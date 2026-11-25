import assert from 'node:assert/strict';

import type { ProbeModel } from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';

// Test-side contract of the declaration-less probe script: inputs stay `unknown`, results name what tests read.

export type ProbeLiveRecord = {
  id: string;
  lifecycle: string;
  liveness: string;
  exitConfirmed: boolean;
  launches: number;
  attempts: number;
  startedAt: number;
  deadlineAt: number;
  handle: string | null;
  outcome: string;
  cause: string;
  gaps: Array<string>;
  checks: { attached: string; sibling: string };
  denylist: { launches: number; behaviour: string; payloadExcluded: boolean };
  usage: unknown;
  capture: string | null;
  cleanup: string;
  cleanupReason: unknown;
  carried?: boolean;
  selection: unknown;
  generationLimit: unknown;
};

export type ProbeTarget = {
  id: string;
  mode: string;
  model: string | null;
  effort: string | null;
  launchLimit: number;
  skip: string | null;
};

export type ProbeModule = {
  PROBE_LEVEL: string;
  createFixture(
    repoRoot: string,
    options: { home: string },
  ): {
    dir: string;
    attached: string;
    sibling: string;
    denylisted: string;
    nonces: { attached: string; sibling: string; denylisted: string };
    prompt: string;
    denyPrompt: string;
  };
  cleanupFixture(
    fixture: unknown,
    records: unknown,
    fsPort: unknown,
  ): { status: string; reason: { code: string; errorCode?: string } | null };
  buildTargets(rows: unknown, options: unknown): Array<ProbeTarget>;
  discover(mods: unknown, providers: Array<string>, ports: unknown): Promise<Array<{ provider: string }>>;
  runTarget(target: unknown, context: unknown): Promise<ProbeLiveRecord>;
  loadConfig(
    repoRoot: string,
    read?: (file: string) => string | null,
  ): { config: unknown; readCommands: ReadonlyArray<string>; error: string | null };
  claimProbe(
    workDir: string,
    rows: unknown,
    selection: unknown,
    io: unknown,
  ): { targets: Array<ProbeTarget>; previous: { [id: string]: ProbeLiveRecord } };
  priorDisposition(previous: unknown): string;
  releaseReservation(probes: unknown, id: string, startedAt: string): void;
  interruptedRecords(targets: unknown, latest: unknown, previous: unknown): Array<ProbeLiveRecord>;
  main(options: unknown): Promise<{ rows: Array<unknown>; live: Array<ProbeLiveRecord>; interrupted: boolean }>;
  selectModel(config: unknown, provider: string): ProbeModel | null;
};

const FUNCTIONS: ReadonlyArray<Exclude<keyof ProbeModule, 'PROBE_LEVEL'>> = [
  'createFixture',
  'cleanupFixture',
  'buildTargets',
  'discover',
  'runTarget',
  'loadConfig',
  'claimProbe',
  'priorDisposition',
  'releaseReservation',
  'interruptedRecords',
  'main',
  'selectModel',
];

function isProbeModule(value: unknown): value is ProbeModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const exported = new Map<string, unknown>(Object.entries(value));
  return FUNCTIONS.every((name) => typeof exported.get(name) === 'function') && exported.has('PROBE_LEVEL');
}

export async function loadProbe(): Promise<ProbeModule> {
  const url = new URL('../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs', import.meta.url);
  const loaded: unknown = await import(url.href);
  assert.ok(isProbeModule(loaded), 'probe-dispatch.mjs no longer exports the tested helpers');
  return loaded;
}
