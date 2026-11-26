import fs from "node:fs";
import zlib from "node:zlib";

import { nodeErrorCode } from "../fs-ext.ts";
import { readOpencodeMessages } from "../opencode-db.ts";
import type { ProviderKey } from "../platform.ts";
import { validSessionId } from "../session.ts";
import { USAGE_ADAPTERS } from "./adapters.ts";
import { readAgySqliteGenMetadata } from "./agy.ts";
import { boundModels, foldRows, OTHER_KEY } from "./bands.ts";
import { MAX_TOTAL_BYTES, phaseAt, readErrorReason } from "./read.ts";
import {
  mergeCopilot,
  HOST_ROLES,
  MAX_RESPONSE_AGENTS,
  splitUsageKey,
  STAGE_ORDER,
  usageKey,
} from "./rows.ts";
import type {
  BandedCounters,
  HostResponseAggregate,
  HostRole,
  HostStage,
  HostUsageAdapter,
  HostUsageFacts,
  HostUsageFs,
  HostUsageRow,
  HostUsageResult,
  Milestone,
  PhaseMilestone,
  UsageRow,
} from "./rows.ts";

const hostRoleOf = (role: UsageRow["role"]) =>
  role === "subagent" ? "subagent" : "host";

const hasText = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

// oxlint-disable-next-line eslint/complexity -- host row folding mirrors every role/phase/coverage combination; refactor deferred.
const foldHostRows = (
  rows: readonly (UsageRow & { stage: HostStage })[],
  phases: readonly PhaseMilestone[],
  hostComplete: boolean,
  subagentComplete: boolean
) => {
  const aliases = new Map<string, string>();
  const serial = { host: 0, subagent: 0 };

  for (const r of rows) {
    if (
      r.copilot &&
      hasText(r.responseActor) &&
      !aliases.has(r.responseActor) &&
      aliases.size < MAX_RESPONSE_AGENTS
    ) {
      const serialKey = hostRoleOf(r.role);
      serial[serialKey] += 1;
      aliases.set(r.responseActor, `${r.role}-${serial[serialKey]}`);
    }
  }

  const groups = new Map<
    string,
    {
      stage: HostStage;
      phase: string | undefined;
      role: HostRole;
      rows: UsageRow[];
      agent?: string;
    }
  >();

  for (const r of rows) {
    const phase = phaseAt(phases, r.atMs);
    const role = hostRoleOf(r.role);
    const agent = r.copilot ? aliases.get(r.responseActor ?? "") : undefined;
    const gKey = `${r.stage}\0${phase ?? ""}\0${role}\0${agent ?? ""}`;

    const group = groups.get(gKey) ?? {
      stage: r.stage,
      phase,
      role,
      rows: [],
      ...(agent !== undefined && { agent }),
    };

    group.rows.push(r);
    groups.set(gKey, group);
  }

  const out: HostUsageRow[] = [];

  for (const group of groups.values()) {
    const byKey = new Map<string, UsageRow[]>();

    for (const r of group.rows) {
      const k = usageKey(r.model, r.effort);
      const list = byKey.get(k) ?? [];
      list.push(r);
      byKey.set(k, list);
    }

    const perKey: Record<
      string,
      BandedCounters & { reasoningInOutput?: boolean }
    > = {};

    for (const [k, list] of byKey) {
      const folded = foldRows(list);
      const entry = folded.models[k];

      if (!entry) {
        continue;
      }

      perKey[k] = {
        ...entry,
        ...(!(folded.reasoningInOutput === undefined) && {
          reasoningInOutput: folded.reasoningInOutput,
        }),
      };
    }

    const bounded = boundModels(perKey);

    const roleComplete =
      group.role === "host" ? hostComplete : subagentComplete;

    for (const [k, value] of Object.entries(bounded)) {
      const { model, effort } = splitUsageKey(k);
      // SAFETY: `bounded` is produced by foldRows, which builds only BandedCounters values.
      const typed = value as BandedCounters & { reasoningInOutput?: boolean };

      const inputs =
        k === OTHER_KEY
          ? [...byKey].flatMap(([key, list]) =>
              key === OTHER_KEY || !Object.hasOwn(bounded, key) ? list : []
            )
          : (byKey.get(k) ?? []);

      const active = inputs.filter((r) => !r.skipResponse);

      const turns =
        roleComplete && active.every((r) => r.turns !== undefined)
          ? active.reduce((total, r) => total + (r.turns ?? 0), 0)
          : undefined;

      const toolCalls =
        roleComplete &&
        active.length > 0 &&
        active.every((r) => r.toolCalls !== undefined)
          ? active.reduce((total, r) => total + (r.toolCalls ?? 0), 0)
          : undefined;

      const toolTurns =
        roleComplete &&
        active.length > 0 &&
        active.every((r) => r.toolTurns !== undefined)
          ? active.reduce((total, r) => total + (r.toolTurns ?? 0), 0)
          : undefined;

      const precise =
        inputs.every((r) => r.depth !== undefined) &&
        (!inputs.some((r) => r.copilot) || group.agent !== undefined);

      let maxDepth: number | undefined;

      if (
        (roleComplete || inputs.every((r) => r.copilot)) &&
        precise &&
        group.role === "subagent"
      ) {
        maxDepth = 0;

        for (const input of inputs) {
          maxDepth = Math.max(maxDepth, input.depth ?? 0);
        }
      }

      const copilot = mergeCopilot(inputs.map((r) => r.copilot));

      if (copilot !== undefined && group.agent === undefined) {
        copilot.actorCoverage = "partial";
        copilot.lineageCoverage = "unknown";
      }

      const parents = new Set(
        inputs.map((r) =>
          hasText(r.parentActor) ? aliases.get(r.parentActor) : undefined
        )
      );

      const parent = parents.size === 1 ? [...parents][0] : undefined;

      const row: HostUsageRow = {
        ...(!(turns === undefined) && { turns }),
        ...(!(toolCalls === undefined) && { toolCalls }),
        ...(!(toolTurns === undefined) && { toolTurns }),
        ...(!(maxDepth === undefined) && { maxDepth }),
        stage: group.stage,
        ...(group.agent !== undefined && { agent: group.agent }),
        ...(parent !== undefined && group.agent !== undefined && { parent }),
        ...(copilot !== undefined && { copilot }),
        ...(!(group.phase === undefined) && { phase: group.phase }),
        role: group.role,
        model,
        effort: hasText(effort) ? effort : null,
        input: typed.input,
        output: typed.output,
        ...(typed.cacheRead !== undefined && { cacheRead: typed.cacheRead }),
        ...(typed.cacheWrite !== undefined && { cacheWrite: typed.cacheWrite }),
        ...(typed.cacheWrite5m !== undefined && {
          cacheWrite5m: typed.cacheWrite5m,
        }),
        ...(typed.cacheWrite1h !== undefined && {
          cacheWrite1h: typed.cacheWrite1h,
        }),
        ...(typed.reasoning !== undefined && { reasoning: typed.reasoning }),
        ...(typed.bands !== undefined && { bands: typed.bands }),
        ...(typed.reasoningInOutput !== undefined && {
          reasoningInOutput: typed.reasoningInOutput,
        }),
      };

      out.push(row);
    }
  }

  return out.toSorted(
    (a, b) =>
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
      (a.phase ?? "").localeCompare(b.phase ?? "") ||
      HOST_ROLES.indexOf(a.role) - HOST_ROLES.indexOf(b.role) ||
      usageKey(a.model, a.effort).localeCompare(usageKey(b.model, b.effort))
  );
};

