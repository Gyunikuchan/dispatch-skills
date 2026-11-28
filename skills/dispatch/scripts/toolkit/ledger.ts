import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { readManifest } from "../lib/session.ts";
import { artifactHash, artifactKind, readArtifact } from "./artifacts.ts";
import type { ArtifactKind } from "./artifacts.ts";
import { safeRelativePath } from "./domain/context.ts";
import { currentRating, IMPACTS, TRIGGERS } from "./domain/severity.ts";
import { stableValue } from "./domain/stable-value.ts";
import { atomic } from "./fanout/state.ts";
import { git, gitOk, gitPaths } from "./git.ts";
import type { GitDeps } from "./git.ts";
import { integrationRecord } from "./integration-state.ts";
import { lintArtifact } from "./lint.ts";
import { withLock } from "./lock.ts";
import type { LockDeps } from "./lock.ts";
import { present, textValue } from "./narrow.ts";
import { ToolError } from "./output.ts";
import { defaultKey, KINDS, validateRecord } from "./records.ts";
import type { LedgerRecord, RecordInput } from "./records.ts";
import {
  reviewDirectory,
  reviewFindingsFile,
  reviewRoot,
  reviewRoundDirectory,
} from "./review-state.ts";

export interface Fold {
  records: LedgerRecord[];
  lastSeq: number;
  torn: Buffer | null;
}

export type Hashes = Partial<Record<ArtifactKind, string | null>>;

const isArtifactKind = (value: string): value is ArtifactKind =>
  value === "spec" || value === "plan" || value === "design";

const ledgerPath = (session: string) => path.join(session, "ledger.jsonl");

// SECTION: repository report note keys
// A closing or rerun decision names the report it acknowledges: the trailing
// :<reportSeq> carries the covered report's asOfSeq, so two reports
// under one reused round number close independently on distinct keys.
export const parseRepositoryNoteKey = (key: string) => {
  const [, kind, review, round, reportSeq] =
    /^repository-(?<cap1>changes|rerun):(?<cap2>[^:\s]+):(?<cap3>\d+):(?<cap4>\d+)$/u.exec(
      key
    ) ?? [];

  return (kind === "changes" || kind === "rerun") &&
    review !== undefined &&
    review !== ""
    ? { kind, review, round: Number(round), reportSeq: Number(reportSeq) }
    : null;
};

export const foldLedger = (session: string) => {
  let bytes: Buffer;

  try {
    bytes = fs.readFileSync(ledgerPath(session));
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { records: [], lastSeq: 0, torn: null };
    }

    throw error;
  }

  const records: LedgerRecord[] = [];
  let lastSeq = 0;
  let offset = 0;
  let line = 0;
  let torn: Buffer | null = null;
  let batch: LedgerRecord[] = [];
  let batchStart = -1;
  let batchEndSeq = 0;

  while (offset < bytes.length) {
    line += 1;
    const end = bytes.indexOf(10, offset);

    if (end === -1) {
      torn = bytes.subarray(batchStart >= 0 ? batchStart : offset);
      break;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(bytes.subarray(offset, end).toString("utf-8"));
    } catch {
      if (end === bytes.length - 1) {
        torn = bytes.subarray(batchStart >= 0 ? batchStart : offset);
        break;
      }

      throw new ToolError(2, "ledger-corrupt", `invalid JSON at line ${line}`);
    }

    try {
      const record = validateRecord(parsed, true);
      const pendingSeq = batch.at(-1)?.seq ?? lastSeq;

      if (record.seq <= pendingSeq) {
        throw new Error("seq");
      }

      if (record.batchEndSeq === undefined) {
        if (batch.length) {
          throw new Error("batch");
        }

        records.push(record);
        lastSeq = record.seq;
      } else {
        if (!batch.length) {
          batchStart = offset;
          ({ batchEndSeq } = record);
        } else if (record.batchEndSeq !== batchEndSeq) {
          throw new Error("batch");
        }

        batch.push(record);

        if (record.seq === batchEndSeq) {
          for (const row of batch) {
            const clean = { ...row };
            delete clean.batchEndSeq;
            records.push(clean);
          }

          lastSeq = record.seq;
          batch = [];
          batchStart = -1;
          batchEndSeq = 0;
        }
      }
    } catch {
      throw new ToolError(
        2,
        "ledger-corrupt",
        `invalid record at line ${line}`
      );
    }

    offset = end + 1;
  }

  if (batch.length) {
    torn = bytes.subarray(batchStart);
  }

  return { records, lastSeq, torn };
};

export const latest = (fold: Fold, kind: string) =>
  fold.records.findLast((record) => record.kind === kind);

