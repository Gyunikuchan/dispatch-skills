import { pricingProblems } from '../../lib/pricing.ts';
import { BANDS, boundModels, type Bands } from '../../lib/usage/bands.ts';
import { baseCounters, count as safeCount, hasUsageTokens } from '../../lib/usage/read.ts';
import { addCounters, HOST_ROLES, HOST_RESPONSE_BASES, MAX_RESPONSE_AGENTS, RESPONSE_COVERAGES, RESPONSE_STAGES, HOST_NOTES, HOST_UNAVAILABLE, splitUsageKey, STAGE_ORDER, type Counters, type HostResponseAggregate, type HostUsageFacts, type HostUsageRow } from '../../lib/usage/rows.ts';
import type { LifecycleStep } from '../../providers/types.ts';
import type { CoverageReason } from '../types.ts';
import { CATEGORIES, COMPONENTS, DASH, DIAGNOSTIC_LIMITS, PHASE_NAMES, type Category, type DelegateResponseFacts, type InvocationFacts, type ModelUsage, type RetroObservation, type ReviewFacts, type RoundWorkload, type RunFacts, type SlotYieldFacts, type Usage } from './diagnostics-types.ts';

const MAX_REVIEW_ROUND_CAP = 1000;

// SECTION: Field gates

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
const responseAgent = match(/^(?:host|subagent)-(?:[1-9]|[12][0-9]|3[0-2])$/);
const token = match(/^[a-z][a-z0-9-]{0,39}$/);
const phaseKey = match(/^[a-z0-9][a-z0-9/._-]{0,127}$/);
const modelAlias = match(/^[A-Za-z0-9][A-Za-z0-9_.:/@\[\]-]{0,95}$/);
const modelName = (v: unknown): string | undefined => { const name = modelAlias(v); return name && !/^[A-Za-z]:|\/\//.test(name) ? name : undefined; };
function isoDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : undefined;
}
const count = (v: unknown): number | undefined => safeCount(v) ? v : undefined;
const millis = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
export const opt = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

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
  return {
    ...out,
    ...(bands ? { bands } : {}),
    ...opt('turns', count(v['turns'])),
    ...opt('toolCalls', count(v['toolCalls'])),
    ...opt('toolTurns', count(v['toolTurns'])),
  };
}

function mergeModelUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  const merged: ModelUsage = addCounters({ ...a }, b);
  for (const key of ['turns', 'toolCalls', 'toolTurns'] as const) {
    if (a[key] !== undefined && b[key] !== undefined && Number.isSafeInteger(a[key]! + b[key]!)) merged[key] = a[key]! + b[key]!;
    else delete merged[key];
  }
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

export const uncached = (u: ModelUsage) => u.input + (u.cacheWrite ?? 0) + u.output;
export const measured = (i: InvocationFacts): Usage | undefined => i.surface !== 'cli' || !i.launched ? undefined : i.usage;

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

const COVERAGE_REASONS: readonly CoverageReason[] = ['no usage', 'transcript unavailable', 'invalid counters', 'unverified zero'];
function coverageOf(v: unknown): CoverageReason[] | undefined {
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v : [];
  const reasons = [...new Set(raw.flatMap((x): CoverageReason[] => {
    const mapped = x === 'no usage output' ? 'no usage' : x;
    const reason = COVERAGE_REASONS.find((candidate) => candidate === mapped);
    return reason ? [reason] : [];
  }))];
  return reasons.length ? reasons : undefined;
}

function reportedModelsOf(v: Record<string, unknown>, usage: Usage | undefined): Pick<InvocationFacts, 'reportedModels' | 'reportedModelAmbiguous'> {
  const raw = list(v['reportedModels']);
  const names = raw.slice(0, 8).map(modelName);
  const reported = [...new Set(names.filter((name): name is string => !!name))];
  const ambiguous = v['reportedModelAmbiguous'] === true || raw.length > 8 || names.some(name => name === undefined)
    || (v['reportedModels'] !== undefined && !Array.isArray(v['reportedModels']))
    || (record(v['usage']) && record(v['usage']['models']) && Object.keys(v['usage']['models']).length > 0 && !usage?.models);
  return { ...opt('reportedModels', reported.length ? reported : undefined), ...(ambiguous ? { reportedModelAmbiguous: true } : {}) };
}

