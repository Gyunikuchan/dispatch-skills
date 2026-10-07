import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';

// NOTE: a literal dynamic import keeps each leaf test independently failing while the module is absent; tsc still types it.
const load = () => import('../../.agents/skills/audit-dispatch-skills/scripts/calibrate.ts');

const FIXTURE = path.join(import.meta.dirname, '..', '..', '.agents', 'skills', 'audit-dispatch-skills', 'fixtures', 'calibration', 'cases.json');
const ARMS = ['old', 'new'] as const;
const SETTINGS ={ host: 'claude-code', model: 'opus', effort: 'high' };
const NOW = () => new Date('2026-10-07T12:00:00Z');
const readBrief = (p: string) => `brief ${p}\n`;

type Json = Record<string, any>;
const fixture = (): Json => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const defects = (f: Json) => f['cases'].filter((c: Json) => c['kind'] === 'defect');
const controls = (f: Json) => f['cases'].filter((c: Json) => c['kind'] === 'control');

async function prepared(f: Json = fixture()) {
  const mod = await load();
  const workDir = tempDir();
  mod.prepare({ fixture: f as never, workDir, settings: SETTINGS, now: NOW, readBrief });
  return { mod, workDir, f };
}

type Claim = { id: string; verdict: 'defect' | 'opportunity' | 'none'; claim: string; evidence: string[] };
function writeClaims(workDir: string, arm: string, cases: Record<string, Claim[]>) {
  const file = path.join(workDir, 'calibration', 'claims', `${arm}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ arm, cases }));
}
const defectClaim = (id: string): Claim => ({ id, verdict: 'defect', claim: `claim ${id}`, evidence: [`trace ${id}`] });

/** Claims and adjudication where `recover` lists the defect case ids each arm matched. */
function scenario(f: Json, recover: string[], extra: { controlDefect?: boolean; skip?: string } = {}) {
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

async function scored(recover: (f: Json) => string[], extra: { controlDefect?: boolean; skip?: string } = {}) {
  const { mod, workDir, f } = await prepared();
  const s = scenario(f, recover(f), extra);
  for (const arm of ARMS) {
    writeClaims(workDir, arm, s.cases);
    mod.fixClaims(workDir, arm);
  }
  const usage = { old: { inputTokens: 100, outputTokens: 10, toolCalls: 5, wallSeconds: 60 }, new: { inputTokens: 80, outputTokens: 10, toolCalls: 4, wallSeconds: 50 } };
  return mod.summarize({ fixture: f as never, workDir, adjudication: { arms: { old: s.matches, new: s.matches } }, usage });
}

const ids = (cs: Json[]) => cs.map((c) => c['id'] as string);
const high = (f: Json) => ids(defects(f).filter((c: Json) => ['high', 'critical'].includes(c['severity'])));

test('audit calibration fixture curates four categorized defects and two controls with verified excerpts', async () => {
  const { validateFixture } = await load();
  const f = fixture();
  validateFixture(f as never);
  assert.deepEqual(defects(f).map((c: Json) => c['category']).sort(), ['ambiguity', 'efficiency', 'handoff', 'recovery']);
  assert.equal(controls(f).length, 2);
  assert.ok(high(f).length >= 1);
});

test('audit calibration prepare rejects a defect without source provenance', async () => {
  const { prepare } = await load();
  const f = fixture();
  delete defects(f)[0]['source']['parent'];
  assert.throws(() => prepare({ fixture: f as never, workDir: tempDir(), settings: SETTINGS, now: NOW, readBrief }), /parent/);
});

test('audit calibration prepare rejects an excerpt whose text no longer matches its hash', async () => {
  const { prepare } = await load();
  const f = fixture();
  defects(f)[1]['excerpts'][0]['text'] += 'tampered\n';
  assert.throws(() => prepare({ fixture: f as never, workDir: tempDir(), settings: SETTINGS, now: NOW, readBrief }), /sha256/);
});

test('audit calibration prepare rejects a corpus missing a required defect category', async () => {
  const { prepare } = await load();
  const f = fixture();
  defects(f)[2]['category'] = 'ambiguity';
  assert.throws(() => prepare({ fixture: f as never, workDir: tempDir(), settings: SETTINGS, now: NOW, readBrief }), /categor/);
});

test('audit calibration prepare rejects missing host or model settings', async () => {
  const { prepare } = await load();
  assert.throws(() => prepare({ fixture: fixture() as never, workDir: tempDir(), settings: { ...SETTINGS, model: '' }, now: NOW, readBrief }), /model/);
});

test('audit calibration packets withhold answer keys, labels and fix commits from both arms', async () => {
  const { workDir, f } = await prepared();
  for (const arm of ARMS) {
    for (const c of f['cases']) {
      const text = fs.readFileSync(path.join(workDir, 'calibration', 'packets', arm, `${c.id}.json`), 'utf8');
      const packet = JSON.parse(text);
      assert.equal(packet.caseId, c.id);
      assert.equal(packet.scenario, c.scenario);
      assert.equal(packet.constraints.probes, false);
      for (const key of ['answer', 'kind', 'category', 'severity']) assert.equal(key in packet, false, `${arm}/${c.id} leaks ${key}`);
      for (const secret of Object.values(c.answer as Record<string, string>)) assert.equal(text.includes(secret), false, `${arm}/${c.id} leaks the answer key`);
      if (c.kind === 'defect') assert.equal(text.includes(c.source.commit), false, `${arm}/${c.id} leaks the fix commit`);
      for (const excerpt of packet.excerpts) assert.doesNotMatch(excerpt.text, /\/\/\s*NOTE\b/, `${arm}/${c.id} keeps a rationale comment that would reveal the answer`);
    }
  }
});

test('audit calibration manifest records settings, briefs and source hashes for both arms', async () => {
  const { workDir, f } = await prepared();
  const manifest = JSON.parse(fs.readFileSync(path.join(workDir, 'calibration', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.settings, SETTINGS);
  assert.deepEqual(Object.keys(manifest.arms).sort(), ['new', 'old']);
  assert.equal(manifest.arms.old.commit, f['briefs'].old.commit);
  assert.match(manifest.arms.new.paths[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(manifest.cases).sort(), ids(f['cases']).sort());
  assert.match(manifest.answerKeySha256, /^sha256:[0-9a-f]{64}$/);
});

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

test('audit calibration passes three of four defects when every high or critical defect is recovered', async () => {
  const summary = await scored((f) => {
    const lowFirst = ids(defects(f)).filter((id) => !high(f).includes(id));
    return ids(defects(f)).filter((id) => id !== lowFirst[0]);
  });
  assert.equal(summary.arms.new.recovered.length, 3);
  assert.equal(summary.arms.new.pass, true);
  assert.equal(summary.pass, true);
});

test('audit calibration fails when a high or critical defect is missed even at three of four', async () => {
  const summary = await scored((f) => ids(defects(f)).filter((id) => id !== high(f)[0]));
  assert.equal(summary.arms.new.recovered.length, 3);
  assert.deepEqual(summary.arms.new.highMissed, [high(fixture())[0]]);
  assert.equal(summary.pass, false);
});

test('audit calibration fails below three recovered defects', async () => {
  const summary = await scored((f) => high(f).slice(0, 2));
  assert.ok(summary.arms.new.recovered.length < 3);
  assert.equal(summary.pass, false);
});

test('audit calibration counts a defect claim against an intentional control as a false defect', async () => {
  const summary = await scored((f) => ids(defects(f)), { controlDefect: true });
  assert.equal(summary.arms.new.controlFalseDefects.length, 2);
  assert.equal(summary.pass, false);
});

test('audit calibration reports a case without results as missing and fails', async () => {
  const f = fixture();
  const summary = await scored((g) => ids(defects(g)), { skip: controls(f)[0].id });
  assert.deepEqual(summary.arms.new.missingCases, [controls(f)[0].id]);
  assert.equal(summary.pass, false);
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
