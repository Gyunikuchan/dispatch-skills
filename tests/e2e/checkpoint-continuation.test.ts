import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { nodePorts } from '../../skills/dispatch/scripts/core/ports.ts';
import { createCheckout, checkoutRecovery } from '../../skills/dispatch/scripts/effects/checkout.ts';
import { createGit } from '../../skills/dispatch/scripts/effects/git.ts';
import { createSnapshot } from '../../skills/dispatch/scripts/effects/snapshot.ts';
import { createRestore, restoreRecovery } from '../../skills/dispatch/scripts/effects/restore.ts';
import type { Effect } from '../../skills/dispatch/scripts/core/types.ts';
import { fixture } from '../helpers/e2e.ts';

// SECTION: Candidate delivery and restore recovery

test('recovery-git: committed candidate and delivery proof retain all-path caller collision guards', async () => {
  const f = fixture(), originalWrite = nodePorts().fs.writeBase64Atomic;
  try {
    f.git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'old b\n'); f.git('add', '.'); f.git('commit', '-qm', 'two files');
    const runDir = path.join(f.repo, '.scratch/recovery'); fs.mkdirSync(runDir, { recursive: true });
    const ports = nodePorts(), ctx = { runDir, attempt: 1 };
    const deps = { cwd: f.repo, links: { create: (target: string, link: string) => fs.symlinkSync(target, link, 'junction'), remove: (link: string) => fs.unlinkSync(link) } };
    const handler = createCheckout(deps), probe = checkoutRecovery(deps).probe!;
    let id = 0;
    const op = async (name: string, input: Record<string, unknown> = {}) => {
      const effect = { kind: 'checkout', id: `git.${++id}`, op: name, input } as Extract<Effect, { kind: 'checkout' }>;
      const event = (await handler(effect, ports, ctx))[0]!; assert.equal(event.type, 'CHECKOUT_DONE', JSON.stringify(event));
      if (event.type !== 'CHECKOUT_DONE') throw new Error('checkout result');
      return { effect, result: event.result as Record<string, unknown> };
    };
    const base = String((await op('init')).result['base']);
    const worktree = String((await op('task', { name: 't1', revision: base })).result['path']);
    fs.writeFileSync(path.join(worktree, 'src/a.ts'), 'new a\n'); fs.writeFileSync(path.join(worktree, 'src/b.ts'), 'new b\n');
    const committed = await op('commit', { name: 't1', base });
    const candidate = String(committed.result['revision']);
    const candidateProof = await probe(committed.effect, ports, ctx);
    assert.equal(candidateProof.status, 'complete');
    const integrated = await op('integrate', { task: 'T1', candidate, expected: base });
    const head = String(integrated.result['revision']);
    assert.equal((await probe(integrated.effect, ports, ctx)).status, 'complete');
    f.git('cat-file', '-e', `${candidate}^{commit}`); f.git('cat-file', '-e', `${head}^{commit}`);
    const delivery: Extract<Effect, { kind: 'checkout' }> = { kind: 'checkout', id: 'delivery.1', op: 'deliver', input: { base, revision: head } };
    let writes = 0;
    ports.fs.writeBase64Atomic = (file, bytes) => { if (++writes === 2) throw new Error('interruption after first delivery path'); originalWrite(file, bytes); };
    const interrupted = (await handler(delivery, ports, ctx))[0]!;
    assert.equal(interrupted.type, 'EFFECT_FAILED');
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'new a\n');
    assert.equal((await probe(delivery, ports, ctx)).status, 'unresolved');
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'newer caller b\n');
    ports.fs.writeBase64Atomic = () => { throw new Error('collision must stop every write'); };
    const collision = (await handler(delivery, ports, { ...ctx, attempt: 2 }))[0]!;
    assert.equal(collision.type, 'CHECKOUT_DONE');
    if (collision.type !== 'CHECKOUT_DONE') throw new Error('collision');
    assert.deepEqual(collision.result['conflicts'], ['src/b.ts']);
    assert.deepEqual(collision.result['transferred'], []);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'newer caller b\n');
    assert.equal(fs.readFileSync(path.join(runDir, 'wt/integration/src/b.ts'), 'utf8'), 'new b\n');
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'old b\n'); ports.fs.writeBase64Atomic = originalWrite;
    const resumed = (await handler(delivery, ports, { ...ctx, attempt: 3 }))[0]!;
    assert.equal(resumed.type, 'CHECKOUT_DONE');
    if (resumed.type !== 'CHECKOUT_DONE') throw new Error('delivery');
    assert.deepEqual(resumed.result['already'], ['src/a.ts']); assert.deepEqual(resumed.result['transferred'], ['src/b.ts']);
    let repeatedWrites = 0; ports.fs.writeBase64Atomic = () => { repeatedWrites++; };
    assert.equal((await probe(delivery, ports, { ...ctx, attempt: 3 })).status, 'complete'); assert.equal(repeatedWrites, 0); ports.fs.writeBase64Atomic = originalWrite;
  } finally { nodePorts().fs.writeBase64Atomic = originalWrite; f.cleanup(); }
});

