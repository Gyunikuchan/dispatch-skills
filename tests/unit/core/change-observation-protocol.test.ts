import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import type { Event, Frame, Handlers, Machine, RecoveryManifest } from '../../../skills/dispatch/scripts/core/types.ts';
import { createAssessRecovery } from '../../../skills/dispatch/scripts/effects/assess-recovery.ts';
import { publishRecovery } from '../../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import { implementData, implementMachine, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { observe } from '../../../skills/dispatch/scripts/machines/change-resolution.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { approval as designApproval } from '../machines/fixtures/design.ts';
import { fakePorts, tempDir, type FakePorts } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import { classificationState, RUN } from '../machines/fixtures/implement-recovery.ts';

// SECTION: Harness — an implement run seeded at level classification, with scripted recovery manifests and real assessment.

type Seeded = { tag: 'seed' } | ImplementState;
const BASE: RecoveryManifest = {
  repoRoot: '/repo', contentStore: 'recovery-contents', contents: { 'src/a.ts': null, 'README.md': null },
  entries: { 'src/a.ts': { kind: 'symlink', mode: 0o777, linkTarget: 'YQ==' }, 'README.md': { kind: 'symlink', mode: 0o777, linkTarget: 'cg==' } },
  taskStartFiles: [], callerDirty: [], git: { head: 'h', index: 'i', stash: '', gitDir: 'g' }, changed: [], verifiedManifestDirs: [], hashManifestDirs: [], ignoreRules: 'node_modules/',
};
const seeded: Machine<Seeded> = {
  initial: () => ({ tag: 'seed' }),
  step(state, event: Event) {
    if (state.tag !== 'seed') return implementMachine.step(state, event) as { state: Seeded; effects: [] };
    if (event.type === 'RUN_STARTED') return { state, effects: [{ kind: 'snapshot', id: 'seed.snapshot', since: null }] };
    if (event.type !== 'SNAPSHOT') return { state, effects: [] };
    const approval = classificationState();
    return { state: { ...approval, c: { ...approval.c, lastFingerprint: event.fingerprint, startFingerprint: event.fingerprint } }, effects: [] };
  },
  awaitOf: (state) => state.tag === 'seed' ? null : implementMachine.awaitOf(state),
  project: (state) => state.tag === 'seed' ? { at: 'seed', data: {} } : implementMachine.project(state),
  transitions: implementMachine.transitions,
  validate: (state, event) => state.tag === 'seed' ? null : implementMachine.validate!(state, event),
};

