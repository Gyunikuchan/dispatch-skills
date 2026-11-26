import path from "node:path";

import { validSessionId } from "../session.ts";
import {
  count,
  note,
  readErrorReason,
  readTranscript,
  row,
  stageAt,
} from "./read.ts";
import type { Row } from "./read.ts";
import type {
  CopilotEvidence,
  HostNotes,
  HostRole,
  HostUsageAdapter,
  HostUsageFs,
  HostUsageQuery,
  HostUsageResult,
  UsageRow,
} from "./rows.ts";

const hasText = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

const responseActorFor = (
  actor: string | null | undefined,
  actorSupplied: boolean,
  sessionId: string
) => {
  if (hasText(actor)) {
    return { responseActor: actor };
  }

  if (actorSupplied) {
    return {};
  }

  return { responseActor: sessionId };
};

/* oxlint-disable eslint/complexity -- Copilot JSONL folding mirrors the on-disk event schema; refactor deferred to avoid behavior drift. */
export const collectCopilotUsage: (
  query: HostUsageQuery,
  fs: HostUsageFs,
  options?: { rootRole?: "host" | "delegate" }
) => HostUsageResult = (query, fs, options = {}) => {
  if (validSessionId(query.sessionId) === null) {
    return { rows: [], unavailable: "invalid host id" };
  }

  const file = path.join(
    query.home,
    ".copilot",
    "session-state",
    query.sessionId,
    "events.jsonl"
  );

  const notes: HostNotes = {};
  let text: string | undefined;

  try {
    if (!fs.stat(file)) {
      return { rows: [], unavailable: "host id file missing" };
    }

    const { text: readText, stop } = readTranscript(fs, file, query.budget);

    if (stop !== undefined) {
      return stop === "budget"
        ? { rows: [], notes: { host: { "read budget reached": 1 } } }
        : { rows: [], unavailable: "transcript over size cap" };
    }

    text = readText;
  } catch (error) {
    return { rows: [], unavailable: readErrorReason(error) };
  }

  const receipts = new Map<string, Receipt>();
  const sourceUsageIds = new Map<string, string>();
  const sourceSequences = new Map<string, string>();
  const links = new Map<string, Link>();
  const conflicting = new Set<string>();
  const rootRole = options.rootRole ?? "host";

  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) {
      continue;
    }

    // Parse only telemetry/lifecycle lines; conversation fields never become retained facts.
    if (
      !/"(?:session\.usage_record|assistant\.usage|subagent\.started)"/u.test(
        line
      )
    ) {
      if (
        !/"type"\s*:\s*"[^"]+"/u.test(line) ||
        /"type"\s*:\s*"[^"]*usage[^"]*"/u.test(line)
      ) {
        note(notes, "host", "unparsed lines");
      }

      continue;
    }

    let event: Row | null;

    try {
      event = row(JSON.parse(line));
    } catch {
      note(notes, "host", "unparsed lines");
      continue;
    }

    if (!event) {
      continue;
    }

    const data = row(event["data"]);

    if (event["type"] === "subagent.started" && data) {
      const actor = identity(event["agentId"]);

      if (!hasText(actor)) {
        note(notes, "subagent", "unverified candidates");
        continue;
      }

      const parent = identity(data["parentId"]);

      if (data["parentId"] !== undefined && !hasText(parent)) {
        conflicting.add(actor);
        note(notes, "subagent", "unverified candidates");
        continue;
      }

      const link: Link = hasText(parent) ? { parent } : {};

      if (
        links.has(actor) &&
        JSON.stringify(links.get(actor)) !== JSON.stringify(link)
      ) {
        conflicting.add(actor);
      }

      links.set(actor, link);
      continue;
    }

    if (!data) {
      note(notes, "host", "unparsed lines");
      continue;
    }

    let raw: ReturnType<typeof row>;

    if (event["type"] === "session.usage_record") {
      raw = row(data["usage"]);
    } else if (event["type"] === "assistant.usage") {
      raw = data;
    } else {
      raw = null;
    }

    if (!raw) {
      note(notes, "host", "unparsed lines");
      continue;
    }

    const accounting = row(raw["accounting"]);

    const source = identity(accounting?.["sourceSessionId"]);
    const id = receiptId(accounting?.["usageId"]);
    const sequence = accounting?.["sequence"];

    const atMs =
      typeof event["timestamp"] === "string"
        ? Date.parse(event["timestamp"])
        : Number.NaN;

    if (
      !hasText(source) ||
      !hasText(id) ||
      !count(sequence) ||
      !Number.isFinite(atMs)
    ) {
      note(notes, "host", "unparsed lines");
      continue;
    }

    // Whitelist the sampled persisted receipt and supported live counters.
    const usage = Object.fromEntries(
      [
        "model",
        "reasoningEffort",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "reasoningTokens",
        "cost",
        "aiCreditsStatus",
      ].map((k) => [k, raw[k]])
    );

    usage["copilotUsage"] = {
      totalNanoAiu: row(raw["copilotUsage"])?.["totalNanoAiu"],
    };
    const actorSupplied = Object.hasOwn(event, "agentId");
    const actor = identity(event["agentId"]);
    const signature = JSON.stringify([actor ?? null, actorSupplied, usage]);
    const key = JSON.stringify([source, sequence, id]);
    const prior = receipts.get(key);

    // Receipt identity precedes window filtering, including later-timestamp replays.
    if (prior) {
      if (prior.signature === signature) {
        prior.atMs = Math.min(prior.atMs, atMs);
      } else {
        prior.conflict = true;
      }
    } else {
      const receipt: Receipt = {
        atMs,
        ...(hasText(actor) && { actor }),
        actorSupplied,
        usage,
        signature,
      };

      const usageIdentity = JSON.stringify([source, id]);
      const sequenceIdentity = JSON.stringify([source, sequence]);

      const conflicts = new Set(
        [
          sourceUsageIds.get(usageIdentity),
          sourceSequences.get(sequenceIdentity),
        ].filter((value): value is string => value !== undefined)
      );

      for (const conflictKey of conflicts) {
        const conflict = receipts.get(conflictKey);

        if (conflict) {
          conflict.conflict = true;
        }

        receipt.conflict = true;
      }

      if (!sourceUsageIds.has(usageIdentity)) {
        sourceUsageIds.set(usageIdentity, key);
      }

      if (!sourceSequences.has(sequenceIdentity)) {
        sourceSequences.set(sequenceIdentity, key);
      }

      receipts.set(key, receipt);
    }
  }

  interface Lineage {
    depth?: number;
    parent?: string;
  }

  const lineageCache = new Map<string, Lineage>([
    [query.sessionId, { depth: 0 }],
  ]);

  const lineage = (actor: string) => {
    const trail: { actor: string; parent: string }[] = [];
    const seen = new Set<string>();

    let current = actor;
    let result: Lineage = {};

    while (true) {
      const cached = lineageCache.get(current);

      if (cached) {
        result = cached;
        break;
      }

      const link = links.get(current);

      if (seen.has(current) || conflicting.has(current) || !link) {
        break;
      }

      seen.add(current);

      if (!hasText(link.parent)) {
        result = { depth: 1, parent: query.sessionId };
        break;
      }

      const { parent } = link;
      trail.push({ actor: current, parent });
      current = parent;
    }

    lineageCache.set(current, result);

    for (const step of trail.toReversed()) {
      result =
        result.depth === undefined
          ? {}
          : { depth: result.depth + 1, parent: step.parent };
      lineageCache.set(step.actor, result);
    }

    return result;
  };

  const rows: HostUsageResult["rows"] = [];
  const tokenLimited = new Set<HostRole>();

  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };

  for (const receipt of receipts.values()) {
    if (receipt.atMs < query.startMs || receipt.atMs > query.endMs) {
      continue;
    }

    const { actor } = receipt;

    const role =
      !receipt.actorSupplied || actor === query.sessionId
        ? rootRole
        : "subagent";

    const noteRole: HostRole = role === "delegate" ? "host" : role;

    if (receipt.conflict) {
      note(notes, noteRole, "unverified candidates");
      tokenLimited.add(noteRole);
      continue;
    }

    const u = receipt.usage;

    const input = u["inputTokens"];
    const output = u["outputTokens"];

    const read = u["cacheReadTokens"] ?? 0;
    const write = u["cacheWriteTokens"] ?? 0;
    const reasoning = u["reasoningTokens"] ?? 0;

    if (
      !count(input) ||
      !count(output) ||
      !count(read) ||
      !count(write) ||
      !count(reasoning) ||
      !Number.isSafeInteger(read + write) ||
      read + write > input ||
      reasoning > output
    ) {
      note(notes, noteRole, "unparsed lines");
      continue;
    }

    const counters = {
      input: input - read - write,
      output,
      ...(!(u["cacheReadTokens"] === undefined) && { cacheRead: read }),
      ...(!(u["cacheWriteTokens"] === undefined) && { cacheWrite: write }),
      ...(!(u["reasoningTokens"] === undefined) && { reasoning }),
    };

    if (
      TOTAL_KEYS.some(
        (k) => !Number.isSafeInteger(totals[k] + (counters[k] ?? 0))
      ) ||
      !Number.isSafeInteger(input + output) ||
      !Number.isSafeInteger(
        totals.input +
          totals.cacheRead +
          totals.cacheWrite +
          totals.output +
          input +
          output
      )
    ) {
      note(notes, noteRole, "unparsed lines");
      continue;
    }

    for (const k of TOTAL_KEYS) {
      totals[k] += counters[k] ?? 0;
    }

    let graph: ReturnType<typeof lineage>;

    if (role === "subagent") {
      graph = hasText(actor) ? lineage(actor) : {};
    } else {
      graph = { depth: 0 };
    }

    if (graph.depth === undefined) {
      note(notes, "subagent", "unverified candidates");
    }

    const nano = row(u["copilotUsage"])?.["totalNanoAiu"];
    const status = configuration(u["aiCreditsStatus"]);
    const multiplier = u["cost"];

    const validMultiplier =
      typeof multiplier === "number" &&
      Number.isFinite(multiplier) &&
      multiplier >= 0;

    const measured = count(nano);

    const billingCoverage = () => {
      if (measured && status === "complete" && validMultiplier) {
        return "complete";
      }

      if (measured) {
        return "partial";
      }

      return "unknown";
    };

    const billing: CopilotEvidence["billing"] = {
      coverage: billingCoverage(),
      ...(measured && { totalNanoAiu: nano }),
      ...(status !== undefined && status !== "" && { statuses: [status] }),
      ...(validMultiplier && { multipliers: [multiplier] }),
    };

    const model = configuration(u["model"]) ?? "";
    const effort = configuration(u["reasoningEffort"]) ?? null;

    const r: UsageRow & { stage: ReturnType<typeof stageAt> } = {
      ...counters,
      role,
      ...graph,
      atMs: receipt.atMs,
      model,
      effort,
      reasoningInOutput: true,
      turns: 1,
      ...responseActorFor(actor, receipt.actorSupplied, query.sessionId),
      ...(hasText(graph.parent) && { parentActor: graph.parent }),
      copilot: {
        tokenCoverage: model === "" ? "partial" : "complete",
        lineageCoverage: graph.depth === undefined ? "unknown" : "complete",
        actorCoverage:
          receipt.actorSupplied && !hasText(actor) ? "unknown" : "complete",
        billing,
      },
      stage: stageAt(query.stages, receipt.atMs),
    };

    rows.push(r);
  }

  for (const r of rows) {
    if (
      r.copilot &&
      (notes[r.role === "subagent" ? "subagent" : "host"]?.[
        "unparsed lines"
      ] !== undefined ||
        tokenLimited.has(r.role === "subagent" ? "subagent" : "host"))
    ) {
      r.copilot.tokenCoverage = "partial";

      if (r.copilot.billing.coverage === "complete") {
        r.copilot.billing.coverage = "partial";
      }
    }
  }

  return {
    rows,
    ...(query.collectResponses && {
      response: { basis: "copilot-usage-record" as const },
    }),
    ...(!rows.length && { unavailable: "no usage records" as const }),
    ...(Object.keys(notes).length && { notes }),
  };
};
/* oxlint-enable eslint/complexity */

interface Link {
  parent?: string;
}

interface Receipt {
  atMs: number;
  actor?: string;
  actorSupplied: boolean;
  usage: Row;
  signature: string;
  conflict?: true;
}

const identity = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,256}$/u.test(v) ? v : undefined;

const receiptId = (v: unknown) =>
  typeof v === "string" &&
  v.length > 0 &&
  Buffer.byteLength(v) <= 1024 &&
  /^[\u0021-\u007E]+$/u.test(v)
    ? v
    : undefined;

const configuration = (v: unknown) =>
  typeof v === "string" && v.length <= 256 && !/[\s`|<>]/u.test(v)
    ? v
    : undefined;

const TOTAL_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
] as const;

export const copilot: HostUsageAdapter = {
  sessionEnv: ["COPILOT_AGENT_SESSION_ID", "COPILOT_CLI_SESSION_ID"],
  read: (query, fs, delegate) =>
    collectCopilotUsage(
      query,
      fs,
      delegate ? { rootRole: "delegate" } : undefined
    ),
};
