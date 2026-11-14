export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Level = (typeof LEVELS)[number];
export type FindingId = string;
export type SlotId = string;
export type FailureClass =
  | 'quota' | 'context-overflow' | 'auth' | 'model-not-found' | 'cli-outdated' | 'model-not-loaded'
  | 'sandbox-unsupported' | 'not-found' | 'timeout' | 'buffer' | 'empty-output' | 'capacity' | 'refusal' | 'no-report' | 'blocked'
  | 'truncated' | 'integrity' | 'config';

export type QuotaKey = { provider: string; model: string | null; mode: string };
export type QuotaGeneration = { schemaVersion: 1; key: QuotaKey; generation: string };
export type QuotaObservation = QuotaGeneration & { bucket: number; observedAt: number };
export type QuotaDecision = { key: QuotaKey; generation: string | null; skipped: boolean; reason: 'quota-cooldown' | null; observedAt?: number; expiresAt?: number };
export type QuotaSnapshot = { schemaVersion: 1; policyVersion: 1; decidedAt: number; decisions: QuotaDecision[] };

export type DiagnosticCounters = { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite5m?: number; cacheWrite1h?: number; reasoning?: number };
export type DiagnosticBand = 'le100k' | 'le200k' | 'le272k' | 'gt272k';
export type DiagnosticModelUsage = DiagnosticCounters & { bands?: Partial<Record<DiagnosticBand, DiagnosticCounters>> };
export type DiagnosticUsage = DiagnosticCounters & { scope: 'invocation' | 'turn-delta' | 'session-cumulative'; provenance: string; inputSemantics: 'includes-cache' | 'uncached'; actualModels?: string[]; models?: Record<string, DiagnosticModelUsage>; actualEffort?: string | null; reasoningInOutput?: boolean };

/** Why a launched CLI invocation has no or incomplete measured usage; fixed enum so exception text never renders. */
export type CoverageReason = 'no usage' | 'transcript unavailable';
