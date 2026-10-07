import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ARMS, type Json, defects, prepared, writeClaims, defectClaim, scenario, ids } from '../helpers/audit-calibration.ts';

test('audit calibration summarize refuses to score claims that were not fixed first', async () => {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, ids(defects(f)));
  writeClaims(workDir, 'old', s.cases);
  writeClaims(workDir, 'new', s.cases);
  assert.throws(() => mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: s.matches, new: s.matches } }, usage: {} }), /not fixed/);
});

test('audit calibration summarize refuses claims edited after they were fixed', async () => {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, ids(defects(f)));
  for (const arm of ARMS) {
    writeClaims(workDir, arm, s.cases);
    mod.fixClaims(workDir, arm);
  }
  writeClaims(workDir, 'new', { ...s.cases, extra: [] });
  assert.throws(() => mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: s.matches, new: s.matches } }, usage: {} }), /changed after/);
});

test('audit calibration rejects a root-cause match that names no fixed defect claim of that case', async () => {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, ids(defects(f)));
  for (const arm of ARMS) {
    writeClaims(workDir, arm, s.cases);
    mod.fixClaims(workDir, arm);
  }
  const bad = { ...s.matches, [defects(f)[0].id]: { match: 'invented', rationale: 'x' } };
  assert.throws(() => mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: s.matches, new: bad } }, usage: {} }), /invented/);
});

test('audit calibration accepts an opportunity claim as recovery only for an efficiency case', async () => {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, ids(defects(f)));
  for (const c of defects(f)) s.cases[c.id] = [{ ...defectClaim(`${c.id}-1`), verdict: 'opportunity' }];
  for (const arm of ARMS) {
    writeClaims(workDir, arm, s.cases);
    mod.fixClaims(workDir, arm);
  }
  const efficiency = defects(f).find((c: Json) => c['category'] === 'efficiency').id;
  const other = defects(f).find((c: Json) => c['category'] !== 'efficiency').id;
  const only = (id: string) => Object.fromEntries(Object.entries(s.matches).map(([k, v]) => [k, k === id ? v : { match: null, rationale: 'miss' }]));
  const summary = mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: only(efficiency), new: only(efficiency) } }, usage: {} });
  assert.deepEqual(summary.arms.new.recovered, [efficiency]);
  assert.throws(() => mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: only(other), new: only(other) } }, usage: {} }), /not a fixed defect claim/);
});

test('audit calibration flags an accepted defect claim without a static trace as unsupported', async () => {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, ids(defects(f)));
  const first = defects(f)[0].id;
  const cases = { ...s.cases, [first]: [{ ...defectClaim(`${first}-1`), evidence: [] }] };
  for (const arm of ARMS) {
    writeClaims(workDir, arm, cases);
    mod.fixClaims(workDir, arm);
  }
  const summary = mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: s.matches, new: s.matches } }, usage: {} });
  assert.deepEqual(summary.arms.new.unsupported, [`${first}-1`]);
  assert.equal(summary.pass, false);
});

test('audit calibration reports unavailable usage instead of computing savings', async () => {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, ids(defects(f)));
  for (const arm of ARMS) {
    writeClaims(workDir, arm, s.cases);
    mod.fixClaims(workDir, arm);
  }
  const usage = { old: { inputTokens: 100, toolCalls: 5 }, new: { inputTokens: null, toolCalls: 4 } };
  const summary = mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: s.matches, new: s.matches } }, usage });
  assert.equal(summary.usage.comparison.inputTokens, 'unavailable');
  assert.equal(summary.usage.comparison.toolCalls, -1);
  assert.ok(summary.usage.unavailable.includes('new.inputTokens'));
  assert.ok(summary.usage.unavailable.includes('old.wallSeconds'));
  assert.equal(summary.usage.complete, false);
});
