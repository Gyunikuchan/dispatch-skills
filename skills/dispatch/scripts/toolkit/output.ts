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
