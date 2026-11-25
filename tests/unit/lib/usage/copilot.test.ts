import assert from 'node:assert/strict';
import test from 'node:test';
import { readHostUsage } from '../../../../skills/dispatch/scripts/lib/usage/index.ts';
import { collectCopilotUsage } from '../../../../skills/dispatch/scripts/lib/usage/copilot.ts';
import { MAX_FILE_BYTES } from '../../../../skills/dispatch/scripts/lib/usage/read.ts';
import { lines, memoryFs, query } from './helpers/memory-fs.ts';

test('Copilot receipts preserve canonical counters and verified or unknown lineage', () => {
  const usage = {
    accounting: { sourceSessionId: 'accounting', sequence: 1, usageId: 'receipt' },
    model: 'custom/model',
    reasoningEffort: 'high',
    inputTokens: 100,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    copilotUsage: { totalNanoAiu: 200 },
    aiCreditsStatus: 'complete',
    cost: 2,
  };
  const fs = memoryFs({
    '/home/.copilot/session-state/host/events.jsonl': lines(
      { type: 'subagent.started', agentId: 'child', parentId: 'unrelated-envelope', data: { toolCallId: 'task-1' } },
      { type: 'subagent.started', agentId: 'nested', data: { toolCallId: 'task-2', parentId: 'child' } },
      {
        type: 'session.usage_record',
        timestamp: new Date(500).toISOString(),
        agentId: 'child',
        data: { usage: { ...usage, accounting: { ...usage.accounting, usageId: 'direct', sequence: 0 } } },
      },
      { type: 'session.usage_record', timestamp: new Date(1000).toISOString(), agentId: 'nested', data: { usage } },
      {
        type: 'session.usage_record',
        timestamp: new Date(1500).toISOString(),
        agentId: 'orphan',
        data: {
          usage: {
            ...usage,
            accounting: { ...usage.accounting, usageId: 'orphan', sequence: 2 },
            reasoningEffort: undefined,
          },
        },
      },
    ),
  });
  const result = readHostUsage(
    'copilot',
    { ...query, env: (name) => (name === 'COPILOT_AGENT_SESSION_ID' ? 'host' : undefined) },
    fs,
  );
  assert.equal(result.rows.length, 3);
  assert.deepEqual(
    result.rows.map((r) => [r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning]),
    [
      [50, 20, 40, 10, 5],
      [50, 20, 40, 10, 5],
      [50, 20, 40, 10, 5],
    ],
  );
  assert.deepEqual(
    result.rows.filter((r) => r.effort === 'high').map((r) => r.maxDepth),
    [1, 2],
  );
  assert.equal(
    result.rows[0]!.input + result.rows[0]!.cacheRead! + result.rows[0]!.cacheWrite! + result.rows[0]!.output,
    120,
  );
  assert.equal(result.rows.find((r) => r.effort === null)?.maxDepth, undefined);
  assert.ok(!JSON.stringify(result).includes('accounting'));
});

const receipt = (sequence: number, over: Record<string, unknown> = {}, actor?: string) => ({
  type: 'session.usage_record',
  timestamp: new Date(1000 + sequence).toISOString(),
  ...(actor ? { agentId: actor } : {}),
  data: {
    usage: {
      accounting: { sourceSessionId: 'accounting', usageId: `receipt-${sequence}`, sequence },
      model: 'custom/model',
      inputTokens: 100,
      outputTokens: 30,
      ...over,
    },
  },
});

test('Copilot rejects corrupt receipts but retains measured partial tokens and billing', () => {
  const event = receipt(1, { copilotUsage: { totalNanoAiu: 0 }, aiCreditsStatus: 'pending', cost: 3 });
  const result = collectCopilotUsage(
    { ...query, collectResponses: true },
    memoryFs({
      '/home/.copilot/session-state/host/events.jsonl':
        lines(
          event,
          event,
          receipt(2, { cacheReadTokens: 90, cacheWriteTokens: 20 }),
          receipt(3, { reasoningTokens: 40 }),
          receipt(4, { inputTokens: -1 }),
          receipt(5),
          receipt(5, { inputTokens: 101 }),
        ) + '\n{broken',
    }),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.input, 100);
  assert.equal(result.rows[0]?.copilot?.billing.coverage, 'partial');
  assert.equal(result.rows[0]?.copilot?.billing.totalNanoAiu, 0);
  assert.equal(result.rows[0]?.copilot?.tokenCoverage, 'partial');
  assert.ok(result.notes?.host?.['unparsed lines']);
  assert.ok(result.notes?.host?.['unverified candidates']);
});

