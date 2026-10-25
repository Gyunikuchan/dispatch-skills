import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { readManifest } from '../lib/session.ts';
import { readQuotaState, publishQuotaFailure } from '../lib/quota-store.ts';
import { H, quotaSnapshot } from '../policy/quota.ts';
import { next, reservePool, takeReserve } from '../policy/cascade.ts';
import { resolveRoster, type Roster, type ReadDelegate, type PhasePolicy } from '../policy/roster.ts';
import { SPECS, isProviderId } from '../providers/index.ts';
import type { ProviderId, RunOutcome } from '../providers/types.ts';
import type { CliDeps } from './cli.ts';
import type { RosterSlot } from './domain/types.ts';
import type { DiagnosticEvent } from './domain/diagnostics.ts';
import type { Level } from './types.ts';

type FailureClass = Extract<RunOutcome, {status: 'fail'}>['cls'];
export type Validation = {ok: true; text?: string} | {ok: false; cls: FailureClass; reason: string};
export type SlotOutcome = {slot: string} & (
  {state: 'done'; text: string} |
  {state: 'native'; promptPath: string; replyPath: string; error?: string} |
  {state: 'failed'; cls: FailureClass; reason: string}
);
type FanOutInput = {
  dir: string; slots: readonly RosterSlot[] | Roster;
  prompt: string | ((slot: RosterSlot) => string);
  validate: (text: string) => Validation; cwd?: string;
  quota?: ReturnType<typeof quotaSnapshot>;
};

export function resolveSlots(kind: 'ask' | 'plan' | 'design' | 'code', level: Level, deps: CliDeps): Roster {
  const {config} = loadConfig(deps.skillRoot);
  const phases = config['phases'] as Record<string, PhasePolicy>;
  return resolveRoster({level, readDelegates: config['read-delegates'] as Record<string, ReadDelegate>,
    orchestrator: deps.orchestrator, liveness: deps.liveness,
    ...(kind === 'ask' ? {} : {policy: phases[kind === 'code' ? 'code-review' : 'plan-review']})});
}

function sessionOf(directory: string): string {
  let current = path.resolve(directory);
  for (;;) {
    if (fs.existsSync(path.join(current, 'manifest.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Fan-out directory has no session manifest ancestor');
    current = parent;
  }
}

function atomic(file: string, value: unknown): void {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600});
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, {force: true}); }
}

