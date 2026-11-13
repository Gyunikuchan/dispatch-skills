import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCommand, UsageError } from './lib/cli.ts';
import { reprobeQuota } from './lib/quota-store.ts';
import { findRepoRoot, initSession, platformSessionId, reactivateSession, recordHost } from './lib/session.ts';
import { H } from './policy/quota.ts';
import { normalizeProvider } from './policy/roster.ts';
import { SPECS, isProviderId } from './providers/index.ts';
import { main as toolkitMain, nodeDeps, type CliDeps } from './toolkit/cli.ts';
import { capSummary } from './toolkit/output.ts';
import { diagnosticInstructions } from './toolkit/diagnostics.ts';

const GROUNDING_INSTRUCTIONS = 'When a verb needs a new spec, run `doctor run --host <platform>` and ground under references/grounding.md before authoring the spec; after confirming it, ground again before design or plan authoring. Launch explorers on doctor\'s `utility` entry for this platform; self-ground only when the host has no launch tool or no map survives recovery.';

// SECTION: help — prints one toolkit.md section as raw text; reads no session, config or ledger.
function printHelp(heading: string, deps: EntryDeps): number {
  const fail = (summary: string, reason: string, exit: number) => {
    deps.stdout(JSON.stringify({ ok: false, summary: capSummary(summary), path: null, reason }) + '\n');
    return exit;
  };
  let lines: string[];
  try { lines = fs.readFileSync(path.join(deps.skillRoot, 'references', 'toolkit.md'), 'utf8').split(/\r?\n/); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error), 'fault', 2); }
  const start = heading ? lines.findIndex((line) => line === '## ' + heading || line === '### ' + heading) : -1;
  if (start < 0) return fail('Unknown or empty heading; valid headings: ' + lines.filter((line) => /^#{2,3} /.test(line)).map((line) => line.replace(/^#{2,3} /, '')).join(', '), 'usage', 1);
  const stop = lines[start]!.startsWith('## ') ? /^#{1,2} / : /^#{1,3} /;
  let end = start; while (++end < lines.length && !stop.test(lines[end]!)) {}
  deps.stdout(lines.slice(start, end).join('\n').trimEnd() + '\n');
  return 0;
}

export type EntryDeps = CliDeps & { cwd?: () => string };

export async function main(argv: readonly string[] = process.argv.slice(2), deps: EntryDeps = nodeDeps()): Promise<number> {
  if (argv[0] === 'help') return printHelp(argv.slice(1).join(' ').trim(), deps);
  if (argv[0] !== 'session') return toolkitMain([...argv], deps);
  const print = (value: Record<string, unknown>) => deps.stdout(JSON.stringify(value) + '\n');
  try {
    const command = parseCommand(argv);
    if (!['init', 'reactivate', 'quota-reprobe'].includes(command.action ?? '')) throw new UsageError('session requires init, reactivate, or quota-reprobe');
    const flag = (name: string) => command.flags[name] as string | undefined;
    const repo = findRepoRoot((deps.cwd ?? process.cwd)());
    if (!repo) throw new UsageError('session requires a Git repository');
    if (command.action === 'quota-reprobe') {
      const provider = flag('provider')!, mode = flag('mode')!;
      if (!isProviderId(provider)) throw new UsageError('Unknown --provider');
      if (!SPECS[provider].modes.some((entry) => entry.id === mode)) throw new UsageError('Unknown --mode for provider');
      const key = { provider, model: flag('model') ?? null, mode };
      let result;
      try { result = reprobeQuota({ sessionDir: path.resolve(flag('session-dir')!), repositoryRoot: repo, bucketWidth: H }, key); }
      catch (error) {
        if (error instanceof Error && (['Linked quota path', 'Invalid quota key or bucket width', 'Quota session ownership mismatch'].includes(error.message)
          || /^Session manifest (?:is missing or invalid|has an unsupported or unsafe identity): /.test(error.message))) {
          throw new UsageError(error.message);
        }
        throw error;
      }
      print({ v: 1, action: 'quota-reprobe', key: result.key, appliesTo: 'future-waves' });
      return 0;
    }
    const host = normalizeProvider(flag('host')!);
    if (!isProviderId(host)) throw new UsageError(`Unknown --host; use ${Object.keys(SPECS).join(', ')}`);
    const session = command.action === 'init'
      ? initSession({ repositoryRoot: repo, sessionId: flag('session-id') ?? platformSessionId((name) => deps.env[name]) ?? crypto.randomUUID(), sessionTitle: flag('objective')!, now: new Date(deps.clock()) })
      : { path: reactivateSession(path.resolve(flag('session-dir')!), repo), reused: true };
    recordHost(session.path, host);
    const diagnostics = diagnosticInstructions(deps.skillRoot).instructions;
    print({ ok: true, summary: capSummary('Session ' + command.action + ' complete'), path: session.path, reused: session.reused, instructions: diagnostics ? `${GROUNDING_INSTRUCTIONS} ${diagnostics}` : GROUNDING_INSTRUCTIONS });
    return 0;
  } catch (error) {
    const usage = error instanceof UsageError;
    print({ ok: false, summary: capSummary(error instanceof Error ? error.message : String(error)), path: null, reason: usage ? 'usage' : 'fault', help: ['init', 'reactivate', 'quota-reprobe'].includes(argv[1] ?? '') ? 'session ' + argv[1] : 'call table' });
    return usage ? 1 : 2;
  }
}

export function isEntry(argvPath: string | undefined, realpath: (file: string) => string = fs.realpathSync, moduleUrl = import.meta.url): boolean {
  return !!argvPath && pathToFileURL(realpath(path.resolve(argvPath))).href === moduleUrl;
}

// NOTE: Node resolves symlinks for import.meta.url but not argv[1]; compare real paths so symlinked skill installs run.
if (isEntry(process.argv[1])) process.exitCode = await main();
