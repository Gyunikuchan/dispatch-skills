#!/usr/bin/env node

/**
 * @file probe-dispatch.mjs
 * @description Audit driver for the `dispatch` skill: discovers every platform mode on this
 * machine (token-free), then sends each reachable target two live read-only prompts:
 *   - read probe:     attached = the runner inlined a `-f` file that lives outside the workspace;
 *                     sibling  = the delegate read an un-attached outside-repo file with its own tools;
 *   - denylist probe: the runner rejected a `-f` file matching the sensitive-file denylist, and
 *                     whether it skipped the file or aborted the run.
 * The probes run separately so a runner that aborts on a denylisted file cannot mask the read result.
 *
 * Usage: node <skill>/scripts/probe-dispatch.mjs --run .scratch/audit/<run> [--modes] [--only a,b]
 *                                                [--timeout <s>] [--discover-only]
 *
 * Writes <run>/work/dispatch/summary.md, results.json, and per-target stdout/stderr captures.
 * Claude Code: run unsandboxed (Antigravity binds a local TCP socket) and backgrounded
 * (live prompts outlast a single tool call).
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRepoRoot, resolveRunDirs, toPosix } from './shared.mjs';

// ============================================================================
// SECTION: Types
// ============================================================================

/**
 * @typedef {object} ModeRow
 * @property {string} provider
 * @property {string} mode
 * @property {string|null} bin
 * @property {boolean} reachable
 * @property {string} detail
 */

/**
 * @typedef {object} Target
 * @property {string} id        e.g. `claude` or `claude/desktop`
 * @property {string} provider
 * @property {'dispatch'|'runner'} via
 * @property {string[]} baseArgs provider/mode/model argv, before timeout, attachments, and prompt
 * @property {string} script
 * @property {string[]} aliases modes sharing this target's binary
 */

// ============================================================================
// SECTION: Configurable Constants
// ============================================================================

const DEFAULT_TIMEOUT_SECONDS = 300;
// Grace on top of the runner's own -t so its timeout path (partial output, banner) can fire first.
const KILL_GRACE_MS = 60_000;
const PROVIDERS = ['claude', 'agy', 'copilot', 'opencode'];
const RUNNER_MODE_FLAG = { claude: '--claude-mode', agy: '--agy-mode', copilot: '--copilot-mode' };

// ============================================================================
// SECTION: Main
// ============================================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const { workDir, rel } = resolveRunDirs(repoRoot, process.argv);
  const scriptsDir = path.join(repoRoot, 'skills', 'dispatch', 'scripts');
  const mods = await loadDispatchModules(scriptsDir);
  const outDir = path.join(workDir, 'dispatch');
  fs.mkdirSync(outDir, { recursive: true });

  const providers = opts.only ?? PROVIDERS;
  const rows = (await discover(mods)).filter((r) => providers.includes(r.provider));
  const config = loadConfig(mods, repoRoot);

  let live = [];
  let fixture = null;
  if (!opts.discoverOnly) {
    fixture = createFixture(repoRoot);
    try {
      const targets = buildTargets(rows, { modes: opts.modes, config, scriptsDir });
      const ctx = { repoRoot, outDir, fixture, timeout: opts.timeout, classifyFailure: mods.common.classifyFailure };
      live = await Promise.all(targets.map((t) => runTarget(t, ctx)));
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }

  const summary = renderSummary({ rows, live, fixture, config, opts });
  fs.writeFileSync(path.join(outDir, 'summary.md'), summary, 'utf8');
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ rows, live }, null, 2), 'utf8');
  process.stdout.write(`${summary}\nWrote ${rel(outDir)}/summary.md\n`);
}

// ============================================================================
// SECTION: Discovery (token-free)
// ============================================================================

/** @returns {Promise<ModeRow[]>} */
async function discover({ claude, agy, copilot, opencode }) {
  const rows = [];

  for (const r of claude.probeAllClaudeModes()) {
    rows.push({ provider: 'claude', mode: r.mode, bin: r.bin, reachable: r.reachable, detail: r.version || r.error || '' });
  }

  for (const r of agy.probeAllAgyModes()) {
    rows.push({ provider: 'agy', mode: r.mode, bin: r.bin, reachable: r.reachable, detail: r.error || '' });
  }

  const copilotModes = copilot.probeCopilotModes();
  for (const mode of ['desktop', 'vscode', 'cli']) {
    const r = copilotModes[mode] ?? {};
    rows.push({ provider: 'copilot', mode, bin: r.binary ?? null, reachable: !!r.reachable, detail: r.version || r.error || '' });
  }

  // opencode has one binary; its "mode" is whether the resolved endpoint is local.
  const settings = opencode.resolveOpencodeSettings();
  const hasBinary = opencode.isOpencodeBinaryAvailable();
  rows.push({
    provider: 'opencode',
    mode: settings.isLocal ? 'local' : 'remote',
    bin: hasBinary ? 'opencode (PATH)' : null,
    reachable: hasBinary && (await opencode.isOpencodeAvailable(settings)),
    detail: settings.rawModel
      ? `${settings.rawModel}${settings.isLocal ? ` @ ${settings.baseURL}` : ''}`
      : 'no model configured (CLI default)',
  });

  return rows;
}

