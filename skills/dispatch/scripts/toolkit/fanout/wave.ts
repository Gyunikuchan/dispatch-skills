import fs from "node:fs";

import { publishExclusive } from "../../lib/fs-ext.ts";
import { nodeLinkFs } from "../../lib/node-fs-ext.ts";
import { parseBlockedReply } from "../domain/blocker.ts";
import type { RosterSlot } from "../domain/types.ts";
import {
  attemptOf,
  blockedEntry,
  firstModelOf,
  isNativeFirstSlot,
  reportEvidence,
} from "./native.ts";
import type { nativeVoice } from "./native.ts";
import {
  atomic,
  mergeBlocked,
  persistDeferredMarker,
  throwRejected,
} from "./state.ts";
import type {
  BlockedAttempt,
  Emit,
  FanOutInput,
  FanoutState,
  NativeFailure,
  SlotOutcome,
  slotFiles,
} from "./state.ts";
import type { cliVoice } from "./voice.ts";

const isOnly = (slot: RosterSlot) => slot.native;

// Drops slots that have no outcome yet.
const settled = (outcomes: readonly (SlotOutcome | undefined)[]) =>
  outcomes.flatMap((outcome) => (outcome ? [outcome] : []));

// NOTE: An unwritable marker falls back to this process-wide set, so another process can repeat the replay emit.
const replayClaimedInMemory = new Set<string>();

// Claims the once-per-slot replay emit; the marker file keeps the claim across processes.
const claimReplayEmit = (marker: string) => {
  if (replayClaimedInMemory.has(marker)) {
    return false;
  }

  replayClaimedInMemory.add(marker);

  try {
    return publishExclusive(nodeLinkFs, marker, "");
  } catch {
    return true;
  }
};

