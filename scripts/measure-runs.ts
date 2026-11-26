// Matched measurement: reads finished session folders and host transcripts, then writes a per-pair comparison.
// Reads only; the sole writes are comparison.json and comparison.md in --out.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { isRecord } from "../skills/dispatch/scripts/lib/config.ts";
import {
  nodeErrorCode,
  stripBom,
} from "../skills/dispatch/scripts/lib/fs-ext.ts";
import { orchestratorFor } from "../skills/dispatch/scripts/lib/platform.ts";
import {
  formatCost,
  resolvePricing,
} from "../skills/dispatch/scripts/lib/pricing.ts";
import type {
  CostReason,
  Pricer,
} from "../skills/dispatch/scripts/lib/pricing.ts";
import {
  readManifest,
  validSessionId,
} from "../skills/dispatch/scripts/lib/session.ts";
import { agy } from "../skills/dispatch/scripts/lib/usage/agy.ts";
import { claudeCode } from "../skills/dispatch/scripts/lib/usage/claude.ts";
import { codex } from "../skills/dispatch/scripts/lib/usage/codex.ts";
import { nodeHostUsageFs } from "../skills/dispatch/scripts/lib/usage/index.ts";
import { opencode } from "../skills/dispatch/scripts/lib/usage/opencode.ts";
import type { HostUsageFacts } from "../skills/dispatch/scripts/lib/usage/rows.ts";
import type { CliDeps } from "../skills/dispatch/scripts/toolkit/cli.ts";
import { sessionFacts } from "../skills/dispatch/scripts/toolkit/diagnostics.ts";
import {
  billedTokens,
  costCoverage,
  efficiencyOf,
  formatDuration,
  sanitizeFacts,
} from "../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import { foldLedger } from "../skills/dispatch/scripts/toolkit/ledger.ts";

// SECTION: Types
export interface PairSide {
  label: string;
  session: string;
  host: string;
  nativeId?: string;
  reportComplete?: string;
}

export interface Pair {
  name: string;
  sides: PairSide[];
}

export interface PairsFile {
  pricing?: string;
  pairs: Pair[];
  confounds: string[];
}

export interface MeasureOptions {
  baseDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  pricing: { path: string; text: string };
}

export type PathForm = "canonical" | "as-given";

export interface DenialCounts {
  config: number;
  hook: number;
  other: number;
}

export type Denials =
  | (DenialCounts & { inWindow: DenialCounts })
  | { unavailable: string };

export interface PerRound {
  review: string;
  round: number;
  calls?: number;
  hostTokens?: number;
  hostTurns?: number;
}

type CostCoverage = ReturnType<typeof costCoverage>;

const VERIFICATION_STATES = [
  "verified",
  "manual",
  "waived",
  "missing",
] as const;

type VerificationState = (typeof VERIFICATION_STATES)[number];

type Verification = Record<VerificationState, number> & {
  criteria: { id: string; state: VerificationState }[];
};

type Efficiency = Omit<ReturnType<typeof efficiencyOf>, "responses"> & {
  verification: Verification | null;
};

export interface SideResult {
  label: string;
  session: string;
  host: string;
  nativeId: string;
  window: { startMs: number; endMs: number; pathForm: PathForm };
  rounds: { total: number; byReview: Record<string, number> };
  perRound: PerRound[];
  hostTokens?: number;
  denials: Denials;
  cost: {
    low: number;
    high: number;
    priced: boolean;
    reasons: string[];
    partial: boolean;
    pricedUnits: number;
    unpricedUnits: number;
    coverage: CostCoverage["coverage"];
    rateBasis: CostCoverage["rateBasis"];
  };
  unavailable: string[];
  efficiency: Efficiency;
}

export interface Comparison {
  pricing: { path: string; asOf: string };
  generatedAt: string;
  pairs: {
    name: string;
    sides: SideResult[];
    comparisonLimits: string[];
  }[];
  confounds: string[];
}

const DEFAULT_PRICING = "skills/dispatch/references/pricing.json";
const OUTCOME = "measured";
const USAGE = "Usage: node scripts/measure-runs.ts <pairs.json> --out <dir>\n";

// NOTE: each adapter's env names receive the side's host id, so the adapter's first match is that id.
const HOST_SESSION_ENV: ReadonlyMap<string, readonly string[]> = new Map([
  ["claude", claudeCode.sessionEnv],
  ["agy", agy.sessionEnv],
  ["codex", codex.sessionEnv],
  ["opencode", opencode.sessionEnv],
]);

const isStringValue = (value: unknown): value is string =>
  typeof value === "string";

const isNumberValue = (value: unknown): value is number =>
  typeof value === "number";

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes(nodeErrorCode(error) ?? "");

const readErrorReason = (error: unknown) =>
  `read-error:${nodeErrorCode(error) ?? "EUNKNOWN"}`;

const roundKey = (review: string, round: number) => `${review}\u0000${round}`;

// NOTE: these prefixes are the contract between measureSide and the markdown flags; renderComparison matches on them.
const CALLS_PARTIAL = "perRound calls partial:";
const HOST_TOKENS_PARTIAL = "hostTokens partial:";

// SECTION: Input

