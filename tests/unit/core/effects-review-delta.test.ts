import { fixtureReference } from './fixtures/review-manifest.ts';
import assert from 'node:assert/strict';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import path from 'node:path';
import { test } from 'node:test';
import { beginReview, stepReview, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { createCheckReviewTarget } from '../../../skills/dispatch/scripts/effects/check-review-target.ts';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { createVerify } from '../../../skills/dispatch/scripts/effects/verify.ts';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git, ReviewSnapshot } from '../../../skills/dispatch/scripts/effects/git.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const finding = (id: string, file: string) => ({ id, severity: 'MUST' as const, category: 'correctness', locus: `${file}:L1`, defect: 'Missing guard', requiredChange: 'Add guard', sources: ['codex[0]'], scope: 'in' as const, round: 1, status: 'open' as const, revision: 'original-revision' });
const ruling = (file: string) => ({ ruling: 'accept', fix: { affectedPaths: [file], dependsOn: file === 'src/b.ts' ? ['R1-F001'] : [], verification: ['check'] } });

function harness() {
  const ports = fakePorts(), cwd = tempDir(), runDir = path.join(cwd, 'run'), baseline = path.join(runDir, 'baseline.json');
  memoryRunFs(ports, runDir);
  const original: ReviewSnapshot = { head: 'head', target: '', comparison: 'head', index: {}, working: { 'src/a.ts': 'a-before', 'src/b.ts': 'b-before', 'src/c.ts': 'c-before' }, untracked: {}, governedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] };
  let current = structuredClone(original);
  ports.fs.writeAtomic(baseline, JSON.stringify(original));
  const delta = async (_cwd: string, prior: ReviewSnapshot, next: ReviewSnapshot) => ({ staged: [], unstaged: [], untracked: [], deleted: [], paths: [...new Set([...Object.keys(prior.working), ...Object.keys(next.working)])].filter((file) => prior.working[file] !== next.working[file]) });
  const git = { toplevel: async () => cwd, diffNames: async () => Object.keys(current.working).filter((file) => current.working[file] !== original.working[file]), reviewSnapshot: async () => structuredClone(current), reviewDelta: delta } as unknown as Git;
  const begun = beginReview({ kind: 'code', target: '', cap: 3, breadth: 1, context: 'Scoped review', roster: [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }], timeoutMs: 1000 }, 'review', {});
  if (!('c' in begun.state)) throw new Error('review context');
  const c = { ...begun.state.c, round: 1, effectId: 'review.wave.1', targetManifest: baseline, targetManifestRef: fixtureReference(ports, runDir, baseline), priorManifest: baseline, priorManifestRef: fixtureReference(ports, runDir, baseline), reviewedRevision: 'original-revision', findings: [finding('R1-F001', 'src/a.ts'), finding('R1-F002', 'src/b.ts')] };
  const handler = createCheckReviewTarget({ cwd, git });
  return {
    ports, cwd, runDir, baseline, git, c,
    edit: (file: string, value = 'edited') => { current.working[file] = value; },
    identity: () => { current.head = 'foreign-head'; },
    check: async (state: ReviewState, event: Event) => {
      const parked = stepReview(state, event), effect = parked.effects.find((item) => item.kind === 'check-review-target');
      assert.ok(effect?.kind === 'check-review-target', 'the public machine issues its admission check');
      const results = await handler(effect, ports, { runDir, attempt: 1 });
      assert.equal(results[0]?.type, 'REVIEW_TARGET_CHECKED', JSON.stringify(results));
      return stepReview(parked.state, results[0]!);
    },
  };
}
async function observedRule(f: ReturnType<typeof harness>, findings: readonly unknown[] = f.c.findings) {
  return f.check({ tag: 'wave', c: { ...f.c, effectId: 'review.wave.1', waveRevision: 'original-revision', findings: [] }, phase: 'cli' }, {
    type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: findings as never,
  });
}
const acceptAll = { type: 'RULINGS' as const, rulings: { 'R1-F001': ruling('src/a.ts'), 'R1-F002': ruling('src/b.ts') } };
const receipts = (state: ReviewState, failed = false): Event => {
  if (state.tag !== 'fix') throw new Error('fix state');
  return { type: 'FIXES_APPLIED', clusters: state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: failed ? 'failed' : 'applied' })) };
};

