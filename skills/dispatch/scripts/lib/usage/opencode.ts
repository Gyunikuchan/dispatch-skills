import { opencodeDbPath } from "../opencode-db.ts";
import type { OpencodeMessage, OpencodeRead } from "../opencode-db.ts";
import { count, note, readErrorReason, row, stageAt } from "./read.ts";
import type { Row } from "./read.ts";
import type {
  DiagnosticUsage,
  HostNotes,
  HostStage,
  HostUsageAdapter,
  HostUsageFs,
  HostUsageQuery,
  HostUsageResult,
  UsageRow,
} from "./rows.ts";
import { addCounters } from "./rows.ts";

const buildRow = (
  message: OpencodeMessage,
  query: HostUsageQuery,
  result: HostUsageResult,
  rootRole: "host" | "delegate"
): UsageRow & { stage: HostStage } => {
  const hostRow: UsageRow & { stage: HostStage } = {
    stage: stageAt(query.stages, message.createdMs),
    role: message.depth === 0 ? rootRole : "subagent",

    model: message.model ?? "",
    effort: message.effort,
    depth: message.depth,
    atMs: message.createdMs,
    reasoningInOutput: false,
    turns: 1,
    ...(message.toolCalls !== undefined && {
      toolCalls: message.toolCalls,
      toolTurns: message.toolCalls > 0 ? 1 : 0,
    }),
    input: message.input,
    output: message.output,
  };

  if (result.response) {
    const actor = message.depth === 0 ? query.sessionId : message.sessionId;

    if (actor !== undefined) {
      hostRow.responseActor = actor;
    }
  }

  if (message.cacheRead !== undefined) {
    hostRow.cacheRead = message.cacheRead;
  }

  if (message.cacheWrite !== undefined) {
    hostRow.cacheWrite = message.cacheWrite;
  }

  if (message.reasoning !== undefined) {
    hostRow.reasoning = message.reasoning;
  }

  return hostRow;
};

const canRecordUserTurns = (
  result: HostUsageResult,
  notes: HostNotes,
  read: OpencodeRead,
  rootRole: "host" | "delegate"
) =>
  rootRole === "host" &&
  result.unavailable === undefined &&
  Object.keys(notes.host ?? {}).length === 0 &&
  read.userTurnsTruncated !== true &&
  read.userMessageTimes !== undefined;

const recordUserTurns = (
  result: HostUsageResult,
  read: OpencodeRead,
  query: HostUsageQuery
) => {
  const userTurnsByStage: Partial<Record<HostStage, number>> = {};
  const times = read.userMessageTimes ?? [];

  for (const at of times) {
    const stage = stageAt(query.stages, at);
    userTurnsByStage[stage] = (userTurnsByStage[stage] ?? 0) + 1;
  }

  result.userTurns = times.length;
  result.userTurnsByStage = userTurnsByStage;
};

export const collectOpencodeUsage: (
  query: HostUsageQuery,
  fs: HostUsageFs,
  options?: { rootRole?: "host" | "delegate" }
) => HostUsageResult = (query, fs, options) => {
  const notes: HostNotes = {};
  const result: HostUsageResult = { rows: [], notes };
  const rootRole = options?.rootRole ?? "host";

  if (query.collectResponses) {
    result.response = { basis: "opencode-assistant-message" };
  }

  if (query.budget.remaining <= 0) {
    note(notes, "host", "read budget reached");

    return result;
  }

  if (!fs.opencodeMessages) {
    return { ...result, unavailable: "read-error:EUNKNOWN" };
  }

  const dbPath = opencodeDbPath(query.home, query.env);
  let read: ReturnType<NonNullable<HostUsageFs["opencodeMessages"]>>;

  try {
    read = fs.opencodeMessages(dbPath, query.sessionId, {
      fromMs: query.startMs,
      toMs: query.endMs,
      ...(result.response && { includeSessionIdentity: true }),
    });
  } catch (error) {
    return { ...result, unavailable: readErrorReason(error) };
  }

  if (result.response && (read.skipped > 0 || read.truncated === "rows")) {
    result.response.limited = true;
  }

  for (const message of read.messages) {
    result.rows.push(buildRow(message, query, result, rootRole));
  }

  if (read.skipped > 0) {
    note(notes, "host", "unparsed lines", read.skipped);
  }

  if (read.truncated === "rows") {
    note(notes, "host", "read budget reached");
  }

  if (read.truncated === "sessions") {
    note(notes, "subagent", "too many candidates");
  }

  if (read.messages.length === 0) {
    result.unavailable = "no usage records";
  }

  if (canRecordUserTurns(result, notes, read, rootRole)) {
    recordUserTurns(result, read, query);
  }

  return result;
};

export const opencode: HostUsageAdapter = {
  sessionEnv: ["OPENCODE_SESSION_ID"],
  read: (query, fs, delegate) =>
    collectOpencodeUsage(
      query,
      fs,
      delegate ? { rootRole: "delegate" } : undefined
    ),
};

export const OPENCODE_COMPLETION_USAGE = "opencode.step.finish";

/** OpenCode `run --format json`: one `step_finish` per turn carries usage; `tokens.input` already excludes cache reads. */
export const opencodeUsage = (raw: string): DiagnosticUsage | undefined => {
  let total: DiagnosticUsage | undefined;

  for (const line of raw.split(/\r?\n/u).filter((v) => v.trim())) {
    let event: Row | null;

    try {
      event = row(JSON.parse(line));
    } catch {
      return undefined;
    }

    if (event?.["type"] !== "step_finish") {
      continue;
    }

    const tokens = row(row(event["part"])?.["tokens"]);

    const rawInput = tokens?.["input"];
    const rawOutput = tokens?.["output"];

    if (!tokens || !count(rawInput) || !count(rawOutput)) {
      return undefined;
    }

    const cache = row(tokens["cache"]);

    const usage: DiagnosticUsage = {
      input: rawInput,
      output: rawOutput,
      scope: "invocation",
      provenance: OPENCODE_COMPLETION_USAGE,
      inputSemantics: "uncached",
    };

    for (const [key, value] of [
      ["reasoning", tokens["reasoning"]],
      ["cacheRead", cache?.["read"]],
      ["cacheWrite", cache?.["write"]],
    ] as const) {
      if (value === undefined) {
        continue;
      }

      if (!count(value)) {
        return undefined;
      }

      usage[key] = value;
    }

    if (total) {
      addCounters(total, usage);
    } else {
      total = usage;
    }
  }

  return total;
};
