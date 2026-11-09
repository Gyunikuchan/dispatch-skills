import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadReadCommands } from '../lib/config.ts';
import { readManifest } from '../lib/session.ts';
import { readQuotaState, publishQuotaFailure } from '../lib/quota-store.ts';
import { H, quotaSnapshot } from '../policy/quota.ts';
import { next, failureDisposition } from '../policy/cascade.ts';
import { resolveRoster, nativeFirstRoute, normalizeProvider, type Roster, type ReadDelegate, type PhasePolicy, type Underfill } from '../policy/roster.ts';
import { opencodeSubagentModels } from '../lib/platform.ts';
import { SPECS, isProviderId } from '../providers/index.ts';
import type { ProviderId, RunOutcome } from '../providers/types.ts';
import { sessionScope, formatSafetyPrompt } from '../providers/runner.ts';
import { nodeRunnerFs } from '../providers/node-process.ts';
import { sanitizeText } from './domain/sanitize.ts';
import type { CliDeps } from './cli.ts';
import type { RosterSlot } from './domain/types.ts';
import type { DiagnosticEvent } from './domain/diagnostics.ts';
import { ToolError } from './output.ts';
import type { Level } from './types.ts';

const newNativeReply = (cwd: string, replyPath: string) => `\n\n## Native reply\n\nWork in \`${cwd}\` for reads and Git commands.\n\nWrite the reply that the instructions above require, in their exact format, to \`${replyPath}\`; do not return it inline. Then reply only \`wrote ${replyPath}\`, or \`BLOCKED: <reason>\` when you cannot write it.\n`;

type FailureClass = Extract<RunOutcome, {status: 'fail'}>['cls'];
export type BlockedAttempt = {provider: string; model: string | null; reason: string; reasonHash: string};
export type Validation = {ok: true; text?: string} | {ok: false; cls: FailureClass; reason: string; blocked?: {reason: string; reasonHash: string}};
export type SlotOutcome = {slot: string; blocked?: BlockedAttempt[]} & (
  {state: 'done'; text: string; responder?: {slot: string; provider: string; model: string | null; native: boolean; effort?: string}} |
  {state: 'native'; promptPath: string; replyPath: string; provider: string; attempt: string; cwd: string; model?: string | readonly string[]; effort?: string; subagentModels?: string[]; error?: string; cliFallback?: true; nativeError?: string} |
  {state: 'failed'; cls: FailureClass; reason: string; cliOnly?: true}
);
export type NativeFailure = {attempt: string; reason: string; reasonHash: string};

/** Native launch fields share one shape: provider opencode carries one `P/M#E` (or `P/M`) value per model. */
const nativeSubagentModels = (provider: string, model: string | readonly string[] | undefined, effort: string | undefined): string[] | undefined => {
  if (normalizeProvider(provider) !== 'opencode') return undefined;
  const models = model === undefined ? undefined : typeof model === 'string' ? [model] : [...model];
  return opencodeSubagentModels(models, effort ?? null);
};
type FanOutInput = {
  dir: string; slots: readonly RosterSlot[] | Roster;
  prompt: string | ((slot: RosterSlot) => string);
  validate: (text: string, logicalSlot: string) => Validation; cwd?: string;
  /** Active session directory; forwarded so the delegate guard can exempt its artifacts. */
  sessionRoot?: string;
  quota?: ReturnType<typeof quotaSnapshot>;
  onFailed?: (slot: string, outcome: Extract<SlotOutcome, {state: 'failed'}>) => void;
  nativeFirstProviders?: readonly string[];
  nativeFailures?: readonly NativeFailure[];
  onIgnoredReport?: (attempt: string) => void;
};

export function resolveSlots(kind: 'ask' | 'plan' | 'design' | 'code', level: Level, deps: CliDeps): Roster & {nativeFirstProviders: string[]} {
  const {config} = loadConfig(deps.skillRoot);
  const phases = config['phases'] as Record<string, PhasePolicy>;
  const readDelegates = config['read-delegates'] as Record<string, ReadDelegate>;
  const roster = resolveRoster({level, readDelegates,
    orchestrator: deps.orchestrator, liveness: deps.liveness, ...(deps.sandboxSupported ? {sandboxSupported: deps.sandboxSupported} : {}),
    ...(kind === 'ask' ? {} : {policy: phases[kind === 'code' ? 'code-review' : 'plan-review']})});
  const seen = new Set<string>();
  const nativeFirstProviders: string[] = [];
  for (const key of Object.keys(readDelegates)) {
    const normalized = normalizeProvider(key);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (nativeFirstRoute(key, readDelegates, deps.orchestrator)) nativeFirstProviders.push(normalized);
  }
  return {...roster, nativeFirstProviders};
}

export function underfillNote(roster: {underfill?: Underfill}): string {
  const u = roster.underfill;
  if (!u) return '';
  return `; underfill ${u.resolved}/${u.configured} targets, host ${u.host ?? 'undetected'}, excluded native-only: ${u.excluded.join(', ') || 'none'}${u.sandboxUnsupported?.length ? `, sandbox unsupported: ${u.sandboxUnsupported.join(', ')}` : ''}`;
}

type FanoutState = {nativeFirst?: true; cliWaveDone?: true; reserveUsedBy?: string; nativeLaunched?: true};

export function cliWaveState(dir: string): 'pending' | 'done' | undefined {
  let raw: string;
  try { raw = fs.readFileSync(path.join(dir, 'fanout.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let data: FanoutState;
  try { data = JSON.parse(raw) as FanoutState; } catch { return undefined; }
  if (!data.nativeFirst) return undefined;
  return data.cliWaveDone ? 'done' : 'pending';
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

/** One entry per logical blocked attempt: repeated modes keep the same alias once, distinct reasons stay apart. */
function mergeBlocked(...lists: readonly (readonly BlockedAttempt[] | undefined)[]): BlockedAttempt[] {
  const out: BlockedAttempt[] = [];
  for (const list of lists) for (const entry of list ?? []) {
    if (out.some(item => item.provider === entry.provider && item.model === entry.model && item.reasonHash === entry.reasonHash)) continue;
    out.push(entry);
  }
  return out;
}

// Step 1 of the fallback transition only: persist the marker with the
// native error and merged blocked evidence, without running the CLI
// cascade. The deferred wave resumes the cascade, so the marker never
// returns as a launchable pending voice.
function persistDeferredMarker(
  file: string,
  nativeSaved: Extract<SlotOutcome, {state: 'native'}>,
  nativeError: string,
  extraBlocked?: BlockedAttempt[],
): void {
  const merged = mergeBlocked(nativeSaved.blocked, extraBlocked);
  atomic(file, {...nativeSaved, cliFallback: true as const, nativeError, ...(merged.length ? {blocked: merged} : {})});
}

function readState(dir: string): FanoutState {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'fanout.json'), 'utf8')) as FanoutState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

function writeState(dir: string, state: FanoutState): void {
  atomic(path.join(dir, 'fanout.json'), state);
}

function firstModelOf(slot: {model?: string | readonly string[] | undefined}): string | null {
  if (slot.model === undefined) return null;
  if (typeof slot.model === 'string') return slot.model;
  return slot.model[0] ?? null;
}

function isNativeFirstSlot(slot: RosterSlot, providers: readonly string[] | undefined): boolean {
  return !slot.native && !slot.reserve && isNativeFirstProvider(slot.provider, providers);
}

function isNativeFirstProvider(provider: string, providers: readonly string[] | undefined): boolean {
  if (!providers?.length) return false;
  const normalized = normalizeProvider(provider);
  return providers.some(candidate => normalizeProvider(candidate) === normalized);
}

function makeNonce(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 6);
}

function parseBlockedFile(text: string): {isBlocked: boolean; raw: string} {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.startsWith('BLOCKED:')) return {isBlocked: false, raw: trimmed};
  const raw = trimmed.slice('BLOCKED:'.length).trim();
  return {isBlocked: true, raw};
}

function blockedEntry(provider: string, model: string | null, rawTrimmed: string): BlockedAttempt {
  const reason = sanitizeText(rawTrimmed).slice(0, 200) || '(reason removed by sanitizer)';
  return {provider, model, reason, reasonHash: crypto.createHash('sha256').update(rawTrimmed).digest('hex')};
}

function reportIsBlocked(reason: string): boolean {
  return reason.startsWith('BLOCKED:');
}

function reportBlockedRaw(reason: string): string {
  // CLI passes sanitized "BLOCKED: <sanitized>" and hashes the extracted raw.
  // Recover the extracted part for identity; fall back to the whole reason.
  if (!reason.startsWith('BLOCKED:')) return reason.trim();
  return reason.slice('BLOCKED:'.length).trim();
}

// Display form of a failure reason: reported BLOCKED evidence wins, the
// protocol marker recovers its raw text, anything else keeps its wording.
function blockedDisplayOf(reason: string, evidence?: BlockedAttempt[]): string {
  if (evidence?.[0]?.reason) return evidence[0].reason;
  const raw = reportIsBlocked(reason) ? reportBlockedRaw(reason) : reason.trim();
  return sanitizeText(raw).slice(0, 200) || '(reason removed by sanitizer)';
}

// Blocked evidence for a reported attempt, attributed to the voice that ran it.
function reportEvidence(native: {provider: string; model?: string | readonly string[]}, report: NativeFailure): BlockedAttempt[] | undefined {
  if (!reportIsBlocked(report.reason)) return undefined;
  return [{provider: native.provider, model: firstModelOf(native), reason: blockedDisplayOf(report.reason), reasonHash: report.reasonHash}];
}

