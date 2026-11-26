import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../../lib/config.ts";
import type { loadReadCommands } from "../../lib/config.ts";
import { nodeErrorCode } from "../../lib/fs-ext.ts";
import { currentPlatform } from "../../lib/platform.ts";
import { readQuotaState, publishQuotaFailure } from "../../lib/quota-store.ts";
import { validSessionId } from "../../lib/session.ts";
import type { DiagnosticUsage } from "../../lib/usage/rows.ts";
import { next as nextCascade } from "../../policy/cascade.ts";
import { quotaSnapshot } from "../../policy/quota.ts";
import { SPECS, isProviderId } from "../../providers/index.ts";
import { sumSessionUsage, CONTINUE_PROMPT } from "../../providers/runner.ts";
import type {
  ProviderId,
  Invocation,
  LaunchRequest,
  ProcessResult,
  UsageBaseline,
} from "../../providers/types.ts";
import type { CliDeps } from "../cli.ts";
import type { RosterSlot } from "../domain/types.ts";
import { present } from "../narrow.ts";
import { atomic, mergeBlocked } from "./state.ts";
import type {
  BlockedAttempt,
  Emit,
  FanOutInput,
  SlotOutcome,
  Validation,
  slotFiles,
} from "./state.ts";

export const VOICE_DEADLINE_MS = 30 * 60 * 1000;

const hasUsageCounters = (part: unknown) =>
  isRecord(part) &&
  [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite5m",
    "cacheWrite1h",
    "reasoning",
  ].every((key) => {
    const field = part[key];

    return field === undefined
      ? key !== "input" && key !== "output"
      : typeof field === "number" && Number.isFinite(field) && field >= 0;
  });

const isSavedUsage = (value: unknown): value is DiagnosticUsage => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !hasUsageCounters(value) ||
    value["scope"] !== "invocation" ||
    (value["provenance"] !== "session" && value["provenance"] !== "stdout") ||
    value["inputSemantics"] !== "uncached"
  ) {
    return false;
  }

  const { actualModels } = value;

  if (
    actualModels !== undefined &&
    (!Array.isArray(actualModels) ||
      !actualModels.every((item) => typeof item === "string"))
  ) {
    return false;
  }

  const { models } = value;

  return (
    models === undefined ||
    (isRecord(models) && Object.values(models).every(hasUsageCounters))
  );
};

const savedUsage = (value: unknown) =>
  isSavedUsage(value) ? value : undefined;

const MAX_REPORT_RESUMES = 3;

const reportResumePromptPath = (promptPath: string) =>
  path.join(
    path.dirname(promptPath),
    `${path.basename(promptPath, ".md")}.no-report.md`
  );

const reportResumePrompt = (reason: string) =>
  `Your previous answer did not include a valid final report.\n\nValidation failure: ${reason}\n\nReply with only the final JSON report in the required format (a JSON object with "status" and "findings", plus "confirmations" with requestId, decision and rationale for every assigned confirmation request). Do not repeat the review.\n`;

