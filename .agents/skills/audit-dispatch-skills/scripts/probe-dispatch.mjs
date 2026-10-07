#!/usr/bin/env node

/**
 * @file probe-dispatch.mjs
 * @description Bounded provider smoke probe for the `dispatch` audit: discovers every platform mode on
 * this machine (token-free), then sends at most one low-level, model-bearing read prompt per selected
 * provider under the run's recorded (else the audit config's) launch, deadline, grace and capture limits:
 *   - read probe:     attached = the runner inlined a file that lives outside the workspace;
 *                     sibling  = the delegate read an un-attached outside-repo file with its own tools;
 *   - denylist check: the real attachment/preflight path runs under a refusing process port, so the
 *                     denylisted file's exclusion is verified from the request payload without a launch.
 *
 * Usage: node <skill>/scripts/probe-dispatch.mjs --run <yyyy-mm-dd-hhmm> [--modes] [--only a,b]
 *                                                [--timeout <s>] [--discover-only]
 *
 * Writes <run>-work/dispatch/summary.md, results.json, and per-target stdout captures; when the run's
 * manifest exists, the probe first claims ownership and reserves launches there, then persists each
 * target's lifecycle as it changes. A live probe refuses a malformed, unsupported or legacy manifest.
 * Claude Code: run unsandboxed (Antigravity binds a local TCP socket) and backgrounded.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { currentPlatform } from '../../../../skills/dispatch/scripts/lib/platform.ts';
import { loadConfig as loadNativeConfig } from '../../../../skills/dispatch/scripts/lib/config.ts';
import { LEVELS, resolveLevel } from '../../../../skills/dispatch/scripts/policy/roster.ts';
import { createDiscovery } from '../../../../skills/dispatch/scripts/providers/discovery.ts';
import { SPECS } from '../../../../skills/dispatch/scripts/providers/index.ts';
import { nodeProcess } from '../../../../skills/dispatch/scripts/providers/node-process.ts';
import { runDelegate } from '../../../../skills/dispatch/scripts/providers/runner.ts';
import { createOpencodePreparePorts, nativeOpencodeIntrospection, resolveEffectiveOpencodeLaunch } from '../../../../skills/dispatch/scripts/providers/opencode-runtime.ts';
import { nodePorts } from '../../../../skills/dispatch/scripts/core/ports.ts';
import { moveEntry } from './finalize.mjs';
import { loadAuditConfig, readRun, updateRun } from './run-state.ts';
import { resolveRepoRoot, resolveRunDirs, toPosix } from './shared.mjs';

const isMainModule = (url) => !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url;

// ============================================================================
// SECTION: Configuration
// ============================================================================

/** Smoke probes prove connectivity, not capability, so the cheapest configured tier is used. */
export const PROBE_LEVEL = 'low';
const TABLE_CELL_CHARACTERS = 160;
const PROVIDERS = ['claude', 'agy', 'copilot', 'opencode'];
const GENERATION_GAP = 'provider adapter exposes no generation-token limit';
const DENYLIST_REFUSAL = 'audit probe: denylist validation never launches a provider';
/** Providers whose adapter refuses to launch until preparation verifies an effective read-only agent. */
const REQUEST_PREPARATION = new Set(['opencode']);
const PREPARATION_REASON = /^(?:effective-config-unverified|read-only-agent-unavailable):[^\n]*/;

const resolveTargets = (config, level) => Object.fromEntries(Object.entries(config?.['read-delegates'] ?? {}).map(([id, value]) => [id, (value.targets ?? []).map((target) => resolveLevel(target, level)).filter(Boolean)]));

/** Real process, clock and preparation ports; bound only by `main`, so exported helpers never reach them implicitly. */
function cliPorts() {
  return {
    process: nodeProcess, clock: nodePorts().clock, specs: SPECS, env: process.env, platform: currentPlatform(), prepareFor: createOpencodePreparePorts,
    // Read-only `debug config`/`debug agents` introspection; the shipped helper caps each call.
    introspect: { opencode: nativeOpencodeIntrospection },
  };
}

// ============================================================================
// SECTION: Main
// ============================================================================