// oxlint-disable-next-line eslint/complexity -- response grouping enumerates every agent/tool-coverage combination; refactor deferred.
const foldHostResponses = (
  result: HostUsageResult,
  stages: readonly Milestone[]
): HostResponseAggregate[] | undefined => {
  const source = result.response;

  if (source === undefined) {
    return undefined;
  }

  let firstMilestone = Infinity;

  for (const stage of stages) {
    firstMilestone = Math.min(firstMilestone, stage.atMs);
  }

  const aliases = new Map<string, string>();
  const serial = { host: 0, subagent: 0 };
  const hasHostNotes = Object.keys(result.notes?.host ?? {}).length > 0;

  const groups = new Map<
    string,
    {
      aggregate: HostResponseAggregate;
      toolCalls: number;
      toolTurns: number;
      allToolCalls: boolean;
      allToolTurns: boolean;
    }
  >();

  for (const row of result.rows) {
    if (row.role === "delegate" || row.skipResponse) {
      continue;
    }

    const { role } = row;
    const stage = row.atMs >= firstMilestone ? row.stage : "unattributed";

    const actor =
      row.responseActor === undefined
        ? undefined
        : `${role}\0${row.responseActor}`;

    if (
      actor !== undefined &&
      !aliases.has(actor) &&
      aliases.size < MAX_RESPONSE_AGENTS
    ) {
      serial[role] += 1;
      aliases.set(actor, `${role}-${serial[role]}`);
    }

    const agent = actor === undefined ? undefined : aliases.get(actor);
    const key = `${stage}\0${role}\0${agent ?? ""}`;

    const coverage =
      source.limited === true ||
      hasText(result.unavailable) ||
      result.notes?.[role] !== undefined ||
      agent === undefined
        ? "partial"
        : "complete";

    let entry = groups.get(key);

    if (!entry) {
      entry = {
        aggregate: {
          stage,
          role,
          basis: source.basis,
          coverage,
          observed: 0,
          uncachedInput: 0,
          ...(!(agent === undefined) && { agent }),
        },
        toolCalls: 0,
        toolTurns: 0,
        allToolCalls: true,
        allToolTurns: true,
      };
      groups.set(key, entry);
    }

    const group = entry.aggregate;
    group.observed = (group.observed ?? 0) + 1;
    const input = (group.uncachedInput ?? Number.NaN) + row.input;

    if (Number.isSafeInteger(input)) {
      group.uncachedInput = input;
    } else {
      delete group.uncachedInput;
    }

    if (row.toolCalls === undefined) {
      entry.allToolCalls = false;
    } else {
      entry.toolCalls += row.toolCalls;
    }

    if (row.toolTurns === undefined) {
      entry.allToolTurns = false;
    } else {
      entry.toolTurns += row.toolTurns;
    }
  }

  const aggregates = [...groups.values()].map(
    ({ aggregate, toolCalls, toolTurns, allToolCalls, allToolTurns }) => {
      if (aggregate.coverage === "complete" && !hasHostNotes) {
        if (allToolCalls) {
          aggregate.toolCalls = toolCalls;
        }

        if (allToolTurns) {
          aggregate.toolTurns = toolTurns;
        }
      }

      return aggregate;
    }
  );

  for (const role of HOST_ROLES) {
    const incomplete =
      result.notes?.[role] !== undefined ||
      (role === "host"
        ? hasText(result.unavailable)
        : result.notes?.host?.["read budget reached"] !== undefined);

    if (incomplete && !aggregates.some((group) => group.role === role)) {
      aggregates.push({
        stage: "unattributed",
        role,
        basis: source.basis,
        coverage: "unknown",
      });
    }
  }

  return aggregates;
};

