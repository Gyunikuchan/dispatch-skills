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
type QuotaDecision = { key: QuotaKey; generation: string | null; skipped: boolean; reason: 'quota-cooldown' | null; observedAt?: number; expiresAt?: number };
export type QuotaSnapshot = { schemaVersion: 1; policyVersion: 1; decidedAt: number; decisions: QuotaDecision[] };
