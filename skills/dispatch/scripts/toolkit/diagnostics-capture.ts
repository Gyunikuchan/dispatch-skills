import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { generateSkillHashes, readVersion } from "../lib/integrity.ts";
import type { ProviderKey } from "../lib/platform.ts";
import { delegateResponseActor } from "../lib/usage/delegate.ts";
import { hostSessionId } from "../lib/usage/index.ts";
import type { HostStage } from "../lib/usage/rows.ts";
import type { Invocation } from "../providers/types.ts";
import type { CliDeps, HandlerResult } from "./cli.ts";
import { recoveryRef } from "./domain/diagnostics-gates.ts";
import { normalizeUsage, sanitizeFacts } from "./domain/diagnostics.ts";
import type { RunFacts } from "./domain/diagnostics.ts";
import { containedSessionPath } from "./ledger.ts";
import { present } from "./narrow.ts";
import { ToolError } from "./output.ts";
import { recoveryTargetHash } from "./review-state.ts";

const CAPTURE_DIRECTORY = ".state/diagnostics";
export const CAPTURE_FAILURE_SUFFIX = ".failure.json";

export const captureDirectory = (session: string) =>
  path.join(session, CAPTURE_DIRECTORY);

const capturePointer = (ref: string) => `${CAPTURE_DIRECTORY}/${ref}.json`;

export const diagnosticSubject = (directory: string) =>
  crypto.createHash("sha256").update(directory).digest("hex").slice(0, 16);

export const hostThreadId = (
  platform: ProviderKey | null,
  env: Record<string, string | undefined>,
  sessionPath: string
) => {
  if (!platform) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the missing-platform and hashed branches.
    return undefined;
  }

  const id = hostSessionId(platform, (name) => env[name]);

  if (id === undefined || id === "") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the missing-platform and hashed branches.
    return undefined;
  }

  return crypto
    .createHmac("sha256", path.resolve(sessionPath))
    .update(JSON.stringify([platform, id]))
    .digest("hex")
    .slice(0, 16);
};

export const diagnosticsEnabled = (skillRoot: string) => {
  let candidateSeen = false;

  const read = (file: string) => {
    try {
      const contents = fs.readFileSync(file, "utf-8");
      candidateSeen = true;

      return contents;
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return null;
      }

      candidateSeen = true;
      throw error;
    }
  };

  try {
    const value = loadConfig(skillRoot, read).config["diagnostics"];

    if (value !== undefined && typeof value !== "boolean") {
      throw new Error("diagnostics must be a boolean");
    }

    return value === true;
  } catch (error) {
    if (!candidateSeen) {
      return false;
    }

    throw new ToolError(
      2,
      "config-invalid",
      error instanceof Error ? error.message : String(error)
    );
  }
};

export interface DiagnosticInstructions {
  instructions?: string;
}

const isInvocationRow = (value: unknown): value is Invocation =>
  Boolean(value) && typeof value === "object";

/** Optional diagnostics stay outside workflow decisions and semantic result files. */
export const diagnosticInstructions = (skillRoot: string) => {
  try {
    return diagnosticsEnabled(skillRoot)
      ? {
          instructions:
            "Read references/diagnostics.md from the Dispatch skill root; at each verb's final handoff, merge retro observations and run diagnostics render.",
        }
      : {};
  } catch {
    return {};
  }
};