export const currentSnapshot = (root: string, bind: unknown) => {
  const hashes: Hashes = {};
  const bytes: Hashes = {};
  const data = isRecord(bind) && "data" in bind ? bind["data"] : bind;

  for (const [kind, file] of Object.entries(isRecord(data) ? data : {})) {
    if (kind !== "spec" && kind !== "plan" && kind !== "design") {
      continue;
    }

    const source = typeof file === "string" ? readArtifact(root, file) : null;
    bytes[kind] = source;
    hashes[kind] = source === null ? null : artifactHash(kind, source);
  }

  return { bytes, hashes };
};

export const currentHashes = (root: string, bind: unknown) =>
  currentSnapshot(root, bind).hashes;

const content = (record: RecordInput | LedgerRecord) =>
  stableValue({
    kind: record.kind,
    by: record.by,
    ...(record.quote !== undefined && { quote: record.quote }),
    data: record.data,
  });

type ApprovalChainResult =
  | { allowed: true }
  | { allowed: false; reason: "unrecorded-change" | "intent-change" };

/** Follows recorded non-intent edits from one hash to the hash they end at. */
const walkEdits = (start: string, rows: readonly LedgerRecord[]) => {
  let hash = start;

  for (const edit of rows) {
    if (edit.data["before"] !== hash) {
      return { allowed: false as const, reason: "unrecorded-change" as const };
    }

    if (edit.data["class"] !== "non-intent") {
      return { allowed: false as const, reason: "intent-change" as const };
    }

    hash = textValue(edit.data["after"]);
  }

  return { allowed: true as const, hash };
};

const approvalChain = (
  fold: Fold,
  artifact: string,
  approved: string,
  current: string | null | undefined,
  approvalSeq?: number
): ApprovalChainResult => {
  const edits = fold.records.filter(
    (row) => row.kind === "edit" && row.data["artifact"] === artifact
  );

  const before =
    approvalSeq === undefined
      ? edits
      : edits.filter((row) => row.seq < approvalSeq);

  const baselines = [approved];

  // Earlier edit history is unrelated when a later recorded edit starts from the approved hash.
  const chainStart = before.findLastIndex(
    (edit) => edit.data["before"] === approved
  );

  if (chainStart !== -1) {
    const chain = walkEdits(approved, before.slice(chainStart));

    if (chain.allowed && chain.hash !== approved) {
      baselines.push(chain.hash);
    }
  }

  if (approvalSeq === undefined) {
    return current !== null &&
      current !== undefined &&
      baselines.includes(current)
      ? { allowed: true }
      : { allowed: false, reason: "unrecorded-change" };
  }

  const after = edits.filter((row) => row.seq > approvalSeq);
  let baselineOneFailure: ApprovalChainResult | undefined;

  for (const baseline of baselines) {
    const chain = walkEdits(baseline, after);

    if (!chain.allowed) {
      baselineOneFailure ??= chain;
      continue;
    }

    if (chain.hash === current) {
      return { allowed: true };
    }

    baselineOneFailure ??= { allowed: false, reason: "unrecorded-change" };
  }

  return baselineOneFailure ?? { allowed: false, reason: "unrecorded-change" };
};

// The subject grammar excludes path separators, and the resolved file must stay inside the reviews directory.
const CORRECTED_SUBJECT =
  /^review:(?<cap1>[A-Za-z0-9][A-Za-z0-9._-]*):(?<cap2>R(?<cap3>\d+)-(?:F|RED)\d+)$/u;

const refuseCorrection = (why: string): never => {
  throw new ToolError(
    1,
    "invalid-record",
    `severity correction refused: ${why}`
  );
};

