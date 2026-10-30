import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashes } from '../../scripts/generate-hashes.ts';
import { completedLaunch, recordedLaunches, type Scenario } from './stub-provider.ts';
import { SPEC_SOURCE } from './spec-fixture.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STUB = path.resolve(ROOT, 'tests/helpers/stub-provider.ts');
export const CLEAN = { status: 'CLEAN', findings: [] };

let baseRepoTemplate: string | null = null;
let baseOverlayTemplate: string | null = null;

function getBaseRepoTemplate(): string {
  if (!baseRepoTemplate) {
    baseRepoTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-e2e-base-repo-'));
    process.on('exit', () => { try { fs.rmSync(baseRepoTemplate!, { recursive: true, force: true }); } catch {} });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: baseRepoTemplate!, encoding: 'utf8', windowsHide: true });
    git('init', '-q');
    fs.appendFileSync(path.join(baseRepoTemplate, '.git/config'), '\n[core]\n\tautocrlf = false\n[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n');
    fs.mkdirSync(path.join(baseRepoTemplate, 'src')); fs.writeFileSync(path.join(baseRepoTemplate, 'src/a.ts'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(baseRepoTemplate, 'governing.spec.md'), SPEC_SOURCE);
    fs.writeFileSync(path.join(baseRepoTemplate, '.gitignore'), '.scratch/\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
  }
  return baseRepoTemplate;
}

function getBaseOverlayTemplate(): string {
  if (!baseOverlayTemplate) {
    baseOverlayTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-e2e-base-overlay-'));
    process.on('exit', () => { try { fs.rmSync(baseOverlayTemplate!, { recursive: true, force: true }); } catch {} });
    fs.cpSync(path.join(ROOT, 'skills/dispatch'), path.join(baseOverlayTemplate, 'skills/dispatch'), { recursive: true });
    const config = {
      'read-delegates': { opencode: { sandbox: false, targets: [{ low: { model: 'stub' } }] } },
      'write-subagents': { codex: { low: { model: 'native-stub', effort: 'low' } } },
      phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } },
    };
    fs.writeFileSync(path.join(baseOverlayTemplate, 'skills/dispatch/config.local.jsonc'), JSON.stringify(config));
    hashes(baseOverlayTemplate);
  }
  return baseOverlayTemplate;
}

export function fixture(scenario: Scenario = { responses: [CLEAN] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-e2e-')), repo = path.join(dir, 'repo'), overlay = path.join(dir, 'overlay');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.cpSync(getBaseOverlayTemplate(), overlay, { recursive: true });
  const skill = path.join(overlay, 'skills/dispatch'), bin = path.join(dir, 'bin'), scenarioPath = path.join(dir, 'scenario.json');
  fs.mkdirSync(bin); fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const shim = process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${STUB}" "${scenarioPath}" %*\r\n` : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(STUB)} ${shellQuote(scenarioPath)} "$@"\n`;
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode'), shim, { mode: 0o700 });
  fs.cpSync(getBaseRepoTemplate(), repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' };
  for (const key of Object.keys(env)) if (/^DISPATCH_|^CLAUDE|^CODEX_THREAD|^ANTIGRAVITY|^COPILOT|^OPENCODE/.test(key)) delete (env as Record<string, string | undefined>)[key];
  const entry = path.join(skill, 'scripts/dispatch.ts');
  const running = new Set<ReturnType<typeof spawn>>();
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
  const launches = () => recordedLaunches(scenarioPath);
  function cleanup() {
    for (const child of running) child.kill('SIGKILL');
    for (const row of launches()) if (!completedLaunch(scenarioPath, row)) try { process.kill(row.pid, 'SIGKILL'); } catch { /* completed */ }
    // Fixture roots are isolated and owned by this harness.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  return { dir, repo, skill, entry, git, launch, launches, cleanup };
}