export async function main(options = {}) {
  const argv = options.argv ?? process.argv;
  const opts = parseArgs(argv.slice(2));
  const repoRoot = options.root ?? resolveRepoRoot();
  const { workDir, rel } = resolveRunDirs(repoRoot, argv);
  // Checked before anything is written, so a refused live probe leaves the work directory untouched.
  const manifest = loadManifest(workDir, { live: !opts.discoverOnly });
  // The reserved manifest's limits govern its run, so a later config edit cannot widen a reserved bound.
  const limits = options.limits ?? manifest?.settings.limits ?? loadAuditConfig().limits;
  // A wider deadline than the recorded limits would silently raise the spend bound.
  if (opts.timeout !== null && opts.timeout > limits.probeDeadlineSeconds) {
    throw new Error(`--timeout ${opts.timeout} exceeds probeDeadlineSeconds=${limits.probeDeadlineSeconds}; raise it in the audit config.json and start a fresh run instead`);
  }
  const effective = opts.timeout === null ? limits : { ...limits, probeDeadlineSeconds: opts.timeout };
  const ports = { ...cliPorts(), ...options.ports };
  const outDir = path.join(workDir, 'dispatch');
  fs.mkdirSync(outDir, { recursive: true });
  // Liveness marker: `summary.md` lands only at the end, so a running probe is distinguishable from a dead one.
  fs.writeFileSync(path.join(outDir, 'started.txt'), `${new Date().toISOString()}\n`, 'utf8');

  const controller = new AbortController();
  const forward = () => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  let signalled = null;
  const onSignal = (sig) => { signalled = sig; controller.abort(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await probe({ opts, repoRoot, workDir, rel, outDir, manifest, limits: effective, ports, signal: controller.signal, home: options.home });
  } catch (err) {
    // A crash after the liveness marker would otherwise read as "still running" forever.
    fs.writeFileSync(path.join(outDir, 'failed.txt'), `${err.stack || err.message}\n`, 'utf8');
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    options.signal?.removeEventListener('abort', forward);
    if (signalled) process.exitCode = 130;
  }
}

async function probe({ opts, repoRoot, workDir, rel, outDir, manifest, limits, ports, signal, home }) {
  const rows = await discover({}, opts.only ?? PROVIDERS, ports);
  const { config, error: configError } = loadConfig(repoRoot);
  let live = [];
  let fixture = null;
  let interrupted = false;

  if (!opts.discoverOnly) {
    const selection = { modes: opts.modes, config, configError, limits };
    // Ownership and launch reservations commit before any child starts, so a competing invocation cannot also launch.
    const claim = claimProbe(workDir, rows, selection, { clock: ports.clock, alive: ports.alive ?? pidAlive });
    try {
      ({ live, fixture, interrupted } = await launchTargets({ claim, manifest, repoRoot, workDir, rel, outDir, limits, ports, signal, home }));
    } finally {
      if (claim.owner) updateRun(workDir, (m) => { if (m.probeOwner?.token === claim.owner.token) m.probeOwner.finishedAt = new Date(ports.clock.now()).toISOString(); });
    }
  }

  const summary = renderSummary({ rows, live, fixture, config, configError, opts, interrupted });
  fs.writeFileSync(path.join(outDir, 'summary.md'), summary, 'utf8');
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ rows, live, interrupted }, null, 2), 'utf8');
  process.stdout.write(`${summary}\nWrote ${rel(outDir)}/summary.md\n`);
  return { rows, live, interrupted };
}

async function launchTargets({ claim, manifest, repoRoot, workDir, rel, outDir, limits, ports, signal, home }) {
  const { targets, previous } = claim;
  let live = [];
  let interrupted = false;
  const fixture = createFixture(repoRoot, { home });
  // Staged outside the repo so delegate output never mixes with the audit's working files mid-run.
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-captures-'));
  const latest = new Map();
  const persist = (id, record) => {
    latest.set(id, record);
    if (manifest) updateRun(workDir, (m) => { m.probes[id] = toProbeRecord(record, rel, stageDir); });
  };
  const runs = Promise.allSettled(targets.map((target) => runTarget(target, {
    fixture, stageDir, limits, signal, previous: previous[target.id] ?? null,
    // Once interrupted, the records below are final; late updates from still-settling targets are ignored.
    state: { update: (id, record) => { if (!interrupted) persist(id, record); } },
    ports: { ...ports, prepare: ports.prepare ?? ports.prepareFor?.(ports.clock.now() + limits.probeDeadlineSeconds * 1000) },
  })));
  const aborted = new Promise((resolve) => signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
  const first = await Promise.race([runs, aborted]);
  if (first === 'aborted') {
    interrupted = true;
    live = targets.map((target) => interruptRecord(target, latest.get(target.id)));
  } else {
    const failed = first.find((s) => s.status === 'rejected');
    if (failed) throw failed.reason;
    live = first.map((s) => s.value);
  }
  // Carried records describe earlier runs' children and fixtures, so they neither gate nor take this run's cleanup.
  const current = live.filter((record) => !record.carried);
  const cleanup = cleanupFixture(fixture, current);
  // A child with unconfirmed exit may still hold its capture open, so captures are copied and the stage kept.
  const move = !interrupted && cleanup === 'complete';
  let preserveError = null;
  try { preserveCaptures(stageDir, outDir, { move }); } catch (err) { preserveError = err.message; }
  for (const record of current) {
    record.cleanup = cleanup;
    // The recorded capture points where the evidence is: the output dir once moved, else the kept stage.
    if (record.capture) record.capturePath = toPosix(path.join(move && !preserveError ? outDir : stageDir, record.capture));
    if (preserveError) record.gaps = [...(record.gaps ?? []), preserveError];
  }
  if (manifest) for (const record of live) persist(record.id, record);
  return { live, fixture, interrupted };
}

/**
 * One locked transaction: refuses while another unfinished owner (live, or on another host) holds the run,
 * then records this owner and reserves each launching target as `running` with its launch budget. Targets
 * are selected from the probes recorded before the reservation, which `runTarget` resolves as `previous`.
 */
export function claimProbe(workDir, rows, selection, { clock, alive, host = os.hostname(), pid = process.pid }) {
  let claim = null;
  updateRun(workDir, (m) => {
    const holder = m.probeOwner;
    if (holder && !holder.finishedAt && (holder.host !== host || alive(holder.pid))) {
      throw new Error(`probe already running for this run (pid ${holder.pid} on ${holder.host} since ${holder.startedAt}); wait for it to finish, or confirm it has exited before retrying.`);
    }
    const previous = structuredClone(m.probes);
    const targets = buildTargets(rows, { ...selection, previous });
    const startedAt = new Date(clock.now()).toISOString();
    const owner = { token: crypto.randomUUID(), pid, host, startedAt, finishedAt: null };
    m.probeOwner = owner;
    for (const target of targets) {
      if (target.skip || target.launchLimit === 0 || priorDisposition(previous[target.id]) !== 'launch') continue;
      m.probes[target.id] = {
        lifecycle: 'running', host, handle: null, liveness: 'exited', startedAt, deadlineAt: null, attempts: 0, reserved: target.launchLimit,
        exitConfirmed: false, capturePath: null, fixturePath: null, outcome: null, cause: 'launch reserved', cleanup: 'pending', model: target.selection ?? null,
      };
    }
    claim = { previous, targets, owner };
  });
  return claim;
}

/** Signal 0 probes existence without delivering a signal; EPERM still means the process exists. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// ============================================================================
// SECTION: Discovery (token-free)
// ============================================================================

/**
 * Gated on `providers`, so `--only` narrows the run itself. `ports.doctor` replaces filesystem
 * discovery in tests.
 */
export async function discover(_mods, providers = PROVIDERS, ports = {}) {
  const doctor = ports.doctor ?? (() => realDiscovery().doctor());
  return doctor().filter((row) => providers.includes(row.provider)).map((row) => ({ provider: row.provider, mode: row.mode, bin: row.path, reachable: row.status === 'path', detail: `${row.status}; launch preparation and substantive coverage unverified` }));
}

function realDiscovery() {
  const platform = currentPlatform();
  return createDiscovery(SPECS, platform, { list: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } }, exists: fs.existsSync, executable: (file) => { try { return fs.statSync(file).isFile() && (platform.os === 'win32' || (fs.statSync(file).mode & 0o111) !== 0); } catch { return false; } } });
}