// oxlint-disable-next-line eslint/complexity -- wave fold branches per failure report, attempt match, and pending state.
export const runNativeWave = async (
  input: Pick<FanOutInput, "validate" | "onIgnoredReport">,
  ports: {
    targets: readonly RosterSlot[];
    nativeFirstProviders: readonly string[];
    nativeFailures: readonly NativeFailure[];
    files: Pick<
      ReturnType<typeof slotFiles>,
      | "basePathOf"
      | "fileOfLogical"
      | "readSaved"
      | "replayMarkerOf"
      | "saveLogical"
    >;
    native: ReturnType<typeof nativeVoice>;
    emit: Emit;
    voiceCLI: ReturnType<typeof cliVoice>;
    stateOf: () => Readonly<FanoutState>;
    patchState: (patch: Pick<FanoutState, "nativeFirst">) => void;
    finishCliWave: () => void;
  }
) => {
  const {
    targets,
    nativeFirstProviders,
    nativeFailures,
    files: {
      basePathOf,
      fileOfLogical,
      readSaved,
      replayMarkerOf,
      saveLogical,
    },
    native: {
      baseTextOf,
      createNativeOnly,
      createNativeFirst,
      invalidateReply,
      markInvalid,
      fallbackToCli,
      isCurrentHost,
      publishNative,
      reserveAllowed,
      reserveLaunchable,
      routeForNative,
      takeReserve,
      saveReportFailure,
      saveDoneFromNative,
      prepareHostBlocked,
    },
    emit,
    voiceCLI,
    stateOf,
    patchState,
    finishCliWave,
  } = ports;

  // Native wave: launch, CLI wave, consume.
  const isFirst = (slot: RosterSlot) =>
    isNativeFirstSlot(slot, nativeFirstProviders);

  const notifyUnmatchedReports = (
    matchedReportAttempts: ReadonlySet<string>
  ) => {
    for (const report of nativeFailures) {
      if (matchedReportAttempts.has(report.attempt)) {
        continue;
      }

      const stillPending = targets.some((slot) => {
        const saved = readSaved(slot.slot);

        // SAFETY: the state guard narrows saved to a native outcome; the assertions only read its optional persisted attempt and cliFallback fields.
        return (
          saved?.state === "native" &&
          (saved as { attempt?: string }).attempt === report.attempt &&
          !(saved as { cliFallback?: true }).cliFallback
        );
      });

      if (stillPending) {
        continue;
      }

      input.onIgnoredReport?.(report.attempt);
    }
  };

  // Launch: no state yet, native-first unsaved.
  if (!stateOf().nativeFirst) {
    const outcomes: SlotOutcome[] = [];
    const matchedReportAttempts = new Set<string>();

    // A matching failure report ends a saved native-only attempt with the
    // native-only classification (no cli cascade), mirroring the cli-only
    // prepass. Anything else replays below.
    const failNativeOnlyLaunch = async (
      slot: RosterSlot,
      native: Extract<SlotOutcome, { state: "native" }>,
      report: NativeFailure
    ) => {
      matchedReportAttempts.add(report.attempt);
      invalidateReply(native.replyPath);
      const saved = await saveReportFailure(slot, native, report);
      outcomes.push(saved);
    };

    // A saved native-first attempt off its route defers to the CLI wave. A
    // matching report persists its evidence; otherwise the marker records the
    // host change. Only the marker persists here, so new descriptors return first.
    const deferUnroutable = (
      slot: RosterSlot,
      existing: Extract<SlotOutcome, { state: "native" }>
    ) => {
      const report = nativeFailures.find(
        (entry) => entry.attempt === existing.attempt
      );

      if (report === undefined) {
        persistDeferredMarker(
          fileOfLogical(slot.slot),
          existing,
          "host changed"
        );

        return;
      }

      matchedReportAttempts.add(report.attempt);
      persistDeferredMarker(
        fileOfLogical(slot.slot),
        existing,
        report.reason,
        reportEvidence(existing, report)
      );
    };

    for (const slot of targets) {
      if (isOnly(slot)) {
        const existing = readSaved(slot.slot);

        if (existing?.state === "native") {
          const report = nativeFailures.find(
            (entry) => entry.attempt === existing.attempt
          );

          if (report) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            await failNativeOnlyLaunch(slot, existing, report);
            continue;
          }
        }

        if (existing?.state === "native" || existing?.state === "done") {
          if (
            existing.state === "done" &&
            !input.validate(existing.text, slot.slot).ok
          ) {
            void 0;
            // Drop stale done below.
          } else {
            emit(slot, { kind: "slot", state: existing.state, replay: true });
            outcomes.push(existing);
            continue;
          }
        }

        // A saved failed native-only reruns below as a fresh native attempt.
        outcomes.push(publishNative(slot, createNativeOnly(slot)));
        continue;
      }

      if (isFirst(slot)) {
        const existing = readSaved(slot.slot);

        if (
          existing?.state === "native" &&
          // SAFETY: the state guard narrows existing to a native outcome; the assertion only reads its optional cliFallback flag.
          !(existing as { cliFallback?: true }).cliFallback
        ) {
          // A host change can make the logical slot native-first while the
          // saved attempt belongs to another provider: check the physical
          // route before replaying, or the old-host attempt stays pending.
          if (!routeForNative(existing).routeOk) {
            deferUnroutable(slot, existing);
            continue;
          }

          emit(slot, { kind: "slot", state: "native", replay: true });
          outcomes.push(existing);
          continue;
        }

        if (
          existing?.state === "done" &&
          input.validate(existing.text, slot.slot).ok
        ) {
          emit(slot, { kind: "slot", state: "done", replay: true });
          outcomes.push(existing);
          continue;
        }

        // Failed or missing: mint fresh. A saved fallback marker resumes in
        // the CLI wave, never as pending, so it stays out of this return.
        // On launch retry after crash before state write, reuse existing native if present.
        if (existing?.state === "native") {
          continue;
        }

        outcomes.push(publishNative(slot, createNativeFirst(slot, slot)));
        continue;
      }
    }

    // Targets that are neither native-only nor native-first are normally
    // unsaved on launch. A host change can still leave them with a saved
    // outcome: replay done and failed saves, and route a pending reserve by
    // its physical provider like the first-slot branch above, so no saved
    // voice is omitted while a matching failure report is retained.
    for (const slot of targets) {
      if (isOnly(slot) || isFirst(slot)) {
        continue;
      }

      const existing = readSaved(slot.slot);

      if (!existing) {
        continue;
      }

      if (existing.state === "done") {
        if (input.validate(existing.text, slot.slot).ok) {
          emit(slot, { kind: "slot", state: "done", replay: true });
          outcomes.push(existing);
        }

        continue;
      }

      if (existing.state === "failed") {
        emit(slot, { kind: "slot", state: "failed", replay: true });
        outcomes.push(existing);
        continue;
      }

      if (
        existing.state === "native" &&
        // SAFETY: the state guard narrows existing to a native outcome; the assertion only reads its optional cliFallback flag.
        !(existing as { cliFallback?: true }).cliFallback
      ) {
        if (!routeForNative(existing).routeOk) {
          deferUnroutable(slot, existing);
          continue;
        }

        emit(slot, { kind: "slot", state: "native", replay: true });
        outcomes.push(existing);
        continue;
      }

      // A fallback marker resumes in the CLI wave with its recorded reason,
      // never as pending. Unsaved targets stay absent here: the deferred wave
      // processes them, and the caller keeps the round open until it does.
      continue;
    }

    patchState({ nativeFirst: true });

    // Reports that matched a saved host-changed attempt were consumed above;
    // only a truly stale report is ignored.
    for (const report of nativeFailures) {
      if (!matchedReportAttempts.has(report.attempt)) {
        input.onIgnoredReport?.(report.attempt);
      }
    }

    return outcomes;
  }

  // CLI wave: descriptors saved, cliWaveDone absent. Runs unsaved CLI and reported failures, reads no other reply.
  if (!stateOf().cliWaveDone) {
    const outcomes = new Map<string, SlotOutcome>();
    const waveTasks: Promise<unknown>[] = [];

    const queueFallback = (
      slot: RosterSlot,
      saved: Extract<SlotOutcome, { state: "native" }>,
      reason: string,
      extra?: BlockedAttempt[]
    ) => {
      waveTasks.push(
        (async () => {
          outcomes.set(
            slot.slot,
            await fallbackToCli(slot, saved, reason, extra)
          );
        })()
      );
    };

    const matchedReportAttempts = new Set<string>();
    const deferredFallbacks = new Set<string>();

    // New descriptors come first and return before any CLI work starts, so a
    // new host's voices launch while old fallbacks still run. cliWaveDone
    // stays absent, so the next call resumes the deferred fallbacks and CLI
    // targets with recoverable wave state.
    for (const canLaunch of [isFirst, isOnly]) {
      for (const slot of targets) {
        if (
          !canLaunch(slot) ||
          outcomes.has(slot.slot) ||
          readSaved(slot.slot)
        ) {
          continue;
        }

        const created = isOnly(slot)
          ? createNativeOnly(slot)
          : createNativeFirst(slot, slot);

        outcomes.set(slot.slot, publishNative(slot, created));
      }
    }

    if (outcomes.size) {
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
        if (outcomes.has(slot.slot)) {
          continue;
        }

        const saved = readSaved(slot.slot);

        // A fallback already in flight stays with the deferred next call, which
        // resumes it with its recorded reason.
        if (
          !saved ||
          saved.state !== "native" ||
          // SAFETY: the state guards narrow saved to a native outcome; the assertion only reads its optional cliFallback flag.
          (saved as { cliFallback?: true }).cliFallback
        ) {
          continue;
        }

        const report = nativeFailures.find(
          (entry) => entry.attempt === saved.attempt
        );

        if (!report) {
          continue;
        }

        matchedReportAttempts.add(report.attempt);
        const route = routeForNative(saved);
        const routeTrue = !slot.native && route.routeOk && route.first;
        const nativeOnlyAttempt = !slot.native && !routeTrue && route.routeOk;

        if (slot.native || nativeOnlyAttempt) {
          invalidateReply(saved.replyPath);
          // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
          outcomes.set(slot.slot, await saveReportFailure(slot, saved, report));
          continue;
        }

        // The marker persists before the reply is quarantined: an
        // interruption between the two still resumes with the reported
        // reason and evidence instead of a generic host change.
        persistDeferredMarker(
          fileOfLogical(slot.slot),
          saved,
          report.reason,
          reportEvidence(saved, report)
        );
        invalidateReply(saved.replyPath);
        deferredFallbacks.add(slot.slot);
      }

      // Reports that matched a saved attempt were consumed above; only a report
      // no saved attempt still holds is ignored. A deferred fallback slot is
      // absent from this return by design: the next call resumes its CLI
      // cascade, so neither caller can list it as pending or failed meanwhile.
      notifyUnmatchedReports(matchedReportAttempts);

      for (const slot of targets) {
        if (outcomes.has(slot.slot)) {
          continue;
        }

        const saved = readSaved(slot.slot);

        // Every saved fallback marker resumes in the CLI wave, including one
        // saved before this call: it never returns as a pending voice.
        if (
          !saved ||
          deferredFallbacks.has(slot.slot) ||
          (saved.state === "native" &&
            // SAFETY: the state guard narrows saved to a native outcome; the assertion only reads its optional cliFallback flag.
            (saved as { cliFallback?: true }).cliFallback)
        ) {
          continue;
        }

        if (saved.state === "native" && !routeForNative(saved).routeOk) {
          continue;
        }

        outcomes.set(slot.slot, saved);
      }

      return settled(targets.map((slot) => outcomes.get(slot.slot)));
    }

    for (const slot of targets) {
      if (isOnly(slot) || isFirst(slot)) {
        const saved = readSaved(slot.slot);

        if (isOnly(slot) && saved?.state === "native") {
          // Saved native-only attempts match reports here too: a host change
          // must not replay the old attempt as pending when its BLOCKED
          // report arrived with the resume.
          const report = nativeFailures.find(
            // SAFETY: the state guard narrows saved to a native outcome; the assertion only reads its persisted attempt field.
            (entry) => entry.attempt === (saved as { attempt: string }).attempt
          );

          if (report) {
            matchedReportAttempts.add(report.attempt);
            // SAFETY: the state guard narrows saved to a native outcome; the assertion only reads its persisted replyPath field.
            invalidateReply((saved as { replyPath: string }).replyPath);
            outcomes.set(
              slot.slot,
              // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
              await saveReportFailure(slot, saved, report)
            );
            continue;
          }
        }

        // SAFETY: the state guards narrow saved to a native outcome; the assertion only reads its optional cliFallback flag.
        if (
          !saved ||
          (saved.state === "native" &&
            (saved as { cliFallback?: true }).cliFallback)
        ) {
          continue;
        }

        // Same physical-route gate as the consume path: a host change can
        // make the logical slot native-first under a stale attempt.
        if (
          isFirst(slot) &&
          saved.state === "native" &&
          !routeForNative(saved).routeOk
        ) {
          // A matching report wins: the report loop below runs the same
          // fallback with the reported reason and evidence.
          if (nativeFailures.some((entry) => entry.attempt === saved.attempt)) {
            continue;
          }

          queueFallback(slot, saved, "host changed");
          continue;
        }

        outcomes.set(slot.slot, saved);
      }
    }

    // Snapshot before any concurrent fallback tasks launch: each pushed task
    // runs its sync prefix (marker persist and failed save) immediately, so a
    // later live read would see a marker that already settled to failed in this
    // same batch and trigger a plain retry for the same slot.
    const waveInitial = new Map(
      targets.map((slot) => [slot.slot, readSaved(slot.slot)])
    );

    // Process reports for natives in this wave (fallback now, no reply read).
    for (const slot of targets) {
      if (isOnly(slot)) {
        continue;
      }

      const saved = readSaved(slot.slot);

      if (
        !saved ||
        saved.state !== "native" ||
        // SAFETY: the state guards narrow saved to a native outcome; the assertion only reads its optional cliFallback flag.
        !(saved as { cliFallback?: true }).cliFallback
      ) {
        continue;
      }

      queueFallback(
        slot,
        saved,
        // SAFETY: the state guards narrow saved to a native outcome; the assertion only reads its optional nativeError field.
        (saved as { nativeError?: string }).nativeError ?? "failed"
      );
    }

    // Route false takes the fallback even with a reply present, before any report handling.
    for (const slot of targets) {
      if (isOnly(slot) || isFirst(slot)) {
        continue;
      }

      const saved = readSaved(slot.slot);

      if (
        !saved ||
        saved.state !== "native" ||
        // SAFETY: the state guards narrow saved to a native outcome; the assertion only reads its optional cliFallback flag.
        (saved as { cliFallback?: true }).cliFallback
      ) {
        continue;
      }

      if (routeForNative(saved).routeOk) {
        continue;
      }

      // A matching report wins: the report loop below runs the same fallback
      // with the reported reason and evidence.
      if (nativeFailures.some((entry) => entry.attempt === saved.attempt)) {
        continue;
      }

      queueFallback(slot, saved, "host changed");
    }

    // Reports match any saved physical native attempt, not only first slots:
    // a reserve substitute saved under a non-first target falls back with its
    // physical reserve provider under the logical slot and no second reserve,
    // and a reported attempt is never returned as pending.
    for (const slot of targets) {
      if (isOnly(slot)) {
        continue;
      }

      const saved = readSaved(slot.slot);

      if (
        !saved ||
        saved.state !== "native" ||
        // SAFETY: the state guards narrow saved to a native outcome; the assertion only reads its optional cliFallback flag.
        (saved as { cliFallback?: true }).cliFallback
      ) {
        continue;
      }

      const report = nativeFailures.find(
        (entry) => entry.attempt === saved.attempt
      );

      if (!report) {
        continue;
      }

      matchedReportAttempts.add(report.attempt);
      queueFallback(slot, saved, report.reason, reportEvidence(saved, report));
    }

    // Run unsaved CLI targets alongside fallback cascades in one concurrent batch.
    // A slot with a saved native (including a fallback marker) is resumed by
    // its own fallback task above; it never runs a second CLI here. The check
    // runs before any task launches so a marker that settles to failed in this
    // same batch does not trigger a plain retry for the same slot.
    const cliTargets = targets.filter(
      (slot) => !isOnly(slot) && !isFirst(slot)
    );

    for (const slot of cliTargets) {
      const initial = waveInitial.get(slot.slot);

      if (initial?.state === "native") {
        continue;
      }

      waveTasks.push(
        (async () => {
          const saved = readSaved(slot.slot);

          if (
            saved?.state === "done" &&
            input.validate(saved.text, slot.slot).ok
          ) {
            emit(slot, { kind: "slot", state: "done", replay: true });
            outcomes.set(slot.slot, saved);

            return saved;
          }

          if (saved && saved.state !== "failed") {
            outcomes.set(slot.slot, saved);

            return saved;
          }

          // If saved failed from previous interrupted wave, rerun below.
          const promptPath = basePathOf(slot.slot);

          if (!fs.existsSync(promptPath)) {
            fs.writeFileSync(promptPath, baseTextOf(slot), { mode: 0o600 });
          }

          let outcome = await voiceCLI(slot, slot.slot, promptPath);

          if (outcome.state === "failed") {
            const canReserve = reserveLaunchable(slot.slot, outcome.cls);
            emit(slot, {
              kind: "routing",
              state: canReserve ? "reserve" : "stop",
              cls: outcome.cls,
            });

            if (canReserve) {
              const launched = await takeReserve(slot, outcome, promptPath);

              if (launched) {
                if (launched.state === "native") {
                  outcomes.set(slot.slot, launched);

                  return launched;
                }

                outcome = launched;
              }
            }
          }

          const savedBlockedFor = readSaved(slot.slot)?.blocked;
          const blocked = mergeBlocked(savedBlockedFor, outcome.blocked);

          if (blocked.length) {
            outcome = { ...outcome, blocked };
          }

          await saveLogical(slot, outcome);
          outcomes.set(slot.slot, outcome);

          return outcome;
        })()
      );
    }

    throwRejected(await Promise.allSettled(waveTasks));
    // Reads no other reply file. Sets cliWaveDone after all settle.
    finishCliWave();
    // Reports that matched nothing are ignored; others were consumed above.
    notifyUnmatchedReports(matchedReportAttempts);

    return settled(
      targets.map((slot) => outcomes.get(slot.slot) ?? readSaved(slot.slot))
    );
  }

  // Consume: cliWaveDone present. Consumes replies, moves failed natives to CLI.
  {
    const startAttempts = new Set<string>();

    for (const slot of targets) {
      const saved = readSaved(slot.slot);

      if (
        saved?.state === "native" &&
        // SAFETY: the state guard narrows saved to a native outcome; the assertion only reads its optional cliFallback flag.
        !(saved as { cliFallback?: true }).cliFallback
      ) {
        // SAFETY: the state guard above narrows saved to a native outcome; the assertion only reads its persisted attempt field.
        startAttempts.add((saved as { attempt: string }).attempt);
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
    const runFallback = (
      slot: RosterSlot,
      nativeSaved: Extract<SlotOutcome, { state: "native" }>,
      nativeError: string,
      extraBlocked?: BlockedAttempt[]
    ) => {
      consumeTasks.push(
        (async () => {
          const outcome = await fallbackToCli(
            slot,
            nativeSaved,
            nativeError,
            extraBlocked
          );

          outcomes.set(slot.slot, outcome);

          if (
            outcome.state === "native" &&
            // SAFETY: the state guard narrows outcome to a native outcome; the assertion only reads its optional cliFallback flag.
            !(outcome as { cliFallback?: true }).cliFallback
          ) {
            pendingRemains = true;
          }
        })()
      );
    };

    const runPlainCli = (slot: RosterSlot, promptPath: string) => {
      consumeTasks.push(
        (async () => {
          let outcome = await voiceCLI(slot, slot.slot, promptPath);

          if (
            outcome.state === "failed" &&
            reserveAllowed(slot.slot, outcome.cls)
          ) {
            const launched = await takeReserve(slot, outcome, promptPath);

            if (launched) {
              outcomes.set(slot.slot, launched);

              if (launched.state === "native") {
                pendingRemains = true;
              }

              if (launched.state === "native") {
                return;
              }

              outcome = launched;
            }
          }

          await saveLogical(slot, outcome);
          outcomes.set(slot.slot, outcome);
        })()
      );
    };

    for (const slot of targets) {
      const saved = readSaved(slot.slot);

      if (isOnly(slot)) {
        if (!saved || saved.state !== "native") {
          if (saved) {
            outcomes.set(slot.slot, saved);
          }

          continue;
        }

        const nativeSaved = saved;

        const report = nativeFailures.find(
          (entry) => entry.attempt === nativeSaved.attempt
        );

        if (report) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
          const reported = await saveReportFailure(slot, nativeSaved, report);
          outcomes.set(slot.slot, reported);

          if (
            reported.state === "native" &&
            // SAFETY: the state guard narrows reported to a native outcome; the assertion only reads its optional cliFallback flag.
            !(reported as { cliFallback?: true }).cliFallback
          ) {
            pendingRemains = true;
          }

          continue;
        }

        if (fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, "utf-8");
          const { isBlocked, raw } = parseBlockedReply(text);

          if (isBlocked && isCurrentHost(nativeSaved.provider)) {
            const { failed, reserve } = prepareHostBlocked(
              slot,
              nativeSaved,
              raw,
              attemptOf(slot, nativeSaved)
            );

            if (reserve) {
              // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
              const launched = await reserve;

              if (launched) {
                if (launched.state === "native") {
                  outcomes.set(slot.slot, launched);
                  pendingRemains = true;
                } else {
                  // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
                  const savedLaunched = await saveLogical(slot, launched);
                  outcomes.set(slot.slot, savedLaunched);
                }

                continue;
              }
            }

            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            outcomes.set(slot.slot, await saveLogical(slot, failed));
            continue;
          }

          const checked = input.validate(text, slot.slot);
          emit(attemptOf(slot, nativeSaved), {
            kind: "validation",
            surface: "native",
            outcome: checked.ok ? "ok" : checked.cls,
          });

          if (checked.ok) {
            emit(attemptOf(slot, nativeSaved), {
              kind: "native",
              state: "completed",
              replay: true,
            });
            outcomes.set(
              slot.slot,
              saveDoneFromNative(slot, nativeSaved, checked.text ?? text)
            );
            continue;
          }

          emit(attemptOf(slot, nativeSaved), {
            kind: "native",
            state: "invalid",
            replay: true,
          });
          outcomes.set(slot.slot, markInvalid(slot, nativeSaved, checked));
          pendingRemains = true;
          continue;
        }

        outcomes.set(slot.slot, nativeSaved);
        pendingRemains = true;
        continue;
      }

      if (isFirst(slot) || saved?.state === "native") {
        // Native-first consume, including route-false fallback.
        const nativeSaved = saved?.state === "native" ? saved : undefined;

        if (!nativeSaved) {
          // No saved native: could be done/failed already, or unsaved (new). If done/failed, handle below as CLI.
          if (saved) {
            if (saved.state === "failed") {
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

        // SAFETY: nativeSaved is a native outcome parameter; the assertion only reads its optional cliFallback flag.
        if ((nativeSaved as { cliFallback?: true }).cliFallback) {
          // Rerun steps 2-3, never read reply. A substitute never takes a
          // second reserve here either.
          runFallback(
            slot,
            nativeSaved,
            // SAFETY: nativeSaved is a native outcome parameter; the assertion only reads its optional nativeError field.
            (nativeSaved as { nativeError?: string }).nativeError ?? "failed"
          );
          continue;
        }

        const report = nativeFailures.find(
          (entry) => entry.attempt === nativeSaved.attempt
        );

        if (report) {
          runFallback(
            slot,
            nativeSaved,
            report.reason,
            reportEvidence(nativeSaved, report)
          );
          continue;
        }

        // Route false takes fallback even with reply present. Resolve the
        // physical provider with the same gate as the CLI-only and wave
        // paths: a host-platform reserve saved under any logical slot stays
        // route-ok while native-first or native-only from the current host,
        // so its reply consumes.
        const route = routeForNative(nativeSaved);

        if (!route.routeOk) {
          runFallback(slot, nativeSaved, "host changed");
          continue;
        }

        // Classify by the physical provider: a wave-minted native-only
        // reserve answers the native-only way, so a BLOCKED or invalid reply
        // file stays pending-native and never falls back to a refusal.
        const nativeOnlyPhysical =
          !route.first && (route.physical?.native ?? false);

        if (nativeOnlyPhysical && fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, "utf-8");
          const { isBlocked, raw } = parseBlockedReply(text);

          if (isBlocked) {
            if (isCurrentHost(nativeSaved.provider)) {
              const { failed, reserve } = prepareHostBlocked(
                slot,
                nativeSaved,
                raw,
                attemptOf(slot, nativeSaved)
              );

              if (reserve) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
                const launched = await reserve;

                if (launched) {
                  if (launched.state === "native") {
                    outcomes.set(slot.slot, launched);
                    pendingRemains = true;
                  } else {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
                    outcomes.set(slot.slot, await saveLogical(slot, launched));
                  }

                  continue;
                }
              }

              // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
              outcomes.set(slot.slot, await saveLogical(slot, failed));
              continue;
            }

            const entry = blockedEntry(
              nativeSaved.provider,
              firstModelOf({
                // SAFETY: nativeSaved is a native outcome parameter; the assertion only reads its optional model field.
                model: (nativeSaved as { model?: string | readonly string[] })
                  .model,
              }),
              raw
            );

            emit(attemptOf(slot, nativeSaved), {
              kind: "validation",
              surface: "native",
              outcome: "blocked",
            });
            emit(attemptOf(slot, nativeSaved), {
              kind: "native",
              state: "invalid",
              replay: true,
            });
            invalidateReply(nativeSaved.replyPath);
            const blocked = mergeBlocked(nativeSaved.blocked, [entry]);

            const pending = {
              ...nativeSaved,
              error: `blocked: ${entry.reason}`,
              ...(blocked.length && { blocked }),
            };

            atomic(fileOfLogical(slot.slot), pending);
            outcomes.set(slot.slot, pending);
            pendingRemains = true;
            continue;
          }

          const checked = input.validate(text, slot.slot);
          emit(attemptOf(slot, nativeSaved), {
            kind: "validation",
            surface: "native",
            outcome: checked.ok ? "ok" : checked.cls,
          });

          if (checked.ok) {
            emit(attemptOf(slot, nativeSaved), {
              kind: "native",
              state: "completed",
              replay: true,
            });
            outcomes.set(
              slot.slot,
              saveDoneFromNative(slot, nativeSaved, checked.text ?? text)
            );
            continue;
          }

          emit(attemptOf(slot, nativeSaved), {
            kind: "native",
            state: "invalid",
            replay: true,
          });
          outcomes.set(slot.slot, markInvalid(slot, nativeSaved, checked));
          pendingRemains = true;
          continue;
        }

        // Route true, no report: consume reply if present.
        if (fs.existsSync(nativeSaved.replyPath)) {
          const text = fs.readFileSync(nativeSaved.replyPath, "utf-8");
          const { isBlocked, raw } = parseBlockedReply(text);

          if (isBlocked) {
            const entry = blockedEntry(
              nativeSaved.provider,
              firstModelOf({
                // SAFETY: nativeSaved is a native outcome parameter; the assertion only reads its optional model field.
                model: (nativeSaved as { model?: string | readonly string[] })
                  .model,
              }),
              raw
            );

            emit(attemptOf(slot, nativeSaved), {
              kind: "validation",
              surface: "native",
              outcome: "blocked",
            });
            emit(attemptOf(slot, nativeSaved), {
              kind: "native",
              state: "failed",
            });
            runFallback(slot, nativeSaved, `blocked: ${entry.reason}`, [entry]);
            continue;
          }

          const checked = input.validate(text, slot.slot);
          emit(attemptOf(slot, nativeSaved), {
            kind: "validation",
            surface: "native",
            outcome: checked.ok ? "ok" : checked.cls,
          });

          if (checked.ok) {
            emit(attemptOf(slot, nativeSaved), {
              kind: "native",
              state: "completed",
            });
            // The responder records the launched voice, not the current
            // roster: a config change between launch and consumption must not
            // attribute the answer to a model or effort that never launched.
            outcomes.set(
              slot.slot,
              saveDoneFromNative(slot, nativeSaved, checked.text ?? text)
            );
            continue;
          }

          // Invalid reply falls back.
          emit(attemptOf(slot, nativeSaved), {
            kind: "native",
            state: "failed",
          });

          const mergedInvalidBlocked = mergeBlocked(
            nativeSaved.blocked,
            checked.blocked
              ? [
                  {
                    provider: nativeSaved.provider,
                    model: firstModelOf({
                      // SAFETY: nativeSaved is a native outcome parameter; the assertion only reads its optional model field.
                      model: (
                        nativeSaved as {
                          model?: string | readonly string[];
                        }
                      ).model,
                    }),
                    ...checked.blocked,
                  },
                ]
              : undefined
          );

          runFallback(
            slot,
            nativeSaved,
            checked.reason,
            mergedInvalidBlocked.length ? mergedInvalidBlocked : undefined
          );
          continue;
        }

        outcomes.set(slot.slot, nativeSaved);
        pendingRemains = true;
        continue;
      }

      // CLI targets in consume.
      if (saved?.state === "done" && input.validate(saved.text, slot.slot).ok) {
        emit(slot, { kind: "slot", state: "done", replay: true });
        outcomes.set(slot.slot, saved);
        continue;
      }

      if (saved?.state === "failed") {
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

      if (!fs.existsSync(promptPath)) {
        fs.writeFileSync(promptPath, baseTextOf(slot), { mode: 0o600 });
      }

      runPlainCli(slot, promptPath);
    }

    throwRejected(await Promise.allSettled(consumeTasks));

    // A saved failed slot retries once in the call where the last native reply settles.
    if (!pendingRemains && preExistingFailed.length) {
      const retryTasks: Promise<void>[] = [];

      for (const slot of preExistingFailed) {
        retryTasks.push(
          (async () => {
            // Carry forward the saved blocked evidence: a retry that settles
            // the last pending voice must not drop it.
            const savedFailed = readSaved(slot.slot);
            const priorBlocked = savedFailed?.blocked;

            // The saved failure replays once per slot, before any retry or reserve routing.
            if (
              savedFailed?.state === "failed" &&
              claimReplayEmit(replayMarkerOf(slot.slot))
            ) {
              emit(slot, { kind: "slot", state: "failed", replay: true });
            }

            // A native-only reserve mint appends its reply section to this same
            // file: rewrite the base prompt unconditionally, as the CLI-only
            // path does, so the retry never reads a native reply section.
            const baseFile = basePathOf(slot.slot);
            fs.writeFileSync(baseFile, baseTextOf(slot), { mode: 0o600 });
            let retryOutcome: SlotOutcome;

            if (isCurrentHost(slot.provider)) {
              retryOutcome =
                savedFailed?.state === "failed"
                  ? savedFailed
                  : {
                      slot: slot.slot,
                      state: "failed",
                      cls: "refusal",
                      reason: "refusal: host voice unavailable",
                      ...(priorBlocked !== undefined &&
                        priorBlocked.length > 0 && { blocked: priorBlocked }),
                    };
            } else {
              retryOutcome = await voiceCLI(slot, slot.slot, baseFile);

              if (priorBlocked !== undefined && priorBlocked.length > 0) {
                retryOutcome = {
                  ...retryOutcome,
                  blocked: mergeBlocked(priorBlocked, retryOutcome.blocked),
                };
              }
            }

            if (
              retryOutcome.state === "failed" &&
              reserveAllowed(slot.slot, retryOutcome.cls)
            ) {
              const launched = await takeReserve(slot, retryOutcome, baseFile);

              if (launched) {
                retryOutcome = launched;
              }
            }

            await saveLogical(slot, retryOutcome);
            outcomes.set(slot.slot, retryOutcome);
          })()
        );
      }

      throwRejected(await Promise.allSettled(retryTasks));
    }

    // Stale or replayed reports never matched a pending native at call start.
    for (const report of nativeFailures) {
      if (!startAttempts.has(report.attempt)) {
        input.onIgnoredReport?.(report.attempt);
      }
    }

    return settled(
      targets.map((slot) => outcomes.get(slot.slot) ?? readSaved(slot.slot))
    );
  }
};
