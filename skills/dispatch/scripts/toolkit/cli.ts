import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode, stripBom } from "../lib/fs-ext.ts";
import { currentPlatform, orchestratorFor } from "../lib/platform.ts";
import type { Orchestrator } from "../lib/platform.ts";
import { readManifest, recordHost } from "../lib/session.ts";
import type { Manifest } from "../lib/session.ts";
import type { HostUsageFs } from "../lib/usage/rows.ts";
import { normalizeProvider } from "../policy/roster.ts";
import { createNodeDiscovery } from "../providers/discovery.ts";
import { SPECS, isProviderId } from "../providers/index.ts";
import { nodeProcess, nodeRunnerFs } from "../providers/node-process.ts";
import {
  createOpencodePreparePorts,
  nativeOpencodeIntrospection,
  resolveEffectiveOpencodeLaunch,
} from "../providers/opencode-runtime.ts";
import { nodeProbeSpawn } from "../providers/probe.ts";
import type { ProbeDeps } from "../providers/probe.ts";
import { runDelegate, sandboxBlocked } from "../providers/runner.ts";
import type {
  DelegateRequest,
  LifecycleStep,
  ModeId,
  ProviderId,
  RunResult,
} from "../providers/types.ts";
import { askRun } from "./ask.ts";
import {
  renderBrief,
  renderExplorerBrief,
  renderTestCleanupBrief,
  renderVerifierBrief,
} from "./brief.ts";
import { checkRun } from "./check.ts";
import { reviewId } from "./confirmations.ts";
import { ACTION_CONTRACTS, ACTION_FLAGS } from "./contracts.ts";
import { deliver, close, cleanup } from "./deliver.ts";
import { observeTool } from "./diagnostics-capture.ts";
import { diagnosticsRender } from "./diagnostics.ts";
import { doctorReport, doctorReportWithProbe } from "./doctor.ts";
import {
  BLOCKED_MARKER,
  failureReasonEvidence,
  parseBlockedReply,
} from "./domain/blocker.ts";
import type { DiagnosticEvent } from "./domain/diagnostics.ts";
import type { NativeFailure } from "./fanout/state.ts";
import { renderFixReviewLiteBrief } from "./fix-review-lite.ts";
import type { GitDeps } from "./git.ts";
import { isHintExcludedAction, stepHint } from "./hints.ts";
import { readJsonPayload } from "./input.ts";
import { integrate, continueIntegration, commit, abort } from "./integrate.ts";
import {
  appendCleanupCheckpoint,
  appendLintEdit,
  appendRecords,
  currentHashes,
  foldLedger,
  latest,
  queryLedger,
} from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { lintArtifact } from "./lint.ts";
import { present } from "./narrow.ts";
import {
  capSummary,
  summaryWithItems,
  ToolError,
  writeResult,
} from "./output.ts";
import type { HandlerResult, ToolResult } from "./output.ts";
import { validateRecord } from "./records.ts";
import { reportComplete, reportRender } from "./report.ts";
import { refreshFindingsSection, rulingReview } from "./review-findings.ts";
import { reviewDirectory } from "./review-state.ts";
import type { RecoverySelection } from "./review-state.ts";
import { reviewRun } from "./review.ts";
import { resumeStatus, statusReport } from "./status.ts";
import { create, submit, abandon } from "./writers.ts";

const earlyExclusiveFlags = ["probe", "resume-ref", "resume", "cleanup"];

const exclusiveFlags = [
  "reuse",
  "fresh",
  "edit",
  "json",
  "text",
  "message",
  "base",
  "integration-path",
  "review-fix-json",
  "test-cleanup-json",
  "task",
  "test-cleanup",
  "commit",
  "pins",
  "native-failed",
];

const booleanFlags = new Set(["relaunch", "reuse", "fresh", "probe", "resume"]);

const toolkitFlags: ParseArgsConfig["options"] = Object.fromEntries(
  Array.from(ACTION_FLAGS.keys(), (flag) => [
    flag,
    booleanFlags.has(flag)
      ? { type: "boolean" }
      : { type: "string", multiple: flag === "native-failed" },
  ])
);

