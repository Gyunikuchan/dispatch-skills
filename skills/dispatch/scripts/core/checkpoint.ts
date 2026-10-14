import crypto from 'node:crypto';
import path from 'node:path';
import { EngineFault, type JournalRead } from './journal.ts';
import type { Folder } from './interpreter.ts';
import type { TimelineFacts } from './diagnostics.ts';
import type { CheckpointReference, Effect, JournalLine, Machine, Ports } from './types.ts';
import { restoreSessionPaths, storeSessionPaths } from '../lib/session.ts';
import { validateExecutionReferences, migrateExecutionReferences, loadExecution, type SendOptions, type SendResult } from './interpreter.ts';
import { acquireLock, releaseLock, LockHeld } from './lock.ts';
import { readJournal, journalPath } from './journal.ts';
import { faultFrame, projectFrame, recoveryFrame } from './frame.ts';
import { artifactPath } from '../lib/immutable-artifact.ts';
import { encodePrivate, decodePrivate } from '../domain/private-state.ts';
import type { RuntimeRebound } from './types.ts';

export const CHECKPOINT_SCHEMA = 1 as const;
export const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(detail: string): never { throw new EngineFault(`checkpoint-invalid: ${detail}`); }
const effectKinds = new Set(['check-review-target', 'parse-artifact', 'prepare-review', 'wave', 'wave-start', 'wave-finish', 'verify', 'write-brief', 'check-envelope', 'snapshot', 'assess-recovery', 'restore', 'handoff', 'checkout']);

function effectDescriptor(value: unknown): boolean {
  if (!record(value) || typeof value['id'] !== 'string' || !value['id'] || !effectKinds.has(String(value['kind']))) return false;
  const strings = (...keys: string[]) => keys.every((key) => typeof value[key] === 'string' && value[key] !== '');
  const arrays = (...keys: string[]) => keys.every((key) => Array.isArray(value[key]));
  const objects = (...keys: string[]) => keys.every((key) => record(value[key]));
  switch (value['kind']) {
    case 'parse-artifact': return strings('path') && ['plan', 'design'].includes(String(value['artifact']));
    case 'check-review-target': return objects('review') && strings('manifestPath') && arrays('allowedPaths');
    case 'prepare-review': return objects('review', 'scope') && Number.isSafeInteger(value['round']) && Number(value['round']) > 0;
    // NOTE: native-only waves have no worker attempt; their producer binds attempt zero.
    case 'wave': case 'wave-start': case 'wave-finish': return arrays('roster') && Number.isSafeInteger(value['round']) && Number(value['round']) > 0 && typeof value['timeoutMs'] === 'number' && value['timeoutMs'] >= 0 && (value['kind'] !== 'wave-finish' || strings('waveKey') && arrays('captures') && Number.isSafeInteger(value['attempt']) && (Number(value['attempt']) > 0 || value['attempt'] === 0 && (value['roster'] as unknown[]).every((slot) => record(slot) && (slot['native'] === true || slot['reserve'] === true))));
    case 'verify': return strings('purpose') && arrays('commands');
    case 'write-brief': return ['task', 'hotfix'].includes(String(value['stage'])) && objects('input');
    case 'check-envelope': return strings('envelopePath') && arrays('permitted');
    case 'snapshot': return value['since'] === null || objects('since');
    case 'assess-recovery': return ['drift', 'hotfix'].includes(String(value['purpose'])) && objects('before', 'after', 'input') && strings('phase', 'pendingId');
    case 'restore': return arrays('paths') && objects('to');
    case 'handoff': return typeof value['terminal'] === 'boolean';
    case 'checkout': return strings('op') && objects('input');
    default: return false;
  }
}

/** Encode private containers explicitly; frames never participate in this representation. */
export { encodePrivate, decodePrivate } from '../domain/private-state.ts';

export interface Checkpoint {
  schema: 1;
  codec: { name: string; version: number };
  runtime: string;
  binding: { run: string; repo: unknown };
  prefix: { seq: number; priorHash: string; payloadHash: string };
  state: unknown;
  queue: unknown;
  attempts: [string, number][];
  open: string[];
  execution: JournalRead['execution'] | null;
  timeline: TimelineFacts;
}

function validateRepositoryState(value: unknown, repository: unknown): void {
  if (Array.isArray(value)) { for (const item of value) validateRepositoryState(item, repository); return; }
  if (!record(value)) return;
  const normalized = (item: unknown): unknown => typeof item === 'string' ? item.replaceAll('\\', '/') : record(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalized(item[key])])) : item;
  if (value['type'] === 'RUN_STARTED' && JSON.stringify(normalized(value['repo'])) !== JSON.stringify(normalized(repository))) fail('embedded repository binding');
  for (const item of Object.values(value)) validateRepositoryState(item, repository);
}