/** @returns {'NOT FOUND'|'REACHABLE'|'UNREACHABLE'} */
export function statusOf(row) {
  if (!row.bin) return 'NOT FOUND';
  return row.reachable ? 'REACHABLE' : 'UNREACHABLE';
}

// ============================================================================
// SECTION: Target Selection
// ============================================================================

/**
 * Default: the first reachable mode per provider. `--modes`: one target per distinct binary. Launches
 * already recorded in `previous` (under any id of the provider, so a `--modes` change cannot reset them)
 * spend the provider's `probeLaunchesPerProvider` budget; targets beyond what remains are recorded as
 * skipped. A target with prior launch evidence is resolved by `runTarget` (reused or blocked).
 */
export function buildTargets(rows, { modes, config, configError = null, limits, previous = {} }) {
  const limit = limits?.probeLaunchesPerProvider ?? 1;
  return PROVIDERS.flatMap((provider) => {
    const reachable = rows.filter((row) => row.provider === provider && row.reachable);
    const selected = modes ? [...new Map(reachable.map((row) => [row.bin, row])).values()] : reachable.slice(0, 1);
    const selection = config ? selectModel(config, provider) : null;
    const used = Object.entries(previous)
      .filter(([id]) => id === provider || id.startsWith(`${provider}/`))
      // An unfinished reservation spends its reserved launches even before any child starts.
      .reduce((sum, [, record]) => sum + Math.max(record?.attempts ?? 0, record?.lifecycle === 'running' ? record.reserved ?? 0 : 0), 0);
    const remaining = Math.max(0, limit - used);
    const targets = selected.map((row) => ({
      id: modes ? `${provider}/${row.mode}` : provider, provider, mode: row.mode, binary: row.bin,
      model: selection?.applied.model ?? null, effort: selection?.applied.effort ?? null, selection,
      sandbox: config?.['read-delegates']?.[provider]?.sandbox ?? true,
      aliases: reachable.filter((other) => other.bin === row.bin).map((other) => other.mode),
      launchLimit: 0, skip: null,
    }));
    const launching = targets.filter((target) => priorDisposition(previous[target.id]) === 'launch');
    const count = Math.min(launching.length, remaining);
    launching.forEach((target, index) => {
      if (!config) target.skip = `no usable dispatch config: ${configError ?? 'not loaded'}`;
      else if (!selection) target.skip = `no model configured for ${provider} in read-delegates`;
      else if (index < count) target.launchLimit = Math.floor(remaining / count) + (index < remaining % count ? 1 : 0);
      else target.skip = used > 0
        ? `probeLaunchesPerProvider=${limit} already spent by ${used} recorded launch(es)`
        : `--modes widening exceeds probeLaunchesPerProvider=${limit}`;
    });
    return targets;
  });
}

/**
 * The provider's model and effort closest to the probe level. Configured entries do not inherit fields, so the
 * first target naming a model supplies, independently, its nearest level naming a model and its nearest level
 * naming an effort (no effort anywhere means the provider default).
 * @returns {{configured: {level: string, model: string|null, effort: string|null}, applied: {model: string, effort: string|null, modelLevel: string, effortLevel: string|null}, fallback: boolean}|null}
 */
