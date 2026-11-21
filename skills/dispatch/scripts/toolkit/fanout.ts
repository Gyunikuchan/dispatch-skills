import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadReadCommands } from '../lib/config.ts';
import { readManifest } from '../lib/session.ts';
import { H } from '../policy/quota.ts';
import { parsePins, resolveRoster, nativeFirstRoute, normalizeProvider, type Pins, type Roster, type ReadDelegate, type PhasePolicy, type Underfill } from '../policy/roster.ts';
import { claudeHostSandboxed } from '../lib/platform.ts';
import type { CliDeps } from './cli.ts';
import type { RosterSlot } from './domain/types.ts';
import type { DiagnosticEvent } from './domain/diagnostics.ts';
import { ToolError } from './output.ts';
import type { Level } from './types.ts';
import { atomic, mergeBlocked, normalizeNative, persistDeferredMarker, readState, savedOrphanTargets, sessionOf, slotFiles, throwRejected, writeState, type BlockedAttempt, type Emit, type FanOutInput, type FanoutState, type NativeFailure, type SlotOutcome } from './fanout/state.ts';
import { cliVoice, VOICE_DEADLINE_MS } from './fanout/voice.ts';
import { attemptOf, blockedEntry, firstModelOf, isNativeFirstProvider, isNativeFirstSlot, nativeVoice, parseBlockedFile, reportEvidence } from './fanout/native.ts';
import { runNativeWave } from './fanout/wave.ts';

export { cliWaveState, nativeSummaryItems, type BlockedAttempt, type SlotOutcome, type Validation } from './fanout/state.ts';

export function parsePinsFlag(raw: unknown): Pins | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ToolError(1, 'invalid-input', '--pins must be a string');
  try { return parsePins(raw); }
  catch (error) { throw new ToolError(1, 'invalid-input', error instanceof Error ? error.message : String(error)); }
}

