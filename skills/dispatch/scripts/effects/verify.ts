// `verify`: run commands sequentially, preserve complete logs, and return stable failure and input identities.

import crypto from 'node:crypto';
import { runOwnedPaths } from './snapshot.ts';
import path from 'node:path';
import { runPaths } from '../lib/session.ts';
import type { Effect, Handler } from '../core/types.ts';
import type { OsId } from '../lib/platform.ts';
import type { Git } from './git.ts';

type VerifyEffect = Extract<Effect, { kind: 'verify' }>;

export type VerifyDeps = { os: OsId; cwd: string; git: Git };
export type CommandResult = {
  command: string; exit: number; logPath: string; failureId: string | null; failedTests: string[];
  baselineHits: string[]; scanUnreadable: string[]; diagnostic: string; inputFingerprint: string; reused?: boolean;
};

/** `cmd.exe /d /s /c` on Windows (no AutoRun, verbatim quoting), `sh -c` elsewhere. */
export function shellArgv(os: OsId, command: string): string[] {
  return os === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
}

const commandOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof (value as { command?: unknown }).command === 'string') return (value as { command: string }).command;
  return null;
};
const listOfStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeDiagnostic(value: string): string {
  return value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\b/gi, '<duration>')
    .replace(/(?:\/(?:private\/)?tmp|\/var\/folders\/\S+|[A-Za-z]:\\(?:Temp|Users\\[^\\]+\\AppData\\Local\\Temp))[/\\][^\s)'\"]+/g, '<tmp-path>')
    .replace(/[ \t]+/g, ' ').trim().slice(0, 4000);
}

// SECTION: Expected names in log

// NOTE: the plan supplies the names, so no reporter format is parsed and any tool that prints test names works.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const QUOTES = new Set(['"', "'", '`']);

/** Log text without ANSI codes or the `$ <command>` echo line, which can name the tests it selects. */
function logBody(log: string): string {
  const lines = log.replace(ANSI, '').split(/\r?\n/);
  return (lines[0]?.startsWith('$ ') ? lines.slice(1) : lines).join('\n');
}

/** Sorted `test:<name>` for each expected name in the log, bounded by a line edge or a character outside letters, digits, and `_`. */
function namesInLog(log: string, expected: readonly string[]): string[] {
  const text = logBody(log);
  // NOTE: a name directly enclosed in quotes is a selector echo (`-t "name"`, `matching "name"`), not an observed test.
  // NOTE: accepted risk: a longer name that starts with the expected name (`parses plan with tasks` for `parses plan`) also matches.
  const observed = (name: string): boolean => [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'gmu'))]
    .some((match) => {
      const before = text[match.index - 1] ?? '';
      return !(QUOTES.has(before) && text[match.index + name.length] === before);
    });
  const found = expected.filter((name) => name.length > 0 && observed(name));
  return [...new Set(found)].map((name) => `test:${name}`).sort();
}

/**
 * Short hash of the sorted unique normalized log lines. Output order, the run root, absolute path prefixes, hex runs, and
 * digit runs never change it, so an unchanged failure keeps one identity across cwd and parallel output; a new failing line changes it.
 */