export function selectModel(config, provider) {
  const below = LEVELS.slice(0, LEVELS.indexOf(PROBE_LEVEL)).reverse();
  const order = [PROBE_LEVEL, ...below, ...LEVELS.slice(LEVELS.indexOf(PROBE_LEVEL) + 1)];
  const nearest = (map, field) => {
    const level = order.find((item) => map?.[item]?.[field] !== undefined && map[item][field] !== null);
    return level ? { level, value: map[level][field] } : null;
  };
  for (const map of config?.['read-delegates']?.[provider]?.targets ?? []) {
    const model = nearest(map, 'model');
    if (!model) continue;
    const effort = nearest(map, 'effort');
    const exact = map[PROBE_LEVEL] ?? {};
    const configured = { level: PROBE_LEVEL, model: first(exact.model) ?? null, effort: exact.effort ?? null };
    const applied = { model: first(model.value), effort: effort?.value ?? null, modelLevel: model.level, effortLevel: effort?.level ?? null };
    return { configured, applied, fallback: configured.model !== applied.model || configured.effort !== applied.effort };
  }
  return null;
}

const first = (value) => (Array.isArray(value) ? value[0] : value);

/**
 * `launch` when nothing was recorded or no child ever started; `reuse` for a launch with a confirmed exit;
 * `blocked` for any launch (or running record) without one, whatever lifecycle it records.
 */
export function priorDisposition(previous) {
  if (!previous) return 'launch';
  const launched = (previous.attempts ?? 0) > 0 || previous.lifecycle === 'running' || Boolean(previous.handle);
  if (!launched) return previous.lifecycle === 'complete' ? 'reuse' : 'launch';
  return previous.exitConfirmed === true && previous.liveness === 'exited' ? 'reuse' : 'blocked';
}

// ============================================================================
// SECTION: Launch Guard
// ============================================================================

/**
 * Wraps a ProcessPort: model-bearing starts beyond `limit` (runner retries included) are refused, and a
 * child that outlives deadline + grace settles as timed out with unknown liveness. Runner kill helpers
 * (`*.kill` logs) pass through uncounted.
 */
export function guardProcess(inner, { limit, clock, deadline, graceMs, signal, onLaunch }) {
  const state = { launches: 0, refused: 0, handle: null, liveness: 'exited', exitConfirmed: true };
  const port = {
    start(launch, io) {
      if (io.logPath.endsWith('.kill')) return inner.start(launch, io);
      if (signal?.aborted || state.launches >= limit) {
        state.refused++;
        throw new Error(`audit probe refused launch ${state.launches + 1}: probeLaunchesPerProvider=${limit}${signal?.aborted ? ' (interrupted)' : ''}`);
      }
      state.launches++;
      const child = inner.start(launch, io);
      Object.assign(state, { handle: String(child.pid), liveness: 'alive', exitConfirmed: false });
      onLaunch?.(state);
      const startedAt = clock.now();
      const done = new Promise((resolve) => {
        const stop = clock.every(Math.max(1, deadline + graceMs - startedAt), () => {
          stop();
          state.liveness = 'unknown';
          resolve({ exit: null, signal: null, stdout: '', stdoutPath: io.logPath, stderrTail: 'termination unconfirmed after grace', durationMs: clock.now() - startedAt, timedOut: true, truncated: false });
        });
        child.done.then((result) => {
          stop();
          if (state.liveness === 'unknown') return;
          Object.assign(state, { liveness: 'exited', exitConfirmed: true });
          resolve(result);
        });
      });
      return { pid: child.pid, done };
    },
    signal: (pid, sig) => inner.signal(pid, sig),
  };
  return { port, state };
}

// ============================================================================
// SECTION: Target Run
// ============================================================================

const runnerFs = {
  readText: (file) => fs.readFileSync(file, 'utf8'),
  writeText: (file, text) => fs.writeFileSync(file, text),
  realpath: (file) => { try { return fs.realpathSync(file); } catch { return null; } },
  size: (file) => { try { const stat = fs.statSync(file); return stat.isFile() ? stat.size : null; } catch { return null; } },
  readPrefix: (file, cap) => { const fd = fs.openSync(file, 'r'); try { const bytes = Buffer.alloc(cap); return bytes.subarray(0, fs.readSync(fd, bytes)).toString('utf8'); } finally { fs.closeSync(fd); } },
};

/**
 * Runs one target: zero-launch denylist validation, then at most one guarded read launch.
 * `ctx.ports` must supply process, clock, specs, env and platform; nothing falls back to real ports.
 */
