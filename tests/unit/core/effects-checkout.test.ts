import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createCheckout, worktreePath } from '../../../skills/dispatch/scripts/effects/checkout.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

test('level-journal: scope replacement checkout resets an incomplete transfer and replays it', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run');
  const originalName = 'task-t1', name = 'task-t1-scope-2';
  const original = worktreePath(runDir, originalName), target = worktreePath(runDir, name);
  fs.mkdirSync(path.join(original, 'src'), { recursive: true });
  fs.writeFileSync(path.join(original, 'src', 'a.ts'), 'writer draft');
  const ports = fakePorts();
  let additions = 0, resets = 0, applies = 0;
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'worktree' && argv[1] === 'add') {
      additions++;
      fs.mkdirSync(path.join(target, 'src'), { recursive: true });
      fs.writeFileSync(path.join(target, 'src', 'a.ts'), 'new prerequisite');
      return '';
    }
    if (argv[0] === 'reset') { resets++; fs.writeFileSync(path.join(target, 'src', 'a.ts'), 'new prerequisite'); return ''; }
    if (argv[0] === 'clean') return '';
    if (argv[0] === 'diff' && argv[1] === '--name-only') return at === original ? 'src/a.ts\0' : 'src/a.ts\0';
    if (argv[0] === 'diff' && argv[1] === '--binary') return 'tracked draft patch';
    if (argv[0] === 'apply') {
      applies++;
      fs.writeFileSync(path.join(target, 'src', 'a.ts'), 'writer draft rebased on prerequisite');
      return '';
    }
    if (argv[0] === 'ls-files') return '';
    throw new Error(`unexpected fake git call: ${argv.join(' ')}`);
  };
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const input = { name, originalName, revision: 'new-base', permitted: ['src/a.ts'], transferKey: 'scope-request:T1:new-base:signature', links: [], ignored: [] };
  const effect = (id: string): Extract<Effect, { kind: 'checkout' }> => ({ kind: 'checkout', id, op: 'scope-rebase', input });
  const writeAtomic = ports.fs.writeBase64Atomic;
  let interrupted = false;
  ports.fs.writeBase64Atomic = (file, contents) => {
    if (!interrupted && file.includes(path.join('scope-transfers'))) { interrupted = true; throw new Error('simulated interruption before transfer marker'); }
    writeAtomic(file, contents);
  };
  const first = (await handler(effect('checkout.scope-rebase.1'), ports, { runDir, attempt: 1 }))[0] as ResultEvent;
  assert.ok(first.type === 'EFFECT_FAILED' && /simulated interruption/.test(first.detail));
  assert.equal(fs.readFileSync(path.join(target, 'src', 'a.ts'), 'utf8'), 'writer draft rebased on prerequisite');
  ports.fs.writeBase64Atomic = writeAtomic;

  const replay = (await handler(effect('checkout.scope-rebase.2'), ports, { runDir, attempt: 1 }))[0] as ResultEvent;
  assert.equal(replay.type, 'CHECKOUT_DONE');
  if (replay.type === 'CHECKOUT_DONE') {
    assert.equal(replay.result['conflict'], false);
    assert.equal(replay.result['path'], target);
    assert.equal(replay.result['revision'], 'new-base');
    assert.deepEqual(replay.result['transferred'], ['src/a.ts']);
  }
  assert.equal(additions, 1);
  assert.equal(resets, 1);
  assert.equal(applies, 2);
});

test('level-journal: scope replacement refuses destination symlink ancestors before draft writes', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run');
  const originalName = 'task-t1', name = 'task-t1-scope-2';
  const original = worktreePath(runDir, originalName), target = worktreePath(runDir, name);
  fs.mkdirSync(path.join(original, 'src'), { recursive: true });
  fs.writeFileSync(path.join(original, 'src', 'new.ts'), 'writer draft');
  const ports = fakePorts();
  const inspect = ports.fs.inspectPath;
  ports.fs.inspectPath = (file) => path.resolve(file) === path.resolve(target, 'src')
    ? { kind: 'symlink', mode: 0o777, linkTarget: '../outside', realPath: path.join(cwd, 'outside') }
    : inspect(file);
  let writes = 0;
  const writeAtomic = ports.fs.writeBase64Atomic;
  ports.fs.writeBase64Atomic = (file, contents) => { writes++; writeAtomic(file, contents); };
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'worktree' && argv[1] === 'add') { fs.mkdirSync(target, { recursive: true }); return ''; }
    if (argv[0] === 'diff' && argv[1] === '--name-only') return '';
    if (argv[0] === 'ls-files' && at === original) return 'src/new.ts\0';
    throw new Error(`unexpected fake git call: ${argv.join(' ')}`);
  };
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const input = { name, originalName, revision: 'new-base', permitted: ['src/new.ts'], transferKey: 'scope-request:T1:new-base:signature', links: [], ignored: [] };
  const [event] = await handler({ kind: 'checkout', id: 'checkout.scope-rebase.1', op: 'scope-rebase', input }, ports, { runDir, attempt: 1 });
  assert.ok(event?.type === 'CHECKOUT_DONE');
  if (event?.type === 'CHECKOUT_DONE') {
    assert.equal(event.result['conflict'], true);
    assert.match(String(event.result['detail']), /symlink ancestor/);
  }
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'outside', 'new.ts')), false);
});
