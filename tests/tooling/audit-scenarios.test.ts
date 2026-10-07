import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';

// NOTE: a literal dynamic import keeps each leaf test independently failing while the module is absent; tsc still types it.
const load = () => import('../../.agents/skills/audit-dispatch-skills/scripts/scenarios.ts');

const VERBS = ['ask', 'design', 'plan', 'review', 'implement'] as const;
const VERB_CLASSES = ['normal', 'decision', 'recovery'];
const BOUNDARIES = ['design-to-plan', 'plan-to-implement', 'review-to-fix', 'interruption-to-resume'];
const ENTRY = 'skills/dispatch/SKILL.md';
const RUN = '2026-10-07-1200';
const WORK = `.scratch/audits/${RUN}-work`;

type Entry = { id: string; scope: string; class: string; trigger: string; expectedOutcome: string; startingState: string; entries: string[]; kind?: string };
const entry = (scope: string, cls: string, suffix = 'a', extra: Partial<Entry> = {}): Entry => ({
  id: `${scope}-${cls}-${suffix}`, scope, class: cls, trigger: `trigger ${suffix}`, expectedOutcome: `outcome ${suffix}`,
  startingState: 'clean', entries: [ENTRY], ...extra,
});

function catalog(extra: Entry[] = []) {
  const scenarios: Entry[] = [];
  for (const verb of VERBS) for (const cls of VERB_CLASSES) scenarios.push(entry(verb, cls, 'a', verb === 'review' ? { kind: 'code' } : {}));
  scenarios.push(entry('review', 'decision', 'b', { kind: 'design' }), entry('review', 'recovery', 'b', { kind: 'plan' }));
  for (const cls of BOUNDARIES) scenarios.push(entry('shared', cls));
  return { version: 1, scenarios: [...scenarios, ...extra] };
}
const exists = () => true;
type Selection = { scopes: { scope: string; scenarios: { id: string; class: string; reason: string; kind?: string }[] }[] };
const scopeOf = (selection: Selection, scope: string) => selection.scopes.find((s) => s.scope === scope);

test('audit scenarios default selection covers five verbs with three classes and the four shared boundaries', async () => {
  const { selectScenarios } = await load();
  const selection = selectScenarios({ catalog: catalog(), exists });
  assert.deepEqual(selection.scopes.map((s) => s.scope), [...VERBS, 'shared']);
  for (const verb of VERBS) assert.deepEqual(scopeOf(selection, verb)?.scenarios.map((s) => s.class), VERB_CLASSES);
  assert.deepEqual(scopeOf(selection, 'shared')?.scenarios.map((s) => s.class), BOUNDARIES);
  assert.equal(selection.partial, false);
  assert.deepEqual(selection.gaps, []);
  assert.equal(selection.selected.length, 19);
});

test('audit scenarios review selection spreads code, design and plan targets', async () => {
  const { selectScenarios } = await load();
  const review = scopeOf(selectScenarios({ catalog: catalog(), exists }), 'review');
  assert.deepEqual(review?.scenarios.map((s) => s.kind).sort(), ['code', 'design', 'plan']);
});

test('audit scenarios missing review target kinds are reported as gaps', async () => {
  const { selectScenarios } = await load();
  const onlyCode = { version: 1, scenarios: catalog().scenarios.filter((s) => !(s.scope === 'review' && s.kind !== 'code')) };
  const selection = selectScenarios({ catalog: onlyCode, exists });
  assert.ok(selection.gaps.some((g) => /review/.test(g) && /design/.test(g) && /plan/.test(g)), selection.gaps.join('\n'));
});

test('audit scenarios risk metadata outranks rotation and records the reason', async () => {
  const { selectScenarios } = await load();
  const risky = entry('ask', 'normal', 'b', { entries: ['skills/dispatch/references/verbs/ask.md'] });
  const selection = selectScenarios({
    catalog: catalog([risky]), exists,
    priorCoverage: { 'ask-normal-a': 0, 'ask-normal-b': 5 },
    risk: [{ kind: 'defect', path: 'skills/dispatch/references/verbs/ask.md', note: 'A-3 open' }],
  });
  const picked = scopeOf(selection, 'ask')?.scenarios[0];
  assert.equal(picked?.id, 'ask-normal-b');
  assert.match(picked?.reason ?? '', /defect/);
});

