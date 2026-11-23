import type { DelegateResponse, DiagnosticUsage } from '../../toolkit/types.ts';
import { validSessionId } from '../session.ts';
import { collectAgyUsage } from './agy.ts';
import { boundModels, foldRows } from './bands.ts';
import { collectClaudeUsage } from './claude.ts';
import { collectCodexUsage } from './codex.ts';
import { collectOpencodeUsage } from './opencode.ts';
import { baseCounters } from './read.ts';
import { MAX_RESPONSE_AGENTS, type DelegateQuery, type HostUsageQuery, type HostUsageResult } from './rows.ts';

export type SessionRead = { usage?: DiagnosticUsage; complete: boolean; invalidCounters?: true; responses?: DelegateResponse[] };

const actors = new WeakMap<DelegateResponse, string>();

// Keep lineage out of serializable invocation rows.
export const delegateResponseActor = (response: DelegateResponse): string | undefined => actors.get(response);

function responseCounts(query: DelegateQuery, result: HostUsageResult, incomplete: boolean): DelegateResponse[] {
  if (!result.response || (query.resumed && result.rows.some(row => row.wholeSecond))) return [];
  const { basis, limited } = result.response;
  const groups = new Map<string, DelegateResponse>();
  const named = new Set<string>();
  for (const row of result.rows) {
    if (row.role === 'host' || !baseCounters(row) || (!row.wholeSecond && row.atMs < query.startMs)) continue;
    const role = row.role;
    const identity = role === 'delegate' ? query.sessionId : row.responseActor;
    const actor = identity && (named.has(identity) || named.size < MAX_RESPONSE_AGENTS) ? identity : undefined;
    if (actor) named.add(actor);
    const key = JSON.stringify([role, actor]);
    let group = groups.get(key);
    if (!group) {
      group = { role, basis, coverage: incomplete || limited || !actor ? 'partial' : 'complete', observed: 0, uncachedInput: 0 };
      if (actor) actors.set(group, actor);
      groups.set(key, group);
    }
    if (!row.skipResponse) {
      group.observed! += 1;
      const input = (group.uncachedInput ?? Infinity) + row.input;
      if (Number.isSafeInteger(input)) group.uncachedInput = input;
      else delete group.uncachedInput;
    }
  }
  if (incomplete) {
    if (!Array.from(groups.values()).some(group => group.role === 'delegate')) {
      groups.set('unknown-root', { role: 'delegate', basis: 'unavailable', coverage: 'unknown' });
    }
    if (result.notes?.subagent && !Array.from(groups.values()).some(group => group.role === 'subagent')) {
      groups.set('unknown-child', { role: 'subagent', basis: 'unavailable', coverage: 'unknown' });
    }
  }
  return [...groups.values()];
}

/** Reads one delegate launch's own session data in its launch window and folds rows into banded counters. */
export function readDelegateSession(query: DelegateQuery): SessionRead {
  if (!validSessionId(query.sessionId)) return { complete: false };
  if (!Number.isFinite(query.startMs) || !Number.isFinite(query.endMs)) return { complete: false };

  const startMs = query.resumed ? query.startMs : Math.floor(query.startMs / 1000) * 1000;
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
  if (incomplete) return { complete: false, ...evidence };
  if (invalidCounters) return { complete: false, invalidCounters: true, ...evidence };

  const folded = foldRows(rows);
  if (!baseCounters(folded.total)) return { complete: false, invalidCounters: true, ...evidence };
  const actualModels: string[] = [];
  for (const r of rows) {
    if (r.model && !actualModels.includes(r.model)) actualModels.push(r.model);
  }
  const efforts = new Set(rows.map((r) => r.effort));
  const actualEffort = efforts.size === 1 ? [...efforts][0]! : null;

  return {
    complete: true,
    ...evidence,
    usage: {
      ...folded.total,
      scope: 'invocation',
      provenance: 'session',
      inputSemantics: 'uncached',
      models: boundModels(folded.models),
      ...(actualModels.length > 0 ? { actualModels: actualModels.slice(0, 8) } : {}),
      actualEffort,
      ...(folded.reasoningInOutput === undefined ? {} : { reasoningInOutput: folded.reasoningInOutput }),
    },
  };
}
