import crypto from "node:crypto";
import fs from "node:fs";

import { failureDisposition } from "../../policy/cascade.ts";
import { normalizeProvider } from "../../policy/roster.ts";
import { nodeRunnerFs } from "../../providers/node-process.ts";
import { sessionScope, formatSafetyPrompt } from "../../providers/runner.ts";
import type { CliDeps } from "../cli.ts";
import {
  BLOCKED_MARKER,
  failureReasonDisplay,
  failureReasonEvidence,
  isBlockedReply,
  parseBlockedReply,
} from "../domain/blocker.ts";
import type { RosterSlot } from "../domain/types.ts";
import { atomic, mergeBlocked, nativeLaunchAs } from "./state.ts";
import type {
  BlockedAttempt,
  Emit,
  FailureClass,
  FanOutInput,
  NativeFailure,
  SlotOutcome,
  Validation,
  slotFiles,
} from "./state.ts";
import type { cliVoice } from "./voice.ts";

const newNativeReply = (cwd: string, replyPath: string) =>
  `\n\n## Native reply\n\nWork in \`${cwd}\` for reads and Git commands.\n\nWrite the reply that the instructions above require, in their exact format, to \`${replyPath}\`; do not return it inline. Then reply only \`wrote ${replyPath}\`, or \`${BLOCKED_MARKER} <reason>\` when you cannot write it.\n`;

export const firstModelOf = (slot: {
  model?: string | readonly string[] | undefined;
}) => {
  if (slot.model === undefined) {
    return null;
  }

  if (typeof slot.model === "string") {
    return slot.model;
  }

  return slot.model[0] ?? null;
};

export const isNativeFirstSlot = (
  slot: RosterSlot,
  providers: readonly string[] | undefined
) =>
  !slot.native &&
  !slot.reserve &&
  isNativeFirstProvider(slot.provider, providers);

export const isNativeFirstProvider = (
  provider: string,
  providers: readonly string[] | undefined
) => {
  if (providers === undefined || providers.length === 0) {
    return false;
  }

  const normalized = normalizeProvider(provider);

  return providers.some(
    (candidate) => normalizeProvider(candidate) === normalized
  );
};

const makeNonce = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6);

export const blockedEntry = (
  provider: string,
  model: string | null,
  raw: string
): BlockedAttempt => ({ provider, model, ...failureReasonEvidence(raw) });

const blockedDisplayOf = (reason: string, evidence?: BlockedAttempt[]) => {
  const firstReason = evidence?.[0]?.reason;

  if (firstReason !== undefined && firstReason !== "") {
    return firstReason;
  }

  const raw = isBlockedReply(reason)
    ? parseBlockedReply(reason).raw
    : reason.trim();

  return failureReasonDisplay(raw);
};

export const reportEvidence = (
  native: { provider: string; model?: string | readonly string[] },
  report: NativeFailure
): BlockedAttempt[] | undefined => {
  if (!isBlockedReply(report.reason)) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the unblocked and blocked branches.
    return undefined;
  }

  return [
    {
      provider: native.provider,
      model: firstModelOf(native),
      reason: blockedDisplayOf(report.reason),
      reasonHash: report.reasonHash,
    },
  ];
};

export const attemptOf = (
  logical: RosterSlot,
  voice: {
    provider: string;
    model?: string | readonly string[];
    effort?: string;
  }
) => ({
  slot: logical.slot,
  provider: voice.provider,
  model: voice.model,
  ...(voice.effort !== undefined && { effort: voice.effort }),
});