const sideOf = (value: unknown, where: string) => {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object`);
  }

  const { label, session, host, nativeId, reportComplete } = value;

  if (
    !isStringValue(label) ||
    !isStringValue(session) ||
    !isStringValue(host)
  ) {
    throw new Error(`${where} needs label, session and host strings`);
  }

  // oxlint-disable-next-line eslint/no-empty-function -- probe call; the empty callback is never invoked for known hosts.
  if (orchestratorFor(host, () => {}) === null) {
    throw new Error(`${where} host is not a known host: ${host}`);
  }

  if (nativeId !== undefined && !isStringValue(nativeId)) {
    throw new Error(`${where} nativeId must be a string`);
  }

  return {
    label,
    session,
    host,
    ...(isStringValue(nativeId) && { nativeId }),
    ...(isStringValue(reportComplete) && { reportComplete }),
  };
};

const pairOf = (value: unknown, where: string) => {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object`);
  }

  const name: unknown = value["name"];
  const sides: unknown = value["sides"];

  if (!isStringValue(name) || !name || !Array.isArray(sides) || !sides.length) {
    throw new Error(`${where} needs a name and a non-empty sides array`);
  }

  return {
    name,
    sides: sides.map((side: unknown, index: number) =>
      sideOf(side, `${where} sides[${index}]`)
    ),
  };
};

/** Validates pairs.json; a relative `session` resolves later against the pairs.json folder. */
export const parsePairs = (input: unknown) => {
  if (!isRecord(input)) {
    throw new Error("pairs file must be an object");
  }

  const list: unknown = input["pairs"];

  if (!Array.isArray(list) || !list.length) {
    throw new Error('pairs file needs a non-empty "pairs" array');
  }

  const pricing: unknown = input["pricing"];
  const confounds: unknown = input["confounds"] ?? [];

  if (pricing !== undefined && !isStringValue(pricing)) {
    throw new Error("pricing must be a path string");
  }

  if (
    !Array.isArray(confounds) ||
    !confounds.every((line) => isStringValue(line))
  ) {
    throw new Error("confounds must be an array of strings");
  }

  return {
    ...(isStringValue(pricing) && { pricing }),
    pairs: list.map((pair: unknown, index: number) =>
      pairOf(pair, `pairs[${index}]`)
    ),
    confounds,
  };
};

// SECTION: Session facts

const REPORT_PATH =
  /^\.state\/results\/report-complete-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.json$/iu;

const MAX_REPORT_BYTES = 1024 * 1024;

const readReportResult = (session: string, relative: string) => {
  const results = fs.realpathSync.native(
    path.join(session, ".state", "results")
  );

  const file = fs.realpathSync.native(path.join(session, relative));

  if (
    results === session ||
    !isWithin(results, session) ||
    !isWithin(file, results) ||
    !fs.statSync(file).isFile()
  ) {
    return null;
  }

  const fd = fs.openSync(file, "r");
  let result: unknown;

  try {
    const stat = fs.fstatSync(fd);

    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) {
      return null;
    }

    const data = Buffer.allocUnsafe(stat.size + 1);
    let read = 0;

    while (read < data.length) {
      const bytes = fs.readSync(fd, data, read, data.length - read, null);

      if (bytes === 0) {
        break;
      }

      read += bytes;
    }

    if (read !== stat.size) {
      return null;
    }

    result = JSON.parse(stripBom(data.toString("utf-8", 0, read)));
  } finally {
    fs.closeSync(fd);
  }

  return isRecord(result) ? result : null;
};

const tallyVerification = (
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- report JSON boundary; narrowing a parsed report object.
  result: Record<string, unknown>
) => {
  const { delivered, statuses } = result;

  if (
    !isRecord(delivered) ||
    !isStringValue(delivered["source"]) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(delivered["source"]) ||
    !Array.isArray(statuses)
  ) {
    return null;
  }

  const verification: Verification = {
    verified: 0,
    manual: 0,
    waived: 0,
    missing: 0,
    criteria: [],
  };

  const seen = new Set<string>();

  for (const status of statuses) {
    if (!isRecord(status) || !isStringValue(status["criterion"])) {
      return null;
    }

    const id = status["criterion"];

    const state = VERIFICATION_STATES.find(
      (candidate) => candidate === status["state"]
    );

    if (
      state === undefined ||
      id === "" ||
      seen.has(id) ||
      (id !== "contract" && !/^SC[1-9]\d*$/u.test(id))
    ) {
      return null;
    }

    seen.add(id);

    if (id === "contract") {
      continue;
    }

    verification[state] += 1;
    verification.criteria.push({ id, state });
  }

  verification.criteria.sort((a, b) => a.id.localeCompare(b.id));

  return verification;
};

const verificationOf = (session: string, relative: string | undefined) => {
  if (
    relative === undefined ||
    relative === "" ||
    !REPORT_PATH.test(relative) ||
    relative.includes("\n") ||
    relative.includes("\r")
  ) {
    return null;
  }

  try {
    const result = readReportResult(session, relative);

    if (result === null) {
      return null;
    }

    return tallyVerification(result);
  } catch {
    return null;
  }
};