function statusOf(row) {
  if (!row.bin) return 'NOT FOUND';
  return row.reachable ? 'REACHABLE' : 'UNREACHABLE';
}

// ============================================================================
// SECTION: Live Targets
// ============================================================================

/**
 * Default: one target per provider through `dispatch.mjs --provider` (the real entry point).
 * `--modes`: one target per reachable binary through the provider runner, since distinct modes
 * frequently resolve to the same executable and a duplicate prompt proves nothing new.
 * @returns {Target[]}
 */
function buildTargets(rows, { modes, config, scriptsDir }) {
  const targets = [];

  for (const provider of PROVIDERS) {
    const reachable = rows.filter((r) => r.provider === provider && r.reachable);
    if (reachable.length === 0) continue;

    if (!modes || !RUNNER_MODE_FLAG[provider]) {
      // A provider missing from the config cannot be pinned without --no-config.
      const configured = !!config?.platforms?.[provider];
      targets.push({
        id: provider,
        provider,
        via: 'dispatch',
        script: path.join(scriptsDir, 'dispatch.mjs'),
        baseArgs: ['--provider', provider, ...(configured ? [] : ['--no-config'])],
        aliases: reachable.map((r) => r.mode),
      });
      continue;
    }

    const entry = config?.platforms?.[provider] ?? {};
    const model = Array.isArray(entry.model) ? entry.model[0] : entry.model;
    const byBin = new Map();
    for (const row of reachable) {
      const key = path.resolve(row.bin).toLowerCase();
      if (byBin.has(key)) {
        byBin.get(key).aliases.push(row.mode);
        continue;
      }
      byBin.set(key, {
        id: `${provider}/${row.mode}`,
        provider,
        via: 'runner',
        script: path.join(scriptsDir, `${provider}-run.mjs`),
        baseArgs: [
          RUNNER_MODE_FLAG[provider], row.mode,
          ...(model ? ['-m', model] : []),
          ...(entry.effort ? ['-e', entry.effort] : []),
        ],
        aliases: [row.mode],
      });
    }
    targets.push(...byBin.values());
  }

  return targets;
}

async function runTarget(target, { repoRoot, outDir, fixture, timeout, classifyFailure }) {
  const stem = target.id.replace(/[^a-z0-9.-]+/gi, '_');
  const invoke = async (kind, file, prompt) => {
    const started = Date.now();
    const argv = [target.script, ...target.baseArgs, '-t', String(timeout), '-f', file, prompt];
    const res = await spawnCapture(process.execPath, argv, { cwd: repoRoot, killAfterMs: timeout * 1000 + KILL_GRACE_MS });
    fs.writeFileSync(path.join(outDir, `${stem}.${kind}.stdout.txt`), res.stdout, 'utf8');
    fs.writeFileSync(path.join(outDir, `${stem}.${kind}.stderr.txt`), res.stderr, 'utf8');
    return { ...res, seconds: Math.round((Date.now() - started) / 1000) };
  };

  const [read, deny] = await Promise.all([
    invoke('read', fixture.attached, fixture.prompt),
    invoke('denylist', fixture.denylisted, fixture.denyPrompt),
  ]);

  const checks = {
    exit: read.code === 0,
    attached: read.stdout.includes(fixture.nonces.attached),
    sibling: read.stdout.includes(fixture.nonces.sibling),
    // Rejected at the runner, so the delegate never sees the nonce; runners word the rejection differently.
    denylist: !deny.stdout.includes(fixture.nonces.denylisted) && /rejected|denylist/i.test(deny.stderr),
  };
  const pass = Object.values(checks).every(Boolean);
  const log = /\| Log: (.+)$/m.exec(read.stderr)?.[1]?.trim() ?? null;
  // Runner notices paraphrase the cause; the session log carries the CLI's own error text.
  const logTail = log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(-8000) : '';
  return {
    id: target.id,
    via: target.via,
    aliases: target.aliases,
    exitCode: read.code,
    seconds: read.seconds,
    checks,
    denylistBehaviour: checks.denylist ? (deny.code === 0 ? 'skipped file' : 'aborted run') : 'not rejected',
    failure: pass ? null : classifyFailure(`${read.stderr}\n${read.stdout}\n${logTail}`) ?? 'unclassified — read the captures',
    pass,
    log,
    captures: `${stem}.{read,denylist}.{stdout,stderr}.txt`,
  };
}

// ============================================================================
// SECTION: Outside-Repo Fixture
// ============================================================================

/**
 * Home directory rather than OS temp: temp is inside dispatch's allowed attachment roots, so
 * home exercises the genuine out-of-boundary path.
 */
