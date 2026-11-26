import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";

import { getSqlite } from "../opencode-db.ts";
import {
  MAX_FILE_BYTES,
  count,
  counter,
  counters,
  note,
  readErrorReason,
  readRoleTranscript,
  row,
  stageAt,
} from "./read.ts";
import type {
  DiagnosticModelUsage,
  DiagnosticUsage,
  Counters,
  HostNotes,
  HostRole,
  HostStage,
  HostUsageAdapter,
  HostUsageFs,
  HostUsageQuery,
  HostUsageResult,
  ReadBudget,
  UsageRow,
} from "./rows.ts";
import { addCounters, emptyModelMap } from "./rows.ts";

const hasText = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

/* oxlint-disable eslint/complexity -- Agy JSONL folding mirrors the on-disk transcript schema; refactor deferred to avoid behavior drift. */
export const collectAgyUsage: (
  query: HostUsageQuery,
  fsPort: HostUsageFs,
  options?: { appDataDir?: string; rootRole?: "host" | "delegate" }
) => HostUsageResult = (query, fsPort, options) => {
  const notes: HostNotes = {};
  const result: HostUsageResult = { rows: [], notes };
  const rootRole = options?.rootRole ?? "host";

  if (query.collectResponses) {
    result.response = { basis: "agy-planner-response" };
  }

  if (!ID_REGEX.test(query.sessionId)) {
    return { ...result, unavailable: "invalid host id" };
  }

  let root = path.join(query.home, ".gemini", "antigravity");
  const appData = options?.appDataDir;

  if (hasText(appData)) {
    root = appData;
  } else {
    const envData = query.env("ANTIGRAVITY_APP_DATA_DIR");

    if (hasText(envData)) {
      root = envData;
    }
  }

  const hostTranscriptFile = path.join(
    root,
    "brain",
    query.sessionId,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );

  let hostStat: { size: number; mtimeMs: number } | null = null;

  try {
    hostStat = fsPort.stat(hostTranscriptFile);
  } catch (error) {
    result.unavailable = readErrorReason(error);
  }

  if (!hostStat) {
    return {
      ...result,
      unavailable: result.unavailable ?? "host id file missing",
    };
  }

  const subagentFallbackModels = new Map<string, string>();
  const visited = new Set<string>();
  visited.add(query.sessionId);
  let userTurns = 0;
  const userTurnsByStage: Partial<Record<HostStage, number>> = {};

  const getDescriptorChildren = (parentId: string) => {
    const subDir = path.join(
      root,
      "brain",
      parentId,
      ".system_generated",
      "subagents"
    );

    let names: string[];

    try {
      names = fsPort.list(subDir);
    } catch {
      note(notes, "subagent", "unreadable files");

      return [];
    }

    const children: string[] = [];

    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }

      if (query.budget.remaining <= 0) {
        note(notes, "subagent", "read budget reached");
        break;
      }

      const descFile = path.join(subDir, name);
      let cid: string | null = null;

      try {
        const stat = fsPort.stat(descFile);

        if (stat) {
          const capped = Math.min(stat.size, 65_536);

          if (query.budget.remaining < capped) {
            query.budget.remaining = 0;
            note(notes, "subagent", "read budget reached");
            break;
          }

          const buf = fsPort.read(descFile, capped);
          query.budget.remaining = Math.max(
            0,
            query.budget.remaining - buf.length
          );

          const conversationId = row(JSON.parse(buf.toString("utf-8")))?.[
            "conversationId"
          ];

          if (typeof conversationId === "string") {
            cid = conversationId;
          }
        }
      } catch {
        // The descriptor name supplies the ID if the descriptor cannot be read.
        // Conversation metadata is optional; skip unreadable entries.
      }

      if (!hasText(cid)) {
        cid = path.basename(name, ".json");
      }

      if (ID_REGEX.test(cid)) {
        children.push(cid);
      }
    }

    return children;
  };

  const processConversation = (
    id: string,
    role: HostRole,
    fallbackModel: string,
    depth: number
  ) => {
    const discoveredChildren: string[] = [];

    const transcriptFile = path.join(
      root,
      "brain",
      id,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );

    const text = readRoleTranscript(
      fsPort,
      transcriptFile,
      query.budget,
      result,
      role
    );

    if (text === undefined) {
      return { steps: [], discoveredChildren };
    }

    const steps: ParsedStep[] = [];
    const pendingInvokeModels: string[] = [];

    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      let entry: ReturnType<typeof row>;

      try {
        entry = row(JSON.parse(line));
      } catch {
        note(notes, role, "unparsed lines");
        continue;
      }

      if (!entry) {
        continue;
      }

      const createdAt = entry["created_at"];

      if (
        entry["type"] === "USER_INPUT" &&
        role === "host" &&
        rootRole === "host" &&
        entry["source"] === "USER_EXPLICIT"
      ) {
        const at =
          typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;

        if (Number.isFinite(at) && at >= query.startMs && at <= query.endMs) {
          userTurns += 1;
          const stage = stageAt(query.stages, at);
          userTurnsByStage[stage] = (userTurnsByStage[stage] ?? 0) + 1;
        }

        continue;
      }

      if (entry["type"] === "PLANNER_RESPONSE") {
        const at =
          typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;

        const stepIndex = entry["step_index"];
        const input = entry["input_tokens"];
        const output = entry["output_tokens"];
        const cacheRead = entry["cache_read_tokens"];
        const rawCalls = entry["tool_calls"];

        const calls: readonly unknown[] = Array.isArray(rawCalls)
          ? rawCalls
          : [];

        if (
          !counter(stepIndex) ||
          !Number.isFinite(at) ||
          !counter(input) ||
          !counter(output) ||
          (cacheRead !== undefined && !counter(cacheRead))
        ) {
          note(notes, role, "unparsed lines");
          continue;
        }

        const parsed: ParsedStep = {
          step_index: stepIndex,
          atMs: at,
          ...(typeof createdAt === "string" &&
            !/\.\d+/u.test(createdAt) && { wholeSecond: true as const }),
          input_tokens: input,
          output_tokens: output,
          toolCalls: calls.length,
        };

        if (cacheRead !== undefined) {
          parsed.cache_read_tokens = cacheRead;
        }

        steps.push(parsed);

        for (const rawCall of calls) {
          const call = row(rawCall);

          if (call?.["name"] === "invoke_subagent") {
            const model = row(call["args"])?.["Model"];

            let m =
              typeof model === "string"
                ? model.replaceAll(/^"|"$/gu, "").trim()
                : null;

            if (hasText(m)) {
              const norm = normalizeAgyModelEffort(m);
              m = norm.model ?? m;
            }

            pendingInvokeModels.push(hasText(m) ? m : "unknown");
          }
        }
      } else if (entry["type"] === "GENERIC") {
        const { content } = entry;

        if (
          typeof content === "string" &&
          content.includes("Created the following subagent:")
        ) {
          const matches = content.matchAll(
            /"conversationId"\s*:\s*"(?<rg1>[A-Za-z0-9-]+)"/gu
          );

          for (const [, childId] of matches) {
            if (childId === undefined) {
              continue;
            }

            const m = pendingInvokeModels.shift() ?? "unknown";

            if (!subagentFallbackModels.has(childId)) {
              subagentFallbackModels.set(childId, m);
            }

            discoveredChildren.push(childId);
          }
        }
      }
    }

    const dbFile = path.join(root, "conversations", `${id}.db`);
    let blobs: readonly Uint8Array[] | null = null;

    try {
      if (fsPort.sqliteGenMetadata) {
        const statDb = fsPort.stat(dbFile);

        if (statDb) {
          let dbSize = statDb.size;
          const statWal = fsPort.stat(`${dbFile}-wal`);

          if (statWal) {
            dbSize += statWal.size;
          }

          const limit = Math.min(MAX_FILE_BYTES, query.budget.remaining);

          if (dbSize > limit) {
            if (dbSize > MAX_FILE_BYTES) {
              note(notes, role, "unreadable files");
            } else {
              query.budget.remaining = 0;
              note(notes, role, "read budget reached");
            }
          } else if (limit > 0) {
            const rawBlobs = fsPort.sqliteGenMetadata(dbFile);

            if (rawBlobs && rawBlobs.length > 0) {
              const blobBytes = rawBlobs.reduce(
                (sum, b) => sum + b.byteLength,
                0
              );

              query.budget.remaining = Math.max(
                0,
                query.budget.remaining - blobBytes
              );
              blobs = rawBlobs;
            }
          }
        }
      }
    } catch {
      note(notes, role, "unreadable files");
    }

    let k = 0;
    let rows: ReturnType<typeof decodeAgyGenMetadata>[] = [];

    if (blobs && blobs.length > 0) {
      rows = blobs.map(decodeAgyGenMetadata);

      while (k < Math.min(steps.length, rows.length)) {
        const r = rows[k];
        const s = steps[k];

        if (!r || !s) {
          break;
        }

        const previous = steps[k - 1];

        const intervalMatch =
          r.lastStepIndex !== undefined &&
          (!previous || r.lastStepIndex >= previous.step_index) &&
          r.lastStepIndex < s.step_index;

        if (
          r.input === s.input_tokens &&
          r.output === s.output_tokens &&
          intervalMatch &&
          r.model !== null
        ) {
          k += 1;
        } else {
          break;
        }
      }

      if (k < steps.length || rows.length !== steps.length) {
        note(notes, role, "unparsed lines");
      }
    } else if (
      rootRole === "delegate" &&
      steps.length > 0 &&
      notes[role]?.["read budget reached"] === undefined &&
      notes[role]?.["unreadable files"] === undefined
    ) {
      note(notes, role, "unreadable files");
    }

    let inWindowCount = 0;
    const seenSteps = new Set<number>();

    for (const [i, s] of steps.entries()) {
      const repeated = seenSteps.has(s.step_index);
      seenSteps.add(s.step_index);

      if (!(s.atMs >= query.startMs && s.atMs <= query.endMs)) {
        continue;
      }

      inWindowCount += 1;
      let model: string;
      let effort: string | null;
      let reasoning: number | undefined;

      const r = i < k ? rows[i] : undefined;

      if (r && r.model !== null) {
        const {
          model: foundModel,
          effort: foundEffort,
          reasoning: foundReasoning,
        } = r;

        model = foundModel;
        effort = foundEffort;
        reasoning = foundReasoning;
      } else {
        model = fallbackModel;
        effort = null;
        reasoning = undefined;
      }

      const hostRow: UsageRow & { stage: HostStage } = {
        stage: stageAt(query.stages, s.atMs),
        role: role === "host" ? rootRole : role,
        model,
        effort,
        depth,
        atMs: s.atMs,
        ...(s.wholeSecond && { wholeSecond: true as const }),
        reasoningInOutput: false,
        ...(repeated
          ? { skipResponse: true as const }
          : {
              turns: 1,
              toolCalls: s.toolCalls,
              toolTurns: s.toolCalls > 0 ? 1 : 0,
            }),
        input: s.input_tokens,
        output: s.output_tokens,
      };

      if (s.cache_read_tokens !== undefined) {
        hostRow.cacheRead = s.cache_read_tokens;
      }

      if (reasoning !== undefined && counter(reasoning)) {
        hostRow.reasoning = reasoning;
      }

      if (result.response) {
        hostRow.responseActor = id;

        if (repeated) {
          result.response.limited = true;
        }
      }

      result.rows.push(hostRow);
    }

    if (role === "host" && !inWindowCount && !result.unavailable) {
      result.unavailable = "no usage records";
    }

    return { steps, discoveredChildren };
  };

  const agyModel = query.env("ANTIGRAVITY_MODEL");

  const hostEnvModel = hasText(agyModel) ? agyModel : query.env("GEMINI_MODEL");

  const normalizedHostModel = hasText(hostEnvModel)
    ? (normalizeAgyModelEffort(hostEnvModel).model ?? hostEnvModel)
    : "";

  const hostFallbackModel = hasText(normalizedHostModel)
    ? normalizedHostModel
    : "unknown";

  const hostResult = processConversation(
    query.sessionId,
    "host",
    hostFallbackModel,
    0
  );

  if (notes.host?.["read budget reached"] !== undefined) {
    return result;
  }

  if (
    rootRole === "host" &&
    !result.unavailable &&
    !Object.keys(notes.host ?? {}).length
  ) {
    result.userTurns = userTurns;
    result.userTurnsByStage = userTurnsByStage;
  }

  let currentQueue: string[];
  {
    const hostDescChildren = getDescriptorChildren(query.sessionId);
    const level1Set = new Set<string>();

    for (const cid of hostDescChildren) {
      if (!visited.has(cid)) {
        level1Set.add(cid);
      }
    }

    for (const cid of hostResult.discoveredChildren) {
      if (!visited.has(cid)) {
        level1Set.add(cid);
      }
    }

    const sorted = [...level1Set].toSorted((a, b) => a.localeCompare(b));

    for (const id of sorted) {
      visited.add(id);
    }

    currentQueue = sorted;
  }

  let liveCount = 0;
  let excess = 0;
  let depth = 1;

  while (currentQueue.length > 0) {
    if (notes.subagent?.["read budget reached"] !== undefined) {
      break;
    }

    const eligibleThisLevel: string[] = [];

    for (const childId of currentQueue) {
      const transcriptFile = path.join(
        root,
        "brain",
        childId,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      );

      let stat: { size: number; mtimeMs: number } | null;

      try {
        stat = fsPort.stat(transcriptFile);
      } catch {
        note(notes, "subagent", "unreadable files");
        continue;
      }

      if (!stat) {
        note(notes, "subagent", "unreadable files");
        continue;
      }

      if (stat.mtimeMs < query.startMs) {
        continue;
      }

      if (liveCount < 256) {
        liveCount += 1;
        eligibleThisLevel.push(childId);
      } else {
        excess += 1;
      }
    }

    const nextLevelSet = new Set<string>();

    for (const childId of eligibleThisLevel) {
      if (notes.subagent?.["read budget reached"] !== undefined) {
        break;
      }

      const fallback = subagentFallbackModels.get(childId) ?? "unknown";

      const childRes = processConversation(
        childId,
        "subagent",
        fallback,
        depth
      );

      if (notes.subagent?.["read budget reached"] !== undefined) {
        break;
      }

      const descChildren = getDescriptorChildren(childId);

      for (const cid of descChildren) {
        if (!visited.has(cid)) {
          nextLevelSet.add(cid);
        }
      }

      for (const cid of childRes.discoveredChildren) {
        if (!visited.has(cid)) {
          nextLevelSet.add(cid);
        }
      }
    }

    const nextSorted = [...nextLevelSet].toSorted((a, b) => a.localeCompare(b));

    for (const id of nextSorted) {
      visited.add(id);
    }

    currentQueue = nextSorted;
    depth += 1;
  }

  if (excess > 0) {
    note(notes, "subagent", "too many candidates", excess);
  }

  return result;
};
/* oxlint-enable eslint/complexity */

