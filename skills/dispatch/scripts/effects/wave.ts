// The `wave` effect (spec §6.4–§6.6, ADR 0006; ports legacy driver/wave-process.mjs). The handler arbitrates an
// attempt through claim files, launches a detached worker, and reconciles its per-slot outcome files into
// `WAVE_PROGRESS` events and exactly one `WAVE_DONE`. Two-phase path: `startWave` hands native descriptors to the
// host; `finishWave` reconciles their captures.
//
// Attempt n files, all under the run dir:
//   <id>.input.json                 handler-written worker input (roster, round, timeout, per-slot paths)
//   <id>.a<n>.claim.json            {pid, host, startedAt} published by link, or a tombstone {fenced, by, at}
//   <id>.a<n>.heartbeat.json        {heartbeatAt}, refreshed every 30 s
//   <id>.a<n>.<slot>.outcome.json   one SlotFinal per roster slot
//   <id>.a<n>.done.json             written last

import type { EffectFailureClass, FailureClass, Handler, HandlerContext, ResultEvent, SlotOutcome } from '../core/types.ts';
import type { DraftFinding, ReviewKind, RosterSlot } from '../domain/types.ts';
import { collectFindings, parseReport, type ReportFailureKind } from '../domain/report.ts';
import { sanitizeText } from '../domain/sanitize.ts';
import { hasReserve, next, reservePool, takeReserve, type Position, type ReservePool } from '../policy/cascade.ts';
import { nativeDescriptor, type NativeDescriptor } from '../providers/native.ts';
import type { DelegateRequest, ModeId, ProviderId, ProviderSpec, RunOutcome } from '../providers/types.ts';
import { publishExclusive, type LinkFs } from '../lib/fs-ext.ts';

export const HEARTBEAT_MS = 30_000;
export const STALE_GRACE_MS = 30_000;

type WaveEffect = { kind: 'wave'; id: string; round: number; roster: readonly Readonly<Record<string, unknown>>[]; timeoutMs: number };

const unreachable = (value: never, what: string): never => { throw new Error(`unhandled ${what}: ${JSON.stringify(value)}`); };

// SECTION: File names

const join = (dir: string, name: string): string => `${dir.replace(/[/\\]+$/, '')}/${name}`;
export const safeSlot = (slot: string): string => slot.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'slot';
export const inputPath = (runDir: string, id: string): string => join(runDir, `${id}.input.json`);
export const claimPath = (runDir: string, id: string, n: number): string => join(runDir, `${id}.a${n}.claim.json`);
export const heartbeatPath = (runDir: string, id: string, n: number): string => join(runDir, `${id}.a${n}.heartbeat.json`);
export const outcomePath = (runDir: string, id: string, n: number, slot: string): string => join(runDir, `${id}.a${n}.${safeSlot(slot)}.outcome.json`);
export const donePath = (runDir: string, id: string, n: number): string => join(runDir, `${id}.a${n}.done.json`);

const readJson = <T>(fs: LinkFs, file: string): T | null => {
  const text = fs.readText(file);
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
};

// SECTION: Worker input

export type SlotPaths = { promptPath: string; logPath: string; attachments: readonly string[] };

export type WaveInput = {
  effectId: string;
  round: number;
  timeoutMs: number;
  /** `ask` slots yield one sanitized raw-text claim instead of parsed findings. */
  review: ReviewKind | 'ask';
  orchestratorPlatform: ProviderId | null;
  cwd: string;
  roster: readonly RosterSlot[];
  paths: Readonly<Record<string, SlotPaths>>;
};

/** Host context the handler cannot derive from the effect alone. */
export type WaveContext = Omit<WaveInput, 'effectId' | 'round' | 'timeoutMs' | 'roster'> & {
  /** The host serves native slots through the machine's `native` frame (two-wave path). */
  nativeHost?: boolean;
};

