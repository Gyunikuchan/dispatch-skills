import fs from 'node:fs';
import * as zlib from 'node:zlib';
import type { ProviderKey } from '../platform.ts';
import { readOpencodeMessages } from '../opencode-db.ts';
import { validSessionId } from '../session.ts';
import { agy, readAgySqliteGenMetadata } from './agy.ts';
import { claudeCode } from './claude.ts';
import { codex } from './codex.ts';
import { copilot } from './copilot.ts';
import { mergeCopilot } from './rows.ts';
import { opencode } from './opencode.ts';
import { boundModels, foldRows, OTHER_KEY, type BandedCounters } from './bands.ts';
import { MAX_TOTAL_BYTES, phaseAt, readErrorReason } from './read.ts';
import { HOST_ROLES, MAX_RESPONSE_AGENTS, splitUsageKey, STAGE_ORDER, usageKey, type Counters, type HostResponseAggregate, type HostRole, type HostStage, type HostUsageAdapter, type HostUsageFacts, type HostUsageFs, type HostUsageRow, type HostUsageResult, type Milestone, type PhaseMilestone, type UsageRow } from './rows.ts';

function foldHostRows(
  rows: readonly (UsageRow & { stage: HostStage })[],
  phases: readonly PhaseMilestone[],
  hostComplete: boolean,
  subagentComplete: boolean,
): HostUsageRow[] {
  const aliases = new Map<string, string>();
  const serial = { host: 0, subagent: 0 };
  for (const r of rows) if (r.copilot && r.responseActor && !aliases.has(r.responseActor) && aliases.size < MAX_RESPONSE_AGENTS) aliases.set(r.responseActor, `${r.role}-${++serial[r.role as HostRole]}`);
  const groups = new Map<string, { stage: HostStage; phase: string | undefined; role: HostRole; rows: UsageRow[]; agent?: string }>();
  for (const r of rows) {
    const phase = phaseAt(phases, r.atMs);
    const role = r.role as HostRole;
    const agent = r.copilot ? aliases.get(r.responseActor ?? '') : undefined;
    const gKey = `${r.stage}\0${phase ?? ''}\0${role}\0${agent ?? ''}`;
    const group = groups.get(gKey) ?? { stage: r.stage, phase, role, rows: [], ...(agent ? { agent } : {}) };
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
    const perKey: Record<string, BandedCounters & { reasoningInOutput?: boolean }> = {};
    for (const [k, list] of byKey) {
      const folded = foldRows(list);
      const entry = folded.models[k]!;
      perKey[k] = { ...entry, ...(folded.reasoningInOutput === undefined ? {} : { reasoningInOutput: folded.reasoningInOutput }) };
    }
    const bounded = boundModels(perKey);
    const roleComplete = group.role === 'host' ? hostComplete : subagentComplete;
    for (const [k, value] of Object.entries(bounded)) {
      const { model, effort } = splitUsageKey(k);
      const typed = value as BandedCounters & { reasoningInOutput?: boolean };
      const inputs = k === OTHER_KEY
        ? [...byKey].flatMap(([key, list]) => key === OTHER_KEY || !Object.hasOwn(bounded, key) ? list : [])
        : byKey.get(k)!;
      const active = inputs.filter(r => !r.skipResponse);
      const turns = roleComplete && active.every(r => r.turns !== undefined) ? active.reduce((total, r) => total + r.turns!, 0) : undefined;
      const toolCalls = roleComplete && active.length > 0 && active.every(r => r.toolCalls !== undefined) ? active.reduce((total, r) => total + r.toolCalls!, 0) : undefined;
      const toolTurns = roleComplete && active.length > 0 && active.every(r => r.toolTurns !== undefined) ? active.reduce((total, r) => total + r.toolTurns!, 0) : undefined;
      const precise = inputs.every(r => r.depth !== undefined) && (!inputs.some(r => r.copilot) || group.agent !== undefined);
      const maxDepth = (roleComplete || inputs.every(r => r.copilot)) && precise && group.role === 'subagent' ? inputs.reduce((max, r) => Math.max(max, r.depth!), 0) : undefined;
      const copilot = mergeCopilot(inputs.map(r => r.copilot));
      if (copilot && !group.agent) { copilot.actorCoverage = 'partial'; copilot.lineageCoverage = 'unknown'; }
      const parents = new Set(inputs.map(r => r.parentActor ? aliases.get(r.parentActor) : undefined));
      const parent = parents.size === 1 ? [...parents][0] : undefined;
      const row: HostUsageRow = {
        ...(turns === undefined ? {} : { turns }),
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(toolTurns === undefined ? {} : { toolTurns }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        stage: group.stage,
        ...(group.agent ? { agent: group.agent } : {}),
        ...(parent && group.agent ? { parent } : {}),
        ...(copilot ? { copilot } : {}),
        ...(group.phase === undefined ? {} : { phase: group.phase }),
        role: group.role,
        model,
        effort: effort ? effort : null,
        input: typed.input,
        output: typed.output,
        ...(typed.cacheRead !== undefined ? { cacheRead: typed.cacheRead } : {}),
        ...(typed.cacheWrite !== undefined ? { cacheWrite: typed.cacheWrite } : {}),
        ...(typed.cacheWrite5m !== undefined ? { cacheWrite5m: typed.cacheWrite5m } : {}),
        ...(typed.cacheWrite1h !== undefined ? { cacheWrite1h: typed.cacheWrite1h } : {}),
        ...(typed.reasoning !== undefined ? { reasoning: typed.reasoning } : {}),
        ...(typed.bands !== undefined ? { bands: typed.bands } : {}),
        ...(typed.reasoningInOutput !== undefined ? { reasoningInOutput: typed.reasoningInOutput } : {}),
      };
      out.push(row);
    }
  }
  return out.sort((a, b) =>
    STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
    || (a.phase ?? '').localeCompare(b.phase ?? '')
    || HOST_ROLES.indexOf(a.role) - HOST_ROLES.indexOf(b.role)
    || usageKey(a.model, a.effort).localeCompare(usageKey(b.model, b.effort)));
}

function foldHostResponses(result: HostUsageResult, stages: readonly Milestone[]): HostResponseAggregate[] | undefined {
  const source = result.response;
  if (!source) return undefined;
  const firstMilestone = stages.reduce((first, stage) => Math.min(first, stage.atMs), Infinity);
  const aliases = new Map<string, string>();
  const serial = { host: 0, subagent: 0 };
  const hasHostNotes = Object.keys(result.notes?.host ?? {}).length > 0;
  const groups = new Map<string, { aggregate: HostResponseAggregate; toolCalls: number; toolTurns: number; allToolCalls: boolean; allToolTurns: boolean }>();
  for (const row of result.rows) {
    if (row.role === 'delegate' || row.skipResponse) continue;
    const role = row.role;
    const stage = row.atMs >= firstMilestone ? row.stage : 'unattributed';
    const actor = row.responseActor === undefined ? undefined : `${role}\0${row.responseActor}`;
    if (actor !== undefined && !aliases.has(actor) && aliases.size < MAX_RESPONSE_AGENTS) {
      aliases.set(actor, `${role}-${++serial[role]}`);
    }
    const agent = actor === undefined ? undefined : aliases.get(actor);
    const key = `${stage}\0${role}\0${agent ?? ''}`;
    const coverage = source.limited || result.unavailable || result.notes?.[role] || !agent ? 'partial' : 'complete';
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        aggregate: {
          stage, role, basis: source.basis, coverage, observed: 0, uncachedInput: 0,
          ...(agent === undefined ? {} : { agent }),
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
    const input = (group.uncachedInput ?? NaN) + row.input;
    if (Number.isSafeInteger(input)) group.uncachedInput = input;
    else delete group.uncachedInput;
    if (row.toolCalls !== undefined) entry.toolCalls += row.toolCalls;
    else entry.allToolCalls = false;
    if (row.toolTurns !== undefined) entry.toolTurns += row.toolTurns;
    else entry.allToolTurns = false;
  }
  const aggregates = [...groups.values()].map(({ aggregate, toolCalls, toolTurns, allToolCalls, allToolTurns }) => {
    if (aggregate.coverage === 'complete' && !hasHostNotes) {
      if (allToolCalls) aggregate.toolCalls = toolCalls;
      if (allToolTurns) aggregate.toolTurns = toolTurns;
    }
    return aggregate;
  });
  for (const role of HOST_ROLES) {
    const incomplete = result.notes?.[role] || (role === 'host' ? result.unavailable : result.notes?.host?.['read budget reached']);
    if (incomplete && !aggregates.some(group => group.role === role)) {
      aggregates.push({ stage: 'unattributed', role, basis: source.basis, coverage: 'unknown' });
    }
  }
  return aggregates;
}
const ADAPTERS: Partial<Record<ProviderKey, HostUsageAdapter>> = { agy, claude: claudeCode, codex, opencode, copilot };
export function hostSessionId(platform: ProviderKey | null, env: (name: string) => string | undefined): string | undefined {
  const adapter = platform ? ADAPTERS[platform] : undefined;
  const sessionId = adapter?.sessionEnv.map(env).find(Boolean);
  return sessionId && validSessionId(sessionId) ? sessionId : undefined;
}
type HostUsageInput = { startMs: number; endMs: number; home: string; env: (name: string) => string | undefined; stages: readonly Milestone[]; phases?: readonly PhaseMilestone[] };
export function readHostUsage(platform: ProviderKey | null, input: HostUsageInput, fsPort: HostUsageFs, adapters: Partial<Record<ProviderKey, HostUsageAdapter>> = ADAPTERS): HostUsageFacts {
  const adapter = platform ? adapters[platform] : undefined;
  if (!adapter) return { platform, rows: [], unavailable: 'no adapter' };
  const sessionId = adapter.sessionEnv.map(input.env).find(Boolean);
  if (!sessionId) return { platform, rows: [], unavailable: 'no host id' };
  if (!validSessionId(sessionId)) return { platform, rows: [], unavailable: 'invalid host id' };
  if (!Number.isFinite(input.startMs)) return { platform, rows: [], unavailable: 'invalid session start' };
  try {
    const res = adapter.read({ ...input, sessionId, collectResponses: true, budget: { remaining: MAX_TOTAL_BYTES } }, fsPort);
    const { unavailable, notes } = res;
    const hostComplete = !unavailable && Object.keys(notes?.host ?? {}).length === 0;
    const subagentComplete = hostComplete && Object.keys(notes?.subagent ?? {}).length === 0;
    const subagentRows = res.rows.filter(r => r.role === 'subagent');
    const subagentActorsComplete = subagentComplete && subagentRows.every(r => r.responseActor !== undefined);
    const subagentCount = subagentActorsComplete ? new Set(subagentRows.map(r => r.responseActor!)).size : undefined;
    const maxSubagentDepth = subagentActorsComplete && subagentRows.every(r => r.depth !== undefined) ? subagentRows.reduce((max, r) => Math.max(max, r.depth!), 0) : undefined;
    const responses = foldHostResponses(res, input.stages);
    return {
      platform, rows: foldHostRows(res.rows, input.phases ?? [], hostComplete, subagentComplete),
      ...(hostComplete && res.userTurns !== undefined ? { userTurns: res.userTurns } : {}),
      ...(hostComplete && res.userTurns !== undefined && res.userTurnsByStage !== undefined ? { userTurnsByStage: res.userTurnsByStage } : {}),
      ...(subagentCount === undefined ? {} : { subagentCount }),
      ...(maxSubagentDepth === undefined ? {} : { maxSubagentDepth }),
      ...(unavailable === undefined ? {} : { unavailable }),
      ...(notes === undefined ? {} : { notes }),
      ...(responses === undefined ? {} : { responses }),
    };
  } catch (error) { return { platform, rows: [], unavailable: readErrorReason(error) }; }
}
export const nodeHostUsageFs: HostUsageFs = {
  list(dir) { try { return fs.readdirSync(dir); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []; throw error; } },
  stat(file) { try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; } },
  read(file, maxBytes) { const fd = fs.openSync(file, 'r'); try { const chunks: Buffer[] = []; let total = 0; while (total < maxBytes) { const data = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes - total)); const count = fs.readSync(fd, data, 0, data.length, null); if (!count) break; chunks.push(data.subarray(0, count)); total += count; } return Buffer.concat(chunks, total); } finally { fs.closeSync(fd); } },
  decompress: typeof zlib.zstdDecompressSync === 'function' ? (data, maxBytes) => zlib.zstdDecompressSync(data, { maxOutputLength: maxBytes }) : null,
  sqliteGenMetadata: (file) => readAgySqliteGenMetadata(file, { throwOnError: true }),
  opencodeMessages: readOpencodeMessages,
};
