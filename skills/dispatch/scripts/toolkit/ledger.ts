import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from '../lib/session.ts';
import { artifactHash, artifactKind, readArtifact, type ArtifactKind } from './artifacts.ts';
import { currentRating, IMPACTS, TRIGGERS } from './domain/severity.ts';
import { stableValue } from './domain/stable-value.ts';
import { withLock, type LockDeps } from './lock.ts';
import { ToolError } from './output.ts';
import { defaultKey, KINDS, validateRecord, type LedgerRecord, type RecordInput } from './records.ts';

export type Fold = { records: LedgerRecord[]; lastSeq: number; torn: Buffer | null };
export type Hashes = Partial<Record<ArtifactKind, string | null>>;
const ledgerPath = (session: string) => path.join(session, 'ledger.jsonl');

// SECTION: repository report note keys
// A closing or rerun decision names the report it acknowledges: the trailing
// :<reportSeq> carries the covered report's asOfSeq, so two reports
// under one reused round number close independently on distinct keys.
export type RepositoryNoteKey = { kind: 'changes' | 'rerun'; review: string; round: number; reportSeq: number };
export function parseRepositoryNoteKey(key: string): RepositoryNoteKey | null {
  let match = /^repository-changes:([^:\s]+):(\d+):(\d+)$/.exec(key);
  if (match) return { kind: 'changes', review: match[1]!, round: Number(match[2]), reportSeq: Number(match[3]) };
  match = /^repository-rerun:([^:\s]+):(\d+):(\d+)$/.exec(key);
  if (match) return { kind: 'rerun', review: match[1]!, round: Number(match[2]), reportSeq: Number(match[3]) };
  return null;
}

export function foldLedger(session: string): Fold {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(ledgerPath(session));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], lastSeq: 0, torn: null };
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
    line++;
    const end = bytes.indexOf(10, offset);
    if (end === -1) {
      torn = bytes.subarray(batchStart >= 0 ? batchStart : offset);
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(offset, end).toString('utf8'));
    } catch {
      if (end === bytes.length - 1) {
        torn = bytes.subarray(batchStart >= 0 ? batchStart : offset);
        break;
      }
      throw new ToolError(2, 'ledger-corrupt', 'invalid JSON at line ' + line);
    }
    try {
      const record = validateRecord(parsed, true) as LedgerRecord;
      const pendingSeq = batch.at(-1)?.seq ?? lastSeq;
      if (record.seq <= pendingSeq) throw new Error('seq');
      if (record.batchEndSeq !== undefined) {
        if (!batch.length) {
          batchStart = offset;
          batchEndSeq = record.batchEndSeq;
        } else if (record.batchEndSeq !== batchEndSeq) throw new Error('batch');
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
      } else {
        if (batch.length) throw new Error('batch');
        records.push(record);
        lastSeq = record.seq;
      }
    } catch {
      throw new ToolError(2, 'ledger-corrupt', 'invalid record at line ' + line);
    }
    offset = end + 1;
  }
  if (batch.length) torn = bytes.subarray(batchStart);
  return { records, lastSeq, torn };
}

export function latest(fold: Fold, kind: string): LedgerRecord | undefined {
  return fold.records.findLast(record => record.kind === kind);
}

export function currentSnapshot(root: string, bind: Record<string, any> | LedgerRecord | undefined): { bytes: Partial<Record<ArtifactKind, string | null>>; hashes: Hashes } {
  const hashes: Hashes = {};
  const bytes: Partial<Record<ArtifactKind, string | null>> = {};
  const data = bind && 'data' in bind ? bind.data : bind;
  for (const [kind, file] of Object.entries(data ?? {})) {
    const source = readArtifact(root, file as string);
    bytes[kind as ArtifactKind] = source;
    hashes[kind as ArtifactKind] = source === null ? null : artifactHash(kind as ArtifactKind, source);
  }
  return {bytes, hashes};
}

export function currentHashes(root: string, bind: Record<string, any> | LedgerRecord | undefined): Hashes {
  return currentSnapshot(root, bind).hashes;
}