const checkExclusiveFlags = (
  flags: readonly string[],
  values: HandlerContext["values"],
  action: string
) => {
  for (const flag of flags) {
    if (values[flag] === undefined) {
      continue;
    }

    const actions = present(ACTION_FLAGS.get(flag), `actions for --${flag}`);

    if (actions.includes(action)) {
      continue;
    }

    const ordered =
      flag === "pins" || flag === "native-failed"
        ? actions.toReversed()
        : actions;

    const last = ordered.at(-1);

    const label =
      ordered.length === 1
        ? last
        : `${ordered.slice(0, -1).join(", ")} and ${last}`;

    const message = `--${flag} is only for ${label}`;

    if (flag === "test-cleanup") {
      throw new Error(message);
    }

    throw new ToolError(1, "invalid-input", message);
  }
};

const parseNativeFailure = (entry: string | boolean) => {
  if (typeof entry !== "string") {
    throw new ToolError(
      1,
      "invalid-input",
      "--native-failed must be <attempt>=<reason>"
    );
  }

  const separator = entry.indexOf("=");
  const attempt = entry.slice(0, separator).trim();
  const rawReason = entry.slice(separator + 1).trim();

  if (separator <= 0 || !attempt || !rawReason) {
    throw new ToolError(
      1,
      "invalid-input",
      "--native-failed must be <attempt>=<reason>"
    );
  }

  const { isBlocked, raw } = parseBlockedReply(rawReason);
  const { reason, reasonHash } = failureReasonEvidence(raw);

  return {
    attempt,
    reason: isBlocked ? `${BLOCKED_MARKER} ${reason}` : reason,
    reasonHash,
  };
};

export type { HandlerResult } from "./output.ts";

export interface HandlerContext {
  session: string;
  manifest: Manifest;
  args: string[];
  nativeFailures?: readonly NativeFailure[];
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  deps: CliDeps;
}

export interface CliDeps {
  probe?: ProbeDeps;
  readStdin?: () => string;
  hostUsageFs?: HostUsageFs;
  diagnostics?: (event: DiagnosticEvent) => void;
  recovery?: (
    ref: unknown,
    actual: Omit<RecoverySelection, "targetHash"> & {
      target: { base: string; head: string };
    },
    subject: string
  ) =>
    | ((replies: readonly { slot: string; state: string }[]) => void)
    | undefined;
  delegate: (
    provider: ProviderId,
    request: DelegateRequest,
    mode: ModeId
  ) => Promise<RunResult>;
  modes: (provider: ProviderId) => readonly ModeId[];
  orchestrator: Orchestrator | null;
  liveness: Readonly<Record<string, boolean>>;
  sandboxSupported?: Readonly<Record<string, boolean>>;
  run: GitDeps["run"];
  hook?: (point: string) => Promise<void> | void;
  stdout: (line: string) => void;
  env: NodeJS.ProcessEnv;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  pid: number;
  host: string;
  isAlive: (pid: number) => boolean;
  skillRoot: string;
  handler?: (context: HandlerContext) => Promise<HandlerResult>;
  writeResult?: typeof writeResult;
}

const clock = () => Date.now();

const carriesInvocations = (
  error: unknown
): error is Pick<RunResult, "invocations"> =>
  typeof error === "object" &&
  error !== null &&
  "invocations" in error &&
  Array.isArray(error.invocations);