test('recovery-git: immutable restore survives partial mutation and refuses newer caller bytes before retry', async () => {
  const f = fixture();
  try {
    f.git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'original b\n'); f.git('add', '.'); f.git('commit', '-qm', 'restore base');
    const runDir = path.join(f.repo, '.scratch/restore'); fs.mkdirSync(runDir, { recursive: true });
    const ports = nodePorts(), ctx = { runDir, attempt: 1 };
    const captured = (await createSnapshot({ cwd: f.repo, git: createGit(ports.git) })({ kind: 'snapshot', id: 'snapshot.1', since: null }, ports, ctx))[0]!;
    if (captured.type !== 'SNAPSHOT') throw new Error('snapshot');
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'failed a\n'); fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'failed b\n');
    const effect: Extract<Effect, { kind: 'restore' }> = { kind: 'restore', id: 'restore.1', paths: ['src/a.ts', 'src/b.ts'], to: captured.fingerprint };
    const restore = createRestore({ cwd: f.repo }), probe = restoreRecovery({ cwd: f.repo }).probe!;
    const write = ports.fs.writeBase64Atomic; let count = 0;
    ports.fs.writeBase64Atomic = (file, bytes) => { if (++count === 2) throw new Error('partial restore interruption'); write(file, bytes); };
    const interrupted = (await restore(effect, ports, ctx))[0]!; assert.equal(interrupted.type, 'EFFECT_FAILED'); if (interrupted.type === 'EFFECT_FAILED') assert.match(interrupted.detail, /partial restore interruption/, JSON.stringify(interrupted));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal((await probe(effect, ports, ctx)).status, 'unresolved');
    const patch = path.join(runDir, 'restore.1/restore.json'), bytes = fs.readFileSync(patch);
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'newer caller b\n');
    ports.fs.writeBase64Atomic = () => { throw new Error('collision must stop every write'); };
    const conflict = (await restore(effect, ports, { ...ctx, attempt: 2 }))[0]!;
    assert.equal(conflict.type, 'EFFECT_FAILED');
    if (conflict.type !== 'EFFECT_FAILED') throw new Error('restore conflict');
    assert.deepEqual(conflict.conflict?.paths, ['src/b.ts']);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'newer caller b\n');
    assert.deepEqual(fs.readFileSync(patch), bytes);
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'failed b\n'); ports.fs.writeBase64Atomic = write;
    assert.equal((await restore(effect, ports, { ...ctx, attempt: 3 }))[0]!.type, 'RESTORED');
    assert.equal((await probe(effect, ports, { ...ctx, attempt: 3 })).status, 'complete');
    assert.deepEqual(fs.readFileSync(patch), bytes);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'original b\n'); ports.fs.writeBase64Atomic = write;
  } finally { f.cleanup(); }
});

// SECTION: Ordered delivery replay continuation

