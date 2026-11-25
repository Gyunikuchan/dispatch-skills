import { nodeErrorCode } from '../../lib/fs-ext.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameRetrying } from '../../lib/node-fs-ext.ts';
import type { quotaSnapshot } from '../../policy/quota.ts';
import type { Roster } from '../../policy/roster.ts';
import { launchLine, summaryLaunch } from '../../lib/platform.ts';
import type { RunOutcome } from '../../providers/types.ts';
import type { CliDeps } from '../cli.ts';
import type { DiagnosticEvent } from '../domain/diagnostics.ts';
import type { RosterSlot } from '../domain/types.ts';
import { isRecord } from '../../lib/config.ts';
import { parseJson } from '../../lib/integrity.ts';

export type FailureClass = Extract<RunOutcome, { status: 'fail' }>['cls'];
export type BlockedAttempt = { provider: string; model: string | null; reason: string; reasonHash: string };
export type Validation =
  | { ok: true; text?: string }
  | { ok: false; cls: FailureClass; reason: string; blocked?: { reason: string; reasonHash: string } };
export type SlotOutcome = { slot: string; blocked?: Array<BlockedAttempt> } & (
  | {
      state: 'done';
      text: string;
      responder?: { slot: string; provider: string; model: string | null; native: boolean; effort?: string };
    }
  | {
      state: 'native';
      promptPath: string;
      replyPath: string;
      provider: string;
      attempt: string;
      cwd: string;
      model?: string | ReadonlyArray<string>;
      effort?: string;
      launchAs?: string;
      error?: string;
      cliFallback?: true;
      nativeError?: string;
    }
  | { state: 'failed'; cls: FailureClass; reason: string; cliOnly?: true }
);
export type NativeFailure = { attempt: string; reason: string; reasonHash: string };

const nativeModels = (model: string | ReadonlyArray<string> | undefined): Array<string> =>
  model === undefined ? [] : typeof model === 'string' ? [model] : [...model];
export const nativeLaunchAs = (
  provider: string,
  model: string | ReadonlyArray<string> | undefined,
  effort: string | undefined,
): string => launchLine(provider, nativeModels(model), effort ?? null);
/** Distinct first-model summary launch lines for pending native descriptors. */
export const nativeSummaryItems = (
  outcomes: ReadonlyArray<Extract<SlotOutcome, { state: 'native' }>>,
): Array<string> => [
  ...new Set(
    outcomes.map((outcome) => summaryLaunch(outcome.provider, nativeModels(outcome.model), outcome.effort ?? null)),
  ),
];
export function normalizeNative(outcome: SlotOutcome): SlotOutcome {
  if (outcome.state !== 'native') {
    return outcome;
  }
  const { subagentModels: _legacy, ...rest } = outcome as Extract<SlotOutcome, { state: 'native' }> & {
    subagentModels?: unknown;
  };
  return { ...rest, launchAs: rest.launchAs ?? nativeLaunchAs(rest.provider, rest.model, rest.effort) };
}
// Only fan-out writes slot and state files; these guards prove the tag and the table, not every field.
const isSavedOutcome = (value: unknown): value is SlotOutcome => isRecord(value) && typeof value['state'] === 'string';
const isFanoutState = (value: unknown): value is FanoutState => isRecord(value);

export function parseSavedOutcome(text: string) {
  const parsed: unknown = parseJson(text);
  if (!isSavedOutcome(parsed)) {
    throw new TypeError('Saved slot outcome has no state');
  }
  return parsed;
}

export type FanOutInput = {
  dir: string;
  slots: ReadonlyArray<RosterSlot> | Roster;
  prompt: string | ((slot: RosterSlot) => string);
  validate: (text: string, logicalSlot: string) => Validation;
  cwd?: string;
  /** Active session directory; forwarded so the delegate guard can exempt its artifacts. */
  sessionRoot?: string;
  quota?: ReturnType<typeof quotaSnapshot>;
  onFailed?: (slot: string, outcome: Extract<SlotOutcome, { state: 'failed' }>) => void;
  nativeFirstProviders?: ReadonlyArray<string>;
  nativeFailures?: ReadonlyArray<NativeFailure>;
  onIgnoredReport?: (attempt: string) => void;
};

export type FanoutState = { nativeFirst?: true; cliWaveDone?: true; reserveUsedBy?: string; nativeLaunched?: true };

export function cliWaveState(dir: string): 'pending' | 'done' | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'fanout.json'), 'utf8');
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = parseJson(raw);
  } catch {
    return undefined;
  }
  if (!isFanoutState(data) || !data.nativeFirst) {
    return undefined;
  }
  return data.cliWaveDone ? 'done' : 'pending';
}