const folderOf = (given: string, where: string) => {
  try {
    const folder = fs.realpathSync.native(given);

    if (fs.statSync(folder).isDirectory()) {
      return folder;
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error(
        `${where}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  throw new Error(`${where}: session folder missing: ${given}`);
};

const manifestOf = (folder: string, where: string) => {
  try {
    return readManifest(folder);
  } catch (error) {
    throw new Error(
      `${where}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

const foldOf = (folder: string, unavailable: string[]) => {
  try {
    return foldLedger(folder);
  } catch (error) {
    unavailable.push(
      `ledger: ${error instanceof Error ? error.message : String(error)}`
    );

    return { records: [], lastSeq: 0, torn: null };
  }
};

const listDir = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
};

const statOrNull = (file: string) => {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }

    throw error;
  }
};

/** Latest `capture.end` across the session's diagnostics; an empty window when none exists. */
const latestCaptureEnd = (folder: string) => {
  let latest: number | undefined;

  try {
    for (const name of listDir(path.join(folder, ".state", "diagnostics"))) {
      if (!name.endsWith(".json")) {
        continue;
      }

      let raw: unknown;

      try {
        raw = JSON.parse(
          stripBom(
            fs.readFileSync(
              path.join(folder, ".state", "diagnostics", name),
              "utf-8"
            )
          )
        );
      } catch {
        continue;
      }

      const capture = isRecord(raw) ? raw["capture"] : undefined;
      const end = isRecord(capture) ? capture["end"] : undefined;

      if (isNumberValue(end) && Number.isFinite(end)) {
        latest = Math.max(latest ?? end, end);
      }
    }
  } catch {
    // NOTE: an unreadable diagnostics folder is reported by sessionFacts as a partial collection.
    latest = undefined;
  }

  return latest;
};

const hasCalls = (run: { roundWorkload?: { calls?: unknown }[] }) =>
  (run.roundWorkload ?? []).some((row) => row.calls !== undefined);

/** Round folders `<session>/.state/reviews/<review>/round-<n>`, keyed as sessionFacts keys them; the number comes from the folder name because round.json may be unreadable. */
const roundFolders = (session: string, unavailable: string[]) => {
  const root = path.join(session, ".state", "reviews");

  try {
    return listDir(root)
      .filter(
        (review) => statOrNull(path.join(root, review))?.isDirectory() === true
      )
      .flatMap((review) => {
        const reviewRoot = path.join(root, review);
        const key = `review-${crypto.createHash("sha256").update(reviewRoot).digest("hex").slice(0, 16)}`;

        return listDir(reviewRoot)
          .filter(
            (name) =>
              /^round-\d+$/u.test(name) &&
              statOrNull(path.join(reviewRoot, name))?.isDirectory() === true
          )
          .map((name) => ({
            review: key,
            round: Number(name.slice("round-".length)),
          }));
      });
  } catch (error) {
    unavailable.push(`rounds: ${readErrorReason(error)}`);

    return [];
  }
};

// SECTION: Host usage

const hostEnvOf = (options: MeasureOptions, host: string, hostId: string) => {
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    HOME: options.home,
    USERPROFILE: options.home,
  };

  for (const name of HOST_SESSION_ENV.get(host) ?? []) {
    env[name] = hostId;
  }

  return env;
};

const hostTokensOf = (host: HostUsageFacts) =>
  host.rows
    .filter((row) => row.role === "host")
    .reduce(
      (total, row) =>
        total + billedTokens(row, host.platform ?? "", row.reasoningInOutput),
      0
    );

// SECTION: Denials

const zeroCounts = () => ({ config: 0, hook: 0, other: 0 });

/** Same location rule as the Claude usage reader: the newest `<projects>/<dir>/<id>.jsonl`. */
const claudeTranscript = (
  hostId: string,
  env: NodeJS.ProcessEnv,
  home: string
) => {
  const configured = env["CLAUDE_CONFIG_DIR"];

  const root = path.join(
    configured !== undefined && configured !== ""
      ? configured
      : path.join(home, ".claude"),
    "projects"
  );

  const candidates = listDir(root).flatMap((dir) => {
    const file = path.join(root, dir, `${hostId}.jsonl`);
    const stat = statOrNull(file);

    return stat?.isFile() === true ? [{ file, mtimeMs: stat.mtimeMs }] : [];
  });

  return candidates.toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file ?? null;
};

const subagentTranscripts = (dir: string) =>
  listDir(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dir, name))
    .filter((file) => statOrNull(file)?.isFile() === true);

