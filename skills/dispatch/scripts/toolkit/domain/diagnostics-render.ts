import { formatCost, sumCost, type AppliedRateBasis, type Cost, type CostReason, type Pricer } from '../../lib/pricing.ts';
import { addCounters, HOST_ROLES, MAX_RESPONSE_AGENTS, STAGE_ORDER, tokenTotal, type Counters, type ResponseCoverage } from '../../lib/usage/rows.ts';
import type { CoverageReason } from '../types.ts';
import { measured, opt, retroObservations, sanitizeFacts } from './diagnostics-gates.ts';
import { bySeverity, num, pct, phaseName, plural, selectFindings, sum } from './diagnostics-heuristics.ts';
import { addYield, CATEGORIES, DASH, DIAGNOSTIC_LIMITS, type DelegateResponseFacts, type Finding, type InvocationFacts, type ModelUsage, type PhaseFacts, type RetroObservation, type RunFacts, type SlotYieldAttempt, type SlotYieldFacts, type Usage } from './diagnostics-types.ts';


const APART = new Set(['opencode', 'agy']);
const reasoningApart = (platform: string, reasoningInOutput: boolean | undefined): boolean => reasoningInOutput === undefined ? APART.has(platform) : !reasoningInOutput;
export const billedTokens = (u: Counters, platform: string, reasoningInOutput?: boolean): number => tokenTotal(u) + (reasoningApart(platform, reasoningInOutput) ? u.reasoning ?? 0 : 0);

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