export async function fanOut(input: FanOutInput, deps: CliDeps): Promise<SlotOutcome[]> {
  const ordinals=new Map<string,number>();
  const emit=(slot:{slot:string;provider:string;model?:string|readonly string[]|undefined},event:Omit<DiagnosticEvent,'subject'|'slot'|'provider'|'model'|'attempt'> & Record<string,unknown>)=>{
    if(!deps.diagnostics)return;
    try {deps.diagnostics({...event,subject:input.dir,slot:slot.slot,provider:slot.provider,
      model:typeof slot.model==='string'?slot.model:(Array.isArray(slot.model)?slot.model[0]??undefined:undefined),attempt:ordinals.get(slot.slot)??0} as DiagnosticEvent);}catch{}
  };
  // Native events name the voice that launched: a reserve attempt reports the reserve's provider and model under the logical slot.
  const attemptOf = (logical: RosterSlot, voice: {provider: string; model?: string | readonly string[]}) => ({slot: logical.slot, provider: voice.provider, model: voice.model});
  const all = Array.isArray(input.slots) ? input.slots as readonly RosterSlot[] :
    [...(input.slots as Roster).targets, ...(input.slots as Roster).reserves];
  const targets = all.filter(slot => !slot.reserve);
  const reserves = all.filter(slot => slot.reserve);
  const firstReserve = reserves.slice(0, 1)[0];
  const nativeFirstProviders = input.nativeFirstProviders ?? [];
  const nativeFailures = input.nativeFailures ?? [];
  const session = sessionOf(input.dir), manifest = readManifest(session);
  const cwd = input.cwd ?? manifest.repositoryRoot;
  const store = {sessionDir: session, repositoryRoot: manifest.repositoryRoot, bucketWidth: H};
  const deadline = deps.clock() + 30 * 60 * 1000;
  const readCommands = loadReadCommands(deps.skillRoot);
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
  const fileOfLogical = (logical: string) => path.join(input.dir, 'slots', name(logical) + '.json');
  const basePathOf = (logical: string) => path.join(input.dir, 'prompts', name(logical) + '.md');
  const nativePathOf = (logical: string) => path.join(input.dir, 'prompts', name(logical) + '.native.md');
  const replyPathFor = (logical: string, nonce: string) => path.join(input.dir, 'replies', `${name(logical)}.${nonce}.md`);
  const oldReplyPathOf = (logical: string) => path.join(input.dir, 'replies', name(logical) + '.md');

  const readSaved = (logical: string): SlotOutcome | undefined => {
    try { return JSON.parse(fs.readFileSync(fileOfLogical(logical), 'utf8')) as SlotOutcome; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };

  const saveLogical = async (target: RosterSlot, outcome: SlotOutcome) => {
    // CLI-only-ness is crash-consistent: the marker rides the atomic failed write.
    // A lost write means no saved failed to retake; an old file without the marker
    // fails closed to no-retake. Any native history bars the marker: the prompt
    // file, a still-pending native attempt, or a prior failed save without the
    // marker (which itself saw native history).
    const hasNativeHistory = (logical: string): boolean => {
      try {
        if (fs.existsSync(nativePathOf(logical))) return true;
      } catch {
        return true;
      }
      try {
        const prior = readSaved(logical);
        if (prior?.state === 'native') return true;
        if (prior?.state === 'failed' && (prior as {cliOnly?: true}).cliOnly !== true) return true;
      } catch {
        return true;
      }
      return false;
    };
    let toSave = outcome;
    if (outcome.state === 'failed' && !target.native && !hasNativeHistory(target.slot)) {
      toSave = {...outcome, cliOnly: true as const};
    }
    if (toSave.state === 'failed') input.onFailed?.(toSave.slot, toSave as Extract<SlotOutcome, {state: 'failed'}>);
    atomic(fileOfLogical(target.slot), toSave);
    emit(target,{kind:'slot',state:toSave.state,...(toSave.state==='failed'?{cls:toSave.cls}:{})});
    await deps.hook?.('fanout:after-slot');
    return toSave;
  };

  const baseTextOf = (slot: RosterSlot): string => typeof input.prompt === 'string' ? input.prompt : input.prompt(slot);

  const buildNativePrompt = (baseText: string, replyPath: string): string => {
    const scope = sessionScope(input.sessionRoot, nodeRunnerFs);
    const guarded = formatSafetyPrompt(baseText, {...scope, ...(cwd ? {workspaceRoot: cwd} : {})});
    return `${guarded}\n\n[REPLY FILE EXCEPTION]: You may write only to \`${replyPath}\`; all other project file writes stay denied.\n` + newNativeReply(cwd, replyPath);
  };

  const createNativeOnly = (slot: RosterSlot): Extract<SlotOutcome, {state: 'native'}> => {
    const baseText = baseTextOf(slot);
    const baseFile = basePathOf(slot.slot);
    try { fs.writeFileSync(baseFile, baseText, {mode: 0o600}); } catch {}
    const replyPath = oldReplyPathOf(slot.slot);
    const nonce = makeNonce();
    const attempt = `${slot.slot}#${nonce}`;
    emit(slot,{kind:'native',state:'pending'});
    // Native-only keeps its prompt path and base text: base plus the reply section naming the working directory.
    try {
      const current = fs.readFileSync(baseFile, 'utf8');
      if (!current.includes('## Native reply')) fs.appendFileSync(baseFile, newNativeReply(cwd, replyPath));
    } catch { fs.writeFileSync(baseFile, baseText + newNativeReply(cwd, replyPath), {mode: 0o600}); }
    const subagentModels = nativeSubagentModels(slot.provider, slot.model, slot.effort);
    const outcome: Extract<SlotOutcome, {state: 'native'}> = {
      slot: slot.slot, state: 'native', promptPath: baseFile, replyPath,
      provider: slot.provider, attempt, cwd,
      ...(slot.model !== undefined ? {model: slot.model} : {}),
      ...(slot.effort !== undefined ? {effort: slot.effort} : {}),
      ...(subagentModels !== undefined ? {subagentModels} : {}),
    };
    markNativeLaunched();
    return outcome;
  };

  const createNativeFirst = (logical: RosterSlot, physical: RosterSlot): Extract<SlotOutcome, {state: 'native'}> => {
    const baseText = baseTextOf(logical);
    const baseFile = basePathOf(logical.slot);
    try {
      if (!fs.existsSync(baseFile)) fs.writeFileSync(baseFile, baseText, {mode: 0o600});
    } catch { fs.writeFileSync(baseFile, baseText, {mode: 0o600}); }
    const nonce = makeNonce();
    const attempt = `${physical.slot}#${nonce}`;
    const replyPath = replyPathFor(logical.slot, nonce);
    const nativeFile = nativePathOf(logical.slot);
    fs.writeFileSync(nativeFile, buildNativePrompt(baseText, replyPath), {mode: 0o600});
    emit(attemptOf(logical, physical),{kind:'native',state:'pending'});
    markNativeLaunched();
    const subagentModels = nativeSubagentModels(physical.provider, physical.model, physical.effort);
    return {
      slot: logical.slot, state: 'native', promptPath: nativeFile, replyPath,
      provider: physical.provider, attempt, cwd,
      ...(physical.model !== undefined ? {model: physical.model} : {}),
      ...(physical.effort !== undefined ? {effort: physical.effort} : {}),
      ...(subagentModels !== undefined ? {subagentModels} : {}),
    };
  };

  const invalidateReply = (replyPath: string): void => {
    if (!fs.existsSync(replyPath)) return;
    let suffix = 1;
    while (fs.existsSync(`${replyPath}.invalid-${suffix}`)) suffix++;
    const target = `${replyPath}.invalid-${suffix}`;
    try {
      fs.renameSync(replyPath, target);
      return;
    } catch (error) {
      // A sharing violation or permission error leaves the rejected reply in
      // place while an unconfirmed native handle may still change it: never
      // treat quarantine as done. Preserve the evidence under the quarantine
      // name, then surface when the original cannot be removed.
      fs.copyFileSync(replyPath, target);
      try {
        fs.rmSync(replyPath);
      } catch {
        throw new Error(`Cannot quarantine rejected reply ${replyPath}: ${(error as Error).message}`);
      }
    }
  };

  // An invalid native reply is quarantined and the attempt stays pending with the checked reason and evidence.
  const markInvalid = (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, checked: Extract<Validation, {ok: false}>): SlotOutcome => {
    invalidateReply(native.replyPath);
    const blocked = checked.blocked ? mergeBlocked(native.blocked, [{provider: native.provider, model: firstModelOf(native), ...checked.blocked}]) : native.blocked;
    const pending: SlotOutcome = {...native, error: checked.reason, ...(blocked?.length ? {blocked} : {})};
    atomic(fileOfLogical(slot.slot), pending);
    return pending;
  };

  const voiceCLI = async (physical: RosterSlot, logicalSlot: string, promptPath: string): Promise<SlotOutcome> => {
    if (!isProviderId(physical.provider)) return {slot: physical.slot, state:'failed',cls:'config',reason:'Unknown provider ' + physical.provider};
    const provider = physical.provider, modes = deps.modes(provider);
    const models = physical.model === undefined ? [null] : typeof physical.model === 'string' ? [physical.model] : physical.model;
    if (!modes.length) return {slot:physical.slot,state:'failed',cls:'not-found',reason:'No launchable ' + provider + ' binary'};
    let blocked: BlockedAttempt[] = [];
    const config = {slot: physical.slot, platform: provider, models, modes, modeCascadeOn:SPECS[provider].modeCascadeOn};
    let position = {model:0,mode:0};
    const targetForEmit: RosterSlot = {...physical, slot: logicalSlot};
    for (;;) {
      const remaining = deadline - deps.clock();
      if (remaining <= 0) return {slot:physical.slot,state:'failed',cls:'timeout',reason:'Fan-out deadline passed', ...(blocked.length ? {blocked} : {})};
      const model = models[position.model] ?? null, mode = modes[position.mode]!;
      const decision = quotaFor(provider,model,mode);
      let failure: Extract<Validation,{ok:false}>;
      if (decision?.skipped) failure = {ok:false,cls:'quota',reason:'skipped-quota: quota-cooldown'};
      else {
        const logPath = path.join(input.dir,'logs',name(logicalSlot) + '.log');
        ordinals.set(logicalSlot,(ordinals.get(logicalSlot)??0)+1);
        const result = await deps.delegate(provider, {
          promptPath,model,effort:physical.effort ?? null,sandbox:physical.sandbox ?? true,schemaPath:null,resume:null,cwd,
          timeoutMs:remaining,outputCapBytes:SPECS[provider].outputCapBytes ?? 10*1024*1024,attachments:[],logPath,briefPath:logPath+'.spill.md',
          configSelectors:Object.fromEntries(['OPENCODE_CONFIG','OPENCODE_CONFIG_DIR'].flatMap(key =>
            deps.env[key] === undefined ? [] : [[key,deps.env[key]!]])),readCommands,
          ...(input.sessionRoot === undefined ? {} : {sessionRoot: input.sessionRoot}),
          ...(logicalSlot === physical.slot ? {} : {targetSlot: logicalSlot}),
        },mode);
        if(result.outcome.status === 'ok') {
          const checked = input.validate(result.outcome.text, logicalSlot);
          emit(targetForEmit,{kind:'validation',surface:'cli',outcome:checked.ok?'ok':checked.cls});
          if(checked.ok) return {slot:logicalSlot,state:'done',text:checked.text ?? result.outcome.text,responder:{slot:physical.slot,provider,model,native:false}, ...(blocked.length ? {blocked} : {})};
          failure = checked;
          if(checked.blocked) blocked=mergeBlocked(blocked,[{provider, model, ...checked.blocked}]);
        } else {
          failure = {ok:false,cls:result.outcome.cls,reason:result.outcome.detail};
          if(failure.cls === 'quota' && decision?.generation)
            publishQuotaFailure(store,{provider,model,mode},decision.generation,deps.clock());
        }
      }
      const cascade = next(failure.cls,position,config);
      emit(targetForEmit,{kind:'routing',state:cascade.kind==='terminal'?'stop':cascade.kind,cls:failure.cls});
      if(cascade.kind === 'next-model' || cascade.kind === 'next-mode') {position=cascade.position;continue;}
      return {slot:physical.slot,state:'failed',cls:failure.cls,reason:failure.reason, ...(blocked.length ? {blocked} : {})};
    }
  };

  // One fallback transition for a saved native attempt, in this order:
  // (1) atomic slot file write with cliFallback, the native error and merged
  // blocked evidence; (2) rename any reply to .invalid-<n>; (3) run the
  // physical provider's CLI cascade from the base prompt under the logical
  // slot; (4) on CLI failure a non-substitute takes the reserve once, else the
  // slot saves failed. A substitute (physical.slot !== logical slot) never
  // takes a second reserve, and a native-only attempt whose provider is no
  // longer the host saves failed without minting a descriptor. The current
  // host never runs its CLI: it takes the reserve or saves failed.
  const fallbackToCli = async (
    logical: RosterSlot,
    nativeSaved: Extract<SlotOutcome, {state: 'native'}>,
    nativeError: string,
    extraBlocked?: BlockedAttempt[],
  ): Promise<SlotOutcome> => {
    const merged = mergeBlocked(nativeSaved.blocked, extraBlocked);
    // Fail closed on the recorded error: the exact external marker, or an
    // internal 'blocked: ' reason with its blocked evidence.
    const blockedFailure = reportIsBlocked(nativeError) || (nativeError.startsWith('blocked: ') && merged.length > 0);
    const display = blockedDisplayOf(nativeError, extraBlocked);
    const withFallback = {...nativeSaved, cliFallback: true as const, nativeError, ...(merged.length ? {blocked: merged} : {})};
    atomic(fileOfLogical(logical.slot), withFallback);
    emit(attemptOf(logical, nativeSaved), {kind: 'native', state: 'failed'});
    invalidateReply(nativeSaved.replyPath);
    const {physical} = routeForNative(nativeSaved);
    const failedForHost = (): Extract<SlotOutcome, {state: 'failed'}> => ({slot: logical.slot, state: 'failed', cls: blockedFailure ? 'blocked' : 'refusal', reason: (blockedFailure ? 'blocked: ' : 'refusal: ') + display, ...(merged.length ? {blocked: merged} : {})});
    if (physical !== undefined && isCurrentHost(physical.provider)) {
      const failed = failedForHost();
      const isReserveSubstitute = physical.slot !== logical.slot;
      if (!isReserveSubstitute && reserveAllowed(logical.slot, failed.cls)) {
        const baseFile = basePathOf(logical.slot);
        fs.writeFileSync(baseFile, baseTextOf(logical), {mode: 0o600});
        const launched = await takeReserve(logical, failed, baseFile);
        if (launched) return launched.state === 'native' ? launched : saveLogical(logical, launched);
      }
      return saveLogical(logical, failed);
    }
    if (physical === undefined || physical.native) {
      const failed: Extract<SlotOutcome, {state: 'failed'}> = {slot: logical.slot, state: 'failed', cls: blockedFailure ? 'blocked' : 'refusal', reason: (blockedFailure ? 'blocked: ' : 'refusal: ') + display, ...(merged.length ? {blocked: merged} : {})};
      return saveLogical(logical, failed);
    }
    const baseFile = basePathOf(logical.slot);
    if (!fs.existsSync(baseFile)) fs.writeFileSync(baseFile, baseTextOf(logical), {mode: 0o600});
    let cliOutcome = await voiceCLI(physical, logical.slot, baseFile);
    if (merged.length) cliOutcome = {...cliOutcome, blocked: mergeBlocked(merged, cliOutcome.blocked)} as SlotOutcome;
    if (cliOutcome.state === 'failed') {
      const isReserveSubstitute = physical.slot !== logical.slot;
      if (!isReserveSubstitute && reserveAllowed(logical.slot, cliOutcome.cls)) {
        const launched = await takeReserve(logical, cliOutcome, baseFile);
        if (launched) return launched.state === 'native' ? launched : saveLogical(logical, launched);
      }
      return saveLogical(logical, {...cliOutcome, slot: logical.slot} as SlotOutcome);
    }
    const doneOutcome = {...cliOutcome, slot: logical.slot} as SlotOutcome;
    return saveLogical(logical, doneOutcome);
  };

  const hasNativeFirstNow = targets.some(slot => isNativeFirstSlot(slot, nativeFirstProviders));
  let state = readState(input.dir);
  const useNativeWave = hasNativeFirstNow || !!state.nativeFirst;
  // Reserve ownership persists across calls; in-memory copy guards concurrent targets in one call.
  let reserveOwner: string | undefined = state.reserveUsedBy;

  const persistReserveOwner = (owner: string): void => {
    reserveOwner = owner;
    state = {...state, reserveUsedBy: owner};
    writeState(input.dir, state);
  };

  // Synchronous claim before any async launch: check and claim stay adjacent
  // with no await between, so concurrent cascades cannot double-claim.
  const claimReserve = (logical: string): void => {
    if (reserveOwner !== logical) persistReserveOwner(logical);
  };

  // Durable per-generation evidence that a native voice launched, covering
  // every native descriptor (native-first, native-only, reserve
  // substitutes). The change check reads it to tell a lost baseline from a
  // round that never needed one. It never affects routing: only nativeFirst
  // selects the wave path.
  const markNativeLaunched = (): void => {
    if (state.nativeLaunched === true) return;
    state = {...state, nativeLaunched: true};
    writeState(input.dir, state);
  };

  const isCurrentHost = (provider: string): boolean => {
    const host = deps.orchestrator?.platform;
    if (!host) return false;
    return normalizeProvider(provider) === normalizeProvider(host);
  };

  // A saved native consumes on its physical route: native-first, or a
  // native-only attempt from the current host (mirrors the CLI-only
  // routeTrue/nativeOnlyAttempt check above). Anything else runs the physical
  // provider's CLI fallback.
  const physicalRouteOk = (physical: RosterSlot | undefined, provider: string): boolean => {
    const current = physical?.provider ?? provider;
    if (isNativeFirstProvider(current, nativeFirstProviders)) return true;
    return (physical?.native ?? false) && isCurrentHost(current);
  };

  // A done owner frees the reserve only when it never consumed it: a CLI
  // substitute saves done under the owner with the reserve as responder, and
  // a consumed native substitute answers natively as the reserve provider. A
  // pending native substitute for the reserve, or a fallback still running
  // under the owner, keeps holding it, so substitutes stay single-use.
  const reserveConsumedBy = (ownerSaved: SlotOutcome | undefined): boolean => {
    if (ownerSaved === undefined || firstReserve === undefined) return false;
    if (ownerSaved.state === 'done') {
      const responder = ownerSaved.responder;
      if (responder?.slot === firstReserve.slot) return true;
      if (responder?.native === true && responder?.provider === firstReserve.provider) return true;
      return false;
    }
    if (ownerSaved.state === 'native') {
      if (ownerSaved.attempt.split('#')[0] === firstReserve.slot) return true;
      if (ownerSaved.cliFallback === true) return true;
    }
    return false;
  };

  const reserveAvailableFor = (logical: string): boolean => {
    if (!firstReserve) return false;
    if (deps.clock() >= deadline) return false;
    if (reserveOwner !== undefined && reserveOwner !== logical) {
      // A recorded owner that no longer holds the reserve releases it for
      // another eligible target: a failed CLI-only retake (the plan
      // exception), or a done owner that never consumed the reserve. A
      // pending native attempt, a fallback rerun, an interrupted reservation
      // (a native prompt on disk under a cliOnly failure), or a substitute
      // (CLI or native) that already ran stays with its owner, so reserve
      // substitutes stay single-use.
      let released = false;
      try {
        const ownerSaved = readSaved(reserveOwner);
        released = (ownerSaved?.state === 'done' && !reserveConsumedBy(ownerSaved)) ||
          (ownerSaved?.state === 'failed' && (ownerSaved as {cliOnly?: true}).cliOnly === true && !fs.existsSync(nativePathOf(reserveOwner)));
      } catch {
        released = false;
      }
      if (!released) return false;
    }
    if (reserveOwner === logical) {
      const saved = readSaved(logical);
      if (saved === undefined) return true;
      if (saved.state === 'native' && (saved as {cliFallback?: true}).cliFallback) return true;
      // A saved failed outcome with a durable cliOnly marker may retake, which
      // also resumes an interrupted native reservation for its owner. A lost
      // marker fails closed to no-retake.
      if (saved.state === 'failed' && (saved as {cliOnly?: true}).cliOnly === true) return true;
      return false;
    }
    return true;
  };

  const reserveAllowed = (logical: string, cls: FailureClass): boolean => {
    if (failureDisposition(cls) === 'terminal-run') return false;
    return reserveAvailableFor(logical);
  };

  // A reserve launches only through takeReserve: an off-host native-only
  // reserve keeps the failed outcome, so routing matches that gate instead
  // of advertising a reserve that can never launch.
  const reserveLaunchable = (logical: string, cls: FailureClass): boolean => {
    if (!reserveAllowed(logical, cls) || firstReserve === undefined) return false;
    return !(firstReserve.native && !isCurrentHost(firstReserve.provider));
  };

  // A native-only reserve never runs the CLI: mint its descriptor under the
  // logical slot, mirroring the fallbackToCli and CLI-only reserve branches.
  // Callers gate on isCurrentHost; an off-host native-only reserve keeps the
  // failed outcome instead of running voiceCLI.
  const createNativeOnlyReserve = (logical: RosterSlot, reserve: RosterSlot, failed: SlotOutcome): SlotOutcome => {
    const nonce = makeNonce();
    const baseText = baseTextOf(logical);
    const baseFile = basePathOf(logical.slot);
    try {
      if (!fs.existsSync(baseFile)) fs.writeFileSync(baseFile, baseText, {mode: 0o600});
    } catch { fs.writeFileSync(baseFile, baseText, {mode: 0o600}); }
    const replyPath = oldReplyPathOf(logical.slot);
    emit(attemptOf(logical, reserve), {kind:'native',state:'pending'});
    try {
      const current = fs.readFileSync(baseFile, 'utf8');
      if (!current.includes('## Native reply')) fs.appendFileSync(baseFile, newNativeReply(cwd, replyPath));
    } catch { fs.writeFileSync(baseFile, baseText + newNativeReply(cwd, replyPath), {mode: 0o600}); }
    const subagentModels = nativeSubagentModels(reserve.provider, reserve.model, reserve.effort);
    const created: Extract<SlotOutcome, {state: 'native'}> = {
      slot: logical.slot, state: 'native', promptPath: baseFile, replyPath,
      provider: reserve.provider, attempt: `${reserve.slot}#${nonce}`, cwd,
      ...(reserve.model !== undefined ? {model: reserve.model} : {}),
      ...(reserve.effort !== undefined ? {effort: reserve.effort} : {}),
      ...(subagentModels !== undefined ? {subagentModels} : {}),
    };
    const withBlocked = failed.blocked?.length ? {...created, blocked: mergeBlocked(created.blocked, failed.blocked)} : created;
    markNativeLaunched();
    atomic(fileOfLogical(logical.slot), withBlocked);
    emit(logical, {kind: 'slot', state: 'native'});
    return withBlocked;
  };

  const findPhysical = (slotId: string): RosterSlot | undefined => all.find(entry => entry.slot === slotId);

  // ONE per-slot native resolution shared by every path: physical route
  // BEFORE substitution (missing physical fails closed on saved evidence,
  // no CLI under the wrong voice) and the exact BLOCKED report marker in
  // every report and replay path.
  const routeForNative = (saved: {attempt: string; provider: string}): {physical: RosterSlot | undefined; routeOk: boolean; first: boolean} => {
    const physical = findPhysical(saved.attempt.split('#')[0] ?? '');
    return {physical, routeOk: physical !== undefined && physicalRouteOk(physical, saved.provider), first: isNativeFirstProvider(physical?.provider ?? saved.provider, nativeFirstProviders)};
  };
  // One reserve gate for every path: native-first descriptor, native-only on
  // current host, keep failed off-host, CLI only for non-native. The current
  // host never runs its CLI: a host reserve mints a native descriptor.
  const takeReserve = async (logical: RosterSlot, failed: SlotOutcome, promptPath: string): Promise<SlotOutcome | undefined> => {
    if (!firstReserve) return undefined;
    if (isNativeFirstProvider(firstReserve.provider, nativeFirstProviders) && !firstReserve.native) {
      const native = createNativeFirst(logical, firstReserve);
      const withBlocked = failed.blocked?.length ? {...native, blocked: mergeBlocked(native.blocked, failed.blocked)} : native;
      claimReserve(logical.slot);
      atomic(fileOfLogical(logical.slot), withBlocked);
      emit(logical, {kind:'slot', state:'native'});
      return withBlocked;
    }
    if (firstReserve.native) {
      if (!isCurrentHost(firstReserve.provider)) return undefined;
      claimReserve(logical.slot);
      return createNativeOnlyReserve(logical, firstReserve, failed);
    }
    if (isCurrentHost(firstReserve.provider)) {
      const native = createNativeFirst(logical, firstReserve);
      const withBlocked = failed.blocked?.length ? {...native, blocked: mergeBlocked(native.blocked, failed.blocked)} : native;
      claimReserve(logical.slot);
      atomic(fileOfLogical(logical.slot), withBlocked);
      emit(logical, {kind:'slot', state:'native'});
      return withBlocked;
    }
    claimReserve(logical.slot);
    const substitute = await voiceCLI(firstReserve, logical.slot, promptPath);
    emit(firstReserve, {kind:'slot', state:substitute.state, targetSlot:logical.slot, ...(substitute.state === 'failed' ? {cls: substitute.cls} : {})});
    const blocked = mergeBlocked(failed.blocked, substitute.blocked);
    return {...substitute, slot: logical.slot, ...(blocked.length?{blocked}:{})} as SlotOutcome;
  };
  // A reported native failure ends its attempt. External reports use the exact
  // 'BLOCKED:' marker only; any other casing is a refusal, not the protocol marker.
  // A current-host attempt that is not a substitute takes its reserve when allowed.
  const saveReportFailure = async (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, report: NativeFailure): Promise<SlotOutcome> => {
    const sanitized = blockedDisplayOf(report.reason);
    invalidateReply(native.replyPath);
    emit(attemptOf(slot, native), {kind: 'native', state: 'failed'});
    const attemptSlot = native.attempt.split('#')[0] ?? '';
    const isSubstitute = attemptSlot !== slot.slot;
    if (isCurrentHost(native.provider) && !isSubstitute) {
      const blockedForHost = reportIsBlocked(report.reason) ? mergeBlocked(native.blocked, reportEvidence(native, report)) : native.blocked;
      const failed: Extract<SlotOutcome, {state: 'failed'}> = reportIsBlocked(report.reason)
        ? {slot: slot.slot, state: 'failed', cls: 'blocked', reason: 'blocked: ' + sanitized, ...(blockedForHost?.length ? {blocked: blockedForHost} : {})}
        : {slot: slot.slot, state: 'failed', cls: 'refusal', reason: 'refusal: ' + sanitized, ...(blockedForHost?.length ? {blocked: blockedForHost} : {})};
      if (reserveAllowed(slot.slot, failed.cls)) {
        const baseFile = basePathOf(slot.slot);
        fs.writeFileSync(baseFile, baseTextOf(slot), {mode: 0o600});
        const launched = await takeReserve(slot, failed, baseFile);
        if (launched) return launched.state === 'native' ? launched : saveLogical(slot, launched);
      }
      return saveLogical(slot, failed);
    }
    if (reportIsBlocked(report.reason)) {
      const blocked = mergeBlocked(native.blocked, reportEvidence(native, report));
      return saveLogical(slot, {slot: slot.slot, state: 'failed', cls: 'blocked', reason: 'blocked: ' + sanitized, blocked});
    }
    return saveLogical(slot, {slot: slot.slot, state: 'failed', cls: 'refusal', reason: 'refusal: ' + sanitized, ...(native.blocked?.length ? {blocked: native.blocked} : {})});
  };

  // The responder records the launched voice, not the current roster: a config
  // change between launch and consumption must not attribute the answer to a
  // model or effort that never launched.
  const doneFromNative = (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, text: string): SlotOutcome => ({
    slot: slot.slot, state: 'done', text,
    responder: {slot: slot.slot, provider: native.provider, model: firstModelOf(native), native: true, ...(native.effort !== undefined ? {effort: native.effort} : {})},
    ...(native.blocked?.length ? {blocked: native.blocked} : {}),
  });

  // CLI-only path: the roster has no native-first target. Keeps today's immediate
  // CLI with persistent reserve; reserve substitutes stay here too (no wave is
  // advertised for them) and are consumed via their physical route.
  if (!useNativeWave) {
    const savedBlocked = new Map<string, BlockedAttempt[]>();
    const savedOutcomes = new Map<string, SlotOutcome>();
    const matchedReportAttempts = new Set<string>();
    const prepassDone = new Set<string>();
    // Independent prepass fallbacks run together in one concurrent batch (as
    // the wave does): each slot decides synchronously, and the fallback
    // marker precedes its CLI inside fallbackToCli, so batching changes
    // timing but not durable transition ordering. Reserve claims stay
    // synchronous claimReserve calls before any launch.
    const deferredFallbacks: Promise<void>[] = [];
    const deferFallback = (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, reason: string, extra?: BlockedAttempt[]): void => {
      deferredFallbacks.push((async () => {
        const outcome = await fallbackToCli(slot, native, reason, extra);
        savedOutcomes.set(slot.slot, outcome);
        prepassDone.add(slot.slot);
      })());
    };
    for (const slot of targets) {
      const saved = readSaved(slot.slot);
      if (saved?.blocked?.length) savedBlocked.set(slot.slot, saved.blocked);
      const nativeSaved = saved?.state === 'native' ? saved as Extract<SlotOutcome, {state: 'native'}> : undefined;
      // Same physical-route gate as the wave and consume paths: a missing physical fails closed instead of consuming under saved provider.
      // Route validity follows the current providers and opt-outs: a saved
      // native whose physical provider is still native-first consumes here, so
      // a crash between a reserve save and its wave flag replays with
      // native-first behavior. A native-only attempt from the current host
      // consumes like a native-only slot; its provider never runs the CLI
      // cascade. Anything else takes the full fallback below.
      const route = nativeSaved ? routeForNative(nativeSaved) : {physical: undefined, routeOk: false, first: false};
      const routeTrue = nativeSaved !== undefined && !slot.native && route.routeOk && route.first;
      const nativeOnlyAttempt = nativeSaved !== undefined && !slot.native && !routeTrue && route.routeOk;
      if (nativeSaved && (slot.native || nativeOnlyAttempt)) {
        // Native-only immediate consume, as today, plus report handling.
        const report = nativeFailures.find(entry => nativeSaved.attempt === entry.attempt);
        if (report) {
          matchedReportAttempts.add(report.attempt);
          invalidateReply(nativeSaved.replyPath);
          const reported = await saveReportFailure(slot, nativeSaved, report);
          savedOutcomes.set(slot.slot, reported);
          prepassDone.add(slot.slot);
          continue;
        }
        if (fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, 'utf8');
          const {isBlocked, raw} = parseBlockedFile(text);
          if (isBlocked && isCurrentHost(nativeSaved.provider)) {
            const entry = blockedEntry(nativeSaved.provider, firstModelOf({model: nativeSaved.model}), raw);
            emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:'blocked'});
            emit(attemptOf(slot,nativeSaved),{kind:'native',state:'failed',replay:true});
            invalidateReply(nativeSaved.replyPath);
            const blocked = mergeBlocked(nativeSaved.blocked, [entry]);
            const failed: Extract<SlotOutcome, {state: 'failed'}> = {slot: slot.slot, state: 'failed', cls: 'blocked', reason: 'blocked: ' + entry.reason, ...(blocked.length ? {blocked} : {})};
            const attemptSlot = nativeSaved.attempt.split('#')[0] ?? '';
            const isSubstitute = attemptSlot !== slot.slot;
            if (!isSubstitute && reserveAllowed(slot.slot, failed.cls)) {
              const baseFile = basePathOf(slot.slot);
              fs.writeFileSync(baseFile, baseTextOf(slot), {mode: 0o600});
              const launched = await takeReserve(slot, failed, baseFile);
              if (launched) {
                const outcome = launched.state === 'native' ? launched : await saveLogical(slot, launched);
                savedOutcomes.set(slot.slot, outcome);
                prepassDone.add(slot.slot);
                continue;
              }
            }
            savedOutcomes.set(slot.slot, await saveLogical(slot, failed));
            prepassDone.add(slot.slot);
            continue;
          }
          const checked = input.validate(text, slot.slot);
          emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:checked.ok?'ok':checked.cls});
          emit(attemptOf(slot,nativeSaved),{kind:'native',state:checked.ok?'completed':'invalid',replay:true});
          if (checked.ok) {
            const done = doneFromNative(slot, nativeSaved, checked.text ?? text);
            atomic(fileOfLogical(slot.slot), done);
            savedOutcomes.set(slot.slot, done);
            continue;
          }
          savedOutcomes.set(slot.slot, markInvalid(slot, nativeSaved, checked));
          continue;
        }
        savedOutcomes.set(slot.slot, nativeSaved);
        continue;
      }
      if (nativeSaved && routeTrue) {
        // Valid native-first route: a saved fallback transition resumes
        // without its report, before any report or reply check, so an
        // interrupted fallback is never returned as pending and a late reply
        // is never consumed for it. A report wins over any reply file, and a
        // BLOCKED or invalid reply falls back instead of validating as an answer.
        if (nativeSaved.cliFallback === true) {
          deferFallback(slot, nativeSaved, nativeSaved.nativeError ?? 'failed');
          continue;
        }
        const report = nativeFailures.find(entry => entry.attempt === nativeSaved.attempt);
        if (report) {
          matchedReportAttempts.add(report.attempt);
          deferFallback(slot, nativeSaved, report.reason, reportEvidence(nativeSaved, report));
          continue;
        }
        if (fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, 'utf8');
          const {isBlocked, raw} = parseBlockedFile(text);
          if (isBlocked) {
            const entry = blockedEntry(nativeSaved.provider, firstModelOf({model: nativeSaved.model}), raw);
            deferFallback(slot, nativeSaved, 'blocked: ' + entry.reason, [entry]);
            continue;
          }
          const checked = input.validate(text, slot.slot);
          emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:checked.ok?'ok':checked.cls});
          if (checked.ok) {
            emit(attemptOf(slot,nativeSaved),{kind:'native',state:'completed'});
            const done = doneFromNative(slot, nativeSaved, checked.text ?? text);
            atomic(fileOfLogical(slot.slot), done);
            savedOutcomes.set(slot.slot, done);
            continue;
          }
          emit(attemptOf(slot,nativeSaved),{kind:'native',state:'failed'});
          const invalidEvidence = checked.blocked ? [{provider: nativeSaved.provider, model: firstModelOf({model: nativeSaved.model}), ...checked.blocked}] : undefined;
          deferFallback(slot, nativeSaved, checked.reason, invalidEvidence);
          continue;
        }
        savedOutcomes.set(slot.slot, nativeSaved);
        continue;
      }
      if (nativeSaved && !slot.native && !routeTrue) {
        // Route is now false in this CLI-only directory: take the full fallback
        // transition. A matching report wins over the host-change reason with its
        // BLOCKED evidence, like the wave path. A substitute never takes a second
        // reserve, and a native-only attempt with no host route saves failed.
        const report = nativeFailures.find(entry => entry.attempt === nativeSaved.attempt);
        if (report !== undefined) {
          matchedReportAttempts.add(report.attempt);
          deferFallback(slot, nativeSaved, report.reason, reportEvidence(nativeSaved, report));
          continue;
        }
        deferFallback(slot, nativeSaved, 'host changed');
        continue;
      }
      if (saved?.state === 'done' && !input.validate(saved.text, slot.slot).ok) {
        // Drop stale done, rerun below.
      } else if (saved && saved.state !== 'failed') {
        savedOutcomes.set(slot.slot, saved);
        continue;
      }
    }
    const deferredSettled = await Promise.allSettled(deferredFallbacks);
    const deferredRejected = deferredSettled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (deferredRejected) throw deferredRejected.reason;
    // Report unmatched attempts as ignored. Matched reports were consumed above,
    // even when the saved file no longer holds the native attempt.
    for (const report of nativeFailures) {
      if (matchedReportAttempts.has(report.attempt)) continue;
      const matched = targets.some(slot => {
        const saved = readSaved(slot.slot);
        return saved?.state === 'native' && (saved as Extract<SlotOutcome,{state:'native'}>).attempt === report.attempt;
      });
      if (!matched) input.onIgnoredReport?.(report.attempt);
    }
    const results = await Promise.allSettled(targets.map(async slot => {
      const saved = savedOutcomes.get(slot.slot);
      if (prepassDone.has(slot.slot) && saved) { emit(slot,{kind:'slot',state:saved.state,replay:true}); return saved; }
      if (saved && saved.state !== 'failed') { emit(slot,{kind:'slot',state:saved.state,replay:true}); return saved; }
      // Failed reruns immediately, as today. A report-driven native-only failure
      // was already saved and returned above via prepassDone.
      if (slot.native) {
        const created = createNativeOnly(slot);
        const withBlocked = savedBlocked.get(slot.slot)?.length ? {...created, blocked: savedBlocked.get(slot.slot)} as SlotOutcome : created as SlotOutcome;
        if (withBlocked.state === 'native') {
          try { fs.appendFileSync(withBlocked.promptPath, ''); } catch {}
        }
        // Native-only keeps its prompt: createNativeOnly already appended.
        atomic(fileOfLogical(slot.slot), withBlocked);
        emit(slot,{kind:'slot',state:'native'});
        return withBlocked;
      }
      const promptPath = basePathOf(slot.slot);
      fs.writeFileSync(promptPath, baseTextOf(slot), {mode: 0o600});
      let outcome = await voiceCLI(slot, slot.slot, promptPath);
      if (outcome.state === 'failed') {
        const canReserve = reserveLaunchable(slot.slot, outcome.cls);
        emit(slot,{kind:'routing',state:canReserve?'reserve':'stop',cls:outcome.cls});
        // No cliWave advertisement: a roster with no native-first target
        // stays in the CLI-only path, which consumes this substitute on the
        // next call via its physical route.
        if (canReserve) {
          const launched = await takeReserve(slot, outcome, promptPath);
          if (launched && launched.state === 'native') {
            const blockedReserve = mergeBlocked(savedBlocked.get(slot.slot), launched.blocked);
            return blockedReserve.length ? {...launched, blocked: blockedReserve} : launched;
          }
          if (launched) outcome = launched;
        }
      }
      const blocked = mergeBlocked(savedBlocked.get(slot.slot), outcome.blocked);
      if (blocked.length) outcome = {...outcome, blocked};
      return saveLogical(slot, outcome);
    }));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return results.map(result => (result as PromiseFulfilledResult<SlotOutcome>).value);
  }

  // Native wave: launch, CLI wave, consume.
  const isOnly = (slot: RosterSlot): boolean => slot.native === true;
  const isFirst = (slot: RosterSlot): boolean => isNativeFirstSlot(slot, nativeFirstProviders);

  // Launch: no state yet, native-first unsaved.
  if (!state.nativeFirst) {
    const outcomes: SlotOutcome[] = [];
    const matchedReportAttempts = new Set<string>();
    // A matching failure report ends a saved native-only attempt with the
    // native-only classification (no cli cascade), mirroring the cli-only
    // prepass. Anything else replays below.
    const failNativeOnlyLaunch = async (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, report: NativeFailure): Promise<SlotOutcome> => {
      matchedReportAttempts.add(report.attempt);
      invalidateReply(native.replyPath);
      const saved = await saveReportFailure(slot, native, report);
      outcomes.push(saved);
      return saved;
    };
    // A saved native-first attempt off its route defers to the CLI wave. A
    // matching report persists its evidence; otherwise the marker records the
    // host change. Only the marker persists here, so new descriptors return first.
    const deferUnroutable = (slot: RosterSlot, existing: Extract<SlotOutcome, {state: 'native'}>): void => {
      const report = nativeFailures.find(entry => entry.attempt === existing.attempt);
      if (report === undefined) {
        persistDeferredMarker(fileOfLogical(slot.slot), existing, 'host changed');
        return;
      }
      matchedReportAttempts.add(report.attempt);
      persistDeferredMarker(fileOfLogical(slot.slot), existing, report.reason, reportEvidence(existing, report));
    };
    for (const slot of targets) {
      if (isOnly(slot)) {
        const existing = readSaved(slot.slot);
        if (existing?.state === 'native') {
          const report = nativeFailures.find(entry => entry.attempt === existing.attempt);
          if (report) {
            await failNativeOnlyLaunch(slot, existing, report);
            continue;
          }
        }
        if (existing?.state === 'native' || existing?.state === 'done') {
          if (existing.state === 'done' && !input.validate(existing.text, slot.slot).ok) {
            // Drop stale done below.
          } else {
            emit(slot,{kind:'slot',state:existing.state,replay:true});
            outcomes.push(existing);
            continue;
          }
        }
        // A saved failed native-only reruns below as a fresh native attempt.
        const created = createNativeOnly(slot);
        atomic(fileOfLogical(slot.slot), created);
        emit(slot,{kind:'slot',state:'native'});
        outcomes.push(created);
        continue;
      }
      if (isFirst(slot)) {
        const existing = readSaved(slot.slot);
        if (existing?.state === 'native' && !(existing as {cliFallback?: true}).cliFallback) {
          // A host change can make the logical slot native-first while the
          // saved attempt belongs to another provider: check the physical
          // route before replaying, or the old-host attempt stays pending.
          if (!routeForNative(existing).routeOk) {
            deferUnroutable(slot, existing);
            continue;
          }
          emit(slot,{kind:'slot',state:'native',replay:true});
          outcomes.push(existing);
          continue;
        }
        if (existing?.state === 'done' && input.validate(existing.text, slot.slot).ok) {
          emit(slot,{kind:'slot',state:'done',replay:true});
          outcomes.push(existing);
          continue;
        }
        // Failed or missing: mint fresh. A saved fallback marker resumes in
        // the CLI wave, never as pending, so it stays out of this return.
        // On launch retry after crash before state write, reuse existing native if present.
        if (existing?.state === 'native') {
          continue;
        }
        const created = createNativeFirst(slot, slot);
        atomic(fileOfLogical(slot.slot), created);
        emit(slot,{kind:'slot',state:'native'});
        outcomes.push(created);
        continue;
      }
    }
    // Targets that are neither native-only nor native-first are normally
    // unsaved on launch. A host change can still leave them with a saved
    // outcome: replay done and failed saves, and route a pending reserve by
    // its physical provider like the first-slot branch above, so no saved
    // voice is omitted while a matching failure report is retained.
    for (const slot of targets) {
      if (isOnly(slot) || isFirst(slot)) continue;
      const existing = readSaved(slot.slot);
      if (!existing) continue;
      if (existing.state === 'done') {
        if (input.validate(existing.text, slot.slot).ok) {
          emit(slot,{kind:'slot',state:'done',replay:true});
          outcomes.push(existing);
        }
        continue;
      }
      if (existing.state === 'failed') {
        emit(slot,{kind:'slot',state:'failed',replay:true});
        outcomes.push(existing);
        continue;
      }
      if (existing.state === 'native' && !(existing as {cliFallback?: true}).cliFallback) {
        if (!routeForNative(existing).routeOk) {
          deferUnroutable(slot, existing);
          continue;
        }
        emit(slot,{kind:'slot',state:'native',replay:true});
        outcomes.push(existing);
        continue;
      }
      // A fallback marker resumes in the CLI wave with its recorded reason,
      // never as pending. Unsaved targets stay absent here: the deferred wave
      // processes them, and the caller keeps the round open until it does.
      continue;
    }
    writeState(input.dir, {...state, nativeFirst: true});
    // Reports that matched a saved host-changed attempt were consumed above;
    // only a truly stale report is ignored.
    for (const report of nativeFailures) if (!matchedReportAttempts.has(report.attempt)) input.onIgnoredReport?.(report.attempt);
    return outcomes;
  }

  // CLI wave: descriptors saved, cliWaveDone absent. Runs unsaved CLI and reported failures, reads no other reply.
  if (!state.cliWaveDone) {
    const outcomes = new Map<string, SlotOutcome>();
    const waveTasks: Promise<unknown>[] = [];
    const matchedReportAttempts = new Set<string>();
    const deferredFallbacks = new Set<string>();
    // New descriptors come first and return before any CLI work starts, so a
    // new host's voices launch while old fallbacks still run. cliWaveDone
    // stays absent, so the next call resumes the deferred fallbacks and CLI
    // targets with recoverable wave state.
    let earlyNatives = false;
    for (const slot of targets) {
      if (isOnly(slot) || !isFirst(slot)) continue;
      if (outcomes.has(slot.slot) || readSaved(slot.slot)) continue;
      const created = createNativeFirst(slot, slot);
      atomic(fileOfLogical(slot.slot), created);
      emit(slot,{kind:'slot',state:'native'});
      outcomes.set(slot.slot, created);
      earlyNatives = true;
    }
    for (const slot of targets) {
      if (!isOnly(slot)) continue;
      if (outcomes.has(slot.slot) || readSaved(slot.slot)) continue;
      const created = createNativeOnly(slot);
      atomic(fileOfLogical(slot.slot), created);
      emit(slot,{kind:'slot',state:'native'});
      outcomes.set(slot.slot, created);
      earlyNatives = true;
    }
    if (earlyNatives) {
      // A host change can leave a saved native attempt with a matching failure
      // report while other targets become newly eligible. A native-only
      // attempt has no CLI cascade and fails at once with its reason and
      // BLOCKED evidence. A native-first slot or reserve substitute persists
      // only the fallback marker (step 1 of fallbackToCli): the deferred next
      // call resumes the CLI cascade with the recorded reason, so the slot is
      // neither returned as pending nor marked failed here. CLI work stays
      // deferred; unmatched reports are ignored only when no saved attempt
      // still holds them.
      for (const slot of targets) {
        if (outcomes.has(slot.slot)) continue;
        const saved = readSaved(slot.slot) as Extract<SlotOutcome, {state: 'native'}> | undefined;
        // A fallback already in flight stays with the deferred next call, which
        // resumes it with its recorded reason.
        if (!saved || saved.state !== 'native' || (saved as {cliFallback?: true}).cliFallback) continue;
        const report = nativeFailures.find(entry => entry.attempt === saved.attempt);
        if (!report) continue;
        matchedReportAttempts.add(report.attempt);
        const route = routeForNative(saved);
        const routeTrue = !slot.native && route.routeOk && route.first;
        const nativeOnlyAttempt = !slot.native && !routeTrue && route.routeOk;
        if (slot.native || nativeOnlyAttempt) {
          invalidateReply(saved.replyPath);
          outcomes.set(slot.slot, await saveReportFailure(slot, saved, report));
          continue;
        }
        // The marker persists before the reply is quarantined: an
        // interruption between the two still resumes with the reported
        // reason and evidence instead of a generic host change.
        persistDeferredMarker(fileOfLogical(slot.slot), saved, report.reason, reportEvidence(saved, report));
        invalidateReply(saved.replyPath);
        deferredFallbacks.add(slot.slot);
      }
      // Reports that matched a saved attempt were consumed above; only a report
      // no saved attempt still holds is ignored. A deferred fallback slot is
      // absent from this return by design: the next call resumes its CLI
      // cascade, so neither caller can list it as pending or failed meanwhile.
      for (const report of nativeFailures) {
        if (matchedReportAttempts.has(report.attempt)) continue;
        const stillPending = targets.some(slot => {
          const saved = readSaved(slot.slot);
          return saved?.state === 'native' && (saved as {attempt?: string}).attempt === report.attempt && !(saved as {cliFallback?: true}).cliFallback;
        });
        if (stillPending) continue;
        input.onIgnoredReport?.(report.attempt);
      }
      for (const slot of targets) {
        if (outcomes.has(slot.slot)) continue;
        const saved = readSaved(slot.slot);
        // Every saved fallback marker resumes in the CLI wave, including one
        // saved before this call: it never returns as a pending voice.
        if (!saved || deferredFallbacks.has(slot.slot) || (saved.state === 'native' && (saved as {cliFallback?: true}).cliFallback)) continue;
        if (saved.state === 'native' && !routeForNative(saved as {attempt: string; provider: string}).routeOk) continue;
        outcomes.set(slot.slot, saved);
      }
      return targets.map(slot => outcomes.get(slot.slot)!).filter(Boolean);
    }
    for (const slot of targets) {
      if (isOnly(slot) || isFirst(slot)) {
        const saved = readSaved(slot.slot);
        if (isOnly(slot) && saved?.state === 'native') {
          // Saved native-only attempts match reports here too: a host change
          // must not replay the old attempt as pending when its BLOCKED
          // report arrived with the resume.
          const report = nativeFailures.find(entry => entry.attempt === (saved as {attempt: string}).attempt);
          if (report) {
            matchedReportAttempts.add(report.attempt);
            invalidateReply((saved as {replyPath: string}).replyPath);
            outcomes.set(slot.slot, await saveReportFailure(slot, saved, report));
            continue;
          }
        }
        if (!saved || (saved.state === 'native' && (saved as {cliFallback?: true}).cliFallback)) continue;
        if (isFirst(slot) && saved.state === 'native') {
          // Same physical-route gate as the consume path: a host change can
          // make the logical slot native-first under a stale attempt.
          if (!routeForNative(saved).routeOk) {
            // A matching report wins: the report loop below runs the same
            // fallback with the reported reason and evidence.
            if (nativeFailures.some(entry => entry.attempt === saved.attempt)) continue;
            waveTasks.push((async () => {
              outcomes.set(slot.slot, await fallbackToCli(slot, saved, 'host changed'));
            })());
            continue;
          }
        }
        outcomes.set(slot.slot, saved);
      }
    }
    // Snapshot before any concurrent fallback tasks launch: each pushed task
    // runs its sync prefix (marker persist and failed save) immediately, so a
    // later live read would see a marker that already settled to failed in this
    // same batch and trigger a plain retry for the same slot.
    const waveInitial = new Map(targets.map(slot => [slot.slot, readSaved(slot.slot)]));
    // Process reports for natives in this wave (fallback now, no reply read).
    for (const slot of targets) {
      if (isOnly(slot)) continue;
      const saved = readSaved(slot.slot) as Extract<SlotOutcome,{state:'native'}> | undefined;
      if (!saved || saved.state !== 'native' || !(saved as {cliFallback?: true}).cliFallback) continue;
      waveTasks.push((async () => {
        const outcome = await fallbackToCli(slot, saved, (saved as {nativeError?: string}).nativeError ?? 'failed');
        outcomes.set(slot.slot, outcome);
      })());
    }
    // Route false takes the fallback even with a reply present, before any report handling.
    for (const slot of targets) {
      if (isOnly(slot) || isFirst(slot)) continue;
      const saved = readSaved(slot.slot) as Extract<SlotOutcome,{state:'native'}> | undefined;
      if (!saved || saved.state !== 'native' || (saved as {cliFallback?: true}).cliFallback) continue;
      if (routeForNative(saved).routeOk) continue;
      // A matching report wins: the report loop below runs the same fallback
      // with the reported reason and evidence.
      if (nativeFailures.some(entry => entry.attempt === saved.attempt)) continue;
      waveTasks.push((async () => {
        const outcome = await fallbackToCli(slot, saved, 'host changed');
        outcomes.set(slot.slot, outcome);
      })());
    }
    // Reports match any saved physical native attempt, not only first slots:
    // a reserve substitute saved under a non-first target falls back with its
    // physical reserve provider under the logical slot and no second reserve,
    // and a reported attempt is never returned as pending.
    for (const slot of targets) {
      if (isOnly(slot)) continue;
      const saved = readSaved(slot.slot) as Extract<SlotOutcome,{state:'native'}> | undefined;
      if (!saved || saved.state !== 'native' || (saved as {cliFallback?: true}).cliFallback) continue;
      const report = nativeFailures.find(entry => entry.attempt === saved.attempt);
      if (!report) continue;
      matchedReportAttempts.add(report.attempt);
      waveTasks.push((async () => {
      // Fallback transition for a reported native attempt in the CLI wave.
      const outcome = await fallbackToCli(slot, saved, report.reason, reportEvidence(saved, report));
      outcomes.set(slot.slot, outcome);
      })());
    }
    // Run unsaved CLI targets alongside fallback cascades in one concurrent batch.
    // A slot with a saved native (including a fallback marker) is resumed by
    // its own fallback task above; it never runs a second CLI here. The check
    // runs before any task launches so a marker that settles to failed in this
    // same batch does not trigger a plain retry for the same slot.
    const cliTargets = targets.filter(slot => !isOnly(slot) && !isFirst(slot));
    for (const slot of cliTargets) {
      const initial = waveInitial.get(slot.slot);
      if (initial?.state === 'native') continue;
      waveTasks.push((async () => {
      const saved = readSaved(slot.slot);
      if (saved?.state === 'done' && input.validate(saved.text, slot.slot).ok) {
        emit(slot,{kind:'slot',state:'done',replay:true});
        outcomes.set(slot.slot, saved);
        return saved;
      }
      if (saved && saved.state !== 'failed') {
        outcomes.set(slot.slot, saved);
        return saved;
      }
      // If saved failed from previous interrupted wave, rerun below.
      const promptPath = basePathOf(slot.slot);
      if (!fs.existsSync(promptPath)) fs.writeFileSync(promptPath, baseTextOf(slot), {mode: 0o600});
      let outcome = await voiceCLI(slot, slot.slot, promptPath);
      if (outcome.state === 'failed') {
        const canReserve = reserveLaunchable(slot.slot, outcome.cls);
        emit(slot,{kind:'routing',state:canReserve?'reserve':'stop',cls:outcome.cls});
        if (canReserve) {
          const launched = await takeReserve(slot, outcome, promptPath);
          if (launched) {
            if (launched.state === 'native') { outcomes.set(slot.slot, launched); return launched; }
            outcome = launched;
          }
        }
      }
      const savedBlockedFor = (() => { const prior = readSaved(slot.slot); return prior?.blocked; })();
      const blocked = mergeBlocked(savedBlockedFor, outcome.blocked);
      if (blocked.length) outcome = {...outcome, blocked};
      await saveLogical(slot, outcome);
      outcomes.set(slot.slot, outcome);
      return outcome;
      })());
    }
    const waveResults = await Promise.allSettled(waveTasks);
    const rejectedWave = waveResults.find(result => result.status === 'rejected');
    if (rejectedWave?.status === 'rejected') throw rejectedWave.reason;
    // Reads no other reply file. Sets cliWaveDone after all settle.
    state = {...readState(input.dir), cliWaveDone: true};
    // Preserve reserveUsedBy from in-memory owner.
    if (reserveOwner !== undefined) state.reserveUsedBy = reserveOwner;
    writeState(input.dir, state);
    // Reports that matched nothing are ignored; others were consumed above.
    for (const report of nativeFailures) {
      if (matchedReportAttempts.has(report.attempt)) continue;
      const stillPending = targets.some(slot => {
        const saved = readSaved(slot.slot);
        return saved?.state === 'native' && (saved as {attempt?: string}).attempt === report.attempt && !(saved as {cliFallback?: true}).cliFallback;
      });
      if (stillPending) continue;
      input.onIgnoredReport?.(report.attempt);
    }
    return targets.map(slot => outcomes.get(slot.slot) ?? readSaved(slot.slot)!).filter(Boolean);
  }

  // Consume: cliWaveDone present. Consumes replies, moves failed natives to CLI.
  {
    const startAttempts = new Set<string>();
    for (const slot of targets) {
      const saved = readSaved(slot.slot);
      if (saved?.state === 'native' && !(saved as {cliFallback?: true}).cliFallback) {
        startAttempts.add((saved as {attempt: string}).attempt);
      }
    }
    const outcomes = new Map<string, SlotOutcome>();
    let pendingRemains = false;
    const preExistingFailed: RosterSlot[] = [];
    const consumeTasks: Promise<void>[] = [];
    // Independent fallback cascades run concurrently in one batch (as the wave
    // does); the walk below decides and marks, tasks launch. Check and claim
    // stay adjacent with no await between, so concurrent cascades cannot
    // double-claim the reserve.
    const runFallback = (slot: RosterSlot, nativeSaved: Extract<SlotOutcome, {state: 'native'}>, nativeError: string, extraBlocked?: BlockedAttempt[]) => {
      consumeTasks.push((async () => {
        const outcome = await fallbackToCli(slot, nativeSaved, nativeError, extraBlocked);
        outcomes.set(slot.slot, outcome);
        if (outcome.state === 'native' && !(outcome as {cliFallback?: true}).cliFallback) pendingRemains = true;
      })());
    };
    const runPlainCli = (slot: RosterSlot, promptPath: string) => {
      consumeTasks.push((async () => {
        let outcome = await voiceCLI(slot, slot.slot, promptPath);
        if (outcome.state === 'failed' && reserveAllowed(slot.slot, outcome.cls)) {
          const launched = await takeReserve(slot, outcome, promptPath);
          if (launched) {
            outcomes.set(slot.slot, launched);
            if (launched.state === 'native') pendingRemains = true;
            if (launched.state === 'native') return;
            outcome = launched;
          }
        }
        await saveLogical(slot, outcome);
        outcomes.set(slot.slot, outcome);
      })());
    };

    for (const slot of targets) {
      const saved = readSaved(slot.slot);
      if (isOnly(slot)) {
        if (!saved || saved.state !== 'native') {
          if (saved) outcomes.set(slot.slot, saved);
          continue;
        }
        const nativeSaved = saved as Extract<SlotOutcome,{state:'native'}>;
        const report = nativeFailures.find(entry => entry.attempt === nativeSaved.attempt);
        if (report) {
          const reported = await saveReportFailure(slot, nativeSaved, report);
          outcomes.set(slot.slot, reported);
          if (reported.state === 'native' && !(reported as {cliFallback?: true}).cliFallback) pendingRemains = true;
          continue;
        }
        if (fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, 'utf8');
          const {isBlocked, raw} = parseBlockedFile(text);
          if (isBlocked && isCurrentHost(nativeSaved.provider)) {
            const entry = blockedEntry(nativeSaved.provider, firstModelOf({model: nativeSaved.model}), raw);
            emit(slot,{kind:'validation',surface:'native',outcome:'blocked'});
            emit(slot,{kind:'native',state:'failed',replay:true});
            invalidateReply(nativeSaved.replyPath);
            const blocked = mergeBlocked(nativeSaved.blocked, [entry]);
            const failed: Extract<SlotOutcome, {state: 'failed'}> = {slot: slot.slot, state: 'failed', cls: 'blocked', reason: 'blocked: ' + entry.reason, ...(blocked.length ? {blocked} : {})};
            const attemptSlot = nativeSaved.attempt.split('#')[0] ?? '';
            const isSubstitute = attemptSlot !== slot.slot;
            if (!isSubstitute && reserveAllowed(slot.slot, failed.cls)) {
              const baseFile = basePathOf(slot.slot);
              fs.writeFileSync(baseFile, baseTextOf(slot), {mode: 0o600});
              const launched = await takeReserve(slot, failed, baseFile);
              if (launched) {
                if (launched.state === 'native') {
                  outcomes.set(slot.slot, launched);
                  pendingRemains = true;
                } else {
                  const savedLaunched = await saveLogical(slot, launched);
                  outcomes.set(slot.slot, savedLaunched);
                }
                continue;
              }
            }
            outcomes.set(slot.slot, await saveLogical(slot, failed));
            continue;
          }
          const checked = input.validate(text, slot.slot);
          emit(slot,{kind:'validation',surface:'native',outcome:checked.ok?'ok':checked.cls});
          if (checked.ok) {
            emit(slot,{kind:'native',state:'completed',replay:true});
            const done = doneFromNative(slot, nativeSaved, checked.text ?? text);
            atomic(fileOfLogical(slot.slot), done);
            outcomes.set(slot.slot, done);
            continue;
          }
          emit(slot,{kind:'native',state:'invalid',replay:true});
          outcomes.set(slot.slot, markInvalid(slot, nativeSaved, checked));
          pendingRemains = true;
          continue;
        }
        outcomes.set(slot.slot, nativeSaved);
        pendingRemains = true;
        continue;
      }
      if (isFirst(slot) || (saved?.state === 'native')) {
        // Native-first consume, including route-false fallback.
        const nativeSaved = saved?.state === 'native' ? saved as Extract<SlotOutcome,{state:'native'}> : undefined;
        if (!nativeSaved) {
          // No saved native: could be done/failed already, or unsaved (new). If done/failed, handle below as CLI.
          if (saved) {
            if (saved.state === 'failed') {
              // Defer retry until pending settles.
              outcomes.set(slot.slot, saved);
              preExistingFailed.push(slot);
              continue;
            }
            outcomes.set(slot.slot, saved);
            continue;
          }
          // Unsaved native-first in consume: create fresh (should not happen for same gen, but handle).
          if (isFirst(slot)) {
            const created = createNativeFirst(slot, slot);
            atomic(fileOfLogical(slot.slot), created);
            outcomes.set(slot.slot, created);
            pendingRemains = true;
            continue;
          }
          continue;
        }
        if ((nativeSaved as {cliFallback?: true}).cliFallback) {
          // Rerun steps 2-3, never read reply. A substitute never takes a
          // second reserve here either.
          runFallback(slot, nativeSaved, (nativeSaved as {nativeError?: string}).nativeError ?? 'failed');
          continue;
        }
        const report = nativeFailures.find(entry => entry.attempt === nativeSaved.attempt);
        if (report) {
          runFallback(slot, nativeSaved, report.reason, reportEvidence(nativeSaved, report));
          continue;
        }
        // Route false takes fallback even with reply present. Resolve the
        // physical provider with the same gate as the CLI-only and wave
        // paths: a host-platform reserve saved under any logical slot stays
        // route-ok while native-first or native-only from the current host,
        // so its reply consumes.
        const route = routeForNative(nativeSaved);
        if (!route.routeOk) {
          runFallback(slot, nativeSaved, 'host changed');
          continue;
        }
        // Classify by the physical provider: a wave-minted native-only
        // reserve answers the native-only way, so a BLOCKED or invalid reply
        // file stays pending-native and never falls back to a refusal.
        const nativeOnlyPhysical = !route.first && (route.physical?.native ?? false);
        if (nativeOnlyPhysical && fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, 'utf8');
          const {isBlocked, raw} = parseBlockedFile(text);
          if (isBlocked) {
            if (isCurrentHost(nativeSaved.provider)) {
              const entry = blockedEntry(nativeSaved.provider, firstModelOf({model: (nativeSaved as {model?: string | readonly string[]}).model}), raw);
              emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:'blocked'});
              emit(attemptOf(slot,nativeSaved),{kind:'native',state:'failed',replay:true});
              invalidateReply(nativeSaved.replyPath);
              const blocked = mergeBlocked(nativeSaved.blocked, [entry]);
              const failed: Extract<SlotOutcome, {state: 'failed'}> = {slot: slot.slot, state: 'failed', cls: 'blocked', reason: 'blocked: ' + entry.reason, ...(blocked.length ? {blocked} : {})};
              const attemptSlot = nativeSaved.attempt.split('#')[0] ?? '';
              const isSubstitute = attemptSlot !== slot.slot;
              if (!isSubstitute && reserveAllowed(slot.slot, failed.cls)) {
                const baseFile = basePathOf(slot.slot);
                fs.writeFileSync(baseFile, baseTextOf(slot), {mode: 0o600});
                const launched = await takeReserve(slot, failed, baseFile);
                if (launched) {
                  if (launched.state === 'native') {
                    outcomes.set(slot.slot, launched);
                    pendingRemains = true;
                  } else {
                    outcomes.set(slot.slot, await saveLogical(slot, launched));
                  }
                  continue;
                }
              }
              outcomes.set(slot.slot, await saveLogical(slot, failed));
              continue;
            }
            const entry = blockedEntry(nativeSaved.provider, firstModelOf({model: (nativeSaved as {model?: string | readonly string[]}).model}), raw);
            emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:'blocked'});
            emit(attemptOf(slot,nativeSaved),{kind:'native',state:'invalid',replay:true});
            invalidateReply(nativeSaved.replyPath);
            const blocked = mergeBlocked(nativeSaved.blocked, [entry]);
            const pending = {...nativeSaved, error: 'blocked: ' + entry.reason, ...(blocked.length ? {blocked} : {})};
            atomic(fileOfLogical(slot.slot), pending);
            outcomes.set(slot.slot, pending);
            pendingRemains = true;
            continue;
          }
          const checked = input.validate(text, slot.slot);
          emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:checked.ok?'ok':checked.cls});
          if (checked.ok) {
            emit(attemptOf(slot,nativeSaved),{kind:'native',state:'completed',replay:true});
            const done = doneFromNative(slot, nativeSaved, checked.text ?? text);
            atomic(fileOfLogical(slot.slot), done);
            outcomes.set(slot.slot, done);
            continue;
          }
          emit(attemptOf(slot,nativeSaved),{kind:'native',state:'invalid',replay:true});
          outcomes.set(slot.slot, markInvalid(slot, nativeSaved, checked));
          pendingRemains = true;
          continue;
        }
        // Route true, no report: consume reply if present.
        if (fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, 'utf8');
          const {isBlocked, raw} = parseBlockedFile(text);
          if (isBlocked) {
            const entry = blockedEntry(nativeSaved.provider, firstModelOf({model: (nativeSaved as {model?: string|readonly string[]}).model}), raw);
            emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:'blocked'});
            emit(attemptOf(slot,nativeSaved),{kind:'native',state:'failed'});
            runFallback(slot, nativeSaved, 'blocked: ' + entry.reason, [entry]);
            continue;
          }
          const checked = input.validate(text, slot.slot);
          emit(attemptOf(slot,nativeSaved),{kind:'validation',surface:'native',outcome:checked.ok?'ok':checked.cls});
          if (checked.ok) {
            emit(attemptOf(slot,nativeSaved),{kind:'native',state:'completed'});
            // The responder records the launched voice, not the current
            // roster: a config change between launch and consumption must not
            // attribute the answer to a model or effort that never launched.
            const done = doneFromNative(slot, nativeSaved, checked.text ?? text);
            atomic(fileOfLogical(slot.slot), done);
            outcomes.set(slot.slot, done);
            continue;
          }
          // Invalid reply falls back.
          emit(attemptOf(slot,nativeSaved),{kind:'native',state:'failed'});
          const mergedInvalidBlocked = mergeBlocked(nativeSaved.blocked, checked.blocked ? [{provider: nativeSaved.provider, model: firstModelOf({model: (nativeSaved as {model?: string|readonly string[]}).model}), ...checked.blocked}] : undefined);
          runFallback(slot, nativeSaved, checked.reason, mergedInvalidBlocked.length ? mergedInvalidBlocked : undefined);
          continue;
        }
        outcomes.set(slot.slot, nativeSaved);
        pendingRemains = true;
        continue;
      }
      // CLI targets in consume.
      if (saved?.state === 'done' && input.validate(saved.text, slot.slot).ok) {
        outcomes.set(slot.slot, saved);
        continue;
      }
      if (saved?.state === 'failed') {
        outcomes.set(slot.slot, saved);
        preExistingFailed.push(slot);
        continue;
      }
      if (saved) {
        outcomes.set(slot.slot, saved);
        continue;
      }
      // Unsaved CLI in consume (should not happen after wave, but run now).
      const promptPath = basePathOf(slot.slot);
      if (!fs.existsSync(promptPath)) fs.writeFileSync(promptPath, baseTextOf(slot), {mode: 0o600});
      runPlainCli(slot, promptPath);
    }
    const consumeSettled = await Promise.allSettled(consumeTasks);
    const consumeRejected = consumeSettled.find(result => result.status === 'rejected');
    if (consumeRejected?.status === 'rejected') throw consumeRejected.reason;

    // A saved failed slot retries once in the call where the last native reply settles.
    if (!pendingRemains && preExistingFailed.length) {
      const retryTasks: Promise<void>[] = [];
      for (const slot of preExistingFailed) {
        retryTasks.push((async () => {
          // Carry forward the saved blocked evidence: a retry that settles
          // the last pending voice must not drop it.
          const savedFailed = readSaved(slot.slot);
          const priorBlocked = savedFailed?.blocked;
          // A native-only reserve mint appends its reply section to this same
          // file: rewrite the base prompt unconditionally, as the CLI-only
          // path does, so the retry never reads a native reply section.
          const baseFile = basePathOf(slot.slot);
          fs.writeFileSync(baseFile, baseTextOf(slot), {mode: 0o600});
          let retryOutcome: SlotOutcome;
          if (isCurrentHost(slot.provider)) {
            retryOutcome = savedFailed?.state === 'failed'
              ? (savedFailed as Extract<SlotOutcome, {state: 'failed'}>)
              : {slot: slot.slot, state: 'failed', cls: 'refusal', reason: 'refusal: host voice unavailable', ...(priorBlocked?.length ? {blocked: priorBlocked} : {})} as Extract<SlotOutcome, {state: 'failed'}>;
          } else {
            retryOutcome = await voiceCLI(slot, slot.slot, baseFile);
            if (priorBlocked?.length) retryOutcome = {...retryOutcome, blocked: mergeBlocked(priorBlocked, retryOutcome.blocked)};
          }
          if (retryOutcome.state === 'failed' && reserveAllowed(slot.slot, retryOutcome.cls)) {
            const launched = await takeReserve(slot, retryOutcome, baseFile);
            if (launched) retryOutcome = launched;
          }
          await saveLogical(slot, retryOutcome);
          outcomes.set(slot.slot, retryOutcome);
        })());
      }
      const retrySettled = await Promise.allSettled(retryTasks);
      const retryRejected = retrySettled.find(result => result.status === 'rejected');
      if (retryRejected?.status === 'rejected') throw retryRejected.reason;
    }

    // Stale or replayed reports never matched a pending native at call start.
    for (const report of nativeFailures) {
      if (!startAttempts.has(report.attempt)) input.onIgnoredReport?.(report.attempt);
    }
    return targets.map(slot => outcomes.get(slot.slot) ?? readSaved(slot.slot)!).filter(Boolean);
  }
}