const parseLine = (line: string) => {
  if (!line.trim()) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(line);

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/** Counts lines with a `toolDenialKind` field in the host transcript and its subagent transcripts. */
const denialsOf = (
  host: string,
  hostId: string,
  context: { env: NodeJS.ProcessEnv; home: string },
  window: { startMs: number; endMs: number }
) => {
  if (host !== "claude") {
    return { unavailable: "no denial marker" };
  }

  if (validSessionId(hostId) === null) {
    return { unavailable: "invalid host id" };
  }

  try {
    const transcript = claudeTranscript(hostId, context.env, context.home);

    if (transcript === null) {
      return { unavailable: "host transcript missing" };
    }

    const headline = zeroCounts();
    const inWindow = zeroCounts();

    for (const file of [
      transcript,
      ...subagentTranscripts(
        path.join(path.dirname(transcript), hostId, "subagents")
      ),
    ]) {
      for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
        const entry = parseLine(line);

        if (entry === null || !Object.hasOwn(entry, "toolDenialKind")) {
          continue;
        }

        const permission = entry["permissionDecision"];
        const source = isRecord(permission) ? permission["source"] : undefined;

        const bucket =
          source === "config" || source === "hook" ? source : "other";

        headline[bucket] += 1;

        const at = isStringValue(entry["timestamp"])
          ? Date.parse(entry["timestamp"])
          : Number.NaN;

        if (at >= window.startMs && at <= window.endMs) {
          inWindow[bucket] += 1;
        }
      }
    }

    return { ...headline, inWindow };
  } catch (error) {
    return { unavailable: readErrorReason(error) };
  }
};

// SECTION: Measurement

// NOTE: sessionFacts reads only orchestrator, env, clock and hostUsageFs here; any other runtime use fails loudly.
const unused = (): never => {
  throw new Error("measure-runs has no CLI runtime");
};

const UNUSED_CLI_DEPS = {
  delegate: unused,
  modes: unused,
  liveness: {},
  run: unused,
  stdout: unused,
  sleep: unused,
  isAlive: unused,
  pid: 0,
  host: "",
  skillRoot: "",
} satisfies Partial<CliDeps>;

const loadPricer = (pricing: { path: string; text: string }) => {
  let table: unknown;

  try {
    table = JSON.parse(stripBom(pricing.text));
  } catch {
    throw new Error(`pricing file is not valid JSON: ${pricing.path}`);
  }

  // NOTE: no config override: every run is priced with the same table, so per-controller overrides stay out of the comparison.
  const pricer = resolvePricing(table, undefined);

  if (!pricer) {
    throw new Error(`pricing file has an unsupported table: ${pricing.path}`);
  }

  return pricer;
};

const measureSide = (
  pair: string,
  side: PairSide,
  options: MeasureOptions,
  pricer: Pricer
) => {
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

  const deps: CliDeps = {
    ...UNUSED_CLI_DEPS,
    orchestrator: orchestratorFor(side.host, (name) => options.env[name]),
    env,
    clock: () => endMs,
    hostUsageFs: nodeHostUsageFs,
  };

  const measure = (session: string) =>
    sessionFacts(session, fold, OUTCOME, { manifest, deps });

  let run = measure(folder);
  let pathForm: PathForm = "canonical";
  let measured = folder;

  const resolveRun = () => {
    // NOTE: round subjects hash the session string, so captures recorded from another path form need the path as given.
    if (
      given !== folder &&
      (run.roundWorkload ?? []).length > 0 &&
      !hasCalls(run)
    ) {
      const asGiven = measure(given);

      if (hasCalls(asGiven)) {
        run = asGiven;
        pathForm = "as-given";
        measured = given;
      }
    }
  };

  resolveRun();

  const host = run.hostUsage;

  if (host === undefined || host === null) {
    throw new Error(`${where}: host usage was not measured`);
  }

  const hostReason = host.unavailable;
  const hostTokens = hostReason === undefined ? hostTokensOf(host) : undefined;

  if (hostReason !== undefined) {
    unavailable.push(`hostTokens: ${hostReason}`);
  }

  const denials = denialsOf(
    side.host,
    nativeId,
    { env, home: options.home },
    { startMs, endMs }
  );

  if ("unavailable" in denials) {
    unavailable.push(`denials: ${denials.unavailable}`);
  }

  const facts = sanitizeFacts(run);

  const { total, priced, unpriced, coverage, rateBasis } = costCoverage(
    [facts],
    pricer
  );

  // Host-role notes only: a subagent note marks cost partial but leaves the host-token cell unflagged.
  const hostRoleNotes = Object.keys(host.notes?.host ?? {}).toSorted();

  if (hostRoleNotes.length) {
    unavailable.push(`${HOST_TOKENS_PARTIAL} ${hostRoleNotes.join(", ")}`);
  }

  if (!total.priced) {
    unavailable.push("cost: no priced unit");
  }

  const done = new Set(
    run.reviews.map((review) => roundKey(review.phase ?? "", review.round))
  );

  // Rounds without a readable result stay out of the totals and are named once: unfinished or corrupt-findings rows first,
  // then round folders whose round.json never reached roundWorkload.
  const named = new Set<string>();

  const excluded = (review: string, round: number) => {
    const key = roundKey(review, round);

    if (done.has(key) || named.has(key)) {
      return;
    }

    named.add(key);
    unavailable.push(
      `rounds: ${review} ${round} excluded: no readable round result`
    );
  };

  const collectExclusions = () => {
    for (const row of run.roundWorkload ?? []) {
      excluded(row.review, row.round);
    }

    for (const roundFolder of roundFolders(measured, unavailable)) {
      excluded(roundFolder.review, roundFolder.round);
    }
  };

  collectExclusions();

  const captures = run.collection?.partial ?? 0;

  if (captures > 0) {
    unavailable.push(
      `${CALLS_PARTIAL} captures partial (${captures})`,
      `${HOST_TOKENS_PARTIAL} captures partial (${captures})`
    );
  }

  const rows = (run.roundWorkload ?? [])
    .filter((row) => done.has(roundKey(row.review, row.round)))
    .toSorted((a, b) => a.review.localeCompare(b.review) || a.round - b.round);

  const perRound: PerRound[] = [];

  const collectPerRound = () => {
    for (const row of rows) {
      perRound.push({
        review: row.review,
        round: row.round,
        ...(row.calls !== undefined && { calls: row.calls.total }),
        ...(row.hostTokens !== undefined && { hostTokens: row.hostTokens }),
        ...(row.hostTurns !== undefined && { hostTurns: row.hostTurns }),
      });

      if (row.calls === undefined) {
        unavailable.push(
          `perRound: ${row.review} ${row.round} calls: no round starts`
        );
      }

      if (row.hostTurns === undefined) {
        const reason = hostRoleNotes.length
          ? `partial: ${hostRoleNotes.join(", ")}`
          : (hostReason ?? "no turn data");

        unavailable.push(
          `perRound: ${row.review} ${row.round} hostTurns: ${
            row.calls === undefined ? "no round starts" : reason
          }`
        );
      }

      if (row.hostTokens === undefined) {
        unavailable.push(
          `perRound: ${row.review} ${row.round} hostTokens: ${row.calls === undefined ? "no round starts" : (hostReason ?? "no usage records")}`
        );
      }
    }
  };

  collectPerRound();

  const byReview: Record<string, number> = {};

  for (const row of rows) {
    byReview[row.review] = (byReview[row.review] ?? 0) + 1;
  }

  const { responses: _responses, ...efficiency } = efficiencyOf(
    [facts],
    pricer
  );

  const verification = verificationOf(folder, side.reportComplete);

  const timing = new Map(
    efficiency.criticalPath.map((span) => [
      roundKey(span.review, span.round),
      span,
    ])
  );

  const criticalPath = perRound.map(
    ({ review, round }) =>
      timing.get(roundKey(review, round)) ?? {
        review,
        round,
        elapsedMs: null,
        finishingSlot: null,
      }
  );

  const output: SideResult = {
    label: side.label,
    session: measured,
    host: side.host,
    nativeId,
    window: { startMs, endMs, pathForm },
    rounds: { total: rows.length, byReview },
    perRound,
    denials,
    cost: {
      low: total.low,
      high: total.high,
      priced: total.priced,
      reasons: coverage.reasons,
      partial: coverage.partial,
      pricedUnits: priced,
      unpricedUnits: unpriced,
      coverage,
      rateBasis,
    },
    unavailable,
    efficiency: { ...efficiency, criticalPath, verification },
  };

  if (hostTokens !== undefined) {
    output.hostTokens = hostTokens;
  }

  return output;
};