/** `1h 4m 12s` | `45s` | `<1s`; unavailable renders `—`. */

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export function heuristics(run: RunFacts): Finding[] {
  return selectFindings(run, formatDuration);
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
const midOf = (c: Cost) => (c.low + c.high) / 2;
const allDefinedSum = (values: readonly (number | undefined)[]): number | undefined => values.length && values.every((v) => v !== undefined) ? values.reduce<number>((a, v) => a + v!, 0) : undefined;
const toolCell = (calls: number | undefined, turns: number | undefined) => calls === undefined || turns === undefined ? DASH : `${num(calls)} (${num(turns)})`;
const hasAnyToken = (u: ModelUsage) => u.input > 0 || u.output > 0 || (u.cacheWrite ?? 0) > 0 || (u.reasoning ?? 0) > 0;
const cacheHitOf = (units: readonly { usage?: ModelUsage | undefined }[], scopePartial = false): string => {
  const reporting = units.filter((u) => u.usage?.cacheRead !== undefined);
  if (!reporting.length) return DASH;
  const inp = reporting.reduce((n, u) => n + u.usage!.input, 0);
  const cr = reporting.reduce((n, u) => n + (u.usage!.cacheRead ?? 0), 0);
  const cw = reporting.reduce((n, u) => n + (u.usage!.cacheWrite ?? 0), 0);
  const d = inp + cr + cw;
  if (d === 0) return DASH;
  const missing = scopePartial || units.some((u) => !u.usage || (u.usage.cacheRead === undefined && hasAnyToken(u.usage)));
  return `${pct(cr / d)}${missing ? ' (partial)' : ''}`;
};

function shareBar(percent: number | null): string {
  if (percent === null) return DASH;
  const filled = percent >= 1 ? Math.min(10, Math.max(1, Math.round(percent / 10))) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${percent}%`;
}

function coverage(items: readonly InvocationFacts[]): string {
  const launched = items.filter((i) => i.surface === 'cli' && i.launched);
  return launched.length ? `${launched.filter((i) => measured(i)).length}/${launched.length}` : DASH;
}

const usageSamples = (items: readonly InvocationFacts[]): UsageSample[] => items.flatMap((i) => {
  const usage = measured(i);
  return usage ? [{ usage, platform: i.provider, reasoningInOutput: usage.reasoningInOutput }] : [];
});

// Cost units: one host row, one `model#effort` entry of a launched CLI invocation, or one invocation without usage. Rollups sum unit costs.
type Unit = { platform: string; phase?: string; stage: string; role: string; model: string; effort: string; configured: boolean; usage?: ModelUsage; reasoningInOutput?: boolean; coverage?: readonly CoverageReason[]; usageSource?: InvocationFacts['usageSource']; cost: Cost | undefined; row: boolean };
type TurnRow = { platform: string; stage: string; role: string; usage?: ModelUsage; reasoningInOutput?: boolean; cost: Cost | undefined; limited?: boolean };

function priceUnit(pricer: Pricer | undefined, platform: string, model: string, usage: ModelUsage | undefined, inOutput: boolean | undefined, onDate: string | undefined): Cost | undefined {
  if (!pricer) return undefined;
  if (usage && model !== DASH) return pricer.price(model, usage, !reasoningApart(platform, inOutput), onDate);
  return { low: 0, high: 0, priced: false, reasons: new Set<CostReason>([usage ? 'unpriced model' : 'no usage']) };
}

const stageForPhase = (run: RunFacts, phaseKey: string | undefined) => {
  const phase = run.phases.find(p => p.key === phaseKey)?.name;
  return phase === 'integration review' ? 'code review' : STAGE_ORDER.find(x => x === phase) ?? DASH;
};

const isSessionDelegate = (i: { usageSource?: InvocationFacts['usageSource'] | undefined; coverage?: readonly CoverageReason[] | undefined }) =>
  i.usageSource !== 'stdout' && !i.coverage?.includes('transcript unavailable');

function delegateFallbackUsage(i: { usage?: Usage | undefined; usageSource?: InvocationFacts['usageSource'] | undefined; coverage?: readonly CoverageReason[] | undefined; responses?: readonly DelegateResponseFacts[] | undefined }): ModelUsage | undefined {
  if (!i.usage) return undefined;
  if (i.usageSource === 'stdout') {
    const { turns: _t, toolCalls: _c, toolTurns: _tt, ...rest } = i.usage;
    return rest;
  }
  if (i.usage.turns !== undefined || !isSessionDelegate(i) || !i.responses?.length) return i.usage;
  const delegates = i.responses.filter(r => r.role === 'delegate');
  if (!delegates.length || !delegates.every(r => r.coverage === 'complete' && r.observed !== undefined)) return i.usage;
  return {
    ...i.usage,
    turns: delegates.reduce((n, r) => n + r.observed!, 0),
    ...opt('toolCalls', allDefinedSum(delegates.map(r => r.toolCalls))),
    ...opt('toolTurns', allDefinedSum(delegates.map(r => r.toolTurns))),
  };
}

function invocationUnits(
  i: Omit<SlotYieldAttempt, 'effort' | 'usage'> & { effort?: string | null | undefined; usage?: Usage | undefined; responses?: readonly DelegateResponseFacts[] },
  stage: string,
  phase: string | undefined,
  pricer: Pricer | undefined,
  onDate: string | undefined,
): Unit[] {
  const out: Unit[] = [];
  const usage = i.usage, effort = i.effort ?? DASH;
  const unit = (model: string, effortName: string, part: ModelUsage | undefined, configured = false): Unit => {
    const cleanPart = part && i.usageSource === 'stdout' ? (() => { const { turns: _t, toolCalls: _c, toolTurns: _tt, ...rest } = part; return rest; })() : part;
    return {
      platform: i.provider, ...opt('phase', phase), stage, role: 'delegate', model, effort: effortName, configured,
      ...(cleanPart ? { usage: cleanPart } : {}), ...(usage?.reasoningInOutput === undefined ? {} : { reasoningInOutput: usage.reasoningInOutput }),
      ...opt('coverage', i.coverage), ...opt('usageSource', i.usageSource), row: true,
      cost: priceUnit(pricer, i.provider, configured ? model.slice(model.lastIndexOf('/') + 1) : model, cleanPart, usage?.reasoningInOutput, onDate),
    };
  };
  if (usage?.models) {
    for (const [key, part] of Object.entries(usage.models)) {
      const at = key.indexOf('#');
      out.push(unit(at < 0 ? key : key.slice(0, at) || DASH, at < 0 ? effort : key.slice(at + 1) || DASH, part));
    }
  } else {
    const reported = i.reportedModels ?? [];
    const ambiguous = i.reportedModelAmbiguous || reported.length > 1;
    const observed = reported[0];
    out.push(unit(ambiguous ? DASH : observed ?? i.model, effort, delegateFallbackUsage(i), !ambiguous && observed === undefined));
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
    out.push(...invocationUnits({ ...i, usage: measured(i) }, stageForPhase(run, i.phase), i.phase, pricer, run.startedAt));
  }
  return out;
}

/** Unified turn rows across host, subagents, delegates, and delegate-child responses without duplicating cost/tokens. */
function turnRowsOf(run: RunFacts, units: readonly Unit[]): TurnRow[] {
  const out: TurnRow[] = units.map((u) => ({
    platform: u.platform, stage: u.stage, role: u.role,
    ...(u.usage ? { usage: u.usage } : {}),
    ...(u.reasoningInOutput === undefined ? {} : { reasoningInOutput: u.reasoningInOutput }),
    cost: u.cost,
  }));
  for (const i of run.invocations) {
    if (i.surface !== 'cli' || !i.launched || !i.responses?.length) continue;
    const stage = stageForPhase(run, i.phase);
    for (const r of i.responses) {
      if (r.role !== 'subagent') continue;
      const codexLimited = r.basis === 'codex-token-count' && r.observed !== undefined && isSessionDelegate(i);
      const turns = r.coverage === 'complete' || codexLimited ? r.observed : undefined;
      out.push({
        platform: i.provider, stage, role: 'subagent', cost: undefined,
        usage: {
          input: 0, output: 0,
          ...opt('turns', turns),
          ...opt('toolCalls', turns === undefined ? undefined : r.toolCalls),
          ...opt('toolTurns', turns === undefined ? undefined : r.toolTurns),
        },
        ...(codexLimited ? { limited: true } : {}),
      });
    }
  }
  return out;
}

const costsOf = (units: readonly { cost?: Cost | undefined }[]) => units.flatMap(u => u.cost ?? []);
const costText = (units: readonly { cost?: Cost | undefined }[]) => formatCost(sumCost(costsOf(units)));
const ROLE_LABELS = { host: 'Host', subagent: 'Subagents', delegate: 'CLI delegates' } as const;
const USAGE_SOURCES = ['session', 'stdout', 'stdout fallback', 'legacy source unknown', 'unmeasured'] as const;
type UsageEvidence = {
  usage?: ModelUsage | undefined;
  usageSource?: InvocationFacts['usageSource'];
  coverage?: readonly CoverageReason[];
};

function sourceOfUsage(item: UsageEvidence): typeof USAGE_SOURCES[number] {
  if (!item.usage) return 'unmeasured';
  if (item.usageSource === 'stdout' && item.coverage?.includes('transcript unavailable')) return 'stdout fallback';
  return item.usageSource ?? 'legacy source unknown';
}

function sourcesOf(items: readonly UsageEvidence[]) {
  const counts = { session: 0, stdout: 0, 'stdout fallback': 0, 'legacy source unknown': 0, unmeasured: 0 };
  for (const item of items) counts[sourceOfUsage(item)]++;
  return counts;
}

function sourceCountsText(counts: ReturnType<typeof sourcesOf>) {
  return USAGE_SOURCES.flatMap(source => counts[source] ? [`${num(counts[source])} ${source}`] : []);
}

function basesOf(units: readonly Unit[]): AppliedRateBasis[] {
  return units.flatMap(u => u.cost?.rateBasis ?? []);
}

// Inputs are sanitized by the report or by sessionFacts before comparison.
export function costCoverage(runs: readonly RunFacts[], pricer: Pricer | undefined, units = runs.flatMap(run => unitsOf(run, pricer))) {
  const costs = costsOf(units), total = sumCost(costs);
  const delegates = runs.flatMap(run => run.invocations.filter(i => i.surface === 'cli' && i.launched));
  const sources = sourcesOf(delegates);
  const delegateReasons = [...new Set(delegates.flatMap(i => i.coverage ?? []))].sort();
  const otherHostThreads = runs.some(run => (run.hosts?.length ? run.hosts : run.host ? [run.host] : [])
    .some(host => host !== run.hostUsage?.platform));
  const priced = costs.filter(c => c.priced).length;
  const reasons = new Set<string>(total.reasons);
  let partial = !pricer || priced < costs.length;
  if (!pricer) reasons.add('rate table unavailable');
  if (total.low < total.high) reasons.add('bounded cost range');
  if (runs.some(run => (run.collection?.partial ?? 0) > 0)) { partial = true; reasons.add('captures partial'); }
  const roles = (Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]).map(role => {
    const own = units.filter(u => u.role === role);
    const observed = own.filter(u => u.usage);
    const cost = sumCost(costsOf(own));
    const tokens = observed.length ? observed.reduce((n, u) => n + billedTokens(u.usage!, u.platform, u.reasoningInOutput), 0) : null;
    const gaps = new Set<string>();
    if (role === 'delegate') {
      if (sources.unmeasured) gaps.add('delegate usage unavailable');
      if (sources['legacy source unknown']) gaps.add('delegate legacy source unknown');
      if (sources['stdout fallback']) gaps.add('delegate stdout fallback');
      for (const reason of delegateReasons) gaps.add(`delegate coverage: ${reason}`);
    } else {
      if (runs.some(run => (role === 'host' && run.hostUsage?.unavailable) || !run.hostUsage?.rows.some(row => row.role === role))) {
        gaps.add(role === 'host' ? 'host usage unavailable' : 'subagent usage unavailable');
      }
      if (role === 'host' && otherHostThreads) gaps.add('other host threads unmeasured');
      if (role === 'subagent' && observed.length) gaps.add('total subagent coverage unknown');
      for (const run of runs) for (const note of Object.keys(run.hostUsage?.notes?.[role] ?? {})) gaps.add(note);
    }
    if (gaps.size) partial = true;
    for (const gap of gaps) reasons.add(gap);
    const coverage = role === 'delegate' ? [...sourceCountsText(sources), ...delegateReasons] : [...gaps];
    const unpriced = own.filter(u => u.usage && u.cost && !u.cost.priced).length;
    if (unpriced) coverage.push(`${plural(unpriced, 'observed unit')} unpriced`);
    if (role !== 'delegate' && observed.length) coverage.unshift(`${num(observed.length)} observed rows`);
    if (role === 'host') {
      const unavailable = [...new Set(runs.flatMap(run => run.hostUsage?.unavailable ?? []))].sort();
      coverage.push(...unavailable);
    }
    return { role, tokens, cost, coverage };
  });
  const bases = basesOf(units);
  const days = [...new Set(bases.map(b => b.effectiveDay))].sort();
  const origins = [...new Set(bases.map(b => b.origin))].sort();
  const matches = [...new Set(bases.map(b => b.match))].sort();
  const periods = [...new Set(bases.map(b => b.periodFrom))].sort();
  const originCounts = { shipped: 0, override: 0 };
  const matchCounts = { qualified: 0, wildcard: 0, generic: 0 };
  for (const basis of bases) { originCounts[basis.origin]++; matchCounts[basis.match]++; }
  const rateBasis = { tableAsOf: pricer?.meta.asOf ?? null, effectiveDay: days.length === 1 ? days[0]! : null,
    effectiveDays: days, origins, matches, periods, originCounts, matchCounts };
  return { total, priced, unpriced: costs.length - priced, coverage: { partial, reasons: [...reasons].sort(), sources }, rateBasis, roles };
}

function rateNotes(units: readonly Unit[]): string[] {
  const notes = new Set<string>();
  for (const { cost } of units) {
    const basis = cost?.rateBasis;
    if (basis && (basis.origin === 'override' || basis.match !== 'generic')) {
      notes.add(`${basis.origin} ${basis.match} rate (${basis.effectiveDay ?? 'base fallback'})`);
    }
  }
  const labels = [...notes].sort();
  return labels.length > 8 ? [...labels.slice(0, 8), `${labels.length - 8} more rate bases`] : labels;
}

function liftedRateNote(units: readonly Unit[]): string | undefined {
  const days = [...new Set(units.flatMap(u => {
    const b = u.cost?.rateBasis;
    return b && b.origin === 'shipped' && b.match === 'generic' ? [b.effectiveDay ?? 'base fallback'] : [];
  }))].sort();
  if (!days.length) return undefined;
  return `Rate note: shipped generic rate (${days.length > 4 ? `${days.length} days` : days.join(', ')}).`;
}

function knownSourceNotes(units: readonly Unit[]) {
  return [...new Set(units.flatMap(u => u.usageSource ? [sourceOfUsage(u)] : []))].sort();
}

function largestRemainder(exact: readonly number[]): number[] {
  // Largest remainder: floor each part, then give the residual points to the largest fractions.
  const parts = exact.map(Math.floor), order = exact.map((_, k) => k).sort((x, y) => (exact[y]! - parts[y]!) - (exact[x]! - parts[x]!) || x - y);
  for (let left = 100 - parts.reduce((n, s) => n + s, 0), k = 0; left > 0; left--, k++) parts[order[k % order.length]!]!++;
  return parts;
}

function computeShares<T extends { cost: Cost; tokens: number; hasUsage: boolean }>(groups: readonly T[]): (number | null)[] {
  const hasPriced = groups.some(g => g.cost.priced);
  const total = hasPriced ? groups.filter(g => g.cost.priced).reduce((n, g) => n + midOf(g.cost), 0) : groups.reduce((n, g) => n + g.tokens, 0);
  if (total === 0) return groups.map(() => null);
  const shareable = groups.map((g, i) => (hasPriced ? g.cost.priced : g.hasUsage) ? i : -1).filter(i => i >= 0);
  const parts = largestRemainder(shareable.map(i => ((hasPriced ? midOf(groups[i]!.cost) : groups[i]!.tokens) / total) * 100));
  const out: (number | null)[] = groups.map(() => null);
  shareable.forEach((gi, idx) => { out[gi] = parts[idx]!; });
  return out;
}

/** Ranked `## Cost drivers` section (up to 5 stage/platform/role/model/effort groups plus remainder). */
function costDrivers(units: readonly Unit[]): string[] {
  type DriverGroup = { key: string; stage: string; platform: string; role: string; model: string; effort: string; configured: boolean; units: Unit[]; tokens: number };
  const map = new Map<string, DriverGroup>();
  for (const u of units) {
    if (!u.row) continue;
    const key = [u.stage, u.platform, u.role, u.model, u.effort, String(u.configured)].join('\0');
    const g = map.get(key) ?? { key, stage: u.stage, platform: u.platform, role: u.role, model: u.model, effort: u.effort, configured: u.configured, units: [], tokens: 0 };
    g.configured ||= u.configured; g.units.push(u);
    if (u.usage) g.tokens += billedTokens(u.usage, u.platform, u.reasoningInOutput);
    map.set(key, g);
  }
  const all = [...map.values()].map(g => { const cost = sumCost(g.units.flatMap(u => u.cost ?? [])); return { ...g, cost, mid: cost.priced ? midOf(cost) : 0, hasUsage: g.units.some(u => u.usage) }; });
  const hasPriced = all.some(g => g.cost.priced);
  const totalTokens = all.reduce((n, g) => n + g.tokens, 0);
  if (!hasPriced && totalTokens === 0) return ['## Cost drivers', '', 'No priced cost or billed tokens.', ''];
  const byTokens = (a: (typeof all)[number], b: (typeof all)[number]) => b.tokens - a.tokens || a.key.localeCompare(b.key);
  const ordered = hasPriced
    ? [...all.filter(g => g.cost.priced).sort((a, b) => b.mid - a.mid || byTokens(a, b)), ...all.filter(g => !g.cost.priced).sort(byTokens)]
    : [...all].sort(byTokens);
  const listed = ordered.slice(0, 5), rest = ordered.slice(5);
  const display = [...listed];
  if (rest.length > 0) {
    const restUnpriced = hasPriced ? rest.filter(g => !g.cost.priced).length : 0;
    const label = restUnpriced ? `${rest.length} more (${restUnpriced} unpriced)` : `${rest.length} more`;
    display.push({
      key: '\xff', stage: label, platform: DASH, role: DASH, model: DASH, effort: DASH, configured: false,
      units: rest.flatMap(g => g.units), tokens: rest.reduce((n, g) => n + g.tokens, 0),
      cost: sumCost(rest.flatMap(g => g.units.flatMap(u => u.cost ?? []))), mid: 0, hasUsage: rest.some(g => g.hasUsage),
    });
  }
  const shares = computeShares(display);
  const evidence = (own: readonly Unit[]) => [...knownSourceNotes(own), ...rateNotes(own)].join(', ') || DASH;
  const rows = display.map((g, idx) => row([
    g.stage, g.platform, g.role, g.model === DASH ? DASH : g.configured ? `${g.model} (configured)` : g.model, g.effort,
    formatCost(g.cost), shareBar(shares[idx] ?? null), g.hasUsage ? num(g.tokens) : DASH,
    cacheHitOf(g.units), num(allDefinedSum(g.units.map(u => u.usage?.turns))), evidence(g.units),
  ]));
  const note = liftedRateNote(units);
  return ['## Cost drivers', '', row(['Stage', 'Platform', 'Role', 'Model', 'Effort', 'Cost', 'Share', 'Billed tokens', 'Cache hit', 'LLM turns', 'Evidence']), '| --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | --- |', ...rows, ...(note ? ['', note] : []), ''];
}

// SECTION: Folding

type ResponseEvidence = Omit<DelegateResponseFacts, 'role'> & { role: 'host' | 'subagent' | 'delegate' };

function responseEvidence(runs: readonly RunFacts[]): ResponseEvidence[] {
  const rows: ResponseEvidence[] = [];
  const unknownScopes = new Set<string>();
  const unknown = (role: ResponseEvidence['role'], stage: ResponseEvidence['stage'] = 'unattributed') => {
    const scope = role + '|' + stage;
    if (unknownScopes.has(scope)) return;
    unknownScopes.add(scope);
    rows.push({ role, stage, basis: 'unavailable', coverage: 'unknown' });
  };
  for (const [index, run] of runs.entries()) {
    const aliases = new Map<string, string>();
    const register = ({ agent, ...entry }: ResponseEvidence): ResponseEvidence => {
      if (!agent) return entry;
      let label = aliases.get(agent);
      if (!label && aliases.size < MAX_RESPONSE_AGENTS) {
        label = (agent.startsWith('delegate-child-') ? 'delegate-child' : entry.role) + '-' + (aliases.size + 1);
        aliases.set(agent, label);
      }
      return label ? { ...entry, agent: runs.length > 1 ? `run ${index + 1} ${label}` : label }
        : { ...entry, coverage: entry.coverage === 'complete' ? 'partial' : entry.coverage };
    };
    const host = run.hostUsage?.responses ?? [];
    rows.push(...host.map(register));
    if (!host.some(entry => entry.role === 'host') || Object.keys(run.hostUsage?.notes?.host ?? {}).length) unknown('host');
    if (!host.some(entry => entry.role === 'subagent') || Object.keys(run.hostUsage?.notes?.subagent ?? {}).length) unknown('subagent');
    const phaseNames = new Map(run.phases.map(phase => [phase.key, phase.name]));
    for (const invocation of run.invocations) {
      if (invocation.surface !== 'cli' || !invocation.launched) continue;
      const phase = phaseNames.get(invocation.phase);
      const stage = phase === 'integration review' ? 'code review' : STAGE_ORDER.find(stage => stage === phase) ?? 'unattributed';
      if (invocation.responses?.length) rows.push(...invocation.responses.map(register));
      else unknown('delegate', stage);
    }
    if ((run.collection?.partial ?? 0) > 0) unknown('delegate');
  }
  return rows;
}

function responseTotals(rows: readonly ResponseEvidence[]) {
  const observed = sum(rows.map(entry => entry.observed)) ?? null;
  const matched = rows.filter(entry => entry.observed !== undefined && entry.uncachedInput !== undefined && (entry.observed > 0 || entry.uncachedInput === 0));
  const matchedObserved = sum(matched.map(entry => entry.observed)) ?? null;
  const matchedUncachedInput = sum(matched.map(entry => entry.uncachedInput)) ?? null;
  const toolCalls = allDefinedSum(rows.map(entry => entry.toolCalls)) ?? null;
  const toolTurns = allDefinedSum(rows.map(entry => entry.toolTurns)) ?? null;
  const coverage: ResponseCoverage = observed === null ? 'unknown'
    : rows.every(entry => entry.coverage === 'complete' && entry.observed !== undefined) ? 'complete' : 'partial';
  return {
    observed, matchedObserved, matchedUncachedInput, coverage, toolCalls, toolTurns,
    uncachedInputPerResponse: matchedObserved && matchedUncachedInput !== null ? matchedUncachedInput / matchedObserved : null,
  };
}

function groupResponses(rows: readonly ResponseEvidence[], agentDetail: boolean) {
  const groups = new Map<string, ResponseEvidence[]>();
  for (const entry of rows) {
    const key = [entry.stage, entry.role, entry.basis, agentDetail ? entry.agent ?? 'Unnamed or folded' : ''].join('|');
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [stage, role, basis, agent] = key.split('|') as [string, string, string, string];
    return { stage, role, basis, ...(agent ? { agent } : {}), ...responseTotals(entries) };
  });
}