export function asRosterSlot(value: Readonly<Record<string, unknown>>): RosterSlot {
  const { slot, provider, index, model, effort, sandbox, native, reserve } = value;
  if (typeof slot !== 'string' || typeof provider !== 'string' || typeof index !== 'number') throw new Error(`invalid roster slot: ${JSON.stringify(value)}`);
  const out: RosterSlot = { slot, provider, index, native: native === true, reserve: reserve === true };
  if (typeof model === 'string' || (Array.isArray(model) && model.every((entry) => typeof entry === 'string'))) out.model = model as string | string[];
  if (typeof effort === 'string') out.effort = effort;
  if (typeof sandbox === 'boolean') out.sandbox = sandbox;
  return out;
}

const modelsOf = (slot: RosterSlot): string[] => (slot.model === undefined ? [] : typeof slot.model === 'string' ? [slot.model] : [...slot.model]);

// SECTION: Slot finals (closed union)

type Success = { provider: string; model: string | null; mode: ModeId | null; resume: string | null; drafts: DraftFinding[]; records: string[]; claim?: string };

export type SlotFinal =
  | ({ state: 'success'; slot: string } & Success)
  | ({ state: 'reserve'; slot: string; by: string; record: string } & Success)
  | { state: 'native'; slot: string; sourceKey: string; reason: string; records: string[]; drafts?: DraftFinding[]; descriptor?: NativeDescriptor; claim?: string }
  | { state: 'failed'; slot: string; cls: FailureClass | 'worker'; reason: string; records: string[] };

export function slotStatus(final: SlotFinal): string {
  switch (final.state) {
    case 'success': return 'done';
    case 'reserve': return `reserve:${final.by}`;
    case 'native': return final.drafts ? 'native' : 'native-pending';
    case 'failed': return `failed:${final.cls}`;
    default: return unreachable(final, 'slot final');
  }
}

/** The WAVE_DONE row: every field except the raw drafts (findings travel separately, with ids). */
export function slotOutcome(final: SlotFinal): SlotOutcome {
  switch (final.state) {
    case 'success': case 'reserve': case 'native': case 'failed': {
      const { drafts: _drafts, ...row } = final as SlotFinal & { drafts?: unknown };
      return row;
    }
    default: return unreachable(final, 'slot final');
  }
}

// SECTION: Claims (closed union of reads)

export type ClaimFile = { pid: number; host: string; startedAt: number } | { fenced: true; by: string; at: number };

export type ClaimRead =
  | { kind: 'absent' }
  | { kind: 'tombstone' }
  | { kind: 'foreign'; host: string }
  | { kind: 'live' }
  | { kind: 'dead' }
  | { kind: 'stale' };

export type ClaimDeps = { fs: LinkFs; proc: { host: string; isAlive(pid: number): boolean }; clock: { now(): number } };

export function readClaim(deps: ClaimDeps, runDir: string, id: string, n: number, timeoutMs: number): ClaimRead {
  const claim = readJson<ClaimFile>(deps.fs, claimPath(runDir, id, n));
  if (claim === null) return { kind: 'absent' };
  if ('fenced' in claim) return { kind: 'tombstone' };
  if (claim.host !== deps.proc.host) return { kind: 'foreign', host: claim.host };
  if (!deps.proc.isAlive(claim.pid)) return { kind: 'dead' };
  const now = deps.clock.now();
  const beat = readJson<{ heartbeatAt: number }>(deps.fs, heartbeatPath(runDir, id, n));
  const quiet = beat === null || now - beat.heartbeatAt > HEARTBEAT_MS;
  // A live pid past its deadline plus grace with no recent heartbeat is a reused pid or a wedged worker.
  return now > claim.startedAt + timeoutMs + STALE_GRACE_MS && quiet ? { kind: 'stale' } : { kind: 'live' };
}

