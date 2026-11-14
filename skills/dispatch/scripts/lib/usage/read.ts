import type { DiagnosticUsage } from '../../toolkit/types.ts';
import type { HostNote, HostNotes, HostRole, HostUnavailable, HostUsageFs, Milestone, PhaseMilestone, ReadBudget } from './rows.ts';

export const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export function readTranscript(fs: HostUsageFs, file: string, budget: ReadBudget): { text?: string; stop?: 'file cap' | 'budget' | 'zstd' } {
  const stat = fs.stat(file); if (!stat) return {};
  const limit = Math.min(MAX_FILE_BYTES, budget.remaining);
  const stop = () => { const reason = limit === MAX_FILE_BYTES ? 'file cap' : 'budget'; if (reason === 'budget') budget.remaining = 0; return { stop: reason } as const; };
  if (limit <= 0) return stop();
  const compressed = file.endsWith('.zst');
  if (compressed && stat.size > MAX_FILE_BYTES * 2) return { stop: 'file cap' };
  if (!compressed && stat.size > limit) return stop();
  if (compressed && !fs.decompress) return { stop: 'zstd' };
  const input = fs.read(file, compressed ? MAX_FILE_BYTES * 2 + 1 : limit + 1);
  if (compressed && input.length > MAX_FILE_BYTES * 2) return { stop: 'file cap' };
  if (!compressed && input.length > limit) return stop();
  let decoded: Buffer;
  try { decoded = compressed ? fs.decompress!(input, limit) : input; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') { budget.remaining -= limit; return stop(); } throw error; }
  if (decoded.length > limit) { budget.remaining -= limit; return stop(); }
  budget.remaining -= decoded.length; return { text: decoded.toString('utf8') };
}
export function stageAt(stages: readonly Milestone[], ms: number) { let selected = stages[0]; for (const stage of stages) if (stage.atMs <= ms && (!selected || stage.atMs >= selected.atMs || selected.atMs > ms)) selected = stage; return selected?.stage ?? 'spec'; }
export function phaseAt(phases: readonly PhaseMilestone[], ms: number): string | undefined {
  let selected: PhaseMilestone | undefined;
  for (const phase of phases) if (phase.atMs <= ms && (!selected || phase.atMs >= selected.atMs)) selected = phase;
  return selected?.phase;
}
export function readErrorReason(error: unknown): HostUnavailable { const code = (error as NodeJS.ErrnoException)?.code; return (['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE'].includes(code ?? '') ? `read-error:${code}` : 'read-error:EUNKNOWN') as HostUnavailable; }
export function note(notes: HostNotes, role: HostRole, name: HostNote, count = 1) { const target = notes[role] ??= {}; target[name] = (target[name] ?? 0) + count; }
export const counter = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export type Row = Record<string, unknown>;
export const row = (v: unknown): Row | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null;
export const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function counters(value: unknown, names: Record<string, string>, provenance: string, inputSemantics: DiagnosticUsage['inputSemantics']): DiagnosticUsage | undefined {
  const r = row(value);
  if (!r || !count(r[names['input']!]) || !count(r[names['output']!])) return undefined;
  const out: DiagnosticUsage = { input: r[names['input']!] as number, output: r[names['output']!] as number, scope: 'invocation', provenance, inputSemantics };
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const field = names[key];
    if (field && r[field] !== undefined) { if (!count(r[field])) return undefined; out[key] = r[field]; }
  }
  return out;
}
