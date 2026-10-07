import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './fake-ports.ts';

// NOTE: a literal dynamic import keeps each leaf test independently failing while the module is absent; tsc still types it.
export const load = () => import('../../.agents/skills/audit-dispatch-skills/scripts/calibrate.ts');

export const FIXTURE = path.join(import.meta.dirname, '..', '..', '.agents', 'skills', 'audit-dispatch-skills', 'fixtures', 'calibration', 'cases.json');
export const ARMS = ['old', 'new'] as const;
export const SETTINGS = { host: 'claude-code', model: 'opus', effort: 'high' };
export const NOW = () => new Date('2026-10-07T12:00:00Z');
export const readBrief = (p: string) => `brief ${p}\n`;

export type Json = Record<string, any>;
export const fixture = (): Json => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
export const defects = (f: Json) => f['cases'].filter((c: Json) => c['kind'] === 'defect');
export const controls = (f: Json) => f['cases'].filter((c: Json) => c['kind'] === 'control');

export async function prepared(f: Json = fixture()) {
  const mod = await load();
  const workDir = tempDir();
  mod.prepare({ fixture: f as never, workDir, settings: SETTINGS, now: NOW, readBrief });
  return { mod, workDir, f };
}

export type Claim = { id: string; verdict: 'defect' | 'opportunity' | 'none'; claim: string; evidence: string[] };
export function writeClaims(workDir: string, arm: string, cases: Record<string, Claim[]>) {
  const file = path.join(workDir, 'calibration', 'claims', `${arm}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ arm, cases }));
}
export const defectClaim = (id: string): Claim => ({ id, verdict: 'defect', claim: `claim ${id}`, evidence: [`trace ${id}`] });

/** Claims and adjudication where `recover` lists the defect case ids each arm matched. */
export function scenario(f: Json, recover: string[], extra: { controlDefect?: boolean; skip?: string } = {}) {
  const cases: Record<string, Claim[]> = {};
  const matches: Record<string, { match: string | null; rationale: string }> = {};
  for (const c of defects(f)) {
    cases[c.id] = [defectClaim(`${c.id}-1`)];
    matches[c.id] = recover.includes(c.id) ? { match: `${c.id}-1`, rationale: 'same root cause' } : { match: null, rationale: 'different cause' };
  }
  for (const c of controls(f)) cases[c.id] = extra.controlDefect ? [defectClaim(`${c.id}-1`)] : [{ id: `${c.id}-1`, verdict: 'none', claim: 'intended', evidence: ['trace'] }];
  if (extra.skip) delete cases[extra.skip];
  return { cases, matches };
}

export async function scored(recover: (f: Json) => string[], extra: { controlDefect?: boolean; skip?: string } = {}) {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, recover(f), extra);
  for (const arm of ARMS) {
    writeClaims(workDir, arm, s.cases);
    mod.fixClaims(workDir, arm);
  }
  const usage = { old: { inputTokens: 100, outputTokens: 10, toolCalls: 5, wallSeconds: 60 }, new: { inputTokens: 80, outputTokens: 10, toolCalls: 4, wallSeconds: 50 } };
  return mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: s.matches, new: s.matches } }, usage });
}

export const ids = (cs: Json[]) => cs.map((c) => c['id'] as string);
export const high = (f: Json) => ids(defects(f).filter((c: Json) => ['high', 'critical'].includes(c['severity'])));
