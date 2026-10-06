// `verify`: run commands sequentially, preserve complete logs, and return stable failure and input identities.

import crypto from 'node:crypto';
import path from 'node:path';
import { runPaths } from '../lib/session.ts';
import type { Effect, Handler } from '../core/types.ts';
import type { OsId } from '../lib/platform.ts';
import type { Git } from './git.ts';

type VerifyEffect = Extract<Effect, { kind: 'verify' }>;

export type VerifyDeps = { os: OsId; cwd: string; git: Git };
export type CommandResult = {
  command: string; exit: number; logPath: string; failureId: string | null; failedTests: string[];
  testCounts: { pass: number; fail: number } | null; loadError: boolean; diagnostic: string; inputFingerprint: string; reused?: boolean;
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

const DURATION = /\s+\(\d+(?:\.\d+)?m?s\)\s*$/;
function parseFailureNames(output: string): string[] {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  let names: string[] = [];
  const start = lines.findIndex((line) => /^✖ failing tests:\s*$/.test(line));
  if (start !== -1) {
    for (let index = start + 1; index < lines.length; index++) {
      if (!/^test at \S/.test(lines[index] ?? '')) continue;
      const match = /^✖ (.+)$/.exec(lines[index + 1] ?? '');
      if (match?.[1]) names.push(match[1].replace(DURATION, ''));
    }
  }
  if (!names.length) for (let index = 0; index + 1 < lines.length; index++) {
    const match = /^✖ (.+)$/.exec(lines[index] ?? '');
    if (match?.[1] && /^\s+Location:\s/.test(lines[index + 1] ?? '')) names.push(match[1]);
  }
  if (!names.length) for (let index = 0; index < lines.length; index++) {
    const match = /^\s*not ok \d+ - (.+?)(?:\s+#\s+(?:SKIP|TODO)\b.*)?$/.exec(lines[index] ?? '');
    if (!match?.[1]) continue;
    let parent = false;
    for (let cursor = index + 1; cursor < lines.length && !/^\s*\.\.\.\s*$/.test(lines[cursor] ?? ''); cursor++) {
      if (/^\s*(?:not )?ok \d+ - /.test(lines[cursor] ?? '')) break;
      if (/failureType:\s*'subtestsFailed'/.test(lines[cursor] ?? '')) { parent = true; break; }
    }
    if (!parent) names.push(match[1].replace(/\\([\\#])/g, '$1'));
  }
  if (!names.length) {
    const suites = new Set(lines.map((line) => /^\s*▶ (.+)$/.exec(line)?.[1]?.trim()).filter((name): name is string => Boolean(name)));
    names = lines.flatMap((line) => {
      const match = /^\s*✖ (.+\(\d+(?:\.\d+)?m?s\))\s*$/.exec(line)?.[1]?.replace(DURATION, '').trim();
      return match && !suites.has(match) ? [match] : [];
    });
  }
  return [...new Set(names.map((name) => `test:${name.trim()}`))].sort();
}

export function testCounts(output: string): { pass: number; fail: number } | null {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '');
  const quietFail = /✖ (\d+) of (\d+) test\(s\) failed \((\d+) passed/.exec(text);
  if (quietFail) return { pass: Number(quietFail[3]), fail: Number(quietFail[1]) };
  const quietPass = /✔ All (\d+) test\(s\) passed/.exec(text);
  if (quietPass) return { pass: Number(quietPass[1]), fail: 0 };
  const pass = /^(?:ℹ|#) pass (\d+)\s*$/m.exec(text), fail = /^(?:ℹ|#) fail (\d+)\s*$/m.exec(text);
  return pass && fail ? { pass: Number(pass[1]), fail: Number(fail[1]) } : null;
}

const isLoadError = (output: string): boolean => /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Cannot find (?:module|package)|Cannot find module|SyntaxError:|SyntaxError \[|Unexpected token|Failed to load|ENOENT:|could not be loaded/i.test(output);

function stableError(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const error = lines.find((line) => /(?:error|ERR_[A-Z_]+|E[A-Z]{3,}:|failed|cannot|could not)/i.test(line)) ?? 'nonzero exit';
  return normalizeDiagnostic(error).replace(/\b(?:pid|port)\s*[:=]?\s*\d+/gi, '<runtime-id>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hash>').slice(0, 512);
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
            command, exit: 0, logPath: candidate['logPath'], failureId: null, failedTests: [], testCounts: null,
            loadError: false, diagnostic: '', inputFingerprint: currentInput, reused: true,
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
      const failedTests = parseFailureNames(combined);
      const loadError = failedTests.length === 0 && isLoadError(combined);
      const diagnostic = normalizeDiagnostic(combined);
      const failureId = exit === 0 ? null : `${command}::${failedTests.length ? failedTests.join(',') : `${loadError ? 'load-error' : 'exit'}:${exit === 127 ? 'spawn' : 'nonzero'}:${stableError(combined)}`}`;
      results.push({ command, exit, logPath, failureId, failedTests, testCounts: testCounts(combined), loadError, diagnostic, inputFingerprint: currentInput });
    }
    let fingerprint;
    try { fingerprint = await deps.git.fingerprint(deps.cwd); } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `fingerprint: ${error instanceof Error ? error.message : String(error)}` }];
    }
    return [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results, fingerprint }];
  };
}