const failureCauses = new Set([
  'quota', 'context-overflow', 'auth', 'model-not-found', 'cli-outdated', 'model-not-loaded', 'sandbox-unsupported',
  'not-found', 'timeout', 'buffer', 'empty-output', 'capacity', 'refusal', 'no-report', 'blocked',
  'truncated', 'integrity', 'config',
]);

function recoveryOf(runs: readonly RunFacts[], pricer?: Pricer) {
  const groups = new Map<string, { units: Unit[]; count: number }>();
  const wasteUnits: Unit[] = [];
  let extraLaunches = 0, reworkLaunches = 0, nudges = 0, wrapUps = 0;
  const writerRelaunches = sum(runs.map(run => run.relaunches)) ?? null;
  for (const run of runs) {
    const previous = new Map<string, InvocationFacts>();
    for (const attempt of run.invocations) {
      if (attempt.surface !== 'cli') continue;
      const slot = attempt.targetSlot ?? attempt.slot;
      const key = slot ? (attempt.subject ?? attempt.phase) + '|' + slot : undefined;
      const prior = key ? previous.get(key) : undefined;
      if (key) previous.set(key, attempt);
      if (!attempt.launched) continue;
      if (attempt.nudge === true) nudges++;
      if (attempt.wrapUp === true) wrapUps++;
      let cause: string | undefined;
      if (attempt.superseded) {
        reworkLaunches++;
        cause = 'superseded generation';
      } else if (prior || attempt.targetSlot) {
        extraLaunches++;
        const outcome = prior?.outcome === 'ok' ? prior.validationOutcome : prior?.outcome;
        cause = outcome && failureCauses.has(outcome) ? outcome
          : prior?.validationOutcome && prior.validationOutcome !== 'ok' ? 'validation'
          : attempt.targetSlot ? 'reserve or fallback' : 'unknown cause';
      } else if (attempt.nudge === true) cause = 'nudge';
      else if (attempt.wrapUp === true) cause = 'wrap-up';
      if (!cause) continue;
      const units = invocationUnits({ ...attempt, usage: measured(attempt) }, 'unattributed', attempt.phase, pricer, run.startedAt);
      wasteUnits.push(...units);
      const group = groups.get(cause) ?? { units: [], count: 0 };
      group.count++;
      group.units.push(...units);
      groups.set(cause, group);
    }
  }
  const byCause = Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cause, group]) => {
    const costs = costsOf(group.units), cost = sumCost(costs);
    const partial = group.units.some(unit => unit.coverage?.length || !unit.cost?.priced);
    return [cause, { count: group.count, cost: cost.priced ? { low: cost.low, high: cost.high, partial } : null }];
  }));
  const coverage = runs.some(run => (run.collection?.partial ?? 0) > 0) ? 'partial'
    : runs.some(run => run.invocations.some(attempt => attempt.surface === 'cli' && attempt.launched)) ? 'observed' : 'unknown';
  const allUnits = runs.flatMap(run => unitsOf(run, pricer));
  const totalCost = sumCost(costsOf(allUnits));
  const wasteSum = sumCost(costsOf(wasteUnits));
  const denomPartial = costCoverage(runs, pricer, allUnits).coverage.partial;
  const wastePartial = wasteUnits.some(u => u.coverage?.length || !u.cost?.priced) || denomPartial;
  const wasteCost = coverage === 'unknown' ? null : wasteUnits.length === 0 ? { low: 0, high: 0, partial: false }
    : wasteSum.priced ? { low: wasteSum.low, high: wasteSum.high, partial: wasteUnits.some(u => u.coverage?.length || !u.cost?.priced) } : null;
  const wasteShare = wasteCost && totalCost.priced && midOf(totalCost) > 0 ? midOf({ ...wasteCost, priced: true, reasons: new Set() }) / midOf(totalCost) : null;
  return {
    extraLaunches: coverage === 'unknown' ? null : extraLaunches,
    reworkLaunches: coverage === 'unknown' ? null : reworkLaunches,
    nudges: coverage === 'unknown' ? null : nudges,
    wrapUps: coverage === 'unknown' ? null : wrapUps,
    writerRelaunches, coverage, byCause, wasteCost, wasteShare, wastePartial,
  };
}

