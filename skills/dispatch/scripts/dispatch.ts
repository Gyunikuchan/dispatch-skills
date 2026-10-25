import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCommand, UsageError } from './lib/cli.ts';
import { reprobeQuota } from './lib/quota-store.ts';
import { findRepoRoot, initializeSession, platformSessionId, reactivateSession } from './lib/session.ts';
import { H } from './policy/quota.ts';
import { SPECS, isProviderId } from './providers/index.ts';
import { main as toolkitMain, nodeDeps, type CliDeps } from './toolkit/cli.ts';
import { capSummary } from './toolkit/output.ts';
import { diagnosticInstructions } from './toolkit/diagnostics.ts';

export type EntryDeps = CliDeps & { cwd?: () => string };

export async function main(argv: readonly string[] = process.argv.slice(2), deps: EntryDeps = nodeDeps()): Promise<number> {
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
    const dir = command.action === 'init'
      ? initializeSession({ repositoryRoot: repo, sessionId: flag('session-id') ?? platformSessionId((name) => deps.env[name]) ?? crypto.randomUUID(), sessionTitle: flag('objective')!, now: new Date(deps.clock()) })
      : reactivateSession(path.resolve(flag('session-dir')!), repo);
    print({ ok: true, summary: capSummary('Session ' + command.action + ' complete'), path: dir, ...diagnosticInstructions(deps.skillRoot) });
    return 0;
  } catch (error) {
    const usage = error instanceof UsageError;
    print({ ok: false, summary: capSummary(error instanceof Error ? error.message : String(error)), path: null, reason: usage ? 'usage' : 'fault' });
    return usage ? 1 : 2;
  }
}

export function isEntry(argvPath: string | undefined, realpath: (file: string) => string = fs.realpathSync, moduleUrl = import.meta.url): boolean {
  return !!argvPath && pathToFileURL(realpath(path.resolve(argvPath))).href === moduleUrl;
}

// NOTE: Node resolves symlinks for import.meta.url but not argv[1]; compare real paths so symlinked skill installs run.
if (isEntry(process.argv[1])) process.exitCode = await main();