// oxlint-disable-next-line eslint/complexity -- model/effort normalization mirrors the Agy display-name table; refactor deferred.
export const normalizeAgyModelEffort = (
  rawModel?: string | null,
  rawEffort?: string | null,
  displayName?: string | null
) => {
  let effortCandidate: string | null = null;
  let displayNameBase: string | null = null;

  if (hasText(displayName)) {
    const labelled = displayEffort(displayName);

    if (labelled) {
      displayNameBase = labelled.base;
      effortCandidate = labelled.level;
    } else {
      displayNameBase = displayName.trim();
    }
  }

  let rawModelEffortSuffix: string | null = null;
  const trimmedRawModel = rawModel?.trim();
  let modelCandidate = hasText(trimmedRawModel) ? trimmedRawModel : null;

  if (hasText(modelCandidate)) {
    if (!hasText(displayName)) {
      const labelled = displayEffort(modelCandidate);

      if (labelled) {
        displayNameBase = labelled.base;
        effortCandidate ??= labelled.level;
        modelCandidate = displayNameBase;
      }
    }

    const effortMatch = EFFORT_SUFFIX.exec(modelCandidate);

    if (effortMatch) {
      rawModelEffortSuffix = effortMatch[1]?.toLowerCase() ?? null;
      modelCandidate = modelCandidate.slice(0, effortMatch.index);
    }

    modelCandidate = modelCandidate.replace(BACKEND_SUFFIXES, "");
    const secondaryEffort = EFFORT_SUFFIX.exec(modelCandidate);

    if (secondaryEffort) {
      rawModelEffortSuffix ??= secondaryEffort[1]?.toLowerCase() ?? null;
      modelCandidate = modelCandidate.slice(0, secondaryEffort.index);
    }
  }

  const finalEffort =
    effortCandidate ??
    (hasText(rawEffort) && VALID_EFFORTS.has(rawEffort.trim().toLowerCase())
      ? rawEffort.trim().toLowerCase()
      : null) ??
    rawModelEffortSuffix;

  let finalModel: string | null = null;

  if (
    hasText(modelCandidate) &&
    modelCandidate.length >= 3 &&
    !/\s/u.test(modelCandidate) &&
    !/[()]/u.test(modelCandidate)
  ) {
    finalModel = modelCandidate.toLowerCase();
  } else if (hasText(displayNameBase)) {
    finalModel = deriveBaseSlug(displayNameBase);
  } else if (hasText(modelCandidate)) {
    finalModel = deriveBaseSlug(modelCandidate) ?? modelCandidate.toLowerCase();
  }

  return {
    model: finalModel,
    effort: finalEffort,
  };
};

