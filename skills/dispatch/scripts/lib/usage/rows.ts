import type { readOpencodeMessages } from '../opencode-db.ts';

export const HOST_ROLES = ['host', 'subagent'] as const;
export const HOST_NOTES = [
  'subagents over size cap',
  'read budget reached',
  'too many candidates',
  'zstd unavailable',
  'unparsed lines',
  'unreadable files',
  'unverified candidates',
] as const;
export const HOST_UNAVAILABLE = [
  'no adapter',
  'no host id',
  'invalid host id',
  'invalid session start',
  'host id file missing',
  'transcript over size cap',
  'zstd unavailable',
  'no usage records',
  'read-error:ENOENT',
  'read-error:EACCES',
  'read-error:EPERM',
  'read-error:EBUSY',
  'read-error:EMFILE',
  'read-error:EUNKNOWN',
] as const;
export const STAGE_ORDER = [
  'spec',
  'design',
  'design review',
  'plan',
  'plan review',
  'implementation',
  'code review',
  'ask',
] as const;
export type HostStage = (typeof STAGE_ORDER)[number];
export type HostRole = (typeof HOST_ROLES)[number];
const CACHE_COUNTER_KEYS = ['cacheRead', 'cacheWrite'] as const;
export const BASE_OPTIONAL_COUNTER_KEYS = [...CACHE_COUNTER_KEYS, 'reasoning'] as const;
export const OPTIONAL_COUNTER_KEYS = [...CACHE_COUNTER_KEYS, 'cacheWrite5m', 'cacheWrite1h', 'reasoning'] as const;
export const COUNTER_KEYS = ['input', 'output', ...OPTIONAL_COUNTER_KEYS] as const;
export type Counters = { input: number; output: number } & Partial<
  Record<(typeof OPTIONAL_COUNTER_KEYS)[number], number>
>;

export const BANDS = ['le100k', 'le200k', 'le272k', 'gt272k'] as const;
export type Band = (typeof BANDS)[number];
export type Bands = Partial<Record<Band, Counters>>;
export type BandedCounters = Counters & { bands?: Bands };
export const MAX_RESPONSE_AGENTS = 32;
export const HOST_RESPONSE_BASES = [
  'agy-planner-response',
  'claude-assistant-message',
  'codex-token-count',
  'opencode-assistant-message',
  'copilot-usage-record',
] as const;
export const RESPONSE_STAGES = [...STAGE_ORDER, 'unattributed'] as const;
export const RESPONSE_COVERAGES = ['complete', 'partial', 'unknown'] as const;
export type HostResponseBasis = (typeof HOST_RESPONSE_BASES)[number];
export type ResponseStage = (typeof RESPONSE_STAGES)[number];
export type ResponseCoverage = (typeof RESPONSE_COVERAGES)[number];
export type CopilotEvidence = {
  tokenCoverage: ResponseCoverage;
  lineageCoverage: ResponseCoverage;
  actorCoverage: ResponseCoverage;
  billing: { coverage: ResponseCoverage; totalNanoAiu?: number; statuses?: string[]; multipliers?: number[] };
};
export type CopilotActor = BandedCounters & {
  turns?: number;
  agent?: string;
  parent?: string;
  role: 'host' | 'delegate' | 'subagent';
  model: string;
  effort: string | null;
  depth?: number;
  copilot: CopilotEvidence;
};
export type DelegateResponse = {
  role: 'delegate' | 'subagent';
  basis: HostResponseBasis | 'unavailable';
  coverage: ResponseCoverage;
  observed?: number;
  uncachedInput?: number;
  toolCalls?: number;
  toolTurns?: number;
};

export type DiagnosticModelUsage = Counters & { bands?: Bands; turns?: number; toolCalls?: number; toolTurns?: number };
export type DiagnosticUsage = Counters & {
  copilot?: CopilotEvidence;
  actors?: CopilotActor[];
  scope: 'invocation' | 'turn-delta' | 'session-cumulative';
  provenance: string;
  inputSemantics: 'includes-cache' | 'uncached';
  actualModels?: string[];
  models?: Record<string, DiagnosticModelUsage>;
  actualEffort?: string | null;
  reasoningInOutput?: boolean;
  turns?: number;
  toolCalls?: number;
  toolTurns?: number;
};

/** Why a launched CLI invocation has no or incomplete measured usage; fixed enum so exception text never renders. */
export const COVERAGE_REASONS = ['no usage', 'transcript unavailable', 'invalid counters', 'unverified zero'] as const;
export type CoverageReason = (typeof COVERAGE_REASONS)[number];
export type UsageSource = 'session' | 'stdout';

export type HostResponseAggregate = {
  stage: ResponseStage;
  role: HostRole;
  agent?: string;
  basis: HostResponseBasis;
  coverage: ResponseCoverage;
  observed?: number;
  uncachedInput?: number;
  toolCalls?: number;
  toolTurns?: number;
};
export type UsageRow = Counters & {
  model: string;
  effort: string | null;
  role: 'host' | 'subagent' | 'delegate';
  depth?: number;
  atMs: number;
  wholeSecond?: true;
  reasoningInOutput: boolean;
  turns?: number;
  toolCalls?: number;
  toolTurns?: number;
  responseActor?: string; // Adapter-local identity, projected to an alias before returning facts.
  parentActor?: string;
  copilot?: CopilotEvidence;
  skipResponse?: true;
};
export type HostUsageRow = {
  stage: HostStage;
  phase?: string;
  role: HostRole;
  model: string;
  effort: string | null;
} & Counters & {
    bands?: Bands;
    reasoningInOutput?: boolean;
    turns?: number;
    toolCalls?: number;
    toolTurns?: number;
    maxDepth?: number;
    agent?: string;
    parent?: string;
    copilot?: CopilotEvidence;
  };