export const nodeDeps = (): CliDeps => {
  const platform = currentPlatform();
  const discovery = createNodeDiscovery(SPECS, platform);

  const modes = (provider: ProviderId) =>
    SPECS[provider].modes
      .filter((mode) => discovery.resolve(provider, mode.id).status === "path")
      .map((mode) => mode.id);

  const runnerFs = nodeRunnerFs;

  return {
    probe: {
      spawn: nodeProbeSpawn,
      platform,
      discovery,
      exists: fs.existsSync,
      cwd: process.cwd(),
      now: clock,
    },
    modes,
    orchestrator: null,
    readStdin: () => fs.readFileSync(0, "utf-8"),
    liveness: Object.fromEntries(
      Object.keys(SPECS)
        .filter(isProviderId)
        .map((provider) => [provider, modes(provider).length > 0])
    ),
    sandboxSupported: Object.fromEntries(
      Object.entries(SPECS).map(([provider, spec]) => [
        provider,
        !sandboxBlocked(spec, true, platform),
      ])
    ),
    async delegate(provider, request, mode) {
      const steps: LifecycleStep[] = [];
      let attached = false;

      const attach = (rows: RunResult["invocations"]) => {
        const [first] = rows;

        if (!attached && first) {
          attached = true;

          if (steps.length) {
            first.lifecycleSteps = [...steps, ...(first.lifecycleSteps ?? [])];
          }
        }

        return rows;
      };

      const notify = (row: RunResult["invocations"][number]) => {
        attach([row]);

        try {
          request.onInvocation?.(row);
        } catch {
          void 0;
        }
      };

      const failedLaunch = (
        cls: "not-found" | "config" | "timeout",
        detail: string
      ): RunResult => {
        const row: RunResult["invocations"][number] = {
          provider,
          model: request.model,
          mode,
          effort: request.effort,
          launched: false,
          outcome: cls,
        };

        notify(row);

        return { outcome: { status: "fail", cls, detail }, invocations: [row] };
      };

      const binary = discovery.resolve(provider, mode).path;

      if (typeof binary !== "string" || binary === "") {
        return failedLaunch("not-found", `${provider}: missing ${mode}`);
      }

      const deadline = Date.now() + request.timeoutMs;
      let resolved = request;

      if (
        provider === "opencode" &&
        !sandboxBlocked(SPECS[provider], request.sandbox, platform)
      ) {
        try {
          resolved = await resolveEffectiveOpencodeLaunch(
            request,
            nativeOpencodeIntrospection(
              binary,
              request,
              process.env,
              request.timeoutMs,
              request.collectLifecycle === true ? steps : undefined
            )
          );
        } catch (error) {
          const detail = String(error);

          return failedLaunch(
            detail.includes(
              "effective-config-unverified: opencode-lifecycle-timeout:"
            )
              ? "timeout"
              : "config",
            detail
          );
        }

        if (resolved.readOnlyBestEffort === true) {
          process.stderr.write(
            "[dispatch] opencode: explore agent is not verified read-only (best effort)\n"
          );
        }
      }

      resolved = {
        ...resolved,
        timeoutMs: Math.max(1, deadline - Date.now()),
        ...(request.onInvocation && { onInvocation: notify }),
      };

      try {
        const run = await runDelegate(SPECS[provider], resolved, mode, {
          process: nodeProcess,
          fs: runnerFs,
          env: process.env,
          platform,
          binary,
          nonce: crypto.randomUUID,
          workspaceRoot: request.cwd,
          clock: {
            now: () => Date.now(),
            every: (ms, fn) => {
              const timer = setInterval(fn, ms);

              return () => {
                clearInterval(timer);
              };
            },
          },
          ...(provider === "opencode" && {
            prepare: createOpencodePreparePorts(deadline),
          }),
        });

        attach(run.invocations);

        return run;
      } catch (error) {
        attach(carriesInvocations(error) ? error.invocations : []);
        throw error;
      }
    },
    run: async (argv, options) =>
      // oxlint-disable-next-line promise/avoid-new -- the executor bridges child-process events to promise settlement; no promise API covers it.
      await new Promise((resolve, reject) => {
        const command = present(argv[0], "command");

        const child = spawn(command, argv.slice(1), {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          windowsHide: true,
          windowsVerbatimArguments:
            process.platform === "win32" && command.toLowerCase() === "cmd.exe",
          stdio: "pipe",
        });

        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (exit) => {
          resolve({ exit: exit ?? 1, stdout, stderr });
        });
        child.stdin.on("error", (error) => {
          if (nodeErrorCode(error) !== "EPIPE") {
            reject(error);
          }
        });
        child.stdin.end(options.stdin);
      }),
    stdout: (line) => {
      process.stdout.write(line);
    },
    env: process.env,
    clock,
    sleep: async (ms) => {
      await delay(ms);
    },
    pid: process.pid,
    host: os.hostname(),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);

        return true;
      } catch (error) {
        return nodeErrorCode(error) === "EPERM";
      }
    },
    skillRoot: fileURLToPath(new URL("../..", import.meta.url)),
  };
};

interface LintEditFields {
  class: string;
  affects: string[];
  rationale: string;
  diffRef: string;
  before?: string;
}