// oxlint-disable-next-line eslint/complexity -- protobuf field walk has one branch per wire type; refactor deferred.
export const decodeAgyGenMetadata = (data: Uint8Array) => {
  try {
    let tag19: string | null = null;
    let tag21: string | null = null;
    let lastStepIndex: number | undefined;
    let input: number | undefined;
    let output: number | undefined;
    let cacheRead: number | undefined;
    let reasoning: number | undefined;

    const cur: [number] = [0];

    while (cur[0] < data.length) {
      const tag = readVarint(data, cur);

      const fn = Math.floor(tag / 8);
      const wire = tag % 8;

      if (fn === 1 && wire === 2) {
        const s1 = readSlice(data, cur);
        const c1: [number] = [0];

        while (c1[0] < s1.length) {
          const t1 = readVarint(s1, c1);

          const f1 = Math.floor(t1 / 8);
          const w1 = t1 % 8;

          if (f1 === 4 && w1 === 2) {
            const s4 = readSlice(s1, c1);
            const c4: [number] = [0];

            while (c4[0] < s4.length) {
              const t4 = readVarint(s4, c4);

              const f4 = Math.floor(t4 / 8);
              const w4 = t4 % 8;

              if (w4 === 0) {
                const val = readVarint(s4, c4);

                if (count(val)) {
                  if (f4 === 2) {
                    input = val;
                  } else if (f4 === 3) {
                    output = val;
                  } else if (f4 === 5) {
                    cacheRead = val;
                  } else if (f4 === 9) {
                    reasoning = val;
                  }
                }
              } else {
                skipField(w4, s4, c4);
              }
            }
          } else if (f1 === 19 && w1 === 2) {
            tag19 = Buffer.from(readSlice(s1, c1)).toString("utf-8");
          } else if (f1 === 20 && w1 === 2) {
            const s20 = readSlice(s1, c1);
            const c20: [number] = [0];

            let kText = "";
            let vText = "";

            while (c20[0] < s20.length) {
              const t20 = readVarint(s20, c20);

              const f20 = Math.floor(t20 / 8);
              const w20 = t20 % 8;

              if (w20 === 2) {
                const str = Buffer.from(readSlice(s20, c20)).toString("utf-8");

                if (f20 === 1) {
                  kText = str;
                } else if (f20 === 2) {
                  vText = str;
                }
              } else if (w20 === 0) {
                const val = readVarint(s20, c20);

                if (f20 === 2) {
                  vText = String(val);
                }
              } else {
                skipField(w20, s20, c20);
              }
            }

            if (kText === "last_step_index" && vText) {
              // oxlint-disable-next-line unicorn/prefer-number-coercion -- vText is an untrusted protobuf string; parseInt reads its leading digits where Number() would reject the field.
              const num = Number.parseInt(vText, 10);

              if (count(num)) {
                lastStepIndex = num;
              }
            }
          } else if (f1 === 21 && w1 === 2) {
            tag21 = Buffer.from(readSlice(s1, c1)).toString("utf-8");
          } else {
            skipField(w1, s1, c1);
          }
        }
      } else {
        skipField(wire, data, cur);
      }
    }

    const { model, effort } = normalizeAgyModelEffort(tag19, null, tag21);
    const result: AgyTurnMetadata = { model, effort };

    if (hasText(tag21)) {
      result.hasDisplayName = true;
    }

    if (lastStepIndex !== undefined) {
      result.lastStepIndex = lastStepIndex;
    }

    if (input !== undefined) {
      result.input = input;
    }

    if (output !== undefined) {
      result.output = output;
    }

    if (cacheRead !== undefined) {
      result.cacheRead = cacheRead;
    }

    if (reasoning !== undefined) {
      result.reasoning = reasoning;
    }

    return result;
  } catch {
    return { model: null, effort: null };
  }
};