/** Highest attempt with a claim file; 0 when none. */
export function latestAttempt(fs: LinkFs, runDir: string, id: string): number {
  const pattern = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.a(\\d+)\\.claim\\.json$`);
  return fs.list(runDir).reduce((max, name) => Math.max(max, Number(pattern.exec(name)?.[1] ?? 0)), 0);
}

export type Arbitration = { action: 'reattach'; attempt: number } | { action: 'launch'; attempt: number };

/**
 * Settles attempt `n`: fence it with a tombstone (success → nothing ever claimed it → n+1); otherwise read the
 * claim. Tombstone or dead → n+1; live → reattach; stale → n+1 without a kill; foreign host → engine fault.
 */
export function arbitrate(deps: ClaimDeps, runDir: string, id: string, n: number, timeoutMs: number): Arbitration {
  const tombstone: ClaimFile = { fenced: true, by: 'send', at: deps.clock.now() };
  if (publishExclusive(deps.fs, claimPath(runDir, id, n), JSON.stringify(tombstone))) return { action: 'launch', attempt: n + 1 };
  const read = readClaim(deps, runDir, id, n, timeoutMs);
  switch (read.kind) {
    case 'live': return { action: 'reattach', attempt: n };
    case 'absent': // removed between link and read: treat as fenced
    case 'tombstone': case 'dead': case 'stale': return { action: 'launch', attempt: n + 1 };
    case 'foreign': throw new Error(`wave claim ${claimPath(runDir, id, n)} belongs to host ${read.host}; the run dir is shared across hosts`);
    default: return unreachable(read, 'claim read');
  }
}

// SECTION: Worker

export type WorkerDeps = {
  fs: LinkFs;
  proc: { pid: number; host: string };
  clock: { now(): number; every(ms: number, fn: () => void): () => void };
  specs: Readonly<Record<ProviderId, ProviderSpec>>;
  /** Modes with a launchable binary, in cascade order. */
  modes(provider: ProviderId): readonly ModeId[];
  run(provider: ProviderId, req: DelegateRequest, mode: ModeId): Promise<RunOutcome>;
  outputCapBytes?: number;
};

export const REPORT_CLASS: Readonly<Record<ReportFailureKind, FailureClass>> = {
  'empty-output': 'empty-output', refusal: 'refusal', truncated: 'truncated', 'uncovered-scope': 'refusal', 'loose-locus': 'refusal',
};

type Attempted = { ok: true; value: Success } | { ok: false; cls: FailureClass; reason: string; records: string[] };

async function runVoice(slot: RosterSlot, input: WaveInput, deps: WorkerDeps, deadline: number): Promise<Attempted & { position?: Position }> {
  const provider = slot.provider as ProviderId;
  const spec = deps.specs[provider];
  const models = modelsOf(slot);
  const modes = spec ? deps.modes(provider) : [];
  const records: string[] = [];
  if (!spec || !modes.length) return { ok: false, cls: 'not-found', reason: `${slot.slot}: no launchable ${slot.provider} binary`, records };
  const paths = input.paths[slot.slot];
  if (!paths) return { ok: false, cls: 'config', reason: `${slot.slot}: no prompt paths in the wave input`, records };
  const voice = { slot: slot.slot, platform: slot.provider, models: models.length ? models : [null], modes, modeCascadeOn: spec.modeCascadeOn };
  let position: Position = { model: 0, mode: 0 };
  for (;;) {
    const remaining = deadline - deps.clock.now();
    if (remaining <= 0) return { ok: false, cls: 'timeout', reason: `${slot.slot}: wave deadline passed`, records, position };
    const mode = modes[position.mode] ?? 'cli';
    const model = voice.models[position.model] ?? null;
    const req: DelegateRequest = {
      promptPath: paths.promptPath, model, effort: slot.effort ?? null, sandbox: slot.sandbox ?? true, schemaPath: null, resume: null,
      cwd: input.cwd, timeoutMs: Math.min(input.timeoutMs, remaining), outputCapBytes: deps.outputCapBytes ?? 10 * 1024 * 1024,
      attachments: paths.attachments, logPath: paths.logPath, briefPath: `${paths.logPath}.brief.md`,
    };
    const outcome = await deps.run(provider, req, mode);
    let cls: FailureClass;
    let reason: string;
    if (outcome.status === 'ok' && input.review === 'ask') {
      const claim = sanitizeText(outcome.text);
      if (claim) return { ok: true, value: { provider: slot.provider, model, mode, resume: outcome.resume, drafts: [], records, claim }, position };
      cls = 'empty-output';
      reason = 'empty-output: the delegate returned no text';
    } else if (outcome.status === 'ok') {
      const report = parseReport({ kind: input.review === 'ask' ? 'code' : input.review, source: slot.slot, text: outcome.text });
      if (report.ok) return { ok: true, value: { provider: slot.provider, model, mode, resume: outcome.resume, drafts: report.findings, records }, position };
      cls = REPORT_CLASS[report.failure.kind];
      reason = `${report.failure.kind}: ${report.failure.detail}`;
    } else {
      cls = outcome.cls;
      reason = `${outcome.cls}: ${outcome.detail}`;
    }
    records.push(`${slot.slot} ${model ?? 'default'}@${mode} → ${reason}`);
    const decision = next(cls, position, voice, { orchestratorPlatform: null, reserveAvailable: false });
    switch (decision.kind) {
      case 'next-model': case 'next-mode': position = decision.position; continue;
      case 'reserve': case 'native-fallback': case 'terminal': return { ok: false, cls, reason, records, position };
      default: return unreachable(decision, 'cascade decision');
    }
  }
}

async function runSlot(slot: RosterSlot, input: WaveInput, deps: WorkerDeps, deadline: number, pool: { current: ReservePool }, reserves: ReadonlyMap<string, RosterSlot>): Promise<SlotFinal> {
  const own = await runVoice(slot, input, deps, deadline);
  if (own.ok) return { state: 'success', slot: slot.slot, ...own.value };
  // The voice is exhausted: reserve (once per wave), then native fallback on the orchestrator platform.
  // An empty voice asks the cascade only for its post-exhaustion step.
  const decision = next(own.cls, { model: 0, mode: 0 }, { slot: slot.slot, platform: slot.provider, models: [], modes: [], modeCascadeOn: [] },
    { orchestratorPlatform: input.orchestratorPlatform, reserveAvailable: hasReserve(pool.current) && deps.clock.now() < deadline });
  switch (decision.kind) {
    case 'reserve': {
      const taken = takeReserve(pool.current, slot.slot, own.reason);
      pool.current = taken.pool;
      const reserve = taken.reserve === null ? undefined : reserves.get(taken.reserve);
      const record = taken.pool.records[taken.pool.records.length - 1] ?? '';
      if (!reserve) return { state: 'failed', slot: slot.slot, cls: own.cls, reason: own.reason, records: own.records };
      // The reserve answers the failed slot's prompt; its log sits beside the slot's.
      const own_ = input.paths[slot.slot];
      const paths = own_ ? { ...input.paths, [reserve.slot]: { ...own_, logPath: `${own_.logPath}.${safeSlot(reserve.slot)}` } } : input.paths;
      const substitute = await runVoice(reserve, { ...input, paths }, deps, deadline);
      if (substitute.ok) return { state: 'reserve', slot: slot.slot, by: reserve.slot, record, ...substitute.value, records: [...own.records, ...substitute.value.records] };
      return { state: 'failed', slot: slot.slot, cls: substitute.cls, reason: `${own.reason}; reserve ${reserve.slot}: ${substitute.reason}`, records: [...own.records, record, ...substitute.records] };
    }
    case 'native-fallback':
      return { state: 'native', slot: slot.slot, sourceKey: `${slot.slot}#fallback`, reason: own.reason, records: own.records };
    case 'next-model': case 'next-mode': case 'terminal':
      return { state: 'failed', slot: slot.slot, cls: own.cls, reason: own.reason, records: own.records };
    default: return unreachable(decision, 'cascade decision');
  }
}

