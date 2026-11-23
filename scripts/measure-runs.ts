// Matched measurement: reads finished session folders and host transcripts, then writes a per-pair comparison.
// Reads only; the sole writes are comparison.json and comparison.md in --out.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { CliDeps } from '../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFacts } from '../skills/dispatch/scripts/toolkit/diagnostics.ts';
import { billedTokens, costCoverage, efficiencyOf, formatDuration, sanitizeFacts } from '../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
import { foldLedger, type Fold } from '../skills/dispatch/scripts/toolkit/ledger.ts';
import { formatCost, resolvePricing, type CostReason, type Pricer } from '../skills/dispatch/scripts/lib/pricing.ts';
import { orchestratorFor } from '../skills/dispatch/scripts/lib/platform.ts';
import { stripBom } from '../skills/dispatch/scripts/lib/fs-ext.ts';
import { readManifest, validSessionId, type Manifest } from '../skills/dispatch/scripts/lib/session.ts';
import { nodeHostUsageFs } from '../skills/dispatch/scripts/lib/usage/index.ts';
import { claudeCode } from '../skills/dispatch/scripts/lib/usage/claude.ts';
import { agy } from '../skills/dispatch/scripts/lib/usage/agy.ts';
import { codex } from '../skills/dispatch/scripts/lib/usage/codex.ts';
import { opencode } from '../skills/dispatch/scripts/lib/usage/opencode.ts';
import type { HostUsageFacts } from '../skills/dispatch/scripts/lib/usage/rows.ts';

// SECTION: Types

export type PairSide = { label: string; session: string; host: string; nativeId?: string; reportComplete?: string };
export type PairsFile = { pricing?: string; pairs: { name: string; sides: PairSide[] }[]; confounds: string[] };
export type MeasureOptions = { baseDir: string; home: string; env: NodeJS.ProcessEnv; pricing: { path: string; text: string } };
export type PathForm = 'canonical' | 'as-given';
export type DenialCounts = { config: number; hook: number; other: number };
export type Denials = (DenialCounts & { inWindow: DenialCounts }) | { unavailable: string };
export type PerRound = { review: string; round: number; calls?: number; hostTokens?: number; hostTurns?: number };
type CostCoverage = ReturnType<typeof costCoverage>;
const VERIFICATION_STATES = ['verified', 'manual', 'waived', 'missing'] as const;
type VerificationState = typeof VERIFICATION_STATES[number];
type Verification = Record<VerificationState, number> & { criteria: { id: string; state: VerificationState }[] };
type Efficiency = Omit<ReturnType<typeof efficiencyOf>, 'responses'> & { verification: Verification | null };

export type SideResult = {
  label: string; session: string; host: string; nativeId: string;
  window: { startMs: number; endMs: number; pathForm: PathForm };
  rounds: { total: number; byReview: Record<string, number> };
  perRound: PerRound[];
  hostTokens?: number;
  denials: Denials;
  cost: {
    low: number; high: number; priced: boolean; reasons: string[]; partial: boolean;
    pricedUnits: number; unpricedUnits: number; coverage: CostCoverage['coverage']; rateBasis: CostCoverage['rateBasis'];
  };
  unavailable: string[];
  efficiency: Efficiency;
};
export type Comparison = {
  pricing: { path: string; asOf: string }; generatedAt: string;
  pairs: { name: string; sides: SideResult[]; comparisonLimits: string[] }[]; confounds: string[];
};

