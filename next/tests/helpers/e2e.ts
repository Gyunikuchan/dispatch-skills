import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashes } from '../../scripts/generate-hashes.ts';
import type { Frame } from '../../skills/dispatch/scripts/core/types.ts';
import { recordedLaunches, type Scenario } from './stub-provider.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STUB = path.resolve(ROOT, 'tests/helpers/stub-provider.ts');
export const CLEAN = { status: 'CLEAN', findings: [] };
export function fixture(scenario: Scenario = { responses: [CLEAN] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-e2e-')), repo = path.join(dir, 'repo'), overlay = path.join(dir, 'overlay');
  fs.mkdirSync(repo); fs.mkdirSync(overlay); fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.cpSync(path.join(ROOT, 'skills/dispatch'), path.join(overlay, 'skills/dispatch'), { recursive: true });
  const skill = path.join(overlay, 'skills/dispatch'), bin = path.join(dir, 'bin'), scenarioPath = path.join(dir, 'scenario.json');
  fs.mkdirSync(bin); fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const shim = process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${STUB}" "${scenarioPath}" %*\r\n` : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(STUB)} ${shellQuote(scenarioPath)} "$@"\n`;
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode'), shim, { mode: 0o700 });
  const config = {
    'read-delegates': { opencode: { sandbox: false, targets: [{ low: { model: 'stub' } }] } },
    'write-subagents': { codex: { low: { model: 'native-stub', effort: 'low' } } },
    phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } },
  };
  fs.writeFileSync(path.join(skill, 'config.local.jsonc'), JSON.stringify(config)); hashes(overlay);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.scratch/\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' };
  for (const key of Object.keys(env)) if (/^DISPATCH_|^CLAUDE|^CODEX_THREAD|^ANTIGRAVITY|^COPILOT|^OPENCODE/.test(key)) delete (env as Record<string, string | undefined>)[key];
  const entry = path.join(skill, 'scripts/dispatch.ts');
  const running = new Set<ReturnType<typeof spawn>>();
  const ownedSessions = new Set<string>();
  function launch(args: readonly string[]) {
    const child = spawn(process.execPath, [entry, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); running.add(child);
    let stdout = '', stderr = ''; child.stdout?.on('data', (bytes: Buffer) => { stdout += bytes; }); child.stderr?.on('data', (bytes: Buffer) => { stderr += bytes; });
    const done = new Promise<{ exit: number; stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timeout: ${args.join(' ')}\n${stderr}`)); }, 25_000);
      child.once('error', (error) => { clearTimeout(timer); running.delete(child); reject(error); });
      child.once('close', (code) => { clearTimeout(timer); running.delete(child); resolve({ exit: code ?? -1, stdout, stderr }); });
    });
    return { child, done };
  }
  const cli = async (args: readonly string[]) => {
    const result = await launch(args).done; assert.equal(result.exit, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`); assert.equal(result.stdout.trim().split('\n').length, 1, 'one stdout frame');
    const frame = JSON.parse(result.stdout) as Frame & { sessionDir: string; sessionId: string };
    if (frame.sessionDir) ownedSessions.add(frame.sessionDir);
    if (typeof frame.data?.['handoff'] === 'string') ownedSessions.add(frame.data['handoff']);
    return frame;
  };
  const initialize = async () => (await cli(['session', 'init', '--session-id', crypto.randomUUID(), '--objective', 'E2E fixture'])).sessionDir;
  const begin = async (verb: string, session: string, argument: string, flags: string[] = []) => cli(['start', verb, '--session-dir', session, '--orchestrator', 'codex', '--level', 'low', '--level-source', 'explicit', ...flags, '--', argument]);
  const reply = async (run: string, event: unknown, dryRun = false) => {
    const eventPath = path.join(dir, 'reply.json'); fs.writeFileSync(eventPath, JSON.stringify(event));
    return cli(['send', '--run', run, '--event', `@${eventPath}`, ...(dryRun ? ['--dry-run'] : [])]);
  };
  const launches = () => recordedLaunches(scenarioPath);
  function cleanup() {
    for (const child of running) child.kill('SIGKILL');
    const workerPids = new Set<number>();
    for (const session of ownedSessions) if (fs.existsSync(session)) for (const relative of fs.readdirSync(session, { recursive: true })) {
      if (!String(relative).endsWith('.claim.json')) continue;
      try { const claim = JSON.parse(fs.readFileSync(path.join(session, String(relative)), 'utf8')) as { pid?: number }; if (claim.pid) workerPids.add(claim.pid); } catch { /* incomplete claim */ }
    }
    for (const pid of workerPids) try { process.kill(pid, 'SIGKILL'); } catch { /* completed */ }
    for (const row of launches()) try { process.kill(row.pid, 'SIGKILL'); } catch { /* completed */ }
    for (const session of ownedSessions) if (fs.existsSync(session) && !session.startsWith(dir)) fs.rmSync(session, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    // Fixture roots are isolated and owned by this harness.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  return { dir, repo, overlay, skill, entry, git, config, scenarioPath, cli, launch, initialize, begin, reply, launches, cleanup, absoluteRun: (run: string) => path.resolve(repo, run) };
}
export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise<void>((resolve) => setTimeout(resolve, 25)); }
}