async function generatedCandidate() {
  const f = harness(), c = { ...f.c, findings: [f.c.findings[0]!] };
  const fix = await f.check({ tag: 'rule', c }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', fix: { affectedPaths: ['src/a.ts', 'src/b.ts'], dependsOn: [], verification: ['regenerate'] } } } });
  f.edit('src/a.ts');
  return { f, candidate: await f.check(fix.state, receipts(fix.state)) };
}
const successfulVerify = (candidate: { state: ReviewState; effects: readonly import('../../../skills/dispatch/scripts/core/types.ts').Effect[] }): Event => ({ type: 'VERIFY_DONE', effectId: candidate.effects.find((effect) => effect.kind === 'verify')!.id, purpose: 'fix-verify', results: [{ command: 'regenerate', exit: 0 }], fingerprint: {} });

test('review verification-output: declared changed output is reverified before candidate adoption', async () => {
  const { f, candidate } = await generatedCandidate();
  let commands = 0;
  f.ports.spawn.run = async () => { commands++; f.edit('src/b.ts', 'generated'); return { exit: 0, stdout: 'Regenerated declared output', stderr: '' }; };
  const handler = createVerify({ os: 'linux', cwd: f.cwd, git: { ...f.git, fingerprint: async () => ({}) } as unknown as Git });
  const effect = candidate.effects.find((item) => item.kind === 'verify')!;
  assert.ok(effect.kind === 'verify');
  const first = (await handler(effect, f.ports, { runDir: f.runDir, attempt: 1 }))[0]!;
  const repeated = await f.check(candidate.state, first);
  assert.equal(repeated.state.tag, 'fix-verify'); if (repeated.state.tag !== 'fix-verify') return;
  assert.equal(repeated.state.clusters[0]!.attemptBudget, 2);
  assert.equal(repeated.state.c.targetManifest, f.baseline);
  assert.equal(repeated.state.c.findings[0]!.status, 'accepted');
  assert.notEqual(repeated.state.c.fixCandidate, 'c' in candidate.state && candidate.state.c.fixCandidate);
  const rerun = repeated.effects.find((item) => item.kind === 'verify')!;
  assert.ok(rerun.kind === 'verify');
  const second = (await handler(rerun, f.ports, { runDir: f.runDir, attempt: 1 }))[0]!;
  const done = await f.check(repeated.state, second);
  assert.equal(commands, 2);
  assert.ok('c' in done.state && done.state.c.findings[0]!.status === 'fixed');
  assert.ok('c' in done.state && done.state.c.targetManifest !== f.baseline && done.state.c.fixCandidate === undefined);
});

test('review verification-output: failed sibling paths grant no verification edit scope', async () => {
  const f = harness(), fix = await f.check({ tag: 'rule', c: f.c }, acceptAll);
  if (fix.state.tag !== 'fix') throw new Error('fix');
  f.edit('src/a.ts');
  const candidate = await f.check(fix.state, { type: 'FIXES_APPLIED', clusters: fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: cluster.paths.includes('src/b.ts') ? 'failed' : 'applied' })) });
  f.edit('src/b.ts');
  const rejected = await f.check(candidate.state, successfulVerify(candidate));
  assert.equal(rejected.state.tag, 'failed');
  assert.ok('c' in rejected.state && rejected.state.c.findings.every((item) => item.status !== 'fixed'));
});

