import { formatCost, sumCost, type Cost, type CostReason, type Pricer } from '../../lib/pricing.ts';
import { addCounters, HOST_ROLES, STAGE_ORDER, tokenTotal, type Counters } from '../../lib/usage/rows.ts';
import type { CoverageReason } from '../types.ts';
import { measured, opt, retroObservations, sanitizeFacts } from './diagnostics-gates.ts';
import { bySeverity, num, pct, phaseName, plural, selectFindings, sum } from './diagnostics-heuristics.ts';
import { addYield, CATEGORIES, DASH, DIAGNOSTIC_LIMITS, type Finding, type InvocationFacts, type ModelUsage, type PhaseFacts, type RetroObservation, type RunFacts, type SlotYieldFacts, type Usage } from './diagnostics-types.ts';


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
      ...(eligible.length ? ['Advisory budget per round with a lightweight fix review: at most 6 toolkit calls and 25 host turns; over: ' + (over.map(round => 'subject ' + round.review.slice(7) + ' round ' + round.round).join(', ') || 'none')] : []),
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
