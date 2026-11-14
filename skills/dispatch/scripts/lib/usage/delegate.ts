import type { DiagnosticUsage } from '../../toolkit/types.ts';
import { validSessionId } from '../session.ts';
import { collectAgyUsage } from './agy.ts';
import { boundModels, foldRows } from './bands.ts';
import { collectClaudeUsage } from './claude.ts';
import { collectCodexUsage } from './codex.ts';
import { collectOpencodeUsage } from './opencode.ts';
import type { DelegateQuery, HostUsageQuery, HostUsageResult } from './rows.ts';

export type SessionRead = { usage?: DiagnosticUsage; complete: boolean };

/** Reads one delegate launch's own session data in its launch window and folds rows into banded counters. */
export function readDelegateSession(query: DelegateQuery): SessionRead {
  if (!validSessionId(query.sessionId)) return { complete: false };
  if (!Number.isFinite(query.startMs) || !Number.isFinite(query.endMs)) return { complete: false };

  const startMs = query.resumed ? query.startMs : Math.floor(query.startMs / 1000) * 1000;
  const hostQuery: HostUsageQuery = {
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
        result = collectClaudeUsage(hostQuery, query.fs, { projectDir, rootRole: 'delegate' });
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
  if (hasNotes) return { complete: false };
  if (result.unavailable && result.unavailable !== 'no usage records') return { complete: false };

  const rows = result.rows;
  if (rows.length === 0) return query.stdoutHasUsage ? { complete: false } : { complete: true };
  if (query.resumed && rows.some((r) => r.wholeSecond)) return { complete: false };

  const folded = foldRows(rows);
  const actualModels: string[] = [];
  for (const r of rows) {
    if (r.model && !actualModels.includes(r.model)) actualModels.push(r.model);
  }
  const efforts = new Set(rows.map((r) => r.effort));
  const actualEffort = efforts.size === 1 ? [...efforts][0]! : null;

  return {
    complete: true,
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