/** Refuses a severity correction the stored finding or earlier rulings cannot support; fails closed when the finding is unreadable. */
// oxlint-disable-next-line eslint/complexity -- correction validation branches per record shape, path containment, and impact transition.
const checkCorrection = (session: string, fold: Fold, data: unknown) => {
  if (!isRecord(data) || data["impact"] === undefined) {
    return;
  }

  const { subject, rationale } = data;

  const [, review, id, round] =
    typeof subject === "string" ? (CORRECTED_SUBJECT.exec(subject) ?? []) : [];

  if (
    review === undefined ||
    review === "" ||
    id === undefined ||
    id === "" ||
    round === undefined ||
    round === "" ||
    review.includes("..")
  ) {
    refuseCorrection(
      "data.subject must be review:<review>:<finding> with a finding ID such as R1-F001"
    );

    return;
  }

  const reviews = path.resolve(reviewRoot(session));

  const file = path.resolve(
    reviewFindingsFile(
      reviewRoundDirectory(reviewDirectory(session, review), round)
    )
  );

  if (path.relative(reviews, file).startsWith("..")) {
    refuseCorrection("data.subject resolves outside the session reviews");
  }

  let finding: unknown;

  try {
    const stored: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));

    const rows: unknown[] =
      isRecord(stored) && Array.isArray(stored["findings"])
        ? stored["findings"]
        : [];

    finding = rows.find((row) => isRecord(row) && row["id"] === id);
  } catch {
    void 0;
    /* Absent and unreadable findings refuse alike. */
  }

  if (!isRecord(finding)) {
    refuseCorrection(
      `stored finding ${
        id
      } is absent or unreadable. Use a finding listed in that round's findings.json.`
    );

    return;
  }

  const impact = IMPACTS.find((value) => value === finding["impact"]);
  const trigger = TRIGGERS.find((value) => value === finding["trigger"]);

  if (!impact || !trigger) {
    refuseCorrection(
      `finding ${id} has no stored impact and trigger to correct`
    );

    return;
  }

  const current = currentRating(
    { impact, trigger },
    fold.records.filter(
      (row) => row.kind === "ruling" && row.data["subject"] === subject
    )
  );

  const currentSummary = `; current: impact=${current.impact}, trigger=${current.trigger}`;

  if (current.impact === "critical" && data["impact"] !== "critical") {
    refuseCorrection(
      `a critical impact cannot be lowered by correction; rule the finding rejected, which needs reviewer confirmation${
        currentSummary
      }`
    );
  }

  const changed = (["impact", "trigger"] as const).filter(
    (dimension) => current[dimension] !== data[dimension]
  );

  if (!changed.length) {
    refuseCorrection(`the corrected rating is unchanged${currentSummary}`);
  }

  const unnamed = changed.filter(
    (dimension) =>
      typeof rationale !== "string" ||
      !new RegExp(String.raw`\b` + dimension + String.raw`\b`, "iu").test(
        rationale
      )
  );

  if (unnamed.length) {
    refuseCorrection(
      `data.rationale must name each changed dimension; missing: ${unnamed.join(
        ", "
      )}${currentSummary}`
    );
  }
};

// SECTION: step-back outcome

const ACCEPTED_FINDING =
  /^review:(?<cap1>[A-Za-z0-9][A-Za-z0-9._-]*):R(?<cap2>\d+)-/u;

/** Refuses a batch whose accepted rulings sit in a round marked `stepBack` while neither batch nor ledger holds its outcome; an absent or unreadable findings file imposes nothing. */
const checkStepBack = (
  session: string,
  fold: Fold,
  added: readonly LedgerRecord[]
) => {
  const missing = new Set<string>();

  for (const row of added) {
    const [, review, round] =
      row.kind === "ruling" && row.data["ruling"] === "accepted"
        ? (ACCEPTED_FINDING.exec(textValue(row.data["subject"])) ?? [])
        : [];

    if (review === undefined || round === undefined) {
      continue;
    }

    const subject = `step-back:${review}:${round}`;

    if (
      fold.records.some(
        (other) => other.kind === "ruling" && other.data["subject"] === subject
      )
    ) {
      continue;
    }

    try {
      const saved: unknown = JSON.parse(
        fs.readFileSync(
          reviewFindingsFile(
            reviewRoundDirectory(reviewDirectory(session, review), round)
          ),
          "utf-8"
        )
      );

      if (isRecord(saved) && isRecord(saved["stepBack"])) {
        missing.add(subject);
      }
    } catch {
      void 0;
      /* Absent and unreadable findings impose no requirement. */
    }
  }

  if (missing.size) {
    throw new ToolError(
      1,
      "invalid-record",
      `step-back outcome missing: add a ruling with subject ${[...missing].join(", ")} (data.ruling: patch, rewrite, re-author or user; data.rationale: one line) to this batch or the ledger before accepted rulings of that round`
    );
  }
};

type PreparedRecord =
  | { record: RecordInput; key: string }
  | { seq: number; deduped: true };

