import { isRecord } from "../lib/config.ts";
import { checkRun } from "./check.ts";
import type { HandlerContext } from "./cli.ts";
import { integrate } from "./integrate.ts";
import { foldLedger } from "./ledger.ts";
import { present, textValue } from "./narrow.ts";
import { stepPrefix, summaryWithItems, ToolError } from "./output.ts";
import type { HandlerResult } from "./output.ts";
import { completion, launches, submit, taskId } from "./writers.ts";

const strings = (value: unknown, key: string) => {
  const list: unknown = isRecord(value) ? value[key] : undefined;

  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === "string")
    : [];
};

const checkRows = (value: unknown) => {
  const rows: unknown = isRecord(value) ? value["checks"] : undefined;

  return Array.isArray(rows) ? rows.filter(isRecord) : [];
};

/** Composes a non-ok primitive result: reason first, then counts, then the paths to read; the full value stays in the result file. */
export const landFailure = (
  step: "integrate" | "check",
  outcome: HandlerResult
): HandlerResult => {
  const reason = present(outcome.reason, "the primitive reason");
  const { value } = outcome;
  let counts: string;
  let items: string[];

  if (step === "integrate") {
    items = strings(value, "paths");
    counts = `${items.length} paths`;
  } else {
    const failed = strings(value, "failed");
    const mutated = strings(value, "mutated");
    const dirty = strings(value, "dirty");
    const rows = checkRows(value);
    const evidence = new Map<string, string>();

    for (const row of rows) {
      if (
        typeof row["criterion"] === "string" &&
        typeof row["path"] === "string"
      ) {
        evidence.set(row["criterion"], row["path"]);
      }
    }

    items = [...new Set([...failed, ...mutated, ...dirty])].map((criterion) =>
      `${criterion} ${evidence.get(criterion) ?? ""}`.trim()
    );
    counts = `${rows.length} checks, ${failed.length} failed, ${mutated.length} mutated, ${dirty.length} dirty`;
  }

  return {
    ok: false,
    exit: outcome.exit,
    reason,
    step,
    value,
    summary: summaryWithItems(
      `${reason}; ${counts}`,
      items,
      Buffer.byteLength(stepPrefix(step))
    ),
  };
};

// The CLI prefixes a step's refusal with its name, so a fault outside a ToolError needs the same step.
const runInStep = async <T>(
  step: "submit" | "integrate" | "check",
  run: () => Promise<T>
) => {
  try {
    return await run();
  } catch (error) {
    throw error instanceof ToolError
      ? new ToolError(error.exit, error.reason, error.message, step)
      : new ToolError(
          2,
          "fault",
          error instanceof Error ? error.message : String(error),
          step
        );
  }
};

/** Runs submit, integrate and `check run --task` in order. Each step reads the ledger first and skips when its durable record exists; the first failure stops the call. */
export const land = async (ctx: HandlerContext): Promise<HandlerResult> => {
  const { id } = taskId(ctx);

  const latest = (fold: ReturnType<typeof foldLedger>) =>
    launches(fold, id).at(-1);

  const needsSubmit = latest(foldLedger(ctx.session))?.finished === undefined;

  if (needsSubmit) {
    await runInStep(
      "submit",
      async () => await submit({ ...ctx, args: [id], values: {} })
    );
  }

  let fold = foldLedger(ctx.session);
  const launch = present(latest(fold), "the submitted launch");
  const ended = completion(fold, launch);

  if (ended?.data["phase"] === "abandoned") {
    const candidate = textValue(
      present(launch.finished, "the finished launch").data["candidate"]
    );

    return {
      ok: false,
      exit: 0,
      reason: "integration-abandoned",
      step: "integrate",
      value: { task: id, launch: launch.launch, candidate },
      summary: `integration-abandoned; candidate ${candidate} was abandoned; run worktree create ${id} for a new launch`,
    };
  }

  if (ended === undefined) {
    const outcome: HandlerResult = await runInStep(
      "integrate",
      async () =>
        await integrate({
          ...ctx,
          args: [id],
          values: { "ack-stale": ctx.values["ack-stale"] },
        })
    );

    if (!outcome.ok) {
      return landFailure("integrate", outcome);
    }

    fold = foldLedger(ctx.session);
  }

  const done = present(completion(fold, launch), "the integrate done record");

  const checked = await runInStep(
    "check",
    async () => await checkRun({ ...ctx, args: [], values: { task: id } })
  );

  if (!checked.ok) {
    return landFailure("check", checked);
  }

  const summary = {
    task: id,
    launch: launch.launch,
    steps: {
      submit: needsSubmit ? "done" : "skipped",
      integrate: ended === undefined ? "done" : "skipped",
      check: "done",
    },
    commit: textValue(done.data["commit"]),
    checks: { passed: checked.value.checks.length },
  };

  return {
    ok: true,
    exit: 0,
    summary: JSON.stringify(summary),
    value: { ...summary, check: checked.value },
    ...(checked.postFold && { postFold: checked.postFold }),
  };
};