export const cliVoice = (
  input: Pick<FanOutInput, "dir" | "quota" | "sessionRoot" | "validate">,
  deps: Pick<CliDeps, "clock" | "modes" | "delegate" | "env">,
  ports: {
    cwd: string;
    store: Parameters<typeof readQuotaState>[0];
    deadline: number;
    readCommands: ReturnType<typeof loadReadCommands>;
    rerun: boolean;
    files: Pick<ReturnType<typeof slotFiles>, "name" | "readSaved">;
    emit: Emit;
    beginAttempt: (logical: string) => void;
  }
) => {
  const {
    cwd,
    store,
    deadline,
    readCommands,
    rerun,
    files: { name, readSaved },
    emit,
    beginAttempt,
  } = ports;

  const decisions = new Map<
    string,
    ReturnType<typeof quotaSnapshot>["decisions"][number]
  >();

  const quotaFor = (
    provider: ProviderId,
    model: string | null,
    mode: string
  ) => {
    const key = { provider, model, mode };
    const id = JSON.stringify(key);

    if (input.quota) {
      return input.quota.decisions.find(
        (row) =>
          row.key.provider === provider &&
          row.key.model === model &&
          row.key.mode === mode
      );
    }

    if (!decisions.has(id)) {
      const state = readQuotaState(store, [key], deps.clock());

      const [decided] = quotaSnapshot(
        [key],
        state.generations,
        state.observations,
        deps.clock()
      ).decisions;

      decisions.set(id, present(decided, "quota decision"));
    }

    return decisions.get(id);
  };

  // oxlint-disable-next-line eslint/complexity -- voice launch branches per provider id, model shape, and mode availability.
  const voiceCLI = async (
    physical: RosterSlot,
    logicalSlot: string,
    promptPath: string
  ): Promise<SlotOutcome> => {
    if (!isProviderId(physical.provider)) {
      return {
        slot: physical.slot,
        state: "failed",
        cls: "config",
        reason: `Unknown provider ${physical.provider}`,
      };
    }

    const { provider } = physical;
    const modes = deps.modes(provider);

    let models: readonly (string | null)[];

    if (physical.model === undefined) {
      models = [null];
    } else if (typeof physical.model === "string") {
      models = [physical.model];
    } else {
      models = physical.model;
    }

    if (!modes.length) {
      return {
        slot: physical.slot,
        state: "failed",
        cls: "not-found",
        reason: `No launchable ${provider} binary`,
      };
    }

    let blocked: BlockedAttempt[] = [];

    const config = {
      slot: physical.slot,
      platform: provider,
      models,
      modes,
      modeCascadeOn: SPECS[provider].modeCascadeOn,
    };

    let position = { model: 0, mode: 0 };
    const targetForEmit: RosterSlot = { ...physical, slot: logicalSlot };

    const voiceDeadline = physical.reserve
      ? deps.clock() + VOICE_DEADLINE_MS
      : deadline;

    let reportResumes = 0;
    let resumeSessionId: string | null = null;
    let resumesUsed = 0;

    let sessionUsage: DiagnosticUsage | undefined;
    let usageBaseline: UsageBaseline = "cumulative";
    let usageWindowEndMs: number | undefined;
    const logPath = path.join(input.dir, "logs", `${name(logicalSlot)}.log`);

    const statePath = path.join(
      input.dir,
      "logs",
      `${name(logicalSlot)}.state.json`
    );

    let crossRun = false;
    let pending: "stall" | "report" = "stall";
    let restart: string | undefined;

    interface SlotState {
      physicalSlot: string;
      provider: string;
      model: string | null;
      position: { model: number; mode: number };
      pending: "stall" | "report";
      resumesUsed: number;
      reportResumes: number;
      sessionId: string | null;
      sessionUsage?: DiagnosticUsage;
      usageBaseline?: UsageBaseline;
      usageWindowEndMs?: number;
    }

    let saved: Partial<SlotState> | undefined;
    const priorOutcome = rerun ? readSaved(logicalSlot) : undefined;

    if (priorOutcome?.state === "done" || priorOutcome?.state === "failed") {
      restart = "saved outcome retake";
    } else {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(statePath, "utf-8"));

        if (
          parsed !== null &&
          parsed !== undefined &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        ) {
          saved = parsed;
        } else {
          restart = "stale: unreadable state";
        }
      } catch {
        if (rerun) {
          restart = "stale: missing or unreadable state";
        }
      }
    }

    let leftover = "";
    let logPreserved = true;

    try {
      leftover = fs.readFileSync(logPath, "utf-8");

      if (leftover) {
        fs.appendFileSync(`${logPath}.stalled`, leftover);
      }
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        logPreserved = false;
      }
    }

    if (saved) {
      const pos = saved.position;

      const validBaseline: UsageBaseline | undefined =
        saved.usageBaseline === "cumulative" || saved.usageBaseline === "none"
          ? saved.usageBaseline
          : undefined;

      const validWindowEnd =
        typeof saved.usageWindowEndMs === "number" &&
        Number.isFinite(saved.usageWindowEndMs)
          ? saved.usageWindowEndMs
          : undefined;

      if (
        saved.physicalSlot !== physical.slot ||
        saved.provider !== provider ||
        !pos ||
        typeof pos.model !== "number" ||
        typeof pos.mode !== "number" ||
        !Number.isInteger(pos.model) ||
        !Number.isInteger(pos.mode) ||
        pos.model < 0 ||
        pos.model >= models.length ||
        pos.mode < 0 ||
        pos.mode >= modes.length ||
        saved.model !== (models[pos.model] ?? null)
      ) {
        restart = "stale: slot, provider, model or position changed";
      } else if (
        SPECS[provider].resumeUsage === "cumulative" &&
        saved.sessionUsage !== undefined &&
        !savedUsage(saved.sessionUsage)
      ) {
        restart = "stale: invalid session usage";
      } else if (
        saved.pending === "report" &&
        !fs.existsSync(reportResumePromptPath(promptPath))
      ) {
        restart = "stale: missing report prompt";
      } else if (
        typeof saved.resumesUsed !== "number" ||
        typeof saved.reportResumes !== "number" ||
        !Number.isInteger(saved.resumesUsed) ||
        saved.resumesUsed < 0 ||
        saved.resumesUsed >= 3 ||
        !Number.isInteger(saved.reportResumes) ||
        saved.reportResumes < 0 ||
        saved.reportResumes > MAX_REPORT_RESUMES ||
        (saved.pending !== "stall" && saved.pending !== "report")
      ) {
        restart = "stale: invalid resume state";
      } else {
        let id = validSessionId(saved.sessionId);

        if (id === null && leftover && SPECS[provider].attemptSession) {
          try {
            const output: ProcessResult = {
              exit: null,
              signal: null,
              stdout: leftover,
              stdoutPath: logPath,
              stderrTail: "",
              durationMs: 0,
              timedOut: false,
              truncated: false,
            };

            const request: LaunchRequest = {
              binary: "",
              prompt: "",
              briefFile: null,
              schemaText: null,
              platform: currentPlatform(),
              promptPath,
              model: models[pos.model] ?? null,
              effort: physical.effort ?? null,
              sandbox: physical.sandbox ?? true,
              schemaPath: null,
              resume: null,
              cwd,
              timeoutMs: 0,
              outputCapBytes: 0,
              attachments: [],
              logPath,
              briefPath: `${logPath}.spill.md`,
            };

            id = validSessionId(
              SPECS[provider].attemptSession(output, request)
            );
          } catch {
            void 0;
          }
        }

        if (id === null) {
          restart = "stale: no valid session ID";
        } else if (
          SPECS[provider].resumeUsage === "cumulative" &&
          validBaseline === undefined
        ) {
          restart = "stale: invalid session usage";
        } else {
          position = pos;
          ({ resumesUsed } = saved);
          ({ reportResumes } = saved);
          resumeSessionId = id;
          ({ pending } = saved);
          sessionUsage =
            SPECS[provider].resumeUsage === "cumulative"
              ? savedUsage(saved.sessionUsage)
              : undefined;
          usageBaseline = validBaseline ?? "none";
          usageWindowEndMs = validWindowEnd;
          crossRun = true;
        }
      }
    }

    let stateEnabled = logPreserved;

    const checkpoint = (model: string | null) => {
      if (!stateEnabled) {
        return;
      }

      try {
        atomic(statePath, {
          physicalSlot: physical.slot,
          provider,
          model,
          position,
          pending,
          resumesUsed,
          reportResumes,
          sessionId: resumeSessionId,
          usageBaseline,
          ...(usageWindowEndMs !== undefined && { usageWindowEndMs }),
          ...(restart !== undefined && restart !== "" && { restart }),
          ...(sessionUsage &&
            SPECS[provider].resumeUsage === "cumulative" && { sessionUsage }),
        });
      } catch {
        stateEnabled = false;

        try {
          fs.rmSync(statePath, { force: true });
        } catch {
          void 0;
        }
      }
    };

    for (;;) {
      const remaining = voiceDeadline - deps.clock();

      if (remaining <= 0) {
        return {
          slot: physical.slot,
          state: "failed",
          cls: "timeout",
          reason: "Fan-out deadline passed",
          ...(blocked.length && { blocked }),
        };
      }

      const model = models[position.model] ?? null;
      const mode = present(modes[position.mode], "provider mode");

      const decision = quotaFor(provider, model, mode);
      let failure: Extract<Validation, { ok: false }>;

      if (decision?.skipped === true) {
        failure = {
          ok: false,
          cls: "quota",
          reason: "skipped-quota: quota-cooldown",
        };
      } else {
        for (;;) {
          const budget = voiceDeadline - deps.clock();

          if (budget <= 0) {
            failure = {
              ok: false,
              cls: "timeout",
              reason: "Fan-out deadline passed",
            };
            break;
          }

          beginAttempt(logicalSlot);
          stateEnabled = logPreserved;

          if (resumeSessionId === null) {
            sessionUsage = undefined;
            usageBaseline = "cumulative";
            usageWindowEndMs = undefined;

            try {
              if (fs.existsSync(logPath) && logPreserved) {
                const old = fs.readFileSync(logPath);

                if (old.length && !leftover) {
                  fs.appendFileSync(`${logPath}.stalled`, old);
                }

                fs.writeFileSync(logPath, "");
              }
            } catch {
              stateEnabled = false;

              try {
                fs.rmSync(statePath, { force: true });
              } catch {
                void 0;
              }
            }
          }

          leftover = "";
          const continued = crossRun && pending === "stall";

          if (continued) {
            resumesUsed += 1;
          }

          const continuePath = `${promptPath}.continue.md`;

          if (continued) {
            fs.writeFileSync(continuePath, CONTINUE_PROMPT, { mode: 0o600 });
          }

          checkpoint(model);
          const observed = new Set<Invocation>();
          let resumeCallback = false;

          // oxlint-disable-next-line eslint/no-loop-func -- recordUsage intentionally folds the latest per-model usage inside this sequential model loop.
          const recordUsage = (row: Invocation) => {
            if (row.usageBaseline !== undefined) {
              ({ usageBaseline } = row);
            }

            if (row.usageWindowEndMs !== undefined) {
              ({ usageWindowEndMs } = row);
            }

            if (SPECS[provider].resumeUsage === "cumulative" && row.usage) {
              try {
                sessionUsage = sumSessionUsage([sessionUsage, row.usage]);
              } catch {
                sessionUsage = undefined;
              }
            }

            checkpoint(model);
          };

          let result: Awaited<ReturnType<CliDeps["delegate"]>>;

          try {
            let activePromptPath = promptPath;

            if (continued) {
              activePromptPath = continuePath;
            } else if (pending === "report" && resumeSessionId !== null) {
              activePromptPath = reportResumePromptPath(promptPath);
            }

            // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
            result = await deps.delegate(
              provider,
              {
                promptPath: activePromptPath,
                model,
                effort: physical.effort ?? null,
                sandbox: physical.sandbox ?? true,
                schemaPath: null,
                resume: resumeSessionId,
                cwd,
                resumesUsed,
                ...(resumeSessionId !== null &&
                  sessionUsage !== undefined && { priorUsage: sessionUsage }),
                usageBaseline,
                ...(usageWindowEndMs !== undefined && { usageWindowEndMs }),
                timeoutMs: budget,
                outputCapBytes:
                  SPECS[provider].outputCapBytes ?? 10 * 1024 * 1024,
                attachments: [],
                logPath,
                briefPath: `${logPath}.spill.md`,
                // oxlint-disable-next-line eslint/no-loop-func -- onResume intentionally mutates this iteration's resume state during the in-iteration delegate call.
                onResume: (id, count) => {
                  resumeCallback = true;
                  resumeSessionId = id;
                  resumesUsed = count;
                  pending = "stall";
                  checkpoint(model);
                },
                onInvocation: (row) => {
                  if (!observed.has(row)) {
                    observed.add(row);
                    recordUsage(row);
                  }
                },
                configSelectors: Object.fromEntries(
                  ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"].flatMap((key) =>
                    deps.env[key] === undefined ? [] : [[key, deps.env[key]]]
                  )
                ),
                readCommands,
                ...(!(input.sessionRoot === undefined) && {
                  sessionRoot: input.sessionRoot,
                }),
                ...(!(logicalSlot === physical.slot) && {
                  targetSlot: logicalSlot,
                }),
              },
              mode
            );
          } catch (error) {
            if (!crossRun) {
              throw error;
            }

            crossRun = false;
            restart = "failed cross-run resume: launch error";
            resumesUsed = 0;
            reportResumes = 0;
            resumeSessionId = null;
            sessionUsage = undefined;
            usageBaseline = "cumulative";
            usageWindowEndMs = undefined;
            pending = "stall";
            continue;
          }

          for (const row of result.invocations) {
            if (!observed.has(row)) {
              recordUsage(row);
            }
          }

          if (!resumeCallback) {
            resumesUsed += result.invocations
              .slice(1)
              .filter(
                (invocation) =>
                  invocation.nudge === true && invocation.wrapUp !== true
              ).length;
          }

          if (result.outcome.status === "ok") {
            resumeSessionId =
              validSessionId(result.outcome.sessionId) ?? resumeSessionId;
          }

          checkpoint(model);

          if (crossRun && result.outcome.status === "fail") {
            crossRun = false;
            restart = `failed cross-run resume: ${result.outcome.cls}`;
            resumesUsed = 0;
            reportResumes = 0;
            resumeSessionId = null;
            sessionUsage = undefined;
            usageBaseline = "cumulative";
            usageWindowEndMs = undefined;
            pending = "stall";
            continue;
          }

          crossRun = false;

          if (result.outcome.status === "ok") {
            const checked = input.validate(result.outcome.text, logicalSlot);
            emit(targetForEmit, {
              kind: "validation",
              surface: "cli",
              outcome: checked.ok ? "ok" : checked.cls,
            });

            if (checked.ok) {
              return {
                slot: logicalSlot,
                state: "done",
                text: checked.text ?? result.outcome.text,
                responder: {
                  slot: physical.slot,
                  provider,
                  model,
                  native: false,
                },
                ...(blocked.length && { blocked }),
              };
            }

            failure = checked;

            if (checked.blocked) {
              blocked = mergeBlocked(blocked, [
                { provider, model, ...checked.blocked },
              ]);
            }

            const sessionId = validSessionId(result.outcome.sessionId);

            if (sessionId !== null) {
              resumeSessionId = sessionId;
            }

            if (
              checked.cls === "no-report" &&
              resumeSessionId !== null &&
              reportResumes < MAX_REPORT_RESUMES &&
              deps.clock() < voiceDeadline
            ) {
              reportResumes += 1;
              pending = "report";

              try {
                fs.copyFileSync(logPath, `${logPath}.no-report`);
              } catch {
                void 0;
              }

              fs.writeFileSync(
                reportResumePromptPath(promptPath),
                reportResumePrompt(checked.reason),
                { mode: 0o600 }
              );
              continue;
            }
          } else {
            failure = {
              ok: false,
              cls: result.outcome.cls,
              reason: result.outcome.detail,
            };

            const generation = decision?.generation;

            if (
              failure.cls === "quota" &&
              typeof generation === "string" &&
              generation !== ""
            ) {
              publishQuotaFailure(
                store,
                { provider, model, mode },
                generation,
                deps.clock()
              );
            }
          }

          break;
        }
      }

      const cascade = nextCascade(failure.cls, position, config);
      emit(targetForEmit, {
        kind: "routing",
        state: cascade.kind === "terminal" ? "stop" : cascade.kind,
        cls: failure.cls,
      });

      if (cascade.kind === "next-model" || cascade.kind === "next-mode") {
        ({ position } = cascade);
        resumesUsed = 0;
        reportResumes = 0;
        resumeSessionId = null;
        sessionUsage = undefined;
        usageBaseline = "cumulative";
        usageWindowEndMs = undefined;
        pending = "stall";
        continue;
      }

      return {
        slot: physical.slot,
        state: "failed",
        cls: failure.cls,
        reason: failure.reason,
        ...(blocked.length && { blocked }),
      };
    }
  };

  return voiceCLI;
};
