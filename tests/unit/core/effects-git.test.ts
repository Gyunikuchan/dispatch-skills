import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';

function fakeGit(failToplevel = 0) {
  const calls: string[] = [];
  let failures = failToplevel;
  return {
    calls,
    port: {
      run: async (args: readonly string[]) => {
        calls.push(args.join(' '));
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
          if (failures-- > 0) throw new Error('not a git repository');
          return '/repo\n';
        }
        if (args[0] === 'ls-files' && args[1] === '--stage') return '100644 abc 0\tsrc/a.ts\n';
        if (args[0] === 'rev-parse') return 'head\n';
        return 'src/a.ts\n';
      },
    },
  };
}
const count = (calls: readonly string[], prefix: string) => calls.filter((call) => call.startsWith(prefix)).length;

test('toplevel is cached after success only', async () => {
  const fake = fakeGit(1);
  const git = createGit(fake.port);
  await assert.rejects(git.toplevel('/repo/src'));
  assert.equal(await git.toplevel('/repo/src'), '/repo');
  assert.equal(await git.toplevel('/repo/src'), '/repo');
  assert.equal(count(fake.calls, 'rev-parse --show-toplevel'), 2);
});

test('index entries are cached by the index content hash; worktree reads are never cached', async () => {
  const fake = fakeGit();
  let index = 'bytes-1';
  const git = createGit(fake.port, () => index);
  await git.indexEntries('/repo');
  await git.indexEntries('/repo');
  assert.equal(count(fake.calls, 'ls-files --stage'), 1);
  index = 'bytes-2';
  await git.indexEntries('/repo');
  assert.equal(count(fake.calls, 'ls-files --stage'), 2);
  const uncached = createGit(fake.port);
  await uncached.indexEntries('/repo');
  await uncached.indexEntries('/repo');
  assert.equal(count(fake.calls, 'ls-files --stage'), 4);
  await git.diffNames('/repo', '');
  await git.diffNames('/repo', '');
  assert.equal(count(fake.calls, 'diff --name-only HEAD'), 2);
  await git.fingerprint('/repo');
  await git.fingerprint('/repo');
  assert.equal(count(fake.calls, 'status'), 2);
});

test('an option-like review range is rejected before git runs', async () => {
  const fake = fakeGit();
  await assert.rejects(createGit(fake.port).diffNames('/repo', '--output=/tmp/x'), /option-like/);
  assert.equal(count(fake.calls, 'diff'), 0);
});

test('the worktree fingerprint changes when an untracked file changes', async () => {
  let blob = 'aaa';
  const port = { run: async (args: readonly string[]) => (args[0] === 'hash-object' ? `${blob}\n` : args[0] === 'rev-parse' ? '/repo\n' : args[0] === 'ls-files' && args[1] === '--others' ? 'new.txt\n' : '') };
  const git = createGit(port);
  const first = await git.fingerprint('/repo');
  blob = 'bbb';
  assert.notEqual((await git.fingerprint('/repo')).worktree, first.worktree);
});

test('git-log: extracts commit messages and handles failures gracefully', async () => {
  const calls: string[] = [];
  const port = {
    run: async (args: readonly string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'log') {
        if (args[2] === 'error..range') throw new Error('git log failed');
        if (args[2] === 'empty..range') return '\n';
        return 'commit message subject\n\ncommit message body\n';
      }
      return '';
    },
  };
  const git = createGit(port);
  assert.ok(git.log);

  const msg = await git.log('/repo', 'main..HEAD');
  assert.equal(msg, 'commit message subject\n\ncommit message body');
  assert.ok(calls.includes('log --format=%s%n%b main..HEAD'));

  // Three-dot comparison translated to two-dot log range to exclude left-only commits
  const msgThreeDot = await git.log('/repo', 'main...HEAD');
  assert.equal(msgThreeDot, 'commit message subject\n\ncommit message body');
  assert.ok(calls.includes('log --format=%s%n%b main..HEAD'));

  const optionLike = await git.log('/repo', '--output=foo');
  assert.equal(optionLike, '');
  assert.equal(calls.filter((c) => c.startsWith('log --format=%s%n%b --output=foo')).length, 0);

  const errorMsg = await git.log('/repo', 'error..range');
  assert.equal(errorMsg, '');

  const emptyMsg = await git.log('/repo', 'empty..range');
  assert.equal(emptyMsg, '');
});