export async function fanOut(input: FanOutInput, deps: CliDeps): Promise<SlotOutcome[]> {
  const ordinals=new Map<string,number>();
  const emit=(slot:RosterSlot,event:Omit<DiagnosticEvent,'subject'|'slot'|'provider'|'model'|'attempt'> & Record<string,unknown>)=>{
    if(!deps.diagnostics)return;
    try {deps.diagnostics({...event,subject:input.dir,slot:slot.slot,provider:slot.provider,
      model:typeof slot.model==='string'?slot.model:undefined,attempt:ordinals.get(slot.slot)??0} as DiagnosticEvent);}catch{}
  };
  const all = Array.isArray(input.slots) ? input.slots as readonly RosterSlot[] :
    [...(input.slots as Roster).targets, ...(input.slots as Roster).reserves];
  const targets = all.filter(slot => !slot.reserve);
  const reserves = all.filter(slot => slot.reserve);
  const pool = {current: reservePool(reserves.slice(0, 1).map(slot => slot.slot))};
  const session = sessionOf(input.dir), manifest = readManifest(session);
  const cwd = input.cwd ?? manifest.repositoryRoot;
  const store = {sessionDir: session, repositoryRoot: manifest.repositoryRoot, bucketWidth: H};
  const deadline = deps.clock() + 30 * 60 * 1000;
  // Reused outcomes need no quota reads; each launched key keeps one frozen decision.
  const decisions = new Map<string, ReturnType<typeof quotaSnapshot>['decisions'][number]>();
  const quotaFor = (provider: ProviderId, model: string | null, mode: string) => {
    const key = {provider,model,mode}, id = JSON.stringify(key);
    if (input.quota) return input.quota.decisions.find(row =>
      row.key.provider === provider && row.key.model === model && row.key.mode === mode);
    if (!decisions.has(id)) {
      const state = readQuotaState(store,[key],deps.clock());
      decisions.set(id,quotaSnapshot([key],state.generations,state.observations,deps.clock()).decisions[0]!);
    }
    return decisions.get(id)!;
  };
  for (const dir of ['prompts','slots','replies','logs']) fs.mkdirSync(path.join(input.dir, dir), {recursive: true});
  const name = (slot: string) => {
    if (!/^[A-Za-z0-9_-]+\[\d+\]$/.test(slot)) throw new Error('Invalid roster slot ' + slot);
    return slot;
  };
  const fileOf = (slot: RosterSlot) => path.join(input.dir, 'slots', name(slot.slot) + '.json');
  const native = (slot: RosterSlot): SlotOutcome => {emit(slot,{kind:'native',state:'pending'});return {slot: slot.slot, state: 'native',
    promptPath: path.join(input.dir, 'prompts', name(slot.slot) + '.md'),
    replyPath: path.join(input.dir, 'replies', name(slot.slot) + '.md')};};
  const save = async (slot: RosterSlot, outcome: SlotOutcome) => {
    atomic(fileOf(slot), outcome);
    emit(slot,{kind:'slot',state:outcome.state,...(outcome.state==='failed'?{cls:outcome.cls}:{})});
    await deps.hook?.('fanout:after-slot');
    return outcome;
  };

  const voice = async (slot: RosterSlot, promptPath: string): Promise<SlotOutcome> => {
    if (slot.native) return native(slot);
    if (!isProviderId(slot.provider)) return {slot: slot.slot, state:'failed',cls:'config',reason:'Unknown provider ' + slot.provider};
    const provider = slot.provider, modes = deps.modes(provider);
    const models = slot.model === undefined ? [null] : typeof slot.model === 'string' ? [slot.model] : slot.model;
    if (!modes.length) return {slot:slot.slot,state:'failed',cls:'not-found',reason:'No launchable ' + provider + ' binary'};
    const config = {slot: slot.slot, platform: provider, models, modes, modeCascadeOn:SPECS[provider].modeCascadeOn};
    let position = {model:0,mode:0};
    for (;;) {
      const remaining = deadline - deps.clock();
      if (remaining <= 0) return {slot:slot.slot,state:'failed',cls:'timeout',reason:'Fan-out deadline passed'};
      const model = models[position.model] ?? null, mode = modes[position.mode]!;
      const decision = quotaFor(provider,model,mode);
      let failure: Extract<Validation,{ok:false}>;
      if (decision?.skipped) failure = {ok:false,cls:'quota',reason:'skipped-quota: quota-cooldown'};
      else {
        const logPath = path.join(input.dir,'logs',name(slot.slot) + '.log');
        ordinals.set(slot.slot,(ordinals.get(slot.slot)??0)+1);
        const result = await deps.delegate(provider, {
          promptPath,model,effort:slot.effort ?? null,sandbox:slot.sandbox ?? true,schemaPath:null,resume:null,cwd,
          timeoutMs:remaining,outputCapBytes:10*1024*1024,attachments:[],logPath,briefPath:logPath+'.spill.md',
          configSelectors:Object.fromEntries(['OPENCODE_CONFIG','OPENCODE_CONFIG_DIR'].flatMap(key =>
            deps.env[key] === undefined ? [] : [[key,deps.env[key]!]])),
        },mode);
        if(result.outcome.status === 'ok') {
          const checked = input.validate(result.outcome.text);
          emit(slot,{kind:'validation',surface:'cli',outcome:checked.ok?'ok':checked.cls});
          if(checked.ok) return {slot:slot.slot,state:'done',text:checked.text ?? result.outcome.text};
          failure = checked;
        } else {
          failure = {ok:false,cls:result.outcome.cls,reason:result.outcome.detail};
          if(failure.cls === 'quota' && decision?.generation)
            publishQuotaFailure(store,{provider,model,mode},decision.generation,deps.clock());
        }
      }
      const cascade = next(failure.cls,position,config);
      emit(slot,{kind:'routing',state:cascade.kind==='terminal'?'stop':cascade.kind,cls:failure.cls});
      if(cascade.kind === 'next-model' || cascade.kind === 'next-mode') {position=cascade.position;continue;}
      return {slot:slot.slot,state:'failed',cls:failure.cls,reason:failure.reason};
    }
  };

  const savedOutcomes = new Map<string, SlotOutcome>();
  for (const slot of targets) {
    const file = fileOf(slot);
    let saved: SlotOutcome | undefined;
    try { saved=JSON.parse(fs.readFileSync(file,'utf8')) as SlotOutcome; }
    catch(error) {if((error as NodeJS.ErrnoException).code !== 'ENOENT')throw error;}
    if(saved?.state === 'native' && fs.existsSync(saved.replyPath)) {
      const text=fs.readFileSync(saved.replyPath,'utf8'), checked=input.validate(text);
      emit(slot,{kind:'validation',surface:'native',outcome:checked.ok?'ok':checked.cls});
      emit(slot,{kind:'native',state:checked.ok?'completed':'invalid',replay:true});
      if(checked.ok) saved={slot:slot.slot,state:'done',text:checked.text ?? text};
      else {
        let suffix=1;while(fs.existsSync(saved.replyPath+'.invalid-'+suffix))suffix++;
        fs.renameSync(saved.replyPath,saved.replyPath+'.invalid-'+suffix);
        saved={...saved,error:checked.reason};
      }
      atomic(file,saved);
    }
    if(saved && saved.state !== 'failed') savedOutcomes.set(slot.slot,saved);
  }
  const results = await Promise.allSettled(targets.map(async slot => {
    const saved=savedOutcomes.get(slot.slot);
    if(saved){emit(slot,{kind:'slot',state:saved.state,replay:true});return saved;}
    const promptPath = path.join(input.dir,'prompts',name(slot.slot)+'.md');
    fs.writeFileSync(promptPath,typeof input.prompt === 'string' ? input.prompt : input.prompt(slot),{mode:0o600});
    let outcome=await voice(slot,promptPath);
    if(outcome.state === 'failed') {
      const cascade=next(outcome.cls,{model:0,mode:0},{slot:slot.slot,platform:slot.provider,models:[],modes:[],modeCascadeOn:[]},
        {orchestratorPlatform:deps.orchestrator?.platform ?? null,reserveAvailable:pool.current.used.length === 0 && reserves.length > 0 && deps.clock()<deadline});
      emit(slot,{kind:'routing',state:cascade.kind==='terminal'?'stop':cascade.kind,cls:outcome.cls});
      if(cascade.kind === 'reserve') {
        const taken=takeReserve(pool.current,slot.slot,outcome.reason);pool.current=taken.pool;
        const reserve=reserves.find(entry=>entry.slot===taken.reserve);
        if(reserve) {
          const substitute=await voice(reserve,promptPath);
          emit(reserve,{kind:'slot',state:substitute.state,targetSlot:slot.slot,...(substitute.state==='failed'?{cls:substitute.cls}:{})});
          outcome=substitute.state === 'native' ? native(slot) : {...substitute,slot:slot.slot};
        }
      } else if(cascade.kind === 'native-fallback')outcome=native(slot);
    }
    return save(slot,outcome);
  }));
  const rejected=results.find(result=>result.status === 'rejected');
  if(rejected?.status === 'rejected')throw rejected.reason;
  return results.map(result=>(result as PromiseFulfilledResult<SlotOutcome>).value);
}
