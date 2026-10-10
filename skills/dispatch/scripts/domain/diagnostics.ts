// Pure diagnostics retrospective: per-run facts in, a severity-ordered, shareable Markdown report out.
// The core collector derives the facts from session journals; nothing here reads ports or files.

// SECTION: Types

const PHASE_NAMES = ['plan', 'plan review', 'implementation', 'code review', 'design', 'design review', 'integration review', 'ask'] as const;
/** The review machine's halt on a re-raised fix (regression) or a pending rejection re-raised twice (deadlock). */
export type Escalation = { kind: 'regression' | 'deadlock'; ids: readonly string[] };
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
export type Category = keyof typeof CATEGORIES;

export type ModelUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
/** `input` is canonical uncached input; `models` holds per-model counters when the provider reports them. */
export type Usage = ModelUsage & { models?: Record<string, ModelUsage> };

/** Phases are disjoint: their wall times sum to the run's wall time. */
export type PhaseFacts = { key: string; name: string; outcome?: string; wallMs?: number; driverMs?: number; hostMs?: number; userMs?: number };
/** One launch attempt (`phase` is a phase key; `outcome` is `ok` or a failure class). Estimated rows carry attested or derived figures. */
export type InvocationFacts = {
  phase: string; provider: string; model: string; effort?: string; mode?: string; surface: 'cli' | 'native';
  launched: boolean; durationMs?: number; outcome: string; usage?: Usage; reportedModels?: string[];
  estimated?: boolean; tokens?: number;
};
/**
 * `reraised` and `escalation` sit on a review's last round; they are the driver's own convergence result, never a re-derivation.
 * `cap` is the phase's resolved round cap on every round; absent, H2 falls back to `DIAGNOSTIC_THRESHOLDS.reviewRounds`.
 */
export type ReviewFacts = { phase?: string; round: number; accepted: number; rejected: number; reraised?: readonly string[]; escalation?: Escalation; cap?: number };
export type RunFacts = {
  version?: string; build?: string; os?: string; host?: string; verb?: string; level?: string; pins?: string;
  config?: Record<string, unknown>; outcome?: string;
  /** `hostWaitMs` is the wait before the failed send; `waitBy` says whether a person or the host held it. */
  fault?: { effectId?: string; cls: string; hostWaitMs?: number; waitBy?: 'user' | 'host'; driverMs?: number };
  phases: PhaseFacts[];
  hostGaps: { await: string; ms: number }[];
  invocations: InvocationFacts[];
  reviews: ReviewFacts[];
  rejectedEvents: { eventType: string; reason: string }[];
  repairs?: number; admissionDefects?: number; orchestratorBytes?: number;
  /** Raw `RETRO` items; gated by `retroObservations` at render time. */
  observations?: unknown;
};
export type RetroObservation = { id: string; component: string; category: Category; evidence: string; impact: string; proposedFix: string };
/** `source` is a heuristic id (`H1`…) or `retro`. */
export type Finding = { source: string; run?: number; id?: string; category: Category; component: string; evidence: string; impact: string; proposedFix: string };

// Share heuristics need `minSamples`, so one or two data points never read as a pattern.
export const DIAGNOSTIC_THRESHOLDS = { reviewRounds: 3, maxRoundCap: 1000, minSamples: 3, rejectedShare: 0.5, cacheReadShare: 0.5, invocationShare: 0.5, hostGapMs: 600_000 } as const;
export const DIAGNOSTIC_LIMITS = { observations: 3, fieldBytes: 512, reportBytes: 131_072, instructionBytes: 1024 } as const;

const files = (dir: string, names: string, ext: string) => names.split(' ').map((name) => `${dir}/${name}${ext}`);
/** Dispatch-owned files a finding may name, relative to the skill root; mirrors the shipped tree. */
export const COMPONENTS: ReadonlySet<string> = new Set([
  'SKILL.md',
  'scripts/dispatch.ts',
  ...files('scripts/core', 'diagnostics effect-id frame interpreter journal lock ports progress types validate', '.ts'),
  ...files('scripts/domain', 'design diagnostics execution-config fix-clustering plan prompt render report sanitize stable-value types', '.ts'),
  ...files('scripts/effects', 'artifacts assess-recovery check-envelope check-review-target checkout git handoff index parse-artifact prepare-review recovery-manifest restore snapshot verify wave-native wave write-brief', '.ts'),
  ...files('scripts/lib', 'cli config diagnostic-usage doctor fs-ext integrity node-fs-ext platform session', '.ts'),
  ...files('scripts/machines', 'ask change-resolution design-revision design diagnostics execution-config implement-tasks implement-types implement plan review revision root types', '.ts'),
  ...files('scripts/policy', 'cascade drift hotfix roster rounds', '.ts'),
  ...files('scripts/providers', 'agy claude codex copilot discovery index native node-process opencode-runtime opencode runner types', '.ts'),
  ...files('references', 'change-handling diagnostics glossary providers review-rules', '.md'),
  ...files('references/readme', 'ask concepts configuration design implement plan review troubleshooting', '.md'),
  ...files('references/templates', 'design plan review-prompt-code review-prompt-design review-prompt-plan review-prompt walkthrough write-brief-hotfix write-brief-task write-brief', '.md'),
  ...files('references/templates/schemas', 'report-code report-design report-plan', '.json'),
  ...files('references/verbs', 'ask design implement plan review', '.md'),
]);