const ID_REGEX = /^[A-Za-z0-9-]+$/u;

interface ParsedStep {
  step_index: number;
  atMs: number;
  wholeSecond?: true;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  toolCalls: number;
}

export const agy: HostUsageAdapter = {
  sessionEnv: ["ANTIGRAVITY_CONVERSATION_ID"],
  read(query, fsPort, delegate) {
    return collectAgyUsage(
      query,
      fsPort,
      delegate
        ? {
            rootRole: "delegate",
            ...(hasText(delegate.appDataDir) && {
              appDataDir: delegate.appDataDir,
            }),
          }
        : undefined
    );
  },
};

interface AgyTurnMetadata {
  model: string | null;
  effort: string | null;
  hasDisplayName?: boolean;
  lastStepIndex?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
}

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const BACKEND_SUFFIXES = /-(?<rg1>trial|tiered|control|n)$/iu;
const EFFORT_SUFFIX = /-(?<rg1>low|medium|high|xhigh|max)$/iu;

const DISPLAY_EFFORT =
  /^(?<rg1>.*?)\s*\((?<rg2>low|medium|high|xhigh|max)\)\s*$/iu;

const deriveBaseSlug = (text: string) => {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  const claudeMatch =
    /^Claude\s+(?<rg1>[A-Za-z0-9]+)\s+(?<rg2>\d+)\.(?<rg3>\d+)$/iu.exec(
      trimmed
    );

  const [, family, major, minor] = claudeMatch ?? [];

  if (family !== undefined) {
    return `claude-${family.toLowerCase()}-${major}-${minor}`;
  }

  const tokens = trimmed.match(/[A-Za-z0-9]+(?:\.[0-9]+)*/gu);

  if (!tokens || tokens.length === 0) {
    return null;
  }

  return tokens.map((t) => t.toLowerCase()).join("-");
};

