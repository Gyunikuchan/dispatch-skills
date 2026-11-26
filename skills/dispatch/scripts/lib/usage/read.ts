import { isRecord } from "../config.ts";
import { nodeErrorCode } from "../fs-ext.ts";
import type { JsonObject } from "../integrity.ts";
import { BASE_OPTIONAL_COUNTER_KEYS } from "./rows.ts";
import type {
  Counters,
  DiagnosticUsage,
  HostNote,
  HostNotes,
  HostRole,
  HostUnavailable,
  HostUsageFs,
  HostUsageResult,
  Milestone,
  PhaseMilestone,
  ReadBudget,
} from "./rows.ts";

export const readErrorReason = (error: unknown) => {
  const code = nodeErrorCode(error);
  const known = READ_ERROR_CODES.find((candidate) => candidate === code);

  const reason: HostUnavailable = known
    ? `read-error:${known}`
    : "read-error:EUNKNOWN";

  return reason;
};

export const note = (
  notes: HostNotes,
  role: HostRole,
  name: HostNote,
  count = 1
) => {
  const target = notes[role] ?? {};
  notes[role] = target;
  target[name] = (target[name] ?? 0) + count;
};

export const counters = (
  value: unknown,
  names: Record<string, string>,
  provenance: string,
  inputSemantics: DiagnosticUsage["inputSemantics"]
): DiagnosticUsage | undefined => {
  const r = row(value);

  const inputName = names["input"];
  const outputName = names["output"];

  if (!r || inputName === undefined || outputName === undefined) {
    return undefined;
  }

  const input = r[inputName];
  const output = r[outputName];

  if (!count(input) || !count(output)) {
    return undefined;
  }

  const out: DiagnosticUsage = {
    input,
    output,
    scope: "invocation",
    provenance,
    inputSemantics,
  };

  for (const key of BASE_OPTIONAL_COUNTER_KEYS) {
    const field = names[key];

    if (field !== undefined && field !== "" && r[field] !== undefined) {
      if (!count(r[field])) {
        return undefined;
      }

      out[key] = r[field];
    }
  }

  return out;
};

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

interface TranscriptRead {
  text?: string;
  stop?: "file cap" | "budget" | "zstd";
}

export const readTranscript: (
  fs: HostUsageFs,
  file: string,
  budget: ReadBudget
) => TranscriptRead = (fs, file, budget) => {
  const stat = fs.stat(file);

  if (!stat) {
    return {};
  }

  const limit = Math.min(MAX_FILE_BYTES, budget.remaining);

  const stop = () => {
    const reason = limit === MAX_FILE_BYTES ? "file cap" : "budget";

    if (reason === "budget") {
      budget.remaining = 0;
    }

    return { stop: reason } as const;
  };

  if (limit <= 0) {
    return stop();
  }

  const compressed = file.endsWith(".zst");

  if (compressed && stat.size > MAX_FILE_BYTES * 2) {
    return { stop: "file cap" };
  }

  if (!compressed && stat.size > limit) {
    return stop();
  }

  if (compressed && !fs.decompress) {
    return { stop: "zstd" };
  }

  const input = fs.read(file, compressed ? MAX_FILE_BYTES * 2 + 1 : limit + 1);

  if (compressed && input.length > MAX_FILE_BYTES * 2) {
    return { stop: "file cap" };
  }

  if (!compressed && input.length > limit) {
    return stop();
  }

  let decoded: Buffer;

  try {
    decoded = compressed && fs.decompress ? fs.decompress(input, limit) : input;
  } catch (error) {
    if (nodeErrorCode(error) === "ERR_BUFFER_TOO_LARGE") {
      budget.remaining -= limit;

      return stop();
    }

    throw error;
  }

  if (decoded.length > limit) {
    budget.remaining -= limit;

    return stop();
  }

  budget.remaining -= decoded.length;

  return { text: decoded.toString("utf-8") };
};

const hostUnavailable = (stop: "file cap" | "budget" | "zstd" | undefined) => {
  if (stop === "zstd") {
    return "zstd unavailable";
  }

  if (stop !== undefined) {
    return "transcript over size cap";
  }

  return "read-error:ENOENT";
};

const subagentNote = (
  stop: "file cap" | "budget" | "zstd" | undefined,
  oversizedSubagent: HostNote
) => {
  if (stop === "zstd") {
    return "zstd unavailable";
  }

  if (stop !== undefined) {
    return oversizedSubagent;
  }

  return "unreadable files";
};

export const readRoleTranscript = (
  fs: HostUsageFs,
  file: string,
  budget: ReadBudget,
  result: HostUsageResult,
  role: HostRole,
  oversizedSubagent: HostNote = "subagents over size cap"
): string | undefined => {
  let text: string | undefined;

  try {
    const { text: readText, stop } = readTranscript(fs, file, budget);
    text = readText;

    if (text === undefined) {
      const notes = result.notes ?? {};
      result.notes = notes;

      if (stop === "budget") {
        note(notes, role, "read budget reached");
      } else if (role === "host") {
        result.unavailable = hostUnavailable(stop);
      } else {
        note(notes, role, subagentNote(stop, oversizedSubagent));
      }
    }
  } catch (error) {
    if (role === "host") {
      result.unavailable = readErrorReason(error);
    } else {
      note((result.notes ??= {}), role, "unreadable files");
    }
  }

  return text;
};

export const stageAt = (stages: readonly Milestone[], ms: number) => {
  let [selected] = stages;

  for (const stage of stages) {
    if (
      stage.atMs <= ms &&
      (!selected || stage.atMs >= selected.atMs || selected.atMs > ms)
    ) {
      selected = stage;
    }
  }

  return selected?.stage ?? "spec";
};

export const phaseAt = (phases: readonly PhaseMilestone[], ms: number) => {
  let selected: PhaseMilestone | undefined;

  for (const phase of phases) {
    if (phase.atMs <= ms && (!selected || phase.atMs >= selected.atMs)) {
      selected = phase;
    }
  }

  return selected?.phase;
};

const READ_ERROR_CODES = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "EBUSY",
  "EMFILE",
] as const;

export const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export type Row = JsonObject;

export const row = (v: unknown) => (isRecord(v) ? v : null);

export const count = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;

export const baseCounters = (value: unknown): Counters | undefined => {
  const r = row(value);

  if (!r || !count(r["input"]) || !count(r["output"])) {
    return undefined;
  }

  const out: Counters = { input: r["input"], output: r["output"] };

  for (const key of BASE_OPTIONAL_COUNTER_KEYS) {
    const n = r[key];

    if (n === undefined) {
      continue;
    }

    if (!count(n)) {
      return undefined;
    }

    out[key] = n;
  }

  const short = r["cacheWrite5m"];
  const long = r["cacheWrite1h"];

  if (
    (short === undefined || count(short)) &&
    (long === undefined || count(long)) &&
    (short ?? 0) + (long ?? 0) <= (out.cacheWrite ?? 0)
  ) {
    if (short !== undefined) {
      out.cacheWrite5m = short;
    }

    if (long !== undefined) {
      out.cacheWrite1h = long;
    }
  }

  return out;
};

export const hasUsageTokens = (counts: Counters) =>
  counts.input > 0 ||
  counts.output > 0 ||
  (counts.cacheRead ?? 0) > 0 ||
  (counts.cacheWrite ?? 0) > 0 ||
  (counts.reasoning ?? 0) > 0;
