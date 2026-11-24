import type { DelegateResponse, DiagnosticModelUsage, DiagnosticUsage } from '../../toolkit/types.ts';
import { validSessionId } from '../session.ts';
import { collectAgyUsage } from './agy.ts';
import { boundModels, foldRows, OTHER_KEY } from './bands.ts';
import { collectClaudeUsage } from './claude.ts';
import { collectCodexUsage } from './codex.ts';
import { collectCopilotUsage } from './copilot.ts';
import { mergeCopilot, type CopilotActor } from './rows.ts';
import { collectOpencodeUsage } from './opencode.ts';
import { baseCounters } from './read.ts';
import { MAX_RESPONSE_AGENTS, usageKey, type DelegateQuery, type HostUsageQuery, type HostUsageResult } from './rows.ts';

export type SessionRead = { usage?: DiagnosticUsage; complete: boolean; invalidCounters?: true; responses?: DelegateResponse[] };

const actors = new WeakMap<DelegateResponse, string>();

// Keep lineage out of serializable invocation rows.
export const delegateResponseActor = (response: DelegateResponse): string | undefined => actors.get(response);

function responseCounts(query: DelegateQuery, result: HostUsageResult, incomplete: boolean): DelegateResponse[] {
  if (!result.response || (query.resumed && result.rows.some(row => row.wholeSecond))) return [];
  const { basis, limited } = result.response;
  const groups = new Map<string, { response: DelegateResponse; activeCount: number; toolCalls: number; toolTurns: number; allToolCalls: boolean; allToolTurns: boolean }>();
  const named = new Set<string>();
  for (const row of result.rows) {
    if (row.role === 'host' || !baseCounters(row) || (!row.wholeSecond && row.atMs < query.startMs)) continue;
    const role = row.role;
    const identity = role === 'delegate' ? query.sessionId : row.responseActor;
    const actor = identity && (named.has(identity) || named.size < MAX_RESPONSE_AGENTS) ? identity : undefined;
    if (actor) named.add(actor);
    const key = JSON.stringify([role, actor]);
    let entry = groups.get(key);
    if (!entry) {
      const response: DelegateResponse = { role, basis, coverage: incomplete || limited || !actor ? 'partial' : 'complete', observed: 0, uncachedInput: 0 };
      if (actor) actors.set(response, actor);
      entry = { response, activeCount: 0, toolCalls: 0, toolTurns: 0, allToolCalls: true, allToolTurns: true };
      groups.set(key, entry);
    }
    const group = entry.response;
    if (!row.skipResponse) {
      entry.activeCount++;
      group.observed! += 1;
      const input = (group.uncachedInput ?? Infinity) + row.input;
      if (Number.isSafeInteger(input)) group.uncachedInput = input;
      else delete group.uncachedInput;
      if (row.toolCalls !== undefined) entry.toolCalls += row.toolCalls;
      else entry.allToolCalls = false;
      if (row.toolTurns !== undefined) entry.toolTurns += row.toolTurns;
      else entry.allToolTurns = false;
    }
  }
  const out = [...groups.values()].map(({ response, activeCount, toolCalls, toolTurns, allToolCalls, allToolTurns }) => {
    if (!incomplete && activeCount > 0) {
      if (allToolCalls) response.toolCalls = toolCalls;
      if (allToolTurns) response.toolTurns = toolTurns;
    }
    return response;
  });
  if (incomplete) {
    if (!out.some(group => group.role === 'delegate')) {
      out.push({ role: 'delegate', basis: 'unavailable', coverage: 'unknown' });
    }
    if (result.notes?.subagent && !out.some(group => group.role === 'subagent')) {
      out.push({ role: 'subagent', basis: 'unavailable', coverage: 'unknown' });
    }
  }
  return out;
}

