import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from '../lib/session.ts';
import { artifactHash, artifactKind, readArtifact, type ArtifactKind } from './artifacts.ts';
import { stableValue } from './domain/stable-value.ts';
import { withLock, type LockDeps } from './lock.ts';
import { ToolError } from './output.ts';
import { defaultKey, KINDS, validateRecord, type LedgerRecord, type RecordInput } from './records.ts';

export type Fold = { records: LedgerRecord[]; lastSeq: number; torn: Buffer | null };
export type Hashes = Partial<Record<ArtifactKind, string | null>>;
const ledgerPath = (session: string) => path.join(session, 'ledger.jsonl');

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
  while (offset < bytes.length) {
    line++;
    const end = bytes.indexOf(10, offset);
    if (end === -1) {
      torn = bytes.subarray(offset);
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(offset, end).toString('utf8'));
    } catch {
      if (end === bytes.length - 1) {
        torn = bytes.subarray(offset);
        break;
      }
      throw new ToolError(2, 'ledger-corrupt', 'invalid JSON at line ' + line);
    }
    try {
      const record = validateRecord(parsed, true) as LedgerRecord;
      if (record.seq <= lastSeq) throw new Error('seq');
      records.push(record);
      lastSeq = record.seq;
    } catch {
      throw new ToolError(2, 'ledger-corrupt', 'invalid record at line ' + line);
    }
    offset = end + 1;
  }
  return { records, lastSeq, torn };
}

export function latest(fold: Fold, kind: string): LedgerRecord | undefined {
  return fold.records.findLast(record => record.kind === kind);
}

export function currentHashes(root: string, bind: Record<string, any> | LedgerRecord | undefined): Hashes {
  const result: Hashes = {};
  const data = bind && 'data' in bind ? bind.data : bind;
  for (const [kind, file] of Object.entries(data ?? {})) {
    const source = readArtifact(root, file as string);
    result[kind as ArtifactKind] = source === null ? null : artifactHash(kind as ArtifactKind, source);
  }
  return result;
}

function content(record: RecordInput | LedgerRecord): string {
  return stableValue({
    kind: record.kind, by: record.by,
    ...(record.quote !== undefined ? { quote: record.quote } : {}), data: record.data,
  });
}

export async function appendRecord(session: string, input: unknown, deps: LockDeps): Promise<{ seq: number; deduped: boolean }> {
  return withLock(session, 'ledger append', deps, async broken => {
    const fold = foldLedger(session);
    const record = validateRecord(input) as RecordInput;
    const key = record.key ?? defaultKey(record);
    const existing = fold.records.find(row => row.key === key);
    if (existing) {
      if (content(existing) !== content(record)) throw new ToolError(2, 'key-conflict', 'key ' + key + ' has different content');
      return { seq: existing.seq, deduped: true };
    }

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
      const hashes = currentHashes(root, bind);
      if (!bind || stableValue(hashes) !== stableValue(record.data)) {
        throw new ToolError(1, 'approval-stale', 'approval hashes differ from current bound artifacts');
      }
    }
    if (record.kind === 'edit' && !Object.hasOwn(bind?.data ?? {}, record.data['artifact'])) {
      throw new ToolError(1, 'invalid-record', 'data.artifact is not bound');
    }

    const file = ledgerPath(session);
    if (fold.torn) {
      let n = 1;
      while (fs.existsSync(path.join(session, 'ledger.torn-' + n + '.jsonl'))) n++;
      fs.writeFileSync(path.join(session, 'ledger.torn-' + n + '.jsonl'), fold.torn, { flag: 'wx' });
      fs.truncateSync(file, fs.statSync(file).size - fold.torn.length);
    }
    const handle = fs.openSync(file, 'a');
    try {
      if (broken) {
        const note = {
          seq: ++fold.lastSeq, key: 'stale-lock:' + broken.host + ':' + broken.pid + ':' + broken.at,
          at: new Date(deps.clock()).toISOString(), kind: 'note', by: 'tool',
          data: { text: 'Broke stale lock from pid ' + broken.pid + ' on ' + broken.host },
        };
        fs.writeSync(handle, JSON.stringify(note) + '\n');
      }
      const seq = fold.lastSeq + 1;
      fs.writeSync(handle, JSON.stringify({ ...record, key, seq, at: new Date(deps.clock()).toISOString() }) + '\n');
      fs.fsyncSync(handle);
      return { seq, deduped: false };
    } finally {
      fs.closeSync(handle);
    }
  });
}

export function queryLedger(fold: Fold, filter: { kind?: unknown; key?: unknown; since?: unknown } = {}): LedgerRecord[] {
  if (filter.kind !== undefined && !KINDS.includes(filter.kind as typeof KINDS[number])) {
    throw new ToolError(1, 'invalid-input', 'filter.kind is invalid');
  }
  let since = 0;
  if (filter.since !== undefined) {
    if (typeof filter.since !== 'string' && typeof filter.since !== 'number') {
      throw new ToolError(1, 'invalid-input', 'filter.since is invalid');
    }
    since = Number(filter.since);
    if (String(filter.since).trim() === '' || !Number.isSafeInteger(since) || since < 0) {
      throw new ToolError(1, 'invalid-input', 'filter.since is invalid');
    }
  }
  return fold.records.filter(row =>
    (filter.kind === undefined || row.kind === filter.kind) &&
    (filter.key === undefined || row.key === filter.key) && row.seq > since);
}

export function gate(fold: Fold, current: Hashes, level?: string): { allowed: boolean; reason?: string; artifact?: string } {
  const selected = latest(fold, 'level');
  level ??= selected?.data['level'] ?? 'medium';
  if (['xhigh', 'max'].includes(level!) && (selected?.by !== 'user' || selected.data['level'] !== level)) {
    return { allowed: false, reason: 'level-unapproved' };
  }
  if (level === 'low') return { allowed: true };
  const approval = latest(fold, 'approval');
  const bind = latest(fold, 'bind');
  const artifacts = Object.keys(bind?.data ?? current);
  if (!approval || artifacts.some(kind => !Object.hasOwn(approval.data, kind))) {
    return { allowed: false, reason: 'missing-approval' };
  }
  for (const artifact of artifacts) {
    let hash = approval.data[artifact];
    for (const edit of fold.records.filter(row => row.seq > approval.seq && row.kind === 'edit' && row.data['artifact'] === artifact)) {
      if (edit.data['before'] !== hash) return { allowed: false, reason: 'unrecorded-change', artifact };
      if (edit.data['class'] !== 'non-intent') return { allowed: false, reason: 'intent-change', artifact };
      hash = edit.data['after'];
    }
    if (hash !== current[artifact as ArtifactKind]) return { allowed: false, reason: 'unrecorded-change', artifact };
  }
  return { allowed: true };
}
