import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createSnapshot } from '../../../skills/dispatch/scripts/effects/snapshot.ts';
import { createVerify, shellArgv } from '../../../skills/dispatch/scripts/effects/verify.ts';
import { writeCheckpoint } from '../../../skills/dispatch/scripts/effects/checkout.ts';
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

test('effect folder: two verification effects in one run keep distinct logs without precreated folders', async () => {
  const runDir = tempDir();
  const ports = fakePorts();
  ports.spawn = { run: async (argv) => ({ exit: 0, stdout: `out ${argv.at(-1)}`, stderr: '' }) };
  const verify = createVerify({ os: 'linux', cwd: '/repo', git });
  const first = only(await verify({ kind: 'verify', id: 'implement.verify.1', purpose: 'baseline', commands: [{ command: 'one' }] }, ports, { runDir, attempt: 1 }));
  const second = only(await verify({ kind: 'verify', id: 'implement.verify.2', purpose: 'fix-verify', commands: [{ command: 'two' }] }, ports, { runDir, attempt: 1 }));
  assert.ok(first.type === 'VERIFY_DONE' && second.type === 'VERIFY_DONE');
  const logs = [first, second].map((event) => String(event.results[0]?.['logPath']));
  assert.deepEqual(logs, [path.join(runDir, 'implement.verify.1', '1.log'), path.join(runDir, 'implement.verify.2', '1.log')]);
  assert.match(fs.readFileSync(logs[0]!, 'utf8'), /out one/);
  assert.match(fs.readFileSync(logs[1]!, 'utf8'), /out two/);
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

// SECTION: Expected names in log

const JEST_OUTPUT = [
  '\u001b[1m\u001b[31m FAIL \u001b[39m\u001b[22m src/auth.test.ts',
  '  auth',
  '    \u001b[31m✕\u001b[39m \u001b[2mrejects malformed tokens (1 ms)\u001b[22m',
  '    \u001b[32m✓\u001b[39m \u001b[2maccepts valid tokens (2 ms)\u001b[22m',
  '    \u001b[31m✕\u001b[39m \u001b[2mrejects expired tokens (5 ms)\u001b[22m',
  '',
  '  \u001b[1m● auth › rejects expired tokens\u001b[22m',
  '',
  '    expect(received).toBe(expected)',
  '',
  'Tests:       \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m, \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m, 3 total',
].join('\n');

const redRun = async (command: Record<string, unknown>, output: { exit: number; stdout: string; stderr: string } | Error) => {
  const ports = fakePorts();
  ports.spawn = { run: async () => { if (output instanceof Error) throw output; return output; } };
  const result = only(await createVerify({ os: 'linux', cwd: '/repo', git })({ kind: 'verify', id: 'implement.verify.1', purpose: 'red', commands: [command as { command: string }] }, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(result.type === 'VERIFY_DONE');
  return (result.type === 'VERIFY_DONE' ? result.results[0] : undefined) as Record<string, unknown>;
};

test('verify: expected names in log are found in Jest-style output and named in the failure ID', async () => {
  const row = await redRun(
    { command: 'npx jest src/auth.test.ts', expectedTests: ['rejects malformed tokens', 'rejects expired tokens', 'rejects revoked tokens'] },
    { exit: 1, stdout: JEST_OUTPUT, stderr: '' },
  );
  assert.deepEqual(row['failedTests'], ['test:rejects expired tokens', 'test:rejects malformed tokens']);
  assert.equal(row['failureId'], 'npx jest src/auth.test.ts::test:rejects expired tokens,test:rejects malformed tokens');
  assert.ok(!('testCounts' in row) && !('loadError' in row), JSON.stringify(row));
});

test('verify: expected names in log match only when bounded by line edges or non-alphanumeric characters', async () => {
  const row = await redRun(
    { command: 'check', expectedTests: ['parses', 'rejects input', 'trims', 'reports'] },
    { exit: 1, stdout: 'parsesAll failed\nprerejects input\nFAIL: trims\n', stderr: 'reports2 failed\n' },
  );
  assert.deepEqual(row['failedTests'], ['test:trims']);
});

test('verify: expected names in log ignore the command echo line', async () => {
  const row = await redRun(
    { command: 'npx jest -t "rejects expired tokens"', expectedTests: ['rejects expired tokens'] },
    { exit: 1, stdout: 'No tests found\n', stderr: '' },
  );
  assert.deepEqual(row['failedTests'], []);
  assert.match(String(row['failureId']), /^npx jest -t "rejects expired tokens"::exit:nonzero:[0-9a-f]{16}$/);
});

test('verify: expected names in log ignore Nx- and Jest-style quoted selector echoes', async () => {
  const nx = await redRun(
    { command: 'npx nx test api -t "rejects expired tokens"', expectedTests: ['rejects expired tokens'] },
    { exit: 1, stdout: '> nx run api:test -t "rejects expired tokens"\nSyntaxError: Unexpected token\n', stderr: '' },
  );
  assert.deepEqual(nx['failedTests'], []);
  const jest = await redRun(
    { command: 'npm test -- -t rejects', expectedTests: ['rejects expired tokens'] },
    { exit: 1, stdout: "No tests found, exiting with code 1\nPattern: src - 0 matches with tests matching \"rejects expired tokens\"\nalso 'rejects expired tokens' and `rejects expired tokens`\n", stderr: '' },
  );
  assert.deepEqual(jest['failedTests'], []);
});

test('verify: an unquoted failure line still matches beside a quoted selector echo', async () => {
  const row = await redRun(
    { command: 'npx nx test api -t "rejects expired tokens"', expectedTests: ['rejects expired tokens'] },
    { exit: 1, stdout: '> nx run api:test -t "rejects expired tokens"\n  ● auth › rejects expired tokens\n', stderr: '' },
  );
  assert.deepEqual(row['failedTests'], ['test:rejects expired tokens']);
});

test('verify: a selector-only echo in a baseline scan log is no baselineHit', async () => {
  const dir = tempDir();
  const echo = path.join(dir, 'baseline.log');
  fs.writeFileSync(echo, '$ npx nx test api -t "rejects expired tokens"\n> nx run api:test -t "rejects expired tokens"\nNo tests found, exiting with code 1\nwith tests matching "rejects expired tokens"\n[exit 1]\n');
  const row = await redRun(
    { command: 'npx nx test api -t "rejects expired tokens"', expectedTests: ['rejects expired tokens'], scanLogs: [echo] },
    { exit: 1, stdout: '  ● auth › rejects expired tokens\n', stderr: '' },
  );
  assert.deepEqual(row['baselineHits'], []);
  assert.deepEqual(row['failedTests'], ['test:rejects expired tokens']);
});

test('verify: expected names in log of baseline scan logs are baselineHits; unreadable scan logs are listed', async () => {
  const dir = tempDir();
  const echoOnly = path.join(dir, 'echo.log'), named = path.join(dir, 'named.log'), missing = path.join(dir, 'missing.log');
  fs.writeFileSync(echoOnly, '$ npx jest -t "rejects malformed tokens"\nNo tests found\n[exit 1]\n');
  fs.writeFileSync(named, `$ npx jest\n${JEST_OUTPUT}\n[exit 1]\n`);
  const row = await redRun(
    { command: 'npx jest src/auth.test.ts', expectedTests: ['rejects expired tokens', 'rejects malformed tokens', 'accepts valid tokens'], scanLogs: [echoOnly, missing, named] },
    { exit: 1, stdout: '', stderr: 'boom' },
  );
  assert.deepEqual(row['baselineHits'], ['test:accepts valid tokens', 'test:rejects expired tokens', 'test:rejects malformed tokens']);
  assert.deepEqual(row['scanUnreadable'], [missing]);
  assert.deepEqual(row['failedTests'], []);
});

test('verify: without expected names in log the failure ID names the exit class', async () => {
  const nonzero = await redRun({ command: 'check' }, { exit: 2, stdout: '', stderr: 'Error: boom' });
  assert.deepEqual([nonzero['failedTests'], nonzero['baselineHits'], nonzero['scanUnreadable']], [[], [], []]);
  assert.match(String(nonzero['failureId']), /^check::exit:nonzero:[0-9a-f]{16}$/);
  const spawn = await redRun({ command: 'check' }, new Error('not executable'));
  assert.equal(spawn['exit'], 127);
  assert.match(String(spawn['failureId']), /^check::exit:spawn:[0-9a-f]{16}$/);
});

test('known-red fallback identity differs for a different failing output of the same command', async () => {
  const accepted = await redRun({ command: 'node --test' }, { exit: 1, stdout: 'not ok 1 - parses dates\n', stderr: '' });
  const later = await redRun({ command: 'node --test' }, { exit: 1, stdout: 'not ok 1 - parses dates\nnot ok 2 - rejects nulls\n', stderr: '' });
  assert.notEqual(later['failureId'], accepted['failureId']);
});

test('implement-within-run-reuse: mapped input changes invalidate prior results', async () => {
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
  assert.match(String(first.results[0]?.['failureId']), /::exit:nonzero:[0-9a-f]{16}$/);
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

test('reused result reports no expected names in log and reads no scan logs', async () => {
  const ports = fakePorts();
  ports.spawn = { run: async () => ({ exit: 0, stdout: 'rejects expired tokens passed\n', stderr: '' }) };
  const handler = createVerify({ os: 'linux', cwd: '/repo', git });
  const first = only(await handler({ kind: 'verify', id: 'verify.1', purpose: 'scoped', commands: [{ command: 'check' }] }, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(first.type === 'VERIFY_DONE');
  if (first.type !== 'VERIFY_DONE') return;
  ports.spawn = { run: async () => { throw new Error('must reuse'); } };
  const reuse = { command: 'check', reuse: first.results[0], expectedTests: ['rejects expired tokens'], scanLogs: [path.join(tempDir(), 'missing.log')] };
  const result = only(await handler({ kind: 'verify', id: 'verify.2', purpose: 'final', commands: [reuse] }, ports, { runDir: tempDir(), attempt: 1 }));
  assert.ok(result.type === 'VERIFY_DONE');
  if (result.type === 'VERIFY_DONE') {
    const row = result.results[0] ?? {};
    assert.deepEqual([row['reused'], row['failedTests'], row['baselineHits'], row['scanUnreadable']], [true, [], [], []]);
    assert.ok(!('testCounts' in row) && !('loadError' in row), JSON.stringify(row));
  }
});

test('verify and snapshot run in the effect cwd when one is given', async () => {
  const seen: string[] = [];
  const probe: Git = { ...git, fingerprint: async (cwd) => { seen.push(cwd); return FP; } };
  const ports = fakePorts();
  ports.spawn = { run: async (_argv, options) => { seen.push(options.cwd); return { exit: 0, stdout: '', stderr: '' }; } };
  await createSnapshot({ cwd: '/repo', git: probe })({ kind: 'snapshot', id: 's.1', since: null, cwd: '/wt/t1' }, fakePorts(), { runDir: tempDir(), attempt: 1 });
  await createVerify({ os: 'linux', cwd: '/repo', git: probe })({ kind: 'verify', id: 'v.1', purpose: 'fix-verify', commands: [{ command: 'good' }], cwd: '/wt/t1' }, ports, { runDir: tempDir(), attempt: 1 });
  assert.ok(seen.length >= 2 && seen.every((cwd) => cwd === '/wt/t1'), JSON.stringify(seen));
});

test('checkpoint captures only listed files and records absent files as deletions', () => {
  const root = tempDir(), out = path.join(tempDir(), 'red.json');
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/a.test.ts'), 'red');
  fs.writeFileSync(path.join(root, 'tests/other.test.ts'), 'unlisted');
  assert.deepEqual(writeCheckpoint(fakePorts(), root, out, ['tests/a.test.ts', 'tests/gone.test.ts']).files, ['tests/a.test.ts', 'tests/gone.test.ts']);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('red').toString('base64'), 'tests/gone.test.ts': null } });
  assert.throws(() => writeCheckpoint(fakePorts(), root, out, ['../escape.ts']), /repository-relative/);
});

test('verify: expected names in log reject underscore-suffixed identifiers', async () => {
  const row = await redRun(
    { command: 'check', expectedTests: ['test_auth', 'TestParse'] },
    { exit: 1, stdout: 'FAILED tests/test_a.py::test_auth_expired\n--- FAIL: TestParse_Invalid (0.00s)\n', stderr: '' },
  );
  assert.deepEqual(row['failedTests'], []);
});

test('verify: expected name followed by a space and a status token is observed', async () => {
  const row = await redRun(
    { command: 'check', expectedTests: ['testMethod'] },
    { exit: 1, stdout: 'com.example.MyTest > testMethod FAILED\n', stderr: '' },
  );
  assert.deepEqual(row['failedTests'], ['test:testMethod']);
});

const fallbackId = async (cwd: string, stdout: string) => {
  const ports = fakePorts();
  ports.spawn = { run: async () => ({ exit: 1, stdout, stderr: '' }) };
  const result = only(await createVerify({ os: 'linux', cwd, git })({ kind: 'verify', id: 'verify.1', purpose: 'baseline', commands: [{ command: 'check' }] }, ports, { runDir: tempDir(), attempt: 1 }));
  return result.type === 'VERIFY_DONE' ? result.results[0]?.['failureId'] : undefined;
};

test('known-red fallback identity ignores output line order', async () => {
  assert.equal(await fallbackId('/repo', 'FAIL a.test.ts\nFAIL b.test.ts\n'), await fallbackId('/repo', 'FAIL b.test.ts\nFAIL a.test.ts\n'));
});

test('known-red fallback identity ignores the absolute run root, absolute path prefixes, and hex runs', async () => {
  const at = (root: string, hash: string) => `rootdir: ${root}\nError: boom\n    at ${root}/tests/a.test.js:4:1\n    at /usr/lib/node/runner.js:9:2\nsnapshot ${hash}\n`;
  assert.equal(await fallbackId('/repo', at('/repo', 'deadbeef12')), await fallbackId('/tmp/run/wt/task-t1', at('/tmp/run/wt/task-t1', 'cafe0123ab')));
  assert.equal(await fallbackId('C:\repo', at('C:\repo', 'deadbeef12')), await fallbackId('/repo', at('/repo', 'deadbeef12')));
});

test('known-red fallback identity differs for a different failing line', async () => {
  assert.notEqual(await fallbackId('/repo', 'Error: boom\n'), await fallbackId('/repo', 'Error: bang\n'));
});