function content(record: RecordInput | LedgerRecord): string {
  return stableValue({
    kind: record.kind, by: record.by,
    ...(record.quote !== undefined ? { quote: record.quote } : {}), data: record.data,
  });
}

type ApprovalChainResult = { allowed: true } | { allowed: false; reason: 'unrecorded-change' | 'intent-change' };
function approvalChain(fold: Fold, artifact: string, approved: string, current: string | null | undefined, approvalSeq?: number): ApprovalChainResult {
  const edits = fold.records.filter(row => row.kind === 'edit' && row.data['artifact'] === artifact);
  const walk = (start: string, rows: readonly LedgerRecord[]) => {
    let hash = start;
    for (const edit of rows) {
      if (edit.data['before'] !== hash) return { allowed: false as const, reason: 'unrecorded-change' as const };
      if (edit.data['class'] !== 'non-intent') return { allowed: false as const, reason: 'intent-change' as const };
      hash = edit.data['after'] as string;
    }
    return { allowed: true as const, hash };
  };
  const before = approvalSeq === undefined ? edits : edits.filter(row => row.seq < approvalSeq);
  const baselines = [approved];
  // Earlier edit history is unrelated when a later recorded edit starts from the approved hash.
  const chainStart = before.findLastIndex(edit => edit.data['before'] === approved);
  if (chainStart >= 0) {
    const chain = walk(approved, before.slice(chainStart));
    if (chain.allowed && chain.hash !== approved) baselines.push(chain.hash);
  }
  if (approvalSeq === undefined) {
    return current !== null && current !== undefined && baselines.includes(current)
      ? { allowed: true }
      : { allowed: false, reason: 'unrecorded-change' };
  }

  const after = edits.filter(row => row.seq > approvalSeq);
  let baselineOneFailure: ApprovalChainResult | undefined;
  for (const baseline of baselines) {
    const chain = walk(baseline, after);
    if (!chain.allowed) {
      baselineOneFailure ??= chain;
      continue;
    }
    if (chain.hash === current) return { allowed: true };
    baselineOneFailure ??= { allowed: false, reason: 'unrecorded-change' };
  }
  return baselineOneFailure ?? { allowed: false, reason: 'unrecorded-change' };
}

// The subject grammar excludes path separators, and the resolved file must stay inside the reviews directory.
const CORRECTED_SUBJECT = /^review:([A-Za-z0-9][A-Za-z0-9._-]*):(R(\d+)-(?:F|RED)\d+)$/;
/** Refuses a severity correction the stored finding or earlier rulings cannot support; fails closed when the finding is unreadable. */
function checkCorrection(session: string, fold: Fold, data: Record<string, any>): void {
  if (data['impact'] === undefined) return;
  const refuse = (why: string): never => { throw new ToolError(1, 'invalid-record', 'severity correction refused: ' + why); };
  const match = CORRECTED_SUBJECT.exec(data['subject']);
  if (!match || match[1]!.includes('..')) refuse('data.subject must be review:<review>:<finding> with a finding ID such as R1-F001');
  const reviews = path.resolve(session, '.state', 'reviews');
  const file = path.resolve(reviews, match![1]!, 'round-' + match![3], 'findings.json');
  if (path.relative(reviews, file).startsWith('..')) refuse('data.subject resolves outside the session reviews');
  let finding: Record<string, any> | undefined;
  try { finding = JSON.parse(fs.readFileSync(file, 'utf8')).findings.find((row: any) => row?.id === match![2]); } catch { /* Absent and unreadable findings refuse alike. */ }
  if (!finding) refuse('stored finding ' + match![2] + ' is absent or unreadable');
  if (!IMPACTS.includes(finding!['impact']) || !TRIGGERS.includes(finding!['trigger'])) refuse('finding ' + match![2] + ' has no stored impact and trigger to correct');
  const current: Record<string, any> = currentRating(finding as never, fold.records.filter(row => row.kind === 'ruling' && row.data['subject'] === data['subject']));
  if (current['impact'] === 'critical' && data['impact'] !== 'critical') refuse('a critical impact cannot be lowered by correction; rule the finding rejected, which needs reviewer confirmation');
  const changed = ['impact', 'trigger'].filter(dimension => current[dimension] !== data[dimension]);
  if (!changed.length) refuse('the corrected rating is unchanged');
  const unnamed = changed.filter(dimension => !new RegExp('\\b' + dimension + '\\b', 'i').test(data['rationale']));
  if (unnamed.length) refuse('data.rationale must name each changed dimension; missing: ' + unnamed.join(', '));
}