function harness(nestedDesign = false) {
  const world = { manifest: BASE, worktree: 'w', paths: [] as string[] };
  const ports: FakePorts = fakePorts(), runDir = path.join(tempDir(), 'runs', '001-implement');
  memoryRunFs(ports, runDir);
  const writeAtomic = ports.fs.writeAtomic;
  ports.fs.writeAtomic = (file, text) => {
    const relative = path.relative(runDir, path.resolve(file));
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Test write escaped run: ${file}`);
    writeAtomic(file, text);
  };
  const handlers: Handlers = {
    snapshot: async (effect, ports, ctx) => [{ type: 'SNAPSHOT', effectId: effect.id, diff: { paths: world.paths },
      fingerprint: { head: world.manifest.git.head, index: world.manifest.git.index, worktree: world.worktree, repoRoot: '', recovery: publishRecovery(ports, ctx.runDir, world.manifest) } }],
    'assess-recovery': createAssessRecovery(),
    checkout: async (effect) => [{ type: 'CHECKOUT_DONE', effectId: effect.id, op: effect.op, result: effect.op === 'init' ? { path: path.join(runDir, 'wt/integration'), base: 'h', manifest: { linked: [] } } : { path: path.join(runDir, 'wt/task-t1'), revision: 'h' } }],
    'write-brief': async (effect) => [{ type: 'BRIEF_READY', effectId: effect.id, stage: 'task', path: path.join(runDir, 'brief.md'), sha256: 'sha256:' + 'a'.repeat(64), envelopePath: path.join(runDir, 'outcome.json') }],
    handoff: async (effect) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: path.join(runDir, 'handoff.md'), warning: null }],
  };
  const nested: Machine<RootState> = { ...rootMachine,
    step(state, event) {
      if (state.tag !== 'booting') return rootMachine.step(state, event);
      if (event.type === 'RUN_STARTED') return { state, effects: [{ kind: 'snapshot', id: 'seed.snapshot', since: null }] };
      if (event.type !== 'SNAPSHOT') return { state, effects: [] };
      const approval = classificationState();
      approval.c = { ...approval.c, baseline: approval.c.baseline.map((record) => ({ ...record, inputFingerprint: 'baseline-input' })) };
      return { state: { tag: 'design', run: { verb: 'implement', argument: 'feature', slug: 'feature' }, child: { tag: 'increment', c: designApproval('implement').c, increment: 'I01', child: { ...approval, c: { ...approval.c, lastFingerprint: event.fingerprint, startFingerprint: event.fingerprint } } } }, effects: [] };
    },
  };
  const machine: Machine<Seeded | RootState> = (nestedDesign ? nested : seeded) as Machine<Seeded | RootState>;
  const reply = async (event: unknown): Promise<Frame> => (await send({ runDir, machine, handlers, ports, rawEvent: JSON.stringify(event) })).frame!;
  const types = () => Array.from(readJournal(ports, runDir).records).map((line) => line.type);
  return { world, ports, runDir, machine, reply, types, begin: async () => (await start({ runDir, machine, handlers, ports, runStarted: RUN })).frame! };
}
const CLASSIFY = { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'Bounded local work.', gateScopeHash: implementData(classificationState())['gateScopeHash'] } };
const STOP = { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop here.' } };
type Row = Record<string, unknown>;
const implementationContext = (h: ReturnType<typeof harness>) => {
  const state = fold(h.machine, readJournal(h.ports, h.runDir).records).state;
  const child = state.tag === 'design' && state.child.tag === 'increment' ? state.child.child : state;
  if (!('c' in child) || !child.c) throw new Error('Expected implementation context');
  return child.c as Extract<ImplementState, { tag: 'tasks' }>['c'];
};
const launchEvent = (h: ReturnType<typeof harness>) => {
  const c = implementationContext(h), task = c.tasks['T1']!;
  return { type: 'WRITE_RECEIPT', status: 'launched', task: 'T1', attempt: task.attempt, signature: task.signature, handle: 'writer', model: c.writer!.models[task.modelIndex] };
};
const storedObservations = (h: ReturnType<typeof harness>): Row[] => implementationContext(h).observations as unknown as Row[];
const observations = (frame: Frame): Row[] => (frame.data['observations'] as Row[] | undefined) ?? [];

async function classifiedAfter(change: (world: ReturnType<typeof harness>['world']) => void) {
  const h = harness();
  const first = await h.begin();
  assert.equal(first.await, 'decide'); assert.equal(first.data['kind'], 'level-classification');
  change(h.world);
  return { h, frame: await h.reply(CLASSIFY) };
}
const trackedEdit = (world: ReturnType<typeof harness>['world']) => {
  world.manifest = { ...BASE, entries: { ...BASE.entries, 'README.md': { kind: 'symlink', mode: 0o777, linkTarget: 'cjI=' } } };
  world.worktree = 'w2'; world.paths = ['README.md'];
};

// SECTION: Scenarios

test('authority-observation: root send routes retain and refresh to the active design increment', async () => {
  for (const selection of ['retain', 'refresh'] as const) {
    const h = harness(true);
    await h.begin();
    trackedEdit(h.world);
    const frame = await h.reply(CLASSIFY);
    assert.equal(frame.error, undefined);
    const row = observations(frame)[0]!;
    assert.ok(row);
    const parentRevision = await h.reply({ type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'Preserve the objective.', changeDispositions: [{ observationId: row['id'], afterHash: row['afterHash'], rationale: 'Checked SC1 relevance.', retain: ['SC1'] }] });
    assert.match(parentRevision.error ?? '', /not accepted at await write/);
    assert.equal(parentRevision.await, 'write');
    const answer = await h.reply({ ...launchEvent(h), changeDispositions: [{ observationId: row['id'], afterHash: row['afterHash'], rationale: 'Checked SC1 relevance.', [selection]: ['SC1'] }] });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    assert.equal(answer.await, 'write');
    assert.equal(observations(answer).length, 0);
    const lines = Array.from(readJournal(h.ports, h.runDir).records);
    const recorded = fold(h.machine, lines).state;
    assert.equal(recorded.tag, 'design');
    if (recorded.tag !== 'design' || recorded.child.tag !== 'increment' || !('c' in recorded.child.child) || !recorded.child.child.c) throw new Error('Expected active implementation child.');
    assert.deepEqual(recorded.child.child.c.observations?.[0]?.disposition?.[selection], ['SC1']);
    const stopped = lines.findLast((line) => line.type === 'WRITE_RECEIPT');
    assert.deepEqual((stopped?.data['changeDispositions'] as Row[])[0]![selection], ['SC1']);

  }
});

test('authority-observation: root send rejects design increment dispositions without observations', async () => {
  const h = harness(true);
  await h.begin();
  const rejected = await h.reply({ ...STOP, changeDispositions: [{ observationId: 'missing', afterHash: 'missing', rationale: 'Checked.', retain: ['SC1'] }] });
  assert.match(rejected.error ?? '', /observation|stale binding/);
  assert.equal(rejected.await, 'decide');
  const child = designApproval('implement');
  assert.match(rootMachine.validate!({ tag: 'design', run: { verb: 'implement', argument: 'feature', slug: 'feature' }, child }, { ...STOP, changeDispositions: [{ observationId: 'missing', afterHash: 'missing', rationale: 'Checked.', retain: ['SC1'] }] } as never) ?? '', /no change observation/);
});

test('authority-observation: unrelated change keeps the normal await', async () => {
  const { frame } = await classifiedAfter(trackedEdit);
  assert.equal(frame.error, undefined);
  assert.equal(frame.await, 'write');
  const [row, extra] = observations(frame);
  assert.ok(row); assert.equal(extra, undefined);
  assert.deepEqual(row['paths'], ['README.md']);
  assert.match(String(frame.data['changeDispositions']), /never block progress/);
});

test('authority-observation: untracked membership, HEAD, index and ignore-rule edits stay advisory', async () => {
  const changes: Record<string, (manifest: RecoveryManifest) => RecoveryManifest> = {
    membership: (manifest) => ({ ...manifest, membership: ['new.txt'], contents: { ...manifest.contents, 'new.txt': null }, entries: { ...manifest.entries, 'new.txt': { kind: 'symlink', mode: 0o777, linkTarget: 'bg==' } } }),
    head: (manifest) => ({ ...manifest, git: { ...manifest.git, head: 'h2' } }),
    index: (manifest) => ({ ...manifest, git: { ...manifest.git, index: 'i2' } }),
    ignore: (manifest) => ({ ...manifest, ignoreRules: 'node_modules/\nnew.txt\n' }),
  };
  for (const [name, change] of Object.entries(changes)) {
    const { frame } = await classifiedAfter((world) => { world.manifest = change(BASE); world.worktree = `w-${name}`; world.paths = name === 'membership' ? ['new.txt'] : []; });
    assert.equal(frame.await, 'write', `${name}: ${JSON.stringify(frame)}`);
    assert.equal(observations(frame).length, 1, name);
    if (name !== 'membership') assert.equal(observations(frame)[0]!['suggestedRelevance'], 'relevant', name);
  }
});

test('authority-observation: a receipt is consumed once', async () => {
  const { h, frame } = await classifiedAfter(trackedEdit);
  const [row] = observations(frame);
  const repeated = await h.reply(CLASSIFY);
  assert.equal(repeated.await, 'write');
  assert.equal(observations(repeated).length, 1);
  const done = await h.reply({ ...launchEvent(h), changeDispositions: [{ observationId: row!['id'], afterHash: row!['afterHash'], rationale: 'README edits do not affect SC1.', retain: ['SC1'] }] });
  assert.equal(done.await, 'write', JSON.stringify(done));
  const recorded = storedObservations(h);
  assert.equal(recorded.length, 1); assert.equal((recorded[0]!['disposition'] as Row)['rationale'], 'README edits do not affect SC1.');
  assert.equal(h.types().filter((type) => type === 'RECOVERY_ASSESSED').length, 1);
});

test('authority-observation: stale supplied bindings cannot change scope', async () => {
  const { h, frame } = await classifiedAfter(trackedEdit);
  const [row] = observations(frame);
  const bind = { observationId: row!['id'], afterHash: row!['afterHash'], rationale: 'Checked.' };
  const before = h.types().length;
  for (const [disposition, pattern] of [[{ ...bind, afterHash: 'stale' }, /stale binding/], [{ ...bind, observationId: 'other' }, /stale binding/], [{ ...bind, refresh: ['SC9'] }, /cannot change scope/]] as const) {
    const rejected = await h.reply({ ...launchEvent(h), changeDispositions: [disposition] });
    assert.match(rejected.error ?? '', pattern);
    assert.equal(rejected.await, 'write');
  }
  assert.deepEqual(h.types().slice(before).filter((type) => type !== 'DIAGNOSTIC_NOTE'), []);
});

test('authority-observation: unacknowledged observations coalesce and never block progress', async () => {
  const { h, frame } = await classifiedAfter(trackedEdit);
  const done = await h.reply(launchEvent(h));
  assert.equal(done.await, 'write', JSON.stringify(done));
  const recorded = storedObservations(h);
  assert.equal(recorded.length, 1); assert.equal(recorded[0]!['disposition'], undefined);
  const state = classificationState(), [row] = observations(frame);
  const notice = { id: String(row!['id']), phase: 'approval', pendingId: 'DECISION', beforeHash: 'b', afterHash: String(row!['afterHash']), rawDeltaRef: row!['rawDeltaRef'] as never, paths: ['README.md'], pathCount: 1, relevance: 'unknown' as const, reason: 'r', affectedEvidence: [] };
  assert.equal(observe(observe(state.c, notice), { ...notice, id: 'again' }).observations?.length, 1);
});
