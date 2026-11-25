import crypto from 'node:crypto';
import fs from 'node:fs';
import { failureDisposition } from '../../policy/cascade.ts';
import { normalizeProvider } from '../../policy/roster.ts';
import { sessionScope, formatSafetyPrompt } from '../../providers/runner.ts';
import { nodeRunnerFs } from '../../providers/node-process.ts';
import { BLOCKED_MARKER, failureReasonDisplay, failureReasonEvidence, isBlockedReply, parseBlockedReply } from '../domain/blocker.ts';
import type { CliDeps } from '../cli.ts';
import type { RosterSlot } from '../domain/types.ts';
import { atomic, mergeBlocked, nativeLaunchAs, type BlockedAttempt, type Emit, type FailureClass, type FanOutInput, type NativeFailure, type SlotOutcome, type Validation, type slotFiles } from './state.ts';
import type { cliVoice } from './voice.ts';

const newNativeReply = (cwd: string, replyPath: string) => `\n\n## Native reply\n\nWork in \`${cwd}\` for reads and Git commands.\n\nWrite the reply that the instructions above require, in their exact format, to \`${replyPath}\`; do not return it inline. Then reply only \`wrote ${replyPath}\`, or \`${BLOCKED_MARKER} <reason>\` when you cannot write it.\n`;

export function firstModelOf(slot: {model?: string | readonly string[] | undefined}): string | null {
  if (slot.model === undefined) return null;
  if (typeof slot.model === 'string') return slot.model;
  return slot.model[0] ?? null;
}

export function isNativeFirstSlot(slot: RosterSlot, providers: readonly string[] | undefined): boolean {
  return !slot.native && !slot.reserve && isNativeFirstProvider(slot.provider, providers);
}

export function isNativeFirstProvider(provider: string, providers: readonly string[] | undefined): boolean {
  if (!providers?.length) return false;
  const normalized = normalizeProvider(provider);
  return providers.some(candidate => normalizeProvider(candidate) === normalized);
}

function makeNonce(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 6);
}

export function blockedEntry(provider: string, model: string | null, raw: string): BlockedAttempt {
  return { provider, model, ...failureReasonEvidence(raw) };
}

// Display form of a failure reason: reported BLOCKED evidence wins, the
// protocol marker recovers its raw text, anything else keeps its wording.
function blockedDisplayOf(reason: string, evidence?: BlockedAttempt[]): string {
  if (evidence?.[0]?.reason) return evidence[0].reason;
  const raw = isBlockedReply(reason) ? parseBlockedReply(reason).raw : reason.trim();
  return failureReasonDisplay(raw);
}

// Blocked evidence for a reported attempt, attributed to the voice that ran it.
export function reportEvidence(native: {provider: string; model?: string | readonly string[]}, report: NativeFailure): BlockedAttempt[] | undefined {
  if (!isBlockedReply(report.reason)) return undefined;
  return [{provider: native.provider, model: firstModelOf(native), reason: blockedDisplayOf(report.reason), reasonHash: report.reasonHash}];
}

  // Native events name the voice that launched: a reserve attempt reports the reserve's provider and model under the logical slot.
  export const attemptOf = (logical: RosterSlot, voice: {provider: string; model?: string | readonly string[]; effort?: string}) => ({slot: logical.slot, provider: voice.provider, model: voice.model, ...(voice.effort !== undefined ? { effort: voice.effort } : {})});
