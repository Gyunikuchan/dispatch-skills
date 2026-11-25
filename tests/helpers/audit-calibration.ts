import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CalibrationCase,
  CalibrationFixture,
  Claim,
} from '../../.agents/skills/audit-dispatch-skills/scripts/calibrate.ts';
import { tempDir } from './fake-ports.ts';

// NOTE: a literal dynamic import keeps each leaf test independently failing while the module is absent; tsc still types it.
export const load = () => import('../../.agents/skills/audit-dispatch-skills/scripts/calibrate.ts');

export const FIXTURE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '.agents',
  'skills',
  'audit-dispatch-skills',
  'fixtures',
  'calibration',
  'cases.json',
);
export const ARMS = ['old', 'new'] as const;
export const SETTINGS = { host: 'claude-code', model: 'opus', effort: 'high' };
export const NOW = () => new Date('2026-10-07T12:00:00Z');
export const readBrief = (p: string) => `brief ${p}\n`;

export type { CalibrationCase, CalibrationFixture, Claim };
// NOTE: a shallow shape check; `prepare` validates the corpus itself.
function isCorpus(value: unknown): value is CalibrationFixture {
  return (
    typeof value === 'object' && value !== null && 'briefs' in value && 'cases' in value && Array.isArray(value.cases)
  );
}
export function fixture(): CalibrationFixture {
  const value: unknown = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.ok(isCorpus(value), `not a calibration corpus: ${FIXTURE}`);
  return value;
}
function casesOfKind(
  f: CalibrationFixture,
  kind: CalibrationCase['kind'],
): [CalibrationCase, ...Array<CalibrationCase>] {
  const [first, ...rest] = f.cases.filter((c) => c.kind === kind);
  assert.ok(first, `corpus has no ${kind} case`);
  return [first, ...rest];
}
export const defects = (f: CalibrationFixture) => casesOfKind(f, 'defect');
export const controls = (f: CalibrationFixture) => casesOfKind(f, 'control');

export async function prepared(f: CalibrationFixture = fixture()) {
  const mod = await load();
  const workDir = tempDir();
  mod.prepare({ fixture: f, workDir, settings: SETTINGS, now: NOW, readBrief });
  return { mod, workDir, f };
}

export function writeClaims(workDir: string, arm: string, cases: Record<string, Array<Claim>>) {
  const file = path.join(workDir, 'calibration', 'claims', `${arm}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ arm, cases }));
}
export const defectClaim = (id: string): Claim => ({
  id,
  verdict: 'defect',
  claim: `claim ${id}`,
  evidence: [`trace ${id}`],
});

/** Claims and adjudication where `recover` lists the defect case ids each arm matched. */
export function scenario(
  f: CalibrationFixture,
  recover: Array<string>,
  extra: { controlDefect?: boolean; skip?: string } = {},
) {
  const cases: Record<string, Array<Claim>> = {};
  const matches: Record<string, { match: string | null; rationale: string }> = {};
  for (const c of defects(f)) {
    cases[c.id] = [defectClaim(`${c.id}-1`)];
    matches[c.id] = recover.includes(c.id)
      ? { match: `${c.id}-1`, rationale: 'same root cause' }
      : { match: null, rationale: 'different cause' };
  }
  for (const c of controls(f)) {
    cases[c.id] = extra.controlDefect
      ? [defectClaim(`${c.id}-1`)]
      : [{ id: `${c.id}-1`, verdict: 'none', claim: 'intended', evidence: ['trace'] }];
  }
  if (extra.skip) {
    delete cases[extra.skip];
  }
  return { cases, matches };
}

export async function scored(
  recover: (f: CalibrationFixture) => Array<string>,
  extra: { controlDefect?: boolean; skip?: string } = {},
) {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, recover(f), extra);
  for (const arm of ARMS) {
    writeClaims(workDir, arm, s.cases);
    mod.fixClaims(workDir, arm);
  }
  const usage = {
    old: { inputTokens: 100, outputTokens: 10, toolCalls: 5, wallSeconds: 60 },
    new: { inputTokens: 80, outputTokens: 10, toolCalls: 4, wallSeconds: 50 },
  };
  return mod.summarize({
    fixture: f,
    workDir,
    adjudication: { arms: { old: s.matches, new: s.matches } },
    usage,
  });
}

export const ids = (cs: ReadonlyArray<CalibrationCase>) => cs.map((c) => c.id);
export const high = (f: CalibrationFixture) =>
  ids(defects(f).filter((c) => ['high', 'critical'].includes(c.severity ?? '')));
