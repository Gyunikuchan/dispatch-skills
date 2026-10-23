import { currentHashes, foldLedger, gate, latest } from './ledger.ts';
import fs from 'node:fs';
import path from 'node:path';
import type {CliDeps} from './cli.ts';
import {parsePlan} from './domain/plan.ts';
import {checks} from './plan-view.ts';
import {writerStates} from './writers.ts';
import {integrationRecord} from './integration.ts';
import {gitOk,headTree,testedTree} from './git.ts';
import {eligibility} from './evidence.ts';

export async function statusReport(session: string, repositoryRoot: string, deps: CliDeps) {
  const fold = foldLedger(session);
  const level = latest(fold, 'level')?.data['level'] ?? 'medium';
  const bound = latest(fold, 'bind')?.data ?? {};
  const current = currentHashes(repositoryRoot, bound);
  const escalations = new Map<string, Record<string, unknown>>();
  for (const record of fold.records) {
    if (record.kind === 'escalation') escalations.set(record.data['id'], record.data);
  }
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
    let criteria: string[] | typeof unavailable=plan ? checks(plan).map(check=>check.criterion) : unavailable;
    if(opened) {
      const cwd=path.resolve(session,opened.data['path']); const exists=fs.existsSync(cwd);
      const head=exists ? await gitOk(deps,cwd,['rev-parse','HEAD']) : null;
      const started=fold.records.findLast(record=>record.kind==='integrate' && record.data['phase']==='started');
      const pending=started && !fold.records.some(record=>record.kind==='integrate' && record.seq>started.seq && record.data['task']===started.data['task'] && ['done','abandoned'].includes(record.data['phase']));
      const conflict=pending ? fold.records.findLast(record=>record.kind==='integrate' && record.data['phase']==='conflict' && record.seq>started!.seq)?.data ?? null : null;
      const delivered=fold.records.findLast(record=>record.kind==='integrate' && record.data['phase']==='delivered');
      integration={path:opened.data['path'],branch:opened.data['branch'],head,state:exists?'present':'missing',pendingConflict:conflict,undelivered:head!==null && head!==(delivered?.data['to']??opened.data['base']),closed:fold.records.some(record=>record.kind==='integrate' && record.data['phase']==='closed' && record.seq>opened.seq)};
      if(exists && plan) criteria=eligibility(fold,checks(plan),{headTree:await headTree(deps,cwd),testedTree:await testedTree(deps,session,cwd)}).filter(row=>row.state==='missing').map(row=>row.criterion);
    }
    sections={writers,integration,criteria};
  }
  return {
    level, bound, current, approved: latest(fold, 'approval')?.data ?? {},
    gate: gate(fold, current, level),
    escalations: [...escalations.values()].filter(record => record['state'] === 'open'),
    recordCount: fold.records.length, tornTail: fold.torn !== null,
    ...sections,
  };
}