test('review verification-output: repeatedly changing declared output exhausts the existing attempt budget', async () => {
  const { f, candidate } = await generatedCandidate();
  let next = candidate;
  for (let index = 0; index < 3; index++) {
    f.edit('src/b.ts', `generated-${index}`);
    next = await f.check(next.state, successfulVerify(next));
    assert.equal(next.state.tag, index === 2 ? 'failed' : 'fix-verify');
  }
  assert.ok(next.state.tag === 'failed' && /fix-attempts-exhausted/.test(next.state.detail));
  assert.ok('c' in next.state && next.state.c.findings[0]!.status === 'accepted' && next.state.c.targetManifest === f.baseline);
});

for (const change of ['undeclared', 'identity'] as const) test(`review verification-output: ${change} change still fails admission`, async () => {
  const { f, candidate } = await generatedCandidate();
  if (change === 'identity') f.identity(); else f.edit('src/c.ts');
  const rejected = await f.check(candidate.state, successfulVerify(candidate));
  assert.equal(rejected.state.tag, 'failed');
  assert.ok('c' in rejected.state && rejected.state.c.findings[0]!.status === 'accepted' && rejected.state.c.targetManifest === f.baseline);
});

for (const change of ['outside', 'identity', 'all-failed', 'mixed-failed-path'] as const) test(`review admission: ${change} fix receipt retains bytes and fails before verification`, async () => {
  const f = harness(), fix = await f.check({ tag: 'rule', c: f.c }, acceptAll);
  if (fix.state.tag !== 'fix') throw new Error('fix');
  const reply = receipts(fix.state, change === 'all-failed');
  if (change === 'identity') f.identity();
  else f.edit(change === 'outside' ? 'src/c.ts' : 'src/b.ts');
  if (change === 'mixed-failed-path' && reply.type === 'FIXES_APPLIED') reply.clusters = fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: cluster.paths.includes('src/b.ts') ? 'failed' : 'applied' }));
  const rejected = await f.check(fix.state, reply);
  assert.equal(rejected.state.tag, 'failed');
  assert.ok('c' in rejected.state);
  if (!('c' in rejected.state)) return;
  assert.equal(rejected.state.c.targetManifest, f.baseline);
  assert.equal(rejected.state.c.fixCandidate, undefined);
  assert.ok(rejected.state.c.findings.every((item) => item.status === 'accepted' && item.revision === 'original-revision'));
  assert.ok(rejected.state.c.observations?.length);
  assert.equal(rejected.effects.length, 0);
});

test('review admission: scoped pre-ruling edits retain the original baseline until applied verification passes', async () => {
  const f = harness(); f.edit('src/a.ts');
  const fix = await f.check({ tag: 'rule', c: f.c }, acceptAll);
  assert.equal(fix.state.tag, 'fix');
  assert.ok('c' in fix.state && fix.state.c.targetManifest === f.baseline && fix.state.c.reviewedRevision === 'original-revision');
  f.edit('src/c.ts');
  const rejected = await f.check(fix.state, receipts(fix.state));
  assert.equal(rejected.state.tag, 'failed', 'a later unauthorized delta cannot hide behind a pre-ruling baseline refresh');
});

test('review admission: scoped pre-ruling edits commit only after an unchanged candidate passes verification', async () => {
  const f = harness(); f.edit('src/a.ts');
  const fix = await f.check({ tag: 'rule', c: f.c }, acceptAll);
  const candidate = await f.check(fix.state, receipts(fix.state));
  assert.equal(candidate.state.tag, 'fix-verify');
  if (candidate.state.tag !== 'fix-verify') return;
  assert.equal(candidate.state.c.targetManifest, f.baseline);
  assert.equal(candidate.state.c.reviewedRevision, 'original-revision');
  const verify = candidate.effects.find((effect) => effect.kind === 'verify')!;
  const done = await f.check(candidate.state, { type: 'VERIFY_DONE', effectId: verify.id, purpose: 'fix-verify', results: [{ exit: 0 }], fingerprint: {} });
  assert.ok('c' in done.state && done.state.c.findings.every((item) => item.status === 'fixed' && item.revision === 'original-revision'));
  assert.ok('c' in done.state && done.state.c.targetManifest !== f.baseline && done.state.c.fixCandidate === undefined);
});