// The default `sort` order (by string form), spelled out: the workload signature only needs a stable order.
const byStringForm = (a: number | null, b: number | null) => {
  const left = String(a);
  const right = String(b);

  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
};

const matchLabel = (observed: unknown, matchedObserved: unknown) => {
  if (matchedObserved === null) {
    return "none";
  }

  if (matchedObserved === observed) {
    return "all observed";
  }

  return "some observed";
};

const pairedComparisonLimits = (sides: readonly SideResult[]) => {
  if (sides.length < 2) {
    return [];
  }

  const costs = sides.map((side) => side.cost);

  const differs = (value: (cost: SideResult["cost"]) => unknown) =>
    new Set(costs.map((cost) => JSON.stringify(value(cost)))).size > 1;

  const limits: string[] = [];

  if (differs((cost) => cost.rateBasis.periods)) {
    limits.push("effective tariff periods differ");
  }

  if (differs((cost) => [cost.rateBasis.origins, cost.rateBasis.matches])) {
    limits.push("rate origins or matches differ");
  }

  if (
    differs((cost) => [
      cost.coverage.partial,
      cost.coverage.reasons,
      Object.entries(cost.coverage.sources)
        .filter(([, count]) => count > 0)
        .map(([source]) => source),
    ])
  ) {
    limits.push("usage coverage differs");
  }

  if (costs.some((cost) => !cost.priced)) {
    limits.push("priced subtotal unavailable");
  }

  const evidence = sides.map((side) => side.efficiency);

  const responseScope = evidence.map(({ responseEvents }) =>
    responseEvents.byStageRole
      .map(({ stage, role, basis, observed, matchedObserved, coverage }) =>
        JSON.stringify([
          stage,
          role,
          basis,
          coverage,
          matchLabel(observed, matchedObserved),
        ])
      )
      .toSorted()
  );

  if (new Set(responseScope.map((scope) => JSON.stringify(scope))).size > 1) {
    limits.push("response event basis or coverage differs");
  }

  if (
    evidence.some(
      ({ uncachedInputPerResponse }) => uncachedInputPerResponse === null
    )
  ) {
    limits.push("matched response ratio unavailable");
  }

  if (
    evidence.some(({ criticalPath }) =>
      criticalPath.some((span) => span.elapsedMs === null)
    )
  ) {
    limits.push("CLI attempt span unavailable");
  }

  if (
    evidence.some(
      ({ reviewOutcomes }) =>
        reviewOutcomes === null || reviewOutcomes.recurring === null
    )
  ) {
    limits.push("review outcome evidence unavailable");
  }

  const workloads = sides.map((side) =>
    JSON.stringify({
      rounds: Object.values(side.rounds.byReview).toSorted((a, b) => a - b),
      calls: side.perRound
        .map((row) => row.calls ?? null)
        .toSorted(byStringForm),
      review: side.efficiency.reviewOutcomes,
    })
  );

  if (new Set(workloads).size > 1) {
    limits.push("review workload or outcomes differ");
  }

  if (
    sides.some(
      (side) =>
        flagged(side, CALLS_PARTIAL) ||
        side.perRound.some((row) => row.calls === undefined)
    )
  ) {
    limits.push("review workload evidence unavailable");
  }

  const verified = evidence.flatMap(({ verification }) =>
    verification ? [verification.criteria] : []
  );

  if (verified.length !== evidence.length) {
    limits.push("verification evidence unavailable");
  }

  if (
    new Set(
      verified.map((criteria) => JSON.stringify(criteria.map(({ id }) => id)))
    ).size > 1
  ) {
    limits.push("verification criteria differ");
  } else if (
    new Set(verified.map((criteria) => JSON.stringify(criteria))).size > 1
  ) {
    limits.push("verification states differ");
  }

  return limits;
};