export const hostSessionId = (
  platform: ProviderKey | null,
  env: (name: string) => string | undefined
) => {
  const adapter = platform ? USAGE_ADAPTERS[platform] : undefined;
  const sessionId = adapter?.sessionEnv.map(env).find(Boolean);

  return hasText(sessionId) && validSessionId(sessionId) !== null
    ? sessionId
    : undefined;
};

interface HostUsageInput {
  startMs: number;
  endMs: number;
  home: string;
  env: (name: string) => string | undefined;
  stages: readonly Milestone[];
  phases?: readonly PhaseMilestone[];
}

/* oxlint-disable eslint/complexity -- host usage completeness folds every adapter note and response signal; refactor deferred. */
export const readHostUsage: (
  platform: ProviderKey | null,
  input: HostUsageInput,
  fsPort: HostUsageFs,
  adapters?: Partial<Record<ProviderKey, HostUsageAdapter>>
) => HostUsageFacts = (platform, input, fsPort, adapters = USAGE_ADAPTERS) => {
  const adapter = platform ? adapters[platform] : undefined;

  if (!adapter) {
    return { platform, rows: [], unavailable: "no adapter" };
  }

  const sessionId = adapter.sessionEnv.map(input.env).find(Boolean);

  if (!hasText(sessionId)) {
    return { platform, rows: [], unavailable: "no host id" };
  }

  if (validSessionId(sessionId) === null) {
    return { platform, rows: [], unavailable: "invalid host id" };
  }

  if (!Number.isFinite(input.startMs)) {
    return { platform, rows: [], unavailable: "invalid session start" };
  }

  try {
    const res = adapter.read(
      {
        ...input,
        sessionId,
        collectResponses: true,
        budget: { remaining: MAX_TOTAL_BYTES },
      },
      fsPort
    );

    const { unavailable, notes } = res;

    const hostComplete =
      unavailable === undefined && Object.keys(notes?.host ?? {}).length === 0;

    const subagentComplete =
      hostComplete && Object.keys(notes?.subagent ?? {}).length === 0;

    const subagentRows = res.rows.filter((r) => r.role === "subagent");

    const subagentActorsComplete =
      subagentComplete &&
      subagentRows.every((r) => r.responseActor !== undefined);

    const subagentCount = subagentActorsComplete
      ? new Set(subagentRows.map((r) => r.responseActor)).size
      : undefined;

    let maxSubagentDepth: number | undefined;

    if (
      subagentActorsComplete &&
      subagentRows.every((r) => r.depth !== undefined)
    ) {
      maxSubagentDepth = 0;

      for (const row of subagentRows) {
        maxSubagentDepth = Math.max(maxSubagentDepth, row.depth ?? 0);
      }
    }

    const responses = foldHostResponses(res, input.stages);

    return {
      platform,
      rows: foldHostRows(
        res.rows,
        input.phases ?? [],
        hostComplete,
        subagentComplete
      ),
      ...(hostComplete &&
        res.userTurns !== undefined && { userTurns: res.userTurns }),
      ...(hostComplete &&
        res.userTurns !== undefined &&
        res.userTurnsByStage !== undefined && {
          userTurnsByStage: res.userTurnsByStage,
        }),
      ...(!(subagentCount === undefined) && { subagentCount }),
      ...(!(maxSubagentDepth === undefined) && { maxSubagentDepth }),
      ...(!(unavailable === undefined) && { unavailable }),
      ...(!(notes === undefined) && { notes }),
      ...(!(responses === undefined) && { responses }),
    };
  } catch (error) {
    return { platform, rows: [], unavailable: readErrorReason(error) };
  }
};
/* oxlint-enable eslint/complexity */

