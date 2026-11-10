import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readHostUsage, nodeHostUsageFs } from './host-usage/index.ts';
import { readErrorReason } from './host-usage/read.ts';
import type { Milestone, HostStage } from './host-usage/types.ts';
import { addYield, normalizeUsage, renderDiagnostics, sanitizeFacts, type InvocationFacts, type ReviewFacts, type RunFacts, type SlotYieldFacts } from './domain/diagnostics.ts';
import { foldLedger, latest, type Fold } from './ledger.ts';
import { stableValue } from './domain/stable-value.ts';
import { launches } from './writers.ts';
import { ToolError } from './output.ts';
import { generateSkillHashes, readVersion } from '../lib/integrity.ts';
import { loadConfig } from '../lib/config.ts';
import { stripBom } from '../lib/fs-ext.ts';
import type { CliDeps, HandlerContext, HandlerResult } from './cli.ts';

type RosterSlot = {slot: string; provider?: string; model?: string | readonly string[]; effort?: string; native?: boolean; reserve?: boolean};
type SlotOutcome =
  | {slot: string; state: 'done'; responder?: {slot: string; provider: string; model: string | null; native: boolean; effort?: string}}
  | {slot: string; state: 'native'}
  | {slot: string; state: 'failed'; cls: string};
type ReviewedFinding = {
  id: string;
  severity?: string;
  sources?: string[];
  recurrence?: {of: string};
  unresolved?: {of: string};
  origin?: string;
};
type FindingsFile = {review?: string; findings?: ReviewedFinding[]};
type RoundFile = {round: number; generation: number; cap: number; roster: RosterSlot[]};

export type ReviewRound = {
  review: string;
  round: number;
  cap: number;
  roster: RosterSlot[];
  generation: number;
  slots: SlotOutcome[];
  findings: FindingsFile | null;
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new ToolError(2, 'review-corrupt', `Malformed review JSON at ${file}`);
    throw error;
  }
}