const DEFAULT_PRICING = 'skills/dispatch/references/pricing.json';
const OUTCOME = 'measured';
const USAGE = 'Usage: node scripts/measure-runs.ts <pairs.json> --out <dir>\n';
// NOTE: each adapter's env names receive the side's host id, so the adapter's first match is that id.
const HOST_SESSION_ENV: Partial<Record<string, readonly string[]>> = {
  claude: claudeCode.sessionEnv, agy: agy.sessionEnv, codex: codex.sessionEnv, opencode: opencode.sessionEnv,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const readErrorReason = (error: unknown) => `read-error:${(error as NodeJS.ErrnoException).code ?? 'EUNKNOWN'}`;
const roundKey = (review: string, round: number) => `${review}\u0000${round}`;
// NOTE: these prefixes are the contract between measureSide and the markdown flags; renderComparison matches on them.
const CALLS_PARTIAL = 'perRound calls partial:';
const HOST_TOKENS_PARTIAL = 'hostTokens partial:';

// SECTION: Input

function sideOf(value: unknown, where: string): PairSide {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const { label, session, host, nativeId, reportComplete } = value;
  if (typeof label !== 'string' || typeof session !== 'string' || typeof host !== 'string') throw new Error(`${where} needs label, session and host strings`);
  if (orchestratorFor(host, () => undefined) === null) throw new Error(`${where} host is not a known host: ${host}`);
  if (nativeId !== undefined && typeof nativeId !== 'string') throw new Error(`${where} nativeId must be a string`);
  return { label, session, host, ...(typeof nativeId === 'string' ? { nativeId } : {}), ...(typeof reportComplete === 'string' ? { reportComplete } : {}) };
}

function pairOf(value: unknown, where: string): { name: string; sides: PairSide[] } {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const name: unknown = value['name'];
  const sides: unknown = value['sides'];
  if (typeof name !== 'string' || !name || !Array.isArray(sides) || !sides.length) throw new Error(`${where} needs a name and a non-empty sides array`);
  return { name, sides: sides.map((side: unknown, index: number) => sideOf(side, `${where} sides[${index}]`)) };
}

/** Validates pairs.json; a relative `session` resolves later against the pairs.json folder. */
export function parsePairs(input: unknown): PairsFile {
  if (!isRecord(input)) throw new Error('pairs file must be an object');
  const list: unknown = input['pairs'];
  if (!Array.isArray(list) || !list.length) throw new Error('pairs file needs a non-empty "pairs" array');
  const pricing: unknown = input['pricing'];
  const confounds: unknown = input['confounds'] ?? [];
  if (pricing !== undefined && typeof pricing !== 'string') throw new Error('pricing must be a path string');
  if (!Array.isArray(confounds) || !confounds.every((line) => typeof line === 'string')) throw new Error('confounds must be an array of strings');
  return {
    ...(typeof pricing === 'string' ? { pricing } : {}),
    pairs: list.map((pair: unknown, index: number) => pairOf(pair, `pairs[${index}]`)),
    confounds: confounds as string[],
  };
}

// SECTION: Session facts

const REPORT_PATH = /^\.state\/results\/report-complete-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.json$/i;
const MAX_REPORT_BYTES = 1024 * 1024;

function verificationOf(session: string, relative: string | undefined): Verification | null {
  if (!relative || !REPORT_PATH.test(relative) || relative.includes('\n') || relative.includes('\r')) return null;
  try {
    const results = fs.realpathSync.native(path.join(session, '.state', 'results'));
    const file = fs.realpathSync.native(path.join(session, relative));
    if (results === session || !isWithin(results, session) || !isWithin(file, results) || !fs.statSync(file).isFile()) return null;
    const fd = fs.openSync(file, 'r');
    let result: unknown;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return null;
      const data = Buffer.allocUnsafe(stat.size + 1);
      let read = 0;
      while (read < data.length) {
        const bytes = fs.readSync(fd, data, read, data.length - read, null);
        if (!bytes) break;
        read += bytes;
      }
      if (read !== stat.size) return null;
      result = JSON.parse(stripBom(data.toString('utf8', 0, read)));
    } finally {
      fs.closeSync(fd);
    }
    if (!isRecord(result)) return null;
    const { delivered, statuses } = result;
    if (!isRecord(delivered) || typeof delivered['source'] !== 'string' ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(delivered['source']) || !Array.isArray(statuses)) return null;
    const verification: Verification = { verified: 0, manual: 0, waived: 0, missing: 0, criteria: [] };
    const seen = new Set<string>();
    for (const status of statuses) {
      if (!isRecord(status) || typeof status['criterion'] !== 'string') return null;
      const id = status['criterion'];
      const state = VERIFICATION_STATES.find(state => state === status['state']);
      if (!state || seen.has(id) || (id !== 'contract' && !/^SC[1-9]\d*$/.test(id))) return null;
      seen.add(id);
      if (id === 'contract') continue;
      verification[state]++;
      verification.criteria.push({ id, state });
    }
    verification.criteria.sort((a, b) => a.id.localeCompare(b.id));
    return verification;
  } catch {
    return null;
  }
}

function folderOf(given: string, where: string): string {
  try {
    const folder = fs.realpathSync.native(given);
    if (fs.statSync(folder).isDirectory()) return folder;
  } catch (error) {
    if (!isMissing(error)) throw new Error(`${where}: ${(error as Error).message}`);
  }
  throw new Error(`${where}: session folder missing: ${given}`);
}