export async function runTarget(target, ctx) {
  const { fixture, stageDir, limits, ports, state, previous, signal } = ctx;
  const base = {
    id: target.id, provider: target.provider, mode: target.mode, aliases: target.aliases, lifecycle: 'pending',
    handle: null, liveness: 'exited', exitConfirmed: true, launches: 0, attempts: 0, startedAt: null, deadlineAt: null,
    outcome: null, cause: null, checks: null, denylist: null, usage: null, gaps: [], capture: null, cleanup: 'pending',
    generationLimit: { requested: limits.probeGenerationTokens, applied: false, reason: GENERATION_GAP },
    selection: target.selection ?? null, fixturePath: fixture?.dir ?? null, capturePath: null,
  };
  // Prior evidence wins over a skip: a recorded launch is reused or blocked, never relaunched or erased.
  const prior = priorDisposition(previous);
  if (prior !== 'launch') {
    const carried = {
      ...base, carried: true, handle: previous.handle ?? null, launches: previous.attempts ?? 0, startedAt: previous.startedAt ?? null,
      deadlineAt: previous.deadlineAt ?? null, capture: previous.capturePath ? path.basename(previous.capturePath) : null,
      capturePath: previous.capturePath ?? null, fixturePath: previous.fixturePath ?? null, selection: previous.model ?? null,
    };
    // Handle absence never means exited: a recorded launch without a confirmed exit is never repeated.
    if (prior === 'blocked') {
      const lifecycle = ['running', 'pending'].includes(previous.lifecycle) ? 'interrupted' : previous.lifecycle;
      const cause = [previous.cause, 'recorded launch has no confirmed exit; not relaunched'].filter(Boolean).join('; ');
      return { ...carried, lifecycle, liveness: 'unknown', exitConfirmed: false, outcome: previous.outcome ?? null, cause, cleanup: 'blocked' };
    }
    return { ...carried, lifecycle: previous.lifecycle, liveness: 'exited', exitConfirmed: true, outcome: previous.outcome ?? null, cause: previous.cause ?? null, cleanup: previous.cleanup ?? 'complete', gaps: ['reused recorded evidence; not relaunched'] };
  }
  const skip = (cause, gaps = []) => ({ ...base, lifecycle: 'skipped', cause, gaps, cleanup: 'complete' });
  if (target.skip) return skip(target.skip);
  const spec = ports.specs?.[target.provider];
  if (!spec) return skip('no provider adapter can enforce local launch bounds');
  const bytes = fixtureBytes(fixture);
  if (bytes > limits.probeFixtureBytes) return skip(`fixture-over-limit: fixture files and prompts total ${bytes} bytes, above probeFixtureBytes=${limits.probeFixtureBytes}`);

  const stem = target.id.replace(/[^a-z0-9.-]+/gi, '_');
  const cwd = path.join(fixture.dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  let prepared = {};
  // Preparation shares the launch deadline, so introspection cannot extend the probe's spend bound.
  const startedAt = ports.clock.now();
  const deadline = startedAt + limits.probeDeadlineSeconds * 1000;
  const request = (kind, file, prompt) => {
    const promptPath = path.join(stageDir, `${stem}.${kind}.prompt.md`);
    fs.writeFileSync(promptPath, prompt);
    const logPath = path.join(stageDir, `${stem}.${kind}.log`);
    return { promptPath, model: target.model, effort: target.effort, sandbox: target.sandbox, schemaPath: null, resume: null, cwd, timeoutMs: deadline - ports.clock.now(), outputCapBytes: limits.probeCaptureBytes, attachments: [file], logPath, briefPath: `${logPath}.brief.md`, ...prepared };
  };
  const runnerPorts = { clock: ports.clock, fs: runnerFs, env: ports.env ?? {}, platform: ports.platform, binary: target.binary, nonce: crypto.randomUUID, workspaceRoot: cwd };

  const timing = { startedAt, deadlineAt: deadline };
  if (REQUEST_PREPARATION.has(target.provider)) {
    // Introspection children are untracked, so an interrupt before settlement must not read as a confirmed exit.
    const preparing = { ...base, ...timing, lifecycle: 'running', liveness: 'unknown', exitConfirmed: false, cause: 'preparing: native introspection pending' };
    state?.update(target.id, preparing);
    const verified = await prepareRequest(target, request('read', fixture.attached, fixture.prompt), ports, { deadline, settleBy: deadline + limits.probeTerminationGraceSeconds * 1000 }, signal);
    // An unsettled introspection may still be live: liveness stays unknown so the fixture is kept, and the late settlement is ignored.
    if (verified.timedOut) {
      const stalled = { ...preparing, lifecycle: 'timeout', cause: 'preparation-timeout: introspection did not settle', outcome: 'introspection outlived deadline + grace; not launched' };
      state?.update(target.id, stalled);
      return stalled;
    }
    // Interrupted records are owned by the caller; a late settlement must not overwrite them.
    if (verified.interrupted || signal?.aborted) return { ...preparing, lifecycle: 'interrupted', cause: 'interrupted during preparation' };
    state?.update(target.id, { ...preparing, liveness: 'exited', cause: 'launch reserved' });
    if (verified.gap) return skip(verified.cause, [verified.gap]);
    prepared = verified.fields;
  }
  // Runner timeouts start from launch, so each request carries only the remaining shared budget.
  if (deadline - ports.clock.now() <= 0) {
    const expired = { ...base, ...timing, lifecycle: 'timeout', cause: 'preparation-timeout', outcome: 'shared deadline expired before launch; not launched' };
    state?.update(target.id, expired);
    return expired;
  }

  const denylist = await checkDenylist(spec, target, request('denylist', fixture.denylisted, fixture.denyPrompt), runnerPorts, fixture.nonces.denylisted);

  const record = { ...base, denylist, startedAt, deadlineAt: deadline, capture: `${stem}.read.log` };
  const guard = guardProcess(ports.process, {
    limit: target.launchLimit ?? limits.probeLaunchesPerProvider, clock: ports.clock, deadline, graceMs: limits.probeTerminationGraceSeconds * 1000, signal,
    onLaunch: (g) => state?.update(target.id, { ...record, lifecycle: 'running', handle: g.handle, liveness: g.liveness, exitConfirmed: false, launches: g.launches }),
  });
  const events = [];
  let run = null;
  let thrown = null;
  try {
    run = await runDelegate(spec, request('read', fixture.attached, fixture.prompt), target.mode, {
      ...runnerPorts, process: guard.port, prepare: ports.prepare, observe: (event) => events.push(event),
    });
  } catch (error) { thrown = error; }

  const usage = [...events].reverse().find((event) => event.usage)?.usage ?? null;
  Object.assign(record, {
    handle: guard.state.handle, liveness: guard.state.liveness, exitConfirmed: guard.state.exitConfirmed,
    launches: guard.state.launches, attempts: run?.attempts ?? guard.state.launches, usage,
    gaps: usage ? [] : ['usage unavailable'],
  });
  if (!fs.existsSync(path.join(stageDir, record.capture))) record.capture = null;
  Object.assign(record, classify(run, thrown, guard.state, events, fixture));
  if (signal?.aborted && record.lifecycle !== 'complete') record.lifecycle = 'interrupted';
  state?.update(target.id, record);
  return record;
}

const STALLED = Symbol('preparation-stalled');

/**
 * Resolves the provider's effective read-only agent through the injected introspection port before any launch.
 * Without the ports, or when introspection cannot verify an agent, the target is a coverage gap, not a launch.
 */
async function prepareRequest(target, req, ports, { deadline, settleBy }, signal) {
  const gap = `coverage gap: ${target.provider} read-only agent unverified; not launched`;
  const introspection = ports.introspect?.[target.provider];
  if (!introspection || !ports.prepare) return { gap, cause: `preparation-unenforceable: no audit ${introspection ? 'launch preparation' : 'introspection'} port for ${target.provider}` };
  if (signal?.aborted) return { interrupted: true };
  // Same timer port as the launch guard: introspection can await a child whose termination failed, so it gets deadline + grace.
  let stop = () => {};
  const stalled = new Promise((resolve) => { stop = ports.clock.every(Math.max(1, settleBy - ports.clock.now()), () => { stop(); resolve(STALLED); }); });
  try {
    const resolving = resolveEffectiveOpencodeLaunch(req, introspection(target.binary, req, ports.env ?? {}, Math.max(1, deadline - ports.clock.now())));
    // NOTE: the shipped introspection port takes no AbortSignal, so an interrupt races it instead of cancelling it.
    resolving.catch(() => {});
    const aborted = new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null), { once: true }));
    const resolved = await Promise.race([resolving, aborted, stalled]);
    if (resolved === STALLED) return { timedOut: true };
    if (resolved === null) return { interrupted: true };
    return { fields: { model: resolved.model, endpoint: resolved.endpoint, agent: resolved.agent, readOnlyVerified: resolved.readOnlyVerified } };
  } catch (error) {
    // Only the classified prefix is kept: a raw parse error could quote credential-bearing native config.
    const reason = PREPARATION_REASON.exec(String(error?.message ?? error))?.[0] ?? 'effective-config-unverified: native introspection failed';
    return { gap, cause: `preparation-unenforceable: ${reason}` };
  } finally { stop(); }
}

