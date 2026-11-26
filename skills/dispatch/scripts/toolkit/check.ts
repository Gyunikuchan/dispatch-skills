import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { nodeLinkFs } from "../lib/node-fs-ext.ts";
import type { HandlerContext } from "./cli.ts";
import { stableValue } from "./domain/stable-value.ts";
import { cleanupBinding } from "./evidence.ts";
import { headTree, testedTree } from "./git.ts";
import { ensureIntegration } from "./integration.ts";
import { appendRecord, withLedger, foldLedger } from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { ToolError } from "./output.ts";
import { checks, loadPlan, taskCriteria } from "./plan-view.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ResolvedCommand {
  execId: string;
  cacheHex: string;
  tree: string;
  logPath: string;
  logSha256: string;
  logText: string;
}

interface CriterionCommandEntry {
  command: string;
  mode: "fresh" | "dedup" | "reused";
  execId: string | null;
  cacheHex: string | null;
  logPath: string;
  logSha256: string;
}

const shellArgv = (os: string, command: string) =>
  os === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["sh", "-c", command];

const sha256Hex = (data: string | Uint8Array) =>
  crypto.createHash("sha256").update(data).digest("hex");

const toRelPath = (base: string, target: string) =>
  path.relative(base, target).split(path.sep).join("/");

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const commandCacheKey = (command: string, tree: string) =>
  sha256Hex(stableValue({ command, tree, clean: true }));

// oxlint-disable-next-line eslint/complexity -- reuse branches per tree equality, exec-field shape, and log-hash match.
const tryReuseCommand = (
  session: string,
  command: string,
  currentTestedTree: string,
  currentHeadTree: string,
  cacheHex: string
) => {
  if (currentTestedTree !== currentHeadTree) {
    return null;
  }

  try {
    const indexFile = path.join(
      session,
      ".state/evidence/commands/index",
      `${cacheHex}.json`
    );

    const pointer: unknown = JSON.parse(fs.readFileSync(indexFile, "utf-8"));

    if (
      !isRecord(pointer) ||
      !isNonEmptyString(pointer["execId"]) ||
      !UUID_RE.test(pointer["execId"])
    ) {
      return null;
    }

    const { execId } = pointer;

    const execFile = path.join(
      session,
      ".state/evidence/commands",
      `${execId}.json`
    );

    const derivedLogPath = path.join(
      session,
      ".state/evidence/commands",
      `${execId}.log`
    );

    const expectedRelLogPath = `.state/evidence/commands/${execId}.log`;
    const exec: unknown = JSON.parse(fs.readFileSync(execFile, "utf-8"));

    if (!isRecord(exec)) {
      return null;
    }

    for (const field of [
      "execId",
      "cacheHex",
      "command",
      "tree",
      "headTree",
      "before",
      "after",
      "logPath",
      "logSha256",
    ] as const) {
      if (!isNonEmptyString(exec[field])) {
        return null;
      }
    }

    if (
      typeof exec["clean"] !== "boolean" ||
      typeof exec["exit"] !== "number" ||
      !Number.isFinite(exec["exit"])
    ) {
      return null;
    }

    if (
      exec["execId"] !== execId ||
      exec["cacheHex"] !== cacheHex ||
      exec["command"] !== command ||
      exec["before"] !== exec["after"] ||
      exec["before"] !== exec["tree"] ||
      exec["headTree"] !== exec["tree"] ||
      currentTestedTree !== exec["tree"] ||
      currentHeadTree !== exec["tree"] ||
      !exec["clean"] ||
      exec["exit"] !== 0 ||
      exec["logPath"] !== expectedRelLogPath
    ) {
      return null;
    }

    const logBuf = fs.readFileSync(derivedLogPath);

    if (`sha256:${sha256Hex(logBuf)}` !== exec["logSha256"]) {
      return null;
    }

    return {
      execId,
      cacheHex,
      tree: exec["tree"],
      logPath: expectedRelLogPath,
      logSha256: exec["logSha256"],
      logText: logBuf.toString("utf-8"),
    };
  } catch {
    return null;
  }
};

const recordCacheableCommand = (
  session: string,
  command: string,
  tree: string,
  headTreeValue: string,
  cacheHex: string,
  logText: string
) => {
  const execId = crypto.randomUUID();
  const commandsDir = path.join(session, ".state/evidence/commands");
  const execLogFile = path.join(commandsDir, `${execId}.log`);
  const execFile = path.join(commandsDir, `${execId}.json`);
  const indexFile = path.join(commandsDir, "index", `${cacheHex}.json`);
  const relLogPath = `.state/evidence/commands/${execId}.log`;
  const logSha256 = `sha256:${sha256Hex(Buffer.from(logText, "utf-8"))}`;

  const execRecord = {
    execId,
    cacheHex,
    command,
    tree,
    headTree: headTreeValue,
    clean: true,
    before: tree,
    after: tree,
    exit: 0,
    logPath: relLogPath,
    logSha256,
    createdAt: new Date().toISOString(),
  };

  nodeLinkFs.writeAtomic(execLogFile, logText);
  nodeLinkFs.writeAtomic(execFile, JSON.stringify(execRecord));
  nodeLinkFs.writeAtomic(indexFile, JSON.stringify({ execId }));

  return { execId, cacheHex, tree, logPath: relLogPath, logSha256, logText };
};