function manifestOf(folder: string, where: string): Manifest {
  try {
    return readManifest(folder);
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function foldOf(folder: string, unavailable: string[]): Fold {
  try {
    return foldLedger(folder);
  } catch (error) {
    unavailable.push(`ledger: ${error instanceof Error ? error.message : String(error)}`);
    return { records: [], lastSeq: 0, torn: null };
  }
}

/** Latest `capture.end` across the session's diagnostics; an empty window when none exists. */
function latestCaptureEnd(folder: string): number | undefined {
  let latest: number | undefined;
  try {
    for (const name of listDir(path.join(folder, '.state', 'diagnostics'))) {
      if (!name.endsWith('.json')) continue;
      let raw: unknown;
      try { raw = JSON.parse(stripBom(fs.readFileSync(path.join(folder, '.state', 'diagnostics', name), 'utf8'))); } catch { continue; }
      const capture = isRecord(raw) ? raw['capture'] : undefined;
      const end = isRecord(capture) ? capture['end'] : undefined;
      if (typeof end === 'number' && Number.isFinite(end)) latest = Math.max(latest ?? end, end);
    }
  } catch {
    // NOTE: an unreadable diagnostics folder is reported by sessionFacts as a partial collection.
    return undefined;
  }
  return latest;
}

const hasCalls = (run: { roundWorkload?: { calls?: unknown }[] }) => (run.roundWorkload ?? []).some((row) => row.calls !== undefined);

/** Round folders `<session>/.state/reviews/<review>/round-<n>`, keyed as sessionFacts keys them; the number comes from the folder name because round.json may be unreadable. */
function roundFolders(session: string, unavailable: string[]): { review: string; round: number }[] {
  const root = path.join(session, '.state', 'reviews');
  try {
    return listDir(root).filter((review) => statOrNull(path.join(root, review))?.isDirectory()).flatMap((review) => {
      const reviewRoot = path.join(root, review);
      const key = `review-${crypto.createHash('sha256').update(reviewRoot).digest('hex').slice(0, 16)}`;
      return listDir(reviewRoot)
        .filter((name) => /^round-\d+$/.test(name) && statOrNull(path.join(reviewRoot, name))?.isDirectory())
        .map((name) => ({ review: key, round: Number(name.slice('round-'.length)) }));
    });
  } catch (error) {
    unavailable.push(`rounds: ${readErrorReason(error)}`);
    return [];
  }
}

// SECTION: Host usage

function hostEnvOf(options: MeasureOptions, host: string, hostId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.env, HOME: options.home, USERPROFILE: options.home };
  for (const name of HOST_SESSION_ENV[host] ?? []) env[name] = hostId;
  return env;
}

function hostTokensOf(host: HostUsageFacts): number {
  return host.rows.filter((row) => row.role === 'host').reduce((total, row) => total + billedTokens(row, host.platform ?? '', row.reasoningInOutput), 0);
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// SECTION: Denials

const zeroCounts = (): DenialCounts => ({ config: 0, hook: 0, other: 0 });

/** Same location rule as the Claude usage reader: the newest `<projects>/<dir>/<id>.jsonl`. */
function claudeTranscript(hostId: string, env: NodeJS.ProcessEnv, home: string): string | null {
  const root = path.join(env['CLAUDE_CONFIG_DIR'] || path.join(home, '.claude'), 'projects');
  const candidates = listDir(root).flatMap((dir) => {
    const file = path.join(root, dir, `${hostId}.jsonl`);
    const stat = statOrNull(file);
    return stat?.isFile() ? [{ file, mtimeMs: stat.mtimeMs }] : [];
  });
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file ?? null;
}

function subagentTranscripts(dir: string): string[] {
  return listDir(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)).filter((file) => statOrNull(file)?.isFile());
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Counts lines with a `toolDenialKind` field in the host transcript and its subagent transcripts. */
function denialsOf(host: string, hostId: string, context: { env: NodeJS.ProcessEnv; home: string }, window: { startMs: number; endMs: number }): Denials {
  if (host !== 'claude') return { unavailable: 'no denial marker' };
  if (!validSessionId(hostId)) return { unavailable: 'invalid host id' };
  try {
    const transcript = claudeTranscript(hostId, context.env, context.home);
    if (!transcript) return { unavailable: 'host transcript missing' };
    const headline = zeroCounts(), inWindow = zeroCounts();
    for (const file of [transcript, ...subagentTranscripts(path.join(path.dirname(transcript), hostId, 'subagents'))]) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const entry = parseLine(line);
        if (!entry || !Object.hasOwn(entry, 'toolDenialKind')) continue;
        const permission = entry['permissionDecision'];
        const source = isRecord(permission) ? permission['source'] : undefined;
        const bucket = source === 'config' || source === 'hook' ? source : 'other';
        headline[bucket]++;
        const at = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
        if (at >= window.startMs && at <= window.endMs) inWindow[bucket]++;
      }
    }
    return { ...headline, inWindow };
  } catch (error) {
    return { unavailable: readErrorReason(error) };
  }
}

