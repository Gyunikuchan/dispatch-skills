import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { verifyRun } from './verify.ts';
import { renderBrief } from './brief.ts';
import { create, submit, abandon } from './writers.ts';
import { integrate, continueIntegration, commit, abort } from './integrate.ts';
import { deliver, close, cleanup } from './deliver.ts';
import { readManifest, type Manifest } from '../lib/session.ts';
import { lintArtifact } from './lint.ts';
import { appendRecord, foldLedger, queryLedger } from './ledger.ts';
import { capSummary, ToolError, writeResult, type ToolResult } from './output.ts';
import { doctorReport } from './doctor.ts';
import { statusReport } from './status.ts';

export type HandlerResult = { ok: boolean; summary: string; value: unknown; exit: number; reason?: string };
export type HandlerContext = { session: string; manifest: Manifest; args: string[]; values: Record<string, string | boolean | (string | boolean)[] | undefined>; deps: CliDeps };
export type CliDeps = {
  run: (argv: string[], options: {cwd: string; env?: NodeJS.ProcessEnv; stdin?: string}) => Promise<{exit: number; stdout: string; stderr: string}>;
  hook?: (point: string) => Promise<void> | void;
  stdout: (line: string) => void;
  env: NodeJS.ProcessEnv;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  pid: number;
  host: string;
  isAlive: (pid: number) => boolean;
  skillRoot: string;
  handler?: (context: HandlerContext) => Promise<HandlerResult>;
  writeResult?: typeof writeResult;
};

export function nodeDeps(): CliDeps {
  return {
    run: (argv, options) => new Promise((resolve, reject) => {
      // cmd.exe must receive the plan command without Node's argument quoting.
      const child = spawn(argv[0]!, argv.slice(1), {cwd: options.cwd, env: {...process.env,...options.env}, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' && argv[0]!.toLowerCase() === 'cmd.exe', stdio: 'pipe'});
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', exit => resolve({exit: exit ?? 1,stdout,stderr}));
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
      child.stdin.end(options.stdin);
    }),
    stdout: (line) => { process.stdout.write(line); }, env: process.env, clock: () => Date.now(),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)), pid: process.pid, host: os.hostname(),
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
    skillRoot: fileURLToPath(new URL('../..', import.meta.url)),
  };
}

const handlers: Record<string, (context: HandlerContext) => Promise<HandlerResult>> = {
  'brief render': renderBrief,
  'worktree integrate': integrate,
  'worktree continue': continueIntegration,
  'worktree commit': commit,
  'worktree abort': abort,
  'worktree deliver': deliver,
  'worktree close': close,
  'worktree cleanup': cleanup,
  'worktree create': create,
  'worktree submit': submit,
  'worktree abandon': abandon,
  'verify run': verifyRun,
  'ledger append': async ({ session, args, deps }) => {
    let input: unknown;
    try {
      if (args.length !== 1) throw new Error();
      input = JSON.parse(fs.readFileSync(args[0]!, 'utf8'));
    } catch {
      throw new ToolError(1, 'invalid-input', 'input requires a readable JSON record file');
    }
    const value = await appendRecord(session, input, deps);
    return { ok: true, value, summary: 'seq ' + value.seq + (value.deduped ? ' deduped' : ' appended'), exit: 0 };
  },
  'ledger query': async ({ session, values, args }) => {
    if (args.length) throw new ToolError(1, 'invalid-input', 'query takes only filters');
    const value = queryLedger(foldLedger(session), { kind: values['kind'], key: values['key'], since: values['since'] });
    return { ok: true, value, summary: value.length + ' records; last ' + JSON.stringify(value.at(-1) ?? null), exit: 0 };
  },
  'doctor run': async ({ session, values, args, deps }) => {
    if (args.length) throw new ToolError(1, 'invalid-input', 'doctor takes only options');
    const value = doctorReport(session, deps.skillRoot, values['level']);
    return { ok: value.ok, value, summary: JSON.stringify(value), exit: 0, ...(value.reason ? { reason: value.reason } : {}) };
  },
  'status show': async ({ session, manifest, args, deps }) => {
    if (args.length) throw new ToolError(1, 'invalid-input', 'status takes no arguments');
    const value = await statusReport(session, manifest.repositoryRoot, deps);
    return { ok: true, value, summary: JSON.stringify(value), exit: 0 };
  },
  'lint run': async ({ args }) => {
    if (args.length !== 1) throw new ToolError(1, 'invalid-input', 'artifact requires one path');
    const value = lintArtifact(path.resolve(args[0]!));
    const ok = value.errors.length === 0;
    return { ok, value, summary: value.kind + ': ' + value.errors.length + ' errors, ' + value.warnings.length + ' warnings; ' + value.hash,
      exit: ok ? 0 : 4, ...(ok ? {} : { reason: 'lint-errors' }) };
  },
};

export async function main(argv: string[], deps: CliDeps = nodeDeps()): Promise<number> {
  const print = (result: ToolResult) => {
    const { exit, ...output } = result;
    deps.stdout(JSON.stringify({ ...output, summary: capSummary(output.summary) }) + '\n');
    return exit;
  };
  let parsed: ReturnType<typeof parseArgs>;
  let session: string;
  let manifest: Manifest;
  let tool: string;
  let action: string;
  try {
    const args = argv.flatMap((arg, index) => arg === '--since' && /^-\d/.test(argv[index + 1] ?? '')
      ? [arg + '=' + argv[index + 1]] : index > 0 && argv[index - 1] === '--since' && /^-\d/.test(arg) ? [] : [arg]);
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      session: { type: 'string' }, level: { type: 'string' }, kind: { type: 'string' }, key: { type: 'string' }, since: { type: 'string' },
      criteria: {type: 'string'}, reason: {type: 'string'}, 'ack-stale': {type: 'string'}, relaunch: {type: 'boolean'},
    } });
    [tool = '', action = ''] = parsed.positionals;
    if (!handlers[tool + ' ' + action]) throw new Error('Unknown tool or action');
    if (typeof parsed.values['session'] !== 'string') throw new Error('Missing --session');
    session = path.resolve(parsed.values['session']);
    manifest = readManifest(session);
  } catch (error) {
    return print({ ok: false, summary: error instanceof Error ? error.message : String(error), path: null, reason: 'usage', exit: 1 });
  }
  let outcome: HandlerResult;
  try {
    outcome = await (deps.handler ?? handlers[tool + ' ' + action]!)({
      session, manifest, args: parsed.positionals.slice(2), values: parsed.values, deps,
    });
  } catch (error) {
    const fault = error instanceof ToolError ? error : new ToolError(2, 'fault', error instanceof Error ? error.message : String(error));
    outcome = { ok: false, summary: fault.message, reason: fault.reason, exit: fault.exit, value: { reason: fault.reason, message: fault.message } };
  }
  try {
    const resultPath = (deps.writeResult ?? writeResult)(session, tool, action, outcome.value);
    return print({ ok: outcome.ok, summary: outcome.summary, path: resultPath, exit: outcome.exit, ...(outcome.reason ? { reason: outcome.reason } : {}) });
  } catch (error) {
    return print({ ok: false, summary: error instanceof Error ? error.message : String(error), path: null, reason: 'fault', exit: 2 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