type PreparedRecord = { record: RecordInput; key: string } | { seq: number; deduped: true };

function prepareRecord(session: string, fold: Fold, input: unknown): PreparedRecord {
  const record = validateRecord(input) as RecordInput;
  const key = record.key ?? defaultKey(record);
  const existing = fold.records.find(row => row.key === key);
  if (existing) {
    if (content(existing) !== content(record)) throw new ToolError(2, 'key-conflict', 'key ' + key + ' has different content');
    return { seq: existing.seq, deduped: true };
  }
  if (record.kind === 'ruling') checkCorrection(session, fold, record.data);

  const root = readManifest(session).repositoryRoot;
  const bind = latest(fold, 'bind');
  if (record.kind === 'bind') {
    const realRoot = fs.realpathSync(root);
    for (const [kind, file] of Object.entries(record.data)) {
      const relative = file as string;
      if (artifactKind(relative) !== kind) {
        throw new ToolError(1, 'invalid-record', 'data.' + kind + ' must name a .' + kind + '.md file');
      }
      let contained = false;
      try {
        const target = fs.realpathSync(path.resolve(root, relative));
        const remainder = path.relative(realRoot, target);
        contained = remainder !== '..' && !remainder.startsWith('..' + path.sep) && !path.isAbsolute(remainder) && fs.statSync(target).isFile();
      } catch { /* Missing or unreadable targets fail the same bind check. */ }
      if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || !contained) {
        throw new ToolError(1, 'invalid-record', 'data.' + kind + ' must name a contained existing file');
      }
    }
  }
  if (record.kind === 'approval') {
    if (!bind) throw new ToolError(1, 'invalid-record', 'approval needs bound artifacts; append a bind record for the spec and plan or design first.');
    const hashes = currentHashes(root, bind);
    const artifacts = Object.keys(bind.data).sort();
    const approvedArtifacts = Object.keys(record.data).sort();
    if (stableValue(artifacts) !== stableValue(approvedArtifacts) || artifacts.some(artifact =>
      !approvalChain(fold, artifact, record.data[artifact], hashes[artifact as ArtifactKind]).allowed)) {
      const current = Object.entries(hashes).map(([artifact, hash]) => `current: ${artifact} ${hash ?? 'null'}`).join('; ');
      throw new ToolError(1, 'approval-stale', 'approval hashes differ from current bound artifacts' + (current ? '; ' + current : ''));
    }
  }
  if (record.kind === 'edit' && !Object.hasOwn(bind?.data ?? {}, record.data['artifact'])) {
    const boundKinds = Object.keys(bind?.data ?? {}).sort();
    const boundSummary = boundKinds.length ? boundKinds.join(', ') : 'none';
    throw new ToolError(1, 'invalid-record', `data.artifact "${record.data['artifact']}" is not bound; append a bind record that includes it first. Currently bound artifact kinds: ${boundSummary}.`);
  }
  return { record, key };
}