export type WorkerResult = { launched: false } | { launched: true; finals: SlotFinal[] };

/**
 * The detached worker for attempt `n`: publish the claim (a tombstone already there fences it: exit without
 * launching), heartbeat, run every non-reserve CLI slot under its own deadline, write outcome files, then done.
 */
export async function runWaveWorker(runDir: string, id: string, n: number, deps: WorkerDeps): Promise<WorkerResult> {
  const input = readJson<WaveInput>(deps.fs, inputPath(runDir, id));
  if (!input) throw new Error(`wave worker: missing input ${inputPath(runDir, id)}`);
  const startedAt = deps.clock.now();
  const claim: ClaimFile = { pid: deps.proc.pid, host: deps.proc.host, startedAt };
  if (!publishExclusive(deps.fs, claimPath(runDir, id, n), JSON.stringify(claim))) return { launched: false };
  const beat = (): void => deps.fs.writeAtomic(heartbeatPath(runDir, id, n), JSON.stringify({ heartbeatAt: deps.clock.now() }));
  beat();
  const stopBeat = deps.clock.every(HEARTBEAT_MS, beat);
  const deadline = startedAt + input.timeoutMs;
  const reserves = new Map(input.roster.filter((slot) => slot.reserve).map((slot) => [slot.slot, slot] as const));
  const pool = { current: reservePool([...reserves.keys()]) };
  const finals: SlotFinal[] = [];
  try {
    // Primary slots run concurrently (legacy batch parity) so one slow delegate cannot starve the rest of the deadline.
    const primaries = input.roster.filter((slot) => !slot.reserve && !slot.native);
    finals.push(...await Promise.all(primaries.map(async (slot) => {
      const final = await runSlot(slot, input, deps, deadline, pool, reserves);
      deps.fs.writeAtomic(outcomePath(runDir, id, n, slot.slot), JSON.stringify(final));
      return final;
    })));
    deps.fs.writeAtomic(donePath(runDir, id, n), JSON.stringify({ at: deps.clock.now(), slots: finals.length }));
  } finally {
    stopBeat();
  }
  return { launched: true, finals };
}