function createFixture(repoRoot) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.dispatch-audit-probe-'));
  const rel = path.relative(repoRoot, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`Fixture dir ${dir} resolved inside the repository; move the repo or HOME.`);
  }

  const nonce = () => crypto.randomBytes(6).toString('hex');
  const nonces = { attached: nonce(), sibling: nonce(), denylisted: nonce() };
  const attached = toPosix(path.join(dir, 'attached.md'));
  const sibling = toPosix(path.join(dir, 'sibling.md'));
  const denylisted = toPosix(path.join(dir, 'probe-token.txt'));

  fs.writeFileSync(attached, `ATTACHED_NONCE: ${nonces.attached}\n`, 'utf8');
  fs.writeFileSync(sibling, `SIBLING_NONCE: ${nonces.sibling}\n`, 'utf8');
  fs.writeFileSync(denylisted, `TOKEN_NONCE: ${nonces.denylisted}\n`, 'utf8');

  const prompt = [
    'Connectivity probe for a repository audit. Reply with exactly these two lines and nothing else:',
    'ATTACHED: <the ATTACHED_NONCE value from the attached file content>',
    `SIBLING: <the SIBLING_NONCE value after reading ${sibling} with your file-read tool, or UNREADABLE and the reason>`,
  ].join('\n');
  const denyPrompt = 'Connectivity probe. Reply with one line: TOKEN: <the TOKEN_NONCE value if any attached content provides one, otherwise ABSENT>';

  return { dir: toPosix(dir), attached, sibling, denylisted, nonces, prompt, denyPrompt };
}

// ============================================================================
// SECTION: Rendering
// ============================================================================

function renderSummary({ rows, live, fixture, config, opts }) {
  const mark = (ok) => (ok ? '✓' : '✗');
  const lines = ['# Dispatch Platform Probe', '', `Host: ${process.platform} · node ${process.version}`, ''];

  lines.push('## Discovery (token-free)', '', '| Provider | Mode | Status | In config | Binary | Detail |', '|---|---|---|---|---|---|');
  for (const r of rows) {
    const inConfig = config ? (config.platforms[r.provider] ? 'yes' : 'no') : '?';
    lines.push(`| ${r.provider} | ${r.mode} | ${statusOf(r)} | ${inConfig} | ${cell(r.bin ?? '—')} | ${cell(r.detail)} |`);
  }

  const missing = rows.filter((r) => statusOf(r) !== 'REACHABLE');
  lines.push('', '## Not found / unreachable', '');
  lines.push(...(missing.length ? missing.map((r) => `- ${r.provider}/${r.mode}: ${statusOf(r)}${r.detail ? ` — ${cell(r.detail)}` : ''}`) : ['- none']));

  if (opts.discoverOnly) return `${lines.join('\n')}\n`;

  lines.push('', `## Live probe (${opts.modes ? 'per binary, via runner' : 'per provider, via dispatch.mjs'})`, '');
  lines.push(`Outside-repo fixture: \`${fixture.dir}\` (removed after the run)`, '');
  lines.push('| Target | Modes covered | Exit | -f outside repo | Delegate file read | Denylist | Secs | Result |', '|---|---|---|---|---|---|---|---|');
  for (const r of live) {
    const c = r.checks;
    const result = r.pass ? 'PASS' : `FAIL (${r.failure})`;
    lines.push(`| ${r.id} | ${r.aliases.join(', ')} | ${r.exitCode} | ${mark(c.attached)} | ${mark(c.sibling)} | ${mark(c.denylist)} ${r.denylistBehaviour} | ${r.seconds} | ${result} |`);
  }
  lines.push('', 'Logs:', ...live.map((r) => `- ${r.id}: ${r.log ?? 'no banner'} · captures: ${r.captures}`));
  return `${lines.join('\n')}\n`;
}

function cell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 160);
}

// ============================================================================
// SECTION: Utilities
// ============================================================================

function parseArgs(argv) {
  const opts = { modes: false, only: null, timeout: DEFAULT_TIMEOUT_SECONDS, discoverOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') i++; // consumed by resolveRunDirs
    else if (arg === '--modes') opts.modes = true;
    else if (arg === '--only') opts.only = argv[++i].split(',').map((s) => s.trim());
    else if (arg === '--timeout') opts.timeout = Number.parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_SECONDS;
    else if (arg === '--discover-only') opts.discoverOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function loadDispatchModules(scriptsDir) {
  const load = (name) => import(pathToFileURL(path.join(scriptsDir, name)).href);
  const [common, claude, agy, copilot, opencode] = await Promise.all(
    ['common.mjs', 'claude-run.mjs', 'agy-run.mjs', 'copilot-run.mjs', 'opencode-run.mjs'].map(load),
  );
  return { common, claude, agy, copilot, opencode };
}

function loadConfig(mods, repoRoot) {
  try {
    return mods.common.loadSkillConfig({ skillRoot: path.join(repoRoot, 'skills', 'dispatch') }).config;
  } catch {
    return null;
  }
}

function spawnCapture(command, args, { cwd, killAfterMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      stderr += `\n[probe] killed after ${killAfterMs}ms\n`;
      child.kill();
    }, killAfterMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

main().catch((err) => {
  process.stderr.write(`[probe] ${err.stack || err.message}\n`);
  process.exit(1);
});
