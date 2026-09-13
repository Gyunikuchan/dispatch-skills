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
 * Usage: node <skill>/scripts/probe-dispatch.mjs --run <yyyy-mm-dd-hhmm> [--modes] [--only a,b]
 *                                                [--timeout <s>] [--discover-only]
 *
 * Writes <run>-work/dispatch/summary.md, results.json, and per-target stdout/stderr captures.
 * Claude Code: run unsandboxed (Antigravity binds a local TCP socket) and backgrounded
 * (live prompts outlast a single tool call).
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMainModule, terminateProcessTree } from '../../../../skills/dispatch/scripts/common.mjs';
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
  // Liveness marker: `summary.md` lands only at the very end, so without this a probe still working
  // through minutes of live prompts is indistinguishable from one that died on startup.
  fs.writeFileSync(path.join(outDir, 'started.txt'), `${new Date().toISOString()}\n`, 'utf8');

  const providers = opts.only ?? PROVIDERS;
  const rows = await discover(mods, providers);
  const config = loadConfig(mods, repoRoot);

  let live = [];
  let fixture = null;
  if (!opts.discoverOnly) {
    fixture = createFixture(repoRoot);
    // Captures are staged outside the repo: `outDir` is under `.scratch/`, which is deliberately
    // not git-ignored, so a capture landing there while a sibling dispatch is live trips that
    // delegate's read-only `git status` guard — the probe would manufacture the violation it checks.
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-captures-'));

    // `finally` never runs when the process is signalled, and the fixture holds nonce files in the
    // user's home directory — Ctrl-C during a slow probe used to leave them there.
    let removed = false;
    const removeFixture = () => {
      if (removed) return;
      removed = true;
      try {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      } catch {}
    };
    const onSignal = (signal) => {
      removeFixture();
      // Signals bypass the `finally`, so the staged captures are discarded here rather than
      // drained: an interrupted probe has no complete result to file, and the dir would otherwise
      // be orphaned in OS temp once per interrupt. Only this path discards them.
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {}
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.kill(process.pid, signal);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      const targets = buildTargets(rows, { modes: opts.modes, config, scriptsDir });
      const ctx = { repoRoot, stageDir, fixture, timeout: opts.timeout, classifyFailure: mods.common.classifyFailure };
      // `allSettled`, not `all`: `all` rejects on the first failure while sibling delegates are
      // still running, so the `finally` below would drain captures into the repo mid-flight and
      // trip exactly the read-only guard this staging exists to protect.
      const settled = await Promise.allSettled(targets.map((t) => runTarget(t, ctx)));
      const failed = settled.find((s) => s.status === 'rejected');
      if (failed) throw failed.reason;
      live = settled.map((s) => s.value);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      removeFixture();
      // Every delegate has settled by now, so the captures can land in the repo.
      drainStaging(stageDir, outDir);
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

/**
 * Each provider's block is gated on `providers`, so `--only` narrows the run itself rather than
 * filtering rows after every binary has already been shelled out to.
 * @returns {Promise<ModeRow[]>}
 */
async function discover({ claude, agy, copilot, opencode }, providers = PROVIDERS) {
  const wanted = new Set(providers);
  const rows = [];

  if (wanted.has('claude')) {
    for (const r of claude.probeAllClaudeModes()) {
      rows.push({ provider: 'claude', mode: r.mode, bin: r.bin, reachable: r.reachable, detail: r.version || r.error || '' });
    }
  }

  if (wanted.has('agy')) {
    for (const r of agy.probeAllAgyModes()) {
      rows.push({ provider: 'agy', mode: r.mode, bin: r.bin, reachable: r.reachable, detail: r.error || '' });
    }
  }

  if (wanted.has('copilot')) {
    const copilotModes = copilot.probeCopilotModes();
    for (const mode of ['desktop', 'vscode', 'cli']) {
      const r = copilotModes[mode] ?? {};
      rows.push({ provider: 'copilot', mode, bin: r.binary ?? null, reachable: !!r.reachable, detail: r.version || r.error || '' });
    }
  }

  if (wanted.has('opencode')) {
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
  }

  return rows;
}

export function statusOf(row) {
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
export function buildTargets(rows, { modes, config, scriptsDir }) {
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

async function runTarget(target, { repoRoot, stageDir, fixture, timeout, classifyFailure }) {
  const stem = target.id.replace(/[^a-z0-9.-]+/gi, '_');
  const invoke = async (kind, file, prompt) => {
    const started = Date.now();
    const argv = [target.script, ...target.baseArgs, '-t', String(timeout), '-f', file, prompt];
    const res = await spawnCapture(process.execPath, argv, { cwd: repoRoot, killAfterMs: timeout * 1000 + KILL_GRACE_MS });
    // Staged, not written into the run directory: see the staging note in main().
    fs.writeFileSync(path.join(stageDir, `${stem}.${kind}.stdout.txt`), res.stdout, 'utf8');
    fs.writeFileSync(path.join(stageDir, `${stem}.${kind}.stderr.txt`), res.stderr, 'utf8');
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
    // The delegate's own read-only integrity guard: a run that modified the working tree cannot PASS.
    readonly: !/Workspace was modified during READ-ONLY execution/.test(`${read.stderr}${deny.stderr}`),
  };
  const pass = Object.values(checks).every(Boolean);
  const logOf = (res) => /\| Log: (.+)$/m.exec(res.stderr)?.[1]?.trim() ?? null;
  const logs = { read: logOf(read), denylist: logOf(deny) };
  // Runner notices paraphrase the cause; the session log carries the CLI's own error text.
  const tailOf = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-8000) : '');
  const logTail = tailOf(logs.read);
  // A cause living only in the denylist run's log was unreachable while only the read log was read.
  const denyFailed = !checks.denylist || deny.code !== 0;
  const denyLogTail = denyFailed && logs.denylist !== logs.read ? tailOf(logs.denylist) : '';
  const denyFailureKind = classifyFailure(`${deny.stderr}\n${deny.stdout}\n${denyLogTail}`);
  return {
    id: target.id,
    via: target.via,
    aliases: target.aliases,
    exitCode: read.code,
    seconds: read.seconds,
    checks,
    denylistBehaviour: classifyDenylistBehaviour({
      rejected: checks.denylist,
      stderr: deny.stderr,
      code: deny.code,
      failureKind: denyFailureKind,
    }),
    // The denylist run has its own captures; a failure that only shows up there (an aborted run,
    // a rejection worded unexpectedly) was invisible when only the read run was classified.
    failure: pass
      ? null
      : classifyFailure(`${read.stderr}\n${read.stdout}\n${deny.stderr}\n${deny.stdout}\n${logTail}\n${denyLogTail}`) ??
        'unclassified — read the captures',
    pass,
    log: logs.read,
    logs,
    captures: `${stem}.{read,denylist}.{stdout,stderr}.txt`,
  };
}

/**
 * The runners state what they did with a denylisted attachment (`Attachment rejected`, then
 * `unreadable <file>` when the run continued); the exit code conflates that with an unrelated
 * failure, so wording is read first and the exit code is only the fallback.
 */
export function classifyDenylistBehaviour({ rejected, stderr, code, failureKind }) {
  // An unrejected denylisted file is the serious case and is never masked by wording.
  if (!rejected) return 'not rejected';
  // A classified failure alongside the rejection means the exit code says nothing about the denylist.
  if (failureKind) return 'rejected; run failed for another reason';
  if (/\bunreadable\b|\bskipp(?:ed|ing)\b|reading anyway/i.test(stderr)) return 'skipped file';
  return code === 0 ? 'skipped file' : 'aborted run';
}

/**
 * Moves staged captures into the run's output directory. `rename` fails with `EXDEV` when OS temp
 * and the repo sit on different devices, so it falls back to copy+unlink.
 */
export function drainStaging(stageDir, outDir) {
  if (!fs.existsSync(stageDir)) return;
  // `finally`, so an EBUSY/EPERM on one file does not orphan the whole staging dir in OS temp.
  try {
    for (const name of fs.readdirSync(stageDir)) {
      const from = path.join(stageDir, name);
      const to = path.join(outDir, name);
      try {
        fs.renameSync(from, to);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
      }
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
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

export function renderSummary({ rows, live, fixture, config, opts }) {
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
  lines.push('| Target | Modes covered | Exit | -f outside repo | Delegate file read | Denylist | Read-only | Secs | Result |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of live) {
    const c = r.checks;
    const result = r.pass ? 'PASS' : `FAIL (${r.failure})`;
    lines.push(`| ${r.id} | ${r.aliases.join(', ')} | ${r.exitCode} | ${mark(c.attached)} | ${mark(c.sibling)} | ${mark(c.denylist)} ${r.denylistBehaviour} | ${mark(c.readonly)} | ${r.seconds} | ${result} |`);
  }
  lines.push('', 'Logs:', ...live.map((r) => {
    // Both runs open their own session log; a target whose runs share one renders it once.
    const paths = [...new Set([r.logs?.read ?? r.log, r.logs?.denylist].filter(Boolean))];
    return `- ${r.id}: ${paths.join(' · ') || 'no banner'} · captures: ${r.captures}`;
  }));
  return `${lines.join('\n')}\n`;
}

export function cell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 160);
}

// ============================================================================
// SECTION: Utilities
// ============================================================================

export function parseArgs(argv) {
  const opts = { modes: false, only: null, timeout: DEFAULT_TIMEOUT_SECONDS, discoverOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') i++; // consumed by resolveRunDirs
    else if (arg === '--modes') opts.modes = true;
    else if (arg === '--only') {
      // A bare `--only` used to crash on `undefined.split`; a typo'd provider silently probed nothing.
      const value = argv[++i];
      if (value === undefined) throw new Error('--only requires a comma-separated provider list');
      const keys = value.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = keys.filter((k) => !PROVIDERS.includes(k));
      if (keys.length === 0) throw new Error('--only requires at least one provider');
      if (unknown.length > 0) {
        throw new Error(`--only: unknown provider(s) ${unknown.join(', ')}. Valid: ${PROVIDERS.join(', ')}`);
      }
      opts.only = keys;
    } else if (arg === '--timeout') {
      // `|| DEFAULT` used to swallow a typo'd value, so a run silently ignored the flag.
      const value = argv[++i];
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--timeout requires a positive number of seconds, got "${value}"`);
      }
      opts.timeout = parsed;
    } else if (arg === '--discover-only') opts.discoverOnly = true;
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
      terminateProcessTree(child);
    }, killAfterMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

// Guarded so buildTargets/parseArgs can be imported and unit-tested without probing real CLIs.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[probe] ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
