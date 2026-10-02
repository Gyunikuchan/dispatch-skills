import crypto from 'node:crypto';
import type { DiagnosticUsage } from '../core/types.ts';

export const DIAGNOSTIC_LIMITS = { observations: 3, excerptBytes: 512, incidentBytes: 2048, runBytes: 65536, reportBytes: 131072, instructionBytes: 1024, producers: 64, sparse: 16, details: 48, phases: 48 } as const;
export type Phase = { key: string; name: 'plan' | 'plan review' | 'implementation' | 'code review' | 'design' | 'design review' | 'integration review' | 'ask'; outcome?: string };
export type Observation = { v: 1; id: string; sourceRole: 'host'; component: string; category: string; trigger: string; evidence: string; impact: string; proposedFix: string; confidence: string; workaround?: string };
export type Usage = DiagnosticUsage;
export type Invocation = { id: string; producer: string; sequence: number; phase: string; surface: 'cli' | 'native'; provider: string; configuredModel: string | null; mode: string; start: number; durationMs: number | null; outcome: string; launched: boolean; usage?: Usage };
export type PhaseTiming = { id: string; name: Phase['name']; start: number; end?: number; outcome: string; approvalMs: number; observations?: Observation[]; rejected?: number };
export type Capture = {
  v: 1; refresh: number; enabled: boolean; intervals: Array<{ seq: number; at: number; enabled: boolean }>;
  phases: PhaseTiming[]; elapsedMs: number | null; outcome: string; anomalies: number;
  invocations: Invocation[]; totals: { launched: number; prelaunch: number; covered: number; input: number; output: number; workMs: number; failures: number; omitted: number };
  longest?: Invocation; largest?: Invocation;
  nativeObserved?: number;
  byProvider?: Record<string, { input: number; output: number; covered: number; observed: number; semantics: string }>;
  byPhase?: Record<string, { input: number; output: number; covered: number; observed: number; workMs: number }>;
  executionRevisions?: number[];
  identity?: { integrity: string; osFamily: string; host: string };
  instructionBytes?: number;
  watermarks: Record<string, { contiguous: number; sparse: number[] }>; omittedProducers: number; notices: number;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Unknown free text is withheld rather than attempting to prove it contains no secret. */
export function shareableText(value: unknown, allowedExcerpts: readonly string[] = []): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > DIAGNOSTIC_LIMITS.excerptBytes) return 'evidence withheld';
  const normalize = (text: string) => text.replace(/(?<![\w])(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g, '<path>').replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '<identity>').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '<identity>').replace(/[`~<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const normalized = normalize(value);
  const error = /^(?:dispatch: )?(quota|timeout|model-not-found|not-found|auth|config|refusal|truncated|empty-output|invalid-event|execution-config-topology|unsupported-journal-protocol)(?::.*)?$/.exec(normalized.trim());
  if (error) return `dispatch error: ${error[1]}; detail withheld`;
  if (/^dispatch error: [a-z-]+; detail withheld$/.test(normalized)) return normalized;
  if (!allowedExcerpts.some((source) => source.includes(value) || normalize(source).includes(normalized))) return 'evidence withheld';
  return normalized;
}
const CATEGORIES = ['instruction ambiguity', 'terminology', 'routing/delegation', 'driver protocol', 'review convergence', 'recovery', 'artifact lifecycle', 'verification orchestration', 'handoff'];
const COMPONENTS = new Set(['core/frame.ts', 'core/interpreter.ts', 'core/diagnostics.ts', 'core/journal.ts', 'core/lock.ts', 'core/progress.ts', 'core/validate.ts', 'machines/root.ts', 'machines/ask.ts', 'machines/plan.ts', 'machines/review.ts', 'machines/implement.ts', 'machines/design.ts', 'machines/revision.ts', 'machines/design-revision.ts', 'machines/diagnostics.ts', 'machines/execution-config.ts', 'domain/diagnostics.ts', 'domain/execution-config.ts', 'effects/wave.ts', 'effects/prepare-review.ts', 'effects/write-brief.ts', 'effects/check-envelope.ts', 'effects/verify.ts', 'effects/handoff.ts', 'providers/runner.ts', 'providers/codex.ts', 'providers/claude.ts', 'providers/opencode.ts', 'providers/copilot.ts', 'providers/agy.ts', 'lib/cli.ts', 'lib/config.ts', 'lib/session.ts', 'lib/diagnostic-usage.ts', 'policy/roster.ts', 'policy/rounds.ts', 'policy/cascade.ts', 'references/diagnostics.md', 'references/review-rules.md', 'references/providers.md', 'references/glossary.md', ...['ask', 'design', 'plan', 'implement', 'review'].map((verb) => `references/verbs/${verb}.md`)]);
export function observations(value: unknown, excerpts: readonly string[] = []): { values?: Observation[]; rejected: number; malformed: boolean } {
  if (!record(value) || !Array.isArray(value['observations'])) return { rejected: 0, malformed: value !== undefined };
  const values: Observation[] = [];
  let rejected = 0;
  for (const item of value['observations'].slice(0, DIAGNOSTIC_LIMITS.observations)) {
    if (!record(item) || item['v'] !== 1 || typeof item['id'] !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(item['id']) || typeof item['component'] !== 'string' || !COMPONENTS.has(item['component']) || !CATEGORIES.includes(String(item['category'])) || !['trigger', 'evidence', 'impact', 'proposedFix', 'confidence'].every((key) => typeof item[key] === 'string') || bytes(item) > DIAGNOSTIC_LIMITS.incidentBytes) { rejected++; continue; }
    const id = /^d-[a-f0-9]{24}$/.test(item['id']) ? item['id'] : `d-${crypto.createHash('sha256').update(item['id']).digest('hex').slice(0, 24)}`;
    if (values.some((prior) => prior.id === id)) continue;
    values.push({ v: 1, id, sourceRole: 'host', component: item['component'], category: String(item['category']), trigger: shareableText(item['trigger'], excerpts), evidence: shareableText(item['evidence'], excerpts), impact: shareableText(item['impact'], excerpts), proposedFix: shareableText(item['proposedFix'], excerpts), confidence: shareableText(item['confidence'], excerpts), ...(item['workaround'] !== undefined ? { workaround: shareableText(item['workaround'], excerpts) } : {}) });
  }
  return { values, rejected: rejected + Math.max(0, value['observations'].length - DIAGNOSTIC_LIMITS.observations), malformed: false };
}
export function extractTransport(value: unknown): { event: unknown; sidecar?: unknown; error?: string } {
  if (record(value) && ('event' in value || 'v' in value)) {
    if (value['v'] !== 1 || !record(value['event'])) return { event: null, error: 'event: expected version 1 reply transport and semantic event' };
    return { event: value['event'], ...(value['diagnostics'] !== undefined ? { sidecar: value['diagnostics'] } : {}) };
  }
  return { event: value };
}
export function emptyCapture(now: number): Capture {
  return { v: 1, refresh: now, enabled: false, intervals: [], phases: [], elapsedMs: null, outcome: 'partial', anomalies: 0, invocations: [], totals: { launched: 0, prelaunch: 0, covered: 0, input: 0, output: 0, workMs: 0, failures: 0, omitted: 0 }, watermarks: {}, omittedProducers: 0, notices: 0 };
}

/** Project invocation metadata; raw requests, results, paths and provider session IDs never cross this seam. */
export function invocation(value: Invocation): Invocation {
  const alias = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,96}$/.test(v) && !/[\\]|:\/\/|^\/|^[A-Za-z]:/.test(v) ? v : null;
  const id = (v: string) => /^[a-f0-9]{16,64}$/.test(v) ? v : 'unavailable';
  const usage = normalizeUsage(value.usage);
  return { id: id(value.id), producer: id(value.producer), sequence: safeInteger(value.sequence) && value.sequence > 0 ? value.sequence : 1, phase: /^[a-z][a-z0-9_.:/-]{0,95}$/.test(value.phase) ? value.phase : 'unavailable', surface: value.surface === 'native' ? 'native' : 'cli', provider: ['claude', 'codex', 'opencode', 'copilot', 'agy'].includes(value.provider) ? value.provider : 'unavailable', configuredModel: alias(value.configuredModel), mode: ['cli', 'desktop', 'vscode', 'native'].includes(value.mode) ? value.mode : 'unavailable', start: safeInteger(value.start) ? value.start : 0, durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : null, outcome: /^[a-z-]{1,40}$/.test(value.outcome) ? value.outcome : 'unavailable', launched: value.launched === true, ...(usage ? { usage } : {}) };
}
export function normalizeUsage(value: unknown): Usage | undefined {
  if (!record(value) || !safeInteger(value['input']) || !safeInteger(value['output']) || !['invocation', 'turn-delta', 'session-cumulative'].includes(String(value['scope'])) || !['includes-cache', 'uncached'].includes(String(value['inputSemantics'])) || !['codex.turn.completed', 'claude.result.usage', 'claude.result.modelUsage'].includes(String(value['provenance']))) return undefined;
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning']) if (value[key] !== undefined && !safeInteger(value[key])) return undefined;
  const out: Usage = { input: value['input'], output: value['output'], scope: value['scope'] as Usage['scope'], inputSemantics: value['inputSemantics'] as Usage['inputSemantics'], provenance: String(value['provenance']) };
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning'] as const) if (safeInteger(value[key])) out[key] = value[key];
  if (Array.isArray(value['actualModels']) && value['actualModels'].length <= 8 && value['actualModels'].every((v) => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,96}$/.test(v))) out.actualModels = value['actualModels'] as string[];
  return out;
}
export function account(capture: Capture, raw: Invocation): boolean {
  const item = invocation(raw);
  let watermark = capture.watermarks[item.producer];
  if (!watermark) {
    if (Object.keys(capture.watermarks).length >= DIAGNOSTIC_LIMITS.producers) { capture.omittedProducers++; return false; }
    watermark = { contiguous: 0, sparse: [] }; capture.watermarks[item.producer] = watermark;
  }
  if (item.sequence <= watermark.contiguous || watermark.sparse.includes(item.sequence)) return false;
  if (item.sequence > watermark.contiguous + 1 && watermark.sparse.length >= DIAGNOSTIC_LIMITS.sparse) { capture.notices++; return false; }
  watermark.sparse.push(item.sequence);
  while (watermark.sparse.includes(watermark.contiguous + 1)) { watermark.contiguous++; watermark.sparse.splice(watermark.sparse.indexOf(watermark.contiguous), 1); }
  if (item.surface === 'native') capture.nativeObserved = (capture.nativeObserved ?? 0) + 1;
  else if (item.launched) capture.totals.launched++; else capture.totals.prelaunch++;
  if (!['ok', 'captured', 'unavailable'].includes(item.outcome)) capture.totals.failures++;
  if (item.durationMs !== null) capture.totals.workMs += item.durationMs;
  if (item.usage) { capture.totals.covered++; capture.totals.input += item.usage.input; capture.totals.output += item.usage.output; }
  if (item.durationMs !== null && item.durationMs > (capture.longest?.durationMs ?? -1)) capture.longest = item;
  if (item.usage && item.usage.output > (capture.largest?.usage?.output ?? -1)) capture.largest = item;
  if (item.surface === 'cli' && item.launched) {
    capture.byProvider ??= {};
    const counts = capture.byProvider[item.provider] ?? { input: 0, output: 0, covered: 0, observed: 0, semantics: item.usage?.inputSemantics ?? 'unavailable' };
    counts.observed++;
    if (item.usage) { counts.covered++; counts.input += item.usage.input; counts.output += item.usage.output; counts.semantics = item.usage.inputSemantics; }
    capture.byProvider[item.provider] = counts;
    capture.byPhase ??= {};
    if (Object.keys(capture.byPhase).length < DIAGNOSTIC_LIMITS.phases || capture.byPhase[item.phase]) {
      const phase = capture.byPhase[item.phase] ?? { input: 0, output: 0, covered: 0, observed: 0, workMs: 0 };
      phase.observed++; phase.workMs += item.durationMs ?? 0;
      if (item.usage) { phase.covered++; phase.input += item.usage.input; phase.output += item.usage.output; }
      capture.byPhase[item.phase] = phase;
    }
  }
  if (capture.invocations.length < DIAGNOSTIC_LIMITS.details) capture.invocations.push(item); else capture.totals.omitted++;
  return true;
}
export function elapsed(start: number, end: number): number | null { return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null; }
export function unionDuration(intervals: readonly { start: number; end: number }[]): number {
  let total = 0, stop = -Infinity;
  for (const span of [...intervals].filter((v) => elapsed(v.start, v.end) !== null).sort((a, b) => a.start - b.start)) { total += Math.max(0, span.end - Math.max(stop, span.start)); stop = Math.max(stop, span.end); }
  return total;
}
export function renderDiagnostics(runs: readonly Capture[], now: number, compact = false, excerpts: readonly string[] = []): string {
  const lines = ['# Dispatch diagnostics v1', '', `Last refresh: ${now} ms since Unix epoch | capture: partial where marked`, 'Review this file before sharing. Evidence withheld unless matched to dispatch-owned excerpts.', 'Native/orchestrator tokens and diagnostic token overhead: unavailable. Extra diagnostic agent turns: 0.', 'Token figures are covered subtotals; cache/reasoning counters overlap differently by provider.', ''];
  runs.forEach((run, index) => {
    lines.push(`## Run ${String(index + 1).padStart(3, '0')}: ${run.outcome}`, '', `Dispatch integrity: ${run.identity?.integrity ?? 'unavailable'}; OS: ${run.identity?.osFamily ?? 'unavailable'}; host platform: ${run.identity?.host ?? 'unavailable'}.`, `Elapsed: ${run.elapsedMs ?? 'unavailable'} ms; invocation work: ${run.totals.workMs} ms (sum, not elapsed).`, `Observed tokens: input ${run.totals.covered ? run.totals.input : 'unavailable'}, output ${run.totals.covered ? run.totals.output : 'unavailable'}; ${run.totals.covered}/${run.totals.launched} CLI invocations covered; prelaunch failures ${run.totals.prelaunch}.`, `Failures: ${run.totals.failures}; omitted invocation detail: ${run.totals.omitted}; deferred producer publications: ${run.omittedProducers}; collection/detail notices: ${run.notices}; clock anomalies: ${run.anomalies}.`, `Emitted instruction bytes: ${run.instructionBytes ?? 'unavailable'}; attributable token overhead unavailable.`, `Enabled intervals: ${run.intervals.map((v) => `${v.seq}:${v.enabled ? 'on' : 'off'}`).join(', ') || 'unavailable'}.`, '');
    if (compact) { lines.push('Phase and incident detail omitted at session report limit.', ''); return; }
    lines.push(`Execution configuration revisions: ${run.executionRevisions?.join(', ') || 'none'}. Explicit start overrides take precedence.`, '', '| Phase | Outcome | Inclusive elapsed ms | Exclusive elapsed ms | Approval wait ms | Work ms | Observed input/output | Coverage | Other gaps |', '| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |');
    for (const phase of run.phases) {
      const end = phase.end ?? run.refresh;
      const inclusive = elapsed(phase.start, end);
      const key = phase.id.replace(/:\d+$/, '');
      const nested = run.phases.filter((p) => p.id.replace(/:\d+$/, '').startsWith(`${key}/`) && p.start >= phase.start && p.start < end).map((p) => ({ start: Math.max(phase.start, p.start), end: Math.min(end, p.end ?? run.refresh) }));
      const exclusive = inclusive === null ? null : Math.max(0, inclusive - unionDuration(nested));
      const counts = run.byPhase?.[phase.id];
      lines.push(`| ${phase.name} | ${phase.outcome} | ${inclusive ?? 'unavailable'} | ${exclusive ?? 'unavailable'} | ${phase.approvalMs} | ${counts?.workMs ?? 'unavailable'} | ${counts?.covered ? `${counts.input}/${counts.output}` : 'unavailable'} | ${counts ? `${counts.covered}/${counts.observed}` : 'unavailable'} | unclassified |`);
    }
    const longest = run.phases.map((p) => ({ ...p, duration: elapsed(p.start, p.end ?? run.refresh) })).filter((p) => p.duration !== null).sort((a, b) => Number(b.duration) - Number(a.duration))[0];
    const invocation = run.longest ?? [...run.invocations].sort((a, b) => Number(b.durationMs) - Number(a.durationMs))[0];
    lines.push('', `Longest observed phase: ${longest?.name ?? 'unavailable'}; longest measured invocation: ${invocation?.durationMs ?? 'unavailable'} ms.`, `Largest observed output token consumer: ${run.largest?.provider ?? 'unavailable'} (partial coverage).`, `Native captures observed: ${run.nativeObserved ?? 0}; usage unavailable.`, '');
    for (const [provider, counts] of Object.entries(run.byProvider ?? {})) lines.push(`${provider}: input ${counts.covered ? counts.input : 'unavailable'} (${counts.semantics}), output ${counts.covered ? counts.output : 'unavailable'}; ${counts.covered}/${counts.observed} covered.`);
    for (const item of run.invocations) lines.push(`Invocation ${item.id}: ${item.provider}/${item.mode}; configured alias ${item.configuredModel ?? 'unavailable'}, reported models ${item.usage?.actualModels?.join(', ') ?? 'unavailable'}; ${item.outcome}.`);
    for (const phase of run.phases) {
      lines.push(`### ${phase.name}: dispatch incidents`, phase.observations === undefined ? 'Observations unavailable.' : phase.observations.length ? '' : 'No dispatch friction reported.', `Scope rejections: ${phase.rejected ?? 0}.`);
      const safe = observations({ observations: phase.observations ?? [] }, ['evidence withheld', ...excerpts]).values ?? [];
      for (const incident of safe) lines.push('', `Incident: ${incident.id}; source: ${incident.sourceRole}`, `Owner: ${incident.component} | category: ${incident.category}`, '```text', `Trigger: ${incident.trigger}`, `Evidence: ${incident.evidence}`, `Impact: ${incident.impact}`, `Workaround: ${incident.workaround ?? 'unavailable'}`, `Proposed fix (unverified): ${incident.proposedFix}`, `Explanation confidence: ${incident.confidence}`, '```');
    }
  });
  const text = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes) return text;
  if (!compact) return renderDiagnostics(runs, now, true, excerpts);
  return `# Dispatch diagnostics v1\n\nSession limit reached; ${runs.length} prior run summaries withheld. Partial report; underlying run records retained.\n`;
}
