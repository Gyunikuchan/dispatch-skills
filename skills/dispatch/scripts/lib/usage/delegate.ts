import type { DelegateResponse, DiagnosticModelUsage, DiagnosticUsage } from './rows.ts';
import { validSessionId } from '../session.ts';
import { USAGE_ADAPTERS } from './adapters.ts';
import { boundModels, foldRows, OTHER_KEY } from './bands.ts';
import { mergeCopilot } from './rows.ts';
import type { CopilotActor } from './rows.ts';
import { baseCounters } from './read.ts';
import { MAX_RESPONSE_AGENTS, usageKey } from './rows.ts';
import type { DelegateQuery, HostUsageQuery, HostUsageResult, UsageRow } from './rows.ts';

export type SessionRead = {
  usage?: DiagnosticUsage;
  complete: boolean;
  invalidCounters?: true;
  responses?: Array<DelegateResponse>;
};

const actors = new WeakMap<DelegateResponse, string>();

// Keep lineage out of serializable invocation rows.
export const delegateResponseActor = (response: DelegateResponse): string | undefined => actors.get(response);

function responseCounts(query: DelegateQuery, result: HostUsageResult, incomplete: boolean): Array<DelegateResponse> {
  if (!result.response || (query.resumed && result.rows.some((row) => row.wholeSecond))) {
    return [];
  }
  const { basis, limited } = result.response;
  const groups = new Map<
    string,
    {
      response: DelegateResponse;
      activeCount: number;
      toolCalls: number;
      toolTurns: number;
      allToolCalls: boolean;
      allToolTurns: boolean;
    }
  >();
  const named = new Set<string>();
  for (const row of result.rows) {
    if (row.role === 'host' || !baseCounters(row) || (!row.wholeSecond && row.atMs < query.startMs)) {
      continue;
    }
    const role = row.role;
    const identity = role === 'delegate' ? query.sessionId : row.responseActor;
    const actor = identity && (named.has(identity) || named.size < MAX_RESPONSE_AGENTS) ? identity : undefined;
    if (actor) {
      named.add(actor);
    }
    const key = JSON.stringify([role, actor]);
    let entry = groups.get(key);
    if (!entry) {
      const response: DelegateResponse = {
        role,
        basis,
        coverage: incomplete || limited || !actor ? 'partial' : 'complete',
        observed: 0,
        uncachedInput: 0,
      };
      if (actor) {
        actors.set(response, actor);
      }
      entry = { response, activeCount: 0, toolCalls: 0, toolTurns: 0, allToolCalls: true, allToolTurns: true };
      groups.set(key, entry);
    }
    const group = entry.response;
    if (!row.skipResponse) {
      entry.activeCount++;
      group.observed = (group.observed ?? 0) + 1;
      const input = (group.uncachedInput ?? Infinity) + row.input;
      if (Number.isSafeInteger(input)) {
        group.uncachedInput = input;
      } else {
        delete group.uncachedInput;
      }
      if (row.toolCalls !== undefined) {
        entry.toolCalls += row.toolCalls;
      } else {
        entry.allToolCalls = false;
      }
      if (row.toolTurns !== undefined) {
        entry.toolTurns += row.toolTurns;
      } else {
        entry.allToolTurns = false;
      }
    }
  }
  const out = [...groups.values()].map(
    ({ response, activeCount, toolCalls, toolTurns, allToolCalls, allToolTurns }) => {
      if (!incomplete && activeCount > 0) {
        if (allToolCalls) {
          response.toolCalls = toolCalls;
        }
        if (allToolTurns) {
          response.toolTurns = toolTurns;
        }
      }
      return response;
    },
  );
  if (incomplete) {
    if (!out.some((group) => group.role === 'delegate')) {
      out.push({ role: 'delegate', basis: 'unavailable', coverage: 'unknown' });
    }
    if (result.notes?.subagent && !out.some((group) => group.role === 'subagent')) {
      out.push({ role: 'subagent', basis: 'unavailable', coverage: 'unknown' });
    }
  }
  return out;
}

const ACTIVITY_KEYS = ['turns', 'toolCalls', 'toolTurns'] as const;

function activityTotals(
  rows: ReadonlyArray<UsageRow>,
  fallback?: Partial<Pick<UsageRow, (typeof ACTIVITY_KEYS)[number]>>,
) {
  const totals: Partial<Pick<UsageRow, (typeof ACTIVITY_KEYS)[number]>> = {};
  for (const key of ACTIVITY_KEYS) {
    if (rows.length && rows.every((row) => row[key] !== undefined)) {
      totals[key] = rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
    } else if (!rows.length && fallback?.[key] !== undefined) {
      totals[key] = 0;
    }
  }
  return totals;
}

