/**
 * Test support: a throwaway copy of the dispatch skill whose four provider runners are replaced
 * by deterministic stubs, so `dispatch.mjs` can be spawned end-to-end (wave runs, batch runs,
 * stdout lines) without any real provider CLI.
 *
 * Stub behaviour is driven by environment variables read inside the spawned child:
 * - `DISPATCH_STUB_RESULTS`: JSON map keyed `<provider>:<model>` or `<provider>` to
 *   `{ exit, stdout, stderr, session, failureKind }`; unmatched runs succeed.
 * - `DISPATCH_STUB_LIVE`: JSON map `<provider>: boolean` for the availability probes (default true).
 * - `DISPATCH_STUB_LOG`: file each runner call appends one JSON line `{ provider, model, effort }` to.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DISPATCH_SKILL = path.join(REPO_ROOT, 'skills', 'dispatch');

const RUNNERS = {
  claude: ['claude-run.mjs', 'Claude'],
  agy: ['agy-run.mjs', 'Agy'],
  copilot: ['copilot-run.mjs', 'Copilot'],
  opencode: ['opencode-run.mjs', 'Opencode'],
};

function stubSource(provider, suffix) {
  return `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER = ${JSON.stringify(provider)};
export const CLI_FLAGS = { valueFlags: [], booleanFlags: [] };
export const AGY_MODE_DATA_DIRS = {};

export async function is${suffix}Available() {
  const live = process.env.DISPATCH_STUB_LIVE ? JSON.parse(process.env.DISPATCH_STUB_LIVE) : {};
  return live[PROVIDER] ?? true;
}

export async function run${suffix}(options = {}) {
  const model = Array.isArray(options.model) ? options.model[0] : (options.model ?? null);
  if (process.env.DISPATCH_STUB_LOG) {
    fs.appendFileSync(
      process.env.DISPATCH_STUB_LOG,
      JSON.stringify({ provider: PROVIDER, model: options.model ?? null, effort: options.effort ?? null }) + '\\n',
    );
  }
  const results = JSON.parse(process.env.DISPATCH_STUB_RESULTS || '{}');
  const r = results[PROVIDER + ':' + model] ?? results[PROVIDER] ?? {};
  const exitCode = r.exit ?? 0;
  return {
    provider: PROVIDER,
    stdout: r.stdout ?? (exitCode === 0 ? 'report from ' + PROVIDER + ' ' + model : ''),
    stderr: r.stderr ?? '',
    exitCode,
    failureKind: exitCode === 0 ? null : (r.failureKind ?? 'quota'),
    logFile: path.join(os.tmpdir(), 'dispatch-stub-' + PROVIDER + '.log'),
    truncated: null,
    metricsAttempts: [],
    session: r.session ?? PROVIDER + '-session',
  };
}
`;
}

/**
 * Builds the fixture. The integrity manifest is removed (the stubs would otherwise fail it), so a
 * spawned run only warns about the missing manifest.
 *
 * @param {object} config v0.5 dispatch config written as `config.jsonc`.
 * @returns {{ dir: string, skillDir: string, script: string, cleanup: () => void }}
 */
export function buildStubDispatchFixture(config) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-stub-'));
  const skillDir = path.join(dir, 'dispatch');
  fs.cpSync(DISPATCH_SKILL, skillDir, { recursive: true });
  for (const name of ['config.jsonc', 'config.local.jsonc', 'skill-hashes.json']) {
    fs.rmSync(path.join(skillDir, name), { force: true });
  }
  for (const [provider, [file, suffix]] of Object.entries(RUNNERS)) {
    fs.writeFileSync(path.join(skillDir, 'scripts', file), stubSource(provider, suffix));
  }
  fs.writeFileSync(path.join(skillDir, 'config.jsonc'), JSON.stringify(config, null, 2));
  return {
    dir,
    skillDir,
    script: path.join(skillDir, 'scripts', 'dispatch.mjs'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Orchestrator-detection variables scrubbed so the host running the tests never leaks in. */
export const ORCHESTRATOR_ENV = [
  'ANTIGRAVITY_AGENT', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'GEMINI_CLI',
  'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'COPILOT_AGENT', 'COPILOT_CLI_SESSION_ID', 'OPENCODE_PORT', 'OPENCODE_AGENT',
  'CLAUDE_MODEL', 'ANTHROPIC_MODEL', 'ANTIGRAVITY_MODEL', 'GEMINI_MODEL', 'COPILOT_MODEL',
  'GITHUB_COPILOT_MODEL', 'OPENCODE_MODEL',
];

/**
 * Spawns the fixture's dispatch.mjs.
 * @returns {{ status: number|null, stdout: string, stderr: string, calls: object[] }}
 */
export function runStubDispatch(fixture, args, { results = {}, live = {}, env: extraEnv = {} } = {}) {
  const logFile = path.join(fixture.dir, `calls-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const env = { ...process.env };
  for (const key of ORCHESTRATOR_ENV) delete env[key];
  Object.assign(env, {
    DISPATCH_TELEMETRY: '0',
    DISPATCH_STUB_RESULTS: JSON.stringify(results),
    DISPATCH_STUB_LIVE: JSON.stringify(live),
    DISPATCH_STUB_LOG: logFile,
    ...extraEnv,
  });
  const res = spawnSync(process.execPath, [fixture.script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
    env,
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  const calls = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', calls };
}

/** Parses R8 per-slot stdout lines (one compact JSON object per line). */
export function parseSlotLines(stdout) {
  return stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