// Saved voices whose logical slot left the recomputed roster reconcile as
// targets; settled failures stay dropped.
function savedOrphanTargets(dir: string): RosterSlot[] {
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(dir, 'slots')); } catch { return []; }
  const out: RosterSlot[] = [];
  for (const file of files) {
    const name = /^([A-Za-z0-9_-]+\[\d+\])\.json$/.exec(file)?.[1];
    if (name === undefined) continue;
    let saved: {state?: string; provider?: unknown; model?: string | readonly string[]; effort?: string; responder?: {provider?: unknown}};
    try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'slots', file), 'utf8')) as typeof saved; } catch { continue; }
    const provider = typeof saved.provider === 'string' ? saved.provider : saved.responder?.provider;
    if ((saved.state !== 'native' && saved.state !== 'done') || typeof provider !== 'string') continue;
    out.push({slot: name, provider, index: Number(name.slice(name.lastIndexOf('[') + 1, -1)),
      native: false, reserve: false,
      ...(saved.model === undefined ? {} : {model: saved.model}),
      ...(saved.effort === undefined ? {} : {effort: saved.effort})});
  }
  return out;
}

// Shared completeness for every caller: a launchable native returns at once
// with matched orphan markers saved and every unconsumed ignore forwarded;
// with no launchable the deferred wave runs once and retries ignores there.
export async function fanOutComplete(input: FanOutInput, deps: CliDeps): Promise<SlotOutcome[]> {
  const uniq = (list: string[], attempt: string): void => { if (!list.includes(attempt)) list.push(attempt); };
  const firstIgnored: string[] = [];
  const first = await fanOut({...input, onIgnoredReport: attempt => uniq(firstIgnored, attempt)}, deps);
  const have = new Set(first.map(outcome => outcome.slot));
  const rostered = Array.isArray(input.slots) ? input.slots as readonly RosterSlot[] : [...(input.slots as Roster).targets, ...(input.slots as Roster).reserves];
  const targeted = new Set(rostered.filter(slot => !slot.reserve).map(slot => slot.slot));
  const extra = savedOrphanTargets(input.dir).filter(slot => !have.has(slot.slot) && !targeted.has(slot.slot));
  const launchable = first.filter(outcome => outcome.state === 'native' && !(outcome as {cliFallback?: true}).cliFallback);
  if (launchable.length) {
    // Descriptors-first: a launchable native returns before any CLI work. A
    // matched orphan report persists its fallback marker, reconciled next call;
    // every ignore that no orphan consumed reaches the callback on this call.
    // A fallback marker saved before this call runs its CLI cascade now, while
    // other native replies stay unread: only pre-marked orphans run, through a
    // call that lists just them, so no other reply is read or consumed.
    const consumed = new Set<string>();
    const marked: RosterSlot[] = [];
    for (const orphan of extra) {
      let saved: SlotOutcome | undefined;
      try { saved = JSON.parse(fs.readFileSync(path.join(input.dir, 'slots', orphan.slot + '.json'), 'utf8')) as SlotOutcome; }
      catch { continue; }
      if (saved?.state !== 'native') continue;
      if ((saved as {cliFallback?: true}).cliFallback) { marked.push(orphan); continue; }
      const native = saved as Extract<SlotOutcome, {state: 'native'}>;
      const report = (input.nativeFailures ?? []).find(entry => entry.attempt === native.attempt && firstIgnored.includes(entry.attempt));
      if (!report) continue;
      persistDeferredMarker(path.join(input.dir, 'slots', orphan.slot + '.json'), native, report.reason, reportEvidence(native, report));
      consumed.add(report.attempt);
    }
    for (const attempt of firstIgnored) if (!consumed.has(attempt)) input.onIgnoredReport?.(attempt);
    if (marked.length) {
      const resumed = await fanOut({...input, slots: marked, nativeFailures: []}, deps);
      return [...first, ...resumed];
    }
    return first;
  }
  if (!extra.length && !rostered.some(slot => !slot.reserve && !have.has(slot.slot))) {
    for (const attempt of firstIgnored) input.onIgnoredReport?.(attempt);
    return first;
  }
  const slots = Array.isArray(input.slots) ? [...input.slots as readonly RosterSlot[], ...extra] : {...(input.slots as Roster), targets: [...(input.slots as Roster).targets, ...extra]};
  const retry = (input.nativeFailures ?? []).filter(report => firstIgnored.includes(report.attempt));
  const secondIgnored: string[] = [];
  const second = await fanOut({...input, slots, nativeFailures: retry, onIgnoredReport: attempt => uniq(secondIgnored, attempt)}, deps);
  for (const attempt of secondIgnored) input.onIgnoredReport?.(attempt);
  return second;
}