for (const kind of ['plan', 'design'] as const) test(`review admission: ${kind} candidate changes during verification cannot complete a fix`, async () => {
  const f = harness(), target = `target.${kind}.md`, file = path.join(f.cwd, target);
  const original = '# Artifact\n\n## Scope\n\nOriginal intent.\n';
  f.ports.fs.writeAtomic(file, original);
  f.ports.fs.writeAtomic(f.baseline, JSON.stringify({ kind, target, text: original }));
  const c = { ...f.c, priorManifestRef: fixtureReference(f.ports, f.runDir, f.baseline), targetManifestRef: fixtureReference(f.ports, f.runDir, f.baseline), spec: { ...f.c.spec, kind, target }, findings: [finding('R1-F001', target)] };
  f.ports.fs.writeAtomic(file, original.replace('Original', 'Revised'));
  const fix = await f.check({ tag: 'rule', c }, { type: 'RULINGS', rulings: { 'R1-F001': ruling(target) } });
  assert.equal(fix.state.tag, 'fix');
  assert.ok('c' in fix.state && fix.state.c.targetManifest === f.baseline);
  const candidate = await f.check(fix.state, receipts(fix.state));
  assert.equal(candidate.state.tag, 'fix-verify');
  if (candidate.state.tag !== 'fix-verify') return;
  f.ports.fs.writeAtomic(file, original.replace('Original', 'Foreign'));
  const parse = candidate.effects.find((effect) => effect.kind === 'parse-artifact')!;
  const rejected = await f.check(candidate.state, { type: 'ARTIFACT_PARSED', effectId: parse.id, kind, hash: 'current', parsed: {}, defects: [] });
  assert.equal(rejected.state.tag, 'failed');
  assert.ok('c' in rejected.state && rejected.state.c.findings[0]?.status === 'accepted' && rejected.state.c.targetManifest === f.baseline);
});

for (const reason of ['outside', 'mixed-rulings', 'identity'] as const) test(`review admission: pre-ruling ${reason} changes fail without adopting edited bytes`, async () => {
  const f = harness(); f.edit(reason === 'outside' ? 'src/c.ts' : 'src/a.ts');
  if (reason === 'identity') f.identity();
  const event = reason === 'mixed-rulings' ? { type: 'RULINGS' as const, rulings: { ...acceptAll.rulings, 'R1-F002': { ruling: 'reject', reason: 'Not a defect' } } } : acceptAll;
  const rejected = await f.check({ tag: 'rule', c: f.c }, event);
  assert.equal(rejected.state.tag, 'failed');
  assert.ok('c' in rejected.state && rejected.state.c.targetManifest === f.baseline);
});

test('review admission: authorized mixed receipt verifies only applied clusters', async () => {
  const f = harness(), fix = await f.check({ tag: 'rule', c: f.c }, acceptAll);
  if (fix.state.tag !== 'fix') throw new Error('fix');
  f.edit('src/a.ts');
  const candidate = await f.check(fix.state, { type: 'FIXES_APPLIED', clusters: fix.state.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: cluster.paths.includes('src/b.ts') ? 'failed' : 'applied' })) });
  assert.equal(candidate.state.tag, 'fix-verify');
  if (candidate.state.tag !== 'fix-verify') return;
  assert.deepEqual(candidate.state.clusters.flatMap((cluster) => cluster.paths), ['src/a.ts']);
  f.edit('src/c.ts');
  const verify = candidate.effects.find((effect) => effect.kind === 'verify')!;
  const rejected = await f.check(candidate.state, { type: 'VERIFY_DONE', effectId: verify.id, purpose: 'fix-verify', results: [{ exit: 0 }], fingerprint: {} });
  assert.equal(rejected.state.tag, 'failed');
  assert.ok('c' in rejected.state && rejected.state.c.findings.every((item) => item.status !== 'fixed'));
});