/** Reads one delegate launch's own session data in its launch window and folds rows into banded counters. */
export function readDelegateSession(query: DelegateQuery): SessionRead {
  if (!validSessionId(query.sessionId)) return { complete: false };
  if (!Number.isFinite(query.startMs) || !Number.isFinite(query.endMs)) return { complete: false };

  const startMs = query.platform === 'copilot' || query.resumed ? query.startMs : Math.floor(query.startMs / 1000) * 1000;
  const hostQuery: HostUsageQuery = {
    ...(query.collectResponses ? { collectResponses: true } : {}),
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
    switch (query.platform) {
      case 'copilot':
        result = collectCopilotUsage(hostQuery, query.fs, { rootRole: 'delegate' });
        break;
      case 'claude': {
        if (!query.cwd) return { complete: false };
        const projectDir = query.cwd.replace(/[^A-Za-z0-9]/g, '-');
        result = collectClaudeUsage(hostQuery, query.fs, {
          projectDir, rootRole: 'delegate', ...(query.collectResponses ? { responseStartMs: query.startMs } : {}),
        });
        break;
      }
      case 'codex':
        result = collectCodexUsage(hostQuery, query.fs, { rootRole: 'delegate' });
        break;
      case 'opencode':
        result = collectOpencodeUsage(hostQuery, query.fs, { rootRole: 'delegate' });
        break;
      case 'agy':
        result = collectAgyUsage(hostQuery, query.fs, {
          ...(query.appDataDir ? { appDataDir: query.appDataDir } : {}),
          rootRole: 'delegate',
        });
        break;
    }
  } catch {
    return { complete: false };
  }

  const hasNotes = Boolean(
    result.notes && Object.values(result.notes).some((roleNotes) => roleNotes && Object.keys(roleNotes).length > 0),
  );
  const rows = result.rows;
  // Descendant-only rows can still supply usage when the root has no accepted records.
  const incomplete = hasNotes || (result.unavailable && result.unavailable !== 'no usage records')
    || rows.length === 0 || (query.resumed && rows.some(r => r.wholeSecond));
  const invalidCounters = !incomplete && rows.some(r => !baseCounters(r));
  const counts = responseCounts(query, result, Boolean(incomplete || result.unavailable || invalidCounters));
  const evidence = counts.length ? { responses: counts } : {};
  if (incomplete && (query.platform !== 'copilot' || !rows.length)) return { complete: false, ...evidence };
  if (invalidCounters) return { complete: false, invalidCounters: true, ...evidence };

  const folded = foldRows(rows);
  if (!baseCounters(folded.total)) return { complete: false, invalidCounters: true, ...evidence };
  const actualModels: string[] = [];
  for (const r of rows) {
    if (r.model && !actualModels.includes(r.model)) actualModels.push(r.model);
  }
  const efforts = new Set(rows.map((r) => r.effort));
  const actualEffort = efforts.size === 1 ? [...efforts][0]! : null;

  const models: Record<string, DiagnosticModelUsage> = boundModels(folded.models);
  const activeDelegateRows = rows.filter(r => r.role === 'delegate' && !r.skipResponse);
  const hasDelegateRows = activeDelegateRows.length > 0;
  const usageTurns = hasDelegateRows && activeDelegateRows.every(r => r.turns !== undefined)
    ? activeDelegateRows.reduce((sum, r) => sum + r.turns!, 0)
    : undefined;
  const usageToolCalls = hasDelegateRows && activeDelegateRows.every(r => r.toolCalls !== undefined)
    ? activeDelegateRows.reduce((sum, r) => sum + r.toolCalls!, 0)
    : undefined;
  const usageToolTurns = hasDelegateRows && activeDelegateRows.every(r => r.toolTurns !== undefined)
    ? activeDelegateRows.reduce((sum, r) => sum + r.toolTurns!, 0)
    : undefined;

  if (hasDelegateRows) {
    const delegateByModel = new Map<string, typeof activeDelegateRows>();
    for (const r of activeDelegateRows) {
      const rawKey = usageKey(r.model, r.effort);
      const key = Object.hasOwn(models, rawKey) ? rawKey : OTHER_KEY;
      const list = delegateByModel.get(key) ?? [];
      list.push(r);
      delegateByModel.set(key, list);
    }
    for (const key of Object.keys(models)) {
      const entry = models[key]!;
      const group = delegateByModel.get(key) ?? [];
      if (group.length > 0) {
        if (group.every(r => r.turns !== undefined)) entry.turns = group.reduce((s, r) => s + r.turns!, 0);
        if (group.every(r => r.toolCalls !== undefined)) entry.toolCalls = group.reduce((s, r) => s + r.toolCalls!, 0);
        if (group.every(r => r.toolTurns !== undefined)) entry.toolTurns = group.reduce((s, r) => s + r.toolTurns!, 0);
      } else {
        if (usageTurns !== undefined) entry.turns = 0;
        if (usageToolCalls !== undefined) entry.toolCalls = 0;
        if (usageToolTurns !== undefined) entry.toolTurns = 0;
      }
    }
  }

  return {
    complete: !incomplete,
    ...evidence,
    usage: {
      ...folded.total,
      ...(usageTurns === undefined ? {} : { turns: usageTurns }),
      ...(usageToolCalls === undefined ? {} : { toolCalls: usageToolCalls }),
      ...(usageToolTurns === undefined ? {} : { toolTurns: usageToolTurns }),
      scope: 'invocation',
      provenance: 'session',
      inputSemantics: 'uncached',
      models,
      ...(actualModels.length > 0 ? { actualModels: actualModels.slice(0, 8) } : {}),
      actualEffort,
      ...(query.platform === 'copilot' ? { copilot: mergeCopilot(rows.map(r => r.copilot))!, actors: copilotActors(rows, models) } : {}),
      ...(folded.reasoningInOutput === undefined ? {} : { reasoningInOutput: folded.reasoningInOutput }),
    },
  };
}

function copilotActors(rows: HostUsageResult['rows'], models: Record<string, DiagnosticModelUsage>): CopilotActor[] {
  const aliases = new Map<string, string>();
  for (const r of rows) if (r.responseActor && !aliases.has(r.responseActor) && aliases.size < MAX_RESPONSE_AGENTS) aliases.set(r.responseActor, `actor-${aliases.size + 1}`);
  const groups = new Map<string, typeof rows>();
  for (const original of rows) {
    const r = Object.hasOwn(models, usageKey(original.model, original.effort)) ? original : { ...original, model: OTHER_KEY, effort: null };
    const agent = aliases.get(r.responseActor ?? '');
    const key = JSON.stringify([r.role, agent, r.model, r.effort]);
    const group = groups.get(key) ?? []; group.push(r); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const r = group[0]!, agent = aliases.get(r.responseActor ?? '');
    const parent = aliases.get(r.parentActor ?? '');
    const copilot = mergeCopilot(group.map(r => r.copilot))!;
    if (!agent) { copilot.actorCoverage = 'partial'; copilot.lineageCoverage = 'unknown'; }
    const folded = foldRows(group);
    const total = folded.total;
    const bands = folded.models[usageKey(r.model, r.effort)]?.bands;
    return { ...total, ...(bands ? { bands } : {}), turns: group.length, role: r.role, model: r.model, effort: r.effort, ...(agent ? { agent } : {}), ...(agent && parent ? { parent } : {}), ...(agent && r.depth !== undefined ? { depth: r.depth } : {}), copilot };
  });
}