function classify(run, thrown, guard, events, fixture) {
  if (thrown) {
    if (guard.refused > 0) return { lifecycle: 'failed', cause: 'retry-refused', outcome: events[0]?.outcome ?? null };
    return { lifecycle: 'failed', cause: 'launch-error', outcome: String(thrown.message ?? thrown) };
  }
  const outcome = run.outcome;
  if (outcome.status === 'ok') {
    const checks = { attached: outcome.text.includes(fixture.nonces.attached), sibling: outcome.text.includes(fixture.nonces.sibling) };
    return { lifecycle: 'complete', checks, outcome: checks.attached && checks.sibling ? 'pass' : 'fail', cause: null };
  }
  if (outcome.cls === 'timeout') {
    return { lifecycle: 'timeout', outcome: outcome.detail, cause: run.attempts === 0 && /preparation/i.test(outcome.detail) ? 'preparation-timeout' : 'deadline' };
  }
  if (outcome.cls === 'buffer') return { lifecycle: 'failed', outcome: outcome.detail, cause: 'output-cap' };
  // Auth, quota and missing binaries are coverage gaps: no login, install or fallback is attempted.
  return { lifecycle: 'failed', outcome: outcome.detail, cause: run.attempts === 0 ? `preparation:${outcome.cls}` : outcome.cls };
}

/**
 * Runs the real attachment and preflight path with a process port that refuses every launch, then checks
 * the would-be request payload (argv, stdin and any spilled brief) for the denylisted nonce.
 */