// SECTION: Measurement

function loadPricer(pricing: { path: string; text: string }): Pricer {
  let table: unknown;
  try {
    table = JSON.parse(stripBom(pricing.text));
  } catch {
    throw new Error(`pricing file is not valid JSON: ${pricing.path}`);
  }
  // NOTE: no config override: every run is priced with the same table, so per-controller overrides stay out of the comparison.
  const pricer = resolvePricing(table, undefined);
  if (!pricer) throw new Error(`pricing file has an unsupported table: ${pricing.path}`);
  return pricer;
}

function measureSide(pair: string, side: PairSide, options: MeasureOptions, pricer: Pricer): SideResult {
  const where = `pair "${pair}" side "${side.label}"`;
  const given = path.resolve(options.baseDir, side.session);
  const folder = folderOf(given, where);
  const manifest = manifestOf(folder, where);
  const nativeId = side.nativeId ?? manifest.sessionId;
  const startMs = Date.parse(manifest.createdAt);
  const endMs = latestCaptureEnd(folder) ?? startMs;
  const unavailable: string[] = [];
  const fold = foldOf(folder, unavailable);
  const env = hostEnvOf(options, side.host, nativeId);
  // NOTE: sessionFacts reads only these four CliDeps members on the measurement path.
  const deps = {
    orchestrator: orchestratorFor(side.host, (name) => options.env[name]),
    env,
    clock: () => endMs,
    hostUsageFs: nodeHostUsageFs,
  } as unknown as CliDeps;
  const measure = (session: string) => sessionFacts(session, fold, OUTCOME, { manifest, deps });

  let run = measure(folder);
  let pathForm: PathForm = 'canonical';
  let measured = folder;
  // NOTE: round subjects hash the session string, so captures recorded from another path form need the path as given.
  if (given !== folder && (run.roundWorkload ?? []).length > 0 && !hasCalls(run)) {
    const asGiven = measure(given);
    if (hasCalls(asGiven)) {
      run = asGiven;
      pathForm = 'as-given';
      measured = given;
    }
  }

  const host = run.hostUsage;
  if (!host) throw new Error(`${where}: host usage was not measured`);
  const hostReason = host.unavailable;
  const hostTokens = hostReason ? undefined : hostTokensOf(host);
  if (hostReason) unavailable.push(`hostTokens: ${hostReason}`);

  const denials = denialsOf(side.host, nativeId, { env, home: options.home }, { startMs, endMs });
  if ('unavailable' in denials) unavailable.push(`denials: ${denials.unavailable}`);

  const facts = sanitizeFacts(run);
  const { total, priced, unpriced, coverage, rateBasis } = costCoverage([facts], pricer);
  // Host-role notes only: a subagent note marks cost partial but leaves the host-token cell unflagged.
  const hostRoleNotes = Object.keys(host.notes?.host ?? {}).sort();
  if (hostRoleNotes.length) unavailable.push(`${HOST_TOKENS_PARTIAL} ${hostRoleNotes.join(', ')}`);
  if (!total.priced) unavailable.push('cost: no priced unit');

  const done = new Set((run.reviews).map((review) => roundKey(review.phase ?? '', review.round)));
  // Rounds without a readable result stay out of the totals and are named once: unfinished or corrupt-findings rows first,
  // then round folders whose round.json never reached roundWorkload.
  const named = new Set<string>();
  const excluded = (review: string, round: number) => {
    const key = roundKey(review, round);
    if (done.has(key) || named.has(key)) return;
    named.add(key);
    unavailable.push(`rounds: ${review} ${round} excluded: no readable round result`);
  };
  for (const row of run.roundWorkload ?? []) excluded(row.review, row.round);
  for (const folder of roundFolders(measured, unavailable)) excluded(folder.review, folder.round);
  const captures = run.collection?.partial ?? 0;
  if (captures > 0) unavailable.push(`${CALLS_PARTIAL} captures partial (${captures})`, `${HOST_TOKENS_PARTIAL} captures partial (${captures})`);
  const rows = (run.roundWorkload ?? [])
    .filter((row) => done.has(roundKey(row.review, row.round)))
    .sort((a, b) => a.review.localeCompare(b.review) || a.round - b.round);
  const perRound: PerRound[] = [];
  for (const row of rows) {
    perRound.push({
      review: row.review, round: row.round,
      ...(row.calls ? { calls: row.calls.total } : {}),
      ...(row.hostTokens === undefined ? {} : { hostTokens: row.hostTokens }),
      ...(row.hostTurns === undefined ? {} : { hostTurns: row.hostTurns }),
    });
    if (!row.calls) unavailable.push(`perRound: ${row.review} ${row.round} calls: no round starts`);
    if (row.hostTurns === undefined) {
      const reason = hostRoleNotes.length ? 'partial: ' + hostRoleNotes.join(', ') : hostReason ?? 'no turn data';
      unavailable.push('perRound: ' + row.review + ' ' + row.round + ' hostTurns: ' + (row.calls ? reason : 'no round starts'));
    }
    if (row.hostTokens === undefined) {
      unavailable.push(`perRound: ${row.review} ${row.round} hostTokens: ${row.calls ? hostReason ?? 'no usage records' : 'no round starts'}`);
    }
  }
  const byReview: Record<string, number> = {};
  for (const row of rows) byReview[row.review] = (byReview[row.review] ?? 0) + 1;

  const { responses: _responses, ...efficiency } = efficiencyOf([facts], pricer);
  const verification = verificationOf(folder, side.reportComplete);
  const timing = new Map(efficiency.criticalPath.map(span => [roundKey(span.review, span.round), span]));
  const criticalPath = perRound.map(({ review, round }) => timing.get(roundKey(review, round)) ??
    { review, round, elapsedMs: null, finishingSlot: null });
  return {
    label: side.label, session: measured, host: side.host, nativeId,
    window: { startMs, endMs, pathForm },
    rounds: { total: rows.length, byReview },
    perRound,
    ...(hostTokens === undefined ? {} : { hostTokens }),
    denials,
    cost: {
      low: total.low, high: total.high, priced: total.priced, reasons: coverage.reasons, partial: coverage.partial,
      pricedUnits: priced, unpricedUnits: unpriced, coverage, rateBasis,
    },
    unavailable,
    efficiency: { ...efficiency, criticalPath, verification },
  };
}

