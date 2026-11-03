import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { nodeHostUsageFs } from '../../../../skills/dispatch/scripts/toolkit/host-usage/index.ts';
import { MAX_FILE_BYTES } from '../../../../skills/dispatch/scripts/toolkit/host-usage/types.ts';
import { codex } from '../../../../skills/dispatch/scripts/toolkit/host-usage/codex.ts';
import { lines, memoryFs, query } from './helpers/memory-fs.ts';

const rollout = (time: string, id: string, compressed = false) => `/home/.codex/sessions/1970/01/01/rollout-1970-01-01T00-${time}-${id}.jsonl${compressed ? '.zst' : ''}`;
const meta = (parent: string, source = 'subagent') => ({ type: 'session_meta', payload: { parent_thread_id: parent, thread_source: source } });
const context = { type: 'turn_context', payload: { model: 'm', effort: 'high' } };
const event = (total: number, at = 3000, counters: { input_tokens: number; cached_input_tokens?: number; output_tokens: number; reasoning_output_tokens?: number } = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 }) => ({
  type: 'event_msg', timestamp: new Date(at).toISOString(),
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: counters } },
});

test('codex counts resumed host and direct child usage once by model', () => {
  const host = rollout('00-01', 'host'); const resumedHost = rollout('00-02', 'host');
  const child = rollout('00-03', 'child'); const resumedChild = rollout('00-04', 'child');
  const otherModel = { type: 'turn_context', payload: { model: 'other', effort: 'low' } };
  const small = { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 };
  const files = {
    [host]: lines(meta('', ''), context, event(15)),
    [resumedHost]: lines(meta('', ''), context, event(15), event(16, 4000, small), otherModel, event(20, 5000, { input_tokens: 6, cached_input_tokens: 0, output_tokens: 3 })),
    [child]: lines(meta('host'), context, event(15)),
    [resumedChild]: lines(meta('host'), context, event(15), event(16, 4000, small)),
    [rollout('00-05', 'grandchild')]: lines(meta('child'), context, event(21)),
    [rollout('00-06', 'delegate')]: lines(meta('', 'cli'), context, event(22)),
    [rollout('00-07', 'guardian')]: lines(meta('host', 'guardian_review'), context, event(23)),
  };
  const result = codex.read({ ...query, budget: { remaining: 100000 } }, memoryFs(files));
  assert.deepEqual(result.rows.map(row => [row.role, row.model, row.effort, row.input, row.output, row.cacheRead, row.reasoning]), [
    ['host', 'm', 'high', 6, 5, 4, 2],
    ['host', 'm', 'high', 3, 2, 1, undefined],
    ['host', 'other', 'low', 6, 3, 0, undefined],
    ['subagent', 'm', 'high', 6, 5, 4, 2],
    ['subagent', 'm', 'high', 3, 2, 1, undefined],
  ]);
});

test('codex ignores a pre-window token total copied into a resumed rollout', () => {
  const host = rollout('00-01', 'host');
  const resumed = rollout('00-02', 'host');
  const result = codex.read({ ...query, startMs: 2000, budget: { remaining: 10000 } }, memoryFs({
    [host]: lines(context, event(3, 1000)),
    [resumed]: lines(context, event(3, 3000)),
  }));
  assert.deepEqual(result.rows, []);
  assert.equal(result.unavailable, 'no usage records');
});

test('codex requires an exact host id before reading rollout candidates', () => {
  const file = '/home/.codex/sessions/1970/01/01/rollout-1970-01-01T00-00-01-host-long.jsonl';
  const other = rollout('00-02', 'other');
  const fs = memoryFs({ [file]: 'private', [other]: lines(meta('host'), context, event(2)) }); const stats: string[] = []; let reads = 0;
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, {
    ...fs,
    stat: candidate => { stats.push(candidate); return fs.stat(candidate); },
    read: (...args) => { reads++; return fs.read(...args); },
  });
  assert.equal(result.unavailable, 'host id file missing');
  assert.deepEqual(stats, []);
  assert.equal(reads, 0);
  assert.deepEqual(fs.reads, []);
});

