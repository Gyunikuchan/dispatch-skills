import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCode } from '../../../../skills/dispatch/scripts/toolkit/host-usage/claude-code.ts';
import { lines, memoryFs, query } from './helpers/memory-fs.ts';

test('claude counts the last in-window message once by stage and excludes synthetic usage', () => {
  const message = (id: string, at: number, input: number, model = 'opus') => ({
    type: 'assistant', timestamp: new Date(at).toISOString(), effort: 'high',
    message: { id, model, usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 3 }, text: 'secret transcript' },
  });
  const result = claudeCode.read({ ...query, startMs: 2000, budget: { remaining: 100000 } }, memoryFs({
    '/home/.claude/projects/p/host.jsonl': lines(message('a', 1000, 1), message('a', 3000, 5), message('synthetic', 3000, 100, '<synthetic>'), message('late', 20000, 100)),
    '/home/.claude/projects/p/host/subagents/agent-1.jsonl': lines(message('b', 2500, 7)),
  }));
  assert.deepEqual(result.rows, [
    { stage: 'plan', role: 'host', model: 'opus', effort: 'high', input: 5, output: 2, cacheRead: 3 },
    { stage: 'plan', role: 'subagent', model: 'opus', effort: 'high', input: 7, output: 2, cacheRead: 3 },
  ]);
  assert.ok(!JSON.stringify(result).includes('secret transcript'));
});

test('claude selects only the current transcript and its children', () => {
  const msg = (id: string, input: number) => ({ type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id, model: 'm', usage: { input_tokens: input, output_tokens: 1 } } });
  const older = '/home/.claude/projects/old/host.jsonl'; const newer = '/home/.claude/projects/new/host.jsonl';
  const fs = memoryFs({
    [older]: lines(msg('old', 1)), [newer]: lines(msg('new', 2)),
    '/home/.claude/projects/old/host/subagents/agent-old.jsonl': lines(msg('old-child', 4)),
    '/home/.claude/projects/new/host/subagents/agent-new.jsonl': lines(msg('new-child', 8)),
  }, { [older]: 100, [newer]: 200 });
  const result = claudeCode.read({ ...query, budget: { remaining: 100000 } }, fs);
  assert.deepEqual(result.rows.map(row => row.input), [2, 8]);
  assert.equal(fs.reads.length, 2);
  assert.ok(fs.reads.every(file => !file.includes('old')));

  const unrelated = memoryFs({ '/home/.claude/projects/p/other.jsonl': 'private', '/home/.claude/projects/p/other/subagents/agent-1.jsonl': 'private' });
  assert.equal(claudeCode.read({ ...query, sessionId: 'missing', budget: { remaining: 1000 } }, unrelated).unavailable, 'host id file missing');
  assert.deepEqual(unrelated.reads, []);
});

test('claude hides host read errors and retains child counters', () => {
  const host = '/home/.claude/projects/p/host.jsonl'; const child = '/home/.claude/projects/p/host/subagents/agent-1.jsonl';
  const message = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'a', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } };
  const fs = memoryFs({ [host]: 'x', [child]: lines(message) });
  for (const [code, expected] of [['EACCES', 'read-error:EACCES'], ['PRIVATE', 'read-error:EUNKNOWN']]) {
    const result = claudeCode.read({ ...query, budget: { remaining: 10000 } }, {
      ...fs,
      read: (file, max) => { if (file.endsWith('host.jsonl')) throw Object.assign(new Error('private sentinel'), { code }); return fs.read(file, max); },
    });
    assert.equal(result.unavailable, expected);
    assert.equal(result.rows[0]?.role, 'subagent');
    assert.ok(!JSON.stringify(result).includes('private sentinel'));
  }
});

test('claude ignores unrelated records, rejects malformed usage, and keeps valid children', () => {
  const host = '/home/.claude/projects/p/host.jsonl';
  const good = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'retry', model: 'm', usage: { input_tokens: 6, output_tokens: 1 } } };
  const malformedUsage = { ...good, message: { ...good.message, usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: -1 } } };
  const missingModel = { ...good, message: { ...good.message, id: 'missing-model', model: null } };
  const missingTime = { ...good, timestamp: 'invalid', message: { ...good.message, id: 'missing-time' } };
  const fs = memoryFs({ [host]: lines(null, 5, { type: 'user' }, malformedUsage, missingModel, missingTime, good) });
  const result = claudeCode.read({ ...query, budget: { remaining: 10000 } }, fs);
  assert.equal(result.rows[0]?.input, 6);
  assert.equal(result.notes?.host?.['unparsed lines'], 3);
  assert.equal(result.unavailable, undefined);

  const child = '/home/.claude/projects/p/host/subagents/agent-1.jsonl';
  const childMessage = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'child', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } };
  const partial = claudeCode.read({ ...query, budget: { remaining: 10000 } }, memoryFs({ [host]: '{bad\n', [child]: lines(childMessage) }));
  assert.equal(partial.unavailable, 'no usage records');
  assert.equal(partial.notes?.host?.['unparsed lines'], 1);
  assert.equal(partial.rows[0]?.role, 'subagent');
});

test('claude honors its config root and skips stale child files', () => {
  const host = '/custom/projects/p/host.jsonl'; const child = '/custom/projects/p/host/subagents/agent-stale.jsonl';
  const message = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'x', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } };
  const fs = memoryFs({ [host]: lines(message), [child]: lines(message) }, { [child]: 1000 });
  const result = claudeCode.read({ ...query, startMs: 2000, env: name => name === 'CLAUDE_CONFIG_DIR' ? '/custom' : undefined, budget: { remaining: 10000 } }, fs);
  assert.deepEqual(result.rows.map(row => row.role), ['host']);
  assert.equal(fs.reads.length, 1);
  assert.ok(!fs.reads.some(file => file.includes('agent-stale')));
});

