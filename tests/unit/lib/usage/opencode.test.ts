import { opencode } from '../../../../skills/dispatch/scripts/lib/usage/opencode.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHostUsage } from '../../../../skills/dispatch/scripts/lib/usage/index.ts';
import { opencodeDbPath } from '../../../../skills/dispatch/scripts/lib/opencode-db.ts';
import type {
  OpencodeMessage,
  OpencodeRead,
  OpencodeReadOptions,
} from '../../../../skills/dispatch/scripts/lib/opencode-db.ts';
import type { HostUsageFs } from '../../../../skills/dispatch/scripts/lib/usage/rows.ts';
import { memoryFs, query } from './helpers/memory-fs.ts';

const session = (name: string): string | undefined => (name === 'OPENCODE_SESSION_ID' ? 'ses_host-1' : undefined);
const input = { ...query, env: session };
const empty: OpencodeRead = { messages: [], skipped: 0, truncated: null };
const port = (read: (db: string, id: string, options: OpencodeReadOptions) => OpencodeRead): HostUsageFs => ({
  ...memoryFs({}),
  opencodeMessages: read,
});
const message = (
  depth: number,
  createdMs: number,
  model: string | null,
  effort: string | null,
  input: number,
  output: number,
  extra: Partial<OpencodeMessage> = {},
): OpencodeMessage => ({ depth, createdMs, model, effort, input, output, ...extra });

test('turns: opencode host usage keeps each message model and effort for host and nested subagent rows', () => {
  let seen: { db: string; id: string; options: OpencodeReadOptions } | undefined;
  const result = readHostUsage(
    'opencode',
    {
      ...input,
      startMs: 2000,
      endMs: 5000,
      stages: [
        { stage: 'spec', atMs: 0 },
        { stage: 'plan', atMs: 3000 },
      ],
    },
    port((db, id, options) => {
      seen = { db, id, options };
      return {
        messages: [
          message(0, 2500, 'opencode-go/deepseek-v4.1-flash', 'max', 10, 5, {
            cacheRead: 2,
            cacheWrite: 1,
            reasoning: 3,
          }),
          message(0, 3000, 'lmstudio/qwen3.8-27b@iq4_xs', 'high', 7, 4),
          message(1, 3500, 'anthropic/claude-opus', null, 20, 8, { sessionId: 'ses_child-1' }),
          message(2, 4000, 'openai/gpt-5', 'low', 3, 1, { cacheRead: 0, sessionId: 'ses_child-2' }),
          message(0, 4500, null, null, 1, 2),
        ],
        skipped: 0,
        truncated: null,
      };
    }),
  );

  assert.deepEqual(seen, {
    db: opencodeDbPath('/home', session),
    id: 'ses_host-1',
    options: { fromMs: 2000, toMs: 5000, includeSessionIdentity: true },
  });
  assert.equal(result.unavailable, undefined);
  assert.deepEqual(result.rows, [
    {
      stage: 'spec',
      role: 'host',
      model: 'opencode-go/deepseek-v4.1-flash',
      turns: 1,
      effort: 'max',
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      reasoning: 3,
      bands: { le100k: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 } },
      reasoningInOutput: false,
    },
    {
      stage: 'plan',
      role: 'host',
      model: '',
      turns: 1,
      effort: null,
      input: 1,
      output: 2,
      bands: { le100k: { input: 1, output: 2 } },
      reasoningInOutput: false,
    },
    {
      stage: 'plan',
      role: 'host',
      model: 'lmstudio/qwen3.8-27b@iq4_xs',
      turns: 1,
      effort: 'high',
      input: 7,
      output: 4,
      bands: { le100k: { input: 7, output: 4 } },
      reasoningInOutput: false,
    },
    {
      stage: 'plan',
      role: 'subagent',
      model: 'anthropic/claude-opus',
      turns: 1,
      maxDepth: 1,
      effort: null,
      input: 20,
      output: 8,
      bands: { le100k: { input: 20, output: 8 } },
      reasoningInOutput: false,
    },
    {
      stage: 'plan',
      role: 'subagent',
      model: 'openai/gpt-5',
      turns: 1,
      maxDepth: 2,
      effort: 'low',
      input: 3,
      output: 1,
      cacheRead: 0,
      bands: { le100k: { input: 3, output: 1, cacheRead: 0 } },
      reasoningInOutput: false,
    },
  ]);
  assert.deepEqual(
    result.responses?.map((r) => [r.stage, r.agent, r.basis, r.coverage, r.observed, r.uncachedInput]),
    [
      ['spec', 'host-1', 'opencode-assistant-message', 'complete', 1, 10],
      ['plan', 'host-1', 'opencode-assistant-message', 'complete', 2, 8],
      ['plan', 'subagent-1', 'opencode-assistant-message', 'complete', 1, 20],
      ['plan', 'subagent-2', 'opencode-assistant-message', 'complete', 1, 3],
    ],
  );
  assert.ok(!JSON.stringify(result).includes('ses_'));
  assert.ok(!JSON.stringify(result).includes(opencodeDbPath('/home', session)));
});

test('opencode host usage notes skipped messages and row and session caps', () => {
  const rows = readHostUsage(
    'opencode',
    input,
    port(() => ({
      messages: [message(0, 1000, 'm', null, 1, 1)],
      skipped: 2,
      truncated: 'rows',
    })),
  );

  assert.equal(rows.unavailable, undefined);
  assert.equal(rows.notes?.host?.['unparsed lines'], 2);
  assert.equal(rows.notes?.host?.['read budget reached'], 1);
  assert.deepEqual(
    rows.responses?.map((r) => [r.role, r.coverage, r.observed]),
    [
      ['host', 'partial', 1],
      ['subagent', 'unknown', undefined],
    ],
  );

  const sessions = readHostUsage(
    'opencode',
    input,
    port(() => ({
      messages: [message(0, 1000, 'm', null, 1, 1)],
      skipped: 0,
      truncated: 'sessions',
    })),
  );

  assert.equal(sessions.notes?.subagent?.['too many candidates'], 1);
  assert.equal(sessions.notes?.host, undefined);
});