export const nodeHostUsageFs: HostUsageFs = {
  list(dir) {
    try {
      return fs.readdirSync(dir);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(nodeErrorCode(error) ?? "")) {
        return [];
      }

      throw error;
    }
  },
  stat(file) {
    try {
      const s = fs.statSync(file);

      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(nodeErrorCode(error) ?? "")) {
        return null;
      }

      throw error;
    }
  },
  read(file, maxBytes) {
    const fd = fs.openSync(file, "r");

    try {
      const chunks: Buffer[] = [];
      let total = 0;

      while (total < maxBytes) {
        const data = Buffer.allocUnsafe(
          Math.min(1024 * 1024, maxBytes - total)
        );

        const count = fs.readSync(fd, data, 0, data.length, null);

        if (!count) {
          break;
        }

        chunks.push(data.subarray(0, count));
        total += count;
      }

      return Buffer.concat(chunks, total);
    } finally {
      fs.closeSync(fd);
    }
  },
  decompress:
    typeof zlib.zstdDecompressSync === "function"
      ? (data, maxBytes) =>
          zlib.zstdDecompressSync(data, { maxOutputLength: maxBytes })
      : null,
  sqliteGenMetadata: (file) =>
    readAgySqliteGenMetadata(file, { throwOnError: true }),
  opencodeMessages: readOpencodeMessages,
};