function logIdentity(log: string, cwd: string): string {
  const roots = [...new Set([cwd, cwd.replace(/\\/g, '/')])].filter(Boolean).sort((a, b) => b.length - a.length);
  const lines = logBody(log).split(/\r?\n/).map((line) => {
    const rooted = roots.reduce((value, root) => value.split(root).join('<root>'), line);
    return normalizeDiagnostic(rooted)
      .replace(/\\/g, '/')
      .replace(/(?<=^|[\s('"=])(?:[A-Za-z]:)?\/(?:[^\s/:'"()<>]+\/)+/g, '<abs>/')
      .replace(/[0-9a-f]{7,}/gi, '<hex>')
      .replace(/\d+/g, '0');
  }).filter((line) => line.length > 0);
  return crypto.createHash('sha256').update([...new Set(lines)].sort().join('\n')).digest('hex').slice(0, 16);
}

async function inputFingerprint(command: string, raw: unknown, ports: Parameters<Handler<VerifyEffect>>[1], deps: VerifyDeps): Promise<string> {
  const fields = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const paths = [...new Set(listOfStrings(fields['inputPaths']))].sort();
  const files = paths.map((file) => {
    const absolute = path.resolve(deps.cwd, file);
    try { return [file, ports.fs.readText(absolute)]; } catch (error) { return [file, `!read-error:${error instanceof Error ? error.message : String(error)}`]; }
  });
  const environment = typeof fields['environment'] === 'string' ? fields['environment'] : `${deps.os}\0${deps.cwd}`;
  return crypto.createHash('sha256').update(canonical({ command, environment, planHash: fields['planHash'] ?? null, files })).digest('hex');
}

export function createVerify(base: VerifyDeps): Handler<VerifyEffect> {
  return async (effect, ports, ctx) => {
    const deps = effect.cwd ? { ...base, cwd: effect.cwd } : base;
    const results: CommandResult[] = [];
    for (const [index, raw] of effect.commands.entries()) {
      const command = commandOf(raw);
      if (command === null) return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'config', detail: `commands[${index}]: expected { command }` }];
      const currentInput = await inputFingerprint(command, raw, ports, deps);
      const fields = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
      const reuse = fields['reuse'];
      if (typeof reuse === 'object' && reuse !== null) {
        const candidate = reuse as Record<string, unknown>;
        if (candidate['inputFingerprint'] === currentInput && candidate['exit'] === 0 && typeof candidate['logPath'] === 'string') {
          results.push({
            command, exit: 0, logPath: candidate['logPath'], failureId: null, failedTests: [], baselineHits: [],
            scanUnreadable: [], diagnostic: '', inputFingerprint: currentInput, reused: true,
          });
          continue;
        }
      }
      const logPath = runPaths(ctx.runDir).verifyLog(effect.id, index + 1);
      let exit: number;
      let stdout: string;
      let stderr: string;
      try {
        const run = await ports.spawn.run(shellArgv(deps.os, command), { cwd: deps.cwd });
        exit = run.exit;
        stdout = run.stdout;
        stderr = run.stderr;
      } catch (error) {
        exit = 127;
        stdout = '';
        stderr = `[spawn error] ${error instanceof Error ? error.message : String(error)}`;
      }
      const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
      const log = `$ ${command}\n${combined}\n[exit ${exit}]\n`;
      try { ports.fs.writeAtomic(logPath, log); } catch (error) {
        return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `log: ${error instanceof Error ? error.message : String(error)}` }];
      }
      const expected = listOfStrings(fields['expectedTests']);
      const failedTests = namesInLog(log, expected);
      const scanUnreadable: string[] = [];
      const hits = listOfStrings(fields['scanLogs']).flatMap((scanLog) => {
        try { return namesInLog(ports.fs.readText(scanLog), expected); } catch { scanUnreadable.push(scanLog); return []; }
      });
      const baselineHits = [...new Set(hits)].sort();
      const diagnostic = normalizeDiagnostic(combined);
      const failureId = exit === 0 ? null : `${command}::${failedTests.length ? failedTests.join(',') : `exit:${exit === 127 ? 'spawn' : 'nonzero'}:${logIdentity(log, deps.cwd)}`}`;
      results.push({ command, exit, logPath, failureId, failedTests, baselineHits, scanUnreadable, diagnostic, inputFingerprint: currentInput });
    }
    let fingerprint;
    try { fingerprint = await deps.git.fingerprint(deps.cwd, runOwnedPaths(ports, await deps.git.toplevel(deps.cwd), ctx.runDir, ctx.ownedArtifacts)); } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `fingerprint: ${error instanceof Error ? error.message : String(error)}` }];
    }
    return [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results, fingerprint }];
  };
}