function usageSourceOf(value: unknown): InvocationFacts['usageSource'] {
  return value === 'session' || value === 'stdout' ? value : undefined;
}

const delegateAgent = match(/^delegate-(?:child-)?[a-f0-9]{16}$/);

function delegateResponsesOf(value: unknown): DelegateResponseFacts[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const aliases = new Set<string>();
  const responses = value.slice(0, MAX_RESPONSE_AGENTS + 2).flatMap((item): DelegateResponseFacts[] => {
    if (!record(item)) return [];
    const {role, observed: rawObserved, uncachedInput: rawInput} = item;
    const stage = RESPONSE_STAGES.find(x => x === item['stage']);
    const basis = [...HOST_RESPONSE_BASES, 'unavailable' as const].find(x => x === item['basis']);
    const coverage = RESPONSE_COVERAGES.find(x => x === item['coverage']);
    if (!stage || !basis || !coverage || (role !== 'delegate' && role !== 'subagent')) return [];
    const agent = delegateAgent(item['agent']);
    if (item['agent'] !== undefined && (!agent || agent.startsWith('delegate-child-') !== (role === 'subagent'))) return [];
    const observed = count(rawObserved);
    const uncachedInput = count(rawInput);
    const toolCalls = count(item['toolCalls']);
    const toolTurns = count(item['toolTurns']);
    if (coverage === 'unknown' ? rawObserved !== undefined || rawInput !== undefined : observed === undefined || basis === 'unavailable') return [];
    if (coverage === 'complete' && !agent) return [];
    const key = JSON.stringify([stage, role, basis, agent]);
    if (seen.has(key) || (agent && !aliases.has(agent) && aliases.size >= MAX_RESPONSE_AGENTS)) return [];
    seen.add(key);
    if (agent) aliases.add(agent);
    return [{
      stage, role, basis, coverage, ...opt('agent', agent), ...opt('observed', observed), ...opt('uncachedInput', uncachedInput),
      ...opt('toolCalls', coverage === 'unknown' ? undefined : toolCalls),
      ...opt('toolTurns', coverage === 'unknown' ? undefined : toolTurns),
    }];
  });
  return responses.length ? responses : undefined;
}

function invocationOf(v: unknown): InvocationFacts[] {
  if (!record(v)) return [];
  const surface = v['surface'] === 'native' ? 'native' : 'cli';
  const launched = v['launched'] === true;
  const outcome = token(v['outcome']) ?? DASH;
  const usageSource = surface === 'cli' ? usageSourceOf(v['usageSource']) : undefined;
  const coverage = new Set(coverageOf(v['coverage']));
  let usage = usageOf(v['usage'], false);
  if (surface === 'cli' && launched) {
    if (!usage && v['usage'] !== undefined) coverage.add('invalid counters');
    if (usage && !usageSource && outcome !== 'ok' && !hasUsageTokens(usage)) {
      usage = undefined;
      coverage.add('unverified zero');
    }
  }
  return [{
    phase: phaseKey(v['phase']) ?? '', provider: token(v['provider']) ?? DASH, model: modelName(v['model']) ?? DASH,
    ...opt('effort', v['effort'] === undefined ? undefined : token(v['effort']) ?? DASH), ...opt('mode', token(v['mode'])),
    surface, launched, ...opt('durationMs', millis(v['durationMs'])),
    ...opt('startMs', millis(v['startMs'])), ...opt('endMs', millis(v['endMs'])),
    ...opt('routingOutcome',(['next-model','next-mode','reserve','stop'] as const).find(x=>x===v['routingOutcome'])),
    ...opt('slotState',(['done','native','failed'] as const).find(x=>x===v['slotState'])),
    ...opt('validationOutcome',token(v['validationOutcome'])),
    ...opt('nativeState',(['pending','completed','invalid','failed'] as const).find(x=>x===v['nativeState'])),
    ...opt('subject',match(/^[a-f0-9]{16}$/)(v['subject'])), ...opt('attempt',count(v['attempt'])),
    ...opt('targetSlot',match(/^[A-Za-z0-9_-]{1,40}\[\d{1,3}\]$/)(v['targetSlot'])),
    outcome, ...opt('usage', usage), ...(usage && usageSource ? { usageSource } : {}), ...reportedModelsOf(v, usage),
    ...opt('coverage', coverage.size ? [...coverage] : undefined),
    ...opt('responses', surface === 'cli' && launched ? delegateResponsesOf(v['responses']) : undefined),
    ...opt('lifecycleSteps', lifecycleOf(v['lifecycleSteps'])), ...opt('slot', match(/^[A-Za-z0-9_.-]{1,40}(?:\[\d{1,3}\])?$/)(v['slot'])),
    ...(v['superseded'] === true ? { superseded: true as const } : {}),
    ...(v['nudge'] === true ? { nudge: true as const } : {}),
    ...(v['wrapUp'] === true ? { wrapUp: true as const } : {}),
  }];
}