export async function checkDenylist(spec, target, req, runnerPorts, nonce) {
  const payloads = [];
  const refusing = {
    start(launch) { payloads.push(`${launch.argv.join(' ')}\n${launch.stdin ?? ''}`); throw new Error(DENYLIST_REFUSAL); },
    signal() {},
  };
  let detail = null;
  try {
    const run = await runDelegate(spec, req, target.mode, { ...runnerPorts, process: refusing });
    if (run.outcome.status === 'fail') detail = `${run.outcome.cls}: ${run.outcome.detail}`;
  } catch (error) {
    if (error.message !== DENYLIST_REFUSAL) detail = String(error.message ?? error);
  }
  if (fs.existsSync(req.briefPath)) payloads.push(fs.readFileSync(req.briefPath, 'utf8'));
  const payloadExcluded = payloads.every((payload) => !payload.includes(nonce));
  const reached = payloads.length > 0;
  return { launches: 0, payloadExcluded, behaviour: !reached ? 'aborted' : payloadExcluded ? 'excluded' : 'not excluded', detail };
}

function interruptRecord(target, latest) {
  const record = latest ?? { id: target.id, provider: target.provider, mode: target.mode, aliases: target.aliases, handle: null, liveness: 'exited', exitConfirmed: true, launches: 0, capture: null, gaps: [] };
  const launched = record.liveness !== 'exited';
  return { ...record, lifecycle: 'interrupted', liveness: launched ? 'unknown' : 'exited', exitConfirmed: !launched, cause: 'interrupted' };
}

function toProbeRecord(record, rel, stageDir) {
  const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : typeof ms === 'string' ? ms : null);
  return {
    lifecycle: record.lifecycle, host: os.hostname(), handle: record.handle, liveness: record.liveness === 'alive' ? 'alive' : record.liveness,
    startedAt: iso(record.startedAt), deadlineAt: iso(record.deadlineAt), attempts: record.launches ?? 0, exitConfirmed: record.exitConfirmed,
    capturePath: record.capturePath ?? (record.capture ? toPosix(path.join(stageDir, record.capture)) : null), fixturePath: record.fixturePath ?? null,
    outcome: record.outcome ?? null, cause: record.cause ?? null, cleanup: record.cleanup ?? 'pending', model: record.selection ?? null,
  };
}

/**
 * Live probes fail closed: a malformed, unsupported or legacy manifest would disable ownership and launch
 * accounting, so it is refused before any write or launch. `--discover-only` launches nothing and ignores it.
 */
export function loadManifest(workDir, { live }) {
  try { return readRun(workDir); } catch (err) {
    if (!live) return null;
    throw new Error(`Live probe refused: ${err.message} Nothing was launched and existing captures are left in place.`);
  }
}

// ============================================================================
// SECTION: Captures and Cleanup
// ============================================================================

/** Removes the fixture only when every launched child has a confirmed exit. */
export function cleanupFixture(fixture, records) {
  if (!fixture) return 'complete';
  if (records.some((record) => record.liveness !== 'exited')) return 'blocked';
  try {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    return 'complete';
  } catch { return 'blocked'; }
}

/** Moves (or, while a child may hold a file, copies) staged captures into the run's output directory. */
export function preserveCaptures(stageDir, outDir, { move }) {
  if (!fs.existsSync(stageDir)) return;
  const failures = [];
  for (const name of fs.readdirSync(stageDir)) {
    try {
      if (move) moveEntry(path.join(stageDir, name), path.join(outDir, name));
      else fs.cpSync(path.join(stageDir, name), path.join(outDir, name), { recursive: true });
    } catch (err) {
      failures.push(`${name}: ${err.code ?? err.message}`);
    }
  }
  // Keep the staging dir while any capture is unmoved, so a failed move never deletes evidence.
  if (failures.length > 0) throw new Error(`Captures left in ${stageDir}: ${failures.join(', ')}`);
  if (move) fs.rmSync(stageDir, { recursive: true, force: true });
}

// ============================================================================
// SECTION: Outside-Repo Fixture
// ============================================================================

/**
 * Home directory rather than OS temp: temp is inside dispatch's allowed attachment roots, so home
 * exercises the genuine out-of-boundary path.
 */
export function createFixture(repoRoot, { home = os.homedir() } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const dir = fs.mkdtempSync(path.join(home, '.dispatch-audit-probe-'));
  const rel = path.relative(repoRoot, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`Fixture dir ${dir} resolved inside the repository; move the repo or HOME.`);
  }

  const nonce = () => crypto.randomBytes(6).toString('hex');
  const nonces = { attached: nonce(), sibling: nonce(), denylisted: nonce() };
  const attached = toPosix(path.join(dir, 'attached.md'));
  const sibling = toPosix(path.join(dir, 'sibling.md'));
  const denylisted = toPosix(path.join(dir, '.env'));

  fs.writeFileSync(attached, `ATTACHED_NONCE: ${nonces.attached}\n`, 'utf8');
  fs.writeFileSync(sibling, `SIBLING_NONCE: ${nonces.sibling}\n`, 'utf8');
  fs.writeFileSync(denylisted, `TOKEN_NONCE: ${nonces.denylisted}\n`, 'utf8');

  const prompt = [
    'Connectivity probe. Reply with exactly these two short lines and nothing else:',
    'ATTACHED: <the ATTACHED_NONCE value from the attached file content>',
    `SIBLING: <the SIBLING_NONCE value after reading ${sibling} with your file-read tool, or UNREADABLE>`,
  ].join('\n');
  const denyPrompt = 'Connectivity probe. Reply with one line: TOKEN: <the TOKEN_NONCE value if any attached content provides one, otherwise ABSENT>';

  return { dir: toPosix(dir), attached, sibling, denylisted, nonces, prompt, denyPrompt };
}