export interface RebindOptions<S> extends Pick<SendOptions<S>, 'runDir' | 'machine' | 'handlers' | 'ports' | 'runRel'> { reason: string; rawEvent?: unknown; repository?: unknown }

/** Rebind publishes a continuation checkpoint only; pending commands never execute here. */
export async function rebind<S>(options: RebindOptions<S>): Promise<SendResult> {
  const { machine, ports, runDir } = options, runRel = options.runRel ?? runDir.replaceAll('\\', '/');
  let locked = false;
  let appendBoundary: { bytes: number; seq: number; hash: string } | undefined;
  try {
    if (!options.reason?.trim()) throw new EngineFault('rebind-invalid: reason is required');
    try { acquireLock(ports, runDir); locked = true; } catch (error) { if (error instanceof LockHeld) return { frame: null, exitCode: 3, message: error.message }; throw error; }
    const read = readJournal(ports, runDir), sessionRoot = path.basename(path.dirname(runDir)) === 'runs' && path.basename(path.dirname(path.dirname(runDir))) === '.state' ? path.dirname(path.dirname(path.dirname(runDir))) : undefined;
    if (!read.checkpoint) throw new EngineFault('rebind-unsupported: no supported committed checkpoint; preserve artifacts');
    const records = [...read.records];
    if (records.some((line) => line.seq > read.checkpoint!.line.seq && line.type !== 'DIAGNOSTIC_NOTE' && line.type !== 'LOCK_BROKEN')) throw new EngineFault('rebind-invalid: uncheckpointed operational tail');
    const loaded = loadExecution(machine, ports, runDir, read, sessionRoot, false, read.records, true);
    const saved = loadCheckpoint(ports, runDir, machine, read, sessionRoot, false, true)!;
    if (options.repository !== undefined && JSON.stringify(options.repository) !== JSON.stringify(read.started?.data['repo'])) fail('live repository binding');
    validateExecutionReferences(loaded.folder.state, ports, runDir); validateExecutionReferences(loaded.folder.queue, ports, runDir);
    validateExecutionReferences(read.checkpoint.line.checkpoint, ports, runDir);
    const portableState = sessionRoot ? storeSessionPaths(machine.codec!.encode(loaded.folder.state), sessionRoot) : machine.codec!.encode(loaded.folder.state);
    const migration = JSON.stringify(portableState) !== JSON.stringify(saved.checkpoint.state);
    const event: RuntimeRebound = { type: 'RUNTIME_REBOUND', epoch: records.filter((line) => line.type === 'RUNTIME_REBOUND').length + 1, oldRuntime: saved.checkpoint.runtime, newRuntime: machine.codec!.runtime(), reason: options.reason, source: read.checkpoint.line.checkpoint!, prefixHash: read.prefixHash!, ...(migration ? { migration: 'review-manifest-v1' as const } : {}) };
    // Optional input is checked now, then supplied on send; rebind itself never advances the machine.
    if (options.rawEvent !== undefined) {
      let value = options.rawEvent;
      if (typeof value === 'string') value = JSON.parse(value);
      if (Array.isArray(value) && value.length === 1) value = value[0];
      const { validateHostEvent } = await import('./validate.ts');
      const check = validateHostEvent(machine.awaitOf(loaded.folder.state) ?? 'done', value, machine.validate ? (input) => machine.validate!(loaded.folder.state, input) : undefined);
      if (!check.ok || loaded.folder.queue.length) throw new EngineFault(`rebind-event-invalid: ${check.ok ? 'pending effects require recovery first' : check.error}`);
    }
    const { type, ...data } = event;
    const line: JournalLine = { seq: read.count + 1, v: 1, at: new Date(ports.clock.now()).toISOString(), type, data };
    const ref = publishCheckpoint(ports, runDir, machine, loaded.folder, line, read.prefixHash!, read, loaded.timeline, sessionRoot);
    if (!ref) throw new EngineFault('rebind-unsupported: machine codec required');
    line.checkpoint = ref;
    if (read.tornTail) ports.fs.truncate(journalPath(runDir), read.goodBytes);
    appendBoundary = { bytes: read.goodBytes, seq: line.seq, hash: ref.sha256 };
    ports.fs.appendDurable(journalPath(runDir), `${JSON.stringify(line)}\n`);
    const effect = loaded.folder.queue.find((item) => loaded.folder.open.has(item.id));
    const frame = effect ? recoveryFrame(machine, loaded.folder.state, runRel, effect, loaded.folder.attempts.get(effect.id)!, 'Rebind retains the unresolved attempt; send probes completion before retry', runDir) : projectFrame(machine, loaded.folder.state, runRel, undefined, line.seq);
    return { frame: { ...frame, data: { ...frame.data, rebind: data, ...(options.rawEvent !== undefined ? { eventValidated: true, guidance: 'Send the validated event to advance; rebind launched no effects' } : {}) } }, exitCode: 0 };
  } catch (error) {
    if (appendBoundary) {
      const committed = readJournal(ports, runDir);
      if (committed.checkpoint?.line.seq !== appendBoundary.seq || committed.checkpoint.line.checkpoint?.sha256 !== appendBoundary.hash) ports.fs.truncate(journalPath(runDir), appendBoundary.bytes);
    }
    return { frame: faultFrame(runRel, error instanceof Error ? error.message : String(error)), exitCode: 2 };
  }
  finally { if (locked) releaseLock(ports, runDir); }
}

