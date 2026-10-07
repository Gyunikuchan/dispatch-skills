/**
 * @file run-state.ts
 * @description Audit configuration and the lead-owned run manifest: exclusive reservation,
 * atomic updates, budgets, scope/probe terminal states, and relocation authority.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// SECTION: Types
// ============================================================================

export type LimitName = (typeof LIMIT_KEYS)[number];
export type AuditConfig = { version: 1; limits: Record<LimitName, number> };
export type RunIo = Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'readFileSync' | 'existsSync' | 'readdirSync' | 'rmSync'>;
export type Clock = { now: () => Date };
/** Cross-process manifest lock: bounded retry, stale takeover, injectable for deterministic tests. */
export type LockOptions = { clock?: Clock; sleep?: (ms: number) => void; retries?: number; retryMs?: number; staleMs?: number };

export type ScopeLifecycle = 'pending' | 'running' | 'complete' | 'partial' | 'failed' | 'interrupted' | 'cancelled';
export type ProbeLifecycle = 'pending' | 'running' | 'complete' | 'skipped' | 'failed' | 'timeout' | 'interrupted';
export type ScopeRecord = { lifecycle: ScopeLifecycle; handle: string | null; budgets: Record<string, number>; resultPath: string | null; gaps: string[] };
export type ProbeRecord = {
  lifecycle: ProbeLifecycle; host: string; handle: string | null; liveness: 'alive' | 'exited' | 'unknown';
  startedAt: string | null; deadlineAt: string | null; attempts: number; exitConfirmed: boolean;
  capturePath: string | null; fixturePath: string | null; outcome: string | null; cause: string | null; cleanup: string | null;
  /** Configured versus applied model and effort when the closest configured fallback was launched. */
  model?: ProbeModel | null;
};
export type ProbeModel = {
  configured: { level: string; model: string | null; effort: string | null };
  applied: { model: string; effort: string | null; modelLevel: string; effortLevel: string | null };
  fallback: boolean;
};
export type BaselineRecord = {
  status: 'pending' | 'complete';
  fingerprints: Record<string, string>;
  tests: { status: number | null; signal: string | null; error: string | null; totals: string; capture: string } | null;
  gaps: string[];
};
export type Relocation = { phase: 'staging' | 'failed' | 'published'; destination: string };
export type RunManifest = {
  version: 1; runId: string; revision: string; createdAt: string; settings: AuditConfig;
  baseline: BaselineRecord; budgets: Record<string, Record<string, number>>;
  scopes: Record<string, ScopeRecord>; probes: Record<string, ProbeRecord>;
  hostHandles: Record<string, string>; relocation: Relocation | null;
};

// ============================================================================
// SECTION: Configuration
// ============================================================================

export const DEFAULT_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
const LIMIT_KEYS = [
  'scopes', 'scenariosPerVerb', 'sharedBoundaries', 'branchExpansionsPerScope', 'repairFollowUps', 'scopeToolCalls', 'scopeMinutes',
  'leadInvestigationCalls', 'baselineTestRuns', 'focusedReproductions', 'probeLaunchesPerProvider', 'probeDeadlineSeconds',
  'probeTerminationGraceSeconds', 'probeCaptureBytes', 'probeFixtureBytes', 'probeGenerationTokens',
] as const;
const SCOPE_STATES = new Set<string>(['pending', 'running', 'complete', 'partial', 'failed', 'interrupted', 'cancelled']);
const PROBE_STATES = new Set<string>(['pending', 'running', 'complete', 'skipped', 'failed', 'timeout', 'interrupted']);
const MANIFEST = 'manifest.json';

