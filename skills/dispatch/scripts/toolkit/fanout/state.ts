import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { quotaSnapshot } from '../../policy/quota.ts';
import type { Roster } from '../../policy/roster.ts';
import { launchLine, summaryLaunch } from '../../lib/platform.ts';
import type { RunOutcome } from '../../providers/types.ts';
import type { CliDeps } from '../cli.ts';
import type { DiagnosticEvent } from '../domain/diagnostics.ts';
import type { RosterSlot } from '../domain/types.ts';

export type FailureClass = Extract<RunOutcome, {status: 'fail'}>['cls'];
export type BlockedAttempt = {provider: string; model: string | null; reason: string; reasonHash: string};
export type Validation = {ok: true; text?: string} | {ok: false; cls: FailureClass; reason: string; blocked?: {reason: string; reasonHash: string}};
export type SlotOutcome = {slot: string; blocked?: BlockedAttempt[]} & (
  {state: 'done'; text: string; responder?: {slot: string; provider: string; model: string | null; native: boolean; effort?: string}} |
  {state: 'native'; promptPath: string; replyPath: string; provider: string; attempt: string; cwd: string; model?: string | readonly string[]; effort?: string; launchAs?: string; error?: string; cliFallback?: true; nativeError?: string} |
  {state: 'failed'; cls: FailureClass; reason: string; cliOnly?: true}
);
export type NativeFailure = {attempt: string; reason: string; reasonHash: string};

const nativeModels = (model: string | readonly string[] | undefined): string[] => model === undefined ? [] : typeof model === 'string' ? [model] : [...model];
export const nativeLaunchAs = (provider: string, model: string | readonly string[] | undefined, effort: string | undefined): string => launchLine(provider, nativeModels(model), effort ?? null);
/** Distinct first-model summary launch lines for pending native descriptors. */
export const nativeSummaryItems = (outcomes: readonly Extract<SlotOutcome, {state: 'native'}>[]): string[] =>
  [...new Set(outcomes.map(outcome => summaryLaunch(outcome.provider, nativeModels(outcome.model), outcome.effort ?? null)))];
export function normalizeNative(outcome: SlotOutcome): SlotOutcome {
  if (outcome.state !== 'native') return outcome;
  const { subagentModels: _legacy, ...rest } = outcome as Extract<SlotOutcome, {state: 'native'}> & { subagentModels?: unknown };
  return { ...rest, launchAs: rest.launchAs ?? nativeLaunchAs(rest.provider, rest.model, rest.effort) };
}
export type FanOutInput = {
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

export type FanoutState = {nativeFirst?: true; cliWaveDone?: true; reserveUsedBy?: string; nativeLaunched?: true};

export function cliWaveState(dir: string): 'pending' | 'done' | undefined {
  let raw: string;
  try { raw = fs.readFileSync(path.join(dir, 'fanout.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let data: FanoutState;
  try { data = JSON.parse(raw) as FanoutState; } catch { return undefined; }
  if (!data.nativeFirst) return undefined;
  return data.cliWaveDone ? 'done' : 'pending';
}

export function sessionOf(directory: string): string {
  let current = path.resolve(directory);
  for (;;) {
    if (fs.existsSync(path.join(current, 'manifest.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Fan-out directory has no session manifest ancestor');
    current = parent;
  }
}

export function atomic(file: string, value: unknown): void {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600});
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, {force: true}); }
}

/** One entry per logical blocked attempt: repeated modes keep the same alias once, distinct reasons stay apart. */
export function mergeBlocked(...lists: readonly (readonly BlockedAttempt[] | undefined)[]): BlockedAttempt[] {
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
export function persistDeferredMarker(
  file: string,
  nativeSaved: Extract<SlotOutcome, {state: 'native'}>,
  nativeError: string,
  extraBlocked?: BlockedAttempt[],
): void {
  const merged = mergeBlocked(nativeSaved.blocked, extraBlocked);
  atomic(file, {...nativeSaved, cliFallback: true as const, nativeError, ...(merged.length ? {blocked: merged} : {})});
}

export function readState(dir: string): FanoutState {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'fanout.json'), 'utf8')) as FanoutState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

export function writeState(dir: string, state: FanoutState): void {
  atomic(path.join(dir, 'fanout.json'), state);
}
// Saved voices whose logical slot left the recomputed roster reconcile as
// targets; settled failures stay dropped.
export function savedOrphanTargets(dir: string): RosterSlot[] {
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(dir, 'slots')); } catch { return []; }
  const out: RosterSlot[] = [];
  for (const file of files) {
    const name = /^([A-Za-z0-9_-]+\[\d+\])\.json$/.exec(file)?.[1];
    if (name === undefined) continue;
    let saved: {state?: string; provider?: unknown; model?: string | readonly string[]; effort?: string; responder?: {provider?: unknown}};
    try { saved = normalizeNative(JSON.parse(fs.readFileSync(path.join(dir, 'slots', file), 'utf8')) as SlotOutcome) as typeof saved; } catch { continue; }
    const provider = typeof saved.provider === 'string' ? saved.provider : saved.responder?.provider;
    if ((saved.state !== 'native' && saved.state !== 'done') || typeof provider !== 'string') continue;
    out.push({slot: name, provider, index: Number(name.slice(name.lastIndexOf('[') + 1, -1)),
      native: false, reserve: false,
      ...(saved.model === undefined ? {} : {model: saved.model}),
      ...(saved.effort === undefined ? {} : {effort: saved.effort})});
  }
  return out;
}

export type Emit = (slot: {slot: string; provider: string; model?: string | readonly string[] | undefined}, event: Omit<DiagnosticEvent, 'subject' | 'slot' | 'provider' | 'model' | 'attempt'> & Record<string, unknown>) => void;

export function slotFiles(dir: string, onFailed: FanOutInput['onFailed'], emit: Emit, hook: CliDeps['hook']) {
  const name = (slot: string) => {
    if (!/^[A-Za-z0-9_-]+\[\d+\]$/.test(slot)) throw new Error('Invalid roster slot ' + slot);
    return slot;
  };
  const fileOfLogical = (logical: string) => path.join(dir, 'slots', name(logical) + '.json');
  const basePathOf = (logical: string) => path.join(dir, 'prompts', name(logical) + '.md');
  const nativePathOf = (logical: string) => path.join(dir, 'prompts', name(logical) + '.native.md');
  const replyPathFor = (logical: string, nonce: string) => path.join(dir, 'replies', `${name(logical)}.${nonce}.md`);
  const oldReplyPathOf = (logical: string) => path.join(dir, 'replies', name(logical) + '.md');

  const readSaved = (logical: string): SlotOutcome | undefined => {
    try { return normalizeNative(JSON.parse(fs.readFileSync(fileOfLogical(logical), 'utf8')) as SlotOutcome); }
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
    if (toSave.state === 'failed') onFailed?.(toSave.slot, toSave as Extract<SlotOutcome, {state: 'failed'}>);
    atomic(fileOfLogical(target.slot), toSave);
    emit(target,{kind:'slot',state:toSave.state,...(toSave.state==='failed'?{cls:toSave.cls}:{})});
    await hook?.('fanout:after-slot');
    return toSave;
  };
  return {name, fileOfLogical, basePathOf, nativePathOf, replyPathFor, oldReplyPathOf, readSaved, saveLogical};
}

export function throwRejected(results: readonly PromiseSettledResult<unknown>[]): void {
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}