/** The two captures of a `name (effort)` label; undefined when the text has another shape. */
const displayEffort = (text: string) => {
  const [, base, level] = DISPLAY_EFFORT.exec(text) ?? [];

  return base === undefined || level === undefined
    ? undefined
    : { base: base.trim(), level: level.toLowerCase() };
};

const readVarint = (buf: Uint8Array, cur: [number]) => {
  let shift = 0;
  let val = 0;

  while (cur[0] < buf.length) {
    const b = buf[cur[0]] ?? 0;
    cur[0] += 1;
    val += (b % 128) * 2 ** shift;

    if (b < 128) {
      break;
    }

    shift += 7;

    if (shift > 49) {
      break;
    }
  }

  return val;
};

const readSlice = (buf: Uint8Array, cur: [number]) => {
  const len = readVarint(buf, cur);

  if (len < 0 || len > buf.length - cur[0]) {
    cur[0] = buf.length;

    return new Uint8Array(0);
  }

  const [start] = cur;
  cur[0] += len;

  return buf.subarray(start, cur[0]);
};

const skipVarint = (buf: Uint8Array, cur: [number]) => {
  while (cur[0] < buf.length) {
    const byte = buf[cur[0]] ?? 0;
    cur[0] += 1;

    if (byte < 128) {
      return;
    }
  }
};

