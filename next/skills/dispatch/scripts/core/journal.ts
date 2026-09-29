// Append-only run journal `<run>/events.jsonl` (spec §4.1).

import path from 'node:path';
import type { EventType, JournalLine, Ports } from './types.ts';

export const JOURNAL_FILE = 'events.jsonl';

/** Invariant breach that aborts a send with exit 2 (spec §12). */
export class EngineFault extends Error {
  override name = 'EngineFault';
}

export interface JournalRead {
  lines: JournalLine[];
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

export function readJournal(ports: Ports, runDir: string): JournalRead {
  const file = journalPath(runDir);
  if (!ports.fs.exists(file)) return { lines: [], tornTail: false, goodBytes: 0 };
  const text = ports.fs.readText(file);
  const segments = text.split('\n');
  // NOTE: a trailing newline leaves one empty final segment; anything else there is a torn write.
  const last = segments.pop() ?? '';
  let tornTail = last !== '';
  const lines: JournalLine[] = [];
  let goodBytes = 0;
  for (const [index, segment] of segments.entries()) {
    const line = parseLine(segment);
    if (!line) {
      if (index === segments.length - 1 && !tornTail) { tornTail = true; break; }
      throw new EngineFault(`journal ${file}: unparseable line ${index + 1} mid-file`);
    }
    if (line.v !== 1) throw new EngineFault(`journal ${file}: line ${index + 1} has v=${String(line.v)}; only v=1 is supported`);
    if (line.seq !== index + 1) throw new EngineFault(`journal ${file}: seq gap at line ${index + 1} (found ${line.seq})`);
    lines.push(line);
    goodBytes += Buffer.byteLength(segment, 'utf8') + 1;
  }
  if (tornTail) ports.proc.stderr(`[dispatch] dropped torn last journal line in ${file}\n`);
  return { lines, tornTail, goodBytes };
}

/** Appends one line; `nextSeq` skips a re-read when the caller already knows it. */
export function appendEvent(ports: Ports, runDir: string, type: EventType, data: Readonly<Record<string, unknown>>, nextSeq?: number): JournalLine {
  const seq = nextSeq ?? readJournal(ports, runDir).lines.length + 1;
  const line: JournalLine = { seq, v: 1, at: new Date(ports.clock.now()).toISOString(), type, data };
  ports.fs.appendDurable(journalPath(runDir), `${JSON.stringify(line)}\n`);
  return line;
}