function pairedComparisonLimits(sides: readonly SideResult[]): string[] {
  if (sides.length < 2) return [];
  const costs = sides.map((side) => side.cost);
  const differs = (value: (cost: SideResult['cost']) => unknown) => new Set(costs.map(cost => JSON.stringify(value(cost)))).size > 1;
  const limits: string[] = [];
  if (differs(cost => cost.rateBasis.periods)) limits.push('effective tariff periods differ');
  if (differs(cost => [cost.rateBasis.origins, cost.rateBasis.matches])) limits.push('rate origins or matches differ');
  if (differs(cost => [
    cost.coverage.partial, cost.coverage.reasons,
    Object.entries(cost.coverage.sources).filter(([, count]) => count > 0).map(([source]) => source),
  ])) limits.push('usage coverage differs');
  if (costs.some(cost => !cost.priced)) limits.push('priced subtotal unavailable');

  const evidence = sides.map(side => side.efficiency);
  const responseScope = evidence.map(({ responseEvents }) => responseEvents.byStageRole.map(({ stage, role, basis, observed, matchedObserved, coverage }) =>
    JSON.stringify([stage, role, basis, coverage, matchedObserved === null ? 'none' : matchedObserved === observed ? 'all observed' : 'some observed'])).sort());
  if (new Set(responseScope.map(scope => JSON.stringify(scope))).size > 1) limits.push('response event basis or coverage differs');
  if (evidence.some(({ uncachedInputPerResponse }) => uncachedInputPerResponse === null)) limits.push('matched response ratio unavailable');
  if (evidence.some(({ criticalPath }) => criticalPath.some(span => span.elapsedMs === null))) limits.push('CLI attempt span unavailable');
  if (evidence.some(({ reviewOutcomes }) => reviewOutcomes === null || reviewOutcomes.recurring === null)) limits.push('review outcome evidence unavailable');
  const workloads = sides.map(side => JSON.stringify({
    rounds: Object.values(side.rounds.byReview).sort((a, b) => a - b),
    calls: side.perRound.map(row => row.calls ?? null).sort(),
    review: side.efficiency.reviewOutcomes,
  }));
  if (new Set(workloads).size > 1) limits.push('review workload or outcomes differ');
  if (sides.some(side => flagged(side, CALLS_PARTIAL) || side.perRound.some(row => row.calls === undefined))) limits.push('review workload evidence unavailable');

  const verified = evidence.flatMap(({ verification }) => verification ? [verification.criteria] : []);
  if (verified.length !== evidence.length) limits.push('verification evidence unavailable');
  if (new Set(verified.map(criteria => JSON.stringify(criteria.map(({ id }) => id)))).size > 1) {
    limits.push('verification criteria differ');
  } else if (new Set(verified.map(criteria => JSON.stringify(criteria))).size > 1) {
    limits.push('verification states differ');
  }
  return limits;
}

