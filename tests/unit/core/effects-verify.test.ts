import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  log: async () => '',
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

test('verify: failure IDs contain sorted stable test names and counts from the quiet reporter', async () => {
  const runDir = tempDir();
  const ports = fakePorts();
  ports.spawn = { run: async () => ({ exit: 1, stdout: '\n--- Test Failures ---\n\n✖ rejects expired tokens\n  Location: tests/auth.test.ts:12\n✖ rejects malformed tokens\n  Location: tests/auth.test.ts:20\n✖ 2 of 5 test(s) failed (3 passed, 8ms across 1 file(s))', stderr: '' }) };
  const result = only(await createVerify({ os: 'linux', cwd: '/repo', git })({ kind: 'verify', id: 'implement.verify.1', purpose: 'red', commands: [{ command: 'node --test tests/auth.test.ts' }] }, ports, { runDir, attempt: 1 }));
  assert.ok(result.type === 'VERIFY_DONE');
  if (result.type === 'VERIFY_DONE') {
    assert.deepEqual(result.results[0]?.['failedTests'], ['test:rejects expired tokens', 'test:rejects malformed tokens']);
    assert.deepEqual(result.results[0]?.['testCounts'], { pass: 3, fail: 2 });
    assert.equal(result.results[0]?.['failureId'], 'node --test tests/auth.test.ts::test:rejects expired tokens,test:rejects malformed tokens');
  }
});

test('implement-within-run-reuse: load errors are distinct and mapped input changes invalidate prior results', async () => {
  const cwd = tempDir();
  fs.mkdirSync(path.join(cwd, 'src'));
  const file = path.join(cwd, 'src', 'a.ts');
  fs.writeFileSync(file, 'const value = 1;');
  const runDir = tempDir();
  const ports = fakePorts();
  ports.spawn = { run: async () => ({ exit: 1, stdout: '', stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module' }) };
  const handler = createVerify({ os: 'linux', cwd, git });
  const spec = { kind: 'verify' as const, id: 'implement.verify.2', purpose: 'scoped', commands: [{ command: 'node --test tests/a.test.ts', inputPaths: ['src/a.ts'], environment: 'node22', planHash: 'plan-hash' }] };
  const first = only(await handler(spec, ports, { runDir, attempt: 1 }));
  assert.ok(first.type === 'VERIFY_DONE');
  if (first.type !== 'VERIFY_DONE') return;
  const firstFingerprint = first.results[0]?.['inputFingerprint'];
  assert.equal(first.results[0]?.['loadError'], true);
  assert.match(String(first.results[0]?.['failureId']), /::load-error:nonzero:Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/);
  fs.writeFileSync(file, 'const value = 2;');
  const second = only(await handler({ ...spec, id: 'implement.verify.3' }, ports, { runDir, attempt: 1 }));
  assert.ok(second.type === 'VERIFY_DONE');
  if (second.type === 'VERIFY_DONE') assert.notEqual(second.results[0]?.['inputFingerprint'], firstFingerprint);
});


test('known-red fallback identity ignores incidental counts, PID and port output', async () => {
  const ports = fakePorts();
  let iteration = 0;
  ports.spawn = { run: async () => ({ exit: 1, stdout: `pass ${++iteration}\nPID: ${100 + iteration}\n`, stderr: `Error: connection refused on port ${3000 + iteration}` }) };
  const handler = createVerify({ os: 'linux', cwd: '/repo', git });
  const effect = { kind: 'verify' as const, id: 'verify.1', purpose: 'baseline', commands: [{ command: 'check' }] };
  const first = only(await handler(effect, ports, { runDir: tempDir(), attempt: 1 }));
  const second = only(await handler(effect, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(first.type === 'VERIFY_DONE' && second.type === 'VERIFY_DONE');
  if (first.type === 'VERIFY_DONE' && second.type === 'VERIFY_DONE') assert.equal(first.results[0]?.['failureId'], second.results[0]?.['failureId']);
});

test('named JSON parse assertion failure remains RED rather than a load error', async () => {
  const ports = fakePorts();
  ports.spawn = { run: async () => ({ exit: 1, stdout: '✖ rejects bad JSON\n  Location: tests/json.test.ts:5\n  SyntaxError: Unexpected token', stderr: '' }) };
  const result = only(await createVerify({ os: 'linux', cwd: '/repo', git })({ kind: 'verify', id: 'verify.1', purpose: 'red', commands: [{ command: 'check' }] }, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(result.type === 'VERIFY_DONE');
  if (result.type === 'VERIFY_DONE') assert.equal(result.results[0]?.['loadError'], false);
});

test('reused result reports unknown counts instead of fabricated zero counts', async () => {
  const ports = fakePorts();
  ports.spawn = { run: async () => ({ exit: 0, stdout: '# pass 4\n# fail 0\n', stderr: '' }) };
  const handler = createVerify({ os: 'linux', cwd: '/repo', git });
  const first = only(await handler({ kind: 'verify', id: 'verify.1', purpose: 'scoped', commands: [{ command: 'check' }] }, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(first.type === 'VERIFY_DONE');
  if (first.type !== 'VERIFY_DONE') return;
  ports.spawn = { run: async () => { throw new Error('must reuse'); } };
  const result = only(await handler({ kind: 'verify', id: 'verify.2', purpose: 'final', commands: [{ command: 'check', reuse: first.results[0] }] }, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(result.type === 'VERIFY_DONE');
  if (result.type === 'VERIFY_DONE') { assert.equal(result.results[0]?.['reused'], true); assert.equal(result.results[0]?.['testCounts'], null); }
});