/** Captures runner facts before semantic slot persistence, so retries and reserve calls survive recovery. */
export const observeTool = (
  session: string,
  tool: string,
  action: string,
  kind: string | undefined,
  deps: CliDeps
):
  | { deps: CliDeps; finish: (outcome: HandlerResult) => string | undefined }
  | undefined => {
  try {
    if (!diagnosticsEnabled(deps.skillRoot)) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the disabled and observer branches.
      return undefined;
    }

    const started = deps.clock();

    const phase = `${tool}-${action}${tool === "review" ? `-${kind ?? "code"}` : ""}`;

    let name: HostStage = "implementation";

    if (tool === "ask") {
      name = "ask";
    } else if (tool === "review") {
      if (kind === "plan") {
        name = "plan review";
      } else if (kind === "design") {
        name = "design review";
      } else {
        name = "code review";
      }
    }

    const hostThread = hostThreadId(
      deps.orchestrator?.platform ?? null,
      deps.env,
      session
    );

    const facts: RunFacts = {
      os: process.platform,
      ...(deps.orchestrator && { host: deps.orchestrator.platform }),
      ...(hostThread !== undefined && hostThread !== "" && { hostThread }),
      phases: [],
      invocations: [],
      reviews: [],
    };

    const directory = captureDirectory(session);
    const ref = crypto.randomUUID();
    const file = path.join(session, capturePointer(ref));
    facts.capture = { state: "opened", start: started };

    try {
      const version = readVersion(deps.skillRoot);

      if (version !== undefined && version !== "") {
        facts.version = version;
      }

      facts.build = crypto
        .createHash("sha256")
        .update(
          JSON.stringify(
            Object.entries(generateSkillHashes(deps.skillRoot)).toSorted(
              ([a], [b]) => {
                if (a < b) {
                  return -1;
                }

                if (a > b) {
                  return 1;
                }

                return 0;
              }
            )
          )
        )
        .digest("hex");
      facts.config = loadConfig(deps.skillRoot).config;
    } catch {
      void 0;
    }

    let pendingPersistence = false;

    const persist = () => {
      const temp = `${file}.tmp`;

      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temp, `${JSON.stringify(sanitizeFacts(facts))}\n`, {
          mode: 0o600,
        });
        fs.renameSync(temp, file);
        pendingPersistence = false;
      } catch {
        pendingPersistence = true;
        const capture = present(facts.capture, "capture state");
        capture.storageFailed = Math.min(
          1_000_000,
          (capture.storageFailed ?? 0) + 1
        );

        const marker = file + CAPTURE_FAILURE_SUFFIX;
        const markerTemp = `${marker}.tmp`;

        try {
          fs.writeFileSync(
            markerTemp,
            `${JSON.stringify({
              kind: "storage-failure",
              count: capture.storageFailed,
            })}\n`,
            { mode: 0o600 }
          );
          fs.renameSync(markerTemp, marker);
        } catch {
          void 0;
        } finally {
          try {
            fs.rmSync(markerTemp, { force: true });
          } catch {
            void 0;
          }
        }
      } finally {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          void 0;
        }
      }
    };

    const attempts = new Map<string, number>();
    const seen = new WeakSet<object>();
    let recoverySubject: string | undefined;

    const reused = new Set<string>();
    const launched = new Set<string>();

    // oxlint-disable-next-line eslint/complexity -- row collection branches per row shape, seen set, and usage-scope class.
    const collect = (
      rows: unknown,
      request: Parameters<CliDeps["delegate"]>[1]
    ) => {
      try {
        if (!Array.isArray(rows)) {
          return;
        }

        const slot = /^(?<cap1>[A-Za-z0-9_-]+\[\d+\])\.log$/u.exec(
          path.basename(request.logPath)
        )?.[1];

        const slotDirectory = path.dirname(path.dirname(request.logPath));
        const subject = diagnosticSubject(slotDirectory);
        const key = subject + slot;
        let added = false;
        const entries: readonly unknown[] = rows;

        for (const i of entries) {
          if (!isInvocationRow(i) || seen.has(i)) {
            continue;
          }

          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);

          const usage =
            i.usage && i.launched && i.usage.scope !== "session-cumulative"
              ? normalizeUsage(i.usage, i.usage.inputSemantics)
              : undefined;

          const source = i.usage?.provenance;

          const usageSource =
            usage && (source === "session" || source === "stdout")
              ? source
              : undefined;

          const responses =
            i.launched && Array.isArray(i.responses)
              ? i.responses.map((response) => {
                  const actor = delegateResponseActor(response);
                  const { role } = response;

                  const agent =
                    actor === undefined
                      ? undefined
                      : `delegate-${role === "subagent" ? "child-" : ""}${crypto
                          .createHmac("sha256", path.resolve(session))
                          .update(JSON.stringify([i.provider, role, actor]))
                          .digest("hex")
                          .slice(0, 16)}`;

                  return {
                    ...response,
                    stage: name,
                    ...(agent !== undefined && agent !== "" && { agent }),
                  };
                })
              : undefined;

          facts.invocations.push({
            phase,
            subject,
            attempt,
            provider: i.provider,
            model:
              i.model ?? (i.provider === "copilot" ? "unavailable" : "default"),
            mode: i.mode,
            surface: "cli",
            launched: i.launched,
            outcome: i.outcome,
            ...(i.configuredEffort !== undefined &&
              i.configuredEffort !== "" && {
                configuredEffort: i.configuredEffort,
              }),
            ...(responses !== undefined &&
              responses.length > 0 && { responses }),
            ...(slot !== undefined && slot !== "" && { slot }),
            ...(request.targetSlot !== undefined &&
              request.targetSlot !== "" && { targetSlot: request.targetSlot }),
            ...(typeof i.effort === "string" &&
              i.effort !== "" && { effort: i.effort }),
            ...(!(i.durationMs === undefined) && { durationMs: i.durationMs }),
            ...(!(i.startMs === undefined) && { startMs: i.startMs }),
            ...(!(i.endMs === undefined) && { endMs: i.endMs }),
            ...(usage && { usage }),
            ...(usageSource && { usageSource }),
            ...(i.coverage && { coverage: i.coverage }),
            ...(i.usage?.actualModels && {
              reportedModels: i.usage.actualModels,
            }),
            ...(i.usage?.models &&
              Object.keys(i.usage.models).length &&
              !usage?.models && { reportedModelAmbiguous: true as const }),
            ...(i.lifecycleSteps && { lifecycleSteps: i.lifecycleSteps }),
            ...(i.nudge === true && { nudge: true as const }),
            ...(i.wrapUp === true && { wrapUp: true as const }),
          });
          const logical = request.targetSlot ?? slot;

          if (
            i.launched &&
            logical !== undefined &&
            logical !== "" &&
            recoverySubject === slotDirectory
          ) {
            launched.add(logical);
          }

          seen.add(i);
          added = true;
        }

        if (added || pendingPersistence) {
          persist();
        }
      } catch {
        void 0;
      }
    };

    persist();

    return {
      deps: {
        ...deps,
        recovery(candidate, actual, subject) {
          if (!recoveryRef(candidate)) {
            // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the invalid-pointer and handler branches.
            return undefined;
          }

          try {
            const relative = capturePointer(candidate);
            const stat = fs.lstatSync(path.join(session, relative));

            if (!stat.isFile() || stat.size > 128 * 1024) {
              // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the invalid-pointer and handler branches.
              return undefined;
            }

            const saved: unknown = JSON.parse(
              fs.readFileSync(containedSessionPath(session, relative), "utf-8")
            );

            if (
              saved === null ||
              saved === false ||
              saved === 0 ||
              saved === ""
            ) {
              // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the invalid-pointer and handler branches.
              return undefined;
            }

            const capture = sanitizeFacts(saved);
            const selection = capture.recoverySelection;

            if (
              capture.capture?.state !== "completed" ||
              capture.capture.end === undefined ||
              !capture.phases.some(
                (p) => p.key === "status-show" && p.outcome === "ok"
              ) ||
              !selection ||
              selection.review !== actual.review ||
              selection.round !== actual.round ||
              selection.generation !== actual.generation ||
              selection.targetHash !== recoveryTargetHash(actual.target)
            ) {
              // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the invalid-pointer and handler branches.
              return undefined;
            }

            recoverySubject = subject;

            const execution: NonNullable<RunFacts["recoveryExecution"]> = {
              ref: candidate,
            };

            facts.recoveryExecution = execution;

            return (replies) => {
              execution.unresolved = new Set(
                replies
                  .filter((reply) => reply.state !== "done")
                  .map((reply) => reply.slot)
              ).size;
            };
          } catch {
            // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the handler and failed branches.
            return undefined;
          }
        },
        // oxlint-disable-next-line eslint/complexity -- event fold branches per slot/native state, validation outcome, and routing update.
        diagnostics(event) {
          try {
            if (
              event.subject === recoverySubject &&
              ((event.kind === "slot" && event.state === "done") ||
                (event.kind === "native" && event.state === "completed")) &&
              event.replay === true
            ) {
              reused.add(event.targetSlot ?? event.slot);
            }

            const subject = diagnosticSubject(event.subject);

            const base = {
              phase,
              subject,
              slot: event.slot,
              attempt: event.attempt,
              ...(event.targetSlot !== undefined &&
                event.targetSlot !== "" && { targetSlot: event.targetSlot }),
              provider: event.provider ?? "unavailable",
              model: event.model ?? "unavailable",
              launched: false,
            };

            if (event.kind === "validation" && event.surface === "cli") {
              const row = facts.invocations.findLast(
                (i) => i.subject === subject && i.slot === event.slot
              );

              if (row) {
                row.validationOutcome = event.outcome;
              }
            } else if (event.kind === "native") {
              const prior = facts.invocations.find(
                (i) =>
                  i.surface === "native" &&
                  i.subject === subject &&
                  i.slot === event.slot
              );

              const row = {
                ...base,
                ...(event.effort !== undefined &&
                  event.effort !== "" && { effort: event.effort }),
                surface: "native" as const,
                outcome:
                  event.state === "completed" ? "ok" : `native-${event.state}`,
                nativeState: event.state,
              };

              if (prior) {
                delete prior.effort;
                Object.assign(prior, row);
              } else {
                facts.invocations.push(row);
              }
            } else if (event.kind === "routing" || event.kind === "slot") {
              let row = facts.invocations.findLast(
                (i) =>
                  i.surface === "cli" &&
                  i.subject === subject &&
                  i.slot === event.slot
              );

              if (!row && event.cls) {
                row = { ...base, surface: "cli", outcome: event.cls };
                facts.invocations.push(row);
              }

              if (row) {
                if (event.kind === "routing") {
                  row.routingOutcome = event.state;
                } else {
                  row.slotState = event.state;
                }

                if (event.targetSlot !== undefined && event.targetSlot !== "") {
                  row.targetSlot = event.targetSlot;
                }
              }
            }

            persist();
          } catch {
            void 0;
          }
        },
        async delegate(provider, request, mode) {
          try {
            const result = await deps.delegate(
              provider,
              {
                ...request,
                collectUsage: true,
                ...(provider === "opencode" && { collectLifecycle: true }),
                onInvocation(row) {
                  collect([row], request);

                  try {
                    request.onInvocation?.(row);
                  } catch {
                    void 0;
                  }
                },
              },
              mode
            );

            collect(result.invocations, request);

            return result;
          } catch (error) {
            try {
              collect(
                typeof error === "object" &&
                  error !== null &&
                  "invocations" in error
                  ? error.invocations
                  : undefined,
                request
              );
            } catch {
              void 0;
            }

            throw error;
          }
        },
      },
      finish(outcome) {
        try {
          facts.phases = [
            {
              key: phase,
              name,
              outcome: outcome.ok ? "ok" : (outcome.reason ?? "fault"),
              wallMs: Math.max(0, deps.clock() - started),
            },
          ];
          facts.capture = {
            ...present(facts.capture, "capture state"),
            state: "completed",
            end: deps.clock(),
          };

          if (
            tool === "status" &&
            action === "show" &&
            outcome.ok &&
            outcome.recoverySelection
          ) {
            const selection = sanitizeFacts({
              ...facts,
              recoverySelection: outcome.recoverySelection,
            }).recoverySelection;

            if (selection) {
              facts.recoverySelection = selection;
            }
          }

          const execution = facts.recoveryExecution;

          if (execution) {
            const saved = [...reused].filter(
              (slot) => !launched.has(slot)
            ).length;

            if (saved) {
              execution.reused = saved;
            }

            if (launched.size) {
              execution.launched = launched.size;
            }
          }

          const rejection = outcome.ok ? "" : (outcome.reason ?? "");

          if (
            [
              "invalid-input",
              "invalid-record",
              "approval-stale",
              "key-conflict",
              "user-only",
            ].includes(rejection)
          ) {
            facts.rejectedTools = [{ tool, action, cls: rejection }];
          }

          persist();

          if (!pendingPersistence && facts.recoverySelection) {
            return ref;
          }

          // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the persisted and skipped branches.
          return undefined;
        } catch {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the finished and failed branches.
          return undefined;
        }
      },
    };
  } catch {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the observer and failed branches.
    return undefined;
  }
};