test('claude retains host rows and notes child size and exhausted-budget stops', () => {
  const host = '/home/.claude/projects/p/host.jsonl'; const child = '/home/.claude/projects/p/host/subagents/agent-1.jsonl';
  const message = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'a', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } };
  const text = lines(message);
  const oversizedFs = memoryFs({ [host]: text, [child]: 'x' });
  const oversized = claudeCode.read({ ...query, budget: { remaining: 256 * 1024 * 1024 } }, {
    ...oversizedFs,
    stat: file => file.endsWith('agent-1.jsonl') ? { size: 64 * 1024 * 1024 + 1, mtimeMs: 10000 } : oversizedFs.stat(file),
  });
  assert.equal(oversized.rows.length, 1);
  assert.equal(oversized.notes?.subagent?.['subagents over size cap'], 1);
  assert.equal(oversizedFs.reads.length, 1);

  const budgetFs = memoryFs({ [host]: text, [child]: text });
  const exhausted = claudeCode.read({ ...query, budget: { remaining: Buffer.byteLength(text) } }, budgetFs);
  assert.equal(exhausted.rows.length, 1);
  assert.equal(exhausted.notes?.subagent?.['read budget reached'], 1);
  assert.equal(budgetFs.reads.length, 1);

  const hostOversizedFs = memoryFs({ [host]: 'x', [child]: text });
  const hostOversized = claudeCode.read({ ...query, budget: { remaining: 256 * 1024 * 1024 } }, { ...hostOversizedFs, stat: file => file.endsWith('host.jsonl') ? { size: 64 * 1024 * 1024 + 1, mtimeMs: 10000 } : hostOversizedFs.stat(file) });
  assert.equal(hostOversized.unavailable, 'transcript over size cap'); assert.equal(hostOversized.rows[0]?.role, 'subagent');
});
test('claude preserves host counters when child listing or stat fails', () => {
  const host = '/home/.claude/projects/p/host.jsonl'; const child = '/home/.claude/projects/p/host/subagents/agent-1.jsonl'; const msg = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'x', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } }; const fs = memoryFs({ [host]: lines(msg), [child]: lines(msg) });
  const listFailure = claudeCode.read({ ...query, budget: { remaining: 10000 } }, { ...fs, list: dir => { if (dir.endsWith('subagents')) throw Error('private'); return fs.list(dir); } });
  assert.equal(listFailure.rows[0]?.role, 'host'); assert.equal(listFailure.notes?.subagent?.['unreadable files'], 1);
  const statFailure = claudeCode.read({ ...query, budget: { remaining: 10000 } }, { ...fs, stat: file => { if (file.endsWith('agent-1.jsonl')) throw Error('private'); return fs.stat(file); } });
  assert.equal(statFailure.rows[0]?.role, 'host'); assert.equal(statFailure.notes?.subagent?.['unreadable files'], 1);
});
test('claude refuses all attribution when a matching project cannot be inspected', () => {
  const host = '/home/.claude/projects/accessible/host.jsonl'; const inaccessible = '/home/.claude/projects/blocked/host.jsonl';
  const msg = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'x', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } }; const fs = memoryFs({ [host]: lines(msg), [inaccessible]: 'x' });
  const result = claudeCode.read({ ...query, budget: { remaining: 10000 } }, { ...fs, stat: file => { if (file.includes('blocked')) throw Object.assign(Error('private'), { code: 'EACCES' }); return fs.stat(file); } });
  assert.equal(result.unavailable, 'read-error:EACCES'); assert.deepEqual(result.rows, []); assert.deepEqual(fs.reads, []);
});
test('claude reports selected host and child files that vanish before read', () => {
  const host = '/home/.claude/projects/p/host.jsonl'; const child = '/home/.claude/projects/p/host/subagents/agent-1.jsonl';
  const msg = { type: 'assistant', timestamp: new Date(3000).toISOString(), message: { id: 'x', model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } }; const fs = memoryFs({ [host]: lines(msg), [child]: lines(msg) });
  for (const role of ['host', 'subagent']) { let calls = 0; const result = claudeCode.read({ ...query, budget: { remaining: 10000 } }, { ...fs, stat: file => { const selected = role === 'host' ? file.endsWith('host.jsonl') : file.endsWith('agent-1.jsonl'); return selected && ++calls === 2 ? null : fs.stat(file); } });
    if (role === 'host') assert.equal(result.unavailable, 'read-error:ENOENT'); else { assert.equal(result.notes?.subagent?.['unreadable files'], 1); assert.equal(result.rows[0]?.role, 'host'); }
  }

  const vanished = '/home/.claude/projects/p/host/subagents/agent-vanished.jsonl';
  const discoveryFs = memoryFs({ [host]: lines(msg), [vanished]: lines(msg), [child]: lines(msg) });
  const discoveryResult = claudeCode.read({ ...query, budget: { remaining: 10000 } }, { ...discoveryFs, stat: file => file.endsWith('agent-vanished.jsonl') ? null : discoveryFs.stat(file) });
  assert.equal(discoveryResult.notes?.subagent?.['unreadable files'], 1); assert.deepEqual(discoveryResult.rows.map(row => row.role), ['host', 'subagent']);
});