/** Bytes the probe exposes to a provider: every fixture file plus both prompt texts, bounded by `probeFixtureBytes`. */
export function fixtureBytes(fixture) {
  const files = [fixture.attached, fixture.sibling, fixture.denylisted].reduce((sum, file) => sum + fs.statSync(file).size, 0);
  return files + Buffer.byteLength(fixture.prompt) + Buffer.byteLength(fixture.denyPrompt);
}

// ============================================================================
// SECTION: Rendering
// ============================================================================

export function renderSummary({ rows, live, fixture, config, configError = null, opts, interrupted = false }) {
  const mark = (ok) => (ok ? '✓' : '✗');
  const lines = ['# Dispatch Platform Probe', '', `Host: ${process.platform} · node ${process.version}`, ''];
  const configured = resolveTargets(config, PROBE_LEVEL);

  lines.push('## Discovery (token-free)', '', '| Provider | Mode | Status | In config | Binary | Detail |', '|---|---|---|---|---|---|');
  for (const r of rows) {
    const inConfig = config ? (configured[r.provider] ? 'yes' : 'no') : '?';
    lines.push(`| ${r.provider} | ${r.mode} | ${statusOf(r)} | ${inConfig} | ${cell(r.bin ?? '—')} | ${cell(r.detail)} |`);
  }

  const missing = rows.filter((r) => statusOf(r) !== 'REACHABLE');
  lines.push('', '## Not found / unreachable', '');
  lines.push(...(missing.length ? missing.map((r) => `- ${r.provider}/${r.mode}: ${statusOf(r)}${r.detail ? ` — ${cell(r.detail)}` : ''}`) : ['- none']));

  if (configError) lines.push('', `Dispatch config unusable: ${cell(configError)}`);

  if (opts.discoverOnly) return `${lines.join('\n')}\n`;

  lines.push('', `## Live probe (${opts.modes ? 'per binary' : 'per provider'}, ${PROBE_LEVEL} level${interrupted ? ', INTERRUPTED' : ''})`, '');
  lines.push(`Outside-repo fixture: \`${fixture.dir}\``, '');
  lines.push('| Target | Modes covered | Lifecycle | Launches | -f outside repo | Delegate file read | Denylist | Liveness | Cleanup | Cause |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of live) {
    const checks = r.checks ?? {};
    lines.push(`| ${r.id} | ${(r.aliases ?? []).join(', ')} | ${r.lifecycle} | ${r.launches ?? 0} | ${mark(checks.attached)} | ${mark(checks.sibling)} | ${r.denylist?.behaviour ?? '—'} | ${r.liveness} | ${r.cleanup ?? '—'} | ${cell(r.cause ?? '—')} |`);
  }
  lines.push('', 'Gaps:', ...live.map((r) => `- ${r.id}: ${[...(r.gaps ?? []), r.generationLimit ? `generation limit ${r.generationLimit.requested} not applied (${r.generationLimit.reason})` : null, modelNote(r.selection)].filter(Boolean).join('; ') || 'none'} · capture: ${r.capturePath ?? r.capture ?? 'none'}`));
  return `${lines.join('\n')}\n`;
}

function modelNote(selection) {
  if (!selection) return null;
  const { configured, applied } = selection;
  const label = (model, effort) => `${model ?? 'none'}/${effort ?? 'provider default'}`;
  return `model ${label(applied.model, applied.effort)} applied${selection.fallback ? ` (closest to configured ${configured.level}: ${label(configured.model, configured.effort)})` : ''}`;
}

/** @returns {string} Markdown-safe table cell. */
export function cell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, TABLE_CELL_CHARACTERS);
}

// ============================================================================
// SECTION: Utilities
// ============================================================================

export function parseArgs(argv) {
  const opts = { modes: false, only: null, timeout: null, discoverOnly: false };
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

/** @returns {{config: object|null, error: string|null}} A load failure is returned, never swallowed, so the summary and skip causes name it. */
export function loadConfig(repoRoot) {
  try {
    return { config: loadNativeConfig(path.join(repoRoot, 'skills', 'dispatch')).config, error: null };
  } catch (err) {
    return { config: null, error: String(err?.message ?? err) };
  }
}

// ============================================================================
// SECTION: CLI Entry
// ============================================================================

// Guarded so helpers can be imported without probing real CLIs.
if (isMainModule(import.meta.url)) {
  // Exit explicitly: a stalled introspection child or its pipes would otherwise keep the CLI alive past deadline plus grace.
  main().then(() => process.exit(process.exitCode ?? 0), (err) => {
    process.stderr.write(`[probe] ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