/** Measures every side of every pair; throws naming the side when its folder or manifest is invalid. */
export function measureRuns(input: PairsFile, options: MeasureOptions): Comparison {
  const pricer = loadPricer(options.pricing);
  return {
    pricing: { path: options.pricing.path, asOf: pricer.meta.asOf },
    generatedAt: new Date().toISOString(),
    pairs: input.pairs.map((pair) => {
      const sides = pair.sides.map((side) => measureSide(pair.name, side, options, pricer));
      return { name: pair.name, sides, comparisonLimits: pairedComparisonLimits(sides) };
    }),
    confounds: input.confounds,
  };
}

// SECTION: Rendering

const withPartial = (text: string, partial: boolean) => partial ? `${text} (partial)` : text;
const flagged = (side: SideResult, prefix: string) => side.unavailable.some((entry) => entry.startsWith(prefix));

const sumOf = (values: (number | undefined)[]) => values.length === 0 || values.some((value) => value === undefined)
  ? '—'
  : String(values.reduce<number>((total, value) => total + (value ?? 0), 0));

function denialText(side: SideResult): string {
  const denials = side.denials;
  return 'unavailable' in denials ? `— (${denials.unavailable})` : `${denials.config} / ${denials.hook} / ${denials.other}`;
}

function costText(side: SideResult): string {
  const text = formatCost({ low: side.cost.low, high: side.cost.high, priced: side.cost.priced, reasons: new Set<CostReason>() });
  return side.cost.partial && side.cost.priced ? `${text} (partial)` : text;
}

function rateBasisText({ cost: { rateBasis } }: SideResult): string {
  const labels = (values: readonly (string | null)[], fallback: string) => values.map(value => value ?? fallback).join(', ') || '—';
  const origins = Object.entries(rateBasis.originCounts).filter(([, count]) => count).map(([origin, count]) => `${count} ${origin}`).join(', ');
  const matches = Object.entries(rateBasis.matchCounts).filter(([, count]) => count).map(([match, count]) => `${count} ${match}`).join(', ');
  return `UTC day ${labels(rateBasis.effectiveDays, 'base-rate fallback')} · effective period ${labels(rateBasis.periods, 'base rate')} · ${origins || 'origin unavailable'} · ${matches || 'match unavailable'}`;
}

