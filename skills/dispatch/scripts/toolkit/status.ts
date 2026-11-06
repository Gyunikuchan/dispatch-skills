import { cleanupBinding, latestCleanup, criterionStatuses, eligibility } from './evidence.ts';
import { currentHashes, foldLedger, gate, latest } from './ledger.ts';
import fs from 'node:fs';
import path from 'node:path';
import type {CliDeps} from './cli.ts';
import {parsePlan} from './domain/plan.ts';
import {checks} from './plan-view.ts';
import {writerStates} from './writers.ts';
import {integrationRecord} from './integration.ts';
import {gitOk,headTree,testedTree} from './git.ts';
import {admission,type ReviewBudget} from './findings.ts';
import {contentReports, closingNotesFor, rerunNotesFor, rerunCoverSeq, coversReport, read as readFindings} from './findings.ts';
import type {FindingsValue} from './findings.ts';
import {applicableReviewIds} from './confirmations.ts';
import {readManifest} from '../lib/session.ts';

export async function statusReport(session: string, repositoryRoot: string, deps: CliDeps) {
  const fold = foldLedger(session);
  const level = latest(fold, 'level')?.data['level'] ?? 'medium';
  const bound = latest(fold, 'bind')?.data ?? {};
  const current = currentHashes(repositoryRoot, bound);
  const escalations = new Map<string, Record<string, unknown>>();
  for (const record of fold.records) {
    if (record.kind === 'escalation') escalations.set(record.data['id'], record.data);
  }
  // Advisory and recomputed from the latest ledger by the launch admission policy; it opens and grants nothing.
  const root = path.join(session, '.state/reviews'), reviews: Record<string, ReviewBudget> = {};
  for (const entry of fs.existsSync(root) ? fs.readdirSync(root, {withFileTypes: true}) : []) {
    if (!entry.isDirectory()) continue;
    const {budget, rounds} = admission(session, fold, entry.name, 0, applicableReviewIds(readManifest(session), fold).get(entry.name));
    if (rounds) reviews[entry.name] = budget;
  }
  const openRepositoryChanges: {review: string; round: number; reportSeq: number; repositoryChanges?: unknown; repositoryCheck?: unknown; rerunPending?: true}[] = [];
  for (const entry of fs.existsSync(root) ? fs.readdirSync(root, {withFileTypes: true}) : []) {
    if (!entry.isDirectory()) continue;
    const review = entry.name;
    const reviewDir = path.join(root, review);
    let roundDirs: string[] = [];
    try {
      roundDirs = fs.readdirSync(reviewDir);
    } catch {
      continue;
    }
    const readRoundMeta = (round: number): {startSeq: number; roster: string[]; scope?: string; coverage?: 'open' | 'full'} | undefined => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(reviewDir, 'round-' + round, 'round.json'), 'utf8')) as {startSeq?: number; roster?: {slot: string; reserve?: boolean}[]; scope?: string; coverage?: 'open' | 'full'};
        if (typeof meta.startSeq !== 'number' || !Array.isArray(meta.roster)) return undefined;
        return {startSeq: meta.startSeq, roster: meta.roster.filter(slot => !slot.reserve).map(slot => slot.slot), ...(typeof meta.scope === 'string' ? {scope: meta.scope} : {}), ...(meta.coverage !== undefined ? {coverage: meta.coverage} : {})};
      } catch {
        return undefined;
      }
    };
    for (const roundName of roundDirs) {
      const match = /^round-(\d+)$/.exec(roundName);
      if (!match) continue;
      const round = Number(match[1]);
      // Every content report carries its own identity; covered reports drop
      // out before the merge, so one map accumulates every unacknowledged
      // attempt and generation together with the finalized findings report.
      const contents = contentReports(session, review, round);
      if (!contents.length) continue;
      const covered = (seq: number): boolean => closingNotesFor(fold, review, round).some(note => coversReport(note, seq));
      const satisfiedFor = (seq: number): boolean => {
        if (!rerunNotesFor(fold, review, round).some(note => rerunCoverSeq(session, review, round, note) === seq)) return false;
        if (!fs.existsSync(path.join(reviewDir, 'round-' + (round + 1), 'findings.json'))) return false;
        const opened = readRoundMeta(round + 1);
        const required = readRoundMeta(round)?.roster;
        const wholeTarget = opened?.scope?.startsWith('Full review') === true || opened?.coverage !== undefined;
        return opened !== undefined && required !== undefined && wholeTarget &&
          opened.startSeq >= Math.max(...rerunNotesFor(fold, review, round).filter(note => rerunCoverSeq(session, review, round, note) === seq).map(note => note.seq)) && required.every(target => opened.roster.includes(target));
      };
      let uncovered = contents.filter(report => !covered(report.seq) && !satisfiedFor(report.seq));
      if (!uncovered.length) continue;
      const pathsByCwd = new Map<string, Set<string>>();
      for (const report of uncovered) {
        if (!Array.isArray(report.repositoryChanges)) continue;
        for (const change of report.repositoryChanges as {cwd?: unknown; paths?: unknown}[]) {
          if (typeof change?.cwd !== 'string' || !Array.isArray(change?.paths)) continue;
          const paths = pathsByCwd.get(change.cwd) ?? new Set<string>();
          for (const file of change.paths) if (typeof file === 'string') paths.add(file);
          pathsByCwd.set(change.cwd, paths);
        }
      }
      let check: unknown;
      for (const report of uncovered) if (report.repositoryCheck) check = report.repositoryCheck;
      const reportSeq = Math.max(...uncovered.map(report => report.seq));
      // A rerun decision binds only its covered report, and only while round
      // r+1 is unfinalized: past that window the report stays open for a
      // repository-changes note, with no lingering rerunPending.
      const nextOpen = !fs.existsSync(path.join(reviewDir, 'round-' + (round + 1), 'findings.json'));
      const covering = nextOpen && rerunNotesFor(fold, review, round).some(note => rerunCoverSeq(session, review, round, note) === reportSeq);
      const rerunPending = covering ? {rerunPending: true as const} : {};
      openRepositoryChanges.push({review, round, reportSeq,
        ...(pathsByCwd.size ? {repositoryChanges: [...pathsByCwd].map(([cwd, paths]) => ({cwd, paths: [...paths].sort()}))} : {}),
        ...(check ? {repositoryCheck: check} : {}), ...rerunPending});
    }
  }
  openRepositoryChanges.sort((left, right) => (left.review < right.review ? -1 : left.review > right.review ? 1 : left.round - right.round));
  let sections: object = {};
  const opened=integrationRecord(fold);
  if(opened || fold.records.some(record=>record.kind==='writer')) {
    let plan: import('./domain/types.ts').ParsedPlan | undefined;
    let reason = 'No bound plan';
    if (bound['plan']) {
      try {
        const parsed = parsePlan(fs.readFileSync(path.resolve(repositoryRoot, bound['plan']), 'utf8'));
        if (parsed.ok) plan = parsed.plan;
        else reason = JSON.stringify(parsed.defects);
      } catch (error) { reason = 'Bound plan unreadable: ' + (error as Error).message; }
    }
    const unavailable = {state: 'unavailable', reason};
    const observations=new Map<string,{exists:boolean;dirty:boolean;head:string}>();
    for(const record of (plan ? fold.records : []).filter(record=>record.kind==='writer' && record.data['phase']==='launched')) {
      const relative=record.data['path'] as string;
      if(observations.has(relative)) continue;
      const cwd=path.resolve(session,relative); const exists=fs.existsSync(cwd);
      observations.set(relative,{exists,dirty:exists ? !!await gitOk(deps,cwd,['status','--porcelain']) : false,head:exists ? await gitOk(deps,cwd,['rev-parse','HEAD']) : ''});
    }
    const writers=plan ? writerStates(fold,plan.tasks.map(task=>task.id),relative=>observations.get(relative)!) : unavailable;
    let integration: object|null=null;
    let evidenceStatuses: import('./evidence.ts').CriterionStatus[]=[];
    let criteria: string[] | typeof unavailable=plan ? checks(plan).map(check=>check.criterion) : unavailable;
    if(opened) {
      const cwd=path.resolve(session,opened.data['path']); const exists=fs.existsSync(cwd);
      const head=exists ? await gitOk(deps,cwd,['rev-parse','HEAD']) : null;
      const started=fold.records.findLast(record=>record.kind==='integrate' && record.data['phase']==='started');
      const pending=started && !fold.records.some(record=>record.kind==='integrate' && record.seq>started.seq && record.data['task']===started.data['task'] && ['done','abandoned'].includes(record.data['phase']));
      const conflict=pending ? fold.records.findLast(record=>record.kind==='integrate' && record.data['phase']==='conflict' && record.seq>started!.seq)?.data ?? null : null;
      const delivered=fold.records.findLast(record=>record.kind==='integrate' && record.data['phase']==='delivered');
      integration={source:delivered?.data['source']??null,to:null,path:opened.data['path'],branch:opened.data['branch'],head,state:exists?'present':'missing',pendingConflict:conflict,undelivered:head!==null && head!==(delivered?.data['source']??opened.data['base']),closed:fold.records.some(record=>record.kind==='integrate' && record.data['phase']==='closed' && record.seq>opened.seq)};
      if(exists && plan) {
        try {
          const tree={headTree:await headTree(deps,cwd),testedTree:await testedTree(deps,session,cwd)};
          const cleanup=cleanupBinding(fold),all=checks(plan);
          evidenceStatuses=criterionStatuses(fold,all,tree,cleanup);
          const kept=eligibility(fold,all.filter(check=>!cleanup?.removed.includes(check.criterion)),tree);
          criteria=all.map(check=>evidenceStatuses.find(row=>row.criterion===check.criterion&&cleanup?.removed.includes(check.criterion))??kept.find(row=>row.criterion===check.criterion)!).filter(row=>row.state!=='verified').map(row=>row.criterion);
        } catch {criteria=checks(plan).map(c=>c.criterion);}
      }
    }
    sections={writers,integration,criteria,criterionStatuses:evidenceStatuses};
  }
  return {
    level, bound, current, approved: latest(fold, 'approval')?.data ?? {},
    gate: gate(fold, current, level),
    escalations: [...escalations.values()].filter(record => record['state'] === 'open'),
    reviews, recordCount: fold.records.length, tornTail: fold.torn !== null,
    ...(openRepositoryChanges.length ? {openRepositoryChanges} : {}),
    testCleanup: (() => { const row = latestCleanup(fold); return row ? {from: row.data['from'], removed: row.data['removed'], deleted: row.data['deleted'], merged: row.data['merged']} : null; })(),
    ...sections,
  };
}
