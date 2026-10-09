// Append-only run journal `<run>/events.jsonl` (spec §4.1).

import path from 'node:path';
import type { EventType, JournalLine, Ports, ExecutionConfigUpdated } from './types.ts';
import { applyExecutionConfig } from '../domain/execution-config.ts';

export const JOURNAL_FILE = 'events.jsonl';

/** Invariant breach that aborts a send with exit 2 (spec §12). */
export class EngineFault extends Error {
  override name = 'EngineFault';
}

/** A run whose RUN_STARTED predates the effect-folder layout; resuming it would split files across layouts. */
export class LayoutUnsupported extends Error {
  override name = 'LayoutUnsupported';
}

export interface JournalRead {
  records: Iterable<JournalLine>;
  count: number;
  started?: JournalLine;
  authored?: JournalLine;
  parsedPlan?: JournalLine;
  execution?: { config: Record<string, unknown>; revision: number };
  recent: JournalLine[];
  tornTail: boolean;
  /** Byte length of the valid prefix (excludes a torn tail). */
  goodBytes: number;
}

export function journalPath(runDir: string): string {
  return path.join(runDir, JOURNAL_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLine(text: string): JournalLine | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const { seq, v, at, type, data } = value;
    if (typeof seq !== 'number' || typeof at !== 'string' || typeof type !== 'string' || !isRecord(data)) return null;
    return { seq, v: v as 1, at, type: type as EventType, data };
  } catch {
    return null;
  }
}

function* scan(ports: Ports, file: string, metadata: JournalRead): Generator<JournalLine> {
  if (!ports.fs.exists(file)) return;
  let pieces: Buffer[] = [], physical = 0, pending: { bytes: number; text: string; invalidUtf8?: boolean } | null = null;
  const accept = (row: { bytes: number; text: string; invalidUtf8?: boolean }, final: boolean): JournalLine | null => {
    physical++;
    const line = parseLine(row.text);
    if (!line) {
      if (final) { metadata.tornTail = true; return null; }
      throw new EngineFault(`journal ${file}: unparseable line ${physical} mid-file${row.invalidUtf8 ? ' (invalid UTF-8)' : ''}`);
    }
    if (line.v !== 1) throw new EngineFault(`journal ${file}: line ${physical} has v=${String(line.v)}; only v=1 is supported`);
    if (line.seq !== physical) throw new EngineFault(`journal ${file}: seq gap at line ${physical} (found ${line.seq})`);
    metadata.goodBytes += row.bytes; metadata.count++;
    return line;
  };
  for (const raw of ports.fs.readChunks(file)) {
    const chunk = Buffer.from(raw);
    let start = 0, at: number;
    while ((at = chunk.indexOf(10, start)) >= 0) {
      pieces.push(chunk.subarray(start, at));
      const bytes = Buffer.concat(pieces); pieces = [];
      if (pending) { const line = accept(pending, false); if (line) yield line; }
      let text: string, invalidUtf8 = false;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = ''; invalidUtf8 = true; }
      pending = { bytes: bytes.length + 1, text, invalidUtf8 };
      start = at + 1;
    }
    if (start < chunk.length) pieces.push(chunk.subarray(start));
  }
  const tail = pieces.some((piece) => piece.length > 0);
  if (pending) { const line = accept(pending, !tail); if (line) yield line; }
  if (tail) metadata.tornTail = true;
}

export function readJournal(ports: Ports, runDir: string, defer = false): JournalRead {
  const file = journalPath(runDir);
  const metadata: JournalRead = { records: [], count: 0, recent: [], tornTail: false, goodBytes: 0 };
  let latestConfig: JournalLine | undefined, boundary: JournalLine | undefined;
  let collected = false;
  metadata.records = { *[Symbol.iterator]() {
    if (collected) { yield* scan(ports, file, { records: [], count: 0, recent: [], tornTail: false, goodBytes: 0 }); return; }
    for (const line of scan(ports, file, metadata)) {
      if (line.type === 'RUN_STARTED') { metadata.started = line; if (isRecord(line.data['config'])) metadata.execution = { config: line.data['config'], revision: 0 }; }
      if (line.type === 'AUTHORED') metadata.authored = line;
      if (line.type === 'ARTIFACT_PARSED' && line.data['kind'] === 'plan') metadata.parsedPlan = line;
      if (line.type === 'EXECUTION_CONFIG_UPDATED') { latestConfig = line; if (metadata.execution) { const event = { type: line.type, ...line.data } as ExecutionConfigUpdated; metadata.execution = { config: applyExecutionConfig(metadata.execution.config, event.delta), revision: event.revision }; } }
      // Lock recovery and diagnostics notes are not reply boundaries, so they never move the host's reply path.
      if (line.type !== 'LOCK_BROKEN' && line.type !== 'DIAGNOSTIC_NOTE') boundary = line;
      yield line;
    }
    metadata.recent = [...new Map([metadata.started, latestConfig, boundary].filter((line): line is JournalLine => !!line).map((line) => [line.seq, line])).values()].sort((a,b) => a.seq-b.seq);
    collected = true;
    if (metadata.tornTail) ports.proc.stderr(`[dispatch] dropped torn last journal line in ${file}\n`);
  } };
  if (!defer) for (const _line of metadata.records) { /* Collect summaries without retaining records. */ }
  return metadata;
}

/** Appends one line; `nextSeq` skips a re-read when the caller already knows it. */
export function appendEvent(ports: Ports, runDir: string, type: EventType, data: Readonly<Record<string, unknown>>, nextSeq?: number): JournalLine {
  const seq = nextSeq ?? readJournal(ports, runDir).count + 1;
  const line: JournalLine = { seq, v: 1, at: new Date(ports.clock.now()).toISOString(), type, data };
  ports.fs.appendDurable(journalPath(runDir), `${JSON.stringify(line)}\n`);
  return line;
}