test('opencode host usage maps read failures to allowlisted reasons without leaking locators', () => {
  const failure = Object.assign(new Error('cannot open /home/me/.local/share/opencode/opencode.db for ses_host-1'), {
    code: 'ENOENT',
  });
  const missing = readHostUsage(
    'opencode',
    input,
    port(() => {
      throw failure;
    }),
  );
  assert.equal(missing.unavailable, 'read-error:ENOENT');
  assert.deepEqual(missing.responses, [
    { stage: 'unattributed', role: 'host', basis: 'opencode-assistant-message', coverage: 'unknown' },
  ]);
  assert.ok(!JSON.stringify(missing).includes('ses_'));
  assert.ok(!JSON.stringify(missing).includes('/home'));

  const unknown = readHostUsage(
    'opencode',
    input,
    port(() => {
      throw Object.assign(new Error('private detail'), { code: 'PRIVATE' });
    }),
  );
  assert.equal(unknown.unavailable, 'read-error:EUNKNOWN');
  assert.ok(!JSON.stringify(unknown).includes('private detail'));
  assert.equal(readHostUsage('opencode', input, memoryFs({})).unavailable, 'read-error:EUNKNOWN');
});

test('opencode host usage reports no records only when no valid message remains', () => {
  const emptyRead = readHostUsage(
    'opencode',
    input,
    port(() => empty),
  );
  assert.equal(emptyRead.unavailable, 'no usage records');
  assert.deepEqual(emptyRead.rows, []);

  const skippedRead = readHostUsage(
    'opencode',
    input,
    port(() => ({ ...empty, skipped: 2 })),
  );
  assert.equal(skippedRead.unavailable, 'no usage records');
  assert.equal(skippedRead.notes?.host?.['unparsed lines'], 2);

  const childOnly = readHostUsage(
    'opencode',
    input,
    port(() => ({
      messages: [message(1, 3000, 'm', 'high', 4, 2)],
      skipped: 0,
      truncated: null,
    })),
  );
  assert.equal(childOnly.unavailable, undefined);
  assert.deepEqual(childOnly.responses, [
    {
      stage: 'plan',
      role: 'subagent',
      basis: 'opencode-assistant-message',
      coverage: 'partial',
      observed: 1,
      uncachedInput: 4,
    },
  ]);
  assert.deepEqual(childOnly.rows, [
    {
      stage: 'plan',
      role: 'subagent',
      model: 'm',
      turns: 1,
      maxDepth: 1,
      effort: 'high',
      input: 4,
      output: 2,
      bands: { le100k: { input: 4, output: 2 } },
      reasoningInOutput: false,
    },
  ]);
});

test('opencode usage row fields carry time, depth and reasoning semantics', async () => {
  const result = opencode.read(
    { ...input, sessionId: 'ses_host-1', budget: { remaining: 10_000 } },
    port(() => ({
      messages: [message(0, 2500, 'm0', null, 10, 5), message(2, 4000, 'm2', 'high', 3, 1)],
      skipped: 0,
      truncated: null,
    })),
  );
  assert.deepEqual(
    result.rows.map((r) => ({ role: r.role, atMs: r.atMs, depth: r.depth, reasoningInOutput: r.reasoningInOutput })),
    [
      { role: 'host', atMs: 2500, depth: 0, reasoningInOutput: false },
      { role: 'subagent', atMs: 4000, depth: 2, reasoningInOutput: false },
    ],
  );
});

test('opencode extracts unified turns, user turns by stage, and tool calls when present', async () => {
  const result = opencode.read(
    {
      ...input,
      sessionId: 'ses_host-1',
      stages: [
        { stage: 'spec', atMs: 0 },
        { stage: 'plan', atMs: 3000 },
      ],
      budget: { remaining: 10_000 },
    },
    port(() => ({
      messages: [
        message(0, 1500, 'm0', null, 10, 5, { toolCalls: 2 }),
        message(1, 3500, 'm1', null, 20, 8, { toolCalls: 0 }),
      ],
      userMessageTimes: [1000, 3200, 3800],
      skipped: 0,
      truncated: null,
    })),
  );
  assert.equal(result.userTurns, 3);
  assert.deepEqual(result.userTurnsByStage, { spec: 1, plan: 2 });
  assert.deepEqual(
    result.rows.map((r) => [r.role, r.turns, r.toolCalls, r.toolTurns]),
    [
      ['host', 1, 2, 1],
      ['subagent', 1, 0, 0],
    ],
  );
});

test('opencode omits userTurns when userTurnsTruncated is true while preserving assistant turns', async () => {
  const result = opencode.read(
    { ...input, sessionId: 'ses_host-1', budget: { remaining: 10_000 } },
    port(() => ({
      messages: [message(0, 2500, 'm0', null, 10, 5)],
      userTurnsTruncated: true,
      skipped: 0,
      truncated: null,
    })),
  );
  assert.equal(result.userTurns, undefined);
  assert.equal(result.userTurnsByStage, undefined);
  assert.equal(result.notes?.host, undefined);
  assert.equal(result.rows[0]?.turns, 1);
  assert.equal(result.rows[0]?.toolCalls, undefined);
  assert.equal(result.rows[0]?.toolTurns, undefined);
});