/** Reads one delegate launch's own session data in its launch window and folds rows into banded counters. */
export function readDelegateSession(query: DelegateQuery): SessionRead {
  if (!validSessionId(query.sessionId)) {
    return { complete: false };
  }
  if (!Number.isFinite(query.startMs) || !Number.isFinite(query.endMs)) {
    return { complete: false };
  }

  const startMs =
    query.platform === 'copilot' || query.resumed ? query.startMs : Math.floor(query.startMs / 1000) * 1000;
  const hostQuery: HostUsageQuery = {
    ...(query.collectResponses && { collectResponses: true }),
    sessionId: query.sessionId,
    startMs,
    endMs: query.endMs,
    home: query.home,
    env: query.env,
    stages: [{ stage: 'implementation', atMs: 0 }],
    budget: query.budget,
  };

  let result: HostUsageResult;
  try {
    result = USAGE_ADAPTERS[query.platform].read(hostQuery, query.fs, query);
  } catch {
    return { complete: false };
  }

  const hasNotes = Boolean(
    result.notes && Object.values(result.notes).some((roleNotes) => roleNotes && Object.keys(roleNotes).length > 0),
  );
  const rows = result.rows;
  // Descendant-only rows can still supply usage when the root has no accepted records.
  const incomplete =
    hasNotes ||
    (result.unavailable && result.unavailable !== 'no usage records') ||
    rows.length === 0 ||
    (query.resumed && rows.some((r) => r.wholeSecond));
  const invalidCounters = !incomplete && rows.some((r) => !baseCounters(r));
  const counts = responseCounts(query, result, Boolean(incomplete || result.unavailable || invalidCounters));
  const evidence = counts.length ? { responses: counts } : {};
  if (incomplete && (query.platform !== 'copilot' || !rows.length)) {
    return { complete: false, ...evidence };
  }
  if (invalidCounters) {
    return { complete: false, invalidCounters: true, ...evidence };
  }

  const folded = foldRows(rows);
  if (!baseCounters(folded.total)) {
    return { complete: false, invalidCounters: true, ...evidence };
  }
  const actualModels: Array<string> = [];
  for (const r of rows) {
    if (r.model && !actualModels.includes(r.model)) {
      actualModels.push(r.model);
    }
  }
  const efforts = new Set(rows.map((r) => r.effort));
  const [onlyEffort] = efforts;
  const actualEffort = efforts.size === 1 ? (onlyEffort ?? null) : null;

  const models: Record<string, DiagnosticModelUsage> = boundModels(folded.models);
  const activeDelegateRows = rows.filter((r) => r.role === 'delegate' && !r.skipResponse);
  const activity = activityTotals(activeDelegateRows);
  if (activeDelegateRows.length) {
    const delegateByModel = new Map<string, typeof activeDelegateRows>();
    for (const r of activeDelegateRows) {
      const rawKey = usageKey(r.model, r.effort);
      const key = Object.hasOwn(models, rawKey) ? rawKey : OTHER_KEY;
      const list = delegateByModel.get(key) ?? [];
      list.push(r);
      delegateByModel.set(key, list);
    }
    for (const [key, model] of Object.entries(models)) {
      Object.assign(model, activityTotals(delegateByModel.get(key) ?? [], activity));
    }
  }

  const copilot = query.platform === 'copilot' ? mergeCopilot(rows.map((r) => r.copilot)) : undefined;

  return {
    complete: !incomplete,
    ...evidence,
    usage: {
      ...folded.total,
      ...activity,
      scope: 'invocation',
      provenance: 'session',
      inputSemantics: 'uncached',
      models,
      ...(actualModels.length > 0 && { actualModels: actualModels.slice(0, 8) }),
      actualEffort,
      ...(copilot && { copilot, actors: copilotActors(rows, models) }),
      ...(!(folded.reasoningInOutput === undefined) && { reasoningInOutput: folded.reasoningInOutput }),
    },
  };
}

function copilotActors(
  rows: HostUsageResult['rows'],
  models: Record<string, DiagnosticModelUsage>,
): Array<CopilotActor> {
  const aliases = new Map<string, string>();
  for (const r of rows) {
    if (r.responseActor && !aliases.has(r.responseActor) && aliases.size < MAX_RESPONSE_AGENTS) {
      aliases.set(r.responseActor, `actor-${aliases.size + 1}`);
    }
  }
  const groups = new Map<string, typeof rows>();
  for (const original of rows) {
    const r = Object.hasOwn(models, usageKey(original.model, original.effort))
      ? original
      : { ...original, model: OTHER_KEY, effort: null };
    const agent = aliases.get(r.responseActor ?? '');
    const key = JSON.stringify([r.role, agent, r.model, r.effort]);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const [r] = group;
    const copilot = mergeCopilot(group.map((r) => r.copilot));
    if (!r || !copilot) {
      return [];
    }
    const agent = aliases.get(r.responseActor ?? '');
    const parent = aliases.get(r.parentActor ?? '');
    if (!agent) {
      copilot.actorCoverage = 'partial';
      copilot.lineageCoverage = 'unknown';
    }
    const folded = foldRows(group);
    const total = folded.total;
    const bands = folded.models[usageKey(r.model, r.effort)]?.bands;
    return {
      ...total,
      ...(bands && { bands }),
      turns: group.length,
      role: r.role,
      model: r.model,
      effort: r.effort,
      ...(agent && { agent }),
      ...(agent && parent && { parent }),
      ...(agent && r.depth !== undefined && { depth: r.depth }),
      copilot,
    };
  });
}