export function loadAuditConfig(file: string = DEFAULT_CONFIG_PATH): AuditConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== 'version' && key !== 'limits') throw new Error(`Audit config: unknown key ${key}`);
  if (raw['version'] !== 1) throw new Error(`Audit config: unsupported version ${String(raw['version'])} (expected 1)`);
  const limits = raw['limits'];
  if (!limits || typeof limits !== 'object') throw new Error('Audit config: limits must be an object');
  const entries = limits as Record<string, unknown>;
  for (const key of Object.keys(entries)) if (!isLimit(key)) throw new Error(`Audit config: unknown limit ${key}`);
  for (const key of LIMIT_KEYS) {
    const value = entries[key];
    if (value === undefined) throw new Error(`Audit config: missing limit ${key}`);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Audit config: ${key} must be a positive safe integer`);
  }
  return { version: 1, limits: { ...(entries as Record<LimitName, number>) } };
}

// ============================================================================
// SECTION: Run Manifest
// ============================================================================

export function reserveRun(
  workDir: string,
  options: { runId: string; revision: string; config: AuditConfig; clock?: Clock },
  io: RunIo = fs,
): RunManifest {
  io.mkdirSync(path.dirname(workDir), { recursive: true });
  try {
    // Non-recursive mkdir is the exclusive reservation: a second run with the same id fails here.
    io.mkdirSync(workDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    throw new Error(`Run ${options.runId} is already reserved at ${workDir}; pass a new --run id, or --resume to continue it.`);
  }
  const manifest: RunManifest = {
    version: 1, runId: options.runId, revision: options.revision, createdAt: (options.clock ?? { now: () => new Date() }).now().toISOString(),
    settings: options.config, baseline: { status: 'pending', fingerprints: {}, tests: null, gaps: [] },
    budgets: {}, scopes: {}, probes: {}, hostHandles: {}, relocation: null,
  };
  writeAtomic(workDir, manifest, io);
  return manifest;
}

export function readRun(workDir: string, options: { revision?: string } = {}, io: RunIo = fs): RunManifest {
  const file = path.join(workDir, MANIFEST);
  if (!io.existsSync(file)) {
    if (io.existsSync(workDir) && io.readdirSync(workDir).length > 0) {
      throw new Error(`${workDir} is a legacy work directory without a manifest; start a fresh run with a new --run id (its evidence is left in place).`);
    }
    throw new Error(`No audit run reserved at ${workDir}.`);
  }
  const manifest = JSON.parse(String(io.readFileSync(file, 'utf8'))) as RunManifest;
  if (manifest.version !== 1) throw new Error(`Unsupported run manifest version ${String(manifest.version)} in ${file}`);
  if (options.revision !== undefined && options.revision !== manifest.revision) {
    throw new Error(`stale run: manifest revision ${manifest.revision} differs from current ${options.revision}; start a fresh run.`);
  }
  return manifest;
}

/** Read-modify-write under the manifest lock, so the backgrounded probe and the lead never lose each other's updates. */
export function updateRun(workDir: string, mutate: (manifest: RunManifest) => void, io: RunIo = fs, lock: LockOptions = {}): RunManifest {
  return withLock(workDir, io, lock, () => {
    const before = readRun(workDir, {}, io);
    const next = structuredClone(before);
    mutate(next);
    validate(before, next);
    writeAtomic(workDir, next, io);
    return next;
  });
}

export function consumeBudget(workDir: string, owner: string, limit: string, io: RunIo = fs): { allowed: boolean; used: number; limit: number } {
  if (!isLimit(limit)) throw new Error(`unknown limit ${limit}`);
  let result = { allowed: false, used: 0, limit: 0 };
  // The check runs inside the locked update, so two consumers cannot both take the last unit.
  updateRun(workDir, (m) => {
    const max = m.settings.limits[limit];
    const used = m.budgets[owner]?.[limit] ?? 0;
    result = used >= max ? { allowed: false, used, limit: max } : { allowed: true, used: used + 1, limit: max };
    if (result.allowed) m.budgets[owner] = { ...m.budgets[owner], [limit]: used + 1 };
  }, io);
  return result;
}

/** The source stays authoritative until a published relocation's destination exists; other copies are uncertain. */
export function resolveAuthority(
  source: string,
  relocation: Relocation | null,
  exists: (p: string) => boolean = fs.existsSync,
): { authoritative: string; uncertain: string[]; removeSource: boolean } {
  if (relocation?.phase === 'published' && exists(relocation.destination)) {
    return { authoritative: relocation.destination, uncertain: [], removeSource: exists(source) };
  }
  const uncertain = relocation && relocation.phase !== 'published' && exists(relocation.destination) ? [relocation.destination] : [];
  return { authoritative: source, uncertain, removeSource: false };
}

// ============================================================================
// SECTION: Internals
// ============================================================================

function isLimit(key: string): key is LimitName {
  return (LIMIT_KEYS as readonly string[]).includes(key);
}

function validate(before: RunManifest, next: RunManifest): void {
  for (const [id, scope] of Object.entries(next.scopes)) if (!SCOPE_STATES.has(scope.lifecycle)) throw new Error(`scope ${id}: invalid lifecycle ${String(scope.lifecycle)}`);
  for (const [id, probe] of Object.entries(next.probes)) if (!PROBE_STATES.has(probe.lifecycle)) throw new Error(`probe ${id}: invalid lifecycle ${String(probe.lifecycle)}`);
  if (before.baseline.status === 'complete' && JSON.stringify(before.baseline) !== JSON.stringify(next.baseline)) {
    throw new Error('A completed baseline is immutable; start a fresh run to re-baseline.');
  }
}

const LOCK = `${MANIFEST}.lock`;
const blockingSleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function withLock<T>(workDir: string, io: RunIo, options: LockOptions, body: () => T): T {
  const clock = options.clock ?? { now: () => new Date() };
  const { sleep = blockingSleep, retries = 200, retryMs = 25, staleMs = 30_000 } = options;
  const file = path.join(workDir, LOCK);
  for (let attempt = 0; ; attempt++) {
    try {
      // Exclusive create is the cross-process mutex; the timestamp lets a crashed holder's lock be reclaimed.
      io.writeFileSync(file, JSON.stringify({ pid: process.pid, at: clock.now().getTime() }), { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = lockAge(file, io, clock);
      if (age === Number.POSITIVE_INFINITY) continue;
      if (age > staleMs) { io.rmSync(file, { force: true }); continue; }
      if (attempt >= retries) throw new Error(`run manifest is locked by another writer (${file}); retry, or remove the lock if no audit process is running.`);
      sleep(retryMs);
    }
  }
  try { return body(); } finally { io.rmSync(file, { force: true }); }
}

function lockAge(file: string, io: RunIo, clock: Clock): number {
  let text: string;
  try { text = String(io.readFileSync(file, 'utf8')); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Number.POSITIVE_INFINITY; // released meanwhile
    throw err;
  }
  // NOTE: an unparsable lock may be mid-create by a live writer, so it counts as fresh; the retry bound still ends the wait.
  try {
    const at = (JSON.parse(text) as { at?: unknown }).at;
    return typeof at === 'number' ? clock.now().getTime() - at : 0;
  } catch { return 0; }
}

function writeAtomic(workDir: string, manifest: RunManifest, io: RunIo): void {
  // Same-directory temp keeps rename atomic; a failed rename leaves the previous manifest intact.
  const temp = path.join(workDir, `.${MANIFEST}.${process.pid}.${Date.now()}.tmp`);
  try {
    io.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    io.renameSync(temp, path.join(workDir, MANIFEST));
  } catch (err) {
    io.rmSync(temp, { force: true });
    throw err;
  }
}