test('codex stops at the shared read budget and keeps host counters', () => {
  const host = rollout('00-01', 'host'); const child = rollout('00-02', 'child');
  const hostText = lines(context, event(4));
  const fs = memoryFs({ [host]: hostText, [child]: lines(meta('host'), context, event(5)) });
  const result = codex.read({ ...query, budget: { remaining: Buffer.byteLength(hostText) } }, fs);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.role, 'host');
  assert.equal(result.notes?.subagent?.['read budget reached'], 1);
  assert.equal(fs.reads.length, 1);

  const first = rollout('00-01', 'host'); const resumed = rollout('00-02', 'host');
  const hostFs = memoryFs({ [first]: hostText, [resumed]: lines(context, event(6)) });
  const hostStop = codex.read({ ...query, budget: { remaining: Buffer.byteLength(hostText) } }, hostFs);
  assert.equal(hostStop.rows.length, 1);
  assert.equal(hostStop.notes?.host?.['read budget reached'], 1);
  assert.equal(hostFs.reads.length, 1);
});

test('codex keeps child rows when the host transcript is compressed or oversized', () => {
  const host = rollout('00-01', 'host', true); const child = rollout('00-02', 'child');
  const fs = memoryFs({ [host]: 'compressed', [child]: lines(meta('host'), context, event(4)) });
  const unsupported = codex.read({ ...query, budget: { remaining: 10000 } }, fs);
  assert.equal(unsupported.unavailable, 'zstd unavailable');
  assert.equal(unsupported.rows[0]?.role, 'subagent');

  const oversizedFs = memoryFs({ [host]: 'compressed', [child]: lines(meta('host'), context, event(4)) });
  const oversized = codex.read({ ...query, budget: { remaining: 256 * 1024 * 1024 } }, {
    ...oversizedFs,
    stat: file => file.endsWith('host.jsonl.zst') ? { size: 128 * 1024 * 1024 + 1, mtimeMs: 10000 } : oversizedFs.stat(file),
  });
  assert.equal(oversized.unavailable, 'transcript over size cap');
  assert.equal(oversized.rows[0]?.role, 'subagent');
  assert.equal(oversizedFs.reads.length, 1);

  const plainHost = rollout('00-03', 'host');
  const plainFs = memoryFs({ [plainHost]: 'x', [child]: lines(meta('host'), context, event(2)) });
  const plainResult = codex.read({ ...query, budget: { remaining: 256 * 1024 * 1024 } }, { ...plainFs, stat: file => file.endsWith('host.jsonl') ? { size: MAX_FILE_BYTES + 1, mtimeMs: 10000 } : plainFs.stat(file) });
  assert.equal(plainResult.unavailable, 'transcript over size cap'); assert.equal(plainResult.rows[0]?.role, 'subagent');
});