function entriesOrEmpty(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, {withFileTypes: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Reads initialized rounds and their current-generation slot and findings files. */
export function readReviews(session: string): ReviewRound[] {
  const root = path.join(session, '.state', 'reviews');
  const rounds: ReviewRound[] = [];
  for (const reviewEntry of entriesOrEmpty(root).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const reviewRoot = path.join(root, reviewEntry.name);
    for (const roundEntry of entriesOrEmpty(reviewRoot).filter((entry) => entry.isDirectory())) {
      const roundRoot = path.join(reviewRoot, roundEntry.name);
      const round = readJson<RoundFile>(path.join(roundRoot, 'round.json'));
      if (!round) continue;
      const roster = Array.isArray(round.roster) ? round.roster : [];
      const rosterIds = new Set(roster.map((slot) => slot['slot']));
      const slotRoot = path.join(roundRoot, `gen-${round.generation}`, 'slots');
      const bySlot = new Map<string, SlotOutcome>();
      for (const slotEntry of entriesOrEmpty(slotRoot).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        const outcome = readJson<SlotOutcome>(path.join(slotRoot, slotEntry.name));
        if (outcome && rosterIds.has(outcome.slot)) bySlot.set(outcome.slot, outcome);
      }
      const slots = roster.flatMap((slot) => {
        const outcome = bySlot.get(slot['slot']);
        return outcome ? [outcome] : [];
      });
      rounds.push({
        review: reviewEntry.name,
        round: round.round,
        cap: round.cap,
        roster,
        generation: round.generation,
        slots,
        findings: readJson<FindingsFile>(path.join(roundRoot, 'findings.json')),
      });
    }
  }
  return rounds.sort((a, b) => a.review.localeCompare(b.review) || a.round - b.round);
}

function invocation(round: ReviewRound, slot: SlotOutcome): InvocationFacts {
  const target = round.roster.find(row => row.slot === slot['slot']);
  const responder = slot['state'] === 'done' ? (slot as {responder?: {provider: string; model: string | null; native: boolean}}).responder : undefined;
  const provider = responder?.provider ?? target?.provider ?? 'unavailable';
  const responderModel = responder?.model;
  const targetModel = typeof target?.model === 'string' ? target.model : Array.isArray((target as {model?: unknown})?.model) ? ((target as {model: readonly string[]}).model[0] ?? 'unavailable') : 'unavailable';
  // A recorded responder names its own model: a null model means the reserve
  // ran unconfigured, never the logical target's model. The target fallback
  // applies only when no responder data exists.
  const model = responder
    ? (typeof responderModel === 'string' && responderModel.trim() ? responderModel : 'unavailable')
    : targetModel;
  const surface = slot['state'] === 'done'
    ? (responder ? (responder.native ? 'native' as const : 'cli' as const) : (target?.native ? 'native' as const : 'cli' as const))
    : slot['state'] === 'native' || (target as {native?: boolean})?.native ? 'native' as const : 'cli' as const;
  const base = {
    phase: round.review,
    provider,
    model,
    launched: false,
    surface,
    slot: slot['slot'],
  };
  if (slot['state'] === 'done') return {...base, outcome: 'ok'};
  if (slot['state'] === 'native') return {...base, outcome: 'native-pending'};
  return {...base, outcome: typeof slot.cls === 'string' ? slot.cls : 'unknown'};
}

function reviewFacts(round: ReviewRound, fold: Fold): ReviewFacts | null {
  const findings = round.findings?.findings;
  if (!findings) return null;
  let accepted = 0;
  let rejected = 0;
  const reraised = new Set<string>();
  for (const finding of findings) {
    const ruling = fold.records.findLast((record) => record.kind === 'ruling' && record.data['subject'] === `review:${round.review}:${finding.id}`);
    if (ruling?.data['ruling'] === 'accepted') accepted++;
    if (ruling?.data['ruling'] === 'rejected') rejected++;
    if (typeof finding.recurrence?.of === 'string') reraised.add(finding.recurrence.of);
    if (typeof finding.unresolved?.of === 'string') reraised.add(finding.unresolved.of);
  }
  return {phase: round.review, round: round.round, cap: round.cap, accepted, rejected, ...(reraised.size ? {reraised: [...reraised]} : {})};
}

/** A round plus every generation directory, so superseded invocations still map to their review. */
type YieldRound = ReviewRound & {generations: {generation: number; subject: string}[]};

const emptyRaised = () => ({MUST: 0, SHOULD: 0, CONSIDER: 0});

/** Per-responder yield from current-generation findings, rulings and slot token cost. */
function slotYieldFacts(rounds: readonly YieldRound[], invocations: readonly InvocationFacts[], fold: Fold): SlotYieldFacts[] {
  const rows = new Map<string, SlotYieldFacts>();
  const add = (value: SlotYieldFacts) => {
    const key = [value.kind, value.provider, value.model ?? ''].join('\0');
    const current = rows.get(key);
    if (!current) { rows.set(key, value); return; }
    addYield(current, value);
  };
  const tally = (target: {accepted: number; rejected: number; deferred: number; duplicate: number; unruled: number}, subject: string) => {
    const value = fold.records.findLast((record) => record.kind === 'ruling' && record.data['subject'] === subject)?.data['ruling'];
    if (value === 'accepted') target.accepted++;
    else if (value === 'rejected') target.rejected++;
    else if (value === 'deferred') target.deferred++;
    else if (value === 'duplicate') target.duplicate++;
    else target.unruled++;
  };
  const tool = {raised: emptyRaised(), accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 0};
  for (const round of rounds) {
    const current = round.generations.find((entry) => entry.generation === round.generation)?.subject;
    const slots = new Map(round.slots.map((slot) => [slot['slot'], slot]));
    // NOTE: a reserve logs its own slot but serves its target slot; map per invocation.
    const logical = new Map<string, InvocationFacts[]>();
    for (const row of invocations) {
      if (!round.generations.some((entry) => entry.subject === row.subject)) continue;
      const target = row.targetSlot ?? row.slot;
      if (target) logical.set(target, [...(logical.get(target) ?? []), row]);
    }
    for (const source of new Set([...slots.keys(), ...logical.keys()])) {
      const outcome = slots.get(source), roster = round.roster.find((slot) => slot['slot'] === source);
      const attempts = logical.get(source) ?? [], recent = attempts.filter((row) => row.subject === current);
      const last = (recent.length ? recent : attempts).at(-1);
      const responder = outcome?.state === 'done' ? outcome.responder : undefined;
      const native = responder?.native === true || (!responder && (outcome?.state === 'native' || roster?.native === true));
      const provider = responder?.provider ?? last?.provider ?? roster?.provider;
      if (!provider) continue;
      const rosterModel = typeof roster?.model === 'string' ? roster.model : Array.isArray(roster?.model) ? roster.model[0] ?? null : null;
      const value: SlotYieldFacts = {
        kind: native ? 'native' : 'provider', provider, model: native ? null : responder?.model ?? last?.model ?? rosterModel,
        raised: emptyRaised(), accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 0,
        measured: recent.filter((row) => row.surface === 'cli' && row.launched && !row.estimated && row.usage).length,
        launched: attempts.filter((row) => row.surface === 'cli' && row.launched).length,
      };
      let tokens: number | undefined, fixInduced = 0;
      for (const row of recent) {
        if (row.surface !== 'cli' || !row.launched || row.estimated || !row.usage) continue;
        tokens = (tokens ?? 0) + row.usage.input + (row.usage.cacheRead ?? 0) + (row.usage.cacheWrite ?? 0) + row.usage.output;
      }
      if (tokens !== undefined) value.tokens = tokens;
      for (const item of round.findings?.findings ?? []) {
        if (!item.sources?.includes(source)) continue;
        if (item.severity === 'MUST' || item.severity === 'SHOULD' || item.severity === 'CONSIDER') value.raised[item.severity]++;
        if (item.origin === 'fix-induced') fixInduced++;
        tally(value, `review:${round.review}:${item.id}`);
      }
      if (fixInduced) value.fixInduced = fixInduced;
      add(value);
    }
    for (const item of round.findings?.findings ?? []) {
      if (!item.sources?.includes('tool')) continue;
      if (item.severity === 'MUST' || item.severity === 'SHOULD' || item.severity === 'CONSIDER') tool.raised[item.severity]++;
      tally(tool, `review:${round.review}:${item.id}`);
    }
  }
  if (tool.accepted + tool.rejected + tool.deferred + tool.duplicate + tool.unruled > 0) add({kind: 'tool', provider: 'tool', model: null, ...tool, measured: 0, launched: 0});
  return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.provider.localeCompare(b.provider) || (a.model ?? '').localeCompare(b.model ?? ''));
}

export function stageMilestones(fold: Fold, captures: readonly RunFacts[], startMs: number): Milestone[] {
  const capturesOf = (name: string) => captures.filter(c => c.phases.some(p => p.name === name) && c.capture?.start !== undefined);
  const confirm = fold.records.filter(r => r.kind === 'confirm').map(r => Date.parse(r.at)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  if (confirm === undefined) {
    const first = captures.filter(c => c.capture && c.phases.some(p => ['ask','design review','plan review','code review'].includes(p.name))).sort((a,b)=>a.capture!.start-b.capture!.start)[0];
    return [{stage: (first?.phases.find(p => ['ask','design review','plan review','code review'].includes(p.name))?.name ?? 'spec') as HostStage, atMs:startMs}];
  }
  const designs=capturesOf('design review'), plans=capturesOf('plan review');
  const stages: Milestone[]=[{stage:'spec',atMs:startMs},{stage:designs.length?'design':'plan',atMs:confirm}];
  for (const name of ['design review','plan review','code review'] as const) {
    const first=capturesOf(name).sort((a,b)=>a.capture!.start-b.capture!.start)[0];
    if(first) stages.push({stage:name,atMs:first.capture!.start});
  }
  if(designs.length && (plans.length || fold.records.some(r=>r.kind==='bind' && typeof r.data['plan']==='string'))) {
    const ends=designs.flatMap(c=>c.capture?.end === undefined ? [] : [c.capture.end]);
    if(ends.length) stages.push({stage:'plan',atMs:Math.max(...ends)});
  }
  const implementation=fold.records.filter(r=>r.kind==='approval'||(r.kind==='writer'&&r.data['phase']==='launched')).map(r=>Date.parse(r.at)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  if(implementation!==undefined) stages.push({stage:'implementation',atMs:implementation});
  return stages.sort((a,b)=>a.atMs-b.atMs);
}

/** Builds optional facts independently of the strict walkthrough reader. */
export function sessionFacts(session: string, fold: Fold, outcome: string, hostContext?: {manifest: HandlerContext['manifest']; deps: CliDeps}): RunFacts {
  const collection = {completed:0, partial:0, corrupt:0, unreadable:0, incomplete:0, storageFailed:0};
  const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const issue = (key: keyof typeof collection) => { collection[key] = Math.min(1_000_000, collection[key]+1); };
  const entries = (directory: string) => {
    try { return entriesOrEmpty(directory).sort((a,b)=>a.name.localeCompare(b.name)); }
    catch { issue('unreadable'); return []; }
  };
  const read = (file: string): unknown => {
    try { return readJson<unknown>(file); }
    catch(error) { issue(error instanceof ToolError && error.reason==='review-corrupt' ? 'corrupt' : 'unreadable'); return undefined; }
  };
  const rounds: YieldRound[] = [];
  const hash=(value:string)=>crypto.createHash('sha256').update(value).digest('hex').slice(0,16);
  const root = path.join(session,'.state','reviews');
  for (const review of entries(root).filter(e=>e.isDirectory())) {
    const reviewRoot=path.join(root,review.name);
    for (const entry of entries(reviewRoot).filter(e=>e.isDirectory())) {
      const roundRoot=path.join(reviewRoot,entry.name), value=read(path.join(roundRoot,'round.json'));
      if(value===undefined) continue;
      if(!object(value)||!Number.isSafeInteger(value['round'])||value['round']<1||!Number.isSafeInteger(value['generation'])||value['generation']<1||!Number.isSafeInteger(value['cap'])||!Array.isArray(value['roster'])||!value['roster'].every((r:unknown)=>object(r)&&typeof r['slot']==='string')) { issue('corrupt');continue; }
      const round=value as RoundFile, slots:SlotOutcome[]=[];
      for(const file of entries(path.join(roundRoot,`gen-${round.generation}`,'slots')).filter(e=>e.isFile()&&e.name.endsWith('.json'))) {
        const slot=read(path.join(roundRoot,`gen-${round.generation}`,'slots',file.name));
        if(slot===undefined)continue;
        if(!object(slot)||!round.roster.some(r=>r['slot']===slot['slot'])||!['done','native','failed'].includes(slot['state'])) {issue('corrupt');continue;}
        slots.push(slot as SlotOutcome);
      }
      const findings=read(path.join(roundRoot,'findings.json'));
      const valid=findings===null || (object(findings)&&Array.isArray(findings['findings'])&&findings['findings'].every((f:unknown)=>object(f)&&typeof f['id']==='string'));
      if(findings!==undefined&&!valid)issue('corrupt');
      const generations=[...new Set(entries(roundRoot).filter(e=>e.isDirectory()&&/^gen-\d+$/.test(e.name)).map(e=>Number(e.name.slice(4))))];
      if(!generations.includes(round.generation))generations.push(round.generation);
      rounds.push({review:review.name,round:round.round,cap:round.cap,generation:round.generation,roster:round.roster,slots,findings:valid?findings as FindingsFile|null:null,
        generations:generations.sort((a,b)=>a-b).map(generation=>({generation,subject:hash(path.join(roundRoot,`gen-${generation}`))}))});
    }
  }
  rounds.sort((a,b)=>a.review.localeCompare(b.review)||a.round-b.round);
  const measured: RunFacts[]=[];
  const storageFailures=new Map<string,number>();
  const directory=path.join(session,'.state','diagnostics');
  for(const entry of entries(directory).filter(e=>e.isFile()&&e.name.endsWith('.json'))) {
    const raw=read(path.join(directory,entry.name));
    if(raw===undefined)continue;
    if(object(raw)&&raw['kind']==='storage-failure'&&entry.name.endsWith('.json.failure.json')) {
      const failures=raw['count'];
      if(Number.isSafeInteger(failures)&&failures>0)storageFailures.set(entry.name.slice(0,-'.failure.json'.length),Math.max(storageFailures.get(entry.name.slice(0,-'.failure.json'.length))??0,Math.min(1_000_000,failures)));
      else issue('corrupt');
      continue;
    }
    if(!object(raw)||!Array.isArray(raw['phases'])||!Array.isArray(raw['invocations'])||!Array.isArray(raw['reviews'])){issue('corrupt');continue;}
    const capture=sanitizeFacts(raw as RunFacts); measured.push(capture);
    if(!capture.capture || capture.capture.state!=='completed' || capture.capture.end===undefined)issue('incomplete');
    else issue('completed');
    storageFailures.set(entry.name,Math.max(storageFailures.get(entry.name)??0,capture.capture?.storageFailed??0));
  }
  // Capture filenames are random; order by capture clock so a retry's later attempt wins, then by content for determinism.
  measured.sort((a,b)=>(a.capture?.start??0)-(b.capture?.start??0)||stableValue(a).localeCompare(stableValue(b)));
  const phases=new Map<string,RunFacts['phases'][number]>();
  const aggregateOutcome=(values:(string|undefined)[])=>{
    const known=[...new Set(values.filter((v):v is string=>v!==undefined))].sort();
    return known.length===1?known[0]:known.length?'mixed':undefined;
  };
  const phaseBySubject=new Map<string,string>();
  const reviewKeys=new Map<string,string>();
  for(const round of rounds) {
    const key=reviewKeys.get(round.review)??'review-'+hash(path.join(root,round.review));reviewKeys.set(round.review,key);
    for(const generation of round.generations)phaseBySubject.set(generation.subject,key);
    const name=round.review.startsWith('plan-')?'plan review':round.review.startsWith('design-')?'design review':'code review';
    if(!phases.has(key))phases.set(key,{key,name});
  }
  for(const capture of measured) for(const original of capture.phases) {
    const subjects=[...new Set(capture.invocations.filter(row=>row.phase===original.key).flatMap(row=>row.subject&&phaseBySubject.has(row.subject)?[phaseBySubject.get(row.subject)!]:[]))];
    const phase={...original,key:subjects.length===1?subjects[0]!:original.key};
    const previous=phases.get(phase.key);
    const result=aggregateOutcome([previous?.outcome,phase.outcome]);
    phases.set(phase.key,{...phase,...(result?{outcome:result}:{}),...(previous?.wallMs===undefined&&phase.wallMs===undefined?{}:{wallMs:(previous?.wallMs??0)+(phase.wallMs??0)})});
  }
  const invocations:InvocationFacts[]=[];
  const native=new Map<string,InvocationFacts>();
  const add=(row:InvocationFacts)=>{
    const phase=row.subject?phaseBySubject.get(row.subject):undefined;
    const value={...row,...(phase?{phase}:{})};
    if(value.surface!=='native'){invocations.push(value);return;}
    const key=[value.subject??value.phase,value.slot??''].join('|');
    const previous=native.get(key);
    const rank=(r:InvocationFacts)=>r.nativeState==='completed'?3:r.nativeState==='invalid'||r.nativeState==='failed'?2:1;
    if(!previous||rank(value)>=rank(previous))native.set(key,value);
  };
  measured.flatMap(row=>row.invocations).forEach(add);
  for(const round of rounds)for(const slot of round.slots) {
    const row=invocation(round,slot);
    if(row.surface!=='native')continue;
    const subject=hash(path.join(root,round.review,`round-${round.round}`,`gen-${round.generation}`));
    // A current semantic slot is authoritative, but never creates another CLI launch.
    const prior=[...native.values()].find(i=>i.subject===subject&&i.slot===slot['slot']);
    add({...row,phase:reviewKeys.get(round.review)!,subject,attempt:prior?.attempt??0,nativeState:slot['state']==='done'?'completed':slot['state']==='native'?'pending':slot['state']==='failed'?'failed':'invalid'});
  }
  invocations.push(...native.values());
  let observations:unknown,retroState:RunFacts['retroState'];
  try {
    observations=JSON.parse(stripBom(fs.readFileSync(path.join(session,'.state','retro.json'),'utf8')));
    retroState=Array.isArray(observations)?observations.length?'collected':'empty':'invalid';
  }catch(error){retroState=(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':error instanceof SyntaxError?'malformed':'unreadable';}
  const provenance=new Map<string,NonNullable<RunFacts['provenance']>[number]>();
  for(const row of measured) {
    const snapshot={...(row.version?{version:row.version}:{}),...(row.build?{build:row.build}:{}),...(row.config?{config:row.config}:{})};
    provenance.set(stableValue(snapshot),snapshot);
  }
  const tasks=[...new Set(fold.records.filter(r=>r.kind==='writer'&&typeof r.data['task']==='string').map(r=>r.data['task'] as string))];
  const relaunches=tasks.reduce((sum,task)=>sum+Math.max(0,new Set(launches(fold,task).map(row=>row.record.key)).size-1),0);
  collection.storageFailed=Math.min(1_000_000,[...storageFailures.values()].reduce((sum,n)=>sum+n,0));
  collection.partial=Math.min(1_000_000,collection.corrupt+collection.unreadable+collection.incomplete+collection.storageFailed);
  const level=latest(fold,'level')?.data['level'],host=measured.find(row=>row.host)?.host;
  const slotYield=slotYieldFacts(rounds,invocations,fold);
  let hostUsage: RunFacts['hostUsage'];
  if(hostContext) {
    const {manifest,deps}=hostContext, platform=deps.orchestrator?.platform ?? null;
    const startMs=Date.parse(manifest.createdAt);
    try {
      hostUsage = !Number.isFinite(startMs) ? {platform,rows:[],unavailable:'invalid session start'} : readHostUsage(platform,{startMs,endMs:deps.clock(),home:(process.platform==='win32' ? deps.env['USERPROFILE'] ?? deps.env['HOME'] : deps.env['HOME'] ?? deps.env['USERPROFILE']) ?? os.homedir(),env:name=>deps.env[name],stages:stageMilestones(fold,measured,startMs)},deps.hostUsageFs ?? nodeHostUsageFs);
    } catch(error) { hostUsage={platform,rows:[],unavailable:readErrorReason(error)}; }
  }
  // NOTE: the ledger records no verb; only writer records identify one, so other runs omit it rather than guess.
  return {
    ...(typeof level==='string'?{level}:{}),...(tasks.length?{verb:'implement'}:{}),outcome,timingScope:'tool-calls',os:process.platform,...(host?{host}:{}),
    phases:[...phases.values()].sort((a,b)=>a.key.localeCompare(b.key)),invocations,
    reviews:rounds.flatMap(round=>{const row=reviewFacts(round,fold);return row?[{...row,phase:reviewKeys.get(round.review)!}]:[];}),
    ...(slotYield.length?{slotYield}:{}),...(hostUsage?{hostUsage}:{}),
    retroState,...(observations===undefined?{}:{observations}),collection,provenance:[...provenance.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v),
    rejectedTools:measured.flatMap(row=>row.rejectedTools??[]),relaunches,
  };
}

/** Writes the compact diagnostics report with a rename so readers never see a partial file. */
export function writeDiagnostics(session: string, facts: RunFacts): string {
  const output = path.join(session, 'diagnostics.md');
  const temp = output + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, renderDiagnostics([facts]).text, {mode: 0o600});
    fs.renameSync(temp, output);
  } finally {
    fs.rmSync(temp, {force: true});
  }
  return output;
}

export function diagnosticsEnabled(skillRoot: string): boolean {
  let candidateSeen = false;
  const read = (file: string): string | null => {
    try {
      const contents = fs.readFileSync(file, 'utf8');
      candidateSeen = true;
      return contents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      candidateSeen = true;
      throw error;
    }
  };
  try {
    const value = loadConfig(skillRoot, read).config['diagnostics'];
    if (value !== undefined && typeof value !== 'boolean') throw new Error('diagnostics must be a boolean');
    return value === true;
  } catch (error) {
    if (!candidateSeen) return false;
    throw new ToolError(2, 'config-invalid', error instanceof Error ? error.message : String(error));
  }
}

/** Optional diagnostics stay outside workflow decisions and semantic result files. */
export function diagnosticInstructions(skillRoot: string): {instructions?: string} {
  try {
    return diagnosticsEnabled(skillRoot) ? {instructions:'Read references/diagnostics.md from the Dispatch skill root; at each verb\'s final handoff, merge retro observations and run diagnostics render.'} : {};
  } catch { return {}; }
}

/** Captures runner facts before semantic slot persistence, so retries and reserve calls survive recovery. */
export function observeTool(session: string, tool: string, action: string, kind: string | undefined, deps: CliDeps): {deps: CliDeps; finish: (outcome: HandlerResult) => void} | undefined {
  try {
  if (!diagnosticsEnabled(deps.skillRoot)) return undefined;
  const started = deps.clock();
  const phase = tool + '-' + action + (tool === 'review' ? '-' + (kind ?? 'code') : '');
  const name = tool === 'ask' ? 'ask' : tool === 'review' ? (kind === 'plan' ? 'plan review' : kind === 'design' ? 'design review' : 'code review') : 'implementation';
  const facts: RunFacts = {os:process.platform,...(deps.orchestrator ? {host:deps.orchestrator.platform} : {}),phases:[],invocations:[],reviews:[]};
  const directory = path.join(session,'.state','diagnostics');
  const file = path.join(directory,crypto.randomUUID()+'.json');
  facts.capture={state:'opened',start:started};
  try {
    const version=readVersion(deps.skillRoot);
    if(version)facts.version=version;
    facts.build=crypto.createHash('sha256').update(JSON.stringify(Object.entries(generateSkillHashes(deps.skillRoot)).sort(([a],[b])=>a<b?-1:a>b?1:0))).digest('hex');
    facts.config=loadConfig(deps.skillRoot).config;
  }catch{}
  const persist = () => {
    const temp = file+'.tmp';
    try {
      fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(temp,JSON.stringify(sanitizeFacts(facts))+'\n',{mode:0o600});
      fs.renameSync(temp,file);
    } catch {
      facts.capture!.storageFailed=Math.min(1000000,(facts.capture!.storageFailed??0)+1);
      // Preserve the previous capture when an optional update fails.
      const marker=file+'.failure.json',markerTemp=marker+'.tmp';
      try {
        fs.writeFileSync(markerTemp,JSON.stringify({kind:'storage-failure',count:facts.capture!.storageFailed})+'\n',{mode:0o600});
        fs.renameSync(markerTemp,marker);
      } catch {}
      finally {try {fs.rmSync(markerTemp,{force:true});}catch{}}
    } finally { try {fs.rmSync(temp,{force:true});} catch {} }
  };
  const subjectOf=(directory:string)=>crypto.createHash('sha256').update(directory).digest('hex').slice(0,16);
  const attempts=new Map<string,number>();
  const collect=(rows: unknown, request: Parameters<CliDeps['delegate']>[1])=>{
    try {
      if(!Array.isArray(rows))return;
      const slot=/^([A-Za-z0-9_-]+\[\d+\])\.log$/.exec(path.basename(request.logPath))?.[1];
      const subject=subjectOf(path.dirname(path.dirname(request.logPath)));
      const key=subject+slot;
      for(const i of rows) {
        const attempt=(attempts.get(key)??0)+1;attempts.set(key,attempt);
        const usage=i.usage&&i.launched&&i.usage.scope!=='session-cumulative'?normalizeUsage(i.usage,i.usage.inputSemantics):undefined;
        facts.invocations.push({phase,subject,attempt,provider:i.provider,model:i.model??'default',mode:i.mode,surface:'cli',launched:i.launched,outcome:i.outcome,
          ...(slot?{slot}:{}),...(request.targetSlot?{targetSlot:request.targetSlot}:{}),...(i.effort?{effort:i.effort}:{}),...(i.durationMs===undefined?{}:{durationMs:i.durationMs}),...(usage?{usage}:{}),...(i.coverage?{coverage:i.coverage}:{}),...(i.usage?.actualModels?{reportedModels:i.usage.actualModels}:{}),...(i.lifecycleSteps?{lifecycleSteps:i.lifecycleSteps}:{}),...(i.nudge===true?{nudge:true as const}:{})});
      }
      persist();
    } catch { /* Malformed optional runner metadata cannot change its outcome. */ }
  };
  persist();
  return {
    deps:{...deps, diagnostics(event) {
      try {
        const subject=subjectOf(event.subject);
        const base={phase,subject,slot:event.slot,attempt:event.attempt,...(event.targetSlot?{targetSlot:event.targetSlot}:{}),provider:event.provider??'unavailable',model:event.model??'unavailable',launched:false};
        if(event.kind==='validation'&&event.surface==='cli') {
          const row=facts.invocations.findLast(i=>i.subject===subject&&i.slot===event.slot);
          if(row)row.validationOutcome=event.outcome;
        } else if(event.kind==='native') {
          const prior=facts.invocations.find(i=>i.surface==='native'&&i.subject===subject&&i.slot===event.slot);
          const row={...base,surface:'native' as const,outcome:event.state==='completed'?'ok':'native-'+event.state,nativeState:event.state};
          if(prior)Object.assign(prior,row);else facts.invocations.push(row);
        } else if(event.kind==='routing'||event.kind==='slot') {
          let row=facts.invocations.findLast(i=>i.surface==='cli'&&i.subject===subject&&i.slot===event.slot);
          if(!row&&event.cls) {
            row={...base,surface:'cli',outcome:event.cls};
            facts.invocations.push(row);
          }
          if(row) {
            if(event.kind==='routing')row.routingOutcome=event.state;
            else row.slotState=event.state;
            if(event.targetSlot)row.targetSlot=event.targetSlot;
          }
        }
        persist();
      }catch{}
    }, async delegate(provider,request,mode) {
      try {
        const result=await deps.delegate(provider,{...request,collectUsage:true,...(provider==='opencode'?{collectLifecycle:true}:{})},mode);
        collect(result.invocations,request);return result;
      } catch(error) {
        try {collect((error as {invocations?:unknown})?.invocations,request);}catch{}
        throw error;
      }
    }},
    finish(outcome) {
      try {
        facts.phases=[{key:phase,name,outcome:outcome.ok?'ok':outcome.reason??'fault',wallMs:Math.max(0,deps.clock()-started)}];
        facts.capture={...facts.capture!,state:'completed',end:deps.clock()};
        if(!outcome.ok&&['invalid-input','invalid-record','approval-stale','key-conflict','user-only'].includes(outcome.reason??''))facts.rejectedTools=[{tool,action,cls:outcome.reason!}];
        persist();
      }catch{}
    },
  };
  }catch{return undefined;}
}

export function optionalDiagnostics(session: string, fold: Fold, outcome: string, host?: {manifest: HandlerContext['manifest']; deps: CliDeps}): string | undefined {
  try { return writeDiagnostics(session,sessionFacts(session,fold,outcome,host)); }
  catch { return undefined; }
}

// NOTE: Render is not captured as a tool observation, so it cannot describe its own run.
export async function diagnosticsRender({session, args, deps, manifest}: HandlerContext): Promise<HandlerResult> {
  if (args.length) throw new ToolError(1, 'invalid-input', 'diagnostics render takes no positional arguments');
  if (!diagnosticsEnabled(deps.skillRoot)) return {ok: true, exit: 0, summary: 'diagnostics off', value: {path: null}};
  const file = optionalDiagnostics(session, foldLedger(session), 'rendered', {manifest,deps});
  if (file === undefined) return {ok: false, exit: 4, reason: 'diagnostics-failed', summary: 'diagnostics render failed; existing diagnostics.md unchanged', value: {path: null}};
  return {ok: true, exit: 0, summary: 'diagnostics rendered: ' + file, value: {path: file}};
}