// SECTION: Field gates

const DASH = '—';
const VERBS = ['ask', 'design', 'plan', 'review', 'implement'];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CONFIG_KEYS = ['diagnostics', 'write-concurrency', 'read-delegates', 'write-subagents', 'phases'];
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
// Every rendered identifier and alias passes the locator gate too: a well-formed id can still be a UUID or a host name.
const match = (re: RegExp) => (v: unknown): string | undefined => typeof v === 'string' && re.test(v) && locatorFree(v) ? v : undefined;
const token = match(/^[a-z][a-z0-9-]{0,39}$/);
const phaseKey = match(/^[a-z0-9][a-z0-9/._-]{0,127}$/);
const modelAlias = match(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$/);
const modelName = (v: unknown): string | undefined => { const name = modelAlias(v); return name && !/^[A-Za-z]:|\/\//.test(name) ? name : undefined; };
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

// SECTION: Rejection reasons

/** Bounded classes for a rejected host event; validator text echoes submitted values and keys, so only the class renders. */
export const REJECTION_CLASSES = ['malformed-json', 'effect-pending', 'unknown-type', 'wrong-await', 'unexpected-field', 'invalid-value', 'state-check'] as const;
// Host-event schema field names (core/validate.ts and machine checks); a name missing here only truncates a rendered path.
const EVENT_FIELDS: ReadonlySet<string> = new Set((
  'type path slots rulings clusters tasks task attempt signature handle model effort substitution envelopePath kind reason tokens durationMs '
  + 'criteria waiver answer artifact evidence observations by quote noticeId afterHash action rationale evidenceIds evaluatedLevel gateScope '
  + 'choice request ruling requestId source baseArtifactHash writerRationale delta proposedArtifactHash affectedTasks affectedIncrements paths '
  + 'obligations commands finalCommands phaseDuties increments criterionDefinitions id prerequisites acceptance title changes verify command final '
  + 'preExisting redException testRationale review enforcementInfeasibility planHash objective invariants approvedPaths commandMappings '
  + 'baselineEvidence phaseObligations writer remainingIncrements design status exit inputFingerprint priority outcome dependencies hash fields '
  + 'slot sourceKey outputPath mapping configuredModel launcherModel launcherEffort provider clusterId affectedPaths fix dependsOn verification '
  + 'severity decision selected ids hotfix mode rootCause'
).split(' '));
const MAX_SEGMENTS = 8;

/** `event` plus allowlisted names and indexes; the first other segment renders as `*` and ends the path. */
function fieldPath(head: string): string | undefined {
  if (!head.startsWith('event')) return undefined;
  const out = ['event'];
  const segment = /\.([^.[\]]+)|\[(\d{1,6})\]/y;
  segment.lastIndex = 'event'.length;
  while (segment.lastIndex < head.length) {
    const at = segment.lastIndex, part = segment.exec(head);
    if (!part || out.length > MAX_SEGMENTS || (part[1] !== undefined && !EVENT_FIELDS.has(part[1]))) {
      if (at === 'event'.length && head[at] !== '.' && head[at] !== '[') return undefined;
      out.push('.*');
      break;
    }
    out.push(part[1] === undefined ? `[${part[2]}]` : `.${part[1]}`);
  }
  return out.length > 1 ? out.join('') : undefined;
}

/**
 * Reduces a validator or machine rejection to `<class>` or `<class> at <field path>`; never echoes a value or an
 * arbitrary key. Idempotent, so the collector and the renderer may both apply it.
 */
export function rejectionReason(v: unknown): string {
  if (typeof v !== 'string') return 'state-check';
  const [, prior = '', priorPath] = /^([a-z-]+)(?: at (event\S*))?$/.exec(v) ?? [];
  if ((REJECTION_CLASSES as readonly string[]).includes(prior)) {
    const path = priorPath === undefined ? undefined : fieldPath(priorPath);
    return path ? `${prior} at ${path}` : prior;
  }
  const unexpected = v.endsWith(': unexpected field');
  const cls = /^event: expected JSON object, got malformed JSON$/.test(v) ? 'malformed-json'
    : /^event: effect \S+ is pending;/.test(v) ? 'effect-pending'
    : /^event\.type: [A-Z][A-Z0-9_]* is not accepted at await [a-z]+;/.test(v) ? 'wrong-await'
    : v.startsWith('event.type: expected ') ? 'unknown-type'
    : unexpected ? 'unexpected-field'
    : v.includes(': expected ') ? 'invalid-value' : 'state-check';
  const split = v.indexOf(': ');
  const path = fieldPath(unexpected ? v.slice(0, -': unexpected field'.length) : split < 0 ? '' : v.slice(0, split));
  return path ? `${cls} at ${path}` : cls;
}

// SECTION: Usage

function counters(v: unknown): ModelUsage | undefined {
  if (!record(v)) return undefined;
  const input = count(v['input']), output = count(v['output']);
  if (input === undefined || output === undefined) return undefined;
  const out: ModelUsage = { input, output };
  for (const key of ['cacheRead', 'cacheWrite'] as const) {
    if (v[key] === undefined) continue;
    const n = count(v[key]);
    if (n === undefined) return undefined;
    out[key] = n;
  }
  return out;
}
function usageOf(v: unknown, subtractCache: boolean): Usage | undefined {
  const base = counters(v);
  if (!base || !record(v)) return undefined;
  const canonical = (u: ModelUsage): ModelUsage => subtractCache ? { ...u, input: Math.max(0, u.input - (u.cacheRead ?? 0)) } : u;
  const out: Usage = canonical(base);
  const models = record(v['models']) ? Object.entries(v['models']) : [];
  const parts = models.map(([name, part]) => [modelName(name), counters(part)] as const);
  if (parts.length && parts.length <= 8 && parts.every(([name, part]) => name && part)) out.models = Object.fromEntries(parts.map(([name, part]) => [name!, canonical(part!)]));
  return out;
}
/** Canonical counters: `input` excludes cache reads, so providers that count them inside input (Codex) compare equally. */
export function normalizeUsage(raw: unknown, inputSemantics: 'includes-cache' | 'uncached'): Usage | undefined {
  return usageOf(raw, inputSemantics === 'includes-cache');
}
const total = (u: ModelUsage) => u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + u.output;
const measured = (i: InvocationFacts): Usage | undefined => i.estimated ? undefined : i.usage;
const estimate = (i: InvocationFacts): number | undefined => !i.estimated ? undefined : i.tokens ?? (i.usage ? total(i.usage) : undefined);
const sum = (values: readonly (number | undefined)[]): number | undefined => values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined;
type Totals = { input: number; output: number; cacheRead?: number; cacheWrite?: number; all: number };
function totals(usages: readonly ModelUsage[]): Totals | undefined {
  if (!usages.length) return undefined;
  return { input: sum(usages.map((u) => u.input))!, output: sum(usages.map((u) => u.output))!, ...opt('cacheRead', sum(usages.map((u) => u.cacheRead))), ...opt('cacheWrite', sum(usages.map((u) => u.cacheWrite))), all: sum(usages.map(total))! };
}

// SECTION: Gates

/** Gates host retro items: ≤3, valid id, dispatch-owned component, known category, bounded locator-free text. */
export function retroObservations(value: unknown): { values: RetroObservation[]; rejected: number } {
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
  return { values, rejected };
}

function configValue(v: unknown, depth: number): unknown {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (typeof v === 'string') return modelName(v) ?? DASH;
  if (depth >= 6) return DASH;
  if (Array.isArray(v)) return v.slice(0, 16).map((item) => configValue(item, depth + 1));
  if (record(v)) return Object.fromEntries(Object.entries(v).filter(([key]) => /^[A-Za-z0-9_-]{1,40}$/.test(key) && locatorFree(key)).slice(0, 32).map(([key, item]) => [key, configValue(item, depth + 1)]));
  return DASH;
}
function invocationOf(v: unknown): InvocationFacts[] {
  if (!record(v)) return [];
  const reported = list(v['reportedModels']).map(modelName).filter((m): m is string => !!m).slice(0, 8);
  return [{
    phase: phaseKey(v['phase']) ?? '', provider: token(v['provider']) ?? DASH, model: modelName(v['model']) ?? DASH,
    ...opt('effort', v['effort'] === undefined ? undefined : token(v['effort']) ?? DASH), ...opt('mode', token(v['mode'])),
    surface: v['surface'] === 'native' ? 'native' : 'cli', launched: v['launched'] === true, ...opt('durationMs', millis(v['durationMs'])),
    outcome: token(v['outcome']) ?? DASH, ...opt('usage', usageOf(v['usage'], false)), ...opt('reportedModels', reported.length ? reported : undefined),
    ...(v['estimated'] === true ? { estimated: true } : {}), ...opt('tokens', count(v['tokens'])),
  }];
}
/** Rebuilds facts from allowlisted fields only, so resume ids, session paths, and objectives never reach the report. */
export function sanitizeFacts(run: RunFacts): RunFacts {
  const r: Record<string, unknown> = record(run) ? run : {};
  // A dispatch content hash, exempt from the long-hex locator rule; only its 12-character prefix renders.
  const build = typeof r['build'] === 'string' && /^[a-f0-9]{12,64}$/.test(r['build']) ? r['build'] : undefined;
  const config = record(r['config']) ? Object.fromEntries(CONFIG_KEYS.filter((key) => (r['config'] as Record<string, unknown>)[key] !== undefined).map((key) => [key, configValue((r['config'] as Record<string, unknown>)[key], 0)])) : undefined;
  const fault = record(r['fault']) ? r['fault'] : undefined;
  return {
    ...opt('version', match(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/)(r['version'])), ...opt('build', build?.slice(0, 12)),
    ...opt('os', token(r['os'])), ...opt('host', token(r['host'])),
    ...opt('verb', VERBS.find((v) => v === r['verb'])), ...opt('level', LEVELS.find((v) => v === r['level'])),
    ...opt('pins', match(/^[A-Za-z0-9_.,:-]{1,96}$/)(r['pins'])), ...opt('config', config), ...opt('outcome', token(r['outcome'])),
    ...opt('fault', fault && {
      ...opt('effectId', match(/^[a-z0-9-]+(?:\.[a-z0-9-]+){0,15}$/)(fault['effectId'])), cls: token(fault['cls']) ?? DASH, ...opt('hostWaitMs', millis(fault['hostWaitMs'])),
      ...opt('waitBy', (['user', 'host'] as const).find((by) => by === fault['waitBy'])), ...opt('driverMs', millis(fault['driverMs'])),
    }),
    phases: list(r['phases']).filter(record).map((p) => ({
      key: phaseKey(p['key']) ?? '', name: PHASE_NAMES.find((name) => name === p['name']) ?? DASH, ...opt('outcome', token(p['outcome'])),
      ...opt('wallMs', millis(p['wallMs'])), ...opt('driverMs', millis(p['driverMs'])), ...opt('hostMs', millis(p['hostMs'])), ...opt('userMs', millis(p['userMs'])),
    })),
    hostGaps: list(r['hostGaps']).filter(record).flatMap((g) => { const ms = millis(g['ms']); return ms === undefined ? [] : [{ await: token(g['await']) ?? DASH, ms }]; }),
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
    rejectedEvents: list(r['rejectedEvents']).filter(record).map((e) => ({ eventType: match(/^[A-Z][A-Z0-9_]{0,47}$/)(e['eventType']) ?? DASH, reason: rejectionReason(e['reason']) })),
    ...opt('repairs', count(r['repairs'])), ...opt('admissionDefects', count(r['admissionDefects'])), ...opt('orchestratorBytes', count(r['orchestratorBytes'])),
    ...opt('observations', r['observations']),
  };
}

// SECTION: Heuristics

const RANK = Object.keys(CATEGORIES);
const bySeverity = <T extends { category: Category }>(items: readonly T[]): T[] => [...items].sort((a, b) => RANK.indexOf(a.category) - RANK.indexOf(b.category));
const pct = (share: number) => `${Math.round(share * 100)}%`;
const num = (n: number | undefined) => n === undefined ? DASH : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const tally = (values: readonly string[]) => [...new Set(values)].map((v) => `${v} ×${values.filter((x) => x === v).length}`).join(', ');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const phaseName = (run: RunFacts, key: string | undefined) => run.phases.find((p) => p.key === key)?.name ?? DASH;
function groups<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

const PREFLIGHT = ['scripts/lib/doctor.ts', 'Detect this condition in the preflight check and skip the provider before launch.'] as const;
const FAILURE_FIXES: Record<string, readonly [string, string]> = {
  'model-not-found': ['scripts/policy/cascade.ts', 'Check configured model names in the preflight and cascade past unknown models before launch.'],
  'model-not-loaded': ['scripts/policy/cascade.ts', 'Cascade to the next model on the first load failure instead of relaunching the same model.'],
  quota: ['scripts/policy/cascade.ts', 'Treat the first quota failure as provider-wide and route the remaining slots to reserves without another launch.'],
  timeout: ['scripts/providers/runner.ts', 'Scale the launch timeout with level and prompt size, and resume the provider session instead of relaunching.'],
  'context-overflow': ['scripts/effects/prepare-review.ts', 'Bound prompt and attachment bytes per voice before launch so prompts fit the model context.'],
  auth: PREFLIGHT, 'cli-outdated': PREFLIGHT, 'not-found': PREFLIGHT, 'sandbox-unsupported': PREFLIGHT, config: PREFLIGHT,
};
const DEFAULT_FIX = ['scripts/providers/runner.ts', 'Classify this failure in the runner and route it through the cascade without a blind retry.'] as const;
const AWAIT_COMPONENTS: Record<string, string> = {
  author: 'references/templates/plan.md', native: 'references/providers.md', rule: 'references/review-rules.md', fix: 'references/change-handling.md',
  write: 'references/templates/write-brief-task.md', evidence: 'references/verbs/implement.md', retro: 'references/diagnostics.md',
};

/** Deterministic findings (H1–H6, H8, H9) for one run, in severity order. */
export function heuristics(run: RunFacts): Finding[] {
  const T = DIAGNOSTIC_THRESHOLDS;
  const out: Finding[] = [];
  const add = (source: string, category: Category, component: string, evidence: string, impact: string, proposedFix: string) => out.push({ source, category, component, evidence, impact, proposedFix });
  const cli = run.invocations.filter((i) => i.surface === 'cli');
  for (const [cls, items] of groups(cli.filter((i) => i.outcome !== 'ok'), (i) => i.outcome)) {
    const [component, fix] = FAILURE_FIXES[cls] ?? DEFAULT_FIX;
    const spent = sum(items.map((i) => i.durationMs));
    add('H1', 'correctness', component, `\`${cls}\`: ${items.length} of ${plural(cli.length, 'CLI attempt')} failed (${tally(items.map((i) => i.provider))})${spent === undefined ? '' : `, ${formatDuration(spent)} of driver time`}.`, 'Failed attempts delay the wave and trigger retries or cascade launches.', fix);
  }
  for (const [key, rows] of groups(run.reviews, (r) => r.phase ?? '')) {
    const rounds = Math.max(...rows.map((r) => r.round));
    const reraised = [...new Set(rows.flatMap((r) => r.reraised ?? []))];
    const escalation = rows.map((r) => r.escalation).filter((e) => e !== undefined).at(-1);
    // Rounds within the resolved cap are normal convergence; only a run without a recorded cap uses the fixed threshold.
    const cap = rows.map((r) => r.cap).filter((c) => c !== undefined).at(-1);
    const overCap = cap === undefined ? rounds >= T.reviewRounds : rounds > cap;
    if (!overCap && !reraised.length && !escalation) continue;
    const ids = (values: readonly string[]) => values.length ? ` (${values.slice(0, 5).join(', ')})` : '';
    // NOTE: a deadlock in the cap round without re-raised findings is the cap-ending refresh label, so it reports as the cap; a regression is always real.
    const capReached = cap !== undefined && (escalation?.kind === 'deadlock' ? rounds >= cap && !reraised.length : !escalation && rounds > cap);
    const detail = [
      plural(rounds, 'round'),
      ...(capReached ? [`cap reached (${cap})`] : []),
      ...(reraised.length ? [`${plural(reraised.length, 'finding')} re-raised across rounds${ids(reraised)}`] : []),
      ...(escalation && !capReached ? [`${escalation.kind} escalation${ids(escalation.ids)}`] : []),
    ];
    add('H2', 'review-convergence', 'references/review-rules.md', `${phaseName(run, key)}: ${detail.join('; ')}.`, 'Each extra round relaunches every voice and adds a host ruling turn.', capReached && !reraised.length ? 'Raise the round cap or narrow scope.' : 'Require reviewers to cite the prior ruling when they raise a finding again, and close repeats as duplicates instead of opening a new round.');
  }
  for (const r of run.reviews) {
    const all = r.accepted + r.rejected;
    if (all < T.minSamples || r.rejected / all <= T.rejectedShare) continue;
    add('H3', 'review-convergence', 'references/templates/review-prompt.md', `${phaseName(run, r.phase)} round ${r.round}: ${r.rejected} of ${plural(all, 'finding')} rejected (${pct(r.rejected / all)}).`, 'Rejected findings cost reviewer tokens and host ruling time without changing the artifact.', 'Put the governing decisions and out-of-scope items in the review prompt so reviewers do not raise settled points.');
  }
  const metered = run.invocations.filter((i) => measured(i));
  for (const [provider, items] of groups(metered, (i) => i.provider)) {
    const reporting = items.filter((i) => i.usage!.cacheRead !== undefined);
    const cacheRead = sum(reporting.map((i) => i.usage!.cacheRead)) ?? 0, input = cacheRead + (sum(reporting.map((i) => i.usage!.input)) ?? 0);
    if (!reporting.length || !input || cacheRead / input >= T.cacheReadShare) continue;
    add('H4', 'token-economy', 'scripts/domain/prompt.ts', `${provider}: cache read ${pct(cacheRead / input)} of input (${num(cacheRead)} of ${num(input)} tokens) across ${plural(reporting.length, 'invocation')}.`, 'Uncached input is billed and processed in full on every launch.', 'Put stable content (rules, templates, shared context) before per-voice and per-round content so provider prompt caches hit.');
  }
  if (metered.length >= T.minSamples) {
    const sizes = metered.map((i) => [i, total(i.usage!)] as const);
    const all = sum(sizes.map(([, n]) => n)) ?? 0;
    const [top, n] = sizes.reduce((a, b) => b[1] > a[1] ? b : a);
    // Above an even share (2/n) the largest invocation stands out; at small n, even shares already reach half.
    if (all && n / all > Math.max(T.invocationShare, 2 / metered.length)) add('H5', 'token-economy', 'scripts/effects/prepare-review.ts', `${top.provider} ${top.model} in ${phaseName(run, top.phase)}: ${num(n)} of ${num(all)} measured tokens (${pct(n / all)}).`, 'One invocation dominates token spend; its prompt or attachments likely exceed what the task needs.', 'Cap per-voice prompt and attachment bytes, and pass large context by reference so no single launch dominates.');
  }
  const gap = run.hostGaps.reduce<{ await: string; ms: number } | undefined>((a, g) => g.ms > (a?.ms ?? -1) ? g : a, undefined);
  if (gap && gap.ms > T.hostGapMs) add('H6', 'speed', AWAIT_COMPONENTS[gap.await] ?? 'SKILL.md', `Longest host turn: \`${gap.await}\` await took ${formatDuration(gap.ms)} (${plural(run.hostGaps.length, 'non-user await')}).`, 'Long host turns dominate wall time.', `Split the \`${gap.await}\` turn's work and record its sub-steps so the cost can be attributed.`);
  if (run.rejectedEvents.length) {
    const reasons = run.rejectedEvents.slice(0, 3).map((e) => `"${e.reason.length > 120 ? `${e.reason.slice(0, 119)}…` : e.reason}"`).join('; ');
    add('H8', 'correctness', 'scripts/core/validate.ts', `${plural(run.rejectedEvents.length, 'host event')} rejected (${tally(run.rejectedEvents.map((e) => e.eventType))}): ${reasons}.`, 'Each rejection costs a host turn and a resend.', 'Return the expected event shape with a minimal valid example in the rejection, and show the same example in the frame reply template.');
  }
  if (run.repairs) add('H9', 'correctness', 'references/templates/write-brief-task.md', `${plural(run.repairs, 'implementation repair attempt')}.`, 'Each repair relaunches a writer and repeats verification.', 'Put the failed check and its acceptance rule in the task brief before the first attempt.');
  if (run.admissionDefects) add('H9', 'correctness', 'scripts/effects/check-envelope.ts', `${plural(run.admissionDefects, 'admission defect')}.`, 'Each defect rejects a writer result and costs another attempt.', 'Check envelope fields deterministically and return the exact failing field so the writer fixes it in one attempt.');
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
function usageSummary(items: readonly InvocationFacts[]): string {
  const t = totals(items.flatMap((i) => measured(i) ?? []));
  return t ? `${num(t.all)} (input ${num(t.input)} · cache read ${num(t.cacheRead)} · cache write ${num(t.cacheWrite)} · output ${num(t.output)})` : DASH;
}

function overview(runs: readonly RunFacts[]): string[] {
  const lines = ['## Overview', '', row(['Run', 'Phase', 'Outcome', 'Wall', 'Driver', 'Host', 'User wait', 'Invocations', 'Input', 'Cache read', 'Cache write', 'Output', 'Coverage']), '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const notes: string[] = [];
  runs.forEach((run, index) => {
    const label = `${index + 1} · ${run.verb ?? DASH} · ${run.level ?? DASH}`;
    const line = (phase: string, outcome: string | undefined, timing: readonly (number | undefined)[], items: readonly InvocationFacts[]) =>
      lines.push(row([label, phase, outcome ?? DASH, ...timing.map(formatDuration), String(items.length), ...tokenCells(totals(items.flatMap((i) => measured(i) ?? []))), coverage(items)]));
    for (const p of run.phases) line(p.name, p.outcome, [p.wallMs, p.driverMs, p.hostMs, p.userMs], run.invocations.filter((i) => i.phase === p.key));
    const unmatched = run.invocations.some((i) => !run.phases.some((p) => p.key === i.phase));
    if (run.phases.length !== 1 || unmatched) line('all phases', run.outcome, (['wallMs', 'driverMs', 'hostMs', 'userMs'] as const).map((k) => sum(run.phases.map((p) => p[k]))), run.invocations);
    if (run.fault) notes.push(`- Run ${index + 1} fault: \`${run.fault.cls}\`${run.fault.effectId ? ` in \`${run.fault.effectId}\`` : ''}; ${run.fault.waitBy === 'user' ? 'user' : 'host'} wait ${formatDuration(run.fault.hostWaitMs)}; driver ${formatDuration(run.fault.driverMs)}.`);
  });
  if (notes.length) lines.push('', ...notes);
  lines.push('', '### Tokens by provider and model', '', row(['Provider', 'Model', 'Input', 'Cache read', 'Cache write', 'Output', 'Coverage']), '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  const items = runs.flatMap((run) => run.invocations).filter((i) => measured(i) || (i.surface === 'cli' && i.launched));
  for (const [provider, rows] of groups(items, (i) => i.provider)) {
    lines.push(row([provider, 'all models', ...tokenCells(totals(rows.flatMap((i) => measured(i) ?? []))), coverage(rows)]));
    const models = new Map<string, ModelUsage[]>();
    const attribute = (model: string, usage: ModelUsage) => models.set(model, [...(models.get(model) ?? []), usage]);
    for (const i of rows) {
      const usage = measured(i);
      if (!usage) continue;
      // Per-model counters win; a multi-model aggregate cannot be split, so its attribution is unavailable.
      if (usage.models) for (const [model, part] of Object.entries(usage.models)) attribute(model, part);
      else attribute((i.reportedModels?.length ?? 0) > 1 ? DASH : `${i.model} (configured)`, usage);
    }
    for (const [model, usages] of models) lines.push(row([provider, model, ...tokenCells(totals(usages)), DASH]));
  }
  if (!items.length) lines.push(row(Array<string>(7).fill(DASH)));
  return [...lines, ''];
}

function appendix(runs: readonly RunFacts[]): string[] {
  const lines = ['## Appendix', '', '<details>', '<summary>Invocations and configuration</summary>', '', row(['Run', 'Phase', 'Provider', 'Model', 'Effort', 'Duration', 'Input', 'Cache read', 'Cache write', 'Output', 'Total', 'Outcome']), '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  runs.forEach((run, index) => {
    for (const i of run.invocations) {
      const usage = i.usage ? totals([i.usage]) : undefined;
      const all = i.estimated ? estimate(i) : usage?.all;
      const provider = i.surface === 'native' ? `${i.provider} (native)` : i.mode && i.mode !== 'cli' ? `${i.provider} (${i.mode})` : i.provider;
      const model = i.reportedModels?.length ? `${i.model} (reported: ${i.reportedModels.join(', ')})` : i.model;
      lines.push(row([String(index + 1), phaseName(run, i.phase), provider, model, i.effort ?? DASH, formatDuration(i.durationMs), ...tokenCells(usage, i.estimated ? '~' : ''), all === undefined ? DASH : `${i.estimated ? '~' : ''}${num(all)}`, i.launched ? i.outcome : `${i.outcome} (not launched)`]));
    }
  });
  lines.push('');
  runs.forEach((run, index) => {
    lines.push(`Run ${index + 1}: verb ${run.verb ?? DASH}, level ${run.level ?? DASH}, pins ${run.pins ?? DASH}, outcome ${run.outcome ?? DASH}.`, '');
    if (run.config && Object.keys(run.config).length) lines.push('```json', JSON.stringify(run.config, null, 2), '```', '');
  });
  return [...lines, '</details>', ''];
}

/** Renders the session report from every run's facts; compaction drops the Appendix, then lower-severity findings. */
export function renderDiagnostics(input: readonly RunFacts[]): { text: string; findings: number; top?: string } {
  const runs = input.map(sanitizeFacts);
  const retro = runs.map((run) => run.observations === undefined ? undefined : retroObservations(run.observations));
  const findings = bySeverity(runs.flatMap((run, index): Finding[] => [
    ...heuristics(run).map((f) => ({ ...f, run: index + 1 })),
    ...(retro[index]?.values ?? []).map((o) => ({ source: 'retro', run: index + 1, id: o.id, category: o.category, component: o.component, evidence: o.evidence, impact: o.impact, proposedFix: o.proposedFix })),
  ]));
  const invocations = runs.flatMap((run) => run.invocations);
  const estimated = sum(invocations.map(estimate));
  const bytes = sum(runs.map((run) => run.orchestratorBytes));
  const collected = retro.filter((r) => r !== undefined);
  const head = [
    '# Dispatch diagnostics', '',
    'Review before sharing. This report holds dispatch-owned data only: no user source, objective, repository paths, or identities. Proposed fixes are unverified.', '',
    '`—` marks an unavailable value; `~` marks an estimate excluded from measured totals.', '',
    '## Summary', '',
    `- Build: ${unique(runs.map((run) => `dispatch ${run.version ?? DASH} · build ${run.build ?? DASH}`))}`,
    `- Host: ${unique(runs.map((run) => run.host ?? DASH))} · OS: ${unique(runs.map((run) => run.os ?? DASH))}`,
    `- Runs: ${runs.length} · wall time: ${formatDuration(sum(runs.flatMap((run) => run.phases.map((p) => p.wallMs))))}`,
    `- Measured tokens: ${usageSummary(invocations)} · coverage ${coverage(invocations)}`,
    `- Estimated, excluded from measured totals: native and write ${estimated === undefined ? DASH : `~${num(estimated)}`} · orchestrator ${bytes === undefined ? DASH : `~${num(Math.ceil(bytes / 4))}`}`,
    `- Host retro: ${collected.length ? `${sum(collected.map((r) => r.values.length))} accepted · ${sum(collected.map((r) => r.rejected))} rejected` : 'not collected'}`,
    '', 'Top findings:', '',
    ...(findings.length ? findings.slice(0, 3).map((f, i) => `${i + 1}. ${summaryLine(f)}`) : ['- none']), '',
    ...overview(runs),
  ];
  const findingLines = (keep: number) => {
    if (!findings.length) return ['## Findings', '', 'No findings.', ''];
    const lines = ['## Findings', ''];
    findings.slice(0, keep).forEach((f, i) => lines.push(`### ${i + 1}. ${CATEGORIES[f.category]} · \`${f.component}\``, '', `- Source: ${sourceOf(f)} · run ${f.run ?? DASH}`, `- Evidence: ${md(f.evidence)}`, `- Impact: ${md(f.impact)}`, `- Proposed fix (unverified): ${md(f.proposedFix)}`, ''));
    if (keep < findings.length) lines.push(`${plural(findings.length - keep, 'lower-severity finding')} omitted at the report size limit.`, '');
    return lines;
  };
  const tail = appendix(runs);
  const assemble = (withAppendix: boolean, keep: number) => [...head, ...findingLines(keep), ...(withAppendix ? tail : ['## Appendix', '', 'Omitted at the report size limit.', ''])].join('\n');
  const fits = (text: string) => Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes;
  let text = assemble(true, findings.length);
  if (!fits(text)) text = assemble(false, findings.length);
  for (let keep = findings.length - 1; !fits(text) && keep >= 0; keep--) text = assemble(false, keep);
  if (!fits(text)) {
    const cut = Buffer.from(text).subarray(0, DIAGNOSTIC_LIMITS.reportBytes - 256).toString();
    text = `${cut.slice(0, cut.lastIndexOf('\n'))}\n\nTruncated at the report size limit.\n`;
  }
  return { text, findings: findings.length, ...opt('top', findings[0] && summaryLine(findings[0])) };
}