export function nativeVoice(input: Pick<FanOutInput, 'sessionRoot' | 'prompt'>, ports: {
  all: readonly RosterSlot[]; firstReserve: RosterSlot | undefined; nativeFirstProviders: readonly string[];
  host: () => CliDeps['orchestrator']; cwd: string; files: Omit<ReturnType<typeof slotFiles>, 'name'>;
  emit: Emit; markNativeLaunched: () => void; claimReserve: (logical: string) => void;
  ownerOfReserve: () => string | undefined; voiceCLI: ReturnType<typeof cliVoice>;
}) {
  const {all, firstReserve, nativeFirstProviders, host: orchestrator, cwd, files, emit, markNativeLaunched, claimReserve, ownerOfReserve, voiceCLI} = ports;
  const {fileOfLogical, basePathOf, nativePathOf, replyPathFor, oldReplyPathOf, readSaved, saveLogical} = files;
  const baseTextOf = (slot: RosterSlot): string => typeof input.prompt === 'string' ? input.prompt : input.prompt(slot);

  const buildNativePrompt = (baseText: string, replyPath: string): string => {
    const scope = sessionScope(input.sessionRoot, nodeRunnerFs);
    const guarded = formatSafetyPrompt(baseText, {...scope, ...(cwd ? {workspaceRoot: cwd} : {})});
    return `${guarded}\n\n[REPLY FILE EXCEPTION]: You may write only to \`${replyPath}\`; all other project file writes stay denied.\n` + newNativeReply(cwd, replyPath);
  };

  const descriptor = (logical: RosterSlot, physical: RosterSlot, promptPath: string, replyPath: string, attempt: string): Extract<SlotOutcome, {state: 'native'}> => ({
    slot: logical.slot, state: 'native', promptPath, replyPath,
    provider: physical.provider, attempt, cwd,
    ...(physical.model !== undefined ? {model: physical.model} : {}),
    ...(physical.effort !== undefined ? {effort: physical.effort} : {}),
    launchAs: nativeLaunchAs(physical.provider, physical.model, physical.effort),
  });

  const appendNativeReply = (baseFile: string, baseText: string, replyPath: string): void => {
    try {
      const current = fs.readFileSync(baseFile, 'utf8');
      if (!current.includes('## Native reply')) fs.appendFileSync(baseFile, newNativeReply(cwd, replyPath));
    } catch { fs.writeFileSync(baseFile, baseText + newNativeReply(cwd, replyPath), {mode: 0o600}); }
  };

  const publishNative = (slot: RosterSlot, outcome: Extract<SlotOutcome, {state: 'native'}>): SlotOutcome => {
    atomic(fileOfLogical(slot.slot), outcome);
    emit(slot, {kind: 'slot', state: 'native'});
    return outcome;
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
    appendNativeReply(baseFile, baseText, replyPath);
    const outcome = descriptor(slot, slot, baseFile, replyPath, attempt);
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
    return descriptor(logical, physical, nativeFile, replyPath, attempt);
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
    const blockedFailure = isBlockedReply(nativeError) || (nativeError.startsWith('blocked: ') && merged.length > 0);
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
        const launched = await takeReserveWithFreshPrompt(logical, failed);
        if (launched) return launched.state === 'native' ? launched : saveLogical(logical, launched);
      }
      return saveLogical(logical, failed);
    }
    if (physical === undefined || physical.native) return saveLogical(logical, failedForHost());
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
    }
    return saveLogical(logical, {...cliOutcome, slot: logical.slot});
  };

  const isCurrentHost = (provider: string): boolean => {
    const host = orchestrator()?.platform;
    if (!host) return false;
    return normalizeProvider(provider) === normalizeProvider(host);
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
    const reserveOwner = ownerOfReserve();
    if (!firstReserve) return false;
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
    appendNativeReply(baseFile, baseText, replyPath);
    const created = descriptor(logical, reserve, baseFile, replyPath, `${reserve.slot}#${nonce}`);
    const withBlocked = failed.blocked?.length ? {...created, blocked: mergeBlocked(created.blocked, failed.blocked)} : created;
    markNativeLaunched();
    return publishNative(logical, withBlocked);
  };

  // A saved native consumes on its physical route: native-first, or a
  // native-only attempt from the current host. The CLI-only prepass uses
  // routeTrue/nativeOnlyAttempt to make the same distinction before fallback.
  // ONE per-slot native resolution shared by every path: physical route
  // BEFORE substitution (missing physical fails closed on saved evidence,
  // no CLI under the wrong voice) and the exact BLOCKED report marker in
  // every report and replay path.
  const routeForNative = (saved: {attempt: string; provider: string}): {physical: RosterSlot | undefined; routeOk: boolean; first: boolean} => {
    const physicalSlot = saved.attempt.split('#')[0] ?? '';
    const physical = all.find(entry => entry.slot === physicalSlot);
    const first = isNativeFirstProvider(physical?.provider ?? saved.provider, nativeFirstProviders);
    const routeOk = physical !== undefined && (first || ((physical.native ?? false) && isCurrentHost(physical.provider)));
    return {physical, routeOk, first};
  };
  // One reserve gate for every path: native-first descriptor, native-only on
  // current host, keep failed off-host, CLI only for non-native. The current
  // host never runs its CLI: a host reserve mints a native descriptor.
  const takeReserve = async (logical: RosterSlot, failed: SlotOutcome, promptPath: string): Promise<SlotOutcome | undefined> => {
    if (!firstReserve) return undefined;
    const first = isNativeFirstProvider(firstReserve.provider, nativeFirstProviders);
    if (firstReserve.native) {
      if (!isCurrentHost(firstReserve.provider)) return undefined;
      claimReserve(logical.slot);
      return createNativeOnlyReserve(logical, firstReserve, failed);
    }
    if (first || isCurrentHost(firstReserve.provider)) {
      const native = createNativeFirst(logical, firstReserve);
      const withBlocked = failed.blocked?.length ? {...native, blocked: mergeBlocked(native.blocked, failed.blocked)} : native;
      claimReserve(logical.slot);
      return publishNative(logical, withBlocked);
    }
    claimReserve(logical.slot);
    const substitute = await voiceCLI(firstReserve, logical.slot, promptPath);
    emit(firstReserve, {kind:'slot', state:substitute.state, targetSlot:logical.slot, ...(substitute.state === 'failed' ? {cls: substitute.cls} : {})});
    const blocked = mergeBlocked(failed.blocked, substitute.blocked);
    return {...substitute, slot: logical.slot, ...(blocked.length?{blocked}:{})} as SlotOutcome;
  };
  const takeReserveWithFreshPrompt = (slot: RosterSlot, failed: SlotOutcome): Promise<SlotOutcome | undefined> => {
    const baseFile = basePathOf(slot.slot);
    fs.writeFileSync(baseFile, baseTextOf(slot), {mode: 0o600});
    return takeReserve(slot, failed, baseFile);
  };

  // A reported native failure ends its attempt. External reports use the exact
  // 'BLOCKED:' marker only; any other casing is a refusal, not the protocol marker.
  // A current-host attempt that is not a substitute takes its reserve when allowed.
  const saveReportFailure = async (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, report: NativeFailure): Promise<SlotOutcome> => {
    const sanitized = blockedDisplayOf(report.reason);
    invalidateReply(native.replyPath);
    emit(attemptOf(slot, native), {kind: 'native', state: 'failed'});
    const canSubstitute = isCurrentHost(native.provider) && native.attempt.split('#')[0] === slot.slot;
    const cls = isBlockedReply(report.reason) ? 'blocked' : 'refusal';
    const blocked = cls === 'blocked' ? mergeBlocked(native.blocked, reportEvidence(native, report)) : native.blocked;
    const failed: Extract<SlotOutcome, {state: 'failed'}> = {
      slot: slot.slot, state: 'failed', cls, reason: cls + ': ' + sanitized, ...(blocked?.length ? {blocked} : {}),
    };
    if (canSubstitute && reserveAllowed(slot.slot, failed.cls)) {
      const launched = await takeReserveWithFreshPrompt(slot, failed);
      if (launched) return launched.state === 'native' ? launched : saveLogical(slot, launched);
    }
    return saveLogical(slot, failed);
  };

  // The responder records the launched voice, not the current roster: a config
  // change between launch and consumption must not attribute the answer to a
  // model or effort that never launched.
  const saveDoneFromNative = (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, text: string): SlotOutcome => {
    const done: SlotOutcome = {
      slot: slot.slot, state: 'done', text,
      responder: {slot: slot.slot, provider: native.provider, model: firstModelOf(native), native: true, ...(native.effort !== undefined ? {effort: native.effort} : {})},
      ...(native.blocked?.length ? {blocked: native.blocked} : {}),
    };
    atomic(fileOfLogical(slot.slot), done);
    return done;
  };

  const prepareHostBlocked = (slot: RosterSlot, native: Extract<SlotOutcome, {state: 'native'}>, raw: string, voice: Parameters<Emit>[0]) => {
    const entry = blockedEntry(native.provider, firstModelOf(native), raw);
    emit(voice, {kind: 'validation', surface: 'native', outcome: 'blocked'});
    emit(voice, {kind: 'native', state: 'failed', replay: true});
    invalidateReply(native.replyPath);
    const blocked = mergeBlocked(native.blocked, [entry]);
    const failed: Extract<SlotOutcome, {state: 'failed'}> = {slot: slot.slot, state: 'failed', cls: 'blocked', reason: 'blocked: ' + entry.reason, blocked};
    if (native.attempt.split('#')[0] !== slot.slot || !reserveAllowed(slot.slot, failed.cls)) return {failed};
    return {failed, reserve: takeReserveWithFreshPrompt(slot, failed)};
  };

  return {baseTextOf, publishNative, createNativeOnly, createNativeFirst, invalidateReply, markInvalid, fallbackToCli,
    isCurrentHost, reserveAllowed, reserveLaunchable, routeForNative, takeReserve, saveReportFailure, saveDoneFromNative, prepareHostBlocked};
}