// oxlint-disable-next-line eslint/complexity -- preparation branches per dedup hit, record kind, and artifact binding.
const prepareRecord = (
  session: string,
  fold: Fold,
  input: unknown
): PreparedRecord => {
  // SAFETY: stored defaults to false so assertEnvelope rejects stored-only fields; the assertion only names the unstored input side of the validated union.
  const record = validateRecord(input) as RecordInput;
  const key = record.key ?? defaultKey(record);
  const existing = fold.records.find((row) => row.key === key);

  if (existing) {
    if (content(existing) !== content(record)) {
      throw new ToolError(
        2,
        "key-conflict",
        `key ${key} has different content`
      );
    }

    return { seq: existing.seq, deduped: true };
  }

  if (record.kind === "ruling") {
    checkCorrection(session, fold, record.data);
  }

  const root = readManifest(session).repositoryRoot;
  const bind = latest(fold, "bind");

  if (record.kind === "bind") {
    const realRoot = fs.realpathSync(root);

    for (const [kind, file] of Object.entries(record.data)) {
      const relative = textValue(file);

      if (artifactKind(relative) !== kind) {
        throw new ToolError(
          1,
          "invalid-record",
          `data.${kind} must name a .${kind}.md file`
        );
      }

      let contained = false;

      try {
        const target = fs.realpathSync(path.resolve(root, relative));
        const remainder = path.relative(realRoot, target);
        contained =
          remainder !== ".." &&
          !remainder.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(remainder) &&
          fs.statSync(target).isFile();
      } catch {
        void 0;
        /* Missing or unreadable targets fail the same bind check. */
      }

      if (
        path.isAbsolute(relative) ||
        path.win32.isAbsolute(relative) ||
        relative.split(/[\\/]/u).includes("..") ||
        !contained
      ) {
        throw new ToolError(
          1,
          "invalid-record",
          `data.${kind} must name a contained existing file`
        );
      }
    }
  }

  if (record.kind === "approval") {
    if (!bind) {
      throw new ToolError(
        1,
        "invalid-record",
        "approval needs bound artifacts; append a bind record (data: an object with spec, plan?, design?) first. Currently bound artifact kinds: none."
      );
    }

    const hashes = currentHashes(root, bind);
    const artifacts = Object.keys(bind.data).toSorted();
    const approvedArtifacts = Object.keys(record.data).toSorted();

    if (
      stableValue(artifacts) !== stableValue(approvedArtifacts) ||
      artifacts.some(
        (artifact) =>
          !approvalChain(
            fold,
            artifact,
            textValue(record.data[artifact]),
            isArtifactKind(artifact) ? hashes[artifact] : undefined
          ).allowed
      )
    ) {
      const current = Object.entries(hashes)
        .map(([artifact, hash]) => `current: ${artifact} ${hash ?? "null"}`)
        .join("; ");

      throw new ToolError(
        1,
        "approval-stale",
        `approval hashes differ from current bound artifacts${
          current ? `; ${current}` : ""
        }`
      );
    }
  }

  if (
    record.kind === "edit" &&
    !Object.hasOwn(bind?.data ?? {}, textValue(record.data["artifact"]))
  ) {
    const boundKinds = Object.keys(bind?.data ?? {}).toSorted();
    const boundSummary = boundKinds.length ? boundKinds.join(", ") : "none";
    throw new ToolError(
      1,
      "invalid-record",
      // oxlint-disable-next-line typescript/restrict-template-expressions, typescript/no-base-to-string -- artifact is a validated record string field; interpolation renders its scalar text.
      `data.artifact "${record.data["artifact"]}" is not bound; append a bind record that includes it first. Currently bound artifact kinds: ${boundSummary}.`
    );
  }

  return { record, key };
};

// Reopen by path so a truncation made through a different descriptor is durable; directory sync is best effort.
const syncPath = (file: string, directory = false) => {
  let handle: number;

  try {
    handle = fs.openSync(file, directory ? "r" : "r+");
  } catch {
    if (directory) {
      return;
    }

    handle = fs.openSync(file, "a");
  }

  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
};

const recoverTorn = (session: string, fold: Fold) => {
  if (!fold.torn) {
    return;
  }

  const file = ledgerPath(session);
  let n = 1;

  while (fs.existsSync(path.join(session, `ledger.torn-${n}.jsonl`))) {
    n += 1;
  }

  fs.writeFileSync(path.join(session, `ledger.torn-${n}.jsonl`), fold.torn, {
    flag: "wx",
  });
  fs.truncateSync(file, fs.statSync(file).size - fold.torn.length);
  syncPath(file);

  if (process.platform !== "win32") {
    syncPath(session, true);
  }

  fold.torn = null;
};

interface AppendRecordsOptions {
  onCommit?: (fold: Fold) => void;
  writeBatch?: (
    handle: number,
    buffer: Buffer,
    offset: number,
    length: number
  ) => number;
}

// Body first without the final newline keeps an un-fsynced batch hidden from unlocked readers; the marker records its extent.
const writeRecords = (
  session: string,
  fold: Fold,
  toWrite: readonly LedgerRecord[],
  options?: AppendRecordsOptions
) => {
  const file = ledgerPath(session);
  recoverTorn(session, fold);
  const baseSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const batchEndSeq = present(toWrite.at(-1), "a record to write").seq;

  const fullBuf = Buffer.from(
    toWrite
      .map(
        (record) =>
          `${JSON.stringify(
            toWrite.length > 1 ? { ...record, batchEndSeq } : record
          )}\n`
      )
      .join(""),
    "utf-8"
  );

  const bodyBuf = fullBuf.subarray(0, -1);
  const finalNewline = fullBuf.subarray(-1);
  let handle: number | undefined;

  try {
    handle = fs.openSync(file, "a");
    let written = 0;

    while (written < bodyBuf.length) {
      const n = (options?.writeBatch ?? fs.writeSync)(
        handle,
        bodyBuf,
        written,
        bodyBuf.length - written
      );

      if (n <= 0) {
        throw new Error("short write");
      }

      written += n;
    }

    fs.fsyncSync(handle);

    if (fs.writeSync(handle, finalNewline, 0, 1) !== 1) {
      throw new Error("short write");
    }

    fs.fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        void 0;
        /* Preserve the write failure. */
      }

      handle = undefined;
    }

    try {
      fs.truncateSync(file, baseSize);
      syncPath(file);

      if (process.platform !== "win32") {
        syncPath(session, true);
      }
    } catch {
      void 0;
      /* Preserve the write failure; truncation is attempted by path first. */
    }

    throw error;
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
};

