import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HandlerContext } from "./cli.ts";
import { askPrompt } from "./domain/prompt.ts";
import { sanitizeText } from "./domain/sanitize.ts";
import {
  assertHostNotSandboxed,
  fanOutComplete,
  nativeSummaryItems,
  parsePinsFlag,
  resolveSlots,
  underfillNote,
  cliWaveState,
  nativePendingNote,
} from "./fanout.ts";
import type { SlotOutcome } from "./fanout.ts";
import { readTextPayload } from "./input.ts";
import { foldLedger, latest, levelGate } from "./ledger.ts";
import { withLockFile } from "./lock.ts";
import { isLevel } from "./narrow.ts";
import { summaryWithItems, ToolError, writePrivateOutput } from "./output.ts";

export const askRun = async (ctx: HandlerContext) => {
  const { session, manifest, values, deps } = ctx;

  const question = readTextPayload(ctx, {
    positional: "question",
    inlineFlag: "text",
    label: "ask question",
  });

  const fold = foldLedger(session);

  const selected: unknown =
    values["level"] ?? latest(fold, "level")?.data["level"] ?? "medium";

  if (!isLevel(selected)) {
    throw new ToolError(1, "invalid-input", "invalid ask level");
  }

  const decision = levelGate(fold, selected);

  if (!decision.allowed) {
    throw new ToolError(
      4,
      "level-unapproved",
      "ask level requires user selection"
    );
  }

  const pins = parsePinsFlag(values["pins"]);
  const slots = resolveSlots("ask", selected, deps, pins);

  if (!slots.targets.length) {
    throw new ToolError(
      1,
      "invalid-input",
      `ask requires a read delegate${underfillNote(slots)}`
    );
  }

  const nativeFailures = ctx.nativeFailures ?? [];
  assertHostNotSandboxed(deps, slots, nativeFailures.length > 0);

  const digest = crypto
    .createHash("sha256")
    .update(question)
    .digest("hex")
    .slice(0, 16);

  const directory = path.join(session, ".state", "asks", digest);

  return await withLockFile(
    path.join(directory, "claim"),
    "ask",
    deps,
    0,
    async () => {
      const attempts = fs.readdirSync(directory).flatMap((name) => {
        const match = /^attempt-(?<cap1>[1-9]\d*)$/u.exec(name);

        return match && fs.statSync(path.join(directory, name)).isDirectory()
          ? [Number(match[1])]
          : [];
      });

      const last = Math.max(0, ...attempts);

      const attempt =
        last &&
        !fs.existsSync(path.join(directory, `attempt-${last}`, "answers.json"))
          ? last
          : last + 1;

      const dir = path.join(directory, `attempt-${attempt}`);
      const ignoredFailureReports: string[] = [];

      const outcomes = await fanOutComplete(
        {
          dir,
          slots,
          prompt: askPrompt(question, ""),
          cwd: manifest.repositoryRoot,
          sessionRoot: session,
          validate(raw) {
            const text = sanitizeText(raw);

            return text
              ? { ok: true, text }
              : {
                  ok: false,
                  cls: "empty-output",
                  reason: "empty sanitized answer",
                };
          },
          nativeFirstProviders: slots.nativeFirstProviders,
          nativeFailures,
          onIgnoredReport: (ignored) => {
            ignoredFailureReports.push(ignored);
          },
        },
        deps
      );

      const answers = outcomes.flatMap((outcome) =>
        outcome.state === "done"
          ? [
              {
                slot: outcome.slot,
                provider:
                  outcome.responder?.provider ??
                  slots.targets.find((slot) => slot.slot === outcome.slot)
                    ?.provider ??
                  // Saved outcomes may carry a provider the done shape does not declare.
                  ("provider" in outcome && typeof outcome.provider === "string"
                    ? outcome.provider
                    : undefined) ??
                  "unknown",
                ...(outcome.responder && { responder: outcome.responder }),
                text: outcome.text,
              },
            ]
          : []
      );

      const failed = outcomes.filter((outcome) => outcome.state === "failed");

      const native = outcomes.filter(
        (outcome): outcome is Extract<SlotOutcome, { state: "native" }> =>
          outcome.state === "native"
      );

      const wave = cliWaveState(dir);

      const value = {
        answers,
        failed,
        native,
        ...(wave !== undefined && { cliWave: wave }),
        ...(ignoredFailureReports.length && { ignoredFailureReports }),
        ...(slots.underfill && { underfill: slots.underfill }),
      };

      const summary = `ask: ${answers.length} answers, ${failed.length} failed${underfillNote(
        slots
      )}`;

      if (native.length) {
        return {
          ok: false,
          exit: 4,
          reason: "native-pending",
          summary: summaryWithItems(
            `ask: ${answers.length} answers, ${failed.length} failed: ${nativePendingNote(
              native.length,
              wave
            )}${underfillNote(slots)}`,
            nativeSummaryItems(native)
          ),
          value,
        };
      }

      if (!answers.length) {
        return { ok: false, exit: 2, reason: "ask-failed", summary, value };
      }

      writePrivateOutput(
        path.join(dir, "answers.json"),
        `${JSON.stringify(value)}\n`
      );

      return { ok: true, exit: 0, summary, value };
    }
  );
};
