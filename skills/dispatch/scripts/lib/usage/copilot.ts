import path from 'node:path';
import { validSessionId } from '../session.ts';
import { count, note, readErrorReason, readTranscript, row, stageAt } from './read.ts';
import { type CopilotEvidence, type HostNotes, type HostRole, type HostUsageAdapter, type HostUsageFs, type HostUsageQuery, type HostUsageResult, type UsageRow } from './rows.ts';

type Link = { parent?: string };
type Receipt = { atMs: number; actor?: string; actorSupplied: boolean; usage: Record<string, unknown>; signature: string; conflict?: true };
const identity = (v: unknown): string | undefined => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v) ? v : undefined;
const receiptId = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 1024 && /^[\x21-\x7e]+$/.test(v) ? v : undefined;
const configuration = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 256 && !/[\s`|<>]/.test(v) ? v : undefined;

export const copilot: HostUsageAdapter = {
  sessionEnv: ['COPILOT_AGENT_SESSION_ID', 'COPILOT_CLI_SESSION_ID'],
  read: (query, fs, delegate) => collectCopilotUsage(query, fs, delegate ? { rootRole: 'delegate' } : undefined),
};

export function collectCopilotUsage(query: HostUsageQuery, fs: HostUsageFs, options: { rootRole?: 'host' | 'delegate' } = {}): HostUsageResult {
  if (!validSessionId(query.sessionId)) return { rows: [], unavailable: 'invalid host id' };
  const file = path.join(query.home, '.copilot', 'session-state', query.sessionId, 'events.jsonl');
  const notes: HostNotes = {};
  let text: string | undefined;
  try {
    if (!fs.stat(file)) return { rows: [], unavailable: 'host id file missing' };
    const read = readTranscript(fs, file, query.budget);
    if (read.stop) return read.stop === 'budget'
      ? { rows: [], notes: { host: { 'read budget reached': 1 } } }
      : { rows: [], unavailable: 'transcript over size cap' };
    text = read.text;
  } catch (error) { return { rows: [], unavailable: readErrorReason(error) }; }
  const receipts = new Map<string, Receipt>();
  const sourceUsageIds = new Map<string, string>();
  const sourceSequences = new Map<string, string>();
  const links = new Map<string, Link>();
  const conflicting = new Set<string>();
  const rootRole = options.rootRole ?? 'host';
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    // Parse only telemetry/lifecycle lines; conversation fields never become retained facts.
    if (!/"(?:session\.usage_record|assistant\.usage|subagent\.started)"/.test(line)) {
      if (!/"type"\s*:\s*"[^"]+"/.test(line) || /"type"\s*:\s*"[^"]*usage[^"]*"/.test(line)) note(notes, 'host', 'unparsed lines');
      continue;
    }
    let event: Record<string, unknown> | null;
    try { event = row(JSON.parse(line)); } catch { note(notes, 'host', 'unparsed lines'); continue; }
    if (!event) continue;
    const data = row(event['data']);
    if (event['type'] === 'subagent.started' && data) {
      const actor = identity(event['agentId']);
      if (!actor) { note(notes, 'subagent', 'unverified candidates'); continue; }
      const parent = identity(data['parentId']);
      if (data['parentId'] !== undefined && !parent) { conflicting.add(actor); note(notes, 'subagent', 'unverified candidates'); continue; }
      const link: Link = parent ? { parent } : {};
      if (links.has(actor) && JSON.stringify(links.get(actor)) !== JSON.stringify(link)) conflicting.add(actor);
      links.set(actor, link);
      continue;
    }
    if (!data) { note(notes, 'host', 'unparsed lines'); continue; }
    const raw = event['type'] === 'session.usage_record' ? row(data['usage']) : event['type'] === 'assistant.usage' ? data : null;
    if (!raw) { note(notes, 'host', 'unparsed lines'); continue; }
    const accounting = row(raw['accounting']);
    const source = identity(accounting?.['sourceSessionId']), id = receiptId(accounting?.['usageId']), sequence = accounting?.['sequence'];
    const atMs = typeof event['timestamp'] === 'string' ? Date.parse(event['timestamp']) : NaN;
    if (!source || !id || !count(sequence) || !Number.isFinite(atMs)) { note(notes, 'host', 'unparsed lines'); continue; }
    // Whitelist the sampled persisted receipt and supported live counters.
    const usage = Object.fromEntries(['model', 'reasoningEffort', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost', 'aiCreditsStatus'].map(k => [k, raw[k]]));
    usage['copilotUsage'] = { totalNanoAiu: row(raw['copilotUsage'])?.['totalNanoAiu'] };
    const actorSupplied = Object.hasOwn(event, 'agentId');
    const actor = identity(event['agentId']);
    const signature = JSON.stringify([actor ?? null, actorSupplied, usage]);
    const key = JSON.stringify([source, sequence, id]);
    const prior = receipts.get(key);
    // Receipt identity precedes window filtering, including later-timestamp replays.
    if (prior) { if (prior.signature !== signature) prior.conflict = true; else prior.atMs = Math.min(prior.atMs, atMs); }
    else {
      const receipt: Receipt = { atMs, ...(actor ? { actor } : {}), actorSupplied, usage, signature };
      const usageIdentity = JSON.stringify([source, id]);
      const sequenceIdentity = JSON.stringify([source, sequence]);
      const conflicts = new Set([sourceUsageIds.get(usageIdentity), sourceSequences.get(sequenceIdentity)].filter((value): value is string => value !== undefined));
      for (const conflictKey of conflicts) {
        const conflict = receipts.get(conflictKey);
        if (conflict) conflict.conflict = true;
        receipt.conflict = true;
      }
      if (!sourceUsageIds.has(usageIdentity)) sourceUsageIds.set(usageIdentity, key);
      if (!sourceSequences.has(sequenceIdentity)) sourceSequences.set(sequenceIdentity, key);
      receipts.set(key, receipt);
    }
  }
  type Lineage = { depth?: number; parent?: string };
  const lineageCache = new Map<string, Lineage>([[query.sessionId, { depth: 0 }]]);
  const lineage = (actor: string): Lineage => {
    const trail: { actor: string; parent: string }[] = [];
    const seen = new Set<string>();
    let current = actor, result: Lineage = {};
    while (true) {
      if (lineageCache.has(current)) { result = lineageCache.get(current)!; break; }
      const link = links.get(current);
      if (seen.has(current) || conflicting.has(current) || !link) break;
      seen.add(current);
      if (!link.parent) {
        result = { depth: 1, parent: query.sessionId };
        break;
      }
      const parent = link.parent;
      trail.push({ actor: current, parent }); current = parent;
    }
    lineageCache.set(current, result);
    for (const step of trail.reverse()) {
      result = result.depth === undefined ? {} : { depth: result.depth + 1, parent: step.parent };
      lineageCache.set(step.actor, result);
    }
    return result;
  };
  const rows: HostUsageResult['rows'] = [];
  const tokenLimited = new Set<HostRole>();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const receipt of receipts.values()) {
    if (receipt.atMs < query.startMs || receipt.atMs > query.endMs) continue;
    const actor = receipt.actor;
    const role = !receipt.actorSupplied || actor === query.sessionId ? rootRole : 'subagent';
    const noteRole: HostRole = role === 'delegate' ? 'host' : role;
    if (receipt.conflict) { note(notes, noteRole, 'unverified candidates'); tokenLimited.add(noteRole); continue; }
    const u = receipt.usage;
    const input = u['inputTokens'], output = u['outputTokens'];
    const read = u['cacheReadTokens'] ?? 0, write = u['cacheWriteTokens'] ?? 0, reasoning = u['reasoningTokens'] ?? 0;
    if (!count(input) || !count(output) || !count(read) || !count(write) || !count(reasoning)
      || !Number.isSafeInteger(read + write) || read + write > input || reasoning > output) { note(notes, noteRole, 'unparsed lines'); continue; }
    const counters = { input: input - read - write, output, ...(u['cacheReadTokens'] === undefined ? {} : { cacheRead: read }), ...(u['cacheWriteTokens'] === undefined ? {} : { cacheWrite: write }), ...(u['reasoningTokens'] === undefined ? {} : { reasoning }) };
    if (Object.keys(totals).some(k => !Number.isSafeInteger(totals[k as keyof typeof totals] + (counters[k as keyof typeof counters] ?? 0)))
      || !Number.isSafeInteger(input + output) || !Number.isSafeInteger(totals.input + totals.cacheRead + totals.cacheWrite + totals.output + input + output)) { note(notes, noteRole, 'unparsed lines'); continue; }
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += counters[k] ?? 0;
    const graph = role === 'subagent' ? actor ? lineage(actor) : {} : { depth: 0 };
    if (graph.depth === undefined) note(notes, 'subagent', 'unverified candidates');
    const nano = row(u['copilotUsage'])?.['totalNanoAiu'];
    const status = configuration(u['aiCreditsStatus']);
    const multiplier = u['cost'];
    const validMultiplier = typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier >= 0;
    const billing: CopilotEvidence['billing'] = {
      coverage: count(nano) && status === 'complete' && validMultiplier ? 'complete' : count(nano) ? 'partial' : 'unknown',
      ...(count(nano) ? { totalNanoAiu: nano } : {}), ...(status ? { statuses: [status] } : {}), ...(validMultiplier ? { multipliers: [multiplier] } : {}),
    };
    const model = configuration(u['model']) ?? '';
    const effort = configuration(u['reasoningEffort']) ?? null;
    const r: UsageRow & { stage: ReturnType<typeof stageAt> } = {
      ...counters, role, ...graph, atMs: receipt.atMs, model, effort, reasoningInOutput: true, turns: 1,
      ...(actor ? { responseActor: actor } : !receipt.actorSupplied ? { responseActor: query.sessionId } : {}),
      ...(graph.parent ? { parentActor: graph.parent } : {}),
      copilot: { tokenCoverage: model ? 'complete' : 'partial', lineageCoverage: graph.depth === undefined ? 'unknown' : 'complete', actorCoverage: receipt.actorSupplied && !actor ? 'unknown' : 'complete', billing },
      stage: stageAt(query.stages, receipt.atMs),
    };
    rows.push(r);
  }
  for (const r of rows) if (notes[r.role === 'subagent' ? 'subagent' : 'host']?.['unparsed lines'] || tokenLimited.has(r.role === 'subagent' ? 'subagent' : 'host')) {
    r.copilot!.tokenCoverage = 'partial';
    if (r.copilot!.billing.coverage === 'complete') r.copilot!.billing.coverage = 'partial';
  }
  return { rows, ...(query.collectResponses ? { response: { basis: 'copilot-usage-record' as const } } : {}), ...(rows.length ? {} : { unavailable: 'no usage records' as const }), ...(Object.keys(notes).length ? { notes } : {}) };
}