function criticalPathOf(runs: readonly RunFacts[]) {
  return runs.flatMap(run => (run.roundTiming ?? []).map(({ review, round, slots }) => {
    let first = Infinity, last = -Infinity, finishingSlot: string | null = null;
    for (const { slot, attempts } of slots) {
      if (slot === DASH) return { review, round, elapsedMs: null, finishingSlot: null };
      for (const { surface, startMs, endMs } of attempts) {
        if (surface === 'native') continue;
        if (surface !== 'cli' || startMs === undefined || endMs === undefined || endMs < startMs) {
          return { review, round, elapsedMs: null, finishingSlot: null };
        }
        first = Math.min(first, startMs);
        if (endMs > last) {
          last = endMs;
          finishingSlot = slot;
        }
      }
    }
    return { review, round, elapsedMs: finishingSlot === null ? null : last - first, finishingSlot };
  }));
}

/** Efficiency from sanitized observations. Ratios use only events with paired input. */
export function efficiencyOf(runs: readonly RunFacts[], pricer?: Pricer) {
  const responses = responseEvidence(runs);
  const { observed, matchedObserved, coverage, matchedUncachedInput, uncachedInputPerResponse } = responseTotals(responses);
  const rounds = runs.flatMap(run => run.reviews);
  const recurring = rounds.length && rounds.every(round => round.recurring !== undefined)
    ? sum(rounds.map(round => round.recurring)) ?? null : null;
  return {
    responseEvents: { observed, matchedObserved, coverage, byStageRole: groupResponses(responses, false) },
    matchedUncachedInput, uncachedInputPerResponse,
    responses,
    recovery: recoveryOf(runs, pricer),
    criticalPath: criticalPathOf(runs),
    reviewOutcomes: rounds.length ? {
      rounds: rounds.length, accepted: sum(rounds.map(round => round.accepted)), rejected: sum(rounds.map(round => round.rejected)), recurring,
    } : null,
  };
}

type Fold = { responses?: number; timing?: number; workload?: number; health?: number; yield?: number; stage?: number; phase?: number; platform?: number };
type Foldable = { units: readonly Unit[]; tokens: number; key: string };
const FOLD_ORDER = ['responses', 'timing', 'workload', 'phase', 'stage', 'platform', 'health', 'yield'] as const;

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

const observedNumber = (n: number | null) => n === null ? DASH : num(n);
const responseCells = (entry: ReturnType<typeof responseTotals>) => [
  observedNumber(entry.observed), entry.coverage === 'unknown' ? 'unavailable' : entry.coverage,
  observedNumber(entry.matchedObserved), observedNumber(entry.matchedUncachedInput),
  entry.uncachedInputPerResponse === null ? DASH : entry.uncachedInputPerResponse.toFixed(2),
  toolCell(entry.toolCalls ?? undefined, entry.toolTurns ?? undefined),
];