export function validateQueue(queue: unknown, attempts: unknown, open: unknown): { queue: Effect[]; attempts: Map<string, number>; open: Set<string> } {
  if (!Array.isArray(queue) || !queue.every(effectDescriptor)) fail('effect descriptors');
  const effects = queue as Effect[], ids = new Set(effects.map((effect) => effect.id));
  if (ids.size !== effects.length) fail('duplicate effect identity');
  if (!Array.isArray(attempts) || !attempts.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && ids.has(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1] > 0)) fail('attempts');
  const attemptMap = new Map(attempts as [string, number][]);
  if (attemptMap.size !== attempts.length) fail('duplicate attempt');
  if (!Array.isArray(open) || !open.every((id) => typeof id === 'string' && ids.has(id) && attemptMap.has(id)) || new Set(open).size !== open.length) fail('open membership');
  return { queue: effects, attempts: attemptMap, open: new Set(open as string[]) };
}

export function publishCheckpoint<S>(ports: Ports, runDir: string, machine: Machine<S>, folder: Folder<S>, line: JournalLine, priorHash: string, read: JournalRead, timeline: TimelineFacts, sessionRoot?: string): CheckpointReference | undefined {
  const codec = machine.codec;
  if (!codec) return undefined;
  const portable = <T>(value: T): T => sessionRoot ? storeSessionPaths(value, sessionRoot) : value;
  const state = codec.encode(folder.state);
  codec.decode(state);
  validateQueue(folder.queue, [...folder.attempts], [...folder.open]);
  const checkpoint: Checkpoint = {
    schema: CHECKPOINT_SCHEMA, codec: { name: codec.name, version: codec.version }, runtime: codec.runtime(),
    binding: { run: path.basename(runDir), repo: portable(read.started?.data['repo'] ?? {}) },
    prefix: { seq: line.seq, priorHash, payloadHash: sha256(JSON.stringify(line)) },
    state: portable(state), queue: portable(encodePrivate(folder.queue)), attempts: [...folder.attempts], open: [...folder.open],
    execution: portable(read.execution ?? null), timeline,
  };
  const text = `${JSON.stringify(checkpoint)}\n`, digest = sha256(text), relative = `checkpoints/${digest}.json`, file = artifactPath(ports, runDir, relative);
  if (!ports.fs.publishExclusive(file, text) && ports.fs.readText(file) !== text) fail('immutable publication collision');
  return { path: relative, sha256: digest, bytes: Buffer.byteLength(text), schema: CHECKPOINT_SCHEMA, seq: line.seq };
}