function hostResponsesOf(value: unknown): HostResponseAggregate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const aliases = new Set<string>();
  const keys = new Set<string>();
  return value.flatMap((item: unknown): HostResponseAggregate[] => {
    if (!record(item)) return [];
    const stage = RESPONSE_STAGES.find(x => x === item['stage']);
    const role = HOST_ROLES.find(x => x === item['role']);
    const basis = HOST_RESPONSE_BASES.find(x => x === item['basis']);
    const coverage = RESPONSE_COVERAGES.find(x => x === item['coverage']);
    if (!stage || !role || !basis || !coverage) return [];
    const agent = responseAgent(item['agent']);
    if (item['agent'] !== undefined && (!agent || !agent.startsWith(`${role}-`))) return [];
    const observed = count(item['observed']);
    const uncachedInput = count(item['uncachedInput']);
    const toolCalls = count(item['toolCalls']);
    const toolTurns = count(item['toolTurns']);
    if (coverage === 'unknown' ? observed !== undefined : observed === undefined) return [];
    if (coverage === 'complete' && !agent) return [];
    const key = `${stage}\0${role}\0${basis}\0${agent ?? ''}`;
    if (keys.has(key) || (agent && !aliases.has(agent) && aliases.size >= MAX_RESPONSE_AGENTS)) return [];
    keys.add(key);
    if (agent) aliases.add(agent);
    return [{
      stage, role, basis, coverage, ...opt('agent', agent), ...opt('observed', observed),
      ...opt('uncachedInput', observed === undefined ? undefined : uncachedInput),
      ...opt('toolCalls', observed === undefined ? undefined : toolCalls),
      ...opt('toolTurns', observed === undefined ? undefined : toolTurns),
    }];
  });
}
function hostUsageOf(value: unknown): HostUsageFacts | undefined {
  if (!record(value)) return undefined;
  const rows: HostUsageRow[] = list(value['rows']).flatMap(v => {
    if (!record(v)) return [];
    const stage=STAGE_ORDER.find(x=>x===v['stage']), role=HOST_ROLES.find(x=>x===v['role']), usage=counters(v);
    if(!stage || !role || !usage) return [];
    return [{
      stage, ...opt('phase', phaseKey(v['phase'])), role, model: modelName(v['model']) ?? DASH, effort: token(v['effort']) ?? null,
      ...usage, ...opt('maxDepth', role === 'subagent' ? count(v['maxDepth']) : undefined),
      ...(typeof v['reasoningInOutput']==='boolean'?{reasoningInOutput:v['reasoningInOutput']}:{}),
    }];
  });
  const notes: NonNullable<HostUsageFacts['notes']> = {};
  if(record(value['notes'])) for(const role of HOST_ROLES) {
    const raw=value['notes'][role]; if(!record(raw)) continue;
    const clean=Object.fromEntries(HOST_NOTES.flatMap(key=>{const n=count(raw[key]);return n===undefined?[]:[[key,n]];}));
    if(Object.keys(clean).length) notes[role]=clean;
  }
  const rawByStage = record(value['userTurnsByStage']) ? value['userTurnsByStage'] : undefined;
  const byStageEntries = rawByStage
    ? STAGE_ORDER.flatMap((stage) => {
      const n = count(rawByStage[stage]);
      return n === undefined ? [] : [[stage, n] as const];
    })
    : [];
  const userTurnsByStage = byStageEntries.length ? Object.fromEntries(byStageEntries) as HostUsageFacts['userTurnsByStage'] : undefined;
  const unavailable=HOST_UNAVAILABLE.find(x=>x===value['unavailable']);
  return {
    platform: token(value['platform']) ?? null,
    rows,
    ...opt('responses', hostResponsesOf(value['responses'])),
    ...opt('userTurns', count(value['userTurns'])),
    ...opt('userTurnsByStage', userTurnsByStage),
    ...opt('subagentCount', count(value['subagentCount'])),
    ...opt('maxSubagentDepth', count(value['maxSubagentDepth'])),
    ...opt('unavailable', unavailable),
    ...(Object.keys(notes).length ? { notes } : {}),
  };
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
    ...opt('os', token(r['os'])), ...opt('host', token(r['host'])), ...opt('hostThread', match(/^[a-f0-9]{16}$/)(r['hostThread'])),
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
        ...opt('recurring', count(v['recurring'])),
        ...opt('reraised', reraised.length ? reraised : undefined), ...opt('escalation', kind && { kind, ids: ids(escalation?.['ids']) }),
        ...opt('cap', cap !== undefined && cap <= MAX_REVIEW_ROUND_CAP ? cap : undefined),
      }];
    }),
    ...opt('roundTiming', Array.isArray(r['roundTiming']) ? r['roundTiming'].filter(record).flatMap(v => {
      const review=match(/^review-[a-f0-9]{16}$/)(v['review']), round=count(v['round']);
      if (!review || !round) return [];
      const slots=list(v['slots']).map(s => {
        const slot=record(s)?match(/^[A-Za-z0-9_.-]{1,40}(?:\[\d{1,3}\])?$/)(s['slot']):undefined;
        const attempts=slot&&record(s)?list(s['attempts']).map(a=>record(a)?({...opt('startMs',millis(a['startMs'])),...opt('endMs',millis(a['endMs'])),...opt('surface',(['cli','native'] as const).find(surface=>surface===a['surface']))}):{}):[];
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
      return [{
        review, round, ...opt('kind', kind), ...opt('hostTurns', count(v['hostTurns'])),
        ...opt('calls', total === undefined ? undefined : {total, phases}), ...opt('hostTokens', count(v['hostTokens'])),
        ...opt('reviewerTurns', count(v['reviewerTurns'])),
        ...(v['reviewerTurnsPartial'] === true ? { reviewerTurnsPartial: true as const } : {}),
      }];
    }) : undefined),
    ...opt('slotYield', Array.isArray(r['slotYield']) ? r['slotYield'].filter(record).flatMap((v): SlotYieldFacts[] => {
      const kind = (['provider', 'native', 'tool'] as const).find((name) => name === v['kind']);
      const provider = token(v['provider']);
      if (!kind || !provider) return [];
      const raised = record(v['raised']) ? v['raised'] : {};
      const attempts = Array.isArray(v['attempts']) ? v['attempts'].filter(record).map((a) => {
        const usage = usageOf(a['usage'], false);
        return {
          provider: token(a['provider']) ?? DASH,
          model: modelName(a['model']) ?? DASH,
          effort: a['effort'] === null || a['effort'] === undefined ? null : token(a['effort']) ?? DASH,
          ...opt('usage', usage), ...opt('usageSource', usage ? usageSourceOf(a['usageSource']) : undefined),
          ...reportedModelsOf(a, usage), ...opt('coverage', coverageOf(a['coverage'])),
        };
      }) : undefined;
      return [{
        kind, provider, model: kind === 'provider' ? modelName(v['model']) ?? null : null,
        raised: { MUST: count(raised['MUST']) ?? 0, SHOULD: count(raised['SHOULD']) ?? 0, CONSIDER: count(raised['CONSIDER']) ?? 0 },
        accepted: count(v['accepted']) ?? 0, rejected: count(v['rejected']) ?? 0, deferred: count(v['deferred']) ?? 0,
        duplicate: count(v['duplicate']) ?? 0, unruled: count(v['unruled']) ?? 0, ...opt('tokens', count(v['tokens'])), ...opt('fixInduced', count(v['fixInduced']) || undefined),
        measured: count(v['measured']) ?? 0, launched: count(v['launched']) ?? 0, ...opt('priorLaunches', count(v['priorLaunches']) || undefined),
        ...opt('attempts', attempts?.length ? attempts : undefined),
      }];
    }) : undefined),
    ...opt('observations', r['observations']),
  };
}