function buildSections(
  runs: readonly RunFacts[],
  efficiency: ReturnType<typeof efficiencyOf>,
  grounding: readonly (RetroObservation & { run: number })[],
  runUnits: readonly (readonly Unit[])[],
  metadataLines: readonly string[],
  pricer?: Pricer,
): {
  reviewHealth: (fold: Fold) => string[];
  groundingLines: () => string[];
  tier2Cost: (fold: Fold) => string[];
  tier2Efficiency: (fold: Fold) => string[];
  tier2Execution: (fold: Fold) => string[];
  counts: Record<(typeof FOLD_ORDER)[number], number>;
} {
  const singleRun = runs.length === 1;
  const allUnits = runUnits.flat();
  const overviewPhase = (p: PhaseFacts) => {
    if (/^review-[a-f0-9]{16}$/.test(p.key)) return `${p.name} · subject ${p.key.slice(7)}`;
    return p.key === p.name || p.key === p.name.replace(/ /g, '-') ? p.name : `${p.name} · ${p.key}`;
  };
  const notes: string[] = [];
  const phaseRows: PhaseRow[] = [];
  runs.forEach((run, index) => {
    const label = `${index + 1} · ${run.verb ?? DASH} · ${run.level ?? DASH}`, units = runUnits[index]!;
    const mkRow = (phase: string, outcome: string | undefined, timing: readonly (number | undefined)[], items: readonly InvocationFacts[], own: readonly Unit[], key?: string): PhaseRow =>
      ({ label, phase, ...opt('outcome', outcome), timing, items, units: own, tokens: totals(usageSamples(items))?.all ?? 0, key: `${index}\0${key ?? ''}`, pinned: key === undefined });
    phaseRows.push(...run.phases.map(p => mkRow(overviewPhase(p), p.outcome, [p.wallMs, p.driverMs, p.hostMs, p.userMs], run.invocations.filter(i => i.phase === p.key), units.filter(u => u.phase === p.key), p.key)));
    const known = (phase: string | undefined) => run.phases.some((p) => p.key === phase);
    const unmatched = run.invocations.filter((i) => !known(i.phase)), before = units.filter(u => !known(u.phase));
    if (before.length) phaseRows.push(mkRow('unattributed phase', undefined, [undefined, undefined, undefined, undefined], unmatched, before));
    if (run.phases.length !== 1 || unmatched.length || before.length) phaseRows.push(mkRow('all phases', run.outcome, (['wallMs', 'driverMs', 'hostMs', 'userMs'] as const).map((k) => sum(run.phases.map((p) => p[k]))), run.invocations, units));
    if (run.fault) notes.push(`- Run ${index + 1} fault: \`${run.fault.cls}\`${run.fault.effectId ? ` in \`${run.fault.effectId}\`` : ''}; ${run.fault.waitBy === 'user' ? 'user' : 'host'} wait ${formatDuration(run.fault.hostWaitMs)}; driver ${formatDuration(run.fault.driverMs)}.`);
  });
  const TIMING_COLS = ['Wall', 'Driver', 'Host', 'User wait'] as const;
  const showTiming = TIMING_COLS.map((_, idx) => phaseRows.some((r) => r.timing[idx] !== undefined));
  const mergePhases = (rest: PhaseRow[]): PhaseRow => ({ label: DASH, phase: smaller(rest), timing: [0, 1, 2, 3].map((k) => sum(rest.map((r) => r.timing[k]))), items: rest.flatMap((r) => r.items), units: rest.flatMap((r) => r.units), tokens: 0, key: '', pinned: false });

  type TokenRow = { stage: string; platform: string; role: string; model: string; effort: string; configured: boolean; samples: UsageSample[]; measured: number; launched: number; coverageReasons: Set<CoverageReason>; costNotes: Set<string>; units: Unit[]; tokens: number; key: string; coverage?: string };
  const rows = new Map<string, TokenRow>();
  for (const u of allUnits) {
    if (!u.row) continue;
    const key = [u.stage, u.platform, u.role, u.model, u.effort, String(u.configured)].join('\0');
    const entry = rows.get(key) ?? { stage: u.stage, platform: u.platform, role: u.role, model: u.model, effort: u.effort, configured: u.configured, samples: [], measured: 0, launched: 0, coverageReasons: new Set<CoverageReason>(), costNotes: new Set<string>(), units: [], tokens: 0, key };
    entry.configured ||= u.configured; entry.launched++; entry.units.push(u);
    if (u.usage) { entry.measured++; entry.samples.push({ usage: u.usage, platform: u.platform, reasoningInOutput: u.reasoningInOutput }); entry.tokens += billedTokens(u.usage, u.platform, u.reasoningInOutput); }
    for (const reason of u.coverage ?? []) entry.coverageReasons.add(reason);
    for (const reason of u.cost?.reasons ?? []) entry.costNotes.add(reason);
    rows.set(key, entry);
  }
  const sorted = [...rows.values()].sort((a, b) => (STAGE_ORDER.indexOf(a.stage as never) < 0 ? 99 : STAGE_ORDER.indexOf(a.stage as never)) - (STAGE_ORDER.indexOf(b.stage as never) < 0 ? 99 : STAGE_ORDER.indexOf(b.stage as never)) || a.platform.localeCompare(b.platform) || ['host', 'subagent', 'delegate'].indexOf(a.role) - ['host', 'subagent', 'delegate'].indexOf(b.role) || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort));
  const platforms = new Set([...sorted.map(r => r.platform), ...runs.flatMap(r => r.hostUsage ? [r.hostUsage.platform ?? DASH] : []), ...allUnits.map(u => u.platform)]);
  const cells = (samples: UsageSample[]) => { const t = totals(samples); return [...tokenCells(t), t?.reasoning === undefined ? DASH : num(t.reasoning)]; };
  const coverageRow = (r: TokenRow) => [r.coverage ?? (r.role === 'delegate' ? `${r.measured}/${r.launched}${r.coverageReasons.size ? ' ' + [...r.coverageReasons].join(', ') : ''}` : DASH), ...knownSourceNotes(r.units)].join(' · ');
  const costNotesRow = (r: TokenRow) => [...r.costNotes, ...rateNotes(r.units)].join(', ') || DASH;
  type PlatformRow = Foldable & { platform: string; samples: UsageSample[]; segments: string[]; costNotes: string[] };
  const platformRows: PlatformRow[] = [];
  for (const platform of [...platforms].sort()) {
    const selected = sorted.filter(r => r.platform === platform), hosts = runs.flatMap(r => r.hostUsage && (r.hostUsage.platform ?? DASH) === platform ? [r.hostUsage] : []);
    const segments: string[] = [];
    for (const role of HOST_ROLES) {
      const roleRows = selected.filter(r => r.role === role), roleNotes = hosts.flatMap(h => Object.entries(h.notes?.[role] ?? {}));
      const aggregated = new Map<string, number>(); for (const [key, n] of roleNotes) aggregated.set(key, (aggregated.get(key) ?? 0) + n);
      const noteText = aggregated.size ? ' (' + [...aggregated].map(([key, n]) => `${key} ${n}`).join(', ') + ')' : '';
      if (role === 'host' && hosts.length) { const reasons = [...new Set(hosts.flatMap(h => h.unavailable ? [h.unavailable] : []))]; if (roleRows.length) segments.push('host measured' + noteText); if (reasons.length) segments.push(`host unavailable: ${reasons.join(', ')}` + (roleRows.length ? '' : noteText)); else if (!roleRows.length) segments.push('host unavailable: no usage records' + noteText); }
      if (role === 'subagent' && (roleRows.length || aggregated.size)) segments.push((roleRows.length ? 'subagents measured' : 'subagents not measured') + noteText);
    }
    const delegates = runs.flatMap(r => r.invocations).filter(i => i.provider === platform && i.surface === 'cli' && i.launched); if (delegates.length) { const reasons = [...new Set(delegates.flatMap(i => i.coverage ?? []))]; segments.push(`delegates ${delegates.filter(i => measured(i)).length}/${delegates.length}${reasons.length ? ' ' + reasons.join(', ') : ''}`); }
    const mine = allUnits.filter(u => u.platform === platform), costNotes = [...new Set(mine.flatMap(u => [...(u.cost?.reasons ?? [])]))];
    const samples = selected.flatMap(r => r.samples);
    platformRows.push({ platform, samples, segments, costNotes, units: mine, tokens: samples.reduce((n, s) => n + billedTokens(s.usage, s.platform, s.reasoningInOutput), 0), key: platform });
  }
  const mergePlatforms = (rest: PlatformRow[]): PlatformRow => ({ platform: smaller(rest), samples: rest.flatMap(r => r.samples), segments: [...new Set(rest.flatMap(r => r.segments))], costNotes: [...new Set(rest.flatMap(r => r.costNotes))], units: rest.flatMap(r => r.units), tokens: 0, key: '' });
  const mergeStages = (rest: TokenRow[]): TokenRow => {
    const delegates = rest.filter(r => r.role === 'delegate'), covReasons = [...new Set(rest.flatMap(r => [...r.coverageReasons]))].join(', ');
    return { stage: smaller(rest), platform: DASH, role: DASH, model: DASH, effort: DASH, configured: false, samples: rest.flatMap(r => r.samples), measured: 0, launched: 0, coverageReasons: new Set(), costNotes: new Set(rest.flatMap(r => [...r.costNotes])), units: rest.flatMap(r => r.units), tokens: 0, key: '', coverage: delegates.length ? `${delegates.reduce((n, r) => n + r.measured, 0)}/${delegates.reduce((n, r) => n + r.launched, 0)}${covReasons ? ' ' + covReasons : ''}` : covReasons || DASH };
  };

  // Review health data
  const yields = new Map<string, SlotYieldFacts>();
  const yieldUnits = new Map<string, Unit[]>();
  for (const run of runs) for (const yRow of run.slotYield ?? []) {
    const key = [yRow.kind, yRow.provider, yRow.model ?? ''].join('\0');
    const units = (yRow.attempts ?? []).flatMap((a) => invocationUnits(a, 'code review', undefined, pricer, run.startedAt));
    if (units.length) yieldUnits.set(key, [...(yieldUnits.get(key) ?? []), ...units]);
    const current = yields.get(key);
    if (!current) { yields.set(key, { ...yRow, raised: { ...yRow.raised }, ...(yRow.attempts ? { attempts: [...yRow.attempts] } : {}) }); continue; }
    addYield(current, yRow);
  }
  const yieldRows = [...yields.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.provider.localeCompare(b.provider) || (a.model ?? '').localeCompare(b.model ?? ''));
  const showFixInduced = yieldRows.some((entry) => (entry.fixInduced ?? 0) > 0);
  const yieldLines = yieldRows.map((entry) => {
    const key = [entry.kind, entry.provider, entry.model ?? ''].join('\0');
    const units = yieldUnits.get(key) ?? [];
    const totalCost = sumCost(units.flatMap((u) => u.cost ?? []));
    const partial = entry.measured < entry.launched || units.some(u => u.coverage?.length) ? ' partial' : '';
    const costPartial = partial || (units.some(u => u.cost && !u.cost.priced) ? ' partial' : '');
    const costCell = `${formatCost(totalCost)}${totalCost.priced ? costPartial : ''}`;
    const costPerAccepted = entry.accepted === 0 ? '0 accepted' : !totalCost.priced ? DASH : `${formatCost({ ...totalCost, low: totalCost.low / entry.accepted, high: totalCost.high / entry.accepted })}${costPartial}`;
    const models = [...new Set(units.filter(u => u.usage && u.model !== DASH && !u.configured).map(u => u.model))];
    const costNotes = [...totalCost.reasons, ...rateNotes(units), ...knownSourceNotes(units),
      ...(models.length && models.some(m => m !== entry.model) ? [`reported: ${models.join(', ')}`] : []),
      ...(entry.priorLaunches ? [`${entry.priorLaunches} prior-generation launches excluded`] : []),
    ].join(', ') || DASH;
    const model = entry.kind === 'native' ? 'native' : entry.kind === 'tool' ? DASH : entry.model ?? DASH;
    const msc = `${entry.raised.MUST}/${entry.raised.SHOULD}/${entry.raised.CONSIDER}`;
    return row([entry.provider, model, msc, ...(showFixInduced ? [String(entry.fixInduced ?? 0)] : []),
      String(entry.accepted), String(entry.rejected), String(entry.duplicate), costCell, costPerAccepted, costNotes]);
  });

  const timing = runs.flatMap(run => run.roundTiming ?? []);
  const workload = runs.flatMap(run => run.roundWorkload ?? []);
  const reviews = runs.flatMap(run => run.reviews);
  const hasReviewHealth = reviews.length > 0 || timing.length > 0 || workload.length > 0 || yieldRows.length > 0;

  const healthRows: string[] = [];
  const reviewKeys = new Set<string>();
  const roundEntries: { run: number; review: string; round: number; totalRounds: number; spanText: string; hostTurns?: number; revTurns?: number; revPartial: boolean; accepted?: number; rejected?: number; recurring?: number }[] = [];
  runs.forEach((run, runIndex) => {
    const rReviews = run.reviews, rTiming = run.roundTiming ?? [], rWorkload = run.roundWorkload ?? [], rCrit = criticalPathOf([run]);
    for (const rk of new Set([...rReviews.map(r => r.phase ?? DASH), ...rTiming.map(t => t.review), ...rWorkload.map(w => w.review)])) {
      reviewKeys.add(`${runIndex}\0${rk}`);
      const rList = rReviews.filter(r => (r.phase ?? DASH) === rk), wList = rWorkload.filter(w => w.review === rk), tList = rTiming.filter(t => t.review === rk), cList = rCrit.filter(c => c.review === rk);
      const roundNums = [...new Set([...rList.map(r => r.round), ...wList.map(w => w.round), ...tList.map(t => t.round), ...cList.map(c => c.round)])].sort((a, b) => a - b);
      const totalRounds = Math.max(...roundNums);
      for (const rn of roundNums) {
        const rev = rList.find(r => r.round === rn), wl = wList.find(w => w.round === rn), tm = tList.find(t => t.round === rn), cp = cList.find(c => c.round === rn);
        const hasNativeUntimed = tm?.slots.some(s => s.attempts.some(a => a.surface === 'native')) ?? false;
        const spanText = cp?.elapsedMs === null || cp?.elapsedMs === undefined ? DASH : `${formatDuration(cp.elapsedMs)}${hasNativeUntimed ? ' (CLI only)' : ''}`;
        roundEntries.push({
          run: runIndex + 1, review: /^review-[a-f0-9]{16}$/.test(rk) ? `subject ${rk.slice(7)}` : phaseName(run, rk),
          round: rn, totalRounds, spanText,
          ...opt('hostTurns', wl?.hostTurns), ...opt('revTurns', wl?.reviewerTurns), revPartial: Boolean(wl?.reviewerTurnsPartial),
          ...opt('accepted', rev?.accepted), ...opt('rejected', rev?.rejected), ...opt('recurring', rev?.recurring),
        });
      }
    }
  });
  for (const e of roundEntries) {
    healthRows.push(row([
      ...(singleRun ? [] : [String(e.run)]), e.review, `${e.round}/${e.totalRounds}`, e.spanText,
      e.hostTurns === undefined ? DASH : num(e.hostTurns),
      e.revTurns === undefined ? DASH : `${num(e.revTurns)}${e.revPartial ? ' partial' : ''}`,
      e.accepted === undefined ? DASH : num(e.accepted),
      e.rejected === undefined ? DASH : num(e.rejected),
      e.recurring === undefined ? DASH : num(e.recurring),
    ]));
  }
  const aggTurns = (vals: readonly (number | undefined)[], forcePartial = false) => {
    const total = sum(vals);
    if (total === undefined) return DASH;
    return `${num(total)}${forcePartial || vals.some(v => v === undefined) ? ' partial' : ''}`;
  };
  const reviewHealth = (fold: Fold): string[] => {
    if (!hasReviewHealth) return [];
    const out: string[] = ['## Review health', ''];
    if (roundEntries.length) {
      const kept = healthRows.slice(0, fold.health);
      out.push(
        `- ${plural(reviewKeys.size, 'review')} · ${plural(roundEntries.length, 'round')} · Host turns ${aggTurns(roundEntries.map(e => e.hostTurns))} · Reviewer turns ${aggTurns(roundEntries.map(e => e.revTurns), roundEntries.some(e => e.revPartial))}`,
        '',
        row([...(singleRun ? [] : ['Run']), 'Review', 'Round', 'Wall span', 'Host turns', 'Reviewer turns', 'Accepted', 'Rejected', 'Recurring']),
        '| ' + (singleRun ? '' : '--- | ') + '--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...kept,
        ...(fold.health !== undefined && fold.health < healthRows.length ? ['', `${healthRows.length - fold.health} review round rows omitted.`] : []),
        '',
      );
    }
    if (yieldRows.length) {
      const kept = yieldLines.slice(0, fold.yield);
      out.push('### Responder yield', '',
        row(['Provider', 'Model', 'M/S/C', ...(showFixInduced ? ['Fix-induced'] : []), 'Accepted', 'Rejected', 'Dup', 'Cost', 'Cost / accepted', 'Notes']),
        '| --- | --- | --- |' + (showFixInduced ? ' ---: |' : '') + ' ---: | ---: | ---: | ---: | ---: | --- |',
        ...kept,
        ...(fold.yield !== undefined && fold.yield < yieldLines.length ? ['', `${yieldLines.length - fold.yield} yield rows omitted.`] : []),
        '');
    }
    return out;
  };
  const groundingLines = (): string[] => {
    if (!grounding.length) return [];
    const out = ['### Grounding', '', row([...(singleRun ? [] : ['Run']), 'Phase', 'Evidence', 'Assessment', 'Proposed change']),
      '| ' + (singleRun ? '' : '--- | ') + '--- | --- | --- | --- |'];
    for (const g of grounding) out.push(row([...(singleRun ? [] : [String(g.run)]), g.id.slice('grounding-'.length), g.evidence, g.impact, g.proposedFix]));
    return [...out, ''];
  };

  const responseAgentRows = groupResponses(efficiency.responses, true);
  const tier2Cost = (fold: Fold): string[] => [
    '<details>', '', '<summary>Cost & token breakdown (platform, stage, model, and metadata)</summary>', '',
    ...metadataLines, '',
    '### Tokens by platform', '',
    row(['Platform', 'Uncached input', 'Cache read', 'Cache write', 'Output', 'Reasoning', 'Coverage', 'Cost notes', 'Cost']),
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |',
    ...(platforms.size ? foldTable(platformRows, fold.platform, mergePlatforms).map(r => row([r.platform, ...cells(r.samples), [...r.segments, ...knownSourceNotes(r.units)].join(' · ') || DASH, [...r.costNotes, ...rateNotes(r.units)].join(', ') || DASH, costText(r.units)])) : [row(Array<string>(9).fill(DASH))]),
    '', '### Tokens by stage', '', 'Host/subagent stages are time-derived; delegates recorded.', '',
    row(['Stage', 'Platform', 'Role', 'Model', 'Effort', 'Uncached input', 'Cache read', 'Cache write', 'Output', 'Reasoning', 'Coverage', 'Cost notes', 'Cost']),
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |',
    ...(sorted.length ? foldTable(sorted, fold.stage, mergeStages).map(entry => row([entry.stage, entry.platform, entry.role, entry.model === DASH ? DASH : entry.configured ? `${entry.model} (configured)` : entry.model, entry.effort, ...cells(entry.samples), coverageRow(entry), costNotesRow(entry), costText(entry.units)])) : [row(Array<string>(13).fill(DASH))]),
    '', '</details>', '',
  ];

  const tier2Efficiency = (fold: Fold): string[] => {
    const { responseEvents, recovery } = efficiency;
    const kept = responseAgentRows.slice(0, fold.responses);
    const showRecovery = fold.responses === undefined || fold.responses > 0;
    return [
      '<details>', '', '<summary>Turn & context efficiency (by stage, role, and agent)</summary>', '',
      ...(showRecovery ? [
        `- CLI recovery: ${recovery.coverage}`,
        ...Object.entries(recovery.byCause).map(([cause, { count, cost }]) =>
          `  - ${cause} · ${count} launches · ${cost ? formatCost({ ...cost, priced: true, reasons: new Set() }) + (cost.partial ? ' (partial)' : '') : DASH}`),
        '',
      ] : []),
      '### Context efficiency by stage and role', '',
      row(['Stage', 'Role', 'Event basis', 'Observed turns', 'Coverage', 'Matched turns', 'Matched uncached input', 'Uncached input / turn', 'Tool calls (tool turns)']),
      '| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |',
      ...responseEvents.byStageRole.map(entry => row([entry.stage, entry.role, entry.basis, ...responseCells(entry)])),
      '', '### Turns & context efficiency by agent', '',
      row(['Stage', 'Role', 'Agent', 'Event basis', 'Observed turns', 'Coverage', 'Matched turns', 'Matched uncached input', 'Uncached input / turn', 'Tool calls (tool turns)']),
      '| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |',
      ...kept.map(entry => row([entry.stage, entry.role, entry.agent ?? DASH, entry.basis, ...responseCells(entry)])),
      ...(kept.length < responseAgentRows.length ? ['', `${responseAgentRows.length - kept.length} response detail rows omitted. Stage totals include them.`] : []),
      '', '</details>', '',
    ];
  };

  const tier2Execution = (fold: Fold): string[] => {
    const out: string[] = ['<details>', '', '<summary>Execution & review detail (phases, per-slot timing, and workload)</summary>', '', '### Phases', '',
      row([...(singleRun ? [] : ['Run']), 'Phase', 'Outcome', ...TIMING_COLS.filter((_, idx) => showTiming[idx]), 'Invocations', 'Input', 'Cache read', 'Cache write', 'Output', 'Coverage', 'Cost']),
      row([...(singleRun ? [] : ['---']), '---', '---', ...showTiming.filter(Boolean).map(() => '---:'), '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
      ...foldTable(phaseRows, fold.phase, mergePhases, (r) => r.pinned).map((r) => row([...(singleRun ? [] : [r.label]), r.phase, r.outcome ?? DASH, ...r.timing.filter((_, idx) => showTiming[idx]).map(formatDuration), String(r.items.length), ...tokenCells(totals(usageSamples(r.items))), coverage(r.items), costText(r.units)])),
      ...(notes.length ? ['', ...notes] : []), ''];
    if (timing.length) {
      const kept = timing.slice(0, fold.timing ?? timing.length);
      out.push('### Review round timing', '', row(['Review', 'Round', 'Slot', 'Wall', 'Critical path']), '| --- | ---: | --- | ---: | --- |');
      for (const round of kept) {
        const spans = round.slots.map(slot => {
          if (!slot.attempts.length || slot.attempts.some(a => a.startMs === undefined || a.endMs === undefined || a.endMs < a.startMs)) return undefined;
          return { start: Math.min(...slot.attempts.map(a => a.startMs!)), end: Math.max(...slot.attempts.map(a => a.endMs!)) };
        });
        const latest = spans.every(Boolean) ? spans.findIndex(s => s!.end === Math.max(...spans.map(x => x!.end))) : -1;
        round.slots.forEach((slot, i) => out.push(row(['subject ' + round.review.slice(7), String(round.round), slot.slot, formatDuration(spans[i] && spans[i]!.end - spans[i]!.start), i === latest ? '✓' : DASH])));
      }
      if (kept.length < timing.length) out.push('', `${timing.length - kept.length} review timing rounds omitted`);
      out.push('');
    }
    if (workload.length) {
      const storageFailed = sum(runs.map((run) => run.collection?.storageFailed)) ?? 0;
      const eligible = workload.filter(round => round.kind === 'plan' || round.kind === 'design');
      const over = eligible.filter(round => (round.calls?.total ?? 0) > 6 || (round.hostTurns ?? 0) > 25);
      out.push('### Review round workload', '', row(['Review', 'Round', 'Toolkit calls', 'Host tokens', 'Host turns', 'Reviewer turns']), '| --- | ---: | --- | ---: | ---: | ---: |',
        ...workload.slice(0, fold.workload).map((round) => row(['subject ' + round.review.slice(7), String(round.round),
          round.calls ? `${num(round.calls.total)}${round.calls.phases.length ? ': ' + round.calls.phases.map((p) => `${p.key} ${num(p.count)}`).join(' · ') : ''}` : DASH,
          round.calls && round.hostTokens !== undefined ? num(round.hostTokens) : DASH,
          round.hostTurns === undefined ? DASH : num(round.hostTurns),
          round.reviewerTurns === undefined ? DASH : `${num(round.reviewerTurns)}${round.reviewerTurnsPartial ? ' partial' : ''}`])),
        '', 'Observed toolkit calls only (`report`, `diagnostics`, and outside-window work excluded).',
        ...(fold.workload !== undefined && fold.workload < workload.length ? [`${workload.length - fold.workload} workload rows omitted.`] : []),
        ...(eligible.length ? ['Advisory budget (lightweight fix review): <=6 toolkit calls, <=25 host turns; over: ' + ((fold.workload === undefined ? over.map(round => 'subject ' + round.review.slice(7) + ' round ' + round.round).join(', ') : (over.length ? plural(over.length, 'round') : '')) || 'none')] : []),
        ...(storageFailed ? [`${plural(storageFailed, 'capture storage failure')}: calls from failed updates may be missing from the counts above.`] : []),
        '');
    }
    return [...out, '</details>', ''];
  };

  return {
    reviewHealth, groundingLines, tier2Cost, tier2Efficiency, tier2Execution,
    counts: { responses: responseAgentRows.length, timing: timing.length, workload: workload.length, health: healthRows.length, yield: yieldLines.length, stage: sorted.length, phase: phaseRows.filter((r) => !r.pinned).length, platform: platformRows.length },
  };
}

function appendix(runs: readonly RunFacts[]): string[] {
  const singleRun = runs.length === 1;
  const lines = ['<details>', '', '<summary>Invocations, provenance, and configuration</summary>', '',
    row([...(singleRun ? [] : ['Run']), 'Phase', 'Provider', 'Model', 'Effort', 'Duration', 'Input', 'Cache read', 'Cache write', 'Output', 'Reasoning', 'Total', 'Outcome']),
    '| ' + (singleRun ? '' : '--- | ') + '--- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  runs.forEach((run, index) => {
    for (const i of run.invocations) {
      const usage = i.usage ? totals([{ usage: i.usage, platform: i.provider, reasoningInOutput: i.usage.reasoningInOutput }]) : undefined;
      const all = usage?.all;
      const apart = usage ? usage.all - usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0) - usage.output : 0;
      const reasoningCell = usage?.reasoning === undefined ? DASH : apart > 0 ? num(apart) : `${num(usage.reasoning)} (in output)`;
      const provider = i.surface === 'native' ? `${i.provider} (native)` : i.mode && i.mode !== 'cli' ? `${i.provider} (${i.mode})` : i.provider;
      const reportedDiffers = i.reportedModels?.length && !(i.reportedModels.length === 1 && i.reportedModels[0] === i.model);
      const model = reportedDiffers ? `${i.model} (reported: ${i.reportedModels!.join(', ')})` : i.model;
      const review = /^review-[a-f0-9]{16}$/.test(i.phase);
      const ordinal = i.attempt !== undefined && i.attempt > 0 ? i.attempt : undefined;
      const identity = i.subject ? (review ? ` · attempt ${i.subject}/${ordinal ?? DASH}` : ` · subject ${i.subject} · attempt ${ordinal ?? DASH}`) : ordinal === undefined ? '' : ` · attempt ${ordinal}`;
      lines.push(row([...(singleRun ? [] : [String(index + 1)]), phaseName(run, i.phase) + identity + (i.slot ? ' · slot ' + i.slot : ''), provider, model, i.effort ?? DASH, formatDuration(i.durationMs), ...tokenCells(usage), reasoningCell, all === undefined ? DASH : num(all), i.surface === 'native' ? `native ${i.nativeState ?? (i.outcome === 'ok' ? 'completed' : i.outcome === 'native-pending' ? 'pending' : 'unavailable')}` : `${i.outcome}${i.nudge === true ? ' · nudge' : ''}${i.wrapUp === true ? ' · wrapUp' : ''}${i.validationOutcome ? ' · validation ' + i.validationOutcome : ''}${i.routingOutcome ? ' · routing ' + i.routingOutcome : ''}${i.slotState ? ' · slot ' + i.slotState : ''}${i.lifecycleSteps?.length ? ' · lifecycle ' + i.lifecycleSteps.map(s => `${s.step} ${s.outcome} ${s.elapsedMs}/${s.budgetMs} ms`).join(', ') : ''}${i.launched ? '' : ' (not launched)'}`]));
    }
  });
  lines.push('');
  runs.forEach((run, index) => {
    lines.push(`Run ${index + 1}: ${run.verb ?? DASH} · ${run.level ?? DASH} · pins ${run.pins ?? DASH} · ${run.outcome ?? DASH}.`, '');
    for (const snapshot of run.provenance ?? [{ version: run.version, build: run.build, config: run.config }]) {
      if (!snapshot.version && !snapshot.build && !snapshot.config) lines.push('Provenance: unknown historical implementation and configuration.', '');
      lines.push(`Provenance: dispatch ${snapshot.version ?? DASH} · build ${snapshot.build ?? DASH}.`, '');
      if (snapshot.config && Object.keys(snapshot.config).length) lines.push('```json', JSON.stringify(snapshot.config, null, 2), '```', '');
    }
  });
  return [...lines, '</details>', ''];
}

/** Renders the session report from every run's facts; compaction drops the Appendix, then lower-severity findings, then folds Tier-2 details before Tier-1 yield. */

export function renderDiagnostics(input: readonly RunFacts[], pricer?: Pricer): { text: string; findings: number; top?: string } {
  const runs = input.map(sanitizeFacts);
  const retro = runs.map((run) => run.observations === undefined ? undefined : retroObservations(run.observations));
  const isGrounding = (o: RetroObservation) => o.id.startsWith('grounding-');
  const grounding = runs.flatMap((_, index) => (retro[index]?.values ?? []).filter(isGrounding).map((o) => ({ ...o, run: index + 1 })));
  const findings = bySeverity(runs.flatMap((run, index): Finding[] => [
    ...heuristics(run).map((f) => ({ ...f, run: index + 1 })),
    ...(retro[index]?.values ?? []).filter((o) => !isGrounding(o)).map((o) => ({ source: 'retro', run: index + 1, id: o.id, category: o.category, component: o.component, evidence: o.evidence, impact: o.impact, proposedFix: o.proposedFix })),
  ]));
  const runUnits = runs.map(run => unitsOf(run, pricer));
  const allUnits = runUnits.flat();
  const allTurnRows = runs.flatMap((run, idx) => turnRowsOf(run, runUnits[idx]!));
  const { total, priced, unpriced, coverage: scope, rateBasis, roles } = costCoverage(runs, pricer, allUnits);
  const collected = retro.filter((r) => r !== undefined);
  const hosts = [...new Set(runs.flatMap((run) => run.hosts?.length ? run.hosts : run.host ? [run.host] : []))];
  const measuredPlatforms = [...new Set(runs.flatMap(run => {
    const host = run.hostUsage;
    return host?.platform && host.rows.some(r => r.role === 'host') ? [host.platform] : [];
  }))];
  const hostScope = hosts.length > 1
    ? ` · ${measuredPlatforms.length ? `host rows measure the ${measuredPlatforms.join(', ')} thread; other hosts' threads are unmeasured` : 'no host thread is measured'}`
    : '';
  const days = rateBasis.effectiveDays;
  const dayText = days.length > 8 ? `${days.length} rate days or base-rate fallbacks` : days.map(day => day ?? 'base-rate fallback').join(', ') || DASH;
  const collectionPartial = runs.some(r => Object.entries(r.collection ?? {}).some(([key, n]) => key !== 'completed' && n > 0));
  const collectionState = collectionPartial ? 'partial' : runs.some(r => (r.collection?.completed ?? 0) > 0) ? 'complete for observed captures' : 'unknown';
  const retroStates = unique(runs.map((run, index) => run.retroState ?? retro[index]?.state ?? 'missing'));
  const metadataLines = [
    `- Build: ${unique(runs.flatMap(run => (run.provenance ?? [{ version: run.version, build: run.build }]).map(p => `dispatch ${p.version ?? DASH} · build ${p.build ?? DASH}`)))}`,
    `- Host: ${hosts.join(', ') || DASH}${hostScope} · OS: ${unique(runs.map((run) => run.os ?? DASH))}`,
    ...(pricer ? [`- Rate basis: table ${rateBasis.tableAsOf} · UTC day ${dayText} · ${rateBasis.originCounts.shipped} shipped, ${rateBasis.originCounts.override} override · ${rateBasis.matchCounts.qualified} qualified, ${rateBasis.matchCounts.wildcard} wildcard, ${rateBasis.matchCounts.generic} generic`] : []),
    ...(runs.some(run => run.timingScope === 'tool-calls') ? [`- Timing scope: summed tool-call durations (overlap possible); host reasoning, user wait, ${runs.some(run => run.hostUsage?.rows.length) ? 'native/writer timing' : 'native/writer usage'}, pre-enablement work unavailable.`] : []),
    runs.some(run => run.hostUsage?.rows.length) ? '- Full conversation totals: host/subagent cover current host thread in window; other threads, full collection, and storage loss are unobservable.' : '- Full conversation totals unavailable: CLI launches only; full collection and storage loss are unobservable.',
    `- Host retro: ${retroStates} · ${sum(collected.map(r => r.values.length)) ?? 0} accepted · ${sum(collected.map(r => r.rejected)) ?? 0} rejected`,
    `- Collection health: ${collectionState} · corrupt ${num(sum(runs.map(r => r.collection?.corrupt)))} · unreadable ${num(sum(runs.map(r => r.collection?.unreadable)))} · incomplete ${num(sum(runs.map(r => r.collection?.incomplete)))} · storage-failed ${num(sum(runs.map(r => r.collection?.storageFailed)))}`,
  ];

  const efficiency = efficiencyOf(runs, pricer);
  const { recovery } = efficiency;
  const hasCompleteHost = (r: RunFacts) => Boolean(r.hostUsage && !r.hostUsage.unavailable && !Object.keys(r.hostUsage.notes?.host ?? {}).length && r.hostUsage.rows.some(row => row.role === 'host'));
  const hasCompleteSubagents = (r: RunFacts) => !Object.keys(r.hostUsage?.notes?.subagent ?? {}).length;
  const hasCompleteUser = (r: RunFacts) => Boolean(r.hostUsage && !r.hostUsage.unavailable && !Object.keys(r.hostUsage.notes?.host ?? {}).length && r.hostUsage.userTurns !== undefined);
  const hostTurnsComplete = runs.every(hasCompleteHost) && runs.every(hasCompleteSubagents);
  const qualify = (text: string, isPartial: boolean, isLimited: boolean) => text === DASH ? DASH : `${text}${isPartial || isLimited ? ` (${[isPartial ? 'partial' : '', isLimited ? 'limited' : ''].filter(Boolean).join(', ')})` : ''}`;
  const userTurnsTotal = allDefinedSum(runs.map(r => hasCompleteUser(r) ? r.hostUsage!.userTurns : undefined));
  const llmTurnsTotal = allDefinedSum(allTurnRows.map(r => r.usage?.turns));
  const toolCallsTotal = allDefinedSum(allTurnRows.map(r => r.usage?.toolCalls));
  const toolTurnsTotal = allDefinedSum(allTurnRows.map(r => r.usage?.toolTurns));
  const summaryLimited = allTurnRows.some(r => r.limited);
  const allHaveCollection = runs.every(r => r.collection?.completed !== undefined && r.collection?.incomplete !== undefined);
  const sessionActions = allHaveCollection ? sum(runs.map(r => (r.collection!.completed ?? 0) + (r.collection!.incomplete ?? 0))) : undefined;
  const workloadCalls = runs.flatMap(r => r.roundWorkload ?? []).flatMap(w => w.calls ? [w.calls.total] : []);
  const toolkitCallsText = allHaveCollection
    ? `Captured toolkit calls ${num(sessionActions)}${collectionPartial ? ' (partial)' : ''} (excl. report/diagnostics)`
    : workloadCalls.length ? `Review-window toolkit calls ${num(sum(workloadCalls))} (excl. report/diagnostics)` : `Captured toolkit calls ${DASH}`;
  const subagentCountTotal = allDefinedSum(runs.map(r => r.hostUsage?.subagentCount));
  const maxSubagentDepthVals = runs.map(r => r.hostUsage?.maxSubagentDepth);
  const maxSubagentDepthTotal = maxSubagentDepthVals.length && maxSubagentDepthVals.every(v => v !== undefined) ? Math.max(...maxSubagentDepthVals as number[]) : undefined;
  const wasteCostText = recovery.wasteCost ? `${formatCost({ ...recovery.wasteCost, priced: true, reasons: new Set() })}${recovery.wasteCost.partial ? ' (partial)' : ''}` : DASH;
  const wasteShareText = recovery.wasteShare === null ? DASH : `${pct(recovery.wasteShare)}${recovery.wastePartial ? ' (partial)' : ''}`;

  const warnings: string[] = [];
  if (!pricer) warnings.push('- Rate warning: rate table unavailable');
  if (rateBasis.originCounts.override > 0) warnings.push(`- Rate warning: ${plural(rateBasis.originCounts.override, 'override rate')} applied`);
  if (scope.partial) warnings.push(`- Coverage warning: partial (${scope.reasons.join(', ')})`);
  if (hosts.length > 1 || runs.some(r => r.hostUsage?.unavailable)) warnings.push(`- Host warning: ${hosts.join(', ') || DASH}${hostScope}`);
  if (collectionPartial) warnings.push(`- Collection warning: partial · corrupt ${num(sum(runs.map(r => r.collection?.corrupt)))} · unreadable ${num(sum(runs.map(r => r.collection?.unreadable)))} · incomplete ${num(sum(runs.map(r => r.collection?.incomplete)))} · storage-failed ${num(sum(runs.map(r => r.collection?.storageFailed)))}`);
  if (runs.some((r, i) => ['invalid', 'malformed', 'unreadable'].includes(r.retroState ?? retro[i]?.state ?? ''))) warnings.push(`- Retro warning: ${retroStates}`);

  // Role table (reconciles Summary & Stage via allTurnRows)
  const allHostComplete = runs.every(hasCompleteHost);
  const allSubagentsComplete = runs.every(hasCompleteSubagents);
  const roleGroups = (Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]).map((role) => {
    const tRows = allTurnRows.filter(r => r.role === role);
    const rUnits = allUnits.filter(u => u.role === role);
    const meta = roles.find(r => r.role === role)!;
    const cov = [...meta.coverage, ...(tRows.some(r => r.limited) ? ['limited'] : [])];
    const rPartial = (role === 'host' && !allHostComplete) || (role === 'subagent' && !allSubagentsComplete);
    return { role, label: ROLE_LABELS[role], cost: meta.cost, tokens: meta.tokens ?? 0, hasUsage: meta.tokens !== null, cacheHit: cacheHitOf(rUnits, rPartial), userTurns: role === 'host' ? userTurnsTotal : undefined, llmTurns: allDefinedSum(tRows.map(r => r.usage?.turns)), toolCalls: allDefinedSum(tRows.map(r => r.usage?.toolCalls)), toolTurns: allDefinedSum(tRows.map(r => r.usage?.toolTurns)), coverage: cov.join(', ') || 'no recorded launches' };
  });
  const roleShares = computeShares(roleGroups);

  // Stage table (reconciles Summary & Role via allTurnRows)
  const stageKeys = [...new Set([...STAGE_ORDER.filter(s => allTurnRows.some(r => r.stage === s) || runs.some(run => run.hostUsage?.userTurnsByStage?.[s] !== undefined)), ...allTurnRows.map(r => r.stage).filter(s => !(STAGE_ORDER as readonly string[]).includes(s))])];
  const stageGroups = stageKeys.map((stage) => {
    const tRows = allTurnRows.filter(r => r.stage === stage);
    const sUnits = allUnits.filter(u => u.stage === stage);
    const obs = tRows.filter(r => r.usage);
    const tokens = obs.reduce((n, r) => n + billedTokens(r.usage!, r.platform, r.reasoningInOutput), 0);
    const uByStage = stage !== DASH ? allDefinedSum(runs.map(r => hasCompleteUser(r) ? (r.hostUsage!.userTurnsByStage?.[stage as never] ?? 0) : undefined)) : undefined;
    const llm = allDefinedSum(tRows.map(r => r.usage?.turns));
    const tc = allDefinedSum(tRows.map(r => r.usage?.toolCalls));
    const tt = allDefinedSum(tRows.map(r => r.usage?.toolTurns));
    const stLimited = tRows.some(r => r.limited);
    const stPartial = (sUnits.some(u => u.role === 'host') && !allHostComplete) || (sUnits.some(u => u.role === 'subagent') && !allSubagentsComplete);
    return { stage, cost: sumCost(costsOf(tRows)), tokens, hasUsage: obs.length > 0, cacheHit: cacheHitOf(sUnits, stPartial), userTurns: num(uByStage), llmTurns: qualify(num(llm), stPartial, stLimited), toolText: qualify(toolCell(tc, tt), stPartial, stLimited) };
  });
  const stageShares = computeShares(stageGroups);

  const lead = [
    '# Dispatch diagnostics', '',
    'Review before sharing: dispatch-owned data only (no source, objective, paths, identities); fixes unverified.', '',
    '`—` unavailable · `~` USD estimate · bars show cost-midpoint share (or tokens if unpriced).', '',
    '## Summary', '',
    `- Runs: ${runs.length} · Host: ${hosts.join(', ') || DASH} · OS: ${unique(runs.map((run) => run.os ?? DASH))} · Measured duration: ${formatDuration(sum(runs.flatMap((run) => run.phases.map((p) => p.wallMs))))}`,
    `- Estimated cost ${pricer ? formatCost(total) : 'not estimated (rate table unavailable)'}${total.priced && scope.partial ? ' (partial)' : ''} · priced ${priced} · unpriced ${unpriced} · Cache hit: ${cacheHitOf(allUnits, !hostTurnsComplete)}`,
    `- Turns: User ${num(userTurnsTotal)} · LLM ${qualify(num(llmTurnsTotal), !hostTurnsComplete, summaryLimited)} · Tool calls ${qualify(toolCell(toolCallsTotal, toolTurnsTotal), !hostTurnsComplete, summaryLimited)} · ${toolkitCallsText}`,
    `- Subagents: ${num(subagentCountTotal)} · max depth ${num(maxSubagentDepthTotal)}`,
    `- Waste / recovery: ${wasteCostText} (${wasteShareText}) · extra ${recovery.extraLaunches ?? DASH} · superseded ${recovery.reworkLaunches ?? DASH} · nudge ${recovery.nudges ?? DASH} · wrap-up ${recovery.wrapUps ?? DASH} · writer relaunches ${recovery.writerRelaunches ?? DASH}`,
    ...warnings,
    '',
    ...(findings.length > 3 ? ['Top findings:', '', ...findings.slice(0, 3).map((f, i) => `${i + 1}. ${summaryLine(f)}`), ''] : []),
    '### Spend & Turns by Role', '',
    row(['Role', 'Share', 'Cost', 'Billed tokens', 'Cache hit', 'User turns', 'LLM turns', 'Tool calls (tool turns)', 'Coverage']),
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...roleGroups.map((g, i) => row([g.label, shareBar(roleShares[i] ?? null), formatCost(g.cost), g.hasUsage ? num(g.tokens) : DASH, g.cacheHit, num(g.userTurns), num(g.llmTurns), toolCell(g.toolCalls, g.toolTurns), g.coverage])),
    '',
    '### Spend & Turns by Stage', '',
    ...(hostTurnsComplete ? [] : ['Stage uses observed rows. Summary flags missing host/subagent data.', '']),
    row(['Stage', 'Share', 'Cost', 'Billed tokens', 'Cache hit', 'User turns', 'LLM turns', 'Tool calls (tool turns)']),
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(stageGroups.length ? stageGroups.map((g, i) => row([g.stage, shareBar(stageShares[i] ?? null), formatCost(g.cost), g.hasUsage ? num(g.tokens) : DASH, g.cacheHit, g.userTurns, g.llmTurns, g.toolText])) : [row(Array<string>(8).fill(DASH))]),
    '',
    ...costDrivers(allUnits),
  ];

  const sections = buildSections(runs, efficiency, grounding, runUnits, metadataLines, pricer);
  const findingLines = (keep: number) => {
    if (!findings.length) return ['## Findings', '', 'No findings.', ''];
    const lines = ['## Findings', ''];
    findings.slice(0, keep).forEach((f, i) => lines.push(`### ${i + 1}. ${CATEGORIES[f.category]} · \`${f.component}\``, '', `- Source: ${sourceOf(f)} · run ${f.run ?? DASH}`, `- Evidence: ${md(f.evidence)}`, `- Impact: ${md(f.impact)}`, `- Proposed fix (unverified): ${md(f.proposedFix)}`, ''));
    if (keep < findings.length) lines.push(`${plural(findings.length - keep, 'lower-severity finding')} omitted at the report size limit.`, '');
    return lines;
  };
  const tail = appendix(runs);
  const assemble = (withAppendix: boolean, keep: number, fold: Fold = {}) => [
    ...lead,
    ...sections.reviewHealth(fold),
    ...sections.groundingLines(),
    ...findingLines(keep),
    ...sections.tier2Cost(fold),
    ...sections.tier2Efficiency(fold),
    ...sections.tier2Execution(fold),
    ...(withAppendix ? tail : ['<details>', '', '<summary>Invocations, provenance, and configuration</summary>', '', 'Omitted at the report size limit.', '', '</details>', '']),
  ].join('\n');
  const fits = (text: string) => Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes;
  let text = assemble(true, findings.length);
  if (!fits(text)) text = assemble(false, findings.length);
  for (let keep = findings.length - 1; !fits(text) && keep >= 0; keep--) text = assemble(false, keep);
  const fold: Fold = {};
  for (const table of FOLD_ORDER) {
    if (fits(text)) break;
    if (!sections.counts[table]) continue;
    const render = (n: number) => assemble(false, 0, { ...fold, [table]: n });
    let lo = 0;
    for (let hi = fits(render(0)) ? sections.counts[table] - 1 : 0; lo < hi;) {
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