/** Measures every side of every pair; throws naming the side when its folder or manifest is invalid. */
export const measureRuns = (input: PairsFile, options: MeasureOptions) => {
  const pricer = loadPricer(options.pricing);

  return {
    pricing: { path: options.pricing.path, asOf: pricer.meta.asOf },
    generatedAt: new Date().toISOString(),
    pairs: input.pairs.map((pair) => {
      const sides = pair.sides.map((side) =>
        measureSide(pair.name, side, options, pricer)
      );

      return {
        name: pair.name,
        sides,
        comparisonLimits: pairedComparisonLimits(sides),
      };
    }),
    confounds: input.confounds,
  };
};

// SECTION: Rendering

const withPartial = (text: string, partial: boolean) =>
  partial ? `${text} (partial)` : text;

const flagged = (side: SideResult, prefix: string) =>
  side.unavailable.some((entry) => entry.startsWith(prefix));

const sumOf = (values: (number | undefined)[]) =>
  values.length === 0 || values.some((value) => value === undefined)
    ? "—"
    : String(values.reduce<number>((total, value) => total + (value ?? 0), 0));

const denialText = (side: SideResult) => {
  const { denials } = side;

  return "unavailable" in denials
    ? `— (${denials.unavailable})`
    : `${denials.config} / ${denials.hook} / ${denials.other}`;
};

const costText = (side: SideResult) => {
  const text = formatCost({
    low: side.cost.low,
    high: side.cost.high,
    priced: side.cost.priced,
    reasons: new Set<CostReason>(),
  });

  return side.cost.partial && side.cost.priced ? `${text} (partial)` : text;
};

const labels = (values: readonly (string | null)[], fallback: string) =>
  values.map((value) => value ?? fallback).join(", ") || "—";

const rateBasisText = ({ cost: { rateBasis } }: SideResult) => {
  const origins = Object.entries(rateBasis.originCounts)
    .filter(([, count]) => count)
    .map(([origin, count]) => `${count} ${origin}`)
    .join(", ");

  const matches = Object.entries(rateBasis.matchCounts)
    .filter(([, count]) => count)
    .map(([match, count]) => `${count} ${match}`)
    .join(", ");

  return `UTC day ${labels(rateBasis.effectiveDays, "base-rate fallback")} · effective period ${labels(rateBasis.periods, "base rate")} · ${origins || "origin unavailable"} · ${matches || "match unavailable"}`;
};