const invalidateReply = (replyPath: string) => {
  if (!fs.existsSync(replyPath)) {
    return;
  }

  let suffix = 1;

  while (fs.existsSync(`${replyPath}.invalid-${suffix}`)) {
    suffix += 1;
  }

  const target = `${replyPath}.invalid-${suffix}`;

  try {
    fs.renameSync(replyPath, target);
  } catch (error) {
    fs.copyFileSync(replyPath, target);

    try {
      fs.rmSync(replyPath);
    } catch {
      throw new Error(
        `Cannot quarantine rejected reply ${replyPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
};

export const nativeVoice = (
  input: Pick<FanOutInput, "sessionRoot" | "prompt">,
  ports: {
    all: readonly RosterSlot[];
    firstReserve: RosterSlot | undefined;
    nativeFirstProviders: readonly string[];
    host: () => CliDeps["orchestrator"];
    cwd: string;
    files: Omit<ReturnType<typeof slotFiles>, "name">;
    emit: Emit;
    markNativeLaunched: () => void;
    claimReserve: (logical: string) => void;
    ownerOfReserve: () => string | undefined;
    voiceCLI: ReturnType<typeof cliVoice>;
  }
) => {
  const {
    all,
    firstReserve,
    nativeFirstProviders,
    host: orchestrator,
    cwd,
    files,
    emit,
    markNativeLaunched,
    claimReserve,
    ownerOfReserve,
    voiceCLI,
  } = ports;

  const {
    fileOfLogical,
    basePathOf,
    nativePathOf,
    replyPathFor,
    oldReplyPathOf,
    readSaved,
    saveLogical,
  } = files;

  const baseTextOf = (slot: RosterSlot) =>
    typeof input.prompt === "string" ? input.prompt : input.prompt(slot);

  const buildNativePrompt = (baseText: string, replyPath: string) => {
    const scope = sessionScope(input.sessionRoot, nodeRunnerFs);

    const guarded = formatSafetyPrompt(baseText, {
      ...scope,
      ...(cwd && { workspaceRoot: cwd }),
    });

    return `${guarded}\n\n[REPLY FILE EXCEPTION]: You may write only to \`${replyPath}\`; all other project file writes stay denied.\n${newNativeReply(
      cwd,
      replyPath
    )}`;
  };

  const descriptor = (
    logical: RosterSlot,
    physical: RosterSlot,
    promptPath: string,
    replyPath: string,
    attempt: string
  ): Extract<SlotOutcome, { state: "native" }> => ({
    slot: logical.slot,
    state: "native",
    promptPath,
    replyPath,
    provider: physical.provider,
    attempt,
    cwd,
    ...(physical.model !== undefined && { model: physical.model }),
    ...(physical.effort !== undefined && { effort: physical.effort }),
    launchAs: nativeLaunchAs(
      physical.provider,
      physical.model,
      physical.effort
    ),
  });

  const appendNativeReply = (
    baseFile: string,
    baseText: string,
    replyPath: string
  ) => {
    try {
      const current = fs.readFileSync(baseFile, "utf-8");

      if (!current.includes("## Native reply")) {
        fs.appendFileSync(baseFile, newNativeReply(cwd, replyPath));
      }
    } catch {
      fs.writeFileSync(baseFile, baseText + newNativeReply(cwd, replyPath), {
        mode: 0o600,
      });
    }
  };

  const publishNative = (
    slot: RosterSlot,
    outcome: Extract<SlotOutcome, { state: "native" }>
  ): SlotOutcome => {
    atomic(fileOfLogical(slot.slot), outcome);
    emit(slot, { kind: "slot", state: "native" });

    return outcome;
  };

  const createNativeOnly = (
    slot: RosterSlot
  ): Extract<SlotOutcome, { state: "native" }> => {
    const baseText = baseTextOf(slot);
    const baseFile = basePathOf(slot.slot);

    try {
      fs.writeFileSync(baseFile, baseText, { mode: 0o600 });
    } catch {
      void 0;
    }

    const replyPath = oldReplyPathOf(slot.slot);
    const nonce = makeNonce();
    const attempt = `${slot.slot}#${nonce}`;
    emit(slot, { kind: "native", state: "pending" });
    appendNativeReply(baseFile, baseText, replyPath);
    const outcome = descriptor(slot, slot, baseFile, replyPath, attempt);
    markNativeLaunched();

    return outcome;
  };

  const createNativeFirst = (
    logical: RosterSlot,
    physical: RosterSlot
  ): Extract<SlotOutcome, { state: "native" }> => {
    const baseText = baseTextOf(logical);
    const baseFile = basePathOf(logical.slot);

    try {
      if (!fs.existsSync(baseFile)) {
        fs.writeFileSync(baseFile, baseText, { mode: 0o600 });
      }
    } catch {
      fs.writeFileSync(baseFile, baseText, { mode: 0o600 });
    }

    const nonce = makeNonce();
    const attempt = `${physical.slot}#${nonce}`;
    const replyPath = replyPathFor(logical.slot, nonce);
    const nativeFile = nativePathOf(logical.slot);
    fs.writeFileSync(nativeFile, buildNativePrompt(baseText, replyPath), {
      mode: 0o600,
    });
    emit(attemptOf(logical, physical), { kind: "native", state: "pending" });
    markNativeLaunched();

    return descriptor(logical, physical, nativeFile, replyPath, attempt);
  };

  const markInvalid = (
    slot: RosterSlot,
    native: Extract<SlotOutcome, { state: "native" }>,
    checked: Extract<Validation, { ok: false }>
  ): SlotOutcome => {
    invalidateReply(native.replyPath);

    const blocked = checked.blocked
      ? mergeBlocked(native.blocked, [
          {
            provider: native.provider,
            model: firstModelOf(native),
            ...checked.blocked,
          },
        ])
      : native.blocked;

    const pending: SlotOutcome = {
      ...native,
      error: checked.reason,
      ...(blocked !== undefined && blocked.length > 0 && { blocked }),
    };

    atomic(fileOfLogical(slot.slot), pending);

    return pending;
  };

  const fallbackToCli = async (
    logical: RosterSlot,
    nativeSaved: Extract<SlotOutcome, { state: "native" }>,
    nativeError: string,
    extraBlocked?: BlockedAttempt[]
  ): Promise<SlotOutcome> => {
    const merged = mergeBlocked(nativeSaved.blocked, extraBlocked);

    const blockedFailure =
      isBlockedReply(nativeError) ||
      (nativeError.startsWith("blocked: ") && merged.length > 0);

    const display = blockedDisplayOf(nativeError, extraBlocked);

    const withFallback = {
      ...nativeSaved,
      cliFallback: true as const,
      nativeError,
      ...(merged.length && { blocked: merged }),
    };

    atomic(fileOfLogical(logical.slot), withFallback);
    emit(attemptOf(logical, nativeSaved), { kind: "native", state: "failed" });
    invalidateReply(nativeSaved.replyPath);
    const { physical } = routeForNative(nativeSaved);

    const failedForHost = (): Extract<SlotOutcome, { state: "failed" }> => ({
      slot: logical.slot,
      state: "failed",
      cls: blockedFailure ? "blocked" : "refusal",
      reason: (blockedFailure ? "blocked: " : "refusal: ") + display,
      ...(merged.length && { blocked: merged }),
    });

    if (physical !== undefined && isCurrentHost(physical.provider)) {
      const failed = failedForHost();
      const isReserveSubstitute = physical.slot !== logical.slot;

      if (!isReserveSubstitute && reserveAllowed(logical.slot, failed.cls)) {
        const launched = await takeReserveWithFreshPrompt(logical, failed);

        if (launched) {
          return launched.state === "native"
            ? launched
            : await saveLogical(logical, launched);
        }
      }

      return await saveLogical(logical, failed);
    }

    if (physical === undefined || physical.native) {
      return await saveLogical(logical, failedForHost());
    }

    const baseFile = basePathOf(logical.slot);

    if (!fs.existsSync(baseFile)) {
      fs.writeFileSync(baseFile, baseTextOf(logical), { mode: 0o600 });
    }

    let cliOutcome = await voiceCLI(physical, logical.slot, baseFile);

    if (merged.length) {
      cliOutcome = {
        ...cliOutcome,
        blocked: mergeBlocked(merged, cliOutcome.blocked),
      };
    }

    if (cliOutcome.state === "failed") {
      const isReserveSubstitute = physical.slot !== logical.slot;

      if (
        !isReserveSubstitute &&
        reserveAllowed(logical.slot, cliOutcome.cls)
      ) {
        const launched = await takeReserve(logical, cliOutcome, baseFile);

        if (launched) {
          return launched.state === "native"
            ? launched
            : await saveLogical(logical, launched);
        }
      }
    }

    return await saveLogical(logical, { ...cliOutcome, slot: logical.slot });
  };

  const isCurrentHost = (provider: string) => {
    const host = orchestrator()?.platform;

    if (!host) {
      return false;
    }

    return normalizeProvider(provider) === normalizeProvider(host);
  };

  const reserveConsumedBy = (ownerSaved: SlotOutcome | undefined) => {
    if (ownerSaved === undefined || firstReserve === undefined) {
      return false;
    }

    if (ownerSaved.state === "done") {
      const { responder } = ownerSaved;

      if (responder?.slot === firstReserve.slot) {
        return true;
      }

      if (
        responder?.native === true &&
        responder?.provider === firstReserve.provider
      ) {
        return true;
      }

      return false;
    }

    if (ownerSaved.state === "native") {
      if (ownerSaved.attempt.split("#")[0] === firstReserve.slot) {
        return true;
      }

      if (ownerSaved.cliFallback === true) {
        return true;
      }
    }

    return false;
  };

  const reserveAvailableFor = (logical: string) => {
    const reserveOwner = ownerOfReserve();

    if (!firstReserve) {
      return false;
    }

    if (reserveOwner !== undefined && reserveOwner !== logical) {
      let released: boolean;

      try {
        const ownerSaved = readSaved(reserveOwner);
        released =
          (ownerSaved?.state === "done" && !reserveConsumedBy(ownerSaved)) ||
          (ownerSaved?.state === "failed" &&
            // SAFETY: the state guard narrows the saved outcome to a failed outcome; the assertion only reads its optional cliOnly flag.
            (ownerSaved as { cliOnly?: true }).cliOnly === true &&
            !fs.existsSync(nativePathOf(reserveOwner)));
      } catch {
        released = false;
      }

      if (!released) {
        return false;
      }
    }

    if (reserveOwner === logical) {
      const saved = readSaved(logical);

      if (saved === undefined) {
        return true;
      }

      if (
        saved.state === "native" &&
        // SAFETY: the state guard narrows saved to a native outcome; the assertion only reads its optional cliFallback flag.
        (saved as { cliFallback?: true }).cliFallback
      ) {
        return true;
      }

      if (
        saved.state === "failed" &&
        // SAFETY: the state guard narrows saved to a failed outcome; the assertion only reads its optional cliOnly flag.
        (saved as { cliOnly?: true }).cliOnly === true
      ) {
        return true;
      }

      return false;
    }

    return true;
  };

  const reserveAllowed = (logical: string, cls: FailureClass) => {
    if (failureDisposition(cls) === "terminal-run") {
      return false;
    }

    return reserveAvailableFor(logical);
  };

  const reserveLaunchable = (logical: string, cls: FailureClass) => {
    if (!reserveAllowed(logical, cls) || firstReserve === undefined) {
      return false;
    }

    return !(firstReserve.native && !isCurrentHost(firstReserve.provider));
  };

  const createNativeOnlyReserve = (
    logical: RosterSlot,
    reserve: RosterSlot,
    failed: SlotOutcome
  ): SlotOutcome => {
    const nonce = makeNonce();
    const baseText = baseTextOf(logical);
    const baseFile = basePathOf(logical.slot);

    try {
      if (!fs.existsSync(baseFile)) {
        fs.writeFileSync(baseFile, baseText, { mode: 0o600 });
      }
    } catch {
      fs.writeFileSync(baseFile, baseText, { mode: 0o600 });
    }

    const replyPath = oldReplyPathOf(logical.slot);
    emit(attemptOf(logical, reserve), { kind: "native", state: "pending" });
    appendNativeReply(baseFile, baseText, replyPath);

    const created = descriptor(
      logical,
      reserve,
      baseFile,
      replyPath,
      `${reserve.slot}#${nonce}`
    );

    const withBlocked =
      (failed.blocked?.length ?? 0) > 0
        ? { ...created, blocked: mergeBlocked(created.blocked, failed.blocked) }
        : created;

    markNativeLaunched();

    return publishNative(logical, withBlocked);
  };

  const routeForNative = (saved: { attempt: string; provider: string }) => {
    const physicalSlot = saved.attempt.split("#")[0] ?? "";
    const physical = all.find((entry) => entry.slot === physicalSlot);

    const first = isNativeFirstProvider(
      physical?.provider ?? saved.provider,
      nativeFirstProviders
    );

    const routeOk =
      physical !== undefined &&
      (first ||
        ((physical.native ?? false) && isCurrentHost(physical.provider)));

    return { physical, routeOk, first };
  };

  const takeReserve = async (
    logical: RosterSlot,
    failed: SlotOutcome,
    promptPath: string
  ): Promise<SlotOutcome | undefined> => {
    if (!firstReserve) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the unreserved and reserved branches.
      return undefined;
    }

    const first = isNativeFirstProvider(
      firstReserve.provider,
      nativeFirstProviders
    );

    if (firstReserve.native) {
      if (!isCurrentHost(firstReserve.provider)) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the foreign-host and reserved branches.
        return undefined;
      }

      claimReserve(logical.slot);

      return createNativeOnlyReserve(logical, firstReserve, failed);
    }

    if (first || isCurrentHost(firstReserve.provider)) {
      const native = createNativeFirst(logical, firstReserve);

      const withBlocked =
        (failed.blocked?.length ?? 0) > 0
          ? { ...native, blocked: mergeBlocked(native.blocked, failed.blocked) }
          : native;

      claimReserve(logical.slot);

      return publishNative(logical, withBlocked);
    }

    claimReserve(logical.slot);
    const substitute = await voiceCLI(firstReserve, logical.slot, promptPath);
    emit(firstReserve, {
      kind: "slot",
      state: substitute.state,
      targetSlot: logical.slot,
      ...(substitute.state === "failed" && { cls: substitute.cls }),
    });
    const blocked = mergeBlocked(failed.blocked, substitute.blocked);

    return {
      ...substitute,
      slot: logical.slot,
      ...(blocked.length && { blocked }),
    };
  };

  const takeReserveWithFreshPrompt = async (
    slot: RosterSlot,
    failed: SlotOutcome
  ): Promise<SlotOutcome | undefined> => {
    const baseFile = basePathOf(slot.slot);
    fs.writeFileSync(baseFile, baseTextOf(slot), { mode: 0o600 });

    return await takeReserve(slot, failed, baseFile);
  };

  const saveReportFailure = async (
    slot: RosterSlot,
    native: Extract<SlotOutcome, { state: "native" }>,
    report: NativeFailure
  ): Promise<SlotOutcome> => {
    const sanitized = blockedDisplayOf(report.reason);
    invalidateReply(native.replyPath);
    emit(attemptOf(slot, native), { kind: "native", state: "failed" });

    const canSubstitute =
      isCurrentHost(native.provider) &&
      native.attempt.split("#")[0] === slot.slot;

    const cls = isBlockedReply(report.reason) ? "blocked" : "refusal";

    const blocked =
      cls === "blocked"
        ? mergeBlocked(native.blocked, reportEvidence(native, report))
        : native.blocked;

    const failed: Extract<SlotOutcome, { state: "failed" }> = {
      slot: slot.slot,
      state: "failed",
      cls,
      reason: `${cls}: ${sanitized}`,
      ...(blocked !== undefined && blocked.length > 0 && { blocked }),
    };

    if (canSubstitute && reserveAllowed(slot.slot, failed.cls)) {
      const launched = await takeReserveWithFreshPrompt(slot, failed);

      if (launched) {
        return launched.state === "native"
          ? launched
          : await saveLogical(slot, launched);
      }
    }

    return await saveLogical(slot, failed);
  };

  const saveDoneFromNative = (
    slot: RosterSlot,
    native: Extract<SlotOutcome, { state: "native" }>,
    text: string
  ): SlotOutcome => {
    const done: SlotOutcome = {
      slot: slot.slot,
      state: "done",
      text,
      responder: {
        slot: slot.slot,
        provider: native.provider,
        model: firstModelOf(native),
        native: true,
        ...(native.effort !== undefined && { effort: native.effort }),
      },
      ...(native.blocked !== undefined &&
        native.blocked.length > 0 && { blocked: native.blocked }),
    };

    atomic(fileOfLogical(slot.slot), done);

    return done;
  };

  const prepareHostBlocked = (
    slot: RosterSlot,
    native: Extract<SlotOutcome, { state: "native" }>,
    raw: string,
    voice: Parameters<Emit>[0]
  ) => {
    const entry = blockedEntry(native.provider, firstModelOf(native), raw);
    emit(voice, { kind: "validation", surface: "native", outcome: "blocked" });
    emit(voice, { kind: "native", state: "failed", replay: true });
    invalidateReply(native.replyPath);
    const blocked = mergeBlocked(native.blocked, [entry]);

    const failed: Extract<SlotOutcome, { state: "failed" }> = {
      slot: slot.slot,
      state: "failed",
      cls: "blocked",
      reason: `blocked: ${entry.reason}`,
      blocked,
    };

    if (
      native.attempt.split("#")[0] !== slot.slot ||
      !reserveAllowed(slot.slot, failed.cls)
    ) {
      return { failed };
    }

    return { failed, reserve: takeReserveWithFreshPrompt(slot, failed) };
  };

  return {
    baseTextOf,
    publishNative,
    createNativeOnly,
    createNativeFirst,
    invalidateReply,
    markInvalid,
    fallbackToCli,
    isCurrentHost,
    reserveAllowed,
    reserveLaunchable,
    routeForNative,
    takeReserve,
    saveReportFailure,
    saveDoneFromNative,
    prepareHostBlocked,
  };
};
