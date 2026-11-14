import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHostUsage } from '../../../../skills/dispatch/scripts/lib/usage/index.ts';
import { opencodeDbPath, type OpencodeMessage, type OpencodeRead, type OpencodeReadOptions } from '../../../../skills/dispatch/scripts/lib/opencode-db.ts';
import type { HostUsageFs } from '../../../../skills/dispatch/scripts/lib/usage/rows.ts';
import { memoryFs, query } from './helpers/memory-fs.ts';

const session = (name: string): string | undefined => name === 'OPENCODE_SESSION_ID' ? 'ses_host-1' : undefined;
const input = { ...query, env: session };
const empty: OpencodeRead = { messages: [], skipped: 0, truncated: null };
const port = (read: (db: string, id: string, options: OpencodeReadOptions) => OpencodeRead): HostUsageFs =>
  ({ ...memoryFs({}), opencodeMessages: read });
const message = (depth: number, createdMs: number, model: string | null, effort: string | null, input: number, output: number, extra: Partial<OpencodeMessage> = {}): OpencodeMessage =>
  ({ depth, createdMs, model, effort, input, output, ...extra });

test('opencode host usage keeps each message model and effort for host and nested subagent rows', () => {
  let seen: { db: string; id: string; options: OpencodeReadOptions } | undefined;
  const result = readHostUsage('opencode', {
    ...input,
    startMs: 2000,
    endMs: 5000,
    stages: [{ stage: 'spec', atMs: 0 }, { stage: 'plan', atMs: 3000 }],
  }, port((db, id, options) => {
    seen = { db, id, options };
    return {
      messages: [
        message(0, 2500, 'opencode-go/deepseek-v4.1-flash', 'max', 10, 5, { cacheRead: 2, cacheWrite: 1, reasoning: 3 }),
        message(0, 3000, 'lmstudio/qwen3.8-27b@iq4_xs', 'high', 7, 4),
        message(1, 3500, 'anthropic/claude-opus', null, 20, 8),
        message(2, 4000, 'openai/gpt-5', 'low', 3, 1, { cacheRead: 0 }),
        message(0, 4500, null, null, 1, 2),
      ],
      skipped: 0,
      truncated: null,
    };
  }));

  assert.deepEqual(seen, { db: opencodeDbPath('/home', session), id: 'ses_host-1', options: { fromMs: 2000, toMs: 5000 } });
  assert.equal(result.unavailable, undefined);
  assert.deepEqual(result.rows, [
    { stage: 'spec', role: 'host', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, bands: { le100k: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 } }, reasoningInOutput: false },
    { stage: 'plan', role: 'host', model: '', effort: null, input: 1, output: 2, bands: { le100k: { input: 1, output: 2 } }, reasoningInOutput: false },
    { stage: 'plan', role: 'host', model: 'lmstudio/qwen3.8-27b@iq4_xs', effort: 'high', input: 7, output: 4, bands: { le100k: { input: 7, output: 4 } }, reasoningInOutput: false },
    { stage: 'plan', role: 'subagent', model: 'anthropic/claude-opus', effort: null, input: 20, output: 8, bands: { le100k: { input: 20, output: 8 } }, reasoningInOutput: false },
    { stage: 'plan', role: 'subagent', model: 'openai/gpt-5', effort: 'low', input: 3, output: 1, cacheRead: 0, bands: { le100k: { input: 3, output: 1, cacheRead: 0 } }, reasoningInOutput: false },
  ]);
  assert.ok(!JSON.stringify(result).includes('ses_'));
  assert.ok(!JSON.stringify(result).includes(opencodeDbPath('/home', session)));
});

test('opencode host usage notes skipped messages and a row cap', () => {
  const result = readHostUsage('opencode', input, port(() => ({
    messages: [message(0, 1000, 'm', null, 1, 1)],
    skipped: 2,
    truncated: 'rows',
  })));

  assert.equal(result.unavailable, undefined);
  assert.equal(result.notes?.host?.['unparsed lines'], 2);
  assert.equal(result.notes?.host?.['read budget reached'], 1);
});

test('opencode host usage notes a session cap as too many candidates', () => {
  const result = readHostUsage('opencode', input, port(() => ({
    messages: [message(0, 1000, 'm', null, 1, 1)],
    skipped: 0,
    truncated: 'sessions',
  })));

  assert.equal(result.notes?.subagent?.['too many candidates'], 1);
  assert.equal(result.notes?.host, undefined);
});

test('opencode host usage maps read failures to allowlisted reasons without leaking locators', () => {
  const failure = Object.assign(new Error('cannot open /home/me/.local/share/opencode/opencode.db for ses_host-1'), { code: 'ENOENT' });
  const missing = readHostUsage('opencode', input, port(() => { throw failure; }));
  assert.deepEqual(missing, { platform: 'opencode', rows: [], unavailable: 'read-error:ENOENT' });
  assert.ok(!JSON.stringify(missing).includes('ses_'));
  assert.ok(!JSON.stringify(missing).includes('/home'));

  const unknown = readHostUsage('opencode', input, port(() => { throw Object.assign(new Error('private detail'), { code: 'PRIVATE' }); }));
  assert.equal(unknown.unavailable, 'read-error:EUNKNOWN');
  assert.ok(!JSON.stringify(unknown).includes('private detail'));
  assert.equal(readHostUsage('opencode', input, memoryFs({})).unavailable, 'read-error:EUNKNOWN');
});

test('opencode host usage reports no records only when no valid message remains', () => {
  const emptyRead = readHostUsage('opencode', input, port(() => empty));
  assert.equal(emptyRead.unavailable, 'no usage records');
  assert.deepEqual(emptyRead.rows, []);

  const skippedRead = readHostUsage('opencode', input, port(() => ({ ...empty, skipped: 2 })));
  assert.equal(skippedRead.unavailable, 'no usage records');
  assert.equal(skippedRead.notes?.host?.['unparsed lines'], 2);

  const childOnly = readHostUsage('opencode', input, port(() => ({
    messages: [message(1, 3000, 'm', 'high', 4, 2)],
    skipped: 0,
    truncated: null,
  })));
  assert.equal(childOnly.unavailable, undefined);
  assert.deepEqual(childOnly.rows, [{ stage: 'plan', role: 'subagent', model: 'm', effort: 'high', input: 4, output: 2, bands: { le100k: { input: 4, output: 2 } }, reasoningInOutput: false }]);
});

test('opencode usage row fields carry time, depth and reasoning semantics', async () => {
  const { opencode } = await import('../../../../skills/dispatch/scripts/lib/usage/opencode.ts');
  const result = opencode.read({ ...input, sessionId: 'ses_host-1', budget: { remaining: 10000 } }, port(() => ({
    messages: [
      message(0, 2500, 'm0', null, 10, 5),
      message(2, 4000, 'm2', 'high', 3, 1),
    ],
    skipped: 0,
    truncated: null,
  })));
  assert.deepEqual(
    result.rows.map(r => ({ role: r.role, atMs: r.atMs, depth: r.depth, reasoningInOutput: r.reasoningInOutput })),
    [
      { role: 'host', atMs: 2500, depth: 0, reasoningInOutput: false },
      { role: 'subagent', atMs: 4000, depth: 2, reasoningInOutput: false },
    ],
  );
});