test('codex reports unsupported, oversized, and over-budget child transcripts', () => {
  const host = rollout('00-01', 'host'); const unsupported = rollout('00-02', 'zip', true);
  const oversized = rollout('00-03', 'big'); const oversizedCompressed = rollout('00-04', 'big-zip', true);
  const hostText = lines(context, event(4));
  const fs = memoryFs({ [host]: hostText, [unsupported]: 'compressed', [oversized]: 'x', [oversizedCompressed]: 'x' });
  const result = codex.read({ ...query, budget: { remaining: 256 * 1024 * 1024 } }, {
    ...fs,
    stat: file => file.endsWith('big.jsonl') ? { size: MAX_FILE_BYTES + 1, mtimeMs: 10000 }
      : file.endsWith('big-zip.jsonl.zst') ? { size: MAX_FILE_BYTES * 2 + 1, mtimeMs: 10000 } : fs.stat(file),
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.notes?.subagent?.['zstd unavailable'], 1);
  assert.equal(result.notes?.subagent?.['unverified candidates'], 2);

  const child = rollout('00-02', 'child', true); const childText = lines(meta('host'), context, event(5));
  const compressedFs = memoryFs({ [host]: hostText, [child]: zstdCompressSync(Buffer.from(childText)) });
  const budgeted = codex.read({ ...query, budget: { remaining: Buffer.byteLength(hostText) + 10 } }, {
    ...compressedFs,
    decompress: nodeHostUsageFs.decompress,
  });
  assert.equal(budgeted.rows.length, 1);
  assert.equal(budgeted.rows[0]?.role, 'host');
  assert.equal(budgeted.notes?.subagent?.['read budget reached'], 1);
});

test('codex ignores stale and removed children while deduplicating resumed child totals', () => {
  const host = rollout('00-01', 'host'); const first = rollout('00-02', 'child'); const resumed = rollout('00-03', 'child');
  const stale = rollout('00-04', 'stale'); const removed = rollout('00-05', 'removed');
  const fs = memoryFs({
    [host]: lines(context, event(1)),
    [first]: lines(meta('host'), context, event(7, 1000)),
    [resumed]: lines(meta('host'), context, event(7, 3000), event(8, 4000)),
    [stale]: lines(meta('host'), context, event(9)),
    [removed]: lines(meta('host'), context, event(10)),
  }, { [stale]: 1000 });
  let removedStats = 0;
  const result = codex.read({ ...query, startMs: 2000, budget: { remaining: 100000 } }, {
    ...fs,
    stat: file => file.endsWith('removed.jsonl') && ++removedStats > 1 ? null : fs.stat(file),
  });
  assert.equal(result.rows.filter(row => row.role === 'subagent').length, 1);
  assert.equal(result.rows.find(row => row.role === 'subagent')?.input, 6);
  assert.ok(!fs.reads.some(file => file.endsWith('stale.jsonl') || file.endsWith('removed.jsonl')));
});

test('codex ignores unrelated lines and malformed events do not poison token totals', () => {
  const host = rollout('00-01', 'host');
  const badTime = { ...event(7), timestamp: 'invalid' };
  const badCounter = { ...event(8), payload: { ...event(8).payload, info: { ...event(8).payload.info, last_token_usage: { input_tokens: 2, cached_input_tokens: 3, output_tokens: 1 } } } };
  const badOptional = { ...event(9), payload: { ...event(9).payload, info: { ...event(9).payload.info, last_token_usage: { input_tokens: 2, output_tokens: 1, reasoning_output_tokens: -1 } } } };
  const fs = memoryFs({ [host]: lines(null, 1, { type: 'user' }, { type: 'event_msg', payload: { type: 'other' } }, event(6), context, event(6), badTime, event(7), badCounter, event(8), badOptional, event(9), event(10)) });
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, fs);
  assert.equal(result.unavailable, undefined);
  assert.deepEqual(result.rows.map(row => row.input), [6, 6, 6, 6, 6]);
  assert.equal(result.notes?.host?.['unparsed lines'], 4);

  const child = rollout('00-02', 'child');
  const partial = codex.read({ ...query, budget: { remaining: 10000 } }, memoryFs({
    [host]: '{bad\n',
    [child]: lines(meta('host'), context, event(3)),
  }));
  assert.equal(partial.unavailable, 'no usage records');
  assert.equal(partial.notes?.host?.['unparsed lines'], 1);
  assert.equal(partial.rows[0]?.role, 'subagent');
});

test('codex lists rollout dates but stats only candidates in the bounded window', () => {
  const host = rollout('00-01', 'host'); const child = rollout('00-02', 'child');
  const old = '/home/.codex/sessions/1969/12/31/rollout-1969-12-31T00-00-01-old.jsonl';
  const future = '/home/.codex/sessions/1970/01/04/rollout-1970-01-04T00-00-01-future.jsonl';
  const fs = memoryFs({ [host]: lines(context, event(1)), [child]: lines(meta('host'), context, event(2)), [old]: 'old', [future]: 'future' });
  const stats: string[] = []; const lists: string[] = [];
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, {
    ...fs,
    stat: file => { stats.push(file); return fs.stat(file); },
    list: dir => { lists.push(dir); return fs.list(dir); },
  });
  assert.equal(result.rows.length, 2);
  assert.ok(stats.every(file => !file.includes('old.jsonl') && !file.includes('future.jsonl')));
  assert.equal(lists.filter(dir => dir.endsWith('1969\\12\\31') || dir.endsWith('1969/12/31')).length, 1);
  assert.equal(lists.filter(dir => dir.endsWith('1970\\01\\04') || dir.endsWith('1970/01/04')).length, 1);
});

