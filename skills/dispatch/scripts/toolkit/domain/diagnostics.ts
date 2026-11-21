import { formatCost, pricingProblems, sumCost, type Cost, type CostReason, type Pricer } from '../../lib/pricing.ts';
import { BANDS, boundModels, type Bands } from '../../lib/usage/bands.ts';
import { addCounters, HOST_ROLES, HOST_NOTES, HOST_UNAVAILABLE, splitUsageKey, STAGE_ORDER, tokenTotal, type Counters, type HostUsageFacts, type HostUsageRow } from '../../lib/usage/rows.ts';
import type { LifecycleStep } from '../../providers/types.ts';
import type { CoverageReason, FailureClass } from '../types.ts';
import type { ReviewKind } from './types.ts';

// Pure diagnostics retrospective: toolkit facts in, a severity-ordered, shareable Markdown report out.
// The caller supplies captured facts; this module applies heuristics without reading session state.

// SECTION: Types

const PHASE_NAMES = ['plan', 'plan review', 'implementation', 'code review', 'design', 'design review', 'integration review', 'ask'] as const;

/** The review machine's halt on a re-raised fix (regression) or a pending rejection re-raised twice (deadlock). */
type Escalation = { kind: 'regression' | 'deadlock'; ids: readonly string[] };

/** Review phases carry the review machine's convergence result (findings re-raised across rounds, any escalation) and the resolved round `cap`. */
export type Phase = { key: string; name: typeof PHASE_NAMES[number]; outcome?: string; reraised?: readonly string[]; escalation?: Escalation; cap?: number };

/** Key order is severity order. Hosts send the keys; the report renders the labels. */
export const CATEGORIES = {
  correctness: 'Correctness / protocol',
  'token-economy': 'Token economy',
  speed: 'Speed',
  'review-convergence': 'Review convergence',
  'instruction-clarity': 'Instruction clarity',
  'information-access': 'Information access',
} as const;
type Category = keyof typeof CATEGORIES;

type ModelUsage = Counters & { bands?: Bands };

/** `input` is canonical uncached input; `models` holds per-model counters, with `<model>#<effort>` keys when effort varies. */
export type Usage = ModelUsage & { models?: Record<string, ModelUsage>; reasoningInOutput?: boolean };

/** Tool-call durations can overlap; they do not measure session elapsed time. */
type PhaseFacts = { key: string; name: string; outcome?: string; wallMs?: number; driverMs?: number; hostMs?: number; userMs?: number };

/** One launch attempt (`phase` is a phase key; `outcome` is `ok` or a failure class). */
export type DiagnosticEvent = {
  subject: string; slot: string; provider?: string; model?: string; attempt: number; targetSlot?: string;
} & (
  {kind:'validation'; outcome:string; surface:'cli'|'native'} |
  {kind:'routing'; cls?:FailureClass; state:'next-model'|'next-mode'|'reserve'|'stop'} |
  {kind:'native'; state:'pending'|'completed'|'invalid'|'failed'; replay?: boolean} |
  {kind:'slot'; cls?:FailureClass; state:'done'|'native'|'failed'; replay?: boolean}
);
export type InvocationFacts = {
  phase: string; provider: string; model: string; effort?: string; mode?: string; surface: 'cli' | 'native';
  launched: boolean; durationMs?: number; startMs?: number; endMs?: number; outcome: string; usage?: Usage; reportedModels?: string[]; coverage?: CoverageReason[];
  slot?: string; lifecycleSteps?: LifecycleStep[]; nudge?: true;
  routingOutcome?: string; slotState?: 'done'|'native'|'failed'; validationOutcome?: string; nativeState?: 'pending'|'completed'|'invalid'|'failed'; subject?: string; attempt?: number; targetSlot?: string;
};

/**
 * `reraised` and `escalation` sit on a review's last round; they are the driver's own convergence result, never a re-derivation.
 * `cap` is the phase's resolved round cap on every round; absent, H2 falls back to `DIAGNOSTIC_THRESHOLDS.reviewRounds`.
 */
export type ReviewFacts = { phase?: string; round: number; accepted: number; rejected: number; reraised?: readonly string[]; escalation?: Escalation; cap?: number };

/** `calls` is absent when the round has no start; `hostTokens` is absent when host usage is unavailable. */
export type RoundWorkload = { review: string; round: number; calls?: {total: number; phases: {key: string; count: number}[]}; hostTokens?: number; hostTurns?: number; kind?: ReviewKind };

type SlotYieldAttempt = { provider: string; model: string; effort: string | null; usage?: Usage };

/** Per-responder review yield: findings raised and ruled, plus the slot's measured token cost. */
export type SlotYieldFacts = {
  kind: 'provider' | 'native' | 'tool'; provider: string; model: string | null;
  raised: { MUST: number; SHOULD: number; CONSIDER: number };
  accepted: number; rejected: number; deferred: number; duplicate: number; unruled: number;
  tokens?: number; measured: number; launched: number;
  attempts?: SlotYieldAttempt[];
  /** Findings whose origin is `fix-induced`; present only when nonzero. */
  fixInduced?: number;
};
/** Adds one responder's yield to another's; absent tokens stay absent. */
export function addYield(current: SlotYieldFacts, row: SlotYieldFacts): void {
  for (const severity of ['MUST', 'SHOULD', 'CONSIDER'] as const) current.raised[severity] += row.raised[severity];
  for (const key of ['accepted', 'rejected', 'deferred', 'duplicate', 'unruled', 'measured', 'launched'] as const) current[key] += row[key];
  if (row.tokens !== undefined) current.tokens = (current.tokens ?? 0) + row.tokens;
  if (row.attempts?.length) current.attempts = [...(current.attempts ?? []), ...row.attempts];
  if (row.fixInduced) current.fixInduced = (current.fixInduced ?? 0) + row.fixInduced;
}
export type RunFacts = {
  hostUsage?: HostUsageFacts;
  startedAt?: string;
  hosts?: string[];
  timingScope?: 'tool-calls';
  capture?: {state:'opened'|'completed'; start:number; end?:number; storageFailed?:number};
  retroState?: 'missing'|'unreadable'|'malformed'|'invalid'|'empty'|'collected';
  collection?: {completed?:number; partial?:number; corrupt?:number; unreadable?:number; incomplete?:number; storageFailed?:number};
  provenance?: {version?:string; build?:string; config?:Record<string,unknown>}[];
  rejectedTools?: {tool:string; action:string; cls:string}[];
  relaunches?: number;
  version?: string; build?: string; os?: string; host?: string; verb?: string; level?: string; pins?: string;
  config?: Record<string, unknown>; outcome?: string;
  /** `hostWaitMs` is the wait before the failed send; `waitBy` says whether a person or the host held it. */
  fault?: { effectId?: string; cls: string; hostWaitMs?: number; waitBy?: 'user' | 'host'; driverMs?: number };
  phases: PhaseFacts[];
  invocations: InvocationFacts[];
  reviews: ReviewFacts[];
  slotYield?: SlotYieldFacts[];
  roundTiming?: {review:string; round:number; slots:{slot:string; attempts:{startMs?:number; endMs?:number}[]}[]}[];
  roundWorkload?: RoundWorkload[];
  /** Raw `RETRO` items; gated by `retroObservations` at render time. */
  observations?: unknown;
};

type RetroObservation = { id: string; component: string; category: Category; evidence: string; impact: string; proposedFix: string };

/** `source` is a heuristic id (`H1`…) or `retro`. */
export type Finding = { source: string; run?: number; id?: string; category: Category; component: string; evidence: string; impact: string; proposedFix: string };

// Share heuristics need `minSamples`, so one or two data points never read as a pattern.
const DIAGNOSTIC_THRESHOLDS = { reviewRounds: 3, maxRoundCap: 1000, minSamples: 3, rejectedShare: 0.5, cacheReadShare: 0.5, invocationShare: 0.5 } as const;
// NOTE: 1600 leaves room for the grounding Overview rule in references/diagnostics.md.
export const DIAGNOSTIC_LIMITS = { observations: 20, fieldBytes: 512, reportBytes: 131_072, instructionBytes: 1600 } as const;

const files = (dir: string, names: string, ext: string) => names.split(' ').map((name) => `${dir}/${name}${ext}`);

/** Dispatch-owned files a finding may name, relative to the skill root; mirrors the shipped tree. */
export const COMPONENTS: ReadonlySet<string> = new Set([
  'SKILL.md',
  'references/pricing.json',
  ...files('references/readme', 'ask concepts configuration design implement plan review troubleshooting verify', '.md'),
  ...files('references/templates', 'context-map design explorer-brief fix-check-brief increment-orchestrator-brief plan plan-field-notes quality-bar review-prompt review-prompt-code review-prompt-design review-prompt-plan review-severity spec test-cleanup-brief verifier-brief walkthrough writer-brief', '.md'),
  ...files('references/verbs', 'ask design implement plan review verify', '.md'),
  ...files('references', 'artifact-readability decision-frame diagnostics glossary grounding providers review-coverage review-fixes review-rules self-build spec-authoring spec-stage toolkit worktree-cleanup', '.md'),
  ...files('scripts/lib', 'canonical-markdown cli config fs-ext integrity node-fs-ext opencode-db platform pricing quota-store session', '.ts'),
  ...files('scripts/lib/usage', 'agy bands claude codex delegate index opencode read rows', '.ts'),
  ...files('scripts/policy', 'cascade quota roster', '.ts'),
  ...files('scripts/providers', 'agy claude codex copilot discovery index node-process opencode opencode-runtime runner types', '.ts'),
  ...files('scripts/toolkit/domain', 'context criterion-id design diagnostics fix-check plan prompt report sanitize severity spec stable-value types', '.ts'),
  ...files('scripts/toolkit', 'artifacts ask brief check cli confirmations contracts coverage deliver diagnostics doctor evidence fanout fanout/state fanout/voice fanout/native fanout/wave findings fix-check git hints input integrate integration ledger lint lock output plan-view prompts records red report review review-checkout review-findings review-identity status types walkthrough writers', '.ts'),
  ...files('scripts', 'dispatch', '.ts'),
  'scripts/package.json',
]);

// SECTION: Field gates