test('audit scenarios prior coverage rotates equally ranked variants and ties break by stable id', async () => {
  const { selectScenarios } = await load();
  const cat = catalog([entry('plan', 'normal', 'b'), entry('plan', 'normal', 'c')]);
  const rotated = selectScenarios({ catalog: cat, exists, priorCoverage: { 'plan-normal-a': 2, 'plan-normal-b': 1, 'plan-normal-c': 1 } });
  assert.equal(scopeOf(rotated, 'plan')?.scenarios[0]?.id, 'plan-normal-b');
  assert.match(scopeOf(rotated, 'plan')?.scenarios[0]?.reason ?? '', /rotation/);
  const fresh = selectScenarios({ catalog: cat, exists });
  assert.equal(scopeOf(fresh, 'plan')?.scenarios[0]?.id, 'plan-normal-a');
  assert.deepEqual(selectScenarios({ catalog: cat, exists }), fresh);
});

test('audit scenarios explicit narrowing selects only named scopes and labels the run partial', async () => {
  const { selectScenarios } = await load();
  const selection = selectScenarios({ catalog: catalog([entry('plan', 'decision', 'b')]), exists, scope: { scopes: ['plan'], scenarios: ['plan-decision-b'] } });
  assert.deepEqual(selection.scopes.map((s) => s.scope), ['plan']);
  assert.equal(selection.partial, true);
  for (const omitted of ['ask', 'design', 'review', 'implement', 'shared']) assert.ok(selection.gaps.some((g) => g.includes(omitted)), omitted);
  assert.deepEqual(selection.selected, ['plan-decision-b']);
  assert.ok(selection.gaps.includes('scope plan class normal not selected (user-narrowed run)'));
  const decision = selection.scopes[0]?.scenarios.find((s) => s.class === 'decision');
  assert.equal(decision?.id, 'plan-decision-b');
  assert.match(decision?.reason ?? '', /explicit/);
});

test('audit scenarios --scenarios alone narrows to the named scenarios and records omitted scopes and classes as gaps', async () => {
  const { selectScenarios } = await load();
  const selection = selectScenarios({ catalog: catalog([entry('plan', 'decision', 'b')]), exists, scope: { scenarios: ['plan-decision-b', 'shared-review-to-fix-a'] } });
  assert.equal(selection.partial, true);
  assert.deepEqual(selection.selected, ['plan-decision-b', 'shared-review-to-fix-a']);
  for (const omitted of ['ask', 'design', 'review', 'implement']) assert.ok(selection.gaps.includes(`scope ${omitted} not selected (user-narrowed run)`), omitted);
  for (const cls of ['normal', 'recovery']) assert.ok(selection.gaps.includes(`scope plan class ${cls} not selected (user-narrowed run)`), cls);
  for (const cls of ['design-to-plan', 'plan-to-implement', 'interruption-to-resume']) assert.ok(selection.gaps.includes(`scope shared class ${cls} not selected (user-narrowed run)`), cls);
});

test('audit scenarios reject an invalid catalog', async () => {
  const { selectScenarios } = await load();
  const missingClass = { version: 1, scenarios: catalog().scenarios.filter((s) => s.id !== 'ask-recovery-a') };
  assert.throws(() => selectScenarios({ catalog: missingClass, exists }), /ask.*recovery/);
  assert.throws(() => selectScenarios({ catalog: catalog([entry('ask', 'normal', 'z', { entries: ['skills/dispatch/SKILL.md:12'] })]), exists }), /line/);
  assert.throws(() => selectScenarios({ catalog: catalog(), exists: (p: string) => p !== ENTRY }), /skills\/dispatch\/SKILL\.md/);
  assert.throws(() => selectScenarios({ catalog: catalog([entry('ask', 'normal')]), exists }), /duplicate/);
  assert.throws(() => selectScenarios({ catalog: catalog([entry('ask', 'surprise')]), exists }), /class/);
  assert.throws(() => selectScenarios({ catalog: { version: 2, scenarios: [] }, exists }), /version/);
});

