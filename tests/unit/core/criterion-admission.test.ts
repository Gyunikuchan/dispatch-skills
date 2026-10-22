import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { send, start as startRun } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { JOURNAL_PROTOCOL_REVISION, type Handlers, type Machine, type PlanEdit } from '../../../skills/dispatch/scripts/core/types.ts';
import { parsePlan } from '../../../skills/dispatch/scripts/domain/plan.ts';
import type { PlanCriterion } from '../../../skills/dispatch/scripts/domain/types.ts';
import { asParsedPlan, criterionEvidenceRows, parseRedMatrix } from '../../../skills/dispatch/scripts/machines/implement-types.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import { AMEND_PLAN, AMEND_TEXT, governedHash } from '../machines/fixtures/implement-amend.ts';
import { answer, launch, run, start, type Sim } from '../machines/fixtures/implement-tasks.ts';
import { launchOf } from '../../helpers/launch.ts';

// SECTION: Helpers and harness

const criterion = (id: string) => `- [${id}] Added numeric criterion works
  - Satisfies: REQ-1
  - Changes: src/a.ts, tests/part-1.test.ts
  - Verify: \`node --test tests/part-1.test.ts\`
  - Evidence: red
  - Test rationale: discriminates the numeric admission behavior.
  - Retain: durable
`;
const edits = (id: string): PlanEdit[] => [
  { kind: 'add', target: 'T1', current: '## Success Criteria\n', proposed: criterion(id) },
  { kind: 'modify', target: 'T1', current: '| T1 | Part one | Deliver part one. | none | SC1 |', proposed: `| T1 | Part one | Deliver part one. | none | SC1, ${id} |` },
];
function revisedText(id: string): string {
  return AMEND_TEXT.replace('## Success Criteria\n', `## Success Criteria\n${criterion(id)}`).replace('| T1 | Part one | Deliver part one. | none | SC1 |', `| T1 | Part one | Deliver part one. | none | SC1, ${id} |`);
}

