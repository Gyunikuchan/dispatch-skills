import fs from "node:fs";

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

const settled = (outcomes: readonly (SlotOutcome | undefined)[]) =>
  outcomes.flatMap((outcome) => (outcome ? [outcome] : []));

// oxlint-disable-next-line eslint/complexity -- wave fold branches per failure report, attempt match, and pending state.
export const runNativeWave = async (
  input: Pick<FanOutInput, "validate" | "onIgnoredReport">,
  ports: {
    targets: readonly RosterSlot[];
    nativeFirstProviders: readonly string[];
    nativeFailures: readonly NativeFailure[];
    files: Pick<
      ReturnType<typeof slotFiles>,
      "basePathOf" | "fileOfLogical" | "readSaved" | "saveLogical"
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
    files: { basePathOf, fileOfLogical, readSaved, saveLogical },
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

  if (!stateOf().nativeFirst) {
    const outcomes: SlotOutcome[] = [];
    const matchedReportAttempts = new Set<string>();

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
          } else {
            emit(slot, { kind: "slot", state: existing.state, replay: true });
            outcomes.push(existing);
            continue;
          }
        }

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

        if (existing?.state === "native") {
          continue;
        }

        outcomes.push(publishNative(slot, createNativeFirst(slot, slot)));
        continue;
      }
    }

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

      continue;
    }

    patchState({ nativeFirst: true });

    for (const report of nativeFailures) {
      if (!matchedReportAttempts.has(report.attempt)) {
        input.onIgnoredReport?.(report.attempt);
      }
    }

    return outcomes;
  }

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
      for (const slot of targets) {
        if (outcomes.has(slot.slot)) {
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
        const route = routeForNative(saved);
        const routeTrue = !slot.native && route.routeOk && route.first;
        const nativeOnlyAttempt = !slot.native && !routeTrue && route.routeOk;

        if (slot.native || nativeOnlyAttempt) {
          invalidateReply(saved.replyPath);
          // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
          outcomes.set(slot.slot, await saveReportFailure(slot, saved, report));
          continue;
        }

        persistDeferredMarker(
          fileOfLogical(slot.slot),
          saved,
          report.reason,
          reportEvidence(saved, report)
        );
        invalidateReply(saved.replyPath);
        deferredFallbacks.add(slot.slot);
      }

      notifyUnmatchedReports(matchedReportAttempts);

      for (const slot of targets) {
        if (outcomes.has(slot.slot)) {
          continue;
        }

        const saved = readSaved(slot.slot);

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

        if (
          isFirst(slot) &&
          saved.state === "native" &&
          !routeForNative(saved).routeOk
        ) {
          if (nativeFailures.some((entry) => entry.attempt === saved.attempt)) {
            continue;
          }

          queueFallback(slot, saved, "host changed");
          continue;
        }

        outcomes.set(slot.slot, saved);
      }
    }

    const waveInitial = new Map(
      targets.map((slot) => [slot.slot, readSaved(slot.slot)])
    );

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

      if (nativeFailures.some((entry) => entry.attempt === saved.attempt)) {
        continue;
      }

      queueFallback(slot, saved, "host changed");
    }

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
    finishCliWave();
    notifyUnmatchedReports(matchedReportAttempts);

    return settled(
      targets.map((slot) => outcomes.get(slot.slot) ?? readSaved(slot.slot))
    );
  }

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
        const nativeSaved = saved?.state === "native" ? saved : undefined;

        if (!nativeSaved) {
          if (saved) {
            if (saved.state === "failed") {
              outcomes.set(slot.slot, saved);
              preExistingFailed.push(slot);
              continue;
            }

            outcomes.set(slot.slot, saved);
            continue;
          }

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

        const route = routeForNative(nativeSaved);

        if (!route.routeOk) {
          runFallback(slot, nativeSaved, "host changed");
          continue;
        }

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
            outcomes.set(
              slot.slot,
              saveDoneFromNative(slot, nativeSaved, checked.text ?? text)
            );
            continue;
          }

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

      const promptPath = basePathOf(slot.slot);

      if (!fs.existsSync(promptPath)) {
        fs.writeFileSync(promptPath, baseTextOf(slot), { mode: 0o600 });
      }

      runPlainCli(slot, promptPath);
    }

    throwRejected(await Promise.allSettled(consumeTasks));

    if (!pendingRemains && preExistingFailed.length) {
      const retryTasks: Promise<void>[] = [];

      for (const slot of preExistingFailed) {
        retryTasks.push(
          (async () => {
            const savedFailed = readSaved(slot.slot);
            const priorBlocked = savedFailed?.blocked;
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
