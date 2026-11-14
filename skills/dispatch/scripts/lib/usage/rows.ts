import type { DiagnosticBand, DiagnosticCounters } from '../../toolkit/types.ts';
import type { readOpencodeMessages } from '../opencode-db.ts';

export const HOST_ROLES = ['host', 'subagent'] as const;
export const HOST_NOTES = ['subagents over size cap', 'read budget reached', 'too many candidates', 'zstd unavailable', 'unparsed lines', 'unreadable files', 'unverified candidates'] as const;
export const HOST_UNAVAILABLE = ['no adapter', 'no host id', 'invalid host id', 'invalid session start', 'host id file missing', 'transcript over size cap', 'zstd unavailable', 'no usage records', 'read-error:ENOENT', 'read-error:EACCES', 'read-error:EPERM', 'read-error:EBUSY', 'read-error:EMFILE', 'read-error:EUNKNOWN'] as const;
export const STAGE_ORDER = ['spec', 'design', 'design review', 'plan', 'plan review', 'implementation', 'code review', 'ask'] as const;
export type HostStage = typeof STAGE_ORDER[number];
export type HostRole = typeof HOST_ROLES[number];
export type Counters = DiagnosticCounters;
export type UsageRow = Counters & {
  model: string;
  effort: string | null;
  role: 'host' | 'subagent' | 'delegate';
  depth: number;
  atMs: number;
  wholeSecond?: true;
  reasoningInOutput: boolean;
};
export type HostUsageRow = { stage: HostStage; phase?: string; role: HostRole; model: string; effort: string | null } & Counters & { bands?: Partial<Record<DiagnosticBand, Counters>>; reasoningInOutput?: boolean };
export type HostUnavailable = typeof HOST_UNAVAILABLE[number];
export type HostNote = typeof HOST_NOTES[number];
export type HostNotes = Partial<Record<HostRole, Partial<Record<HostNote, number>>>>;
export type HostUsageFacts = { platform: string | null; rows: HostUsageRow[]; unavailable?: HostUnavailable; notes?: HostNotes };
export type Milestone = { stage: HostStage; atMs: number };
export type PhaseMilestone = { phase: string; atMs: number };
export type ReadBudget = { remaining: number };
export type HostUsageQuery = { sessionId: string; startMs: number; endMs: number; home: string; env: (name: string) => string | undefined; stages: readonly Milestone[]; phases?: readonly PhaseMilestone[]; budget: ReadBudget };
export type DelegateQuery = {
  platform: 'claude' | 'codex' | 'opencode' | 'agy';
  sessionId: string;
  startMs: number;
  endMs: number;
  resumed: boolean;
  stdoutHasUsage: boolean;
  home: string;
  env: (name: string) => string | undefined;
  cwd?: string;
  appDataDir?: string;
  fs: HostUsageFs;
  budget: ReadBudget;
};
export type HostUsageFs = { list(dir: string): string[]; stat(file: string): { size: number; mtimeMs: number } | null; read(file: string, maxBytes: number): Buffer; decompress: ((data: Buffer, maxBytes: number) => Buffer) | null; sqliteGenMetadata?: (file: string) => readonly Uint8Array[] | null; opencodeMessages?: typeof readOpencodeMessages };
export type HostUsageResult = { rows: (UsageRow & { stage: HostStage })[]; unavailable?: HostUnavailable; notes?: HostNotes };
export type HostUsageAdapter = { sessionEnv: readonly string[]; read(query: HostUsageQuery, fs: HostUsageFs): HostUsageResult };

const OPTIONAL_COUNTERS = ['cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning'] as const;

export function addCounters<T extends Counters>(total: T, part: Counters): T {
  total.input += part.input;
  total.output += part.output;
  for (const key of OPTIONAL_COUNTERS) {
    if (total[key] !== undefined || part[key] !== undefined) total[key] = (total[key] ?? 0) + (part[key] ?? 0);
  }
  return total;
}

export const tokenTotal = (u: Counters): number => u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + u.output;

export const usageKey = (model: string | null | undefined, effort: string | null | undefined): string => `${model ?? ''}#${effort ?? ''}`;

export function splitUsageKey(key: string): { model: string; effort: string | undefined } {
  const at = key.indexOf('#');
  return at < 0 ? { model: key, effort: undefined } : { model: key.slice(0, at), effort: key.slice(at + 1) };
}