// SECTION: Handler

export type WaveDeps = ClaimDeps & {
  context(effect: WaveEffect): WaveContext;
  /** Starts the detached worker for attempt n (`runWaveWorker` in its own process). */
  launchWorker(runDir: string, id: string, n: number): void;
  /** Resolves once attempt n's done file exists or its worker exited. */
  awaitWorker(runDir: string, id: string, n: number): Promise<void>;
};

const failed = (effectId: string, cls: EffectFailureClass, detail: string): ResultEvent => ({ type: 'EFFECT_FAILED', effectId, cls, detail });

async function driveWorker(effect: WaveEffect, roster: readonly RosterSlot[], deps: WaveDeps, ctx: HandlerContext): Promise<number> {
  const file = inputPath(ctx.runDir, effect.id);
  if (deps.fs.readText(file) === null) {
    const input: WaveInput = { ...deps.context(effect), effectId: effect.id, round: effect.round, timeoutMs: effect.timeoutMs, roster };
    deps.fs.writeAtomic(file, JSON.stringify(input));
  }
  const latest = latestAttempt(deps.fs, ctx.runDir, effect.id);
  // A resumed send settles the newest attempt; a first send launches past any leftovers.
  const decision: Arbitration = ctx.attempt > 1 || latest > 0 ? arbitrate(deps, ctx.runDir, effect.id, Math.max(latest, 1), effect.timeoutMs) : { action: 'launch', attempt: 1 };
  if (decision.action === 'launch') deps.launchWorker(ctx.runDir, effect.id, decision.attempt);
  await deps.awaitWorker(ctx.runDir, effect.id, decision.attempt);
  return decision.attempt;
}

function readFinals(deps: WaveDeps, runDir: string, id: string, n: number, roster: readonly RosterSlot[]): SlotFinal[] {
  return roster.filter((slot) => !slot.reserve && !slot.native).map((slot): SlotFinal =>
    readJson<SlotFinal>(deps.fs, outcomePath(runDir, id, n, slot.slot))
      ?? { state: 'failed', slot: slot.slot, cls: 'worker', reason: `attempt ${n} wrote no outcome for ${slot.slot}`, records: [] });
}