/** Markdown view of the comparison: one metric table per pair, per-round rows, then confounds and pricing. */
export const renderComparison = (comparison: Comparison) => {
  const lines = [
    "# Matched measurement comparison",
    "",
    `Generated ${comparison.generatedAt}. Results are advisory; no value gates delivery.`,
    "",
  ];

  for (const pair of comparison.pairs) {
    const { sides } = pair;

    const metric = (label: string, cell: (side: SideResult) => string) =>
      `| ${label} | ${sides.map(cell).join(" | ")} |`;

    lines.push(
      `## ${pair.name}`,
      "",
      `| Metric | ${sides.map((side) => side.label).join(" | ")} |`,
      `| --- | ${sides.map(() => "---:").join(" | ")} |`,
      metric("Rounds", (side) => String(side.rounds.total)),
      metric("Calls in rounds", (side) =>
        withPartial(
          sumOf(side.perRound.map((row) => row.calls)),
          flagged(side, CALLS_PARTIAL)
        )
      ),
      metric("Host tokens in rounds", (side) =>
        withPartial(
          sumOf(side.perRound.map((row) => row.hostTokens)),
          flagged(side, HOST_TOKENS_PARTIAL)
        )
      ),
      metric("Denials (config / hook / other)", denialText),
      metric("Cost (USD)", costText)
    );

    if (sides.length >= 2 && !pair.comparisonLimits.length) {
      lines.push(metric("Comparable priced subtotal (USD)", costText));
    }

    lines.push(
      metric("Cost coverage", ({ cost }) =>
        [
          cost.partial ? "partial" : "complete for observed scope",
          `${cost.pricedUnits} priced, ${cost.unpricedUnits} unpriced`,
          ...cost.coverage.reasons,
        ].join(" · ")
      ),
      metric(
        "Delegate usage source",
        ({ cost }) =>
          Object.entries(cost.coverage.sources)
            .filter(([, count]) => count)
            .map(([source, count]) => `${count} ${source}`)
            .join(", ") || "no recorded launches"
      ),
      metric("Rate basis", rateBasisText),
      metric(
        "Response events",
        ({ efficiency: { responseEvents } }) =>
          `${responseEvents.observed ?? "unavailable"} observed · ${responseEvents.coverage} · ${responseEvents.matchedObserved ?? "unavailable"} matched`
      ),
      metric("Uncached input / matched response", ({ efficiency }) =>
        efficiency.uncachedInputPerResponse === null
          ? "unavailable"
          : `${efficiency.uncachedInputPerResponse.toFixed(2)} · ${efficiency.matchedUncachedInput} input / ${efficiency.responseEvents.matchedObserved} events`
      ),
      metric(
        "Recovery (extra CLI / superseded CLI / writer relaunches)",
        ({ efficiency: { recovery } }) =>
          `${recovery.extraLaunches ?? "—"} / ${recovery.reworkLaunches ?? "—"} / ${recovery.writerRelaunches ?? "—"} · ${recovery.coverage}`
      ),
      metric(
        "Retry and rework costs by cause",
        ({ efficiency: { recovery } }) =>
          Object.entries(recovery.byCause)
            .map(
              ([cause, { count, cost }]) =>
                `${cause} ${count} (${cost ? withPartial(formatCost({ ...cost, priced: true, reasons: new Set() }), cost.partial) : "unavailable"})`
            )
            .join(" · ") || "—"
      ),
      metric(
        "Review finding occurrences",
        ({ efficiency: { reviewOutcomes } }) =>
          reviewOutcomes
            ? `${reviewOutcomes.accepted} accepted · ${reviewOutcomes.rejected} rejected · ${reviewOutcomes.recurring ?? "unavailable"} recurring`
            : "unavailable"
      ),
      metric("Verification", ({ efficiency: { verification } }) =>
        verification
          ? [
              ...VERIFICATION_STATES.map(
                (state) => `${verification[state]} ${state}`
              ),
              ...verification.criteria.map(({ id, state }) => `${id} ${state}`),
            ].join(" · ")
          : "unavailable"
      )
    );

    if (pair.comparisonLimits.length) {
      lines.push("", `Comparison limits — ${pair.comparisonLimits.join(", ")}`);
    }

    lines.push(
      "",
      "### Per-round",
      "",
      "| Side | Review | Round | Calls | Host tokens | Host turns |",
      "| --- | --- | ---: | ---: | ---: | ---: |"
    );

    pushPerRound(lines, sides);

    lines.push(
      "",
      "### Response evidence by stage and role",
      "",
      "| Side | Stage | Role | Event basis | Observed | Coverage | Matched events | Matched input | Input / matched response |",
      "| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: |"
    );

    pushResponseEvidence(lines, sides);

    lines.push(
      "",
      "### Review CLI attempt spans",
      "",
      "Spans cover current-generation CLI launches, including retry gaps. Native completion timing is unavailable.",
      "",
      "| Side | Review | Round | CLI span | Finishing logical slot |",
      "| --- | --- | ---: | ---: | --- |"
    );

    pushAttemptSpans(lines, sides);

    const gaps = sides.flatMap((side) =>
      side.unavailable.map((entry) => `- ${side.label}: ${entry}`)
    );

    if (gaps.length) {
      lines.push("", "Unavailable:", ...gaps);
    }

    lines.push("");
  }

  lines.push(
    "## Confounds",
    "",
    ...comparison.confounds.map((line) => `- ${line}`),
    "",
    `Pricing: \`${comparison.pricing.path}\` as of ${comparison.pricing.asOf}; one table reprices every run.`,
    ""
  );

  return lines.join("\n");
};

const pushPerRound = (lines: string[], sides: SideResult[]) => {
  for (const side of sides) {
    for (const row of side.perRound) {
      lines.push(
        `| ${side.label} | ${row.review} | ${row.round} | ${row.calls ?? "—"} | ${row.hostTokens ?? "—"} | ${row.hostTurns ?? "unavailable"} |`
      );
    }
  }
};

const pushResponseEvidence = (lines: string[], sides: SideResult[]) => {
  for (const side of sides) {
    for (const row of side.efficiency.responseEvents.byStageRole) {
      lines.push(
        `| ${side.label} | ${row.stage} | ${row.role} | ${row.basis} | ${row.observed ?? "—"} | ${row.coverage} | ${row.matchedObserved ?? "—"} | ${row.matchedUncachedInput ?? "—"} | ${row.uncachedInputPerResponse?.toFixed(2) ?? "—"} |`
      );
    }
  }
};