async function harness() {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  memoryRunFs(ports, session);
  const writeAtomic = ports.fs.writeAtomic;
  ports.fs.writeAtomic = (file, text) => {
    const relative = path.relative(session, path.resolve(file));
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Test write escaped session: ${file}`);
    writeAtomic(file, text);
  };
  const planPath = path.join(session, 'x.plan.md').replaceAll('\\', '/'), replacementPath = path.join(session, 'replacement.plan.md').replaceAll('\\', '/');
  ports.fs.writeAtomic(planPath, AMEND_TEXT);
  const sim: Sim = { plan: AMEND_PLAN, planHash: governedHash(AMEND_PLAN), briefRoot: runDir };
  const initial = start(3, sim), launched = launch(initial.result, sim, initial.trace);
  const defaults = { ...run(3), protocolRevision: JOURNAL_PROTOCOL_REVISION, argument: planPath, overrides: { ...run(3).overrides, sessionDir: session, settledPlan: { path: planPath, hash: governedHash(AMEND_PLAN), outcome: 'settled' } } };
  if (!('c' in launched.state) || !launched.state.c) throw new Error('context');
  launched.state.c = { ...launched.state.c, run: defaults, planPath, planHash: governedHash(AMEND_PLAN) };
  let current: RootState = { tag: 'implement', run: { verb: 'implement', argument: defaults.argument, slug: 'x', defaults }, child: launched.state };
  const machine: Machine<RootState> = { ...rootMachine,
    step(state, event) {
      const next = event.type === 'RUN_STARTED' ? { state: current, effects: [] } : rootMachine.step(state, event);
      current = next.state;
      if (current.tag === 'implement' && 'c' in current.child && current.child.c?.plan) { sim.plan = current.child.c.plan; sim.planHash = current.child.c.planHash!; }
      return next;
    },
  };
  const handlers = Object.fromEntries(['snapshot', 'parse-artifact', 'write-brief', 'check-envelope', 'verify', 'checkout'].map((kind) => [kind, async (effect: Parameters<NonNullable<Handlers['snapshot']>>[0]) => {
    assert.equal(current.tag, 'implement');
    if (current.tag !== 'implement') throw new Error('implement run expected');
    const result = answer(current.child, effect, sim);
    assert.ok(result, effect.kind);
    return [result];
  }])) as Handlers;
  const options = { machine, handlers, ports, runDir, runRel: 'session/runs/001-implement' };
  assert.equal((await startRun({ ...options, runStarted: defaults })).exitCode, 0);
  return { sim, options, session, replacementPath, state: () => current, reply: (rawEvent: unknown) => send({ ...options, rawEvent }) };
}

// SECTION: Admission and replacement

test('RED matrix exposes only valid eligible rows while retaining diagnostics', () => {
  const base = { ...AMEND_PLAN.criteria[0]!, evidence: 'red' as const, red: 'node --test {files}', tests: ['tests/a.ts'], redException: null };
  const criteria: PlanCriterion[] = ['SC1', 'SC2', 'SC3', 'SC4', 'SC5'].map((id) => ({ ...base, id }));
  criteria[3] = { ...criteria[3]!, evidence: 'verify' };
  criteria[4] = { ...criteria[4]!, redException: 'Approved exception.' };
  const row = (id: string, name = 'rejects invalid input') => `RED-MATRIX ${id} | tests/a.ts:${name} | exit 1 test:${name}`;
  const parsed = parseRedMatrix([row('SC1'), row('SC2'), row('SC2'), row('SC3', 'SC3 fails'), row('SC4'), row('SC5'), row('SC99')], criteria, criteria.map((criterion) => criterion.id));
  assert.deepEqual(parsed.validRows.map((row) => row.id), ['SC1']);
  assert.match(parsed.defects.join('\n'), /Exactly one RED-MATRIX row required for SC2/);
  assert.match(parsed.defects.join('\n'), /names plan ID SC3/);
  assert.match(parsed.defects.join('\n'), /RED exception/);
  assert.match(parsed.defects.join('\n'), /unknown criterion SC99/);
});

test('criterion-admission: writer self-check receipts stay in the in-memory session', async () => {
  const h = await harness();
  for (const task of ['T1', 'T2', 'T3']) {
    const slot = launchOf(h.state(), task);
    const receiptPath = path.join(path.dirname(slot.briefPath), 'self-check.event.json');
    assert.ok(path.isAbsolute(receiptPath));
    const receipt = JSON.parse(h.options.ports.fs.readText(receiptPath));
    assert.equal(receipt.type, 'WRITE_RECEIPT');
    assert.equal(receipt.status, 'submitted');
    assert.equal(receipt.task, task);
    assert.equal(receipt.handle, slot.handle);
  }
});

for (const method of ['replacement', 'AMEND']) test(`criterion-admission: ${method} admits a new numeric criterion and matching writer evidence`, async () => {
  const h = await harness(), parsed = parsePlan(revisedText('SC14'));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  h.sim.replacements = { [h.replacementPath]: { plan: parsed.plan, hash: governedHash(parsed.plan) } };
  const current = h.state(); assert.equal(current.tag, 'implement');
  if (current.tag !== 'implement' || !('c' in current.child) || !current.child.c) throw new Error('context');
  const event = method === 'AMEND'
    ? { type: 'AMEND', delta: edits('SC14'), notify: [{ task: 'T1', notice: 'SC14 added.' }], rationale: 'Add a numeric criterion.' }
    : { type: 'REPLACE_PLAN', expectedHash: current.child.c.planHash, path: h.replacementPath, rationale: 'Add a numeric criterion.', notify: [{ task: 'T1', notice: 'SC14 added.' }], reconciliation: { retained: ['T2', 'T3'], changed: ['T1'], added: [], retired: [], intentChanged: false, dependencyChanged: false } };
  const revision = await h.reply(event);
  assert.equal(revision.frame?.error, undefined, JSON.stringify(revision));
  assert.equal(revision.frame?.data['planRejection'], undefined);
  h.sim.envelope = () => ({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered numeric criterion.', evidence: [
    'CRITERION SC1 | src/a.ts | original behavior', 'CRITERION SC14 | src/a.ts | added behavior',
    'RED-MATRIX SC14 | tests/part-1.test.ts:rejects bad input | exit 1 test:rejects bad input',
  ] });
  const slot = launchOf(h.state(), 'T1');
  const submitted = await h.reply({ type: 'WRITE_RECEIPT', status: 'submitted', task: 'T1', attempt: slot.attempt, signature: slot.signature, handle: slot.handle!, model: slot.model, envelopePath: slot.envelopePath, briefHash: slot.briefHash });
  assert.equal(submitted.frame?.error, undefined, JSON.stringify(submitted));
  const state = h.state();
  assert.ok(state.tag === 'implement' && 'c' in state.child && state.child.c);
  if (state.tag !== 'implement' || !('c' in state.child) || !state.child.c) return;
  assert.equal(state.child.c.tasks['T1']?.status, 'accepted');
  assert.equal(state.child.c.tasks['T1']?.integrated, 'i-T1');
  assert.ok(state.child.c.plan?.criteria.some((row) => row.id === 'SC14'));
  assert.ok(state.child.c.planPath!.replaceAll('\\', '/').startsWith(h.session.replaceAll('\\', '/') + '/'));
  assert.match(h.options.ports.fs.readText(state.child.c.planPath!), /\[SC14\]/, 'real rendering publishes the admitted criterion under the temporary session');
});

// SECTION: Malformed criterion rejection

test('criterion-admission: malformed criteria IDs are rejected before replacement or AMEND work admission', async () => {
  for (const id of ['SC0', 'SC01', 'SC1a', 'SC14-extra', 'sc14']) {
    const h = await harness(), before = h.state(), parsed = parsePlan(revisedText(id));
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    h.sim.replacements = { [h.replacementPath]: { plan: AMEND_PLAN, hash: governedHash(AMEND_PLAN), defects: parsed.defects as unknown as Record<string, unknown>[] } };
    assert.equal(before.tag, 'implement');
    if (before.tag !== 'implement' || !('c' in before.child) || !before.child.c) return;
    const records = before.child.c.tasks;
    for (const rawEvent of [
      { type: 'AMEND', delta: edits(id), notify: [{ task: 'T1', notice: 'Invalid criterion.' }], rationale: 'Invalid criterion.' },
      { type: 'REPLACE_PLAN', path: h.replacementPath, expectedHash: before.child.c.planHash, rationale: 'Invalid criterion.', notify: [], reconciliation: { retained: ['T1', 'T2', 'T3'], changed: [], added: [], retired: [], intentChanged: false, dependencyChanged: false } },
    ]) {
      const result = await h.reply(rawEvent);
      assert.ok(result.frame?.error || result.frame?.data['planRejection'], JSON.stringify(result));
      const state = h.state();
      assert.ok(state.tag === 'implement' && 'c' in state.child && state.child.c);
      if (state.tag === 'implement' && 'c' in state.child && state.child.c) assert.deepEqual(state.child.c.tasks, records);
    }
    const rows = [ `CRITERION ${id} | src/a.ts | wrong id`, `RED-MATRIX ${id} | tests/part-1.test.ts:rejects bad input | exit 1 test:rejects bad input` ];
    assert.deepEqual(criterionEvidenceRows(rows, [AMEND_PLAN.criteria[0]!]), ['SC1']);
    assert.ok(parseRedMatrix(rows, [], []).defects.some((item) => item.startsWith('Malformed')));
    assert.equal(asParsedPlan({ ...AMEND_PLAN, criteria: AMEND_PLAN.criteria.map((row, index) => index ? row : { ...row, id }) }), null, 'Parsed event payload cannot bypass numeric admission.');
  }
});