export interface LedgerTransaction {
  fold: Fold;
  append: (input: unknown) => Promise<{ seq: number; deduped: boolean }>;
}

export const appendRecord = async (
  session: string,
  input: unknown,
  deps: LockDeps,
  options?: AppendRecordsOptions
) => {
  if (Array.isArray(input)) {
    throw new ToolError(1, "invalid-record", "record must be a JSON object");
  }

  const { seq, deduped } = await appendRecords(session, input, deps, options);

  return { seq, deduped };
};

export const appendRecords = async (
  session: string,
  input: unknown,
  deps: LockDeps,
  options?: AppendRecordsOptions
) =>
  // oxlint-disable-next-line eslint/require-await -- withLedger requires a promise-returning callback; this batch builds synchronously.
  await withLedger(session, "ledger append", deps, async ({ fold }) => {
    const items = Array.isArray(input) ? input : [input];

    if (Array.isArray(input) && items.length === 0) {
      throw new ToolError(
        1,
        "invalid-record",
        "record batch must be a non-empty array"
      );
    }

    const working: Fold = {
      records: [...fold.records],
      lastSeq: fold.lastSeq,
      torn: fold.torn,
    };

    const results: { seq: number; deduped: boolean }[] = [];
    const toWrite: LedgerRecord[] = [];

    for (const item of items) {
      const prepared = prepareRecord(session, working, item);

      if (
        !("deduped" in prepared) &&
        prepared.record.kind === "note" &&
        CLEANUP_KEY.test(prepared.key)
      ) {
        throw new ToolError(
          1,
          "invalid-input",
          "Use ledger append - --cleanup for a bound cleanup checkpoint"
        );
      }

      if ("deduped" in prepared) {
        results.push({ seq: prepared.seq, deduped: true });
        continue;
      }

      const stored: LedgerRecord = {
        ...prepared.record,
        key: prepared.key,
        seq: working.lastSeq + 1,
        at: new Date(deps.clock()).toISOString(),
      };

      working.records.push(stored);
      working.lastSeq = stored.seq;
      toWrite.push(stored);
      results.push({ seq: stored.seq, deduped: false });
    }

    checkStepBack(session, working, toWrite);

    if (toWrite.length) {
      writeRecords(session, fold, toWrite, options);
    }

    fold.records = working.records;
    fold.lastSeq = working.lastSeq;
    options?.onCommit?.(fold);
    const lastResult = present(results.at(-1), "an append result");

    return Array.isArray(input)
      ? {
          seq: lastResult.seq,
          deduped: results.every((row) => row.deduped),
          count: items.length,
          results,
        }
      : { seq: lastResult.seq, deduped: lastResult.deduped };
  });

export const withPostFold = async <T extends object>(
  session: string,
  tool: string,
  deps: LockDeps,
  fn: (tx: LedgerTransaction) => Promise<T>
) =>
  await withLedger(session, tool, deps, async (tx) => ({
    ...(await fn(tx)),
    postFold: tx.fold,
  }));

export const withLedger = async <T>(
  session: string,
  tool: string,
  deps: LockDeps,
  fn: (tx: LedgerTransaction) => Promise<T>
) =>
  await withLock(session, tool, deps, async (broken) => {
    const fold = foldLedger(session);

    // oxlint-disable-next-line eslint/require-await -- LedgerTransaction.append requires a promise return; the write path is synchronous.
    const append = async (input: unknown) => {
      const prepared = prepareRecord(session, fold, input);

      if ("deduped" in prepared) {
        return { seq: prepared.seq, deduped: true };
      }

      const file = ledgerPath(session);
      recoverTorn(session, fold);
      const handle = fs.openSync(file, "a");

      try {
        const seq = fold.lastSeq + 1;

        const stored = {
          ...prepared.record,
          key: prepared.key,
          seq,
          at: new Date(deps.clock()).toISOString(),
        };

        fs.writeSync(handle, `${JSON.stringify(stored)}\n`);
        fs.fsyncSync(handle);
        fold.records.push(stored);
        fold.lastSeq = seq;

        return { seq, deduped: false };
      } finally {
        fs.closeSync(handle);
      }
    };

    if (broken) {
      await append({
        kind: "note",
        key: `stale-lock:${broken.host}:${broken.pid}:${broken.at}`,
        by: "tool",
        data: {
          text: `Broke stale lock from pid ${broken.pid} on ${broken.host}`,
        },
      });
    }

    return await fn({ fold, append });
  });