test('audit scenarios packets point to shared evidence and the scope reference without copying sources', async () => {
  const { selectScenarios, buildPackets } = await load();
  const packets = buildPackets(selectScenarios({ catalog: catalog(), exists }), { runId: RUN });
  assert.equal(packets.length, 6);
  const plan = packets.find((p) => p.scope === 'plan');
  const shared = packets.find((p) => p.scope === 'shared');
  assert.match(plan?.reference ?? '', /references\/walkthrough\.md$/);
  assert.match(shared?.reference ?? '', /references\/shared\.md$/);
  assert.equal(plan?.findingsPath, `${WORK}/findings/plan.md`);
  assert.deepEqual(plan?.evidence, [`${WORK}/manifest.json`, `${WORK}/tests.txt`, `${WORK}/metrics.md`]);
  for (const scenario of plan?.scenarios ?? []) {
    assert.deepEqual(Object.keys(scenario).sort(), ['class', 'entries', 'expectedOutcome', 'id', 'reason', 'startingState', 'trigger']);
  }
  assert.equal(plan?.partial, false);
});

test('audit scenarios emitting packets writes one file per scope and records the selection in the run manifest', async () => {
  const { selectScenarios, emitPackets } = await load();
  const { reserveRun, readRun, loadAuditConfig } = await import('../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts');
  const workDir = path.join(tempDir(), `${RUN}-work`);
  reserveRun(workDir, { runId: RUN, revision: 'abc', config: loadAuditConfig() });
  const selection = selectScenarios({ catalog: catalog(), exists });
  emitPackets(workDir, selection, { runId: RUN });
  for (const scope of [...VERBS, 'shared']) assert.ok(fs.existsSync(path.join(workDir, 'packets', `${scope}.json`)), scope);
  const manifest = readRun(workDir) as ReturnType<typeof readRun> & { scenarios?: { selected: string[] } };
  assert.deepEqual(manifest.scenarios?.selected, selection.selected);
  assert.equal(manifest.scopes['plan']?.lifecycle, 'pending');
  assert.equal(manifest.scopes['plan']?.resultPath, `${WORK}/findings/plan.md`);
});

test('audit scenarios bundled catalog validates against the current checkout', async () => {
  const { loadCatalog, selectScenarios } = await load();
  const selection = selectScenarios({ catalog: loadCatalog() });
  assert.equal(selection.partial, false);
  assert.deepEqual(selection.gaps, []);
});

test('audit scenarios interrupted packet emission publishes no selection and a rerun completes every packet', async () => {
  const { selectScenarios, emitPackets } = await load();
  const { reserveRun, readRun, loadAuditConfig } = await import('../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts');
  const workDir = path.join(tempDir(), `${RUN}-work`);
  reserveRun(workDir, { runId: RUN, revision: 'abc', config: loadAuditConfig() });
  const selection = selectScenarios({ catalog: catalog(), exists });
  let writes = 0;
  const interrupted = (file: string, text: string) => { if (++writes > 2) throw new Error('interrupted'); fs.writeFileSync(file, text); };
  assert.throws(() => emitPackets(workDir, selection, { runId: RUN, writeFile: interrupted }), /interrupted/);
  const partial = readRun(workDir) as ReturnType<typeof readRun> & { scenarios?: unknown };
  assert.equal(partial.scenarios, undefined);
  assert.deepEqual(partial.scopes, {});
  emitPackets(workDir, selection, { runId: RUN });
  for (const scope of [...VERBS, 'shared']) assert.ok(fs.existsSync(path.join(workDir, 'packets', `${scope}.json`)), scope);
  const done = readRun(workDir) as ReturnType<typeof readRun> & { scenarios?: { selected: string[] } };
  assert.deepEqual(done.scenarios?.selected, selection.selected);
});
