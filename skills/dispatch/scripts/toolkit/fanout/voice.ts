import fs from 'node:fs';
import path from 'node:path';
import type { loadReadCommands } from '../../lib/config.ts';
import { currentPlatform } from '../../lib/platform.ts';
import { readQuotaState, publishQuotaFailure } from '../../lib/quota-store.ts';
import { validSessionId } from '../../lib/session.ts';
import { next } from '../../policy/cascade.ts';
import { quotaSnapshot } from '../../policy/quota.ts';
import { SPECS, isProviderId } from '../../providers/index.ts';
import { sumSessionUsage, CONTINUE_PROMPT } from '../../providers/runner.ts';
import type { ProviderId, Invocation, LaunchRequest, ProcessResult, UsageBaseline } from '../../providers/types.ts';
import type { CliDeps } from '../cli.ts';
import type { RosterSlot } from '../domain/types.ts';
import type { DiagnosticUsage } from '../types.ts';
import { atomic, mergeBlocked, type BlockedAttempt, type Emit, type FanOutInput, type SlotOutcome, type Validation, type slotFiles } from './state.ts';

export const VOICE_DEADLINE_MS = 30 * 60 * 1000;

function savedUsage(value: unknown): DiagnosticUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const counters = (part: unknown): boolean => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
    const fields = part as Record<string, unknown>;
    return ['input','output','cacheRead','cacheWrite','cacheWrite5m','cacheWrite1h','reasoning'].every(key =>
      fields[key] === undefined ? key !== 'input' && key !== 'output' : typeof fields[key] === 'number' && Number.isFinite(fields[key]) && (fields[key] as number) >= 0);
  };
  if (!counters(row) || row['scope'] !== 'invocation' || (row['provenance'] !== 'session' && row['provenance'] !== 'stdout') || row['inputSemantics'] !== 'uncached') return undefined;
  if (row['actualModels'] !== undefined && (!Array.isArray(row['actualModels']) || !row['actualModels'].every(item => typeof item === 'string'))) return undefined;
  if (row['models'] !== undefined && (!row['models'] || typeof row['models'] !== 'object' || Array.isArray(row['models']) || !Object.values(row['models']).every(counters))) return undefined;
  return value as DiagnosticUsage;
}
const MAX_REPORT_RESUMES = 3;