test('codex caps candidates and keeps the newest ones', () => {
  const host = rollout('00-00', 'host'); const files: Record<string, string> = { [host]: lines(context, event(4)) };
  for (let i = 0; i < 257; i++) {
    const time = `${String(Math.floor(i / 60) + 1).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}`;
    files[rollout(time, `child-${i}`)] = lines(meta('host'), context, event(i + 1));
  }
  const fs = memoryFs(files); const result = codex.read({ ...query, budget: { remaining: 1024 * 1024 } }, fs);
  assert.equal(result.notes?.subagent?.['too many candidates'], 1);
  assert.equal(result.rows.filter(row => row.role === 'subagent').length, 256);
  assert.ok(!fs.reads.some(file => file.includes('child-0.jsonl')));

  const resumedFiles: Record<string, string> = { [host]: lines(context, event(1)) }; const times: Record<string, number> = {};
  for (let i = 0; i < 257; i++) { const time = `${String(Math.floor(i / 60) + 1).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}`; const file = rollout(time, 'child'); resumedFiles[file] = lines(meta('host'), context, event(i + 1)); times[file] = i === 256 ? 10000 : 1000; }
  const resumedFs = memoryFs(resumedFiles, times); const resumedResult = codex.read({ ...query, startMs: 2000, budget: { remaining: 1000000 } }, resumedFs);
  assert.equal(resumedResult.notes?.subagent?.['too many candidates'], 1); assert.equal(resumedResult.rows.filter(row => row.role === 'subagent').length, 0); assert.equal(resumedFs.reads.length, 1);
});

test('codex finds direct children from the earliest host rollout date', () => {
  const earlyHost = rollout('00-01', 'host'); const earlyChild = rollout('00-02', 'child');
  const lateHost = '/home/.codex/sessions/1970/01/02/rollout-1970-01-02T00-00-01-host.jsonl';
  const fs = memoryFs({ [earlyHost]: lines(context, event(1)), [lateHost]: lines(context, event(2)), [earlyChild]: lines(meta('host'), context, event(3)) });
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, fs);
  assert.equal(result.rows.filter(row => row.role === 'host').length, 2);
  assert.equal(result.rows.filter(row => row.role === 'subagent').length, 1);
});

test('codex reads compressed host and child rollouts within the decoded-byte budget', () => {
  const host = rollout('00-01', 'host', true); const child = rollout('00-02', 'child', true);
  const hostText = lines(meta('', ''), context, event(4)); const childText = lines(meta('host'), context, event(5));
  const fs = memoryFs({ [host]: zstdCompressSync(Buffer.from(hostText)), [child]: zstdCompressSync(Buffer.from(childText)) });
  const budget = { remaining: 10000 };
  const result = codex.read({ ...query, budget }, { ...fs, decompress: nodeHostUsageFs.decompress });
  assert.deepEqual(result.rows.map(row => row.role), ['host', 'subagent']);
  assert.equal(budget.remaining, 10000 - Buffer.byteLength(hostText) - Buffer.byteLength(childText));
});