const isLintEditFields = (value: unknown): value is LintEditFields =>
  isRecord(value) &&
  typeof value["class"] === "string" &&
  Array.isArray(value["affects"]) &&
  value["affects"].every((item) => typeof item === "string") &&
  typeof value["rationale"] === "string" &&
  typeof value["diffRef"] === "string" &&
  (value["before"] === undefined || typeof value["before"] === "string");

const readLintEditFields = (ctx: HandlerContext) => {
  const input = readJsonPayload(ctx, {
    fileFlag: "edit",
    inlineFlag: "json",
    optional: true,
    label: "--edit fields",
  });

  if (input === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the absent and validated branches.
    return undefined;
  }

  if (!isRecord(input)) {
    throw new ToolError(
      1,
      "invalid-input",
      "--edit fields must be a JSON object"
    );
  }

  const fields = input;
  const allowed = ["class", "affects", "rationale", "diffRef", "before"];
  const unknownKey = Object.keys(fields).find((key) => !allowed.includes(key));

  if (unknownKey !== undefined) {
    throw new ToolError(
      1,
      "invalid-input",
      `Unknown --edit field: ${unknownKey}. Allowed fields: ${allowed.join(", ")}.`
    );
  }

  const placeholder = `sha256:${"0".repeat(64)}`;

  try {
    validateRecord({
      kind: "edit",
      by: "orchestrator",
      key: "lint-edit:plan:1",
      data: {
        before: placeholder,
        ...fields,
        artifact: "plan",
        after: placeholder,
      },
    });
  } catch (error) {
    if (error instanceof ToolError) {
      throw new ToolError(1, "invalid-input", error.message);
    }

    throw error;
  }

  if (!isLintEditFields(fields)) {
    throw new ToolError(1, "invalid-input", "--edit fields are invalid");
  }

  return fields;
};

interface HandlerTable {
  readonly [action: string]: (
    context: HandlerContext
  ) => Promise<HandlerResult>;
}