test('Copilot orphan, cyclic and conflicting links never become root work', () => {
  const start = (actor: string, task: string, parent: string) => ({
    type: 'subagent.started',
    agentId: actor,
    data: { toolCallId: task, parentId: parent },
  });
  const result = collectCopilotUsage(
    query,
    memoryFs({
      '/home/.copilot/session-state/host/events.jsonl': lines(
        start('a', 'ta', 'b'),
        start('b', 'tb', 'a'),
        start('orphan', 'to', 'absent'),
        start('conflict', 'tc', 'a'),
        start('conflict', 'tc', 'b'),
        receipt(1, {}, 'a'),
        receipt(2, {}, 'orphan'),
        receipt(3, {}, 'conflict'),
      ),
    }),
  );
  assert.equal(result.rows.length, 3);
  assert.ok(
    result.rows.every(
      (r) => r.role === 'subagent' && r.depth === undefined && r.copilot?.lineageCoverage === 'unknown',
    ),
  );
  assert.ok(result.rows.every((r) => r.copilot?.tokenCoverage === 'complete'));
});

test('Copilot bounded storage failures avoid reads and never enumerate sessions', () => {
  const fs = memoryFs({});
  fs.list = () => {
    throw new Error('must not enumerate');
  };
  assert.equal(collectCopilotUsage(query, fs).unavailable, 'host id file missing');
  fs.stat = () => ({ size: MAX_FILE_BYTES + 1, mtimeMs: 0 });
  assert.equal(
    collectCopilotUsage({ ...query, budget: { remaining: MAX_FILE_BYTES * 2 } }, fs).unavailable,
    'transcript over size cap',
  );
  fs.stat = () => ({ size: 2, mtimeMs: 0 });
  assert.equal(collectCopilotUsage({ ...query, budget: { remaining: 1 } }, fs).notes?.host?.['read budget reached'], 1);
  assert.deepEqual(fs.reads, []);
});

test('Copilot live copies and root spawning tasks preserve mixed configuration', () => {
  const root = receipt(
    1,
    { reasoningEffort: 'low', copilotUsage: { totalNanoAiu: 0 }, cost: 0, aiCreditsStatus: 'complete' },
    'child',
  );
  const live = {
    type: 'assistant.usage',
    agentId: root.agentId,
    timestamp: new Date(3000).toISOString(),
    data: root.data.usage,
  };
  const result = collectCopilotUsage(
    query,
    memoryFs({
      '/home/.copilot/session-state/host/events.jsonl': lines(
        { type: 'subagent.started', agentId: 'child', parentId: 'irrelevant-envelope', data: { toolCallId: 'task' } },
        root,
        live,
        receipt(
          2,
          {
            model: 'other/model',
            reasoningEffort: 'max',
            copilotUsage: { totalNanoAiu: -1 },
            cost: 2,
            aiCreditsStatus: 'complete',
          },
          'child',
        ),
      ),
    }),
  );
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((r) => [r.model, r.effort, r.depth]),
    [
      ['custom/model', 'low', 1],
      ['other/model', 'max', 1],
    ],
  );
  assert.equal(result.rows[0]?.copilot?.billing.coverage, 'complete');
  assert.equal(result.rows[1]?.copilot?.billing.coverage, 'unknown');
  assert.equal(result.rows[1]?.copilot?.billing.totalNanoAiu, undefined);
  assert.equal(result.notes, undefined);
});