export function waveDone(effect: WaveEffect, finals: readonly SlotFinal[]): ResultEvent[] {
  const progress: ResultEvent[] = finals.map((final) => ({ type: 'WAVE_PROGRESS', effectId: effect.id, slot: final.slot, status: slotStatus(final) }));
  const drafts = finals.flatMap((final) => final.state === 'failed' ? [] : final.drafts ?? []);
  return [...progress, { type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: finals.map(slotOutcome), findings: collectFindings(effect.round, drafts) }];
}

/**
 * Single-shot handler. With `context.nativeHost` (the two-wave machine path, I04), native-needed slots come back
 * `state: 'native'` with their descriptor for the host; otherwise native rosters are rejected and a runtime native
 * fallback fails by name (no host serves it).
 */
export function createWaveHandler(deps: WaveDeps): Handler<Extract<Parameters<Handler>[0], { kind: 'wave' }>> {
  return async (effect, _ports, ctx) => {
    let roster: RosterSlot[];
    try { roster = effect.roster.map(asRosterSlot); } catch (error) { return [failed(effect.id, 'config', (error as Error).message)]; }
    const context = deps.context(effect);
    const host = context.nativeHost === true && context.orchestratorPlatform !== null ? context.orchestratorPlatform : null;
    if (host === null && roster.some((slot) => slot.native)) return [failed(effect.id, 'config', 'roster has native slots; use startWave/finishWave')];
    const describe = (slot: string, substitutes: boolean, models: readonly string[], effort: string | null): NativeDescriptor | null => {
      const paths = context.paths[slot];
      if (!paths || host === null) return null;
      return nativeDescriptor({
        slot, platform: host, models, effort, substitutes, cascadePosition: 0, promptPath: paths.promptPath,
        outputPath: outputOf(paths, substitutes ? `${slot}#fallback` : slot), attachments: paths.attachments,
      });
    };
    const cli = roster.filter((slot) => !slot.native);
    let cliFinals: SlotFinal[];
    try {
      const n = cli.some((slot) => !slot.reserve) ? await driveWorker(effect, cli, deps, ctx) : 0;
      cliFinals = n > 0 ? readFinals(deps, ctx.runDir, effect.id, n, cli) : [];
    } catch (error) {
      return [failed(effect.id, 'io', `wave worker: ${error instanceof Error ? error.message : String(error)}`)];
    }
    const finals = roster.filter((slot) => !slot.reserve).flatMap((slot): SlotFinal[] => {
      if (slot.native) {
        const descriptor = describe(slot.slot, false, modelsOf(slot), slot.effort ?? null);
        return [descriptor
          ? { state: 'native', slot: slot.slot, sourceKey: descriptor.sourceKey, reason: 'nativeSubagentsOnly', records: [], descriptor }
          : { state: 'failed', slot: slot.slot, cls: 'config', reason: `native slot ${slot.slot} has no prompt path`, records: [] }];
      }
      const final = cliFinals.find((entry) => entry.slot === slot.slot);
      if (!final) return [];
      if (final.state !== 'native') return [final];
      const descriptor = describe(slot.slot, true, modelsOf(slot), slot.effort ?? null);
      return [descriptor
        ? { ...final, descriptor }
        : { state: 'failed', slot: final.slot, cls: 'worker', reason: `native fallback unavailable in single-shot mode (${final.reason})`, records: final.records }];
    });
    return waveDone(effect, finals);
  };
}

// SECTION: Two-phase native path

export type WaveStart = { native: NativeDescriptor[]; early: NativeDescriptor[]; progress: ResultEvent[]; attempt: Promise<number> };

const outputOf = (paths: SlotPaths, key: string): string => `${paths.logPath}.${safeSlot(key)}.native.md`;

/**
 * Starts the CLI worker and returns descriptors for the host: `nativeSubagentsOnly` slots, plus an early fallback
 * (position 0) for each CLI slot on the orchestrator platform so a native capture is ready if the CLI fails.
 */