// Reopen by path so a truncation made through a different descriptor is durable; directory sync is best effort.
function syncPath(file: string, directory = false): void {
  let handle: number;
  try { handle = fs.openSync(file, directory ? 'r' : 'r+'); }
  catch { if (directory) return; handle = fs.openSync(file, 'a'); }
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function recoverTorn(session: string, fold: Fold): void {
  if (!fold.torn) return;
  const file = ledgerPath(session);
  let n = 1;
  while (fs.existsSync(path.join(session, 'ledger.torn-' + n + '.jsonl'))) n++;
  fs.writeFileSync(path.join(session, 'ledger.torn-' + n + '.jsonl'), fold.torn, { flag: 'wx' });
  fs.truncateSync(file, fs.statSync(file).size - fold.torn.length);
  syncPath(file);
  if (process.platform !== 'win32') syncPath(session, true);
  fold.torn = null;
}

export type AppendResult = { seq: number; deduped: boolean; count?: number; results?: { seq: number; deduped: boolean }[] };
export type AppendRecordsOptions = {
  onCommit?: (fold: Fold) => void;
  writeBatch?: (handle: number, buffer: Buffer, offset: number, length: number) => number;
};

// Body first without the final newline keeps an un-fsynced batch hidden from unlocked readers; the marker records its extent.
function writeRecords(session: string, fold: Fold, toWrite: readonly LedgerRecord[], options?: AppendRecordsOptions): void {
  const file = ledgerPath(session);
  recoverTorn(session, fold);
  const baseSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const batchEndSeq = toWrite.at(-1)!.seq;
  const fullBuf = Buffer.from(toWrite.map(record => JSON.stringify(toWrite.length > 1 ? { ...record, batchEndSeq } : record) + '\n').join(''), 'utf8');
  const bodyBuf = fullBuf.subarray(0, fullBuf.length - 1);
  const finalNewline = fullBuf.subarray(fullBuf.length - 1);
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, 'a');
    let written = 0;
    while (written < bodyBuf.length) {
      const n = (options?.writeBatch ?? fs.writeSync)(handle, bodyBuf, written, bodyBuf.length - written);
      if (n <= 0) throw new Error('short write');
      written += n;
    }
    fs.fsyncSync(handle);
    if (fs.writeSync(handle, finalNewline, 0, 1) !== 1) throw new Error('short write');
    fs.fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* Preserve the write failure. */ }
      handle = undefined;
    }
    try {
      fs.truncateSync(file, baseSize);
      syncPath(file);
      if (process.platform !== 'win32') syncPath(session, true);
    } catch { /* Preserve the write failure; truncation is attempted by path first. */ }
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

export type LedgerTransaction = {fold: Fold; append: (input: unknown) => Promise<{seq: number; deduped: boolean}>};
export async function appendRecord(session: string, input: unknown, deps: LockDeps): Promise<{ seq: number; deduped: boolean }> {
  return withLedger(session, 'ledger append', deps, tx => tx.append(input));
}
export async function appendRecords(session: string, input: unknown, deps: LockDeps, options?: AppendRecordsOptions): Promise<AppendResult> {
  return withLedger(session, 'ledger append', deps, async ({ fold }) => {
    const items = Array.isArray(input) ? input : [input];
    if (Array.isArray(input) && items.length === 0) throw new ToolError(1, 'invalid-record', 'record batch must be a non-empty array');
    const working: Fold = { records: [...fold.records], lastSeq: fold.lastSeq, torn: fold.torn };
    const results: { seq: number; deduped: boolean }[] = [];
    const toWrite: LedgerRecord[] = [];
    for (const item of items) {
      const prepared = prepareRecord(session, working, item);
      if ('deduped' in prepared) {
        results.push({ seq: prepared.seq, deduped: true });
        continue;
      }
      const stored: LedgerRecord = { ...prepared.record, key: prepared.key, seq: working.lastSeq + 1, at: new Date(deps.clock()).toISOString() };
      working.records.push(stored);
      working.lastSeq = stored.seq;
      toWrite.push(stored);
      results.push({ seq: stored.seq, deduped: false });
    }
    if (toWrite.length) writeRecords(session, fold, toWrite, options);
    fold.records = working.records;
    fold.lastSeq = working.lastSeq;
    options?.onCommit?.(fold);
    return Array.isArray(input)
      ? { seq: results.at(-1)!.seq, deduped: results.every(row => row.deduped), count: items.length, results }
      : { seq: results[0]!.seq, deduped: results[0]!.deduped };
  });
}
export async function withLedger<T>(session: string, tool: string, deps: LockDeps, fn: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
  return withLock(session, tool, deps, async broken => {
    const fold = foldLedger(session);
    const append = async (input: unknown) => {
    const prepared = prepareRecord(session, fold, input);
    if ('deduped' in prepared) return { seq: prepared.seq, deduped: true };
    const file = ledgerPath(session);
    recoverTorn(session, fold);
    const handle = fs.openSync(file, 'a');
    try {
      const seq = fold.lastSeq + 1;
      const stored = { ...prepared.record, key: prepared.key, seq, at: new Date(deps.clock()).toISOString() };
      fs.writeSync(handle, JSON.stringify(stored) + '\n');
      fs.fsyncSync(handle);
      fold.records.push(stored);
      fold.lastSeq = seq;
      return { seq, deduped: false };
    } finally {
      fs.closeSync(handle);
    }
    };
    if (broken) await append({
      kind: 'note', key: 'stale-lock:' + broken.host + ':' + broken.pid + ':' + broken.at, by: 'tool',
      data: {text: 'Broke stale lock from pid ' + broken.pid + ' on ' + broken.host},
    });
    return fn({fold,append});
  });
}