test('Copilot opaque nested accounting receipts preserve exact bounded dedupe identity', () => {
  const usageId = 'Ab+/'.repeat(128) + 'AA==';
  const first = receipt(1, { accounting: { sourceSessionId: 'source', sequence: 1, usageId } });
  const replay = { ...first, timestamp: new Date(9000).toISOString() };
  const invalid = receipt(2, { accounting: { sourceSessionId: 'source', sequence: 2, usageId: 'A'.repeat(1025) } });
  const result = collectCopilotUsage(
    query,
    memoryFs({ '/home/.copilot/session-state/host/events.jsonl': lines(first, replay, invalid) }),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.input, 100);
  assert.equal(result.rows[0]?.atMs, 1001);
  assert.doesNotMatch(JSON.stringify(result), /Ab\+\//);
  const resumed = collectCopilotUsage(
    { ...query, startMs: 8000 },
    memoryFs({ '/home/.copilot/session-state/host/events.jsonl': lines(first, replay) }),
  );
  assert.equal(resumed.rows.length, 0);
});

test('Copilot conflicting sequences for one source receipt remain unmeasured', () => {
  const accounted = (timestampSequence: number, sequence: number, usageId: string) =>
    receipt(timestampSequence, {
      accounting: { sourceSessionId: 'source', sequence, usageId },
      copilotUsage: { totalNanoAiu: 50 },
      aiCreditsStatus: 'complete',
      cost: 2,
    });
  const result = collectCopilotUsage(
    query,
    memoryFs({
      '/home/.copilot/session-state/host/events.jsonl': lines(
        accounted(1, 1, 'reused'),
        accounted(2, 2, 'reused'),
        accounted(3, 3, 'unrelated'),
      ),
    }),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.input, 100);
  assert.equal(result.rows[0]?.output, 30);
  assert.equal(result.rows[0]?.copilot?.tokenCoverage, 'partial');
  assert.equal(result.rows[0]?.copilot?.billing.coverage, 'partial');
  assert.ok(result.notes?.host?.['unverified candidates']);
});

test('Copilot conflicting usage IDs for one source sequence remain unmeasured', () => {
  const accounted = (timestampSequence: number, sequence: number, usageId: string) =>
    receipt(timestampSequence, {
      accounting: { sourceSessionId: 'source', sequence, usageId },
      copilotUsage: { totalNanoAiu: 50 },
      aiCreditsStatus: 'complete',
      cost: 2,
    });
  const result = collectCopilotUsage(
    query,
    memoryFs({
      '/home/.copilot/session-state/host/events.jsonl': lines(
        accounted(1, 1, 'first'),
        accounted(2, 1, 'second'),
        accounted(3, 3, 'unrelated'),
      ),
    }),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.input, 100);
  assert.equal(result.rows[0]?.output, 30);
  assert.equal(result.rows[0]?.copilot?.tokenCoverage, 'partial');
  assert.equal(result.rows[0]?.copilot?.billing.coverage, 'partial');
  assert.ok(result.notes?.host?.['unverified candidates']);
});

test('Copilot malformed envelope actors retain unnamed partial subagent usage', () => {
  const root = receipt(1);
  const malformedNumber = { ...receipt(2), agentId: 424242 };
  const malformedString = { ...receipt(3), agentId: 'bad actor' };
  const transcript = lines(root, malformedNumber, malformedString);
  const file = '/home/.copilot/session-state/host/events.jsonl';
  const result = collectCopilotUsage(query, memoryFs({ [file]: transcript }));
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0]?.role, 'host');
  assert.equal(result.rows[0]?.responseActor, 'host');
  const unnamed = result.rows.slice(1);
  assert.ok(unnamed.every((row) => row.role === 'subagent' && row.input === 100 && row.output === 30));
  assert.ok(
    unnamed.every((row) => row.depth === undefined && row.responseActor === undefined && row.parentActor === undefined),
  );
  assert.ok(
    unnamed.every((row) => row.copilot?.actorCoverage === 'unknown' && row.copilot?.lineageCoverage === 'unknown'),
  );
  assert.equal(result.notes?.subagent?.['unverified candidates'], 2);
  assert.doesNotMatch(JSON.stringify(result), /424242|bad actor/);

  const facts = readHostUsage(
    'copilot',
    {
      ...query,
      env: (name) => (name === 'COPILOT_AGENT_SESSION_ID' ? 'host' : undefined),
    },
    memoryFs({ [file]: transcript }),
  );
  const unnamedFact = facts.rows.find((row) => row.role === 'subagent');
  assert.ok(unnamedFact);
  assert.equal(unnamedFact.input, 200);
  assert.equal(unnamedFact.output, 60);
  assert.equal(unnamedFact.agent, undefined);
  assert.equal(unnamedFact.parent, undefined);
  assert.equal(unnamedFact.maxDepth, undefined);
  assert.equal(unnamedFact.copilot?.actorCoverage, 'partial');
  assert.equal(unnamedFact.copilot?.lineageCoverage, 'unknown');
  assert.doesNotMatch(JSON.stringify(facts), /424242|bad actor/);
});

test('Copilot nesting resolves registry actors rather than tool-call or chronology identities', () => {
  const result = collectCopilotUsage(
    query,
    memoryFs({
      '/home/.copilot/session-state/host/events.jsonl': lines(
        { type: 'subagent.started', agentId: 'parent', data: { toolCallId: 'parent-tool-call' } },
        { type: 'subagent.started', agentId: 'parent', data: { toolCallId: 'different-tool-call' } },
        {
          type: 'subagent.started',
          agentId: 'child',
          parentId: 'chronology-only',
          data: { toolCallId: 'child-tool-call', parentId: 'parent' },
        },
        {
          type: 'subagent.started',
          agentId: 'unproved',
          data: { toolCallId: 'unproved-tool-call', parentId: 'parent-tool-call' },
        },
        receipt(1, {}, 'child'),
        receipt(2, {}, 'unproved'),
      ),
    }),
  );
  assert.equal(result.rows[0]?.depth, 2);
  assert.equal(result.rows[0]?.parentActor, 'parent');
  assert.equal(result.rows[1]?.depth, undefined);
  assert.equal(result.rows[1]?.role, 'subagent');
  assert.equal(result.rows[1]?.effort, null);
});