export function sessionOf(directory: string): string {
  let current = path.resolve(directory);
  for (;;) {
    if (fs.existsSync(path.join(current, 'manifest.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Fan-out directory has no session manifest ancestor');
    }
    current = parent;
  }
}

export function atomic(file: string, value: unknown): void {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
    renameRetrying(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** One entry per logical blocked attempt: repeated modes keep the same alias once, distinct reasons stay apart. */
export function mergeBlocked(
  ...lists: ReadonlyArray<ReadonlyArray<BlockedAttempt> | undefined>
): Array<BlockedAttempt> {
  const out: Array<BlockedAttempt> = [];
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (
        out.some(
          (item) =>
            item.provider === entry.provider && item.model === entry.model && item.reasonHash === entry.reasonHash,
        )
      ) {
        continue;
      }
      out.push(entry);
    }
  }
  return out;
}

// Step 1 of the fallback transition only: persist the marker with the
// native error and merged blocked evidence, without running the CLI
// cascade. The deferred wave resumes the cascade, so the marker never
// returns as a launchable pending voice.
export function persistDeferredMarker(
  file: string,
  nativeSaved: Extract<SlotOutcome, { state: 'native' }>,
  nativeError: string,
  extraBlocked?: Array<BlockedAttempt>,
): void {
  const merged = mergeBlocked(nativeSaved.blocked, extraBlocked);
  atomic(file, {
    ...nativeSaved,
    cliFallback: true as const,
    nativeError,
    ...(merged.length && { blocked: merged }),
  });
}

export function readState(dir: string): FanoutState {
  try {
    const parsed: unknown = parseJson(fs.readFileSync(path.join(dir, 'fanout.json'), 'utf8'));
    if (!isFanoutState(parsed)) {
      throw new TypeError('Fan-out state is not an object');
    }
    return parsed;
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export function writeState(dir: string, state: FanoutState): void {
  atomic(path.join(dir, 'fanout.json'), state);
}
// Saved voices whose logical slot left the recomputed roster reconcile as
// targets; settled failures stay dropped.
export function savedOrphanTargets(dir: string): Array<RosterSlot> {
  let files: Array<string>;
  try {
    files = fs.readdirSync(path.join(dir, 'slots'));
  } catch {
    return [];
  }
  const out: Array<RosterSlot> = [];
  for (const file of files) {
    const name = /^([A-Za-z0-9_-]+\[\d+\])\.json$/.exec(file)?.[1];
    if (name === undefined) {
      continue;
    }
    let saved: {
      state?: string;
      provider?: unknown;
      model?: string | ReadonlyArray<string>;
      effort?: string;
      responder?: { provider?: unknown };
    };
    try {
      saved = normalizeNative(parseSavedOutcome(fs.readFileSync(path.join(dir, 'slots', file), 'utf8')));
    } catch {
      continue;
    }
    const provider = typeof saved.provider === 'string' ? saved.provider : saved.responder?.provider;
    if ((saved.state !== 'native' && saved.state !== 'done') || typeof provider !== 'string') {
      continue;
    }
    out.push({
      slot: name,
      provider,
      index: Number(name.slice(name.lastIndexOf('[') + 1, -1)),
      native: false,
      reserve: false,
      ...(!(saved.model === undefined) && { model: saved.model }),
      ...(!(saved.effort === undefined) && { effort: saved.effort }),
    });
  }
  return out;
}

// Distributes over the event union so each kind keeps its own detail fields.
type EventDetail<T> = T extends unknown ? Omit<T, 'subject' | 'slot' | 'provider' | 'model' | 'attempt'> : never;
export type Emit = (
  slot: { slot: string; provider: string; model?: string | ReadonlyArray<string> | undefined; effort?: string },
  event: EventDetail<DiagnosticEvent>,
) => void;

const name = (slot: string) => {
  if (!/^[A-Za-z0-9_-]+\[\d+\]$/.test(slot)) {
    throw new Error('Invalid roster slot ' + slot);
  }
  return slot;
};

export function slotFiles(dir: string, onFailed: FanOutInput['onFailed'], emit: Emit, hook: CliDeps['hook']) {
  const fileOfLogical = (logical: string) => path.join(dir, 'slots', name(logical) + '.json');
  const basePathOf = (logical: string) => path.join(dir, 'prompts', name(logical) + '.md');
  const nativePathOf = (logical: string) => path.join(dir, 'prompts', name(logical) + '.native.md');
  const replyPathFor = (logical: string, nonce: string) => path.join(dir, 'replies', `${name(logical)}.${nonce}.md`);
  const oldReplyPathOf = (logical: string) => path.join(dir, 'replies', name(logical) + '.md');

  const readSaved = (logical: string): SlotOutcome | undefined => {
    try {
      return normalizeNative(parseSavedOutcome(fs.readFileSync(fileOfLogical(logical), 'utf8')));
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  };

  const hasNativeHistory = (logical: string): boolean => {
    try {
      if (fs.existsSync(nativePathOf(logical))) {
        return true;
      }
    } catch {
      return true;
    }
    try {
      const prior = readSaved(logical);
      if (prior?.state === 'native') {
        return true;
      }
      if (prior?.state === 'failed' && (prior as { cliOnly?: true }).cliOnly !== true) {
        return true;
      }
    } catch {
      return true;
    }
    return false;
  };

  const saveLogical = async (target: RosterSlot, outcome: SlotOutcome) => {
    // CLI-only-ness is crash-consistent: the marker rides the atomic failed write.
    // A lost write means no saved failed to retake; an old file without the marker
    // fails closed to no-retake. Any native history bars the marker: the prompt
    // file, a still-pending native attempt, or a prior failed save without the
    // marker (which itself saw native history).
    let toSave = outcome;
    if (outcome.state === 'failed' && !target.native && !hasNativeHistory(target.slot)) {
      toSave = { ...outcome, cliOnly: true as const };
    }
    if (toSave.state === 'failed') {
      onFailed?.(toSave.slot, toSave);
    }
    atomic(fileOfLogical(target.slot), toSave);
    emit(target, { kind: 'slot', state: toSave.state, ...(toSave.state === 'failed' && { cls: toSave.cls }) });
    await hook?.('fanout:after-slot');
    return toSave;
  };
  return { name, fileOfLogical, basePathOf, nativePathOf, replyPathFor, oldReplyPathOf, readSaved, saveLogical };
}

export function throwRejected(results: ReadonlyArray<PromiseSettledResult<unknown>>): void {
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') {
    throw rejected.reason;
  }
}