test('review-reuse: selected unchanged paths reach prepared prompt scope and launch', async () => {
  const f = harness();
  f.edit('src/a.ts');
  const observed = await observedRule(f, f.c.findings.map((row) => ({ ...row, severity: 'CONSIDER' as const })));
  if (observed.state.tag !== 'rule') throw new Error('rule frame');
  const notice = observed.state.c.observations![0]!;
  const selected = stepReview(observed.state, { type: 'REVIEW_USE', observationId: notice.id, afterHash: notice.afterHash, action: 'targeted', paths: ['src/b.ts'], rationale: 'Inspect unchanged dependent code.' });
  const prepared = await f.check(selected.state, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } } });
  const effect = prepared.effects.find((item) => item.kind === 'prepare-review');
  assert.ok(effect?.kind === 'prepare-review', JSON.stringify(prepared));
  const event = (await createPrepareReview({ cwd: f.cwd, git: f.git, skillRoot: path.resolve('skills/dispatch') })(effect, f.ports, { runDir: f.runDir, attempt: 1 }))[0];
  assert.ok(event?.type === 'REVIEW_PREPARED', JSON.stringify(event));
  assert.deepEqual(event.scope['paths'], ['src/b.ts']);
  assert.match(f.ports.fs.readText(event.promptPaths['codex[0]']!), /src\/b\.ts/);
  assert.doesNotMatch(f.ports.fs.readText(event.promptPaths['codex[0]']!), /changed paths: src\/a\.ts/);
  const scope = JSON.parse(f.ports.fs.readText(String(event.scope['manifestPath'])));
  assert.deepEqual(scope.governedPaths, ['src/b.ts']);
  const launched = await f.check(prepared.state, event);
  assert.equal(launched.state.tag, 'wave');
  assert.ok('c' in launched.state && launched.state.c.observations![0]!.use?.launchedRound === 2);
});

test('review-reuse: selected unchanged paths retain mandatory dispute and full coverage', async () => {
  for (const continuation of ['dispute', 'full'] as const) {
    const f = harness(); f.edit('src/a.ts'); f.edit('src/c.ts');
    const observed = await observedRule(f);
    if (observed.state.tag !== 'rule') throw new Error('rule frame');
    const c = { ...observed.state.c, findings: observed.state.c.findings.map((item) => item.id === 'R1-F001'
      ? { ...item, status: continuation === 'full' ? 'fixed' as const : 'pending-rejection' as const, fix: { paths: ['src/a.ts'], dependencies: [], verification: [] }, resolution: 'Disputed guard' }
      : { ...item, severity: 'CONSIDER' as const }) };
    const notice = c.observations![0]!;
    const selected = stepReview({ tag: 'rule', c }, { type: 'REVIEW_USE', observationId: notice.id, afterHash: notice.afterHash, action: 'targeted', paths: ['src/b.ts'], rationale: 'Inspect dependent code.' });
    const prepared = await f.check(selected.state, { type: 'RULINGS', rulings: { 'R1-F002': { ruling: 'accept' } } });
    const effect = prepared.effects.find((item) => item.kind === 'prepare-review');
    assert.ok(effect?.kind === 'prepare-review');
    const event = (await createPrepareReview({ cwd: f.cwd, git: f.git, skillRoot: path.resolve('skills/dispatch') })(effect, f.ports, { runDir: f.runDir, attempt: 1 }))[0];
    assert.ok(event?.type === 'REVIEW_PREPARED', JSON.stringify(event));
    assert.deepEqual([...(event.scope['paths'] as string[])].sort(), continuation === 'full' ? ['src/a.ts', 'src/b.ts', 'src/c.ts'] : ['src/a.ts', 'src/b.ts']);
    const prompt = f.ports.fs.readText(event.promptPaths['codex[0]']!);
    assert.match(prompt, /review paths: .*src\/b\.ts/);
    assert.match(prompt, /src\/a\.ts/);
    const launched = await f.check(prepared.state, event);
    assert.equal(launched.state.tag, 'wave');
    assert.ok('c' in launched.state && launched.state.c.findings[0]?.revision === 'original-revision');
  }
});