export function queryLedger(fold: Fold, filter: { kind?: unknown; key?: unknown; since?: unknown } = {}): LedgerRecord[] {
  if (filter.kind !== undefined && !KINDS.includes(filter.kind as typeof KINDS[number])) {
    throw new ToolError(1, 'invalid-input', `filter.kind must be one of: ${KINDS.join(', ')}.`);
  }
  let since = 0;
  if (filter.since !== undefined) {
    if (typeof filter.since !== 'string' && typeof filter.since !== 'number') {
      throw new ToolError(1, 'invalid-input', 'filter.since must be a nonnegative safe integer.');
    }
    since = Number(filter.since);
    if (String(filter.since).trim() === '' || !Number.isSafeInteger(since) || since < 0) {
      throw new ToolError(1, 'invalid-input', 'filter.since must be a nonnegative safe integer.');
    }
  }
  return fold.records.filter(row =>
    (filter.kind === undefined || row.kind === filter.kind) &&
    (filter.key === undefined || row.key === filter.key) && row.seq > since);
}

export function levelGate(fold: Fold, level?: string): { allowed: boolean; reason?: string } {
  const selected = latest(fold, 'level');
  level ??= selected?.data['level'] ?? 'medium';
  if (['xhigh', 'max'].includes(level!) && (selected?.by !== 'user' || selected.data['level'] !== level)) {
    return { allowed: false, reason: 'level-unapproved' };
  }
  return { allowed: true };
}

// SECTION: intent confirmation
// Fail closed: a missing spec hash or confirm record cannot match, so the spec is never implicitly confirmed.
export function confirmGate(fold: Fold, specHash: string | null | undefined): { allowed: boolean; reason?: string } {
  const confirmed = latest(fold, 'confirm')?.data['spec'];
  if (typeof specHash !== 'string' || typeof confirmed !== 'string' || !approvalChain(fold, 'spec', confirmed, specHash).allowed) {
    return { allowed: false, reason: 'missing-confirmation' };
  }
  return { allowed: true };
}

export function gate(fold: Fold, current: Hashes, level?: string): { allowed: boolean; reason?: string; artifact?: string } {
  const decision = levelGate(fold, level);
  if (!decision.allowed) return decision;
  const confirmation = confirmGate(fold, current.spec);
  if (!confirmation.allowed) return confirmation;
  level ??= latest(fold, 'level')?.data['level'] ?? 'medium';
  if (level === 'low') return { allowed: true };
  const approval = latest(fold, 'approval');
  const bind = latest(fold, 'bind');
  const artifacts = Object.keys(bind?.data ?? current);
  if (!approval || artifacts.some(kind => !Object.hasOwn(approval.data, kind))) {
    return { allowed: false, reason: 'missing-approval' };
  }
  for (const artifact of artifacts) {
    const chain = approvalChain(fold, artifact, approval.data[artifact], current[artifact as ArtifactKind], approval.seq);
    if (!chain.allowed) return { ...chain, artifact };
  }
  return { allowed: true };
}