export type HostUnavailable = (typeof HOST_UNAVAILABLE)[number];
export type HostNote = (typeof HOST_NOTES)[number];
export type HostNotes = Partial<Record<HostRole, Partial<Record<HostNote, number>>>>;
export type HostUsageFacts = {
  platform: string | null;
  rows: HostUsageRow[];
  responses?: HostResponseAggregate[];
  userTurns?: number;
  userTurnsByStage?: Partial<Record<HostStage, number>>;
  subagentCount?: number;
  maxSubagentDepth?: number;
  unavailable?: HostUnavailable;
  notes?: HostNotes;
};
export type Milestone = { stage: HostStage; atMs: number };
export type PhaseMilestone = { phase: string; atMs: number };
export type ReadBudget = { remaining: number };
export type HostUsageQuery = {
  collectResponses?: true;
  sessionId: string;
  startMs: number;
  endMs: number;
  home: string;
  env: (name: string) => string | undefined;
  stages: readonly Milestone[];
  phases?: readonly PhaseMilestone[];
  budget: ReadBudget;
};
export type DelegateQuery = {
  collectResponses?: true;
  platform: 'claude' | 'codex' | 'opencode' | 'agy' | 'copilot';
  sessionId: string;
  startMs: number;
  endMs: number;
  resumed: boolean;
  home: string;
  env: (name: string) => string | undefined;
  cwd?: string;
  appDataDir?: string;
  fs: HostUsageFs;
  budget: ReadBudget;
};
export type HostUsageFs = {
  list(dir: string): string[];
  stat(file: string): { size: number; mtimeMs: number } | null;
  read(file: string, maxBytes: number): Buffer;
  decompress: ((data: Buffer, maxBytes: number) => Buffer) | null;
  sqliteGenMetadata?: (file: string) => readonly Uint8Array[] | null;
  opencodeMessages?: typeof readOpencodeMessages;
};
export type HostUsageResult = {
  rows: (UsageRow & { stage: HostStage })[];
  response?: { basis: HostResponseBasis; limited?: true };
  userTurns?: number;
  userTurnsByStage?: Partial<Record<HostStage, number>>;
  unavailable?: HostUnavailable;
  notes?: HostNotes;
};
export type HostUsageAdapter = {
  sessionEnv: readonly string[];
  read(
    query: HostUsageQuery,
    fs: HostUsageFs,
    delegate?: Pick<DelegateQuery, 'cwd' | 'appDataDir' | 'startMs' | 'collectResponses'>,
  ): HostUsageResult;
};

export function addCounters<T extends Counters>(total: T, part: Counters): T {
  total.input += part.input;
  total.output += part.output;
  for (const key of OPTIONAL_COUNTER_KEYS) {
    if (total[key] !== undefined || part[key] !== undefined) total[key] = (total[key] ?? 0) + (part[key] ?? 0);
  }
  return total;
}

export const tokenTotal = (u: Counters): number => u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + u.output;

export const usageKey = (model: string | null | undefined, effort: string | null | undefined): string =>
  `${model ?? ''}#${effort ?? ''}`;

export function splitUsageKey(key: string): { model: string; effort: string | undefined } {
  const at = key.indexOf('#');
  return at < 0 ? { model: key, effort: undefined } : { model: key.slice(0, at), effort: key.slice(at + 1) };
}

export function mergeCopilot(parts: readonly (CopilotEvidence | undefined)[]): CopilotEvidence | undefined {
  if (!parts.some(Boolean)) return undefined;
  const coverage = (key: 'tokenCoverage' | 'lineageCoverage' | 'actorCoverage'): ResponseCoverage =>
    parts.every((p) => p?.[key] === 'complete')
      ? 'complete'
      : parts.every((p) => !p || p[key] === 'unknown')
        ? 'unknown'
        : 'partial';
  const billing = parts.map((p) => p?.billing);
  const measured = billing.filter((b) => b?.totalNanoAiu !== undefined);
  const total = measured.reduce((s, b) => s + b!.totalNanoAiu!, 0);
  const allStatuses = [...new Set(billing.flatMap((b) => b?.statuses ?? []))];
  const allMultipliers = [...new Set(billing.flatMap((b) => b?.multipliers ?? []))];
  const statuses = allStatuses.slice(0, 8),
    multipliers = allMultipliers.slice(0, 8);
  return {
    tokenCoverage: coverage('tokenCoverage'),
    lineageCoverage: coverage('lineageCoverage'),
    actorCoverage: coverage('actorCoverage'),
    billing: {
      coverage:
        billing.every((b) => b?.coverage === 'complete') &&
        Number.isSafeInteger(total) &&
        allStatuses.length <= 8 &&
        allMultipliers.length <= 8
          ? 'complete'
          : measured.length
            ? 'partial'
            : 'unknown',
      ...(measured.length && Number.isSafeInteger(total) ? { totalNanoAiu: total } : {}),
      ...(statuses.length ? { statuses } : {}),
      ...(multipliers.length ? { multipliers } : {}),
    },
  };
}