/** Markdown view of the comparison: one metric table per pair, per-round rows, then confounds and pricing. */
export function renderComparison(comparison: Comparison): string {
  const lines = ['# Matched measurement comparison', '', `Generated ${comparison.generatedAt}. Results are advisory; no value gates delivery.`, ''];
  for (const pair of comparison.pairs) {
    const sides = pair.sides;
    const metric = (label: string, cell: (side: SideResult) => string) => `| ${label} | ${sides.map(cell).join(' | ')} |`;
    lines.push(`## ${pair.name}`, '', `| Metric | ${sides.map((side) => side.label).join(' | ')} |`, `| --- | ${sides.map(() => '---:').join(' | ')} |`);
    lines.push(metric('Rounds', (side) => String(side.rounds.total)));
    lines.push(metric('Calls in rounds', (side) => withPartial(sumOf(side.perRound.map((row) => row.calls)), flagged(side, CALLS_PARTIAL))));
    lines.push(metric('Host tokens in rounds', (side) => withPartial(sumOf(side.perRound.map((row) => row.hostTokens)), flagged(side, HOST_TOKENS_PARTIAL))));
    lines.push(metric('Denials (config / hook / other)', denialText));
    lines.push(metric('Cost (USD)', costText));
    if (sides.length >= 2 && !pair.comparisonLimits.length) lines.push(metric('Comparable priced subtotal (USD)', costText));
    lines.push(metric('Cost coverage', ({ cost }) => [
      cost.partial ? 'partial' : 'complete for observed scope', `${cost.pricedUnits} priced, ${cost.unpricedUnits} unpriced`,
      ...cost.coverage.reasons,
    ].join(' · ')));
    lines.push(metric('Delegate usage source', ({ cost }) => Object.entries(cost.coverage.sources)
      .filter(([, count]) => count).map(([source, count]) => `${count} ${source}`).join(', ') || 'no recorded launches'));
    lines.push(metric('Rate basis', rateBasisText));
    lines.push(metric('Response events', ({ efficiency: { responseEvents } }) =>
      `${responseEvents.observed ?? 'unavailable'} observed · ${responseEvents.coverage} · ${responseEvents.matchedObserved ?? 'unavailable'} matched`));
    lines.push(metric('Uncached input / matched response', ({ efficiency }) =>
      efficiency.uncachedInputPerResponse === null ? 'unavailable'
        : `${efficiency.uncachedInputPerResponse.toFixed(2)} · ${efficiency.matchedUncachedInput} input / ${efficiency.responseEvents.matchedObserved} events`));
    lines.push(metric('Recovery (extra CLI / superseded CLI / writer relaunches)', ({ efficiency: { recovery } }) =>
      `${recovery.extraLaunches ?? '—'} / ${recovery.reworkLaunches ?? '—'} / ${recovery.writerRelaunches ?? '—'} · ${recovery.coverage}`));
    lines.push(metric('Retry and rework costs by cause', ({ efficiency: { recovery } }) =>
      Object.entries(recovery.byCause).map(([cause, { count, cost }]) =>
        `${cause} ${count} (${cost ? withPartial(formatCost({ ...cost, priced: true, reasons: new Set() }), cost.partial) : 'unavailable'})`).join(' · ') || '—'));
    lines.push(metric('Review finding occurrences', ({ efficiency: { reviewOutcomes } }) => reviewOutcomes
      ? `${reviewOutcomes.accepted} accepted · ${reviewOutcomes.rejected} rejected · ${reviewOutcomes.recurring ?? 'unavailable'} recurring` : 'unavailable'));
    lines.push(metric('Verification', ({ efficiency: { verification } }) => verification
      ? VERIFICATION_STATES.map(state => `${verification[state]} ${state}`).concat(verification.criteria.map(({ id, state }) => `${id} ${state}`)).join(' · ')
      : 'unavailable'));
    if (pair.comparisonLimits.length) lines.push('', `Comparison limits — ${pair.comparisonLimits.join(', ')}`);
    lines.push('', '### Per-round', '', '| Side | Review | Round | Calls | Host tokens | Host turns |', '| --- | --- | ---: | ---: | ---: | ---: |');
    for (const side of sides) {
      for (const row of side.perRound) lines.push(`| ${side.label} | ${row.review} | ${row.round} | ${row.calls ?? '—'} | ${row.hostTokens ?? '—'} | ${row.hostTurns ?? 'unavailable'} |`);
    }
    lines.push('', '### Response evidence by stage and role', '',
      '| Side | Stage | Role | Event basis | Observed | Coverage | Matched events | Matched input | Input / matched response |',
      '| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: |');
    for (const side of sides) {
      for (const row of side.efficiency.responseEvents.byStageRole) {
        lines.push(`| ${side.label} | ${row.stage} | ${row.role} | ${row.basis} | ${row.observed ?? '—'} | ${row.coverage} | ${row.matchedObserved ?? '—'} | ${row.matchedUncachedInput ?? '—'} | ${row.uncachedInputPerResponse?.toFixed(2) ?? '—'} |`);
      }
    }
    lines.push('', '### Review CLI attempt spans', '',
      'Spans cover current-generation CLI launches, including retry gaps. Native completion timing is unavailable.', '',
      '| Side | Review | Round | CLI span | Finishing logical slot |', '| --- | --- | ---: | ---: | --- |');
    for (const side of sides) {
      for (const span of side.efficiency.criticalPath) {
        lines.push(`| ${side.label} | ${span.review} | ${span.round} | ${formatDuration(span.elapsedMs ?? undefined)} | ${span.finishingSlot ?? '—'} |`);
      }
    }
    const gaps = sides.flatMap((side) => side.unavailable.map((entry) => `- ${side.label}: ${entry}`));
    if (gaps.length) lines.push('', 'Unavailable:', ...gaps);
    lines.push('');
  }
  lines.push('## Confounds', '', ...comparison.confounds.map((line) => `- ${line}`), '');
  lines.push(`Pricing: \`${comparison.pricing.path}\` as of ${comparison.pricing.asOf}; one table reprices every run.`, '');
  return lines.join('\n');
}