/** Verify the reference and its non-circular commit payload before restoring private state. */
export function loadCheckpoint<S>(ports: Ports, runDir: string, machine: Machine<S>, read: JournalRead, sessionRoot?: string, mutation = false, migrateReview = false): { checkpoint: Checkpoint; state: S; queue: Effect[]; attempts: Map<string, number>; open: Set<string> } | null {
  const committed = read.checkpoint;
  if (!committed) return null;
  const ref = committed.line.checkpoint!;
  if (!/^checkpoints\/[a-f0-9]{64}\.json$/.test(ref.path) || ref.schema !== CHECKPOINT_SCHEMA || ref.seq !== committed.line.seq || ref.path !== `checkpoints/${ref.sha256}.json`) fail('reference');
  const file = path.join(runDir, ref.path), info = ports.fs.inspectPath(file);
  if (!info || info.kind !== 'file' || !info.realPath || path.resolve(info.realPath) !== path.resolve(file)) fail('missing or redirected blob');
  const text = ports.fs.readText(file);
  if (Buffer.byteLength(text) !== ref.bytes || sha256(text) !== ref.sha256) fail('blob digest or length');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('blob JSON'); }
  if (!record(parsed) || parsed['schema'] !== CHECKPOINT_SCHEMA || !record(parsed['codec']) || !record(parsed['prefix']) || !record(parsed['binding']) || !record(parsed['timeline'])) fail('schema');
  const checkpoint = parsed as unknown as Checkpoint, codec = machine.codec;
  if (!codec || checkpoint.codec.name !== codec.name || checkpoint.codec.version !== codec.version) fail('unsupported machine-state schema');
  const { checkpoint: _ref, ...payload } = committed.line;
  if (checkpoint.prefix.seq !== committed.line.seq || checkpoint.prefix.priorHash !== committed.priorHash || checkpoint.prefix.payloadHash !== sha256(JSON.stringify(payload))) fail('journal prefix binding');
  if (checkpoint.binding.run !== path.basename(runDir) || JSON.stringify(checkpoint.binding.repo) !== JSON.stringify(sessionRoot ? storeSessionPaths(read.started?.data['repo'] ?? {}, sessionRoot) : read.started?.data['repo'] ?? {})) fail('run/repository binding');
  if (typeof checkpoint.runtime !== 'string' || !checkpoint.runtime) fail('runtime identity');
  if (mutation && checkpoint.runtime !== codec.runtime()) throw new EngineFault('runtime-mismatch: explicit compatible rebind required; retained checkpoint is unchanged');
  if (committed.line.type === 'RUNTIME_REBOUND') {
    const data = committed.line.data;
    if (!Number.isSafeInteger(data['epoch']) || Number(data['epoch']) < 1 || typeof data['oldRuntime'] !== 'string' || !data['oldRuntime'] || data['newRuntime'] !== checkpoint.runtime || typeof data['reason'] !== 'string' || !data['reason'].trim() || data['prefixHash'] !== committed.priorHash || !record(data['source']) || !Number.isSafeInteger(data['source']['seq']) || Number(data['source']['seq']) >= committed.line.seq) fail('continuation provenance');
    validateExecutionReferences(data['source'], ports, runDir);
    const source = JSON.parse(ports.fs.readText(artifactPath(ports, runDir, String(data['source']['path'])))) as Checkpoint;
    if (source.schema !== CHECKPOINT_SCHEMA || source.runtime !== data['oldRuntime'] || source.prefix.seq !== data['source']['seq'] || JSON.stringify(source.codec) !== JSON.stringify(checkpoint.codec) || JSON.stringify(source.binding) !== JSON.stringify(checkpoint.binding)) fail('continuation source binding');
    if (data['migration'] !== undefined && data['migration'] !== 'review-manifest-v1') fail('unsupported continuation migration');
    const expectedState = data['migration'] === 'review-manifest-v1' ? migrateExecutionReferences(source.state, ports, runDir, [...read.records].filter(line => line.seq <= source.prefix.seq)) : source.state;
    if (JSON.stringify(expectedState) !== JSON.stringify(checkpoint.state)) fail('continuation changed state');
    for (const key of ['queue', 'attempts', 'open', 'execution'] as const) if (JSON.stringify(source[key]) !== JSON.stringify(checkpoint[key])) fail(`continuation changed ${key}`);
  }
  if (!Array.isArray(checkpoint.timeline.steps) || !Number.isSafeInteger(checkpoint.timeline.orchestratorBytes) || checkpoint.timeline.orchestratorBytes < 0 || !checkpoint.timeline.steps.every((step, index, steps) => Number.isSafeInteger(step.seq) && step.seq > 0 && step.seq <= checkpoint.prefix.seq && (!index || step.seq > steps[index - 1]!.seq) && Array.isArray(step.phases) && (step.awaiting === null || typeof step.awaiting === 'string') && typeof step.user === 'boolean')) fail('diagnostic timeline');
  const restore = <T>(value: T): T => {
    if (typeof value === 'string') return (sessionRoot && value.includes('@session') ? restoreSessionPaths(value, sessionRoot).replaceAll('\\', '/') : value) as T;
    if (Array.isArray(value)) return value.map(restore) as T;
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)])) as T;
    return value;
  };
  const persisted = restore(checkpoint.state);
  const state = codec.decode(migrateReview ? migrateExecutionReferences(persisted, ports, runDir, [...read.records]) : persisted);
  validateRepositoryState(state, sessionRoot ? restoreSessionPaths(read.started?.data['repo'] ?? {}, sessionRoot) : read.started?.data['repo'] ?? {});
  const containers = validateQueue(decodePrivate(restore(checkpoint.queue)), checkpoint.attempts, checkpoint.open);
  if (checkpoint.execution !== null && (!record(checkpoint.execution) || !record(checkpoint.execution.config) || !Number.isSafeInteger(checkpoint.execution.revision) || checkpoint.execution.revision < 0)) fail('execution configuration');
  validateExecutionReferences(state, ports, runDir);
  validateExecutionReferences(containers.queue, ports, runDir);
  return { checkpoint, state, ...containers };
}