const DASH = '—';
const VERBS = ['ask', 'design', 'plan', 'review', 'implement'];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CONFIG_KEYS = ['diagnostics', 'write-concurrency', 'read-delegates', 'write-subagents', 'utility-subagents', 'phases', 'read-commands', 'pricing'];
const ID = /^[A-Za-z0-9_-]{1,48}$/;
// Host text may name dispatch files and slash commands, never machine, network, or identity locators.
const PROHIBITED: readonly RegExp[] = [
  /(?:^|[\s"'`(<[=,;])(?:~|\/[^\s/"'`]+)\/[^\s/"'`]/, // POSIX absolute or home path
  /\b[A-Za-z]:[\\/]|\\\\[^\s\\]+\\/, // drive letter or UNC share
  /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|ai|app|cloud|internal|corp)\b/i, // URL host
  /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/, // email
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32,}\b/i, // UUID-like or long hex id
];

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const locatorFree = (v: string): boolean => !PROHIBITED.some((re) => re.test(v));
// Read-command prefixes are space-separated words; slashes are excluded so no path survives.
const commandText = (v: unknown): string => typeof v === 'string' && v.length <= 80 && /^[A-Za-z0-9._:=@+-]+(?: [A-Za-z0-9._:=@+-]+)*$/.test(v) && locatorFree(v) ? v : DASH;
// Every rendered identifier and alias passes the locator gate too: a well-formed id can still be a UUID or a host name.
const match = (re: RegExp) => (v: unknown): string | undefined => typeof v === 'string' && re.test(v) && locatorFree(v) ? v : undefined;
const token = match(/^[a-z][a-z0-9-]{0,39}$/);
const phaseKey = match(/^[a-z0-9][a-z0-9/._-]{0,127}$/);
const modelAlias = match(/^[A-Za-z0-9][A-Za-z0-9_.:/@\[\]-]{0,95}$/);
const modelName = (v: unknown): string | undefined => { const name = modelAlias(v); return name && !/^[A-Za-z]:|\/\//.test(name) ? name : undefined; };
function isoDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : undefined;
}
const count = (v: unknown): number | undefined => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : undefined;
const millis = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
const opt = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** One-line host or validator text, or undefined when empty, oversized, or carrying a prohibited locator. */

function safeText(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > DIAGNOSTIC_LIMITS.fieldBytes || !locatorFree(v)) return undefined;
  return v.replace(/\s+/g, ' ').trim();
}

function componentOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const relative = v.replace(/^skills\/dispatch\//, '');
  return COMPONENTS.has(relative) ? relative : undefined;
}

function categoryOf(v: unknown): Category | undefined {
  return Object.entries(CATEGORIES).find(([key, label]) => v === key || v === label)?.[0] as Category | undefined;
}

// SECTION: Usage

function baseCounters(v: unknown): Counters | undefined {
  if (!record(v)) return undefined;
  const input = count(v['input']), output = count(v['output']);
  if (input === undefined || output === undefined) return undefined;
  const out: Counters = { input, output };
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning'] as const) {
    if (v[key] === undefined) continue;
    const n = count(v[key]);
    if (n === undefined) return undefined;
    out[key] = n;
  }
  const has5m = v['cacheWrite5m'] !== undefined, has1h = v['cacheWrite1h'] !== undefined;
  if (has5m || has1h) {
    const n5m = has5m ? count(v['cacheWrite5m']) : 0;
    const n1h = has1h ? count(v['cacheWrite1h']) : 0;
    if (n5m !== undefined && n1h !== undefined && n5m + n1h <= (out.cacheWrite ?? 0)) {
      if (has5m) out.cacheWrite5m = n5m;
      if (has1h) out.cacheWrite1h = n1h;
    }
  }
  return out;
}

function bandsOf(v: unknown, expected: Counters): Bands | undefined {
  if (!record(v)) return undefined;
  const entries = Object.entries(v);
  if (!entries.length) return undefined;
  const out: Bands = {};
  const summed: Counters = { input: 0, output: 0 };
  for (const [key, raw] of entries) {
    if (!(BANDS as readonly string[]).includes(key)) return undefined;
    const c = baseCounters(raw);
    if (!c) return undefined;
    out[key as keyof Bands] = c;
    addCounters(summed, c);
  }
  if (summed.input !== expected.input || summed.output !== expected.output) return undefined;
  if ((['cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning'] as const).some((k) => summed[k] !== expected[k])) return undefined;
  return out;
}

function counters(v: unknown): ModelUsage | undefined {
  const out = baseCounters(v);
  if (!out || !record(v)) return undefined;
  const bands = v['bands'] !== undefined ? bandsOf(v['bands'], out) : undefined;
  return bands ? { ...out, bands } : out;
}

function mergeModelUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  const merged: ModelUsage = addCounters({ ...a }, b);
  if (a.bands && b.bands) {
    const bands: Bands = { ...a.bands };
    for (const [band, bv] of Object.entries(b.bands) as [keyof Bands, Counters][]) {
      bands[band] = bands[band] ? addCounters({ ...bands[band]! }, bv) : { ...bv };
    }
    merged.bands = bands;
  } else {
    delete merged.bands;
  }
  return merged;
}

function usageOf(v: unknown, subtractCache: boolean): Usage | undefined {
  const base = counters(v);
  if (!base || !record(v)) return undefined;
  const canonicalCounters = (u: Counters): Counters => subtractCache ? { ...u, input: Math.max(0, u.input - (u.cacheRead ?? 0)) } : u;
  const canonical = (u: ModelUsage): ModelUsage => {
    const c = canonicalCounters(u);
    return u.bands ? { ...c, bands: Object.fromEntries(Object.entries(u.bands).map(([b, bv]) => [b, canonicalCounters(bv!)])) } : c;
  };
  const out: Usage = { ...canonical(base), ...(typeof v['reasoningInOutput'] === 'boolean' ? { reasoningInOutput: v['reasoningInOutput'] } : {}) };
  const models = record(v['models']) ? Object.entries(v['models']) : [];
  // A `<model>#<effort>` key keeps its own effort; an empty or gate-failing part renders `—` but keeps its counters.
  const parts = models.map(([key, part]) => {
    const split = splitUsageKey(key);
    const name = modelName(split.model), effort = split.effort === undefined ? undefined : token(split.effort) ?? '';
    return { key: effort === undefined ? name : `${name ?? ''}#${effort}`, part: counters(part), keyed: effort !== undefined };
  });
  if (parts.length && parts.every(({ key, part, keyed }) => part && (keyed || key))) {
    const grouped = new Map<string, ModelUsage>();
    for (const { key, part } of parts) {
      const current = grouped.get(key!);
      grouped.set(key!, current ? mergeModelUsage(current, canonical(part!)) : canonical(part!));
    }
    out.models = boundModels(Object.fromEntries(grouped));
  }
  return out;
}

/** Canonical counters: `input` excludes cache reads, so providers that count them inside input (Codex) compare equally. */

export function normalizeUsage(raw: unknown, inputSemantics: 'includes-cache' | 'uncached'): Usage | undefined {
  return usageOf(raw, inputSemantics === 'includes-cache');
}

const APART = new Set(['opencode', 'agy']);
const reasoningApart = (platform: string, reasoningInOutput: boolean | undefined): boolean => reasoningInOutput === undefined ? APART.has(platform) : !reasoningInOutput;
export const billedTokens = (u: Counters, platform: string, reasoningInOutput?: boolean): number => tokenTotal(u) + (reasoningApart(platform, reasoningInOutput) ? u.reasoning ?? 0 : 0);
const uncached = (u: ModelUsage) => u.input + (u.cacheWrite ?? 0) + u.output;
const measured = (i: InvocationFacts): Usage | undefined => i.surface !== 'cli' || !i.launched ? undefined : i.usage;
const sum = (values: readonly (number | undefined)[]): number | undefined => values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined;
type UsageSample = { usage: ModelUsage; platform: string; reasoningInOutput?: boolean | undefined };
type Totals = { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; all: number };

function totals(samples: readonly UsageSample[]): Totals | undefined {
  if (!samples.length) return undefined;
  const acc: ModelUsage = { input: 0, output: 0 };
  let all = 0;
  for (const s of samples) {
    addCounters(acc, s.usage);
    all += billedTokens(s.usage, s.platform, s.reasoningInOutput);
  }
  return { ...acc, all };
}

// SECTION: Gates

/** Gates host retro items: at most `DIAGNOSTIC_LIMITS.observations`, valid id, dispatch-owned component, known category, bounded locator-free text. */

export function retroObservations(value: unknown): { state: 'invalid'|'empty'|'collected'; values: RetroObservation[]; rejected: number } {
  if (!Array.isArray(value)) return {state:'invalid',values:[],rejected:0};
  const items = list(value);
  const values: RetroObservation[] = [];
  let rejected = Math.max(0, items.length - DIAGNOSTIC_LIMITS.observations);
  for (const item of items.slice(0, DIAGNOSTIC_LIMITS.observations)) {
    const row = record(item) ? item : {};
    const id = match(ID)(row['id']), component = componentOf(row['component']), category = categoryOf(row['category']);
    const evidence = safeText(row['evidence']), impact = safeText(row['impact']), proposedFix = safeText(row['proposedFix']);
    if (!id || values.some((v) => v.id === id) || !component || !category || !evidence || !impact || !proposedFix) { rejected++; continue; }
    values.push({ id, component, category, evidence, impact, proposedFix });
  }
  return { state:items.length?'collected':'empty', values, rejected };
}

/** Dotted ids and `provider/*` keys fail `configValue`'s key gate, so pricing keeps its own: model-like keys with valid entries, whose rates are numbers. */
function pricingValue(v: unknown): Record<string, unknown> {
  if (!record(v)) return {};
  const keyOk = (key: string) => modelName(key) !== undefined || (key.endsWith('/*') && token(key.slice(0, -2)) !== undefined);
  return Object.fromEntries(Object.entries(v).filter(([key, entry]) => keyOk(key) && !pricingProblems({ [key]: entry }).length).slice(0, 32).map(([key, entry]) => [key, structuredClone(entry)]));
}

function configValue(v: unknown, depth: number): unknown {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (typeof v === 'string') return modelName(v) ?? DASH;
  if (depth >= 6) return DASH;
  if (Array.isArray(v)) return v.slice(0, 16).map((item) => configValue(item, depth + 1));
  if (record(v)) return Object.fromEntries(Object.entries(v).filter(([key]) => /^[A-Za-z0-9_-]{1,40}$/.test(key) && locatorFree(key)).slice(0, 32).map(([key, item]) => [key, configValue(item, depth + 1)]));
  return DASH;
}

/** Exact-shape rows only; invalid rows are dropped rather than clamped into success, and each step appears once. */
function lifecycleOf(v: unknown): LifecycleStep[] | undefined {
  const rows: LifecycleStep[] = [];
  const ms = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= 2147483647;
  for (const r of list(v)) {
    if (!record(r) || Object.keys(r).length !== 4) continue;
    const step = (['debug-config', 'debug-agents', 'prepare', 'response', 'teardown'] as const).find((x) => x === r['step']);
    const outcome = (['ok', 'failed', 'timeout', 'unconfirmed'] as const).find((x) => x === r['outcome']);
    if (step && outcome && ms(r['elapsedMs']) && ms(r['budgetMs']) && !rows.some((x) => x.step === step)) rows.push({ step, elapsedMs: r['elapsedMs'], budgetMs: r['budgetMs'], outcome });
  }
  return rows.length ? rows : undefined;
}

const COVERAGE_REASONS: readonly CoverageReason[] = ['no usage', 'transcript unavailable'];
function coverageOf(v: unknown): CoverageReason[] | undefined {
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v : [];
  const reasons = [...new Set(raw.flatMap((x): CoverageReason[] => {
    const mapped = x === 'no usage output' ? 'no usage' : x;
    return (COVERAGE_REASONS as readonly string[]).includes(String(mapped)) ? [mapped as CoverageReason] : [];
  }))];
  return reasons.length ? reasons : undefined;
}

function invocationOf(v: unknown): InvocationFacts[] {
  if (!record(v)) return [];
  const reported = list(v['reportedModels']).map(modelName).filter((m): m is string => !!m).slice(0, 8);
  return [{
    phase: phaseKey(v['phase']) ?? '', provider: token(v['provider']) ?? DASH, model: modelName(v['model']) ?? DASH,
    ...opt('effort', v['effort'] === undefined ? undefined : token(v['effort']) ?? DASH), ...opt('mode', token(v['mode'])),
    surface: v['surface'] === 'native' ? 'native' : 'cli', launched: v['launched'] === true, ...opt('durationMs', millis(v['durationMs'])),
    ...opt('startMs', millis(v['startMs'])), ...opt('endMs', millis(v['endMs'])),
    ...opt('routingOutcome',(['next-model','next-mode','reserve','stop'] as const).find(x=>x===v['routingOutcome'])),
    ...opt('slotState',(['done','native','failed'] as const).find(x=>x===v['slotState'])),
    ...opt('validationOutcome',token(v['validationOutcome'])),
    ...opt('nativeState',(['pending','completed','invalid','failed'] as const).find(x=>x===v['nativeState'])),
    ...opt('subject',match(/^[a-f0-9]{16}$/)(v['subject'])), ...opt('attempt',count(v['attempt'])),
    ...opt('targetSlot',match(/^[A-Za-z0-9_-]{1,40}\[\d{1,3}\]$/)(v['targetSlot'])),
    outcome: token(v['outcome']) ?? DASH, ...opt('usage', usageOf(v['usage'], false)), ...opt('reportedModels', reported.length ? reported : undefined),
    ...opt('coverage', coverageOf(v['coverage'])),
    ...opt('lifecycleSteps', lifecycleOf(v['lifecycleSteps'])), ...opt('slot', match(/^[A-Za-z0-9_.-]{1,40}(?:\[\d{1,3}\])?$/)(v['slot'])),
    ...(v['nudge'] === true ? { nudge: true as const } : {}),
  }];
}

function hostUsageOf(value: unknown): HostUsageFacts | undefined {
  if (!record(value)) return undefined;
  const rows: HostUsageRow[] = list(value['rows']).flatMap(v => {
    if (!record(v)) return [];
    const stage=STAGE_ORDER.find(x=>x===v['stage']), role=HOST_ROLES.find(x=>x===v['role']), usage=counters(v);
    if(!stage || !role || !usage) return [];
    return [{stage,...opt('phase',phaseKey(v['phase'])),role,model:modelName(v['model']) ?? DASH,effort:token(v['effort']) ?? null,...usage,...(typeof v['reasoningInOutput']==='boolean'?{reasoningInOutput:v['reasoningInOutput']}:{}) }];
  });
  const notes: NonNullable<HostUsageFacts['notes']> = {};
  if(record(value['notes'])) for(const role of HOST_ROLES) {
    const raw=value['notes'][role]; if(!record(raw)) continue;
    const clean=Object.fromEntries(HOST_NOTES.flatMap(key=>{const n=count(raw[key]);return n===undefined?[]:[[key,n]];}));
    if(Object.keys(clean).length) notes[role]=clean;
  }
  const unavailable=HOST_UNAVAILABLE.find(x=>x===value['unavailable']);
  return {platform:token(value['platform']) ?? null,rows,...opt('unavailable',unavailable),...(Object.keys(notes).length?{notes}:{})};
}

/** Rebuilds facts from allowlisted fields only, so resume ids, session paths, and objectives never reach the report. */

export function sanitizeFacts(run: RunFacts): RunFacts {
  const r: Record<string, unknown> = record(run) ? run : {};
  // A dispatch content hash, exempt from the long-hex locator rule; only its 12-character prefix renders.
  const build = typeof r['build'] === 'string' && /^[a-f0-9]{12,64}$/.test(r['build']) ? r['build'] : undefined;
  const config = record(r['config']) ? Object.fromEntries(CONFIG_KEYS.filter((key) => (r['config'] as Record<string, unknown>)[key] !== undefined).map((key) => { const v = (r['config'] as Record<string, unknown>)[key]; return [key, key === 'read-commands' && Array.isArray(v) ? v.slice(0, 16).map(commandText) : key === 'pricing' ? pricingValue(v) : configValue(v, 0)]; })) : undefined;
  const fault = record(r['fault']) ? r['fault'] : undefined;
  const hosts = Array.isArray(r['hosts']) ? [...new Set(r['hosts'].map(token).filter((h): h is string => !!h))].slice(0, 32) : undefined;
  return {
    ...opt('hostUsage',hostUsageOf(r['hostUsage'])),
    ...opt('startedAt', isoDate(r['startedAt'])),
    ...opt('hosts', hosts?.length ? hosts : undefined),
    ...opt('capture',record(r['capture']) && (r['capture']['state']==='opened'||r['capture']['state']==='completed') ? {
      state:r['capture']['state'] as 'opened'|'completed',start:millis(r['capture']['start'])??0,
      ...opt('end',millis(r['capture']['end'])),...opt('storageFailed',count(r['capture']['storageFailed']))} : undefined),
    ...opt('retroState',(['missing','unreadable','malformed','invalid','empty','collected'] as const).find(x=>x===r['retroState'])),
    ...opt('collection',record(r['collection']) ? Object.fromEntries(['completed','partial','corrupt','unreadable','incomplete','storageFailed'].flatMap(k=>{const n=count((r['collection'] as Record<string,unknown>)[k]);return n===undefined?[]:[[k,Math.min(1_000_000,n)]];})) : undefined),
    ...opt('provenance',Array.isArray(r['provenance']) ? r['provenance'].slice(0,100).filter(record).map(p=>{const clean=sanitizeFacts({...p,phases:[],invocations:[],reviews:[]});return { ...opt('version',clean.version),...opt('build',clean.build),...opt('config',clean.config)};}) : undefined),
    ...opt('rejectedTools',Array.isArray(r['rejectedTools']) ? r['rejectedTools'].slice(0,1000).filter(record).flatMap(v=>{
      const cls=['invalid-input','invalid-record','approval-stale','key-conflict','user-only'].find(x=>x===v['cls']),tool=token(v['tool']),action=token(v['action']);return cls&&tool&&action?[{tool,action,cls}]:[];}) : undefined),
    ...opt('relaunches',count(r['relaunches'])===undefined?undefined:Math.min(1_000_000,count(r['relaunches'])!)),
    ...opt('version', match(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/)(r['version'])), ...opt('build', build?.slice(0, 12)),
    ...opt('os', token(r['os'])), ...opt('host', token(r['host'])),
    ...opt('verb', VERBS.find((v) => v === r['verb'])), ...opt('level', LEVELS.find((v) => v === r['level'])),
    ...opt('pins', match(/^[A-Za-z0-9_.,:-]{1,96}$/)(r['pins'])), ...opt('config', config), ...opt('outcome', token(r['outcome'])),
    ...opt('fault', fault && {
      ...opt('effectId', match(/^[a-z0-9-]+(?:\.[a-z0-9-]+){0,15}$/)(fault['effectId'])), cls: token(fault['cls']) ?? DASH, ...opt('hostWaitMs', millis(fault['hostWaitMs'])),
      ...opt('waitBy', (['user', 'host'] as const).find((by) => by === fault['waitBy'])), ...opt('driverMs', millis(fault['driverMs'])),
    }),
    ...(r['timingScope'] === 'tool-calls' ? {timingScope:'tool-calls' as const} : {}),
    phases: list(r['phases']).filter(record).map((p) => ({
      key: phaseKey(p['key']) ?? '', name: PHASE_NAMES.find((name) => name === p['name']) ?? DASH, ...opt('outcome', token(p['outcome'])),
      ...opt('wallMs', millis(p['wallMs'])), ...opt('driverMs', millis(p['driverMs'])), ...opt('hostMs', millis(p['hostMs'])), ...opt('userMs', millis(p['userMs'])),
    })),
    invocations: list(r['invocations']).flatMap(invocationOf),
    reviews: list(r['reviews']).filter(record).flatMap((v): ReviewFacts[] => {
      const round = count(v['round']), cap = count(v['cap']);
      if (!round) return [];
      const ids = (value: unknown) => list(value).map(match(ID)).filter((id): id is string => !!id);
      const reraised = ids(v['reraised']), escalation = record(v['escalation']) ? v['escalation'] : undefined;
      const kind = escalation?.['kind'] === 'regression' || escalation?.['kind'] === 'deadlock' ? escalation['kind'] : undefined;
      return [{
        ...opt('phase', phaseKey(v['phase'])), round, accepted: count(v['accepted']) ?? 0, rejected: count(v['rejected']) ?? 0,
        ...opt('reraised', reraised.length ? reraised : undefined), ...opt('escalation', kind && { kind, ids: ids(escalation?.['ids']) }),
        ...opt('cap', cap !== undefined && cap <= DIAGNOSTIC_THRESHOLDS.maxRoundCap ? cap : undefined),
      }];
    }),
    ...opt('roundTiming', Array.isArray(r['roundTiming']) ? r['roundTiming'].filter(record).flatMap(v => {
      const review=match(/^review-[a-f0-9]{16}$/)(v['review']), round=count(v['round']);
      if (!review || !round) return [];
      const slots=list(v['slots']).map(s => {
        const slot=record(s)?match(/^[A-Za-z0-9_.-]{1,40}(?:\[\d{1,3}\])?$/)(s['slot']):undefined;
        const attempts=slot&&record(s)?list(s['attempts']).map(a=>record(a)?({...opt('startMs',millis(a['startMs'])),...opt('endMs',millis(a['endMs']))}):{}):[];
        return {slot:slot??DASH,attempts};
      });
      return [{review,round,slots}];
    }) : undefined),
    ...opt('roundWorkload', Array.isArray(r['roundWorkload']) ? r['roundWorkload'].slice(0, 1000).filter(record).flatMap((v): RoundWorkload[] => {
      const review = match(/^review-[a-f0-9]{16}$/)(v['review']), round = count(v['round']);
      if (!review || !round) return [];
      const calls = record(v['calls']) ? v['calls'] : undefined, total = calls ? count(calls['total']) : undefined;
      const phases = calls && Array.isArray(calls['phases']) ? calls['phases'].slice(0, 100).filter(record).flatMap(p => {
        const key = phaseKey(p['key']), n = count(p['count']);
        return key && n !== undefined ? [{key, count: n}] : [];
      }) : [];
      const kind = (['plan', 'design', 'code'] as const).find(kind => kind === v['kind']);
      return [{review, round, ...opt('kind', kind), ...opt('hostTurns', count(v['hostTurns'])), ...opt('calls', total === undefined ? undefined : {total, phases}), ...opt('hostTokens', count(v['hostTokens']))}];
    }) : undefined),
    ...opt('slotYield', Array.isArray(r['slotYield']) ? r['slotYield'].filter(record).flatMap((v): SlotYieldFacts[] => {
      const kind = (['provider', 'native', 'tool'] as const).find((name) => name === v['kind']);
      const provider = token(v['provider']);
      if (!kind || !provider) return [];
      const raised = record(v['raised']) ? v['raised'] : {};
      const attempts = Array.isArray(v['attempts']) ? v['attempts'].filter(record).map((a) => ({
        provider: token(a['provider']) ?? DASH,
        model: modelName(a['model']) ?? DASH,
        effort: a['effort'] === null || a['effort'] === undefined ? null : token(a['effort']) ?? DASH,
        ...opt('usage', usageOf(a['usage'], false)),
      })) : undefined;
      return [{
        kind, provider, model: kind === 'provider' ? modelName(v['model']) ?? null : null,
        raised: { MUST: count(raised['MUST']) ?? 0, SHOULD: count(raised['SHOULD']) ?? 0, CONSIDER: count(raised['CONSIDER']) ?? 0 },
        accepted: count(v['accepted']) ?? 0, rejected: count(v['rejected']) ?? 0, deferred: count(v['deferred']) ?? 0,
        duplicate: count(v['duplicate']) ?? 0, unruled: count(v['unruled']) ?? 0, ...opt('tokens', count(v['tokens'])), ...opt('fixInduced', count(v['fixInduced']) || undefined),
        measured: count(v['measured']) ?? 0, launched: count(v['launched']) ?? 0,
        ...opt('attempts', attempts?.length ? attempts : undefined),
      }];
    }) : undefined),
    ...opt('observations', r['observations']),
  };
}

// SECTION: Heuristics

const RANK = Object.keys(CATEGORIES);
const bySeverity = <T extends { category: Category }>(items: readonly T[]): T[] => [...items].sort((a, b) => RANK.indexOf(a.category) - RANK.indexOf(b.category));
const pct = (share: number) => `${Math.round(share * 100)}%`;
const num = (n: number | undefined) => n === undefined ? DASH : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const tally = (values: readonly string[]) => [...new Set(values)].map((v) => `${v} ×${values.filter((x) => x === v).length}`).join(', ');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(?:s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
const phaseName = (run: RunFacts, key: string | undefined) => {
  const name=run.phases.find(p=>p.key===key)?.name??DASH;
  return key&&/^review-[a-f0-9]{16}$/.test(key)?`${name} · subject ${key.slice(7)}`:name;
};

function groups<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

const PREFLIGHT = ['scripts/toolkit/doctor.ts', 'Detect this condition in the preflight check and skip the provider before launch.'] as const;
const FAILURE_FIXES: Record<string, readonly [string, string]> = {
  'model-not-found': ['scripts/policy/cascade.ts', 'Check configured model names in the preflight and cascade past unknown models before launch.'],
  'model-not-loaded': ['references/providers.md', 'Check that the configured model is installed and loadable on the provider, or replace it in config.'],
  quota: ['references/providers.md', 'Reorder or remove the exhausted model alias, or check its quota; quota limits may be shared.'],
  capacity: ['references/providers.md', 'Check the provider capacity and retry delay; reduce concurrent launches on that provider or wait before re-running.'],
  'no-report': ['references/templates/review-prompt.md', 'Keep the required report JSON in the prompt and inspect the slot log when an answer ends without a report.'],
  timeout: ['references/providers.md', 'Inspect the slot log nudge rows: if the stall persisted through three resumes, check provider health and model load before re-running.'],
  blocked: ['references/providers.md', 'Read the blocked reason; fix the denied path or brief, or replace the model.'],
  'context-overflow': ['scripts/toolkit/prompts.ts', 'Bound prompt and attachment bytes per voice before launch so prompts fit the model context.'],
  auth: PREFLIGHT, 'cli-outdated': PREFLIGHT, 'not-found': PREFLIGHT, 'sandbox-unsupported': PREFLIGHT, config: PREFLIGHT,
};

const DEFAULT_FIX = ['references/providers.md', "Inspect the slot log for the delegate's last output and consider replacing the model or provider."] as const;

// The domain layer cannot import cli.ts, so this table mirrors its handler map.
const TOOL_MODULES: Readonly<Record<string, string>> = {
  'ask run': 'ask', 'review run': 'review', 'diagnostics render': 'diagnostics', 'brief render': 'brief', 'brief explorer': 'brief', 'brief test-cleanup': 'brief', 'brief verifier': 'brief', 'brief fix-check': 'fix-check', 'check run': 'check', 'doctor run': 'doctor', 'status show': 'status', 'lint run': 'lint',
  'report render': 'report', 'report complete': 'report', 'ledger append': 'ledger', 'ledger query': 'ledger',
  'worktree integrate': 'integrate', 'worktree continue': 'integrate', 'worktree commit': 'integrate', 'worktree abort': 'integrate',
  'worktree deliver': 'deliver', 'worktree close': 'deliver', 'worktree cleanup': 'deliver',
  'worktree create': 'writers', 'worktree submit': 'writers', 'worktree abandon': 'writers',
};

/** Deterministic findings (H1–H5, H8, H9) for one run, in severity order. */

export function heuristics(run: RunFacts): Finding[] {
  const T = DIAGNOSTIC_THRESHOLDS;
  const out: Finding[] = [];
  const add = (source: string, category: Category, component: string, evidence: string, impact: string, proposedFix: string) => out.push({ source, category, component, evidence, impact, proposedFix });
  // Quota-store skips never launch, so they cost no driver time and are not attempts.
  const cli = run.invocations.filter((i) => i.surface === 'cli' && i.launched);
  // A single failure absorbed by a retry or reserve is designed behavior; only repeated failures waste work.
  const isOk = (i: InvocationFacts) => i.outcome === 'ok' && (i.validationOutcome === undefined || i.validationOutcome === 'ok');
  const isFailure = (i: InvocationFacts) => i.outcome !== 'ok' || (i.validationOutcome !== undefined && i.validationOutcome !== 'ok');
  const identity = (i: InvocationFacts) => [i.subject ?? i.phase, i.slot, i.provider, i.model].join('\0');
  const cliIndex = new Map(cli.map((row, index) => [row, index] as const));
  // A stall or missing report that a resume chain recovers is not waste: consecutive resume attempts of the same subject, slot, provider and model must end in a valid ok row for the whole chain to leave the failure set.
  const recoveredByResume = (row: InvocationFacts): boolean => {
    if (row.slot === undefined || row.attempt === undefined) return false;
    const start = cliIndex.get(row);
    if (start === undefined) return false;
    const key = identity(row);
    let attempt = row.attempt;
    for (let index = start + 1; index < cli.length; index++) {
      const next = cli[index]!;
      if (identity(next) !== key) continue;
      if (next.nudge !== true || next.attempt !== attempt + 1) return false;
      attempt = next.attempt;
      if (isOk(next)) return true;
    }
    return false;
  };
  const failed = cli.filter(isFailure).filter((row) => !recoveredByResume(row));
  const failureClass = (i:InvocationFacts) => i.outcome !== 'ok' ? i.outcome : i.validationOutcome!;
  const count = (key: (i: InvocationFacts) => string) => { const m = new Map<string, number>(); for (const i of failed) m.set(key(i), (m.get(key(i)) ?? 0) + 1); return m; };
  const bySlot = count((i) => `${i.subject??i.phase}|${i.slot ?? ''}`);
  const byProvider = count((i) => i.provider);
  const wasted = failed.filter((i) => (i.slot !== undefined && (bySlot.get(`${i.subject??i.phase}|${i.slot}`) ?? 0) >= 2) || (byProvider.get(i.provider) ?? 0) >= 2);
  for (const [cls, items] of groups(wasted, failureClass)) {
    const [component, fix] = FAILURE_FIXES[cls] ?? DEFAULT_FIX;
    const spent = sum(items.map((i) => i.durationMs));
    const quota = cls === 'quota';
    const attempts = tally(items.map((i) => quota ? `${i.provider}/${i.model}` : i.provider));
    let recovery = '';
    if (quota) {
      const indexOf = new Map(run.invocations.map((item, index) => [item, index]));
      const routed = new Set(['next-model', 'next-mode', 'reserve']);
      const recovered = items.filter((failedItem) => {
        if (!failedItem.subject || !failedItem.slot || !routed.has(failedItem.routingOutcome ?? '')) return false;
        const failedIndex = indexOf.get(failedItem);
        if (failedIndex === undefined) return false;
        return run.invocations.slice(failedIndex + 1).some((later) => {
          if (later.surface !== 'cli' || !later.launched || later.subject !== failedItem.subject || later.outcome !== 'ok'
            || (later.validationOutcome !== undefined && later.validationOutcome !== 'ok')) return false;
          const retried = later.slot === failedItem.slot && failedItem.attempt !== undefined
            && later.attempt !== undefined && later.attempt > failedItem.attempt;
          const reserved = later.slot !== undefined && later.slot !== failedItem.slot && later.targetSlot === failedItem.slot;
          return retried || reserved;
        });
      }).length;
      recovery = `, ${recovered} recovered by fallback`;
    }
    add('H1', 'correctness', component, `\`${cls}\`: ${items.length} of ${plural(cli.length, 'CLI attempt')} failed (${attempts})${recovery}${spent === undefined ? '' : `, ${formatDuration(spent)} of driver time`}.`, 'Failed attempts delay the wave and trigger retries or cascade launches.', fix);
  }
  for (const [key, rows] of groups(run.reviews, (r) => r.phase ?? '')) {
    const rounds = Math.max(...rows.map((r) => r.round));
    const reraised = [...new Set(rows.flatMap((r) => r.reraised ?? []))];
    const escalation = rows.map((r) => r.escalation).filter((e) => e !== undefined).at(-1);
    // Known-cap continuation is designed; only a run without a recorded cap uses the fixed threshold.
    const cap = rows.map((r) => r.cap).filter((c) => c !== undefined).at(-1);
    const fallback = cap === undefined && rounds >= T.reviewRounds;
    if (!fallback && !reraised.length && !escalation) continue;
    const ids = (values: readonly string[]) => values.length ? ` (${values.slice(0, 5).join(', ')})` : '';
    // NOTE: a deadlock in the cap round without re-raised findings is the cap-ending refresh label; past the cap it marks designed continuation, so its fix must not raise the cap.
    const capReached = cap !== undefined && escalation?.kind === 'deadlock' && rounds === cap && !reraised.length;
    const pastCap = cap !== undefined && rounds > cap && (!escalation ? reraised.length > 0 : escalation.kind === 'deadlock' && !reraised.length);
    const detail = [
      plural(rounds, 'round'),
      ...(capReached ? [`cap reached (${cap})`] : []),
      ...(pastCap ? [`continued past the cap (${cap})`] : []),
      ...(reraised.length ? [`${plural(reraised.length, 'finding')} re-raised across rounds${ids(reraised)}`] : []),
      ...(escalation && !capReached ? [`${escalation.kind} escalation${ids(escalation.ids)}`] : []),
    ];
    add('H2', 'review-convergence', 'references/review-rules.md', `${phaseName(run, key)}: ${detail.join('; ')}.`, 'Each extra round adds voice launches and a host ruling turn.', capReached ? 'Raise the round cap or narrow scope.' : 'Require reviewers to cite new code or requirement evidence before re-raising a settled finding; otherwise the earlier ruling stays closed.');
  }
  for (const r of run.reviews) {
    const all = r.accepted + r.rejected;
    if (all < T.minSamples || r.rejected / all <= T.rejectedShare) continue;
    add('H3', 'review-convergence', 'references/templates/review-prompt.md', `${phaseName(run, r.phase)} round ${r.round}: ${r.rejected} of ${plural(all, 'finding')} rejected (${pct(r.rejected / all)}).`, 'Rejected findings cost reviewer tokens and host ruling time without changing the artifact.', 'Read the rejection rulings; where reviewers misread scope or criteria, state that boundary in the artifact the prompt cites.');
  }
  const metered = run.invocations.filter((i) => measured(i));
  for (const [provider, items] of groups(metered, (i) => i.provider)) {
    const reporting = items.filter((i) => i.usage!.cacheRead !== undefined);
    const cacheRead = sum(reporting.map((i) => i.usage!.cacheRead)) ?? 0, input = cacheRead + (sum(reporting.map((i) => i.usage!.input)) ?? 0);
    if (!reporting.length || !input || cacheRead / input >= T.cacheReadShare) continue;
    add('H4', 'token-economy', 'scripts/toolkit/domain/prompt.ts', `${provider}: cache read ${pct(cacheRead / input)} of input (${num(cacheRead)} of ${num(input)} tokens) across ${plural(reporting.length, 'invocation')}.`, 'Uncached input is billed and processed in full on every launch.', 'Put stable content (rules, templates, shared context) before per-voice and per-round content so provider prompt caches hit.');
  }
  // Cache reads are cheap and dominate long sessions, so rank launches by uncached tokens; zero-usage failures are not samples.
  const sizes = metered.map((i) => [i, uncached(i.usage!)] as const).filter(([, n]) => n > 0);
  if (sizes.length >= T.minSamples) {
    const all = sum(sizes.map(([, n]) => n)) ?? 0;
    const [top, n] = sizes.reduce((a, b) => b[1] > a[1] ? b : a);
    // Above an even share (2/n) the largest invocation stands out; at small n, even shares already reach half.
    if (all && n / all > Math.max(T.invocationShare, 2 / sizes.length)) add('H5', 'token-economy', 'scripts/toolkit/prompts.ts', `${top.provider} ${top.model} in ${phaseName(run, top.phase)}: ${num(n)} of ${num(all)} measured uncached tokens (${pct(n / all)}).`, 'One invocation dominates token spend; its own repository exploration likely drives most of it.', 'Lower that slot\'s turn budget or effort, or assign it a cheaper model.');
  }
  // One clear refusal is not a pattern.
  const rejection = (item: { tool: string; action: string; cls: string }) => item.tool + ' ' + item.action + ': ' + item.cls;
  const repeated = [...groups(run.rejectedTools ?? [], rejection).values()].filter((items) => items.length >= 2).flat();
  for (const [component, items] of groups(repeated, (item) => `scripts/toolkit/${TOOL_MODULES[item.tool + ' ' + item.action] ?? 'cli'}.ts`)) {
    add('H8', 'correctness', component, `${plural(items.length, 'toolkit operation')} rejected (${tally(items.map(rejection))}).`, 'Rejected operations can require another host turn.', 'Return the allowed input shape and current preconditions with the rejection.');
  }
  // One relaunch without a recorded cause is not a pattern.
  if ((run.relaunches ?? 0) >= 2) add('H9','correctness','scripts/toolkit/brief.ts',`${plural(run.relaunches!,'writer relaunch')}; rework evidence, cause unavailable.`,'Additional launches repeat context and may repeat verification.','Read the writer launch reports at `.state/briefs/<task>-<launch>.report.md` for the relaunch cause.');
  return bySeverity(out);
}

// SECTION: Rendering

/** `1h 4m 12s` | `45s` | `<1s`; unavailable renders `—`. */

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

// Only a `<` that could open a tag, comment, or declaration is escaped, so `<1s` stays readable.
const md = (text: string) => text.replace(/<(?=[A-Za-z/!?])/g, '&lt;');
const cell = (text: string) => md(text).replace(/\|/g, '\\|');
const row = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
const tokenCells = (t: Totals | undefined, prefix = '') => [t?.input, t?.cacheRead, t?.cacheWrite, t?.output].map((n) => n === undefined ? DASH : `${prefix}${num(n)}`);
const unique = (values: readonly string[]) => [...new Set(values)].join(', ') || DASH;
const clip = (text: string, max: number) => Array.from(text).length > max ? `${Array.from(text).slice(0, max - 1).join('')}…` : text;
const sourceOf = (f: Finding) => f.source === 'retro' ? `host retro \`${f.id ?? DASH}\`` : f.source;
const summaryLine = (f: Finding) => md(`${CATEGORIES[f.category]} · \`${f.component}\` · ${clip(f.evidence, 160)} (${f.source === 'retro' ? 'host retro' : f.source})`);

function coverage(items: readonly InvocationFacts[]): string {
  const launched = items.filter((i) => i.surface === 'cli' && i.launched);
  return launched.length ? `${launched.filter((i) => measured(i)).length}/${launched.length}` : DASH;
}

const usageSamples = (items: readonly InvocationFacts[]): UsageSample[] => items.flatMap((i) => {
  const usage = measured(i);
  return usage ? [{ usage, platform: i.provider, reasoningInOutput: usage.reasoningInOutput }] : [];
});

function usageSummary(items: readonly InvocationFacts[]): string {
  const t = totals(usageSamples(items));
  if (!t) return DASH;
  const apart = t.all - t.input - (t.cacheRead ?? 0) - (t.cacheWrite ?? 0) - t.output;
  return `${num(t.all)} (input ${num(t.input)} · cache read ${num(t.cacheRead)} · cache write ${num(t.cacheWrite)} · output ${num(t.output)}${apart > 0 ? ` · reasoning ${num(apart)}` : ''})`;
}

// Cost units: one host row, one `model#effort` entry of a launched CLI invocation, or one invocation without usage. Rollups sum unit costs.
type Unit = { platform: string; phase?: string; stage: string; role: string; model: string; effort: string; configured: boolean; usage?: ModelUsage; reasoningInOutput?: boolean; coverage?: readonly CoverageReason[]; cost: Cost | undefined; row: boolean };

function priceUnit(pricer: Pricer | undefined, platform: string, model: string, usage: ModelUsage | undefined, inOutput: boolean | undefined, onDate: string | undefined): Cost | undefined {
  return !pricer ? undefined : usage ? pricer.price(model, usage, !reasoningApart(platform, inOutput), onDate) : { low: 0, high: 0, priced: false, reasons: new Set<CostReason>(['no usage']) };
}

function invocationUnits(
  i: { provider: string; model: string; effort?: string | null | undefined; usage?: Usage | undefined; reportedModels?: readonly string[] | undefined; coverage?: readonly CoverageReason[] | undefined },
  stage: string,
  phase: string | undefined,
  pricer: Pricer | undefined,
  onDate: string | undefined,
): Unit[] {
  const out: Unit[] = [];
  const usage = i.usage, effort = i.effort ?? DASH;
  const unit = (model: string, effortName: string, part: ModelUsage | undefined, configured = false): Unit => ({
    platform: i.provider, ...opt('phase', phase), stage, role: 'delegate', model, effort: effortName, configured,
    ...(part ? { usage: part } : {}), ...(usage?.reasoningInOutput === undefined ? {} : { reasoningInOutput: usage.reasoningInOutput }),
    ...opt('coverage', i.coverage), row: true,
    cost: priceUnit(pricer, i.provider, model, part, usage?.reasoningInOutput, onDate),
  });
  if (usage?.models) {
    for (const [key, part] of Object.entries(usage.models)) {
      // A `#` key renders its own effort; a plain key keeps the invocation effort.
      const at = key.indexOf('#');
      out.push(unit(at < 0 ? key : key.slice(0, at) || DASH, at < 0 ? effort : key.slice(at + 1) || DASH, part));
    }
  } else {
    const reported = i.reportedModels?.length ?? 0;
    out.push(unit(reported > 1 ? DASH : i.model, effort, usage, reported <= 1));
  }
  return out;
}

export function unitsOf(run: RunFacts, pricer: Pricer | undefined): Unit[] {
  const out: Unit[] = [];
  const hostPlatform = run.hostUsage?.platform ?? DASH;
  for (const h of run.hostUsage?.rows ?? []) {
    out.push({
      platform: hostPlatform, ...opt('phase', h.phase), stage: h.stage, role: h.role, model: h.model, effort: h.effort ?? DASH, configured: false,
      usage: h, ...(h.reasoningInOutput === undefined ? {} : { reasoningInOutput: h.reasoningInOutput }), row: true,
      cost: priceUnit(pricer, hostPlatform, h.model, h, h.reasoningInOutput, run.startedAt),
    });
  }
  for (const i of run.invocations) {
    if (i.surface !== 'cli' || !i.launched) continue;
    const phase = run.phases.find(p => p.key === i.phase)?.name, stage = phase === 'integration review' ? 'code review' : STAGE_ORDER.find(x => x === phase) ?? DASH;
    out.push(...invocationUnits({ ...i, usage: measured(i) }, stage, i.phase, pricer, run.startedAt));
  }
  return out;
}

const costText = (units: readonly Unit[]) => formatCost(sumCost(units.flatMap(u => u.cost ?? [])));

function largestRemainder(exact: readonly number[]): number[] {
  // Largest remainder: floor each part, then give the residual points to the largest fractions.
  const parts = exact.map(Math.floor), order = exact.map((_, k) => k).sort((x, y) => (exact[y]! - parts[y]!) - (exact[x]! - parts[x]!) || x - y);
  for (let left = 100 - parts.reduce((n, s) => n + s, 0), k = 0; left > 0; left--, k++) parts[order[k % order.length]!]!++;
  return parts;
}

/** Top three `model/effort` keys by cost-midpoint share, `other N%` beyond three, `+ unpriced` when any unit is unpriced, and token shares when no cost ranks. Shares total 100%. */
function topModels(units: readonly Unit[]): string {
  const groups = new Map<string, { key: string; tokens: number; costs: Cost[] }>();
  for (const u of units) {
    if (!u.usage || !u.cost) continue;
    const key = u.effort === DASH ? u.model : `${u.model}/${u.effort}`, g = groups.get(key) ?? { key, tokens: 0, costs: [] };
    g.tokens += billedTokens(u.usage, u.platform, u.reasoningInOutput); g.costs.push(u.cost); groups.set(key, g);
  }
  const all = [...groups.values()].map(g => ({ ...g, cost: sumCost(g.costs) }));
  const mid = (c: Cost) => (c.low + c.high) / 2;
  const shares = (ranked: typeof all, share: (g: (typeof all)[number]) => number) => {
    const exact = ranked.slice(0, 3).map(g => share(g) * 100);
    if (ranked.length > 3) exact.push(Math.max(0, 100 - exact.reduce((n, s) => n + s, 0)));
    return largestRemainder(exact).map((n, k) => `${k < 3 ? ranked[k]!.key : 'other'} ${n}%`).join(' · ');
  };
  const pricedGroups = all.filter(g => g.cost.priced), total = pricedGroups.reduce((n, g) => n + mid(g.cost), 0);
  const unpriced = units.some(u => u.row && u.cost && !u.cost.priced) ? ' + unpriced' : '';
  if (!pricedGroups.length || total === 0) {
    const tokens = all.reduce((n, g) => n + g.tokens, 0);
    return tokens ? `${shares([...all].sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key)), g => g.tokens / tokens)} (tokens)${unpriced}` : DASH;
  }
  const ranked = pricedGroups.sort((a, b) => mid(b.cost) - mid(a.cost) || b.tokens - a.tokens || a.key.localeCompare(b.key));
  return shares(ranked, g => mid(g.cost) / total) + unpriced;
}

/** Ranked `## Cost drivers` section (up to 5 stage/platform/role/model/effort groups plus remainder). */
function costDrivers(units: readonly Unit[]): string[] {
  type DriverGroup = { key: string; stage: string; platform: string; role: string; model: string; effort: string; configured: boolean; units: Unit[]; tokens: number; input: number; cacheRead: number; cacheWrite: number };
  const map = new Map<string, DriverGroup>();
  for (const u of units) {
    if (!u.row) continue;
    const key = [u.stage, u.platform, u.role, u.model, u.effort].join('\0');
    const g = map.get(key) ?? { key, stage: u.stage, platform: u.platform, role: u.role, model: u.model, effort: u.effort, configured: u.configured, units: [], tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
    g.configured ||= u.configured; g.units.push(u);
    if (u.usage) {
      g.tokens += billedTokens(u.usage, u.platform, u.reasoningInOutput);
      g.input += u.usage.input; g.cacheRead += u.usage.cacheRead ?? 0; g.cacheWrite += u.usage.cacheWrite ?? 0;
    }
    map.set(key, g);
  }
  const all = [...map.values()].map(g => { const cost = sumCost(g.units.flatMap(u => u.cost ?? [])); return { ...g, cost, mid: cost.priced ? (cost.low + cost.high) / 2 : 0 }; });
  const pricedTotal = all.filter(g => g.cost.priced).reduce((n, g) => n + g.mid, 0);
  const totalTokens = all.reduce((n, g) => n + g.tokens, 0);
  const hasPriced = all.some(g => g.cost.priced);
  if (pricedTotal === 0 && totalTokens === 0) return ['## Cost drivers', '', 'No priced cost or billed tokens.', ''];
  const byTokens = (a: (typeof all)[number], b: (typeof all)[number]) => b.tokens - a.tokens || a.key.localeCompare(b.key);
  const ordered = hasPriced
    ? [...all.filter(g => g.cost.priced).sort((a, b) => b.mid - a.mid || byTokens(a, b)), ...all.filter(g => !g.cost.priced).sort(byTokens)]
    : [...all].sort(byTokens);
  const listed = ordered.slice(0, 5), rest = ordered.slice(5);
  const shareable = hasPriced ? listed.filter(g => g.cost.priced) : listed, restShareable = hasPriced ? rest.filter(g => g.cost.priced) : rest;
  const parts = pricedTotal > 0 || !hasPriced ? largestRemainder([
    ...shareable.map(g => (pricedTotal > 0 ? g.mid / pricedTotal : g.tokens / totalTokens) * 100),
    ...(restShareable.length > 0 ? [Math.max(0, 100 - shareable.reduce((n, g) => n + (pricedTotal > 0 ? g.mid / pricedTotal : g.tokens / totalTokens) * 100, 0))] : []),
  ]) : [];
  let idx = 0;
  const cacheHit = (g: { input: number; cacheRead: number; cacheWrite: number }) => { const d = g.input + g.cacheRead + g.cacheWrite; return d === 0 ? DASH : pct(g.cacheRead / d); };
  const rows = listed.map(g => row([g.stage, g.platform, g.role, g.model === DASH ? DASH : g.configured ? `${g.model} (configured)` : g.model, g.effort, formatCost(g.cost), hasPriced && !g.cost.priced ? 'unpriced' : hasPriced && pricedTotal === 0 ? DASH : `${parts[idx++]}%`, num(g.tokens), cacheHit(g)]));
  if (rest.length > 0) {
    const restUnpriced = hasPriced ? rest.length - restShareable.length : 0;
    const label = restUnpriced ? `${rest.length} more (${restUnpriced} unpriced)` : `${rest.length} more`;
    const restTotals = { input: rest.reduce((n, g) => n + g.input, 0), cacheRead: rest.reduce((n, g) => n + g.cacheRead, 0), cacheWrite: rest.reduce((n, g) => n + g.cacheWrite, 0) };
    const restShare = restShareable.length > 0 ? (hasPriced && pricedTotal === 0 ? DASH : `${parts[idx]}%`) : 'unpriced';
    rows.push(row([label, DASH, DASH, DASH, DASH, formatCost(sumCost(rest.flatMap(g => g.units.flatMap(u => u.cost ?? [])))), restShare, num(rest.reduce((n, g) => n + g.tokens, 0)), cacheHit(restTotals)]));
  }
  const intro = pricedTotal > 0 ? [] : [hasPriced ? 'Priced cost is zero; cost shares unavailable.' : 'Ranked by billed tokens: no unit is priced.', ''];
  return ['## Cost drivers', '', ...intro, row(['Stage', 'Platform', 'Role', 'Model', 'Effort', 'Cost', 'Share', 'Billed tokens', 'Cache hit']), '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |', ...rows, ''];
}

// SECTION: Folding

/** Row counts kept per table once a report exceeds its byte cap; an absent entry leaves that table whole. */
type Fold = { timing?: number; stage?: number; phase?: number; platform?: number };
type Foldable = { units: readonly Unit[]; tokens: number; key: string };
const FOLD_ORDER = ['timing', 'stage', 'phase', 'platform'] as const;

/** Keeps the `keep` best-ranked rows (high cost, low cost, tokens, key; unpriced counts 0) in normal order and merges the rest into one trailing row. */
function foldTable<R extends Foldable>(rows: readonly R[], keep: number | undefined, merge: (rest: R[]) => R, pinned: (row: R) => boolean = () => false): R[] {
  const free = rows.filter((r) => !pinned(r));
  if (keep === undefined || keep >= free.length) return [...rows];
  const best = free.map((r) => ({ r, c: sumCost(r.units.flatMap((u) => u.cost ?? [])) }))
    .sort((a, b) => b.c.high - a.c.high || b.c.low - a.c.low || b.r.tokens - a.r.tokens || (a.r.key < b.r.key ? -1 : 1));
  const kept = new Set(best.slice(0, keep).map(({ r }) => r));
  return [...rows.filter((r) => pinned(r) || kept.has(r)), merge(free.filter((r) => !kept.has(r)))];
}

const smaller = (rest: readonly unknown[]) => `${rest.length} smaller rows`;

type PhaseRow = Foldable & { label: string; phase: string; outcome?: string; timing: readonly (number | undefined)[]; items: readonly InvocationFacts[]; pinned: boolean };

/** Folding re-renders the tables only: the table functions in `lines` run per `render(fold)`, so the data builds once. */
function overview(runs: readonly RunFacts[], grounding: readonly (RetroObservation & {run: number})[], runUnits: readonly (readonly Unit[])[], pricer?: Pricer): { render: (fold: Fold) => string[]; counts: Record<(typeof FOLD_ORDER)[number], number> } {
  const overviewPhase = (p: PhaseFacts) => {
    if (/^review-[a-f0-9]{16}$/.test(p.key)) return `${p.name} · subject ${p.key.slice(7)}`;
    return p.key === p.name || p.key === p.name.replace(/ /g, '-') ? p.name : `${p.name} · ${p.key}`;
  };
  const isEmptyPhase = (r: PhaseRow) => r.items.length === 0 && r.units.every(u => (!u.usage || billedTokens(u.usage, u.platform, u.reasoningInOutput) === 0) && !u.cost?.priced);
  const notes: string[] = [];
  const phaseRows: PhaseRow[] = [];
  runs.forEach((run, index) => {
    const label = `${index + 1} · ${run.verb ?? DASH} · ${run.level ?? DASH}`, units = runUnits[index]!;
    const mkRow = (phase: string, outcome: string | undefined, timing: readonly (number | undefined)[], items: readonly InvocationFacts[], own: readonly Unit[], key?: string): PhaseRow =>
      ({ label, phase, ...opt('outcome', outcome), timing, items, units: own, tokens: totals(usageSamples(items))?.all ?? 0, key: `${index}\0${key ?? ''}`, pinned: key === undefined });
    const runPhases = run.phases.map(p => mkRow(overviewPhase(p), p.outcome, [p.wallMs, p.driverMs, p.hostMs, p.userMs], run.invocations.filter(i => i.phase === p.key), units.filter(u => u.phase === p.key), p.key));
    const empty = runPhases.filter(isEmptyPhase);
    if (empty.length > 1) {
      phaseRows.push(...runPhases.filter(r => !isEmptyPhase(r)), {
        label, phase: `${empty.length} empty phases`, timing: [0, 1, 2, 3].map(k => sum(empty.map(r => r.timing[k]))),
        items: [], units: empty.flatMap(r => r.units), tokens: 0, key: `${index}\0empty`, pinned: false,
      });
    } else {
      phaseRows.push(...runPhases);
    }
    const known = (phase: string | undefined) => run.phases.some((p) => p.key === phase);
    const unmatched = run.invocations.filter((i) => !known(i.phase)), before = units.filter(u => !known(u.phase));
    if (before.length) phaseRows.push(mkRow('before first phase', undefined, [undefined, undefined, undefined, undefined], unmatched, before));
    if (run.phases.length !== 1 || unmatched.length || before.length) phaseRows.push(mkRow('all phases', run.outcome, (['wallMs', 'driverMs', 'hostMs', 'userMs'] as const).map((k) => sum(run.phases.map((p) => p[k]))), run.invocations, units));
    if (run.fault) notes.push(`- Run ${index + 1} fault: \`${run.fault.cls}\`${run.fault.effectId ? ` in \`${run.fault.effectId}\`` : ''}; ${run.fault.waitBy === 'user' ? 'user' : 'host'} wait ${formatDuration(run.fault.hostWaitMs)}; driver ${formatDuration(run.fault.driverMs)}.`);
  });
  const TIMING_COLS = ['Wall', 'Driver', 'Host', 'User wait'] as const;
  const showTiming = TIMING_COLS.map((_, idx) => phaseRows.some((r) => r.timing[idx] !== undefined));
  const lines: (string | ((fold: Fold) => string[]))[] = [
    '## Overview', '',
    row(['Run', 'Phase', 'Outcome', ...TIMING_COLS.filter((_, idx) => showTiming[idx]), 'Invocations', 'Input', 'Cache read', 'Cache write', 'Output', 'Coverage', 'Cost', 'Top models']),
    row(['---', '---', '---', ...showTiming.filter(Boolean).map(() => '---:'), '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---']),
  ];
  // Summed timings, items and units keep the folded row's cells equal to its parts; `all phases` and `before first phase` stay pinned.
  const mergePhases = (rest: PhaseRow[]): PhaseRow => ({ label: DASH, phase: smaller(rest), timing: [0, 1, 2, 3].map((k) => sum(rest.map((r) => r.timing[k]))), items: rest.flatMap((r) => r.items), units: rest.flatMap((r) => r.units), tokens: 0, key: '', pinned: false });
  lines.push((fold) => foldTable(phaseRows, fold.phase, mergePhases, (r) => r.pinned).map((r) => row([r.label, r.phase, r.outcome ?? DASH, ...r.timing.filter((_, idx) => showTiming[idx]).map(formatDuration), String(r.items.length), ...tokenCells(totals(usageSamples(r.items))), coverage(r.items), costText(r.units), r.units.some(u => u.cost) ? topModels(r.units) : DASH])));
  if (notes.length) lines.push('', ...notes);
  lines.push('', 'Overview token columns count CLI delegates only; Cost also counts host and subagent usage attributed by time.', '');
  if (grounding.length) {
    lines.push('### Grounding', '', row(['Run', 'Phase', 'Evidence', 'Assessment', 'Proposed change']), '| --- | --- | --- | --- | --- |');
    for (const g of grounding) lines.push(row([String(g.run), g.id.slice('grounding-'.length), g.evidence, g.impact, g.proposedFix]));
    lines.push('');
  }
  type TokenRow = {stage:string; platform:string; role:string; model:string; effort:string; configured:boolean; samples:UsageSample[]; measured:number; launched:number; coverageReasons:Set<CoverageReason>; costReasons:Set<CostReason>; units:Unit[]; tokens:number; key:string; coverage?:string; costNotes?:string};
  const rows = new Map<string,TokenRow>();
  const allUnits = runUnits.flat();
  for(const u of allUnits) {
    if(!u.row) continue;
    const key=[u.stage,u.platform,u.role,u.model,u.effort].join('\0');
    const entry=rows.get(key) ?? {stage:u.stage,platform:u.platform,role:u.role,model:u.model,effort:u.effort,configured:u.configured,samples:[],measured:0,launched:0,coverageReasons:new Set<CoverageReason>(),costReasons:new Set<CostReason>(),units:[],tokens:0,key};
    entry.configured ||= u.configured; entry.launched++; entry.units.push(u); if(u.usage){entry.measured++;entry.samples.push({usage:u.usage,platform:u.platform,reasoningInOutput:u.reasoningInOutput});entry.tokens+=billedTokens(u.usage,u.platform,u.reasoningInOutput);}
    for(const reason of u.coverage ?? []) entry.coverageReasons.add(reason);
    for(const reason of u.cost?.reasons ?? []) entry.costReasons.add(reason);
    rows.set(key,entry);
  }
  const sorted=[...rows.values()].sort((a,b)=>(STAGE_ORDER.indexOf(a.stage as never) < 0 ? 99 : STAGE_ORDER.indexOf(a.stage as never))-(STAGE_ORDER.indexOf(b.stage as never) < 0 ? 99 : STAGE_ORDER.indexOf(b.stage as never)) || a.platform.localeCompare(b.platform) || ['host','subagent','delegate'].indexOf(a.role)-['host','subagent','delegate'].indexOf(b.role) || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort));
  const platforms=new Set([...sorted.map(r=>r.platform),...runs.flatMap(r=>r.hostUsage?[r.hostUsage.platform??DASH]:[]),...allUnits.map(u=>u.platform)]);
  const cells=(samples:UsageSample[])=>{const t=totals(samples);return [...tokenCells(t),t?.reasoning===undefined?DASH:num(t.reasoning)];};
  const coverageRow=(r:TokenRow)=>r.coverage ?? (r.role==='delegate'?`${r.measured}/${r.launched}${r.coverageReasons.size?' '+[...r.coverageReasons].join(', '):''}`:[...r.coverageReasons].join(', ')||DASH);
  const costNotesRow=(r:TokenRow)=>r.costNotes ?? ([...r.costReasons].join(', ')||DASH);
  type PlatformRow = Foldable & {platform:string; samples:UsageSample[]; segments:string[]; costNotes:string[]};
  const platformRows:PlatformRow[]=[];
  lines.push('### Tokens by platform','',row(['Platform','Uncached input','Cache read','Cache write','Output','Reasoning','Coverage','Cost notes','Cost']),'| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |');
  for(const platform of [...platforms].sort()) {
    const selected=sorted.filter(r=>r.platform===platform), hosts=runs.flatMap(r=>r.hostUsage && (r.hostUsage.platform??DASH)===platform?[r.hostUsage]:[]);
    const segments:string[]=[];
    for(const role of HOST_ROLES) {
      const roleRows=selected.filter(r=>r.role===role), roleNotes=hosts.flatMap(h=>Object.entries(h.notes?.[role]??{}));
      const aggregated=new Map<string,number>(); for(const [key,n] of roleNotes) aggregated.set(key,(aggregated.get(key)??0)+n);
      const noteText=aggregated.size?' ('+[...aggregated].map(([key,n])=>`${key} ${n}`).join(', ')+')':'';
      if(role==='host' && hosts.length) {const reasons=[...new Set(hosts.flatMap(h=>h.unavailable?[h.unavailable]:[]))];if(roleRows.length) segments.push('host measured'+noteText); if(reasons.length) segments.push(`host unavailable: ${reasons.join(', ')}`+(roleRows.length?'':noteText)); else if(!roleRows.length) segments.push('host unavailable: no usage records'+noteText);}
      if(role==='subagent' && (roleRows.length || aggregated.size)) segments.push((roleRows.length?'subagents measured':'subagents not measured')+noteText);
    }
    const delegates=runs.flatMap(r=>r.invocations).filter(i=>i.provider===platform && i.surface==='cli' && i.launched); if(delegates.length){const reasons=[...new Set(delegates.flatMap(i=>i.coverage ?? []))];segments.push(`delegates ${delegates.filter(i=>measured(i)).length}/${delegates.length}${reasons.length?' '+reasons.join(', '):''}`);}
    const mine=allUnits.filter(u=>u.platform===platform), costNotes=[...new Set(mine.flatMap(u=>[...(u.cost?.reasons ?? [])]))];
    const samples=selected.flatMap(r=>r.samples);
    platformRows.push({platform,samples,segments,costNotes,units:mine,tokens:samples.reduce((n,s)=>n+billedTokens(s.usage,s.platform,s.reasoningInOutput),0),key:platform});
  }
  const mergePlatforms=(rest:PlatformRow[]):PlatformRow=>({platform:smaller(rest),samples:rest.flatMap(r=>r.samples),segments:[...new Set(rest.flatMap(r=>r.segments))],costNotes:[...new Set(rest.flatMap(r=>r.costNotes))],units:rest.flatMap(r=>r.units),tokens:0,key:''});
  lines.push(fold=>foldTable(platformRows,fold.platform,mergePlatforms).map(r=>row([r.platform,...cells(r.samples),r.segments.join(' · ')||DASH,r.costNotes.join(', ')||DASH,costText(r.units)])));
  if(!platforms.size) lines.push(row(Array<string>(9).fill(DASH)));
  lines.push('','### Tokens by stage','','Host and subagent stages are time-derived; delegate stages are recorded.','',row(['Stage','Platform','Role','Model','Effort','Uncached input','Cache read','Cache write','Output','Reasoning','Coverage','Cost notes','Cost']),'| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |');
  const mergeStages=(rest:TokenRow[]):TokenRow=>{
    const delegates=rest.filter(r=>r.role==='delegate'), covReasons=[...new Set(rest.flatMap(r=>[...r.coverageReasons]))].join(', ');
    return {stage:smaller(rest),platform:DASH,role:DASH,model:DASH,effort:DASH,configured:false,samples:rest.flatMap(r=>r.samples),measured:0,launched:0,coverageReasons:new Set(),costReasons:new Set(),units:rest.flatMap(r=>r.units),tokens:0,key:'',coverage:delegates.length?`${delegates.reduce((n,r)=>n+r.measured,0)}/${delegates.reduce((n,r)=>n+r.launched,0)}${covReasons?' '+covReasons:''}`:covReasons||DASH,costNotes:[...new Set(rest.flatMap(r=>[...r.costReasons]))].join(', ')||DASH};
  };
  lines.push(fold=>foldTable(sorted,fold.stage,mergeStages).map(entry=>row([entry.stage,entry.platform,entry.role,entry.model===DASH?DASH:entry.configured?`${entry.model} (configured)`:entry.model,entry.effort,...cells(entry.samples),coverageRow(entry),costNotesRow(entry),costText(entry.units)])));
  if(!sorted.length) lines.push(row(Array<string>(13).fill(DASH)));
  const yields = new Map<string, SlotYieldFacts>();
  const yieldUnits = new Map<string, Unit[]>();
  for (const run of runs) for (const row of run.slotYield ?? []) {
    const key = [row.kind, row.provider, row.model ?? ''].join('\0');
    const units = (row.attempts ?? []).flatMap((a) => invocationUnits(a, 'code review', undefined, pricer, run.startedAt));
    if (units.length) yieldUnits.set(key, [...(yieldUnits.get(key) ?? []), ...units]);
    const current = yields.get(key);
    if (!current) { yields.set(key, { ...row, raised: { ...row.raised }, ...(row.attempts ? { attempts: [...row.attempts] } : {}) }); continue; }
    addYield(current, row);
  }
  const yieldRows = [...yields.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.provider.localeCompare(b.provider) || (a.model ?? '').localeCompare(b.model ?? ''));
  const showFixInduced = yieldRows.some((entry) => (entry.fixInduced ?? 0) > 0);
  const timing=runs.flatMap(run=>run.roundTiming??[]);
  if(timing.length) lines.push((fold) => {
    const kept=timing.slice(0,fold.timing??timing.length);
    const result=['', '### Review round timing', '', row(['Review','Round','Slot','Wall','Critical path']), '| --- | ---: | --- | ---: | --- |'];
    for(const round of kept) {
      const spans=round.slots.map(slot=>{
        if(!slot.attempts.length || slot.attempts.some(a=>a.startMs===undefined||a.endMs===undefined||a.endMs<a.startMs)) return undefined;
        return {start:Math.min(...slot.attempts.map(a=>a.startMs!)),end:Math.max(...slot.attempts.map(a=>a.endMs!))};
      });
      const latest=spans.every(Boolean)?spans.findIndex(s=>s!.end===Math.max(...spans.map(x=>x!.end))):-1;
      round.slots.forEach((slot,i)=>result.push(row(['subject '+round.review.slice(7),String(round.round),slot.slot,formatDuration(spans[i] && spans[i]!.end-spans[i]!.start),i===latest?'✓':DASH])));
    }
    if(kept.length<timing.length)result.push('',`${timing.length-kept.length} review timing rounds omitted`);
    return result;
  });
  const workload = runs.flatMap((run) => run.roundWorkload ?? []);
  if (workload.length) {
    const storageFailed = sum(runs.map((run) => run.collection?.storageFailed)) ?? 0;
    const eligible = workload.filter(round => round.kind === 'plan' || round.kind === 'design');
    const over = eligible.filter(round => (round.calls?.total ?? 0) > 6 || (round.hostTurns ?? 0) > 25);
    lines.push('', '### Review round workload', '', row(['Review', 'Round', 'Toolkit calls', 'Host tokens', 'Host turns']), '| --- | ---: | --- | ---: | ---: |',
      ...workload.map((round) => row(['subject ' + round.review.slice(7), String(round.round),
        round.calls ? `${num(round.calls.total)}${round.calls.phases.length ? ': ' + round.calls.phases.map((p) => `${p.key} ${num(p.count)}`).join(' · ') : ''}` : DASH,
        round.calls && round.hostTokens !== undefined ? num(round.hostTokens) : DASH,
        round.hostTurns === undefined ? 'unavailable' : num(round.hostTurns)])),
      '', 'Observed toolkit calls only: `report` and `diagnostics` calls and work outside round windows are not counted.',
      ...(eligible.length ? ['Advisory budget per round with a fix check: at most 6 toolkit calls and 25 host turns; over: ' + (over.map(round => 'subject ' + round.review.slice(7) + ' round ' + round.round).join(', ') || 'none')] : []),
      ...(storageFailed ? [`${plural(storageFailed, 'capture storage failure')}: calls from failed updates may be missing from the counts above.`] : []));
  }
  lines.push('', '### Review yield by slot', '',
    row(['Provider', 'Model', 'MUST', 'SHOULD', 'CONSIDER', ...(showFixInduced ? ['Fix-induced'] : []), 'Accepted', 'Rejected', 'Deferred', 'Duplicate', 'Unruled', 'Tokens', 'Tokens / accepted', 'Cost', 'Cost / accepted', 'Cost notes']),
    '| --- | --- | ---: | ---: | ---: |' + (showFixInduced ? ' ---: |' : '') + ' ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const entry of yieldRows) {
    const key = [entry.kind, entry.provider, entry.model ?? ''].join('\0');
    const units = yieldUnits.get(key) ?? [];
    const totalCost = sumCost(units.flatMap((u) => u.cost ?? []));
    const partial = entry.measured < entry.launched ? ' partial' : '';
    const tokensCell = `${entry.tokens === undefined ? DASH : num(entry.tokens)}${partial}`;
    const tokensPerAccepted = entry.accepted === 0 ? '0 accepted' : entry.tokens === undefined ? DASH : `${num(entry.tokens / entry.accepted)}${partial}`;
    const costCell = `${formatCost(totalCost)}${totalCost.priced ? partial : ''}`;
    const costPerAccepted = entry.accepted === 0 ? '0 accepted' : !totalCost.priced ? DASH : `${formatCost({ ...totalCost, low: totalCost.low / entry.accepted, high: totalCost.high / entry.accepted })}${partial}`;
    const costNotes = [...totalCost.reasons].join(', ') || DASH;
    const model = entry.kind === 'native' ? 'native' : entry.kind === 'tool' ? DASH : entry.model ?? DASH;
    lines.push(row([entry.provider, model, String(entry.raised.MUST), String(entry.raised.SHOULD), String(entry.raised.CONSIDER), ...(showFixInduced ? [String(entry.fixInduced ?? 0)] : []),
      String(entry.accepted), String(entry.rejected), String(entry.deferred), String(entry.duplicate), String(entry.unruled), tokensCell, tokensPerAccepted, costCell, costPerAccepted, costNotes]));
  }
  if (!yieldRows.length) lines.push(row(Array<string>(showFixInduced ? 16 : 15).fill(DASH)));
  return { render: (fold) => [...lines.flatMap((line) => typeof line === 'function' ? line(fold) : [line]), ''], counts: { timing: timing.length, stage: sorted.length, phase: phaseRows.filter((r) => !r.pinned).length, platform: platformRows.length } };
}

function appendix(runs: readonly RunFacts[]): string[] {
  const lines = ['## Appendix', '', '<details>', '<summary>Invocations and configuration</summary>', '', row(['Run', 'Phase', 'Provider', 'Model', 'Effort', 'Duration', 'Input', 'Cache read', 'Cache write', 'Output', 'Reasoning', 'Total', 'Outcome']), '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  runs.forEach((run, index) => {
    for (const i of run.invocations) {
      const usage = i.usage ? totals([{ usage: i.usage, platform: i.provider, reasoningInOutput: i.usage.reasoningInOutput }]) : undefined;
      const all = usage?.all;
      const apart = usage ? usage.all - usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0) - usage.output : 0;
      const reasoningCell = usage?.reasoning === undefined ? DASH : apart > 0 ? num(apart) : `${num(usage.reasoning)} (in output)`;
      const provider = i.surface === 'native' ? `${i.provider} (native)` : i.mode && i.mode !== 'cli' ? `${i.provider} (${i.mode})` : i.provider;
      const model = i.reportedModels?.length ? `${i.model} (reported: ${i.reportedModels.join(', ')})` : i.model;
      const review=/^review-[a-f0-9]{16}$/.test(i.phase);
      const ordinal=i.attempt!==undefined&&i.attempt>0?i.attempt:undefined;
      const identity=i.subject?(review?` · attempt ${i.subject}/${ordinal??DASH}`:` · subject ${i.subject} · attempt ${ordinal??DASH}`):ordinal===undefined?'':` · attempt ${ordinal}`;
      lines.push(row([String(index + 1), phaseName(run, i.phase)+identity+(i.slot?' · slot '+i.slot:''), provider, model, i.effort ?? DASH, formatDuration(i.durationMs), ...tokenCells(usage), reasoningCell, all === undefined ? DASH : num(all), i.surface==='native' ? `native ${i.nativeState??(i.outcome==='ok'?'completed':i.outcome==='native-pending'?'pending':'unavailable')}` : `${i.outcome}${i.nudge===true?' · nudge':''}${i.validationOutcome?' · validation '+i.validationOutcome:''}${i.routingOutcome?' · routing '+i.routingOutcome:''}${i.slotState?' · slot '+i.slotState:''}${i.lifecycleSteps?.length?' · lifecycle '+i.lifecycleSteps.map(s=>`${s.step} ${s.outcome} ${s.elapsedMs}/${s.budgetMs} ms`).join(', '):''}${i.launched?'':' (not launched)'}`]));
    }
  });
  lines.push('');
  runs.forEach((run, index) => {
    lines.push(`Run ${index + 1}: verb ${run.verb ?? DASH}, level ${run.level ?? DASH}, pins ${run.pins ?? DASH}, outcome ${run.outcome ?? DASH}.`, '');
    for(const snapshot of run.provenance??[{version:run.version,build:run.build,config:run.config}]) {
      if(!snapshot.version&&!snapshot.build&&!snapshot.config)lines.push('Provenance: unknown historical implementation and configuration.','');
      lines.push(`Provenance: dispatch ${snapshot.version??DASH} · build ${snapshot.build??DASH}.`,'');
      if(snapshot.config&&Object.keys(snapshot.config).length)lines.push('```json',JSON.stringify(snapshot.config,null,2),'```','');
    }
  });
  return [...lines, '</details>', ''];
}

/** Renders the session report from every run's facts; compaction drops the Appendix, then lower-severity findings, then folds the smallest table rows. */

export function renderDiagnostics(input: readonly RunFacts[], pricer?: Pricer): { text: string; findings: number; top?: string } {
  const runs = input.map(sanitizeFacts);
  const retro = runs.map((run) => run.observations === undefined ? undefined : retroObservations(run.observations));
  // Grounding phases report in their own Overview table; every other retro item stays a finding.
  const isGrounding = (o: RetroObservation) => o.id.startsWith('grounding-');
  const grounding = runs.flatMap((_, index) => (retro[index]?.values ?? []).filter(isGrounding).map((o) => ({ ...o, run: index + 1 })));
  const findings = bySeverity(runs.flatMap((run, index): Finding[] => [
    ...heuristics(run).map((f) => ({ ...f, run: index + 1 })),
    ...(retro[index]?.values ?? []).filter((o) => !isGrounding(o)).map((o) => ({ source: 'retro', run: index + 1, id: o.id, category: o.category, component: o.component, evidence: o.evidence, impact: o.impact, proposedFix: o.proposedFix })),
  ]));
  const invocations = runs.flatMap((run) => run.invocations);
  const runUnits = runs.map((run) => unitsOf(run, pricer)), costs = runUnits.flat().flatMap((u) => u.cost ?? []);
  const collected = retro.filter((r) => r !== undefined);
  const hosts = [...new Set(runs.flatMap((run) => run.hosts?.length ? run.hosts : run.host ? [run.host] : []))];
  const measuredPlatforms = [...new Set(runs.map((run) => run.hostUsage?.platform).filter((p): p is string => typeof p === 'string' && p.length > 0))];
  const hostScope = hosts.length > 1
    ? ` · ${measuredPlatforms.length ? `host rows measure the ${measuredPlatforms.join(', ')} thread; other hosts' threads are unmeasured` : 'no host thread is measured'}`
    : '';
  const lead = [
    '# Dispatch diagnostics', '',
    'Review before sharing. This report holds dispatch-owned data only: no user source, objective, repository paths, or identities. Proposed fixes are unverified.', '',
    '`—` marks an unavailable value · `~` marks a cost estimate in USD · a unit is one host row, one model/effort entry of a launched delegate, or one launched delegate without usage; a priced unit has a computed cost; an unpriced unit lacks a rate or usage (reason in `Cost notes`).', '',
    '## Summary', '',
    `- Build: ${unique(runs.flatMap(run=>(run.provenance??[{version:run.version,build:run.build}]).map(p=>`dispatch ${p.version??DASH} · build ${p.build??DASH}`)))}`,
    `- Host: ${hosts.join(', ') || DASH}${hostScope} · OS: ${unique(runs.map((run) => run.os ?? DASH))}`,
    `- Runs: ${runs.length} · measured duration: ${formatDuration(sum(runs.flatMap((run) => run.phases.map((p) => p.wallMs))))}`,
    `- Provider CLI measured tokens: ${usageSummary(invocations)} · launch coverage ${coverage(invocations)}`,
    pricer ? `- Estimated cost (host, subagents and CLI delegates): ${formatCost(sumCost(costs))} · rates as of ${pricer.meta.asOf} · priced ${costs.filter((c) => c.priced).length} · unpriced ${costs.filter((c) => !c.priced).length}` : '- Estimated cost: not estimated (rate table unavailable)',
    ...(runs.some(run => run.timingScope === 'tool-calls') ? [`- Timing scope: summed measured tool-call durations; concurrent calls can overlap. Host reasoning, user wait, ${runs.some(run => run.hostUsage?.rows.length) ? 'native/writer timing' : 'native/writer usage'} and work before enablement are unavailable.`] : []),
    runs.some(run => run.hostUsage?.rows.length) ? '- Full conversation totals: Host and subagent tokens cover the current host thread within the session window; other threads are unavailable. Full collection coverage is unavailable. Total storage loss can be unobservable.' : '- Full conversation totals are unavailable: provider measurements cover reported CLI launches only. Full collection coverage is unavailable. Total storage loss can be unobservable.',
    `- Host retro: ${unique(runs.map((run,index)=>run.retroState??retro[index]?.state??'missing'))} · ${sum(collected.map(r=>r.values.length))??0} accepted · ${sum(collected.map(r=>r.rejected))??0} rejected`,
    `- Collection health: ${runs.some(r=>Object.entries(r.collection??{}).some(([key,n])=>key!=='completed'&&n>0))?'partial':runs.some(r=>(r.collection?.completed??0)>0)?'complete for observed captures':'unknown'} · corrupt ${num(sum(runs.map(r=>r.collection?.corrupt)))} · unreadable ${num(sum(runs.map(r=>r.collection?.unreadable)))} · incomplete ${num(sum(runs.map(r=>r.collection?.incomplete)))} · storage-failed ${num(sum(runs.map(r=>r.collection?.storageFailed)))}`,
    '',
    ...(findings.length ? ['Top findings:', '', ...findings.slice(0, 3).map((f, i) => `${i + 1}. ${summaryLine(f)}`), ''] : []),
    ...costDrivers(runUnits.flat()),
  ];
  const whole = overview(runs, grounding, runUnits, pricer);
  const head = (fold: Fold) => [...lead, ...whole.render(fold)];
  const findingLines = (keep: number) => {
    if (!findings.length) return ['## Findings', '', 'No findings.', ''];
    const lines = ['## Findings', ''];
    findings.slice(0, keep).forEach((f, i) => lines.push(`### ${i + 1}. ${CATEGORIES[f.category]} · \`${f.component}\``, '', `- Source: ${sourceOf(f)} · run ${f.run ?? DASH}`, `- Evidence: ${md(f.evidence)}`, `- Impact: ${md(f.impact)}`, `- Proposed fix (unverified): ${md(f.proposedFix)}`, ''));
    if (keep < findings.length) lines.push(`${plural(findings.length - keep, 'lower-severity finding')} omitted at the report size limit.`, '');
    return lines;
  };
  const tail = appendix(runs);
  const assemble = (withAppendix: boolean, keep: number, fold: Fold = {}) => [...head(fold), ...findingLines(keep), ...(withAppendix ? tail : ['## Appendix', '', 'Omitted at the report size limit.', ''])].join('\n');
  const fits = (text: string) => Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes;
  let text = assemble(true, findings.length);
  if (!fits(text)) text = assemble(false, findings.length);
  for (let keep = findings.length - 1; !fits(text) && keep >= 0; keep--) text = assemble(false, keep);
  // Each table keeps the most rows that fit; when none fits it folds whole and the next table folds.
  const fold: Fold = {};
  for (const table of FOLD_ORDER) {
    if (fits(text)) break;
    if (!whole.counts[table]) continue;
    const render = (n: number) => assemble(false, 0, { ...fold, [table]: n });
    let lo = 0;
    for (let hi = fits(render(0)) ? whole.counts[table] - 1 : 0; lo < hi;) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(render(mid))) lo = mid; else hi = mid - 1;
    }
    fold[table] = lo;
    text = render(lo);
  }
  if (!fits(text)) {
    const cut = Buffer.from(text).subarray(0, DIAGNOSTIC_LIMITS.reportBytes - 256).toString();
    text = `${cut.slice(0, cut.lastIndexOf('\n'))}\n\nTruncated at the report size limit.\n`;
  }
  return { text, findings: findings.length, ...opt('top', findings[0] && summaryLine(findings[0])) };
}