test('recovery-git: ordered delivery replay retains conflicts, recovers resolution and refuses repeated collisions', async () => {
  const f = fixture();
  try {
    f.git('config', 'core.autocrlf', 'false');
    for (const file of ['src/b.ts', 'src/c.ts']) fs.writeFileSync(path.join(f.repo, file), 'old\n');
    f.git('add', '.'); f.git('commit', '-qm', 'replay inputs');
    const runDir = path.join(f.repo, '.scratch/replay'); fs.mkdirSync(runDir, { recursive: true });
    const ports = nodePorts(), ctx = { runDir, attempt: 1 };
    const deps = { cwd: f.repo, links: { create: (target: string, link: string) => fs.symlinkSync(target, link, 'junction'), remove: (link: string) => fs.unlinkSync(link) } };
    const handler = createCheckout(deps), proof = checkoutRecovery(deps).probe!;
    let sequence = 0;
    const op = async (name: string, input: Record<string, unknown> = {}, effectId = `replay.${++sequence}`) => {
      const effect = { kind: 'checkout', id: effectId, op: name, input } as Extract<Effect, { kind: 'checkout' }>;
      const event = (await handler(effect, ports, ctx))[0]!;
      assert.equal(event.type, 'CHECKOUT_DONE', JSON.stringify(event));
      if (event.type !== 'CHECKOUT_DONE') throw new Error('checkout result');
      return { effect, result: event.result as Record<string, unknown> };
    };
    const initial = (await op('init')).result, base = String(initial['base']); let acceptedHead = base;
    const accepted: string[] = [];
    for (const [n, file] of ['src/b.ts', 'src/a.ts', 'src/c.ts'].entries()) {
      const worktree = String((await op('task', { name: `t${n}`, revision: acceptedHead })).result['path']);
      fs.writeFileSync(path.join(worktree, file), file === 'src/a.ts' ? 'export const value = 2;\n' : 'accepted\n');
      const candidate = String((await op('commit', { name: `t${n}`, base: acceptedHead })).result['revision']);
      acceptedHead = String((await op('integrate', { task: `T${n}`, candidate, expected: acceptedHead })).result['revision']);
      accepted.push(acceptedHead);
    }
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 3; // caller\n');
    const replayInput = { rebase: true, archivedName: 'integration-first', replay: { base, head: acceptedHead } };
    const conflicted = (await op('init', replayInput)).result;
    const active = String(conflicted['path']);
    assert.equal(conflicted['conflict'], true);
    assert.deepEqual(conflicted['candidatePaths'], ['src/a.ts'], 'replay scope metadata comes from the full source commit delta');
    assert.deepEqual((conflicted['replayed'] as { from: string }[]).map((row) => row.from), [accepted[0]], 'earlier pick remains committed');
    assert.equal(f.git('-C', active, 'rev-parse', 'HEAD').trim(), conflicted['head']);
    assert.equal(f.git('-C', active, 'rev-parse', 'CHERRY_PICK_HEAD').trim(), accepted[1]);
    assert.equal(fs.readFileSync(path.join(active, 'src/b.ts'), 'utf8'), 'accepted\n');
    fs.writeFileSync(path.join(active, 'src/a.ts'), 'export const value = 2; // caller\n');
    const resolution = await op('resolve', { tasks: ['T1'], candidate: accepted[1], expected: conflicted['head'], base: conflicted['head'], attempt: 1, permitted: ['src/a.ts'] });
    assert.equal((await proof(resolution.effect, ports, ctx)).status, 'complete', 'committed resolution is recoverable before sealing');
    assert.equal((await op('resolve', resolution.effect.input as Record<string, unknown>, resolution.effect.id)).result['revision'], resolution.result['revision']);
    const runGit = ports.git.run;
    let failReplay = true;
    ports.git.run = async (args, cwd) => {
      if (failReplay && args[0] === 'rev-list' && args.includes('--reverse')) { failReplay = false; throw new Error('Injected replay range read failure'); }
      return runGit(args, cwd);
    };
    const failed = (await handler({ kind: 'checkout', id: 'replay.failed-continuation', op: 'init', input: replayInput }, ports, ctx))[0]!;
    assert.equal(failed.type, 'EFFECT_FAILED');
    assert.equal(f.git('-C', active, 'rev-parse', 'HEAD').trim(), resolution.result['revision']);
    assert.equal(fs.readFileSync(path.join(active, 'src/c.ts'), 'utf8'), 'old\n', 'remaining accepted pick is still pending');
    const resumed = (await op('init', replayInput)).result;
    assert.equal(resumed['conflict'], false);
    assert.deepEqual((resumed['replayed'] as { from: string }[]).map((row) => row.from), accepted);
    assert.equal((await op('init', replayInput)).result['head'], resumed['head'], 'retry repeats no completed pick');
    for (const revision of accepted) f.git('cat-file', '-e', `${revision}^{commit}`);
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 4; // next caller\n');
    const secondInput = { rebase: true, archivedName: 'integration-second', replay: { base: resumed['base'], head: resumed['head'] } };
    const second = (await op('init', secondInput)).result;
    assert.equal(second['conflict'], true, 'a new caller collision produces a new retained pick');
    fs.writeFileSync(path.join(active, 'src/a.ts'), 'export const value = 2; // next caller\n');
    await op('resolve', { tasks: ['T1'], candidate: second['candidate'], expected: second['head'], base: second['head'], attempt: 1, permitted: ['src/a.ts'] });
    const final = (await op('init', secondInput)).result;
    fs.writeFileSync(path.join(f.repo, 'src/c.ts'), 'newer caller c\n');
    const collision = (await op('deliver', { base: final['base'], revision: final['head'] })).result;
    assert.deepEqual(collision['conflicts'], ['src/c.ts']); assert.deepEqual(collision['transferred'], []);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 4; // next caller\n');
    fs.writeFileSync(path.join(f.repo, 'src/c.ts'), 'old\n');
    assert.deepEqual((await op('deliver', { base: final['base'], revision: final['head'] })).result['conflicts'], []);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2; // next caller\n');
  } finally { f.cleanup(); }
});