const handlers: HandlerTable = {
  "ask run": askRun,
  "review run": reviewRun,
  "report render": reportRender,
  "report complete": reportComplete,
  "diagnostics render": diagnosticsRender,
  "brief render": renderBrief,
  "brief explorer": renderExplorerBrief,
  "brief test-cleanup": renderTestCleanupBrief,
  "brief verifier": renderVerifierBrief,
  "brief fix-review-lite": renderFixReviewLiteBrief,
  "worktree integrate": integrate,
  "worktree continue": continueIntegration,
  "worktree commit": commit,
  "worktree abort": abort,
  "worktree deliver": deliver,
  "worktree close": close,
  "worktree cleanup": cleanup,
  "worktree create": create,
  "worktree submit": submit,
  "worktree abandon": abandon,
  "check run": checkRun,
  // oxlint-disable-next-line eslint/complexity -- ledger-append branches per arg shape, cleanup value, and stdin presence.
  "ledger append": async ({ session, manifest, args, values, deps }) => {
    const [source] = args;

    if (args.length !== 1 || source === undefined) {
      throw new ToolError(
        1,
        "invalid-input",
        "ledger append takes one record file or -: ledger append <record.json|-> --session <session>"
      );
    }

    const stdin = source === "-";

    if (values["cleanup"] !== undefined && !stdin) {
      throw new ToolError(1, "invalid-input", "--cleanup requires stdin");
    }

    const file = stdin ? "" : path.resolve(source);
    let text: string;

    try {
      text = stdin
        ? present(deps.readStdin, "stdin reader")()
        : fs.readFileSync(file, "utf-8");
    } catch {
      throw new ToolError(
        1,
        "invalid-input",
        stdin
          ? "Cannot read records from stdin"
          : `Cannot read record file ${file}`
      );
    }

    let input: unknown;

    try {
      input = JSON.parse(stripBom(text));
    } catch (error) {
      throw new ToolError(
        1,
        "invalid-input",
        (stdin
          ? "Records from stdin are not valid JSON: "
          : `Record file ${file} is not valid JSON: `) +
          (error instanceof Error ? error.message : String(error))
      );
    }

    if (values["cleanup"] !== undefined) {
      const { result: value, fold: postFold } = await appendCleanupCheckpoint(
        session,
        values["cleanup"],
        input,
        deps
      );

      return {
        ok: true,
        value,
        summary: `seq ${value.seq}${value.deduped ? " deduped" : " appended"}`,
        exit: 0,
        postFold,
      };
    }

    let findingsSection: ReturnType<typeof refreshFindingsSection> | null =
      null;

    let findingsSectionReason: string | undefined;
    let postFold: Fold | undefined;

    const appended = await appendRecords(session, input, deps, {
      onCommit: (fold) => {
        postFold = fold;
        const reviews = new Set<string>();

        for (const item of Array.isArray(input) ? input : [input]) {
          if (!isRecord(item)) {
            continue;
          }

          const record = item;
          const { data } = record;

          if (!isRecord(data)) {
            continue;
          }

          if (record["kind"] === "bind") {
            for (const kind of ["plan", "design"] as const) {
              const relative = data[kind];

              if (typeof relative !== "string") {
                continue;
              }

              const review = reviewId(
                kind,
                path.resolve(manifest.repositoryRoot, relative)
              );

              if (fs.existsSync(reviewDirectory(session, review))) {
                reviews.add(review);
              }
            }

            continue;
          }

          if (record["kind"] !== "ruling") {
            continue;
          }

          const { subject } = data;

          const review =
            typeof subject === "string" ? rulingReview(subject) : null;

          if (review !== null) {
            reviews.add(review);
          }
        }

        for (const review of reviews) {
          findingsSection = refreshFindingsSection(
            session,
            manifest,
            review,
            // oxlint-disable-next-line eslint/no-loop-func -- the reason callback runs synchronously inside refreshFindingsSection; no deferred capture occurs.
            (reason) => {
              findingsSectionReason = reason;
            }
          );

          if (findingsSection !== "skipped") {
            findingsSectionReason = undefined;
          }
        }
      },
    });

    const value = {
      ...appended,
      ...(Boolean(findingsSection) && {
        findingsSection,
        ...(findingsSectionReason !== undefined &&
          findingsSectionReason !== "" && { findingsSectionReason }),
      }),
    };

    const summary = Array.isArray(input)
      ? `${appended.count} records (last seq ${appended.seq}${
          appended.deduped ? ", all deduped" : ""
        })`
      : `seq ${value.seq}${value.deduped ? " deduped" : " appended"}`;

    return { ok: true, value, summary, exit: 0, ...(postFold && { postFold }) };
  },
  // oxlint-disable-next-line eslint/require-await -- handler table requires async; the query path is synchronous.
  "ledger query": async ({ session, values, args }) => {
    if (args.length) {
      throw new ToolError(1, "invalid-input", "query takes only filters");
    }

    const fold = foldLedger(session);

    const value = queryLedger(fold, {
      kind: values["kind"],
      key: values["key"],
      since: values["since"],
    });

    return {
      ok: true,
      value,
      summary: `${value.length} records; last ${JSON.stringify(value.at(-1) ?? null)}`,
      exit: 0,
      postFold: fold,
    };
  },
  "doctor run": async ({ session, manifest, values, args, deps }) => {
    if (args.length) {
      throw new ToolError(1, "invalid-input", "doctor takes only options");
    }

    const fold =
      values["level"] === undefined ? foldLedger(session) : undefined;

    const host =
      orchestratorFor(manifest.host, (name) => deps.env[name])?.platform ??
      null;

    const reportArgs = [
      session,
      deps.skillRoot,
      values["level"],
      host,
      deps.liveness,
      deps.sandboxSupported,
      fold,
    ] as const;

    const value =
      values["probe"] === true
        ? await doctorReportWithProbe(...reportArgs, deps.probe)
        : doctorReport(...reportArgs);

    return {
      ok: value.ok,
      value,
      summary: JSON.stringify(value),
      exit: 0,
      ...(value.reason !== undefined &&
        value.reason !== "" && { reason: value.reason }),
      ...(fold && { postFold: fold }),
    };
  },
  "status show": async (ctx) => {
    const { session, manifest, args, deps } = ctx;

    if (args.length) {
      throw new ToolError(1, "invalid-input", "status takes no arguments");
    }

    if (ctx.values["resume"] === true) {
      const result = await resumeStatus(ctx);

      return {
        ok: true,
        ...result,
        summary: JSON.stringify(result.value),
        exit: 0,
      };
    }

    const fold = foldLedger(session);

    const value = await statusReport(
      session,
      manifest.repositoryRoot,
      deps,
      fold
    );

    return {
      ok: true,
      value,
      summary: JSON.stringify(value),
      exit: 0,
      postFold: fold,
    };
  },
  "lint run": async (ctx) => {
    const { args, manifest, session, deps } = ctx;
    const [target] = args;

    if (args.length !== 1 || target === undefined) {
      throw new ToolError(
        1,
        "invalid-input",
        `lint run takes one artifact path. Usage: ${
          present(ACTION_CONTRACTS["lint run"], "lint run contract").arguments
        }`
      );
    }

    const editFields = readLintEditFields(ctx);
    const artifactPath = path.resolve(target);

    const checked = editFields
      ? await appendLintEdit(session, artifactPath, editFields, deps)
      : {
          value: lintArtifact(artifactPath, {
            repositoryRoot: manifest.repositoryRoot,
          }),
        };

    const { value } = checked;
    const ok = value.errors.length === 0;

    const items = [...value.errors, ...value.warnings].map(
      (defect) => `L${defect.line ?? "-"} ${defect.code}: ${defect.message}`
    );

    const edit = "edit" in checked ? checked.edit : undefined;

    const suffix = edit
      ? `; edit seq ${edit.seq} ${edit.deduped ? "deduped" : "appended"}`
      : "";

    return {
      ok,
      value: edit ? { ...value, edit } : value,
      summary: summaryWithItems(
        `${value.kind}: ${value.errors.length} errors, ${
          value.warnings.length
        } warnings; ${value.hash}${suffix}`,
        items
      ),
      exit: ok ? 0 : 4,
      ...(!ok && { reason: "lint-errors" }),
    };
  },
};