const CLEANUP_REPORT = ".state/test-cleanup.json";

const CLEANUP_KEY =
  /^test-cleanup:(?<cap1>skip|zero):(?<cap2>\d+):(?<cap3>[a-f0-9]{40}|[a-f0-9]{64})$/u;

const changedTests = ({ data }: LedgerRecord) => {
  const removed: unknown = data["removed"];

  return (
    (Array.isArray(removed) && removed.length > 0) ||
    Boolean(data["deleted"]) ||
    Boolean(data["merged"])
  );
};

export const gitObjectId = <T>(value: T): value is T & string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);

export const containedSessionPath = (session: string, relative: string) => {
  if (
    !safeRelativePath(relative) ||
    relative !== path.posix.normalize(relative)
  ) {
    throw new Error("Invalid session-relative path");
  }

  const file = fs.realpathSync(path.resolve(session, relative));
  const rest = path.relative(fs.realpathSync(session), file);

  if (
    !rest ||
    rest === ".." ||
    rest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rest)
  ) {
    throw new Error("Path escapes session");
  }

  return file;
};

const reportDigest = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const zeroCleanup = (report: unknown) =>
  isRecord(report) &&
  Object.keys(report).toSorted().join(",") === "deleted,merged,removed" &&
  Array.isArray(report["removed"]) &&
  report["removed"].length === 0 &&
  report["deleted"] === 0 &&
  report["merged"] === 0;

const cleanupPaths = async (
  deps: GitDeps,
  cwd: string,
  base: string,
  head: string
) => {
  if (base === head) {
    return [];
  }

  const diff = await gitPaths(deps, cwd, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    base,
    head,
    "--",
  ]);

  return diff.toSorted();
};

const cleanCheckout = async (deps: GitDeps, cwd: string) =>
  !(await gitOk(deps, cwd, [
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]));

export const appendCleanupCheckpoint = async (
  session: string,
  mode: unknown,
  value: unknown,
  deps: GitDeps & LockDeps
) => {
  const input = isRecord(value) ? value : null;

  if (
    (mode !== "skip" && mode !== "zero") ||
    !input ||
    Object.keys(input).toSorted().join(",") !==
      (mode === "skip" ? "head" : "head,report") ||
    !gitObjectId(input["head"]) ||
    (mode === "zero" && !zeroCleanup(input["report"]))
  ) {
    throw new ToolError(
      1,
      "invalid-input",
      "Cleanup requires skip {head} or zero {head,report} with zero counts"
    );
  }

  return await withLedger(
    session,
    "ledger append",
    deps,
    async ({ fold, append }) => {
      const opened = integrationRecord(fold);

      if (
        !opened ||
        !gitObjectId(opened.data["base"]) ||
        fold.records.some(
          (row) =>
            row.seq > opened.seq &&
            row.kind === "integrate" &&
            (row.data["phase"] === "closed" ||
              row.data["phase"] === "delivered")
        )
      ) {
        throw new ToolError(
          4,
          "nothing-to-review",
          "No open integration checkout"
        );
      }

      const cwd = containedSessionPath(session, textValue(opened.data["path"]));
      const head = await gitOk(deps, cwd, ["rev-parse", "HEAD"]);

      if (head !== input["head"]) {
        throw new ToolError(
          4,
          "target-moved",
          "Cleanup requires the current clean integration HEAD"
        );
      }

      const tree = await gitOk(deps, cwd, ["rev-parse", `${head}^{tree}`]);

      if (!gitObjectId(tree)) {
        throw new ToolError(
          2,
          "fault",
          "Cannot establish the integration tree"
        );
      }

      const paths =
        mode === "skip"
          ? await cleanupPaths(deps, cwd, textValue(opened.data["base"]), head)
          : undefined;

      if (
        head !== (await gitOk(deps, cwd, ["rev-parse", "HEAD"])) ||
        !(await cleanCheckout(deps, cwd))
      ) {
        throw new ToolError(
          4,
          "target-moved",
          "Cleanup requires the current clean integration HEAD"
        );
      }

      let proof: { paths: string[] } | { reportDigest: string };

      if (paths) {
        proof = { paths };
      } else {
        const report = path.join(
          containedSessionPath(session, ".state"),
          "test-cleanup.json"
        );

        atomic(report, { removed: [], deleted: 0, merged: 0 });
        proof = { reportDigest: reportDigest(fs.readFileSync(report)) };
      }

      const result = await append({
        kind: "note",
        by: "tool",
        key: `test-cleanup:${mode}:${opened.seq}:${head}`,
        data: {
          text: JSON.stringify({
            openingSeq: opened.seq,
            head,
            tree,
            ...proof,
          }),
        },
      });

      return { result, fold };
    }
  );
};