interface CheckRecord {
  criterion: string;
  commandDigest: string;
  tree: string;
  clean: boolean;
  before: string;
  after: string;
  exit: number;
  path: string;
  logPath: string;
}

// oxlint-disable-next-line eslint/complexity -- check-run branches per task/criteria args, reuse/fresh flags, and review presence.
export const checkRun = async (ctx: HandlerContext) => {
  const { session, manifest, deps, values, args } = ctx;

  if (args.length) {
    throw new ToolError(1, "invalid-input", "check run takes only options");
  }

  if (values["task"] !== undefined && values["criteria"] !== undefined) {
    throw new ToolError(
      1,
      "invalid-input",
      "check run accepts --criteria or --task, not both"
    );
  }

  if (values["reuse"] === true && values["fresh"] === true) {
    throw new ToolError(
      1,
      "invalid-input",
      "check run accepts --reuse or --fresh, not both"
    );
  }

  const allowReuse = values["reuse"] === true;
  const forceFresh = values["fresh"] === true;

  const taskId =
    typeof values["task"] === "string" ? values["task"].trim() : "";

  if (values["task"] !== undefined && !taskId) {
    throw new ToolError(
      1,
      "invalid-input",
      "check run --task requires a task ID"
    );
  }

  const named =
    typeof values["criteria"] === "string"
      ? values["criteria"]
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : null;

  if (values["criteria"] !== undefined && (named?.length ?? 0) === 0) {
    throw new ToolError(
      1,
      "invalid-input",
      "check run --criteria requires at least one criterion ID"
    );
  }

  const plan = loadPlan(session, manifest);
  const all = checks(plan);
  const removed = cleanupBinding(foldLedger(session))?.removed ?? [];

  const ids =
    named ??
    (taskId
      ? taskCriteria(plan, taskId).filter(
          (id) =>
            !removed.includes(id) &&
            all.some((c) => c.criterion === id && c.evidenceClass !== "review")
        )
      : all
          .filter((c) => c.evidenceClass !== "review")
          .map((c) => c.criterion)
          .filter((id) => !removed.includes(id)));

  const unknown = ids.filter((id) => !all.some((c) => c.criterion === id));

  if (unknown.length) {
    throw new ToolError(
      1,
      "invalid-input",
      `Unknown criterion: ${unknown.join(", ")}; valid: ${all
        .map((c) => c.criterion)
        .join(", ")}`
    );
  }

  const gone = ids.filter((id) => removed.includes(id));

  if (gone.length) {
    throw new ToolError(
      4,
      "test-cleanup-removed",
      `Test cleanup removed the tests for ${gone.join(
        ", "
      )}; their evidence stays bound to their recorded evidence tree`
    );
  }

  const selected = all.filter((c) => ids.includes(c.criterion));

  const review = selected
    .filter((c) => c.evidenceClass === "review")
    .map((c) => c.criterion);

  if (review.length) {
    throw new ToolError(
      1,
      "invalid-input",
      `Review-only criteria need user evidence and cannot be checked by tool evidence: ${review.join(
        ", "
      )}`
    );
  }

  const empty = selected
    .filter((c) => c.criterion !== "contract" && !c.commands.length)
    .map((c) => c.criterion);

  if (empty.length) {
    throw new ToolError(
      1,
      "invalid-input",
      `Criteria have no Check commands: ${empty.join(", ")}`
    );
  }

  const integration = await withLedger(
    session,
    "check run",
    deps,
    async (tx) => await ensureIntegration(tx, ctx)
  );

  const directory = path.join(session, ".state/evidence");
  fs.mkdirSync(directory, { recursive: true });
  const runId = crypto.randomUUID();
  const records: CheckRecord[] = [];
  const withinRun = new Map<string, ResolvedCommand>();
  let executed = 0;
  let reused = 0;
  let postFold: Fold | undefined;

  for (const check of selected) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    const before = await testedTree(deps, session, integration.path);
    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    let cmdHead = await headTree(deps, integration.path);
    const clean = before === cmdHead;
    let cmdBefore = before;
    let cmdAfter = before;
    let cmdClean = clean;
    let exit = 0;
    let combinedLog = "";
    const commandEntries: CriterionCommandEntry[] = [];
    const safeCriterion = check.criterion.replaceAll(/[^A-Za-z0-9._-]/gu, "_");

    for (const [idx, command] of check.commands.entries()) {
      const cacheHex = cmdClean ? commandCacheKey(command, cmdBefore) : null;

      const withinHit =
        !forceFresh && cacheHex !== null ? withinRun.get(cacheHex) : undefined;

      if (withinHit) {
        cmdAfter = cmdBefore;
        combinedLog += withinHit.logText;
        commandEntries.push({
          command,
          mode: "dedup",
          execId: withinHit.execId,
          cacheHex: withinHit.cacheHex,
          logPath: withinHit.logPath,
          logSha256: withinHit.logSha256,
        });
        continue;
      }

      const reuseHit =
        allowReuse && !forceFresh && cacheHex !== null
          ? tryReuseCommand(session, command, cmdBefore, cmdHead, cacheHex)
          : null;

      if (reuseHit && cacheHex !== null) {
        reused += 1;
        withinRun.set(cacheHex, reuseHit);
        cmdAfter = cmdBefore;
        combinedLog += reuseHit.logText;
        commandEntries.push({
          command,
          mode: "reused",
          execId: reuseHit.execId,
          cacheHex: reuseHit.cacheHex,
          logPath: reuseHit.logPath,
          logSha256: reuseHit.logSha256,
        });
        continue;
      }

      executed += 1;

      // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
      const result = await deps.run(shellArgv(process.platform, command), {
        cwd: integration.path,
      });

      const cmdLog = `$ ${command}\n${result.stdout}${result.stderr}`;
      combinedLog += cmdLog;
      // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
      cmdAfter = await testedTree(deps, session, integration.path);
      ({ exit } = result);

      if (
        cmdClean &&
        cacheHex !== null &&
        cmdBefore === cmdAfter &&
        result.exit === 0
      ) {
        const saved = recordCacheableCommand(
          session,
          command,
          cmdAfter,
          cmdHead,
          cacheHex,
          cmdLog
        );

        withinRun.set(cacheHex, saved);
        commandEntries.push({
          command,
          mode: "fresh",
          execId: saved.execId,
          cacheHex: saved.cacheHex,
          logPath: saved.logPath,
          logSha256: saved.logSha256,
        });
      } else {
        if (cmdClean && cacheHex !== null) {
          withinRun.delete(cacheHex);
          fs.rmSync(
            path.join(directory, "commands/index", `${cacheHex}.json`),
            { force: true }
          );
        }

        const runLogFile = path.join(
          directory,
          "runs",
          `${runId}-${safeCriterion}-${idx}.log`
        );

        nodeLinkFs.writeAtomic(runLogFile, cmdLog);
        commandEntries.push({
          command,
          mode: "fresh",
          execId: null,
          cacheHex: null,
          logPath: toRelPath(session, runLogFile),
          logSha256: `sha256:${sha256Hex(Buffer.from(cmdLog, "utf-8"))}`,
        });
      }

      if (result.exit !== 0) {
        break;
      }

      if (idx + 1 < check.commands.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
        cmdHead = await headTree(deps, integration.path);
        cmdClean = cmdAfter === cmdHead;
        cmdBefore = cmdAfter;
      }
    }

    const after = cmdAfter;

    const ledgerData = {
      criterion: check.criterion,
      commandDigest: check.commandDigest,
      tree: before,
      clean,
      before,
      after,
      exit,
    };

    const evidenceHex = sha256Hex(stableValue({ runId, ...ledgerData }));
    const file = path.join(directory, `${evidenceHex}.json`);
    const logPath = path.join(directory, `${evidenceHex}.log`);
    nodeLinkFs.writeAtomic(logPath, combinedLog);
    nodeLinkFs.writeAtomic(
      file,
      JSON.stringify({ ...ledgerData, runId, commands: commandEntries })
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    await deps.hook?.("check:after-evidence");
    const evidence = { ...ledgerData, path: toRelPath(session, file) };
    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    await appendRecord(
      session,
      {
        kind: "evidence",
        by: "tool",
        key: `evidence:${evidenceHex}`,
        data: evidence,
      },
      deps,
      {
        // oxlint-disable-next-line eslint/no-loop-func -- onCommit runs synchronously inside appendRecords; no deferred capture occurs.
        onCommit: (fold) => {
          postFold = fold;
        },
      }
    );
    records.push({ ...evidence, logPath });
  }

  const failed = records.flatMap((r) => (r.exit === 0 ? [] : [r.criterion]));

  const mutated = records.flatMap((r) =>
    r.before === r.after ? [] : [r.criterion]
  );

  const dirty = records.flatMap((r) => (r.clean ? [] : [r.criterion]));

  let reason: "checks-failed" | "mutated" | "dirty" | undefined;

  if (failed.length > 0) {
    reason = "checks-failed";
  } else if (mutated.length > 0) {
    reason = "mutated";
  } else if (dirty.length > 0) {
    reason = "dirty";
  } else {
    reason = undefined;
  }

  const reusedSuffix = reused > 0 ? `; reused ${reused}` : "";

  return {
    ok: reason === undefined,
    exit: 0,
    ...(reason && { reason }),
    summary: `${records.length} checks (${executed} commands); failed ${failed.join(",")}; mutated ${mutated.join(",")}; dirty ${dirty.join(",")}${reusedSuffix}`,
    value: { checks: records, executed, reused, failed, mutated, dirty },
    ...(postFold && { postFold }),
  };
};