export const TOOL_ACTIONS = Object.keys(handlers);

// oxlint-disable-next-line eslint/complexity -- dispatch branches per arg rewrite, handler lookup, and native-pending reason.
export const main = async (argv: string[], deps: CliDeps = nodeDeps()) => {
  const print = (result: ToolResult) => {
    const { exit, ...output } = result;

    let help: string | undefined;

    if (!output.ok && output.reason !== "native-pending") {
      help =
        handlers[`${argv[0] ?? ""} ${argv[1] ?? ""}`] === undefined
          ? "call table"
          : `${argv[0]} ${argv[1]}`;
    }

    deps.stdout(
      `${JSON.stringify({
        ...output,
        summary: capSummary(output.summary),
        ...(help !== undefined && help !== "" && { help }),
      })}\n`
    );

    return exit;
  };

  let nativeFailures: readonly NativeFailure[] = [];
  let parsed: ReturnType<typeof parseArgs>;
  let session: string;
  let manifest: Manifest;
  let tool: string;
  let action: string;

  try {
    const args = argv.flatMap((arg, index) => {
      if (arg === "--since" && /^-\d/u.test(argv[index + 1] ?? "")) {
        return [`${arg}=${argv[index + 1]}`];
      }

      if (index > 0 && argv[index - 1] === "--since" && /^-\d/u.test(arg)) {
        return [];
      }

      return [arg];
    });

    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: toolkitFlags,
    });
    [tool = "", action = ""] = parsed.positionals;
    const fullAction = `${tool} ${action}`;
    checkExclusiveFlags(earlyExclusiveFlags, parsed.values, fullAction);

    if (!handlers[fullAction]) {
      throw new Error("Unknown tool or action");
    }

    checkExclusiveFlags(exclusiveFlags, parsed.values, fullAction);
    const reports = parsed.values["native-failed"];

    if (reports !== undefined) {
      nativeFailures = (Array.isArray(reports) ? reports : [reports]).map(
        parseNativeFailure
      );
      delete parsed.values["native-failed"];
    }

    if (typeof parsed.values["session"] !== "string") {
      throw new TypeError("Missing --session");
    }

    session = path.resolve(parsed.values["session"]);
    manifest = readManifest(session);

    const hostSensitive = present(
      ACTION_FLAGS.get("host"),
      "actions for --host"
    ).includes(fullAction);

    const hostRaw = parsed.values["host"];

    if (hostSensitive) {
      if (typeof hostRaw !== "string") {
        throw new TypeError("Missing --host");
      }

      const normalized = normalizeProvider(hostRaw);

      if (!isProviderId(normalized)) {
        throw new Error(`Unknown --host; use ${Object.keys(SPECS).join(", ")}`);
      }

      recordHost(session, normalized);
      manifest = { ...manifest, host: normalized };
    } else if (hostRaw !== undefined) {
      throw new Error(
        "--host is only for doctor run, review run, ask run, brief render, brief explorer, brief test-cleanup, brief verifier and brief fix-review-lite"
      );
    }
  } catch (error) {
    if (error instanceof ToolError) {
      return print({
        ok: false,
        summary: error.message,
        path: null,
        reason: error.reason,
        exit: error.exit,
      });
    }

    return print({
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      path: null,
      reason: "usage",
      exit: 1,
    });
  }

  const { kind: rawKind } = parsed.values;

  let kind: string | undefined;

  if (typeof rawKind === "string") {
    kind = rawKind;
  } else if (parsed.positionals[2]?.endsWith(".plan.md") === true) {
    kind = "plan";
  } else if (parsed.positionals[2]?.endsWith(".design.md") === true) {
    kind = "design";
  } else {
    kind = undefined;
  }

  const resolvedDeps = {
    ...deps,
    orchestrator:
      orchestratorFor(manifest.host, (name) => deps.env[name]) ??
      deps.orchestrator,
  };

  const observation =
    tool === "report" || tool === "diagnostics"
      ? undefined
      : observeTool(session, tool, action, kind, resolvedDeps);

  let outcome: HandlerResult;

  try {
    const handler = present(
      resolvedDeps.handler ?? handlers[`${tool} ${action}`],
      "handler"
    );

    outcome = await handler({
      session,
      manifest,
      args: parsed.positionals.slice(2),
      values: parsed.values,
      nativeFailures,
      deps: observation?.deps ?? resolvedDeps,
    });
  } catch (error) {
    const fault =
      error instanceof ToolError
        ? error
        : new ToolError(
            2,
            "fault",
            error instanceof Error ? error.message : String(error)
          );

    outcome = {
      ok: false,
      summary: fault.message,
      reason: fault.reason,
      exit: fault.exit,
      value: { reason: fault.reason, message: fault.message },
    };
  }

  const resumeRef = observation?.finish(outcome);

  if (
    resumeRef !== undefined &&
    resumeRef !== "" &&
    tool === "status" &&
    action === "show" &&
    parsed.values["resume"] === true
  ) {
    const value =
      typeof outcome.value === "object"
        ? { ...outcome.value, resumeRef }
        : { resumeRef };

    const summary = JSON.stringify(value);

    if (Buffer.byteLength(summary) <= 2048) {
      outcome = { ...outcome, value, summary };
    }
  }

  try {
    const resultPath = (resolvedDeps.writeResult ?? writeResult)(
      session,
      tool,
      action,
      outcome.value
    );

    const reason =
      outcome.reason ??
      (outcome.ok && (tool === "ask" || tool === "review")
        ? "complete"
        : undefined);

    const fullAction = `${tool} ${action}`;
    let hint: string | undefined;

    if (
      outcome.ok &&
      reason !== "native-pending" &&
      !isHintExcludedAction(fullAction)
    ) {
      try {
        const fold = outcome.postFold ?? foldLedger(session);

        const current = currentHashes(
          manifest.repositoryRoot,
          latest(fold, "bind")
        );

        hint = stepHint({
          fold,
          current,
          action: fullAction,
          result: { ok: outcome.ok, reason, value: outcome.value },
          session,
          manifest,
        });
      } catch {
        hint = undefined;
      }
    }

    return print({
      ok: outcome.ok,
      summary: outcome.summary,
      path: resultPath,
      exit: outcome.exit,
      ...(reason !== undefined && reason !== "" && { reason }),
      ...(hint !== undefined && hint !== "" && { hint }),
    });
  } catch (error) {
    return print({
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      path: null,
      reason: "fault",
      exit: 2,
    });
  }
};

if (
  typeof process.argv[1] === "string" &&
  process.argv[1] !== "" &&
  path.resolve(process.argv[1]) === import.meta.filename
) {
  process.exitCode = await main(process.argv.slice(2));
}