// SECTION: Output guard

/** Realpath of the nearest existing ancestor, with the folders that do not exist yet re-attached. */
function canonicalPath(target: string): string {
  const missing: string[] = [];
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
}

const isWithin = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

// NOTE: each root repeats its usage adapter's rule (claude.ts, codex.ts, agy.ts, opencode-db.ts); a new store needs a row here.
function hostStoreRoots(home: string, env: NodeJS.ProcessEnv): string[] {
  return [
    env['CLAUDE_CONFIG_DIR'] || path.join(home, '.claude'),
    env['CODEX_HOME'] || path.join(home, '.codex'),
    env['ANTIGRAVITY_APP_DATA_DIR'] || path.join(home, '.gemini', 'antigravity'),
    path.join(env['XDG_DATA_HOME'] || path.join(home, '.local', 'share'), 'opencode'),
  ];
}

/** Refuses an --out folder inside, or equal to, a measured session folder or a host store; runs before any write. */
function assertOutside(dir: string, comparison: Comparison, home: string, env: NodeJS.ProcessEnv): void {
  const target = canonicalPath(dir);
  const guarded = [
    ...comparison.pairs.flatMap((pair) => pair.sides.map((side) => ({ kind: 'measured session folder', root: side.session }))),
    ...hostStoreRoots(home, env).map((root) => ({ kind: 'host store', root })),
  ];
  for (const { kind, root } of guarded) {
    if (isWithin(target, canonicalPath(root))) throw new Error(`--out must not be inside or equal a ${kind}: ${root}`);
  }
}

/** Refuses an --out whose comparison files are symbolic links, so no write can follow a link outside --out. */
function assertNoLinkedOutputs(dir: string): void {
  for (const name of ['comparison.json', 'comparison.md']) {
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`--out file is a symbolic link, refusing to overwrite: ${file}`);
  }
}

// SECTION: CLI

export type RunIo = { cwd: string; home: string; env: NodeJS.ProcessEnv; stdout(text: string): void; stderr(text: string): void };

function readFile(file: string, label: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${label} unreadable: ${file}`);
  }
}

/** Runs the maintainer command; returns the process exit code. */
export function runMeasureRuns(argv: readonly string[], io: RunIo): number {
  try {
    const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { out: { type: 'string' } } });
    const out = values.out;
    const [pairsArg] = positionals;
    if (positionals.length !== 1 || !out || pairsArg === undefined) {
      io.stderr(USAGE);
      return 1;
    }
    const pairsFile = path.resolve(io.cwd, pairsArg);
    let input: unknown;
    try {
      input = JSON.parse(stripBom(readFile(pairsFile, 'pairs file')));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`pairs file is not valid JSON: ${pairsFile}`);
      throw error;
    }
    const pairs = parsePairs(input);
    const pricingPath = pairs.pricing ?? DEFAULT_PRICING;
    const pricingText = readFile(path.resolve(io.cwd, pricingPath), 'pricing file');
    const comparison = measureRuns(pairs, {
      baseDir: path.dirname(pairsFile), home: io.home, env: io.env, pricing: { path: pricingPath, text: pricingText },
    });
    const dir = path.resolve(io.cwd, out);
    assertOutside(dir, comparison, io.home, io.env);
    assertNoLinkedOutputs(dir);
    fs.mkdirSync(dir, { recursive: true });
    const jsonFile = path.join(dir, 'comparison.json'), markdownFile = path.join(dir, 'comparison.md');
    fs.writeFileSync(jsonFile, `${JSON.stringify(comparison, null, 2)}\n`);
    fs.writeFileSync(markdownFile, renderComparison(comparison));
    io.stdout(`${jsonFile}\n${markdownFile}\n`);
    return 0;
  } catch (error) {
    io.stderr(`measure-runs: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runMeasureRuns(process.argv.slice(2), {
    cwd: process.cwd(),
    home: os.homedir(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