test('codex hides host and child read errors while retaining other child usage', () => {
  const host = rollout('00-01', 'host'); const bad = rollout('00-02', 'bad'); const good = rollout('00-03', 'good');
  const fs = memoryFs({ [host]: 'x', [bad]: 'x', [good]: lines(meta('host'), context, event(2)) });
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, {
    ...fs,
    read: (file, max) => {
      if (file.endsWith('host.jsonl')) throw Object.assign(new Error('private'), { code: 'EPERM' });
      if (file.endsWith('bad.jsonl')) throw Error('private');
      return fs.read(file, max);
    },
  });
  assert.equal(result.unavailable, 'read-error:EPERM');
  assert.equal(result.notes?.subagent?.['unreadable files'], 1);
  assert.equal(result.rows[0]?.role, 'subagent');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('codex validates the first nonblank child header before counting rows', () => {
  const host = rollout('00-01', 'host'); const child = rollout('00-02', 'child'); const resumed = rollout('00-03', 'child'); const other = rollout('00-04', 'other');
  const fs = memoryFs({ [host]: lines(context, event(1)), [child]: '\n' + lines(meta('host'), context, event(7)), [resumed]: '\n' + lines(meta('host'), context, event(7)), [other]: '\n' + lines(meta('other'), context, event(8)) });
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, fs);
  assert.equal(result.rows.filter(row => row.role === 'subagent').length, 1);
});
test('codex preserves host counters when candidate listing or stat fails', () => {
  const host = rollout('00-01', 'host'); const child = rollout('00-02', 'child'); const fs = memoryFs({ [host]: lines(context, event(1)), [child]: lines(meta('host'), context, event(2)) }); let listCount = 0;
  const listFailure = codex.read({ ...query, budget: { remaining: 10000 } }, { ...fs, list: dir => { if (/1970[\\/]01[\\/]01$/.test(dir) && ++listCount === 2) throw Object.assign(Error('private'), { code: 'EACCES' }); return fs.list(dir); } });
  assert.equal(listFailure.rows[0]?.role, 'host'); assert.equal(listFailure.notes?.subagent?.['unreadable files'], 1);
  const statFailure = codex.read({ ...query, budget: { remaining: 10000 } }, { ...fs, stat: file => { if (file.endsWith('child.jsonl')) throw Error('private'); return fs.stat(file); } });
  assert.equal(statFailure.rows[0]?.role, 'host'); assert.equal(statFailure.notes?.subagent?.['unreadable files'], 1);
});
test('codex repeated compressed overflows exhaust the shared decode budget', () => {
  const host = rollout('00-01', 'host'); const text = lines(context, event(1)); const files: Record<string, string> = { [host]: text };
  for (let i = 2; i <= 4; i++) files[rollout(`00-0${i}`, `child-${i}`, true)] = 'x';
  const fs = memoryFs(files); const result = codex.read({ ...query, budget: { remaining: Buffer.byteLength(text) + 2 * MAX_FILE_BYTES } }, { ...fs, decompress: () => { throw Object.assign(Error('large'), { code: 'ERR_BUFFER_TOO_LARGE' }); } });
  assert.equal(result.rows.length, 1); assert.equal(result.notes?.subagent?.['unverified candidates'], 2); assert.equal(result.notes?.subagent?.['read budget reached'], 1); assert.equal(fs.reads.length, 3);
});
test('codex does not count resumed child usage after unreadable or oversized history', () => {
  const host = rollout('00-01', 'host'); const prior = rollout('00-02', 'child'); const live = rollout('00-03', 'child');
  const fs = memoryFs({ [host]: lines(context, event(1)), [prior]: lines(meta('host'), context, event(7, 1000)), [live]: lines(meta('host'), context, event(7, 3000)) }, { [prior]: 1000 });
  for (const failure of ['read', 'size']) {
    const result = codex.read({ ...query, startMs: 2000, budget: { remaining: 256 * 1024 * 1024 } }, {
      ...fs,
      stat: file => failure === 'size' && file.includes('00-00-02-child.jsonl') ? { size: MAX_FILE_BYTES + 1, mtimeMs: 1000 } : fs.stat(file),
      read: (file, max) => { if (failure === 'read' && file.includes('00-00-02-child.jsonl')) throw Error('private'); return fs.read(file, max); },
    });
    assert.equal(result.rows.filter(row => row.role === 'subagent').length, 0);
    assert.equal(result.notes?.subagent?.[failure === 'read' ? 'unreadable files' : 'unverified candidates'], 1);
  }
});
test('codex keeps earlier child rows but stops that thread after later read failure', () => {
  const host = rollout('00-01', 'host'); const first = rollout('00-02', 'child'); const failed = rollout('00-03', 'child'); const last = rollout('00-04', 'child');
  const fs = memoryFs({ [host]: lines(context, event(1)), [first]: lines(meta('host'), context, event(7)), [failed]: 'x', [last]: lines(meta('host'), context, event(8)) });
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, { ...fs, read: (file, max) => { if (file.includes('00-00-03-child.jsonl')) throw Error('private'); return fs.read(file, max); } });
  assert.equal(result.rows.filter(row => row.role === 'subagent').length, 1); assert.equal(result.notes?.subagent?.['unreadable files'], 1); assert.ok(!fs.reads.some(file => file.includes('00-00-04-child.jsonl')));
});
test('codex discovery stat failure blocks newer same-thread totals while retaining earlier rows', () => {
  const host1 = rollout('00-01', 'host'); const host2 = rollout('00-02', 'host'); const host3 = rollout('00-03', 'host');
  const child1 = rollout('00-04', 'child'); const child2 = rollout('00-05', 'child'); const child3 = rollout('00-06', 'child');
  const fs = memoryFs({ [host1]: lines(context, event(1)), [host2]: lines(context, event(7, 1000)), [host3]: lines(context, event(7, 3000)), [child1]: lines(meta('host'), context, event(2)), [child2]: lines(meta('host'), context, event(8, 1000)), [child3]: lines(meta('host'), context, event(8, 3000)) });
  const result = codex.read({ ...query, budget: { remaining: 100000 } }, { ...fs, stat: file => { if (file.includes('00-00-02-host.jsonl') || file.includes('00-00-05-child.jsonl')) throw Object.assign(Error('private'), { code: 'EACCES' }); return fs.stat(file); } });
  assert.equal(result.unavailable, 'read-error:EACCES'); assert.equal(result.notes?.subagent?.['unreadable files'], 1); assert.equal(result.rows.filter(row => row.role === 'host').length, 1); assert.equal(result.rows.filter(row => row.role === 'subagent').length, 1);
});
test('codex notes a vanished older child before skipping the resumed thread', () => {
  const host = rollout('00-01', 'host'); const prior = rollout('00-02', 'child'); const live = rollout('00-03', 'child');
  const fs = memoryFs({ [host]: lines(context, event(1)), [prior]: lines(meta('host'), context, event(7, 1000)), [live]: lines(meta('host'), context, event(7, 3000)) }); let priorStats = 0;
  const result = codex.read({ ...query, startMs: 2000, budget: { remaining: 10000 } }, { ...fs, stat: file => file.includes('00-00-02-child.jsonl') && ++priorStats > 1 ? null : fs.stat(file) });
  assert.equal(result.rows.filter(row => row.role === 'subagent').length, 0); assert.equal(result.notes?.subagent?.['unreadable files'], 1);
});
test('codex with inaccessible host-search directory avoids uncertain attribution', () => {
  const host = rollout('00-01', 'host'); const hidden = '/home/.codex/sessions/1969/12/31/rollout-1969-12-31T00-00-01-other.jsonl'; const fs = memoryFs({ [host]: lines(context, event(1)), [hidden]: 'x' });
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, { ...fs, list: dir => { if (/1969[\\/]12[\\/]31$/.test(dir)) throw Object.assign(Error('private'), { code: 'EACCES' }); return fs.list(dir); } });
  assert.equal(result.unavailable, 'read-error:EACCES'); assert.deepEqual(result.rows, []); assert.deepEqual(fs.reads, []);
});
test('codex omits a readable child when another date directory cannot be searched', () => {
  const host = rollout('00-01', 'host'); const child = rollout('00-02', 'child'); const hidden = '/home/.codex/sessions/1970/01/02/rollout-1970-01-02T00-00-01-other.jsonl';
  const fs = memoryFs({ [host]: lines(context, event(1)), [child]: lines(meta('host'), context, event(2)), [hidden]: 'x' }); let dateLists = 0;
  const result = codex.read({ ...query, budget: { remaining: 10000 } }, { ...fs, list: dir => { if (/1970[\\/]01[\\/]02$/.test(dir) && ++dateLists === 2) throw Error('private'); return fs.list(dir); } });
  assert.equal(result.rows.filter(row => row.role === 'host').length, 1); assert.equal(result.rows.filter(row => row.role === 'subagent').length, 0); assert.equal(result.notes?.subagent?.['unreadable files'], 1);
});
test('codex reports and blocks listed host and child files that vanish before discovery stat', () => {
  const host1 = rollout('00-01', 'host'); const host2 = rollout('00-02', 'host'); const host3 = rollout('00-03', 'host'); const child1 = rollout('00-04', 'child'); const child2 = rollout('00-05', 'child'); const child3 = rollout('00-06', 'child');
  const fs = memoryFs({ [host1]: lines(context, event(1)), [host2]: lines(context, event(7, 1000)), [host3]: lines(context, event(7, 3000)), [child1]: lines(meta('host'), context, event(2)), [child2]: lines(meta('host'), context, event(8, 1000)), [child3]: lines(meta('host'), context, event(8, 3000)) });
  const result = codex.read({ ...query, budget: { remaining: 100000 } }, { ...fs, stat: file => file.includes('00-00-02-host.jsonl') || file.includes('00-00-05-child.jsonl') ? null : fs.stat(file) });
  assert.equal(result.unavailable, 'read-error:ENOENT'); assert.equal(result.notes?.subagent?.['unreadable files'], 1); assert.equal(result.rows.filter(row => row.role === 'host').length, 1); assert.equal(result.rows.filter(row => row.role === 'subagent').length, 1);

  let calls = 0;
  const singleHost = memoryFs({ [rollout('00-01', 'host')]: lines(context, event(1)) });
  const vanishRead = codex.read({ ...query, budget: { remaining: 10000 } }, { ...singleHost, stat: file => file.endsWith('host.jsonl') && ++calls === 2 ? null : singleHost.stat(file) });
  assert.equal(vanishRead.unavailable, 'read-error:ENOENT'); assert.deepEqual(vanishRead.rows, []);
});
