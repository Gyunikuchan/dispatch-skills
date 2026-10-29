import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ToolResult = { ok: boolean; summary: string; path: string | null; reason?: string; exit: number };
export class ToolError extends Error {
  readonly exit: number;
  readonly reason: string;
  constructor(exit: number, reason: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.exit = exit;
    this.reason = reason;
  }
}

export function capSummary(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= 1024) return text;
  let result = '';
  let bytes = 3;
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > 1024) break;
    result += point;
    bytes += size;
  }
  return result + '…';
}

// Counts stay in `head` so a truncated list never hides totals; the omission notice is budgeted before any item.
const SUMMARY_ITEM_LIMIT = 5;
const SUMMARY_ITEM_BYTES = 200;
function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  let result = '';
  let bytes = Buffer.byteLength('…', 'utf8');
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > max) break;
    result += point;
    bytes += size;
  }
  return result + '…';
}

export function summaryWithItems(head: string, items: readonly string[]): string {
  if (!items.length) return head;
  const clipped = items.map(item => clipBytes(item, SUMMARY_ITEM_BYTES));
  for (let shown = Math.min(SUMMARY_ITEM_LIMIT, clipped.length); shown > 0; shown--) {
    const omitted = clipped.length - shown;
    const text = head + '; first ' + shown + ': ' + clipped.slice(0, shown).join('; ') + (omitted > 0 ? '; +' + omitted + ' more in result' : '');
    if (Buffer.byteLength(text, 'utf8') <= 1024) return text;
  }
  return head;
}

export function writeResult(session: string, tool: string, action: string, value: unknown): string {
  const directory = path.join(path.resolve(session), '.state', 'results');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, tool + '-' + action + '-' + crypto.randomUUID() + '.json');
  const temp = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally { fs.rmSync(temp, { force: true }); }
  return target;
}