// oxlint-disable-next-line eslint/complexity -- checkpoint probe branches per integration record, note kind, and ancestry exit.
export const hasCleanupCheckpoint = async (
  session: string,
  fold: Fold,
  deps: GitDeps,
  cwd: string,
  head: string
) => {
  const opened = integrationRecord(fold);

  if (!opened) {
    return false;
  }

  try {
    const row = fold.records.findLast(
      (candidate) =>
        candidate.seq > opened.seq &&
        candidate.by === "tool" &&
        ((candidate.kind === "integrate" &&
          candidate.data["phase"] === "test-cleanup" &&
          changedTests(candidate)) ||
          (candidate.kind === "note" &&
            CLEANUP_KEY.exec(candidate.key)?.[2] === String(opened.seq)))
    );

    if (!row) {
      return false;
    }

    const checkpoint: unknown =
      row.kind === "note" ? CLEANUP_KEY.exec(row.key)?.[3] : row.data["to"];

    if (
      !gitObjectId(checkpoint) ||
      !gitObjectId(head) ||
      !(await cleanCheckout(deps, cwd))
    ) {
      return false;
    }

    const ancestry = await git(deps, cwd, [
      "merge-base",
      "--is-ancestor",
      checkpoint,
      head,
    ]);

    if (ancestry.exit !== 0) {
      return false;
    }

    if (row.kind !== "note") {
      return true;
    }

    const proof: unknown = JSON.parse(textValue(row.data["text"]));

    if (
      !isRecord(proof) ||
      proof["openingSeq"] !== opened.seq ||
      proof["head"] !== checkpoint ||
      !gitObjectId(proof["tree"]) ||
      proof["tree"] !==
        (await gitOk(deps, cwd, ["rev-parse", `${checkpoint}^{tree}`]))
    ) {
      return false;
    }

    if (CLEANUP_KEY.exec(row.key)?.[1] === "skip") {
      const base: unknown = opened.data["base"];

      return (
        gitObjectId(base) &&
        Array.isArray(proof["paths"]) &&
        JSON.stringify(proof["paths"]) ===
          JSON.stringify(await cleanupPaths(deps, cwd, base, checkpoint))
      );
    }

    const bytes = fs.readFileSync(
      containedSessionPath(session, CLEANUP_REPORT)
    );

    return (
      proof["reportDigest"] === reportDigest(bytes) &&
      zeroCleanup(JSON.parse(bytes.toString("utf-8")))
    );
  } catch {
    return false;
  }
};

export const appendLintEdit = async (
  session: string,
  artifactPath: string,
  fields: {
    class: string;
    affects: string[];
    rationale: string;
    diffRef: string;
    before?: string;
  },
  deps: LockDeps
) =>
  // oxlint-disable-next-line eslint/complexity -- lint-run branches per artifact errors, binding match, and prior record.
  await withLedger(session, "lint run", deps, async (tx) => {
    const { repositoryRoot } = readManifest(session);
    const value = lintArtifact(artifactPath, { repositoryRoot });

    if (value.errors.length) {
      return { value };
    }

    const { kind: artifact, hash: after } = value;

    if (!artifact || artifact === "context") {
      throw new ToolError(
        1,
        "invalid-input",
        "--edit cannot record a context map"
      );
    }

    const binding: unknown = latest(tx.fold, "bind")?.data[artifact];

    if (
      binding === undefined ||
      binding === null ||
      binding === false ||
      binding === "" ||
      binding === 0
    ) {
      throw new ToolError(
        1,
        "invalid-record",
        `Artifact kind is not bound: ${artifact}`
      );
    }

    const bound = textValue(binding);
    const boundPath = path.resolve(repositoryRoot, bound);
    let isBoundPath = false;

    try {
      isBoundPath =
        path.relative(
          fs.realpathSync(boundPath),
          fs.realpathSync(artifactPath)
        ) === "";
    } catch {
      void 0;
      /* A missing or unreadable path cannot match the binding. */
    }

    if (!isBoundPath) {
      throw new ToolError(
        1,
        "invalid-record",
        `Linted path must match the bound ${artifact} path: ${bound}`
      );
    }

    let matchingBinding = false;
    let editCount = 0;
    let previous: LedgerRecord | undefined;

    for (const row of tx.fold.records) {
      if (row.kind === "bind") {
        // Compare stored paths because an earlier target may have moved or been removed.
        const boundAtEdit: unknown = row.data[artifact];
        matchingBinding =
          Boolean(boundAtEdit) &&
          path.relative(
            boundPath,
            path.resolve(repositoryRoot, textValue(boundAtEdit))
          ) === "";
      } else if (row.kind === "edit" && row.data["artifact"] === artifact) {
        editCount += 1;

        if (matchingBinding) {
          previous = row;
        }
      }
    }

    const { before: explicitBefore, ...details } = fields;

    if (previous) {
      const earlierBefore = textValue(previous.data["before"]);

      const candidate = {
        artifact,
        before: explicitBefore ?? earlierBefore,
        after,
        ...details,
      };

      if (stableValue(previous.data) === stableValue(candidate)) {
        return {
          value,
          edit: {
            seq: previous.seq,
            deduped: true,
            before: earlierBefore,
            after,
          },
        };
      }
    }

    const before =
      explicitBefore ??
      (previous ? textValue(previous.data["after"]) : undefined);

    if (before === undefined) {
      throw new ToolError(
        1,
        "invalid-input",
        `--edit requires before for the first ${
          artifact
        } edit at the bound path`
      );
    }

    if (before === after) {
      throw new ToolError(
        1,
        "no-change",
        `Lint hash equals before for ${artifact}`
      );
    }

    const appended = await tx.append({
      kind: "edit",
      by: "orchestrator",
      key: `lint-edit:${artifact}:${editCount + 1}`,
      data: { artifact, before, after, ...details },
    });

    return { value, edit: { ...appended, before, after } };
  });