export function cliVoice(input: Pick<FanOutInput, 'dir' | 'quota' | 'sessionRoot' | 'validate'>, deps: Pick<CliDeps, 'clock' | 'modes' | 'delegate' | 'env'>, ports: {
  cwd: string; store: Parameters<typeof readQuotaState>[0]; deadline: number; readCommands: ReturnType<typeof loadReadCommands>;
  rerun: boolean; files: Pick<ReturnType<typeof slotFiles>, 'name' | 'readSaved'>; emit: Emit; beginAttempt: (logical: string) => void;
}) {
  const {cwd, store, deadline, readCommands, rerun, files: {name, readSaved}, emit, beginAttempt} = ports;
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

  // A report resume asks the same session for only the final report. Its prompt
  // sits beside the voice prompt because the runner reads the body from promptPath.
  const reportResumePromptPath = (promptPath: string): string =>
    path.join(path.dirname(promptPath), path.basename(promptPath, '.md') + '.no-report.md');
  const reportResumePrompt = (reason: string): string =>
    `Your previous answer did not include a valid final report.\n\nValidation failure: ${reason}\n\nReply with only the final JSON report in the required format (a JSON object with "status" and "findings", plus "confirmations" with requestId, decision and rationale for every assigned confirmation request). Do not repeat the review.\n`;

  const voiceCLI = async (physical: RosterSlot, logicalSlot: string, promptPath: string): Promise<SlotOutcome> => {
    if (!isProviderId(physical.provider)) return {slot: physical.slot, state:'failed',cls:'config',reason:'Unknown provider ' + physical.provider};
    const provider = physical.provider, modes = deps.modes(provider);
    const models = physical.model === undefined ? [null] : typeof physical.model === 'string' ? [physical.model] : physical.model;
    if (!modes.length) return {slot:physical.slot,state:'failed',cls:'not-found',reason:'No launchable ' + provider + ' binary'};
    let blocked: BlockedAttempt[] = [];
    const config = {slot: physical.slot, platform: provider, models, modes, modeCascadeOn:SPECS[provider].modeCascadeOn};
    let position = {model:0,mode:0};
    const targetForEmit: RosterSlot = {...physical, slot: logicalSlot};
    // A reserve runs on its own 30-minute budget from its start; targets share the wave deadline.
    const voiceDeadline = physical.reserve ? deps.clock() + VOICE_DEADLINE_MS : deadline;
    let resumesUsed = 0, reportResumes = 0, resumeSessionId: string | null = null;
    let sessionUsage: DiagnosticUsage | undefined;
    let usageBaseline: UsageBaseline = 'cumulative';
    let usageWindowEndMs: number | undefined;
    const logPath = path.join(input.dir,'logs',name(logicalSlot) + '.log');
    const statePath = path.join(input.dir,'logs',name(logicalSlot) + '.state.json');
    let restart: string | undefined, crossRun = false, pending: 'stall' | 'report' = 'stall';
    type SlotState = {physicalSlot: string; provider: string; model: string | null; position: {model: number; mode: number}; pending: 'stall' | 'report'; resumesUsed: number; reportResumes: number; sessionId: string | null; sessionUsage?: DiagnosticUsage; usageBaseline?: UsageBaseline; usageWindowEndMs?: number};
    let saved: Partial<SlotState> | undefined;
    const priorOutcome = rerun ? readSaved(logicalSlot) : undefined;
    if (priorOutcome?.state === 'done' || priorOutcome?.state === 'failed') restart = 'saved outcome retake';
    else {
      try { const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Partial<SlotState>; else restart = 'stale: unreadable state'; }
      catch { if (rerun) restart = 'stale: missing or unreadable state'; }
    }
    let leftover = '', logPreserved = true;
    try { leftover = fs.readFileSync(logPath, 'utf8'); if (leftover) fs.appendFileSync(logPath + '.stalled', leftover); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logPreserved = false; }
    if (saved) {
      const pos = saved.position;
      const validBaseline: UsageBaseline | undefined = saved.usageBaseline === 'cumulative' || saved.usageBaseline === 'none' ? saved.usageBaseline : undefined;
      const validWindowEnd = typeof saved.usageWindowEndMs === 'number' && Number.isFinite(saved.usageWindowEndMs) ? saved.usageWindowEndMs : undefined;
      if (saved.physicalSlot !== physical.slot || saved.provider !== provider || !pos || typeof pos.model !== 'number' || typeof pos.mode !== 'number' || !Number.isInteger(pos.model) || !Number.isInteger(pos.mode) || pos.model < 0 || pos.model >= models.length || pos.mode < 0 || pos.mode >= modes.length || saved.model !== (models[pos.model] ?? null)) restart = 'stale: slot, provider, model or position changed';
      else if (SPECS[provider].resumeUsage === 'cumulative' && saved.sessionUsage !== undefined && !savedUsage(saved.sessionUsage)) restart = 'stale: invalid session usage';
      else if (saved.pending === 'report' && !fs.existsSync(reportResumePromptPath(promptPath))) restart = 'stale: missing report prompt';
      else if (typeof saved.resumesUsed !== 'number' || typeof saved.reportResumes !== 'number' || !Number.isInteger(saved.resumesUsed) || saved.resumesUsed < 0 || saved.resumesUsed >= 3 || !Number.isInteger(saved.reportResumes) || saved.reportResumes < 0 || saved.reportResumes > MAX_REPORT_RESUMES || (saved.pending !== 'stall' && saved.pending !== 'report')) restart = 'stale: invalid resume state';
      else {
        let id = validSessionId(saved.sessionId);
        if (!id && leftover && SPECS[provider].attemptSession) {
          try {
            const output: ProcessResult = {exit:null,signal:null,stdout:leftover,stdoutPath:logPath,stderrTail:'',durationMs:0,timedOut:false,truncated:false};
            const request: LaunchRequest = {binary:'',prompt:'',briefFile:null,schemaText:null,platform:currentPlatform(),promptPath,model:models[pos.model] ?? null,effort:physical.effort ?? null,sandbox:physical.sandbox ?? true,schemaPath:null,resume:null,cwd,timeoutMs:0,outputCapBytes:0,attachments:[],logPath,briefPath:logPath+'.spill.md'};
            id = validSessionId(SPECS[provider].attemptSession!(output, request));
          } catch {}
        }
        if (!id) restart = 'stale: no valid session ID';
        else if (SPECS[provider].resumeUsage === 'cumulative' && validBaseline === undefined) restart = 'stale: invalid session usage';
        else { position = pos; resumesUsed = saved.resumesUsed; reportResumes = saved.reportResumes; resumeSessionId = id; pending = saved.pending; sessionUsage = SPECS[provider].resumeUsage === 'cumulative' ? savedUsage(saved.sessionUsage) : undefined; usageBaseline = SPECS[provider].resumeUsage === 'cumulative' ? validBaseline! : (validBaseline ?? 'none'); usageWindowEndMs = validWindowEnd; crossRun = true; }
      }
    }
    let stateEnabled = logPreserved;
    const checkpoint = (model: string | null) => {
      if (!stateEnabled) return;
      try { atomic(statePath,{physicalSlot:physical.slot,provider,model,position,pending,resumesUsed,reportResumes,sessionId:resumeSessionId,usageBaseline,...(usageWindowEndMs !== undefined ? {usageWindowEndMs} : {}),...(restart ? {restart} : {}),...(sessionUsage && SPECS[provider].resumeUsage === 'cumulative' ? {sessionUsage} : {})}); }
      catch { stateEnabled = false; try { fs.rmSync(statePath,{force:true}); } catch {} }
    };
    for (;;) {
      const remaining = voiceDeadline - deps.clock();
      if (remaining <= 0) return {slot:physical.slot,state:'failed',cls:'timeout',reason:'Fan-out deadline passed', ...(blocked.length ? {blocked} : {})};
      const model = models[position.model] ?? null, mode = modes[position.mode]!;
      const decision = quotaFor(provider,model,mode);
      let failure: Extract<Validation,{ok:false}>;
      if (decision?.skipped) failure = {ok:false,cls:'quota',reason:'skipped-quota: quota-cooldown'};
      else {
        for (;;) {
          const budget = voiceDeadline - deps.clock();
          if (budget <= 0) { failure = {ok:false,cls:'timeout',reason:'Fan-out deadline passed'}; break; }
          beginAttempt(logicalSlot);
          stateEnabled = logPreserved;
          if (!resumeSessionId) {
            sessionUsage = undefined;
            usageBaseline = 'cumulative';
            usageWindowEndMs = undefined;
            // Clear the previous attempt before publishing a fresh session checkpoint.
            try { if (fs.existsSync(logPath) && logPreserved) { const old = fs.readFileSync(logPath); if (old.length && !leftover) fs.appendFileSync(logPath + '.stalled', old); fs.writeFileSync(logPath, ''); } } catch { stateEnabled = false; try { fs.rmSync(statePath,{force:true}); } catch {} }
          }
          leftover = '';
          const continued = crossRun && pending === 'stall';
          if (continued) resumesUsed++;
          const continuePath = promptPath + '.continue.md';
          if (continued) fs.writeFileSync(continuePath, CONTINUE_PROMPT, {mode:0o600});
          checkpoint(model);
          const observed = new Set<Invocation>();
          let resumeCallback = false;
          const recordUsage = (row: Invocation) => {
            if (row.usageBaseline !== undefined) usageBaseline = row.usageBaseline;
            if (row.usageWindowEndMs !== undefined) usageWindowEndMs = row.usageWindowEndMs;
            if (SPECS[provider].resumeUsage === 'cumulative' && row.usage) {
              try { sessionUsage = sumSessionUsage([sessionUsage, row.usage]); } catch { sessionUsage = undefined; }
            }
            checkpoint(model);
          };
          let result: Awaited<ReturnType<CliDeps['delegate']>>;
          try { result = await deps.delegate(provider, {
            promptPath: continued ? continuePath : pending === 'report' && resumeSessionId ? reportResumePromptPath(promptPath) : promptPath,
            model,effort:physical.effort ?? null,sandbox:physical.sandbox ?? true,schemaPath:null,resume:resumeSessionId,cwd,
            resumesUsed,...(resumeSessionId && sessionUsage ? {priorUsage:sessionUsage} : {}),usageBaseline,...(usageWindowEndMs !== undefined ? {usageWindowEndMs} : {}),timeoutMs:budget,outputCapBytes:SPECS[provider].outputCapBytes ?? 10*1024*1024,attachments:[],logPath,briefPath:logPath+'.spill.md',
            onResume: (id, count) => { resumeCallback = true; resumeSessionId = id; resumesUsed = count; pending = 'stall'; checkpoint(model); },
            onInvocation: row => { if (!observed.has(row)) { observed.add(row); recordUsage(row); } },
            configSelectors:Object.fromEntries(['OPENCODE_CONFIG','OPENCODE_CONFIG_DIR'].flatMap(key =>
              deps.env[key] === undefined ? [] : [[key,deps.env[key]!]])),readCommands,
            ...(input.sessionRoot === undefined ? {} : {sessionRoot: input.sessionRoot}),
            ...(logicalSlot === physical.slot ? {} : {targetSlot: logicalSlot}),
          },mode); } catch (error) {
            if (!crossRun) throw error;
            crossRun = false; restart = 'failed cross-run resume: launch error';
            resumesUsed = 0; reportResumes = 0; resumeSessionId = null; sessionUsage = undefined; usageBaseline = 'cumulative'; usageWindowEndMs = undefined; pending = 'stall';
            continue;
          }
          for (const row of result.invocations) if (!observed.has(row)) recordUsage(row);
          // Fakes may return rows without invoking the callback. Wrap-up resumes ride outside the stall count.
          if (!resumeCallback) resumesUsed += result.invocations.slice(1).filter(invocation => invocation.nudge === true && invocation.wrapUp !== true).length;
          if (result.outcome.status === 'ok') resumeSessionId = validSessionId(result.outcome.sessionId) ?? resumeSessionId;
          checkpoint(model);
          if (crossRun && result.outcome.status === 'fail') {
            crossRun = false; restart = 'failed cross-run resume: ' + result.outcome.cls;
            resumesUsed = 0; reportResumes = 0; resumeSessionId = null; sessionUsage = undefined; usageBaseline = 'cumulative'; usageWindowEndMs = undefined; pending = 'stall';
            continue;
          }
          crossRun = false;
          if(result.outcome.status === 'ok') {
            const checked = input.validate(result.outcome.text, logicalSlot);
            emit(targetForEmit,{kind:'validation',surface:'cli',outcome:checked.ok?'ok':checked.cls});
            if(checked.ok) return {slot:logicalSlot,state:'done',text:checked.text ?? result.outcome.text,responder:{slot:physical.slot,provider,model,native:false}, ...(blocked.length ? {blocked} : {})};
            failure = checked;
            if(checked.blocked) blocked=mergeBlocked(blocked,[{provider, model, ...checked.blocked}]);
            const sessionId = validSessionId(result.outcome.sessionId);
            if (sessionId !== null) resumeSessionId = sessionId;
            if (checked.cls === 'no-report' && resumeSessionId !== null && reportResumes < MAX_REPORT_RESUMES && deps.clock() < voiceDeadline) {
              reportResumes += 1; pending = 'report';
              try { fs.copyFileSync(logPath, logPath + '.no-report'); } catch {}
              fs.writeFileSync(reportResumePromptPath(promptPath), reportResumePrompt(checked.reason), {mode: 0o600});
              continue;
            }
          } else {
            failure = {ok:false,cls:result.outcome.cls,reason:result.outcome.detail};
            if(failure.cls === 'quota' && decision?.generation)
              publishQuotaFailure(store,{provider,model,mode},decision.generation,deps.clock());
          }
          break;
        }
      }
      const cascade = next(failure.cls,position,config);
      emit(targetForEmit,{kind:'routing',state:cascade.kind==='terminal'?'stop':cascade.kind,cls:failure.cls});
      if(cascade.kind === 'next-model' || cascade.kind === 'next-mode') {position=cascade.position;resumesUsed=0;reportResumes=0;resumeSessionId=null;sessionUsage=undefined;usageBaseline='cumulative';usageWindowEndMs=undefined;pending='stall';continue;}
      return {slot:physical.slot,state:'failed',cls:failure.cls,reason:failure.reason, ...(blocked.length ? {blocked} : {})};
    }
  };
  return voiceCLI;
}
