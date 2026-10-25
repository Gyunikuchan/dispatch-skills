import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeUsage, renderDiagnostics, sanitizeFacts, type InvocationFacts, type ReviewFacts, type RunFacts } from './domain/diagnostics.ts';
import { latest, type Fold } from './ledger.ts';
import { ToolError } from './output.ts';
import { loadConfig } from '../lib/config.ts';
import type { CliDeps, HandlerResult } from './cli.ts';

type RosterSlot = {slot: string; provider?: string; model?: string | readonly string[]; native?: boolean; reserve?: boolean};
type SlotOutcome =
  | {slot: string; state: 'done'}
  | {slot: string; state: 'native'}
  | {slot: string; state: 'failed'; cls: string};
type ReviewedFinding = {
  id: string;
  recurrence?: {of: string};
  unresolved?: {of: string};
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
      const rosterIds = new Set(roster.map((slot) => slot.slot));
      const slotRoot = path.join(roundRoot, `gen-${round.generation}`, 'slots');
      const bySlot = new Map<string, SlotOutcome>();
      for (const slotEntry of entriesOrEmpty(slotRoot).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        const outcome = readJson<SlotOutcome>(path.join(slotRoot, slotEntry.name));
        if (outcome && rosterIds.has(outcome.slot)) bySlot.set(outcome.slot, outcome);
      }
      const slots = roster.flatMap((slot) => {
        const outcome = bySlot.get(slot.slot);
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
  const target = round.roster.find(row => row.slot === slot.slot);
  const base = {
    phase: round.review,
    provider: target?.provider ?? 'unavailable',
    model: typeof target?.model === 'string' ? target.model : 'unavailable',
    launched: false,
    surface: slot.state === 'native' || target?.native ? 'native' as const : 'cli' as const,
    slot: slot.slot,
  };
  if (slot.state === 'done') return {...base, outcome: 'ok'};
  if (slot.state === 'native') return {...base, outcome: 'native-pending'};
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

/** Builds dispatch-owned diagnostics facts from the toolkit's ledger and result files. */
export function sessionFacts(session: string, fold: Fold, outcome: string): RunFacts {
  const rounds = readReviews(session);
  const level = latest(fold, 'level')?.data['level'];
  const measured: RunFacts[] = [];
  const directory = path.join(session, '.state', 'diagnostics');
  for (const entry of entriesOrEmpty(directory).filter(e => e.isFile() && e.name.endsWith('.json')).sort((a,b) => a.name.localeCompare(b.name))) {
    try { measured.push(sanitizeFacts(readJson<RunFacts>(path.join(directory, entry.name))!)); }
    catch { /* One corrupt optional capture must not suppress the other measurements. */ }
  }
  const phases = new Map<string,RunFacts['phases'][number]>();
  for (const phase of measured.flatMap(row => row.phases)) {
    const previous = phases.get(phase.key);
    phases.set(phase.key,{...phase,wallMs:(previous?.wallMs ?? 0)+(phase.wallMs ?? 0)});
  }
  let observations: unknown;
  let hasObservations = true;
  try {
    observations = JSON.parse(fs.readFileSync(path.join(session, '.state', 'retro.json'), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    hasObservations = false;
  }
  const host = measured.find(row => row.host)?.host;
  return {
    ...(typeof level === 'string' ? {level} : {}),
    verb: 'session',
    outcome,
    timingScope: 'tool-calls',
    os: process.platform,
    ...(host ? {host} : {}),
    phases: [...phases.values()],
    hostGaps: [],
    invocations: [...measured.flatMap(row => row.invocations), ...rounds.flatMap(round => round.slots.map(slot => invocation(round,slot))).filter(row => row.surface === 'native')],
    reviews: rounds.flatMap((round) => {
      const facts = reviewFacts(round, fold);
      return facts ? [facts] : [];
    }),
    rejectedEvents: [],
    ...(hasObservations ? {observations} : {}),
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
    return diagnosticsEnabled(skillRoot) ? {instructions:'Read references/diagnostics.md from the Dispatch skill root; collect retro observations before report completion.'} : {};
  } catch { return {}; }
}

/** Captures runner facts before semantic slot persistence, so retries and reserve calls survive recovery. */
export function observeTool(session: string, tool: string, action: string, kind: string | undefined, deps: CliDeps): {deps: CliDeps; finish: (outcome: HandlerResult) => void} | undefined {
  try { if (!diagnosticsEnabled(deps.skillRoot)) return undefined; } catch { return undefined; }
  const started = deps.clock();
  const phase = tool + '-' + action + (tool === 'review' ? '-' + (kind ?? 'code') : '');
  const name = tool === 'ask' ? 'ask' : tool === 'review' ? (kind === 'plan' ? 'plan review' : kind === 'design' ? 'design review' : 'code review') : 'implementation';
  const facts: RunFacts = {os:process.platform,...(deps.orchestrator ? {host:deps.orchestrator.platform} : {}),phases:[],hostGaps:[],invocations:[],reviews:[],rejectedEvents:[]};
  const directory = path.join(session,'.state','diagnostics');
  const file = path.join(directory,crypto.randomUUID()+'.json');
  const persist = () => {
    const temp = file+'.tmp';
    try {
      fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(temp,JSON.stringify(sanitizeFacts(facts))+'\n',{mode:0o600});
      fs.renameSync(temp,file);
    } catch { /* Diagnostic storage cannot change the tool result. */ }
    finally { try {fs.rmSync(temp,{force:true});} catch {} }
  };
  return {
    deps:{...deps, async delegate(provider,request,mode) {
      const result = await deps.delegate(provider,request,mode);
      try {
        const slot = /^([A-Za-z0-9_-]+\[\d+\])\.log$/.exec(path.basename(request.logPath))?.[1];
        facts.invocations.push(...result.invocations.map((i): InvocationFacts => {
          const usage = i.usage && i.launched && i.usage.scope !== 'session-cumulative' ? normalizeUsage(i.usage,i.usage.inputSemantics) : undefined;
          return {
            phase, provider:i.provider, model:i.model ?? 'default', mode:i.mode, surface:'cli', launched:i.launched, outcome:i.outcome,
            ...(slot ? {slot} : {}), ...(i.effort ? {effort:i.effort} : {}),
            ...(i.durationMs === undefined ? {} : {durationMs:i.durationMs}),
            ...(usage ? {usage} : {}),
            ...(i.usage?.actualModels ? {reportedModels:i.usage.actualModels} : {}),
          };
        }));
        persist();
      } catch { /* Malformed optional runner metadata cannot change its outcome. */ }
      return result;
    }},
    finish(outcome) {
      facts.phases = [{key:phase,name,outcome:outcome.ok ? 'ok' : outcome.reason ?? 'fault',wallMs:Math.max(0,deps.clock()-started)}];
      persist();
    },
  };
}

export function optionalDiagnostics(session: string, fold: Fold, outcome: string): string | undefined {
  try { return writeDiagnostics(session,sessionFacts(session,fold,outcome)); }
  catch { return undefined; }
}