export function resolveSlots(kind: 'ask' | 'plan' | 'design' | 'code', level: Level, deps: CliDeps, pins?: Pins | null): Roster & {nativeFirstProviders: string[]} {
  const {config} = loadConfig(deps.skillRoot);
  const phases = config['phases'] as Record<string, PhasePolicy>;
  const readDelegates = config['read-delegates'] as Record<string, ReadDelegate>;
  let roster: Roster;
  try {
    roster = resolveRoster({level, readDelegates,
      orchestrator: deps.orchestrator, liveness: deps.liveness, ...(deps.sandboxSupported ? {sandboxSupported: deps.sandboxSupported} : {}),
      ...(pins ? {pins} : {}),
      ...(kind === 'ask' ? {} : {policy: phases[kind === 'code' ? 'code-review' : 'plan-review']})});
  } catch (error) {
    throw new ToolError(1, 'invalid-input', error instanceof Error ? error.message : String(error));
  }
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

/** True when any target or reserve slot runs a non-native, non-native-first CLI provider. */
export function hasCliSlot(roster: Roster & {nativeFirstProviders: readonly string[]}): boolean {
  return [...roster.targets, ...roster.reserves].some(
    slot => !slot.native && !isNativeFirstProvider(slot.provider, roster.nativeFirstProviders),
  );
}

/** Parse `--native-failed` and `--native-failed-hash` flags into NativeFailure entries. */
export function parseNativeFailures(values: Record<string, unknown>): NativeFailure[] {
  const rawFailed = values['native-failed'];
  const rawHashes = values['native-failed-hash'];
  const failedEntries = rawFailed === undefined ? [] : Array.isArray(rawFailed) ? rawFailed as string[] : [rawFailed as string];
  const failedHashes = rawHashes === undefined ? [] : Array.isArray(rawHashes) ? rawHashes as string[] : [rawHashes as string];
  return failedEntries.map((entry, index) => {
    const eq = entry.indexOf('=');
    return {attempt: entry.slice(0, eq), reason: entry.slice(eq + 1), reasonHash: failedHashes[index] ?? ''};
  });
}

/** Refuse CLI fan-out before state writes when a Claude host runs inside Claude Code's sandbox. */
export function assertHostNotSandboxed(
  deps: Pick<CliDeps, 'orchestrator' | 'env'>,
  roster: Roster & {nativeFirstProviders: readonly string[]},
  hasNativeFailed: boolean,
): void {
  if (
    deps.orchestrator?.platform === 'claude' &&
    claudeHostSandboxed((name) => deps.env[name]) &&
    (hasCliSlot(roster) || hasNativeFailed)
  ) {
    throw new ToolError(
      4,
      'host-sandboxed',
      "Claude Code's sandbox blocks CLI providers; rerun this same command with Claude Code's sandbox disabled (dangerouslyDisableSandbox: true); to make it permanent, add the dispatch command to sandbox.excludedCommands.",
    );
  }
}

export function underfillNote(roster: {underfill?: Underfill}): string {
  const u = roster.underfill;
  if (!u) return '';
  return `; underfill ${u.resolved}/${u.configured} targets, host ${u.host ?? 'undetected'}, excluded native-only: ${u.excluded.join(', ') || 'none'}${u.sandboxUnsupported?.length ? `, sandbox unsupported: ${u.sandboxUnsupported.join(', ')}` : ''}`;
}

export function nativePendingNote(count: number, wave: 'pending' | 'done' | undefined): string {
  const noun = count === 1 ? 'native slot pending' : 'native slots pending';
  if (wave === 'pending') return `${count} ${noun}; launch them now, then rerun this call to start the CLI wave`;
  return `${count} ${noun}; wait for every retained handle to finish or be reported, launch any slot without a handle, then rerun to consume`;
}

export async function fanOut(input: FanOutInput, deps: CliDeps): Promise<SlotOutcome[]> {
  const ordinals=new Map<string,number>();
  const emit: Emit = (slot, event) => {
    if(!deps.diagnostics)return;
    try {deps.diagnostics({...event,subject:input.dir,slot:slot.slot,provider:slot.provider,
      model:typeof slot.model==='string'?slot.model:(Array.isArray(slot.model)?slot.model[0]??undefined:undefined),attempt:ordinals.get(slot.slot)??0} as DiagnosticEvent);}catch{}
  };
  const all = Array.isArray(input.slots) ? input.slots as readonly RosterSlot[] :
    [...(input.slots as Roster).targets, ...(input.slots as Roster).reserves];
  const targets = all.filter(slot => !slot.reserve);
  const firstReserve = all.find(slot => slot.reserve);
  const nativeFirstProviders = input.nativeFirstProviders ?? [];
  const nativeFailures = input.nativeFailures ?? [];
  const session = sessionOf(input.dir), manifest = readManifest(session);
  const cwd = input.cwd ?? manifest.repositoryRoot;
  const store = {sessionDir: session, repositoryRoot: manifest.repositoryRoot, bucketWidth: H};
  const deadline = deps.clock() + VOICE_DEADLINE_MS;
  const readCommands = loadReadCommands(deps.skillRoot);
  const rerun = fs.existsSync(path.join(input.dir, 'logs'));
  for (const dir of ['prompts','slots','replies','logs']) fs.mkdirSync(path.join(input.dir, dir), {recursive: true});
  const files = slotFiles(input.dir, (slot, outcome) => input.onFailed?.(slot, outcome), emit, name => deps.hook?.(name));
  const {fileOfLogical, basePathOf, readSaved, saveLogical} = files;
  const runCliVoice = cliVoice(input, deps, {cwd, store, deadline, readCommands, rerun, files, emit,
    beginAttempt: logical => ordinals.set(logical, (ordinals.get(logical) ?? 0) + 1)});

  const hasNativeFirstNow = targets.some(slot => isNativeFirstSlot(slot, nativeFirstProviders));
  let state = readState(input.dir);
  const useNativeWave = hasNativeFirstNow || !!state.nativeFirst;
  // Reserve ownership persists across calls; in-memory copy guards concurrent targets in one call.
  let reserveOwner: string | undefined = state.reserveUsedBy;

  const patchState = (patch: FanoutState): void => {
    state = {...state, ...patch};
    writeState(input.dir, state);
  };

  // Synchronous claim before any async launch: check and claim stay adjacent
  // with no await between, so concurrent cascades cannot double-claim.
  const claimReserve = (logical: string): void => {
    if (reserveOwner === logical) return;
    reserveOwner = logical;
    patchState({reserveUsedBy: logical});
  };

  // Durable per-generation evidence that a native voice launched, covering
  // every native descriptor (native-first, native-only, reserve
  // substitutes). The change check reads it to tell a lost baseline from a
  // round that never needed one. It never affects routing: only nativeFirst
  // selects the wave path.
  const markNativeLaunched = (): void => {
    if (state.nativeLaunched === true) return;
    patchState({nativeLaunched: true});
  };
  const finishCliWave = (): void => {
    state = {...readState(input.dir), cliWaveDone: true};
    // Preserve reserveUsedBy from in-memory owner.
    if (reserveOwner !== undefined) state.reserveUsedBy = reserveOwner;
    writeState(input.dir, state);
  };
  const native = nativeVoice(input, {all, firstReserve, nativeFirstProviders, host: () => deps.orchestrator, cwd, files,
    emit, markNativeLaunched, claimReserve, ownerOfReserve: () => reserveOwner, voiceCLI: runCliVoice});
  if (useNativeWave) return runNativeWave(input, {targets, nativeFirstProviders, nativeFailures, files, native,
    emit, voiceCLI: runCliVoice, stateOf: () => state, patchState, finishCliWave});
  const {baseTextOf, createNativeOnly, invalidateReply, markInvalid, fallbackToCli, isCurrentHost,
    reserveLaunchable, routeForNative, takeReserve, saveReportFailure, saveDoneFromNative, prepareHostBlocked} = native;

  // CLI-only path: the roster has no native-first target. Keeps today's immediate
  // CLI with persistent reserve; reserve substitutes stay here too (no wave is
  // advertised for them) and are consumed via their physical route.
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
          const {failed, reserve} = prepareHostBlocked(slot, nativeSaved, raw, attemptOf(slot,nativeSaved));
          if (reserve) {
            const launched = await reserve;
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
          savedOutcomes.set(slot.slot, saveDoneFromNative(slot, nativeSaved, checked.text ?? text));
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
          savedOutcomes.set(slot.slot, saveDoneFromNative(slot, nativeSaved, checked.text ?? text));
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
  throwRejected(await Promise.allSettled(deferredFallbacks));
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
    let outcome = await runCliVoice(slot, slot.slot, promptPath);
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
  throwRejected(results);
  return results.map(result => (result as PromiseFulfilledResult<SlotOutcome>).value);
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
      try { saved = normalizeNative(JSON.parse(fs.readFileSync(path.join(input.dir, 'slots', orphan.slot + '.json'), 'utf8')) as SlotOutcome); }
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