export const queryLedger = (
  fold: Fold,
  filter: { kind?: unknown; key?: unknown; since?: unknown } = {}
) => {
  if (
    filter.kind !== undefined &&
    !KINDS.some((kind) => kind === filter.kind)
  ) {
    throw new ToolError(
      1,
      "invalid-input",
      `filter.kind must be one of: ${KINDS.join(", ")}.`
    );
  }

  let since = 0;

  if (filter.since !== undefined) {
    if (typeof filter.since !== "string" && typeof filter.since !== "number") {
      throw new ToolError(
        1,
        "invalid-input",
        "filter.since must be a nonnegative safe integer."
      );
    }

    since = Number(filter.since);

    if (
      String(filter.since).trim() === "" ||
      !Number.isSafeInteger(since) ||
      since < 0
    ) {
      throw new ToolError(
        1,
        "invalid-input",
        "filter.since must be a nonnegative safe integer."
      );
    }
  }

  return fold.records.filter(
    (row) =>
      (filter.kind === undefined || row.kind === filter.kind) &&
      (filter.key === undefined || row.key === filter.key) &&
      row.seq > since
  );
};

type GateResult =
  | { allowed: true; reason?: never; artifact?: never }
  | { allowed: false; reason: string; artifact?: string };

export const levelGate = (fold: Fold, level?: string): GateResult => {
  const selected = latest(fold, "level");
  const saved = selected?.data["level"];
  const resolvedLevel = level ?? (typeof saved === "string" ? saved : "medium");

  if (
    (resolvedLevel === "xhigh" || resolvedLevel === "max") &&
    (selected?.by !== "user" || selected.data["level"] !== resolvedLevel)
  ) {
    return { allowed: false, reason: "level-unapproved" };
  }

  return { allowed: true };
};

// SECTION: intent confirmation
// Fail closed: a missing spec hash or confirm record cannot match, so the spec is never implicitly confirmed.
export const confirmGate = (
  fold: Fold,
  specHash: string | null | undefined
): GateResult => {
  const confirmed: unknown = latest(fold, "confirm")?.data["spec"];

  if (
    typeof specHash !== "string" ||
    typeof confirmed !== "string" ||
    !approvalChain(fold, "spec", confirmed, specHash).allowed
  ) {
    return { allowed: false, reason: "missing-confirmation" };
  }

  return { allowed: true };
};

export const gate = (
  fold: Fold,
  current: Hashes,
  level?: string
): GateResult => {
  const decision = levelGate(fold, level);

  if (!decision.allowed) {
    return decision;
  }

  const confirmation = confirmGate(fold, current.spec);

  if (!confirmation.allowed) {
    return confirmation;
  }

  const saved = latest(fold, "level")?.data["level"];
  const resolvedLevel = level ?? (typeof saved === "string" ? saved : "medium");

  if (resolvedLevel === "low") {
    return { allowed: true };
  }

  const approval = latest(fold, "approval");
  const bind = latest(fold, "bind");
  const artifacts = Object.keys(bind?.data ?? current);

  if (
    !approval ||
    artifacts.some((kind) => !Object.hasOwn(approval.data, kind))
  ) {
    return { allowed: false, reason: "missing-approval" };
  }

  for (const artifact of artifacts) {
    const chain = approvalChain(
      fold,
      artifact,
      textValue(approval.data[artifact]),
      isArtifactKind(artifact) ? current[artifact] : undefined,
      approval.seq
    );

    if (!chain.allowed) {
      return { ...chain, artifact };
    }
  }

  return { allowed: true };
};
