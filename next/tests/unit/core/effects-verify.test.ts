import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createSnapshot } from '../../../skills/dispatch/scripts/effects/snapshot.ts';
import { createVerify, shellArgv } from '../../../skills/dispatch/scripts/effects/verify.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const FP = { head: 'abc', index: 'i', worktree: 'w' };
const git: Git = {
  toplevel: async () => '/repo', indexEntries: async () => '', diffNames: async () => [],
  fingerprint: async () => FP, changedSince: async (_cwd, since) => (since ? ['src/a.ts'] : []),
};
const only = (events: readonly ResultEvent[]) => { assert.equal(events.length, 1); return events[0] as ResultEvent; };

test('shellArgv forks on the platform', () => {
  assert.deepEqual(shellArgv('win32', 'npm test'), ['cmd.exe', '/d', '/s', '/c', 'npm test']);
  assert.deepEqual(shellArgv('linux', 'npm test'), ['sh', '-c', 'npm test']);
});

test('verify: sequential runs with logs; a red command is VERIFY_DONE with its exit and log path', async () => {
  const runDir = tempDir();
  const ports = fakePorts();
  const calls: string[][] = [];
  ports.spawn = { run: async (argv) => { calls.push([...argv]); return argv.at(-1) === 'bad' ? { exit: 2, stdout: '', stderr: 'boom' } : { exit: 0, stdout: 'ok', stderr: '' }; } };
  const result = only(await createVerify({ os: 'linux', cwd: '/repo', git })({ kind: 'verify', id: 'review.verify.1', purpose: 'fix-verify', commands: [{ command: 'good' }, { command: 'bad' }] }, ports, { runDir, attempt: 1 }));
  assert.ok(result.type === 'VERIFY_DONE');
  assert.deepEqual(calls, [['sh', '-c', 'good'], ['sh', '-c', 'bad']]);
  assert.deepEqual(result.results.map((row) => [row['command'], row['exit']]), [['good', 0], ['bad', 2]]);
  assert.match(fs.readFileSync(String(result.results[1]?.['logPath']), 'utf8'), /boom[\s\S]*\[exit 2\]/);
  assert.deepEqual(result.fingerprint, FP);
  const none = only(await createVerify({ os: 'linux', cwd: '/repo', git })({ kind: 'verify', id: 'review.verify.2', purpose: 'fix-verify', commands: [] }, ports, { runDir, attempt: 1 }));
  assert.deepEqual(none.type === 'VERIFY_DONE' && none.results, []);
});

test('snapshot: fingerprint and changed paths since a prior fingerprint', async () => {
  const handler = createSnapshot({ cwd: '/repo', git });
  const first = only(await handler({ kind: 'snapshot', id: 's.1', since: null }, fakePorts(), { runDir: '/run', attempt: 1 }));
  assert.deepEqual(first.type === 'SNAPSHOT' && [first.fingerprint, first.diff], [FP, { paths: [] }]);
  const later = only(await handler({ kind: 'snapshot', id: 's.2', since: FP }, fakePorts(), { runDir: '/run', attempt: 1 }));
  assert.deepEqual(later.type === 'SNAPSHOT' && later.diff, { paths: ['src/a.ts'] });
});

test('verify: a log write failure is one EFFECT_FAILED io', async () => {
  const ports = fakePorts();
  ports.spawn = { run: async () => ({ exit: 0, stdout: '', stderr: '' }) };
  ports.fs = { ...ports.fs, writeAtomic: () => { throw new Error('disk full'); } };
  const result = only(await createVerify({ os: 'linux', cwd: '/repo', git })({ kind: 'verify', id: 'review.verify.3', purpose: 'fix-verify', commands: [{ command: 'good' }] }, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(result.type === 'EFFECT_FAILED' && result.cls === 'io' && /disk full/.test(result.detail));
});
