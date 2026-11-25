import { isRecord } from '../config.ts';
import { nodeErrorCode } from '../fs-ext.ts';
import type { JsonObject } from '../integrity.ts';
import { BASE_OPTIONAL_COUNTER_KEYS } from './rows.ts';
import type {
  Counters,
  DiagnosticUsage,
  HostNote,
  HostNotes,
  HostRole,
  HostUnavailable,
  HostUsageFs,
  HostUsageResult,
  Milestone,
  PhaseMilestone,
  ReadBudget,
} from './rows.ts';

export const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

type TranscriptRead = { text?: string; stop?: 'file cap' | 'budget' | 'zstd' };

export function readTranscript(fs: HostUsageFs, file: string, budget: ReadBudget): TranscriptRead {
  const stat = fs.stat(file);
  if (!stat) {
    return {};
  }
  const limit = Math.min(MAX_FILE_BYTES, budget.remaining);
  const stop = () => {
    const reason = limit === MAX_FILE_BYTES ? 'file cap' : 'budget';
    if (reason === 'budget') {
      budget.remaining = 0;
    }
    return { stop: reason } as const;
  };
  if (limit <= 0) {
    return stop();
  }
  const compressed = file.endsWith('.zst');
  if (compressed && stat.size > MAX_FILE_BYTES * 2) {
    return { stop: 'file cap' };
  }
  if (!compressed && stat.size > limit) {
    return stop();
  }
  if (compressed && !fs.decompress) {
    return { stop: 'zstd' };
  }
  const input = fs.read(file, compressed ? MAX_FILE_BYTES * 2 + 1 : limit + 1);
  if (compressed && input.length > MAX_FILE_BYTES * 2) {
    return { stop: 'file cap' };
  }
  if (!compressed && input.length > limit) {
    return stop();
  }
  let decoded: Buffer;
  try {
    decoded = compressed && fs.decompress ? fs.decompress(input, limit) : input;
  } catch (error) {
    if (nodeErrorCode(error) === 'ERR_BUFFER_TOO_LARGE') {
      budget.remaining -= limit;
      return stop();
    }
    throw error;
  }
  if (decoded.length > limit) {
    budget.remaining -= limit;
    return stop();
  }
  budget.remaining -= decoded.length;
  return { text: decoded.toString('utf8') };
}
export function readRoleTranscript(
  fs: HostUsageFs,
  file: string,
  budget: ReadBudget,
  result: HostUsageResult,
  role: HostRole,
  oversizedSubagent: HostNote = 'subagents over size cap',
): string | undefined {
  try {
    const { text, stop } = readTranscript(fs, file, budget);
    if (text !== undefined) {
      return text;
    }
    const notes = (result.notes ??= {});
    if (stop === 'budget') {
      note(notes, role, 'read budget reached');
    } else if (role === 'host') {
      result.unavailable =
        stop === 'zstd' ? 'zstd unavailable' : stop ? 'transcript over size cap' : 'read-error:ENOENT';
    } else {
      note(notes, role, stop === 'zstd' ? 'zstd unavailable' : stop ? oversizedSubagent : 'unreadable files');
    }
  } catch (error) {
    if (role === 'host') {
      result.unavailable = readErrorReason(error);
    } else {
      note((result.notes ??= {}), role, 'unreadable files');
    }
  }
  return undefined;
}

export function stageAt(stages: ReadonlyArray<Milestone>, ms: number) {
  let selected = stages[0];
  for (const stage of stages) {
    if (stage.atMs <= ms && (!selected || stage.atMs >= selected.atMs || selected.atMs > ms)) {
      selected = stage;
    }
  }
  return selected?.stage ?? 'spec';
}
export function phaseAt(phases: ReadonlyArray<PhaseMilestone>, ms: number): string | undefined {
  let selected: PhaseMilestone | undefined;
  for (const phase of phases) {
    if (phase.atMs <= ms && (!selected || phase.atMs >= selected.atMs)) {
      selected = phase;
    }
  }
  return selected?.phase;
}
const READ_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE'] as const;

export function readErrorReason(error: unknown): HostUnavailable {
  const code = nodeErrorCode(error);
  const known = READ_ERROR_CODES.find((candidate) => candidate === code);
  return known ? `read-error:${known}` : 'read-error:EUNKNOWN';
}
export function note(notes: HostNotes, role: HostRole, name: HostNote, count = 1) {
  const target = (notes[role] ??= {});
  target[name] = (target[name] ?? 0) + count;
}
export const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export type Row = JsonObject;
export const row = (v: unknown): Row | null => (isRecord(v) ? v : null);
export const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function baseCounters(value: unknown): Counters | undefined {
  const r = row(value);
  if (!r || !count(r['input']) || !count(r['output'])) {
    return undefined;
  }
  const out: Counters = { input: r['input'], output: r['output'] };
  for (const key of BASE_OPTIONAL_COUNTER_KEYS) {
    const n = r[key];
    if (n === undefined) {
      continue;
    }
    if (!count(n)) {
      return undefined;
    }
    out[key] = n;
  }
  const short = r['cacheWrite5m'],
    long = r['cacheWrite1h'];
  // An invalid split does not invalidate the observed total cache writes.
  if (
    (short === undefined || count(short)) &&
    (long === undefined || count(long)) &&
    (short ?? 0) + (long ?? 0) <= (out.cacheWrite ?? 0)
  ) {
    if (short !== undefined) {
      out.cacheWrite5m = short;
    }
    if (long !== undefined) {
      out.cacheWrite1h = long;
    }
  }
  return out;
}

export function hasUsageTokens(counters: Counters): boolean {
  return (
    counters.input > 0 ||
    counters.output > 0 ||
    (counters.cacheRead ?? 0) > 0 ||
    (counters.cacheWrite ?? 0) > 0 ||
    (counters.reasoning ?? 0) > 0
  );
}

export function counters(
  value: unknown,
  names: Record<string, string>,
  provenance: string,
  inputSemantics: DiagnosticUsage['inputSemantics'],
): DiagnosticUsage | undefined {
  const r = row(value);
  const inputName = names['input'],
    outputName = names['output'];
  if (!r || inputName === undefined || outputName === undefined) {
    return undefined;
  }
  const input = r[inputName],
    output = r[outputName];
  if (!count(input) || !count(output)) {
    return undefined;
  }
  const out: DiagnosticUsage = {
    input,
    output,
    scope: 'invocation',
    provenance,
    inputSemantics,
  };
  for (const key of BASE_OPTIONAL_COUNTER_KEYS) {
    const field = names[key];
    if (field && r[field] !== undefined) {
      if (!count(r[field])) {
        return undefined;
      }
      out[key] = r[field];
    }
  }
  return out;
}