export function startWave(effect: WaveEffect, ctx: HandlerContext, deps: WaveDeps): WaveStart {
  const roster = effect.roster.map(asRosterSlot);
  const context = deps.context(effect);
  const describe = (slot: RosterSlot, substitutes: boolean): NativeDescriptor[] => {
    const paths = context.paths[slot.slot];
    if (!paths || context.orchestratorPlatform === null) return [];
    return [nativeDescriptor({
      slot: slot.slot, platform: context.orchestratorPlatform, models: modelsOf(slot), effort: slot.effort ?? null, substitutes,
      cascadePosition: 0, promptPath: paths.promptPath, outputPath: outputOf(paths, substitutes ? `${slot.slot}#fallback` : slot.slot), attachments: paths.attachments,
    })];
  };
  const native = roster.filter((slot) => slot.native).flatMap((slot) => describe(slot, false));
  const early = roster.filter((slot) => !slot.native && !slot.reserve && slot.provider === context.orchestratorPlatform).flatMap((slot) => describe(slot, true));
  const progress: ResultEvent[] = roster.filter((slot) => !slot.reserve)
    .map((slot) => ({ type: 'WAVE_PROGRESS', effectId: effect.id, slot: slot.slot, status: slot.native ? 'native-pending' : 'launched' }));
  const cli = roster.filter((slot) => !slot.native);
  const attempt = cli.some((slot) => !slot.reserve) ? driveWorker(effect, cli, deps, ctx) : Promise.resolve(0);
  return { native, early, progress, attempt };
}

type Capture = { sourceKey: string; text: string };

function captureOf(value: Readonly<Record<string, unknown>>, fs: LinkFs): Capture | null {
  const { sourceKey, text, outputPath } = value;
  if (typeof sourceKey !== 'string') return null;
  if (typeof text === 'string') return { sourceKey, text };
  if (typeof outputPath === 'string') return { sourceKey, text: fs.readText(outputPath) ?? '' };
  return { sourceKey, text: '' };
}

/** Reconciles the worker's finals with `NATIVE_RESULTS` captures by `sourceKey`; one `WAVE_DONE`. */
export async function finishWave(effect: WaveEffect, ctx: HandlerContext, start: WaveStart, nativeResults: readonly Readonly<Record<string, unknown>>[], deps: WaveDeps & { review: ReviewKind }): Promise<ResultEvent[]> {
  const roster = effect.roster.map(asRosterSlot);
  const n = await start.attempt;
  const captures = new Map(nativeResults.map((value) => captureOf(value, deps.fs)).filter((capture): capture is Capture => capture !== null).map((capture) => [capture.sourceKey, capture.text]));
  const fromCapture = (slot: string, key: string, prior: string[]): SlotFinal | null => {
    const text = captures.get(key);
    if (text === undefined) return null;
    const report = parseReport({ kind: deps.review, source: slot, text });
    return report.ok
      ? { state: 'native', slot, sourceKey: key, reason: 'native capture', records: prior, drafts: report.findings }
      : { state: 'failed', slot, cls: REPORT_CLASS[report.failure.kind], reason: `native ${key}: ${report.failure.kind}: ${report.failure.detail}`, records: prior };
  };
  const cliFinals = n > 0 ? readFinals(deps, ctx.runDir, effect.id, n, roster.filter((slot) => !slot.native)) : [];
  const finals: SlotFinal[] = [];
  for (const slot of roster) {
    if (slot.reserve) continue;
    if (slot.native) {
      finals.push(fromCapture(slot.slot, slot.slot, []) ?? { state: 'failed', slot: slot.slot, cls: 'empty-output', reason: `no native capture for ${slot.slot}`, records: [] });
      continue;
    }
    const final = cliFinals.find((entry) => entry.slot === slot.slot);
    if (!final) continue;
    switch (final.state) {
      case 'success': case 'reserve': finals.push(final); break;
      case 'native': case 'failed':
        finals.push(fromCapture(slot.slot, `${slot.slot}#fallback`, final.records)
          ?? (final.state === 'native' ? { state: 'failed', slot: slot.slot, cls: 'empty-output', reason: `no native capture for ${final.sourceKey}`, records: final.records } : final));
        break;
      default: unreachable(final, 'slot final');
    }
  }
  return waveDone(effect, finals).filter((event) => event.type === 'WAVE_DONE');
}
