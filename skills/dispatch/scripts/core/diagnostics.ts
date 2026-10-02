import path from 'node:path';
import crypto from 'node:crypto';
import { account, DIAGNOSTIC_LIMITS, elapsed, emptyCapture, invocation, observations, renderDiagnostics, type Capture, type Invocation, type Phase } from '../domain/diagnostics.ts';
import type { DiagnosticBinding, DiagnosticUsage, Frame, JournalLine, Ports } from './types.ts';

const sessionOf = (runDir: string) => runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
const fileOf = (runDir: string) => path.join(runDir, 'diagnostics', 'capture.json');
const PENDING_SLOTS = 16, PENDING_BYTES = 1024;
const CAPTURE_BYTES = DIAGNOSTIC_LIMITS.runBytes - PENDING_SLOTS * PENDING_BYTES;
const pendingFile = (runDir: string, slot: number) => path.join(runDir, 'diagnostics', `pending-${slot}.json`);
export const diagnosticId = (value: string): string => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
export function invocationObserver(ports: Ports, binding: DiagnosticBinding, provider: string, configuredModel: string | null, mode: string, warn = diagnosticWarning(ports)): (event: { attempt: number; start: number; durationMs: number | null; launched: boolean; outcome: string; usage?: DiagnosticUsage }) => void {
  return (event) => publishInvocation(ports, binding.runDir, { id: diagnosticId(`${binding.producer}:${event.attempt}`), producer: diagnosticId(binding.producer ?? ''), sequence: event.attempt, phase: binding.phase, surface: 'cli', provider, configuredModel, mode, ...event }, warn);
}
export function diagnosticWarning(ports: Ports): () => void {
  let warned = false;
  return () => { if (!warned) { warned = true; ports.proc.stderr('[dispatch] diagnostics collection incomplete; workflow continues\n'); } };
}
function readCapture(ports: Ports, runDir: string): Capture {
  const file = fileOf(runDir);
  if (!ports.fs.exists(file)) return emptyCapture(ports.clock.now());
  if (ports.fs.size(file) > DIAGNOSTIC_LIMITS.runBytes) throw new Error('diagnostic capture limit');
  const value = JSON.parse(ports.fs.readText(file)) as Capture;
  if (value.v !== 1 || !Array.isArray(value.phases) || !Array.isArray(value.invocations) || !value.totals || !value.watermarks || !Array.isArray(value.intervals)) throw new Error('invalid diagnostic capture');
  const nonnegative = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const outcomes = ['partial', 'complete', 'failed', 'stopped', 'fault', 'skipped', 'no-reviewable-changes', 'lint-defects'];
  if (!outcomes.includes(value.outcome) || !nonnegative(value.refresh) || Object.values(value.totals).some((n) => !nonnegative(n)) || value.phases.length > DIAGNOSTIC_LIMITS.phases || value.invocations.length > DIAGNOSTIC_LIMITS.details) throw new Error('invalid diagnostic counters');
  for (const phase of value.phases) if (!['plan', 'plan review', 'implementation', 'code review', 'design', 'design review', 'integration review', 'ask'].includes(phase.name) || !outcomes.includes(phase.outcome) || !/^[a-z][a-z0-9_./:-]{0,95}$/.test(phase.id) || !nonnegative(phase.start) || !nonnegative(phase.approvalMs) || phase.end !== undefined && !nonnegative(phase.end)) throw new Error('invalid diagnostic phase');
  for (const interval of value.intervals) if (typeof interval.enabled !== 'boolean' || !nonnegative(interval.seq) || !nonnegative(interval.at)) throw new Error('invalid diagnostic interval');
  for (const [provider, counters] of Object.entries(value.byProvider ?? {})) if (!['claude', 'codex', 'opencode', 'copilot', 'agy', 'unavailable'].includes(provider) || !['includes-cache', 'uncached', 'unavailable'].includes(counters.semantics) || ![counters.input, counters.output, counters.covered, counters.observed].every(nonnegative)) throw new Error('invalid diagnostic provider');
  if (value.identity && (!/^[a-f0-9]{64}$/.test(value.identity.integrity) || !['win32', 'darwin', 'linux'].includes(value.identity.osFamily) || !['claude', 'codex', 'opencode', 'copilot', 'agy'].includes(value.identity.host))) throw new Error('invalid diagnostic identity');
  if (value.instructionBytes !== undefined && !nonnegative(value.instructionBytes)) throw new Error('invalid diagnostic overhead');
  value.invocations = value.invocations.map(invocation);
  if (value.longest) value.longest = invocation(value.longest);
  if (value.largest) value.largest = invocation(value.largest);
  return value;
}
/** Separate bounded lock; diagnostic contention never waits on operational work. */
function lock(ports: Ports, file: string): boolean {
  const content = JSON.stringify({ pid: ports.proc.pid, host: ports.proc.host, at: ports.clock.now() });
  try { ports.fs.writeExclusive(file, content); return true; } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    const owner = JSON.parse(ports.fs.readText(file)) as { pid: number; host: string };
    if (owner.host !== ports.proc.host || !Number.isSafeInteger(owner.pid) || ports.proc.isAlive(owner.pid)) return false;
    ports.fs.remove(file);
    try { ports.fs.writeExclusive(file, content); return true; } catch (retry) { if ((retry as { code?: string }).code === 'EEXIST') return false; throw retry; }
  }
}
function mutate(ports: Ports, runDir: string, update: (capture: Capture) => void, warn: () => void): void {
  const dir = path.dirname(fileOf(runDir)), lockFile = path.join(dir, 'capture.lock');
  let held = false;
  try {
    ports.fs.mkdir(dir, { recursive: true });
    held = lock(ports, lockFile);
    if (!held) { warn(); return; }
    const capture = readCapture(ports, runDir);
    const processed: string[] = [];
    for (let slot = 0; slot < PENDING_SLOTS; slot++) {
      const file = pendingFile(runDir, slot);
      if (!ports.fs.exists(file)) continue;
      try {
        if (ports.fs.size(file) > PENDING_BYTES) throw new Error('diagnostic record limit');
        const item = invocation(JSON.parse(ports.fs.readText(file)) as Invocation);
        const accepted = account(capture, item), watermark = capture.watermarks[item.producer];
        if (accepted || watermark && (item.sequence <= watermark.contiguous || watermark.sparse.includes(item.sequence))) processed.push(file);
        else warn();
      } catch { warn(); }
    }
    update(capture);
    let text = JSON.stringify(capture);
    while (Buffer.byteLength(text) > CAPTURE_BYTES && capture.invocations.length) { capture.invocations.pop(); capture.totals.omitted++; text = JSON.stringify(capture); }
    while (Buffer.byteLength(text) > CAPTURE_BYTES && capture.phases.some((phase) => phase.observations?.length)) {
      const phase = capture.phases.findLast((phase) => phase.observations?.length)!;
      phase.observations!.pop();
      if (!phase.observations!.length) delete phase.observations;
      capture.notices++; text = JSON.stringify(capture);
    }
    if (Buffer.byteLength(text) > CAPTURE_BYTES) { warn(); return; }
    ports.fs.writeAtomic(fileOf(runDir), text);
    for (const file of processed) ports.fs.remove(file);
  } catch { warn(); } finally { if (held) { try { ports.fs.remove(lockFile); } catch { warn(); } } }
}
export function publishInvocation(ports: Ports, runDir: string, value: Invocation, warn = diagnosticWarning(ports)): void {
  try {
    const item = invocation(value);
    let text = JSON.stringify(item);
    if (Buffer.byteLength(text) > PENDING_BYTES && item.usage) { delete item.usage.actualModels; text = JSON.stringify(item); }
    if (Buffer.byteLength(text) > PENDING_BYTES) { warn(); return; }
    ports.fs.mkdir(path.dirname(fileOf(runDir)), { recursive: true });
    let published = false;
    for (let slot = 0; slot < PENDING_SLOTS; slot++) {
      const file = pendingFile(runDir, slot);
      if (ports.fs.publishExclusive(file, text)) { published = true; break; }
      try { if ((JSON.parse(ports.fs.readText(file)) as Invocation).id === item.id) { published = true; break; } } catch { /* A corrupt diagnostic slot stays bounded and unavailable. */ }
    }
    if (!published) { warn(); return; }
    mutate(ports, runDir, () => {}, warn);
  } catch { warn(); }
}
export function resolveDiagnosticToggle(ports: Ports, runDir: string, fallback: boolean, source: (() => boolean) | undefined, warn: () => void): boolean {
  try { return source ? source() : fallback; } catch {
    warn();
    try { return ports.fs.exists(fileOf(runDir)) ? readCapture(ports, runDir).enabled : fallback; } catch { return fallback; }
  }
}
export type TimelineEntry = { seq: number; at: number; phases: Phase[]; awaiting: string | null; outcome?: string };
export function publishBoundary(ports: Ports, runDir: string, enabled: boolean, lines: readonly JournalLine[], timeline: readonly TimelineEntry[], sidecars: readonly { seq: number; phase: string; value?: unknown }[], excerpts: readonly string[], warn: () => void, identity?: Capture['identity'], instructionBytes = 0, binding = { seq: lines.length, at: ports.clock.now() }): void {
  try { if (!enabled && !ports.fs.exists(fileOf(runDir))) return; } catch { warn(); return; }
  mutate(ports, runDir, (capture) => {
    const now = ports.clock.now();
    if (capture.enabled !== enabled || !capture.intervals.length) {
      if (capture.intervals.length < DIAGNOSTIC_LIMITS.phases) capture.intervals.push({ ...binding, enabled }); else capture.notices++;
    }
    capture.enabled = enabled;
    if (!enabled) return;
    capture.refresh = now;
    if (identity && /^[a-f0-9]{64}$/.test(identity.integrity) && ['win32', 'darwin', 'linux'].includes(identity.osFamily) && ['claude', 'codex', 'opencode', 'copilot', 'agy'].includes(identity.host)) capture.identity = { integrity: identity.integrity, osFamily: identity.osFamily, host: identity.host };
    capture.instructionBytes = (capture.instructionBytes ?? 0) + instructionBytes;
    capture.executionRevisions = lines.filter((line) => line.type === 'EXECUTION_CONFIG_UPDATED').map((line) => Number(line.data['revision'])).filter((v) => Number.isSafeInteger(v) && v > 0).slice(-DIAGNOSTIC_LIMITS.phases);
    const active = new Map<string, Capture['phases'][number]>();
    const phases: Capture['phases'] = [];
    let prior: TimelineEntry | undefined;
    for (const entry of timeline) {
      for (const [key, phase] of active) {
        if (!entry.phases.some((p) => p.key === key)) {
          phase.end ??= entry.at;
          if (phase.outcome === 'partial') phase.outcome = 'complete';
          active.delete(key);
        }
      }
      for (const current of entry.phases) {
        let phase = active.get(current.key);
        if (!phase) {
          if (phases.length >= DIAGNOSTIC_LIMITS.phases) { capture.notices++; continue; }
          const old = capture.phases.find((p) => p.id === `${current.key}:${entry.seq}`);
          phase = { id: `${current.key}:${entry.seq}`, name: current.name, start: entry.at, outcome: 'partial', approvalMs: 0, ...(old?.observations !== undefined ? { observations: old.observations } : {}), ...(old?.rejected !== undefined ? { rejected: old.rejected } : {}) };
          active.set(current.key, phase); phases.push(phase);
        }
        if (current.outcome && phase.end === undefined) { phase.outcome = current.outcome; phase.end = entry.at; }
        if (prior?.awaiting === 'approval') phase.approvalMs += elapsed(prior.at, entry.at) ?? 0;
      }
      prior = entry;
    }
    for (const sidecar of sidecars) {
      const ending = timeline.find((v) => v.seq === sidecar.seq - 1);
      const key = sidecar.phase || ending?.phases.at(-1)?.key;
      const phase = phases.findLast((p) => p.id.startsWith(`${key}:`) && p.start <= (timeline.find((v) => v.seq === sidecar.seq)?.at ?? now));
      if (!phase) continue;
      const parsed = observations(sidecar.value, excerpts);
      if (parsed.values !== undefined) phase.observations = parsed.values;
      phase.rejected = (phase.rejected ?? 0) + parsed.rejected;
      if (parsed.malformed) { capture.notices++; warn(); }
    }
    if (timeline.at(-1)?.awaiting === 'approval') for (const phase of active.values()) if (phase.end === undefined) phase.approvalMs += elapsed(timeline.at(-1)!.at, now) ?? 0;
    capture.phases = phases;
    const start = timeline[0]?.at;
    const last = timeline.at(-1);
    capture.outcome = last?.outcome ?? 'partial';
    capture.elapsedMs = start === undefined ? null : elapsed(start, last?.outcome ? last.at : now);
    capture.anomalies = timeline.filter((v, i) => i > 0 && elapsed(timeline[i - 1]!.at, v.at) === null).length;
  }, warn);
}
/** Called only after releasing the run lock, avoiding run/render lock inversion. */
export function publishReport(ports: Ports, runDir: string, enabled: boolean, warn: () => void, excerpts: readonly string[] = []): void {
  if (!enabled) return;
  const session = sessionOf(runDir), lockFile = path.join(session, '.state', 'diagnostics.render.lock');
  let held = false;
  try {
    ports.fs.mkdir(path.dirname(lockFile), { recursive: true });
    held = lock(ports, lockFile);
    if (!held) { warn(); return; }
    const runsDir = path.join(session, '.state/runs');
    const files = ports.fs.listFiles(runsDir).filter((file) => /(?:^|\/)diagnostics\/capture\.json$/.test(file));
    const runs = files.sort().map((file) => readCapture(ports, path.dirname(path.dirname(path.join(runsDir, file)))));
    ports.fs.writeAtomic(path.join(session, 'diagnostics.md'), renderDiagnostics(runs, ports.clock.now(), false, excerpts));
  } catch { warn(); } finally { if (held) { try { ports.fs.remove(lockFile); } catch { warn(); } } }
}
export function diagnosticFrame(frame: Frame, ports: Ports, runDir: string, enabled: boolean, instruction: string): Frame {
  if (!enabled) return frame;
  if (frame.await === 'done') {
    const report = path.join(sessionOf(runDir), 'diagnostics.md');
    let exists = false;
    try { exists = ports.fs.exists(report); } catch { /* A missing report cannot fault completion. */ }
    return { ...frame, data: { ...frame.data, diagnostics: exists ? { path: report.replaceAll('\\', '/'), coverage: 'partial; see report' } : { unavailable: true } } };
  }
  return { ...frame, data: { ...frame.data, diagnostics: { instruction, replyTransport: { v: 1, event: frame.events?.[0] ?? '<existing semantic event>', diagnostics: { observations: [] } } } } };
}