const skipField = (wire: number, buf: Uint8Array, cur: [number]) => {
  if (wire === 0) {
    skipVarint(buf, cur);
  } else if (wire === 1) {
    cur[0] = Math.min(cur[0] + 8, buf.length);
  } else if (wire === 2) {
    const len = readVarint(buf, cur);

    if (len < 0 || len > buf.length - cur[0]) {
      cur[0] = buf.length;
    } else {
      cur[0] += len;
    }
  } else if (wire === 5) {
    cur[0] = Math.min(cur[0] + 4, buf.length);
  } else {
    cur[0] = buf.length;
  }
};

export const readAgySqliteGenMetadata = (
  dbPath: string,
  options?: { maxBytes?: number; throwOnError?: boolean }
) => {
  try {
    const maxBytes = options?.maxBytes;

    if (maxBytes !== undefined) {
      let totalSize = 0;

      try {
        const s = fs.statSync(dbPath);
        totalSize += s.size;
      } catch (error) {
        if (options?.throwOnError === true) {
          throw error;
        }

        return null;
      }

      try {
        const wal = fs.statSync(`${dbPath}-wal`);
        totalSize += wal.size;
      } catch {
        // An absent write-ahead log adds no bytes.
      }

      if (totalSize > maxBytes) {
        if (options?.throwOnError === true) {
          throw new Error(
            `file size ${totalSize} exceeds maxBytes ${maxBytes}`
          );
        }

        return null;
      }
    }

    const { DatabaseSync } = getSqlite();
    let db: DatabaseSync | null = null;

    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare("SELECT data FROM gen_metadata ORDER BY idx");

      // A non-blob cell keeps the typed-array constructor's length coercion.
      return stmt
        .all()
        .map(({ data }) =>
          types.isUint8Array(data) ? data : new Uint8Array(Number(data))
        );
    } finally {
      try {
        db?.close();
      } catch {
        // A failed close must not hide the read result or its error.
      }
    }
  } catch (error) {
    if (options?.throwOnError === true) {
      throw error;
    }

    return null;
  }
};