const pushAttemptSpans = (lines: string[], sides: SideResult[]) => {
  for (const side of sides) {
    for (const span of side.efficiency.criticalPath) {
      lines.push(
        `| ${side.label} | ${span.review} | ${span.round} | ${formatDuration(span.elapsedMs ?? undefined)} | ${span.finishingSlot ?? "—"} |`
      );
    }
  }
};

// SECTION: Output guard

/** Realpath of the nearest existing ancestor, with the folders that do not exist yet re-attached. */
const canonicalPath = (target: string) => {
  const missing: string[] = [];
  let existing = target;

  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }

  return path.join(fs.realpathSync.native(existing), ...missing);
};

const isWithin = (child: string, parent: string) => {
  const rel = path.relative(parent, child);

  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
};

const envOr = (env: NodeJS.ProcessEnv, name: string, fallback: string) => {
  const value = env[name];

  return value === undefined || value === "" ? fallback : value;
};

// NOTE: each root repeats its usage adapter's rule (claude.ts, codex.ts, agy.ts, opencode-db.ts); a new store needs a row here.
const hostStoreRoots = (home: string, env: NodeJS.ProcessEnv) => [
  envOr(env, "CLAUDE_CONFIG_DIR", path.join(home, ".claude")),
  envOr(env, "CODEX_HOME", path.join(home, ".codex")),
  envOr(
    env,
    "ANTIGRAVITY_APP_DATA_DIR",
    path.join(home, ".gemini", "antigravity")
  ),
  path.join(
    envOr(env, "XDG_DATA_HOME", path.join(home, ".local", "share")),
    "opencode"
  ),
];

/** Refuses an --out folder inside, or equal to, a measured session folder or a host store; runs before any write. */
const assertOutside = (
  dir: string,
  comparison: Comparison,
  home: string,
  env: NodeJS.ProcessEnv
) => {
  const target = canonicalPath(dir);

  const guarded = [
    ...comparison.pairs.flatMap((pair) =>
      pair.sides.map((side) => ({
        kind: "measured session folder",
        root: side.session,
      }))
    ),
    ...hostStoreRoots(home, env).map((root) => ({ kind: "host store", root })),
  ];

  for (const { kind, root } of guarded) {
    if (isWithin(target, canonicalPath(root))) {
      throw new Error(`--out must not be inside or equal a ${kind}: ${root}`);
    }
  }
};

/** Refuses an --out whose comparison files are symbolic links, so no write can follow a link outside --out. */
const assertNoLinkedOutputs = (dir: string) => {
  for (const name of ["comparison.json", "comparison.md"]) {
    const file = path.join(dir, name);
    let stat: fs.Stats;

    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }

      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(
        `--out file is a symbolic link, refusing to overwrite: ${file}`
      );
    }
  }
};

// SECTION: CLI

export interface RunIo {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const readFile = (file: string, label: string) => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    throw new Error(`${label} unreadable: ${file}`);
  }
};

/** Runs the maintainer command; returns the process exit code. */
export const runMeasureRuns = (argv: readonly string[], io: RunIo) => {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { out: { type: "string" } },
    });

    const { out } = values;
    const [pairsArg] = positionals;

    if (
      positionals.length !== 1 ||
      out === undefined ||
      out === "" ||
      pairsArg === undefined
    ) {
      io.stderr(USAGE);

      return 1;
    }

    const pairsFile = path.resolve(io.cwd, pairsArg);
    let input: unknown;

    try {
      input = JSON.parse(stripBom(readFile(pairsFile, "pairs file")));
    } catch (error) {
      if (error instanceof SyntaxError) {
        // oxlint-disable-next-line unicorn/prefer-type-error -- contract is Error (instanceof Error); TypeError would break callers.
        throw new Error(`pairs file is not valid JSON: ${pairsFile}`, {
          cause: error,
        });
      }

      throw error;
    }

    const pairs = parsePairs(input);
    const pricingPath = pairs.pricing ?? DEFAULT_PRICING;

    const pricingText = readFile(
      path.resolve(io.cwd, pricingPath),
      "pricing file"
    );

    const comparison = measureRuns(pairs, {
      baseDir: path.dirname(pairsFile),
      home: io.home,
      env: io.env,
      pricing: { path: pricingPath, text: pricingText },
    });

    const dir = path.resolve(io.cwd, out);
    assertOutside(dir, comparison, io.home, io.env);
    assertNoLinkedOutputs(dir);
    fs.mkdirSync(dir, { recursive: true });

    const jsonFile = path.join(dir, "comparison.json");
    const markdownFile = path.join(dir, "comparison.md");

    fs.writeFileSync(jsonFile, `${JSON.stringify(comparison, null, 2)}\n`);
    fs.writeFileSync(markdownFile, renderComparison(comparison));
    io.stdout(`${jsonFile}\n${markdownFile}\n`);

    return 0;
  } catch (error) {
    io.stderr(
      `measure-runs: ${error instanceof Error ? error.message : String(error)}\n`
    );

    return 1;
  }
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = runMeasureRuns(process.argv.slice(2), {
    cwd: process.cwd(),
    home: os.homedir(),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}