interface UsageContext {
  appDataDir?: string;
  readSqliteGenMetadata?: (dbPath: string) => readonly Uint8Array[] | null;
  budget?: ReadBudget;
}

const hasTurnCounters = (
  turn: AgyTurnMetadata
): turn is AgyTurnMetadata & Counters =>
  turn.input !== undefined && turn.output !== undefined;

export const AGY_ENVELOPE_USAGE = "agy.usage.envelope";

// oxlint-disable-next-line eslint/complexity -- Agy envelope usage combines transcript, env, and sqlite evidence; refactor deferred.
export const agyUsage = (
  raw: string,
  context?: UsageContext
): DiagnosticUsage | undefined => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const envelope = row(parsed);

  // agy reports cache reads beside input_tokens, so input is uncached; agy has no cache-write counter.
  const out = counters(
    envelope?.["usage"],
    {
      input: "input_tokens",
      output: "output_tokens",
      cacheRead: "cache_read_tokens",
      reasoning: "thinking_tokens",
    },
    "agy.usage",
    "uncached"
  );

  if (out === undefined) {
    return undefined;
  }

  const usageRow = row(envelope?.["usage"]);

  let rawModel: string | null = null;

  if (typeof envelope?.["model"] === "string") {
    rawModel = envelope["model"];
  } else if (typeof usageRow?.["model"] === "string") {
    rawModel = usageRow["model"];
  }

  let rawEffort: string | null = null;

  if (typeof envelope?.["effort"] === "string") {
    rawEffort = envelope["effort"];
  } else if (typeof usageRow?.["effort"] === "string") {
    rawEffort = usageRow["effort"];
  }

  const convIdRaw =
    envelope?.["conversation_id"] ?? envelope?.["conversationId"];

  const convId =
    typeof convIdRaw === "string" && /^[A-Za-z0-9-]+$/u.test(convIdRaw)
      ? convIdRaw
      : null;

  let sqliteBlobs: readonly Uint8Array[] | null = null;
  const budget = context?.budget;

  const maxBytes =
    budget === undefined
      ? MAX_FILE_BYTES
      : Math.min(MAX_FILE_BYTES, budget.remaining);

  if (
    hasText(convId) &&
    maxBytes > 0 &&
    (hasText(context?.appDataDir) ||
      context?.readSqliteGenMetadata !== undefined)
  ) {
    const dbPath = hasText(context.appDataDir)
      ? path.join(context.appDataDir, "conversations", `${convId}.db`)
      : "";

    try {
      if (context.readSqliteGenMetadata !== undefined) {
        sqliteBlobs = context.readSqliteGenMetadata(
          hasText(dbPath) ? dbPath : convId
        );
      } else if (hasText(dbPath)) {
        sqliteBlobs = readAgySqliteGenMetadata(dbPath, { maxBytes });
      }
    } catch {
      // Unreadable generation metadata leaves the envelope as the only evidence.
    }

    if (budget !== undefined && sqliteBlobs !== null) {
      let blobBytes = 0;

      for (const blob of sqliteBlobs) {
        blobBytes += blob.byteLength;
      }

      budget.remaining = Math.max(0, budget.remaining - blobBytes);
    }
  }

  if (sqliteBlobs !== null && sqliteBlobs.length > 0) {
    const rows = sqliteBlobs.map(decodeAgyGenMetadata);
    const modelsList: string[] = [];

    for (const r of rows) {
      if (hasText(r.model) && !modelsList.includes(r.model)) {
        modelsList.push(r.model);
      }
    }

    if (modelsList.length > 0) {
      out.actualModels = modelsList.slice(0, 8);

      if (rows.every((r) => r.model !== null)) {
        const [onlyModel] = modelsList;

        if (modelsList.length === 1 && onlyModel !== undefined) {
          out.models = {
            [onlyModel]: {
              input: out.input,
              output: out.output,
              ...(out.cacheRead !== undefined && { cacheRead: out.cacheRead }),
              ...(out.reasoning !== undefined && { reasoning: out.reasoning }),
            },
          };
        } else {
          const perModel = emptyModelMap<DiagnosticModelUsage>();
          const sum: Counters = { input: 0, output: 0 };
          let canSum = true;

          for (const r of rows) {
            if (!hasText(r.model) || !hasTurnCounters(r)) {
              canSum = false;
              break;
            }

            const target = perModel[r.model] ?? { input: 0, output: 0 };
            perModel[r.model] = target;
            addCounters(target, r);
            addCounters(sum, r);
          }

          const matchesEnvelope =
            canSum &&
            sum.input === out.input &&
            sum.output === out.output &&
            (sum.cacheRead ?? 0) === (out.cacheRead ?? 0) &&
            (sum.reasoning ?? 0) === (out.reasoning ?? 0);

          if (matchesEnvelope) {
            out.models = perModel;
          }
        }
      }
    }

    const lastRow = rows.at(-1);

    const lastEffort =
      lastRow?.effort ?? (lastRow?.hasDisplayName === true ? null : undefined);

    if (lastEffort !== undefined) {
      out.actualEffort = lastEffort;
    }

    return out;
  }

  const envelopeModelsRaw = row(
    envelope?.["models"] ??
      envelope?.["model_usage"] ??
      envelope?.["modelUsage"] ??
      usageRow?.["models"]
  );

  if (envelopeModelsRaw && Object.keys(envelopeModelsRaw).length > 0) {
    const perModel = emptyModelMap<DiagnosticModelUsage>();
    const activeModels: string[] = [];
    const keyEfforts: string[] = [];

    for (const [mName, mVal] of Object.entries(envelopeModelsRaw)) {
      const mRow = row(mVal);

      if (!mRow) {
        continue;
      }

      const modelEffort = normalizeAgyModelEffort(mName);
      const normalizedName = modelEffort.model ?? mName.toLowerCase();

      const mCounters = counters(
        mRow,
        {
          input: "input_tokens",
          output: "output_tokens",
          cacheRead: "cache_read_tokens",
          reasoning: "thinking_tokens",
        },
        "agy.usage",
        "uncached"
      );

      if (mCounters) {
        if (
          modelEffort.effort !== null &&
          !keyEfforts.includes(modelEffort.effort)
        ) {
          keyEfforts.push(modelEffort.effort);
        }

        const entry = perModel[normalizedName] ?? { input: 0, output: 0 };
        perModel[normalizedName] = entry;
        addCounters(entry, mCounters);

        if (!activeModels.includes(normalizedName)) {
          activeModels.push(normalizedName);
        }
      }
    }

    if (activeModels.length > 0) {
      out.actualModels = activeModels;
      out.models = perModel;
      const norm = normalizeAgyModelEffort(rawModel, rawEffort);
      const [onlyEffort] = keyEfforts;

      let consensusKeyEffort: string | null | undefined;

      if (keyEfforts.length === 1) {
        consensusKeyEffort = onlyEffort;
      } else if (keyEfforts.length > 1) {
        consensusKeyEffort = null;
      }

      if (norm.effort !== null) {
        out.actualEffort = norm.effort;
      } else if (rawEffort !== null && rawEffort !== undefined) {
        out.actualEffort = null;
      } else if (consensusKeyEffort !== undefined) {
        out.actualEffort = consensusKeyEffort;
      } else if (hasText(rawModel)) {
        out.actualEffort = null;
      }

      out.provenance = AGY_ENVELOPE_USAGE;

      return out;
    }
  }

  if (hasText(rawModel) || hasText(rawEffort)) {
    const norm = normalizeAgyModelEffort(rawModel, rawEffort);

    if (hasText(norm.model)) {
      out.actualModels = [norm.model];
      out.models = {
        [norm.model]: {
          input: out.input,
          output: out.output,
          ...(out.cacheRead !== undefined && { cacheRead: out.cacheRead }),
          ...(out.reasoning !== undefined && { reasoning: out.reasoning }),
        },
      };
    }

    out.actualEffort = norm.effort;
    out.provenance = AGY_ENVELOPE_USAGE;
  }

  return out;
};
