import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agy } from '../../../../skills/dispatch/scripts/lib/usage/agy.ts';
import { MAX_FILE_BYTES } from '../../../../skills/dispatch/scripts/lib/usage/read.ts';
import type { HostUsageFs } from '../../../../skills/dispatch/scripts/lib/usage/rows.ts';
import { lines, memoryFs, query } from './helpers/memory-fs.ts';

function encodeVarint(val: number | bigint): number[] {
  const bytes: number[] = [];
  let n = BigInt(val);
  while (n > 0x7fn) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n & 0x7fn));
  return bytes;
}

function encodeTag(fieldNum: number, wireType: number): number[] {
  return encodeVarint((fieldNum << 3) | wireType);
}

function encodeLengthDelimited(fieldNum: number, content: Uint8Array | number[] | string): number[] {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return [...encodeTag(fieldNum, 2), ...encodeVarint(buf.length), ...buf];
}

function buildGenMetadataBlob(options: {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  modelSlug?: string;
  displayName?: string;
  lastStepIndex?: number;
}): Uint8Array {
  const tag1Fields: number[] = [];
  const counters: number[] = [];
  if (options.input !== undefined) counters.push(...encodeTag(2, 0), ...encodeVarint(options.input));
  if (options.output !== undefined) counters.push(...encodeTag(3, 0), ...encodeVarint(options.output));
  if (options.cacheRead !== undefined) counters.push(...encodeTag(5, 0), ...encodeVarint(options.cacheRead));
  if (options.reasoning !== undefined) counters.push(...encodeTag(9, 0), ...encodeVarint(options.reasoning));
  if (counters.length > 0) tag1Fields.push(...encodeLengthDelimited(4, counters));
  if (options.modelSlug !== undefined) tag1Fields.push(...encodeLengthDelimited(19, options.modelSlug));
  if (options.lastStepIndex !== undefined) {
    const kv = [
      ...encodeLengthDelimited(1, 'last_step_index'),
      ...encodeLengthDelimited(2, String(options.lastStepIndex)),
    ];
    tag1Fields.push(...encodeLengthDelimited(20, kv));
  }
  if (options.displayName !== undefined) tag1Fields.push(...encodeLengthDelimited(21, options.displayName));
  return new Uint8Array(encodeLengthDelimited(1, tag1Fields));
}

function createAgyFs(
  files: Record<string, string | Buffer>,
  times: Record<string, number> = {},
  sqliteDbs: Record<string, readonly Uint8Array[] | (() => readonly Uint8Array[])> = {},
): HostUsageFs & { reads: string[] } {
  const base = memoryFs(files, times);
  return {
    ...base,
    sqliteGenMetadata: (file: string) => {
      const normalized = path.normalize(file);
      const entry = sqliteDbs[normalized] ?? sqliteDbs[file];
      if (typeof entry === 'function') return entry();
      return entry ?? null;
    },
  };
}

test('agy collects host and recursive subagent usage row fields with gen_metadata model effort and reasoning', () => {
  const hostId = 'host-session';
  const child1Id = 'child-1';
  const child2Id = 'child-2';
  const grandchildId = 'grandchild-1';

  const hostStep0 = {
    step_index: 2,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(1500).toISOString(),
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 20,
    tool_calls: [{ name: 'invoke_subagent', args: { Model: 'flash' } }],
  };
  const hostGeneric = {
    step_index: 3,
    type: 'GENERIC',
    created_at: new Date(1600).toISOString(),
    content: `Created the following subagent:\n{\n  "conversationId": "${child2Id}"\n}`,
  };
  const hostStep1 = {
    step_index: 5,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(3500).toISOString(),
    input_tokens: 200,
    output_tokens: 25,
    cache_read_tokens: 40,
  };
  const hostOutOfWindow = {
    step_index: 8,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(25000).toISOString(),
    input_tokens: 500,
    output_tokens: 50,
  };

  const child1Step = {
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(2500).toISOString(),
    input_tokens: 50,
    output_tokens: 5,
    cache_read_tokens: 10,
    tool_calls: [{ name: 'invoke_subagent', args: { Model: '"pro"' } }],
  };
  const child1Generic = {
    step_index: 2,
    type: 'GENERIC',
    created_at: new Date(2600).toISOString(),
    content: `Created the following subagent:\n{\n  "conversationId": "${grandchildId}"\n}`,
  };

  const child2Step = {
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(2800).toISOString(),
    input_tokens: 60,
    output_tokens: 6,
  };

  const grandchildStep = {
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(3200).toISOString(),
    input_tokens: 30,
    output_tokens: 3,
    cache_read_tokens: 5,
  };

  const hostBlob0 = buildGenMetadataBlob({
    input: 100,
    output: 10,
    cacheRead: 20,
    reasoning: 15,
    modelSlug: 'gemini-4-argon-trial',
    displayName: 'Gemini 4 Argon (Medium)',
    lastStepIndex: 1,
  });
  const hostBlob1 = buildGenMetadataBlob({
    input: 200,
    output: 25,
    cacheRead: 40,
    reasoning: 30,
    modelSlug: 'gemini-3.8-flash-n',
    displayName: 'Gemini 3.8 Flash (High)',
    lastStepIndex: 4,
  });

  const child1Blob = buildGenMetadataBlob({
    input: 50,
    output: 5,
    cacheRead: 10,
    reasoning: 8,
    modelSlug: 'gemini-3.8-flash-tiered',
    displayName: 'Gemini 3.8 Flash (Low)',
    lastStepIndex: 0,
  });

  const child2Blob = buildGenMetadataBlob({
    input: 60,
    output: 6,
    reasoning: 4,
    modelSlug: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    lastStepIndex: 0,
  });

  const grandchildBlob = buildGenMetadataBlob({
    input: 30,
    output: 3,
    cacheRead: 5,
    reasoning: 2,
    modelSlug: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash (Max)',
    lastStepIndex: 0,
  });

  const root = '/home/.gemini/antigravity';
  const hostTranscript = path.join(root, 'brain', hostId, '.system_generated', 'logs', 'transcript.jsonl');
  const hostDb = path.join(root, 'conversations', `${hostId}.db`);
  const subagentsDir = path.join(root, 'brain', hostId, '.system_generated', 'subagents');
  const child1Descriptor = path.join(subagentsDir, `${child1Id}.json`);

  const child1Transcript = path.join(root, 'brain', child1Id, '.system_generated', 'logs', 'transcript.jsonl');
  const child1Db = path.join(root, 'conversations', `${child1Id}.db`);

  const child2Transcript = path.join(root, 'brain', child2Id, '.system_generated', 'logs', 'transcript.jsonl');
  const child2Db = path.join(root, 'conversations', `${child2Id}.db`);

  const grandchildTranscript = path.join(root, 'brain', grandchildId, '.system_generated', 'logs', 'transcript.jsonl');
  const grandchildDb = path.join(root, 'conversations', `${grandchildId}.db`);

  const files: Record<string, string | Buffer> = {
    [hostTranscript]: lines(hostStep0, hostGeneric, hostStep1, hostOutOfWindow),
    [hostDb]: Buffer.alloc(10),
    [child1Descriptor]: JSON.stringify({
      conversationId: child1Id,
      subagentDescriptor: { typeName: 'self', role: 'Explorer' },
    }),
    [child1Transcript]: lines(child1Step, child1Generic),
    [child1Db]: Buffer.alloc(10),
    [child2Transcript]: lines(child2Step),
    [child2Db]: Buffer.alloc(10),
    [grandchildTranscript]: lines(grandchildStep),
    [grandchildDb]: Buffer.alloc(10),
  };

  const sqliteDbs = {
    [hostDb]: [hostBlob0, hostBlob1],
    [child1Db]: [child1Blob],
    [child2Db]: [child2Blob],
    [grandchildDb]: [grandchildBlob],
  };

  const fs = createAgyFs(files, {}, sqliteDbs);
  const result = agy.read({
    ...query,
    sessionId: hostId,
    startMs: 1000,
    endMs: 10000,
    stages: [
      { stage: 'spec', atMs: 1000 },
      { stage: 'plan', atMs: 2000 },
    ],
  }, fs);

  assert.equal(result.unavailable, undefined);
  assert.deepEqual(result.rows, [
    {
      stage: 'spec',
      role: 'host',
      model: 'gemini-4-argon',
      effort: 'medium',
      depth: 0,
      atMs: 1500,
      reasoningInOutput: false,
      input: 100,
      output: 10,
      cacheRead: 20,
      reasoning: 15,
    },
    {
      stage: 'plan',
      role: 'host',
      model: 'gemini-3.8-flash',
      effort: 'high',
      depth: 0,
      atMs: 3500,
      reasoningInOutput: false,
      input: 200,
      output: 25,
      cacheRead: 40,
      reasoning: 30,
    },
    {
      stage: 'plan',
      role: 'subagent',
      model: 'gemini-3.8-flash',
      effort: 'low',
      depth: 1,
      atMs: 2500,
      reasoningInOutput: false,
      input: 50,
      output: 5,
      cacheRead: 10,
      reasoning: 8,
    },
    {
      stage: 'plan',
      role: 'subagent',
      model: 'gemini-3.8-flash',
      effort: null,
      depth: 1,
      atMs: 2800,
      reasoningInOutput: false,
      input: 60,
      output: 6,
      reasoning: 4,
    },
    {
      stage: 'plan',
      role: 'subagent',
      model: 'gemini-3.8-flash',
      effort: 'max',
      depth: 2,
      atMs: 3200,
      reasoningInOutput: false,
      input: 30,
      output: 3,
      cacheRead: 5,
      reasoning: 2,
    },
  ]);
});

test('agy degrades without db and enforces budget size candidate caps and allowlisted errors', () => {
  const root = '/home/.gemini/antigravity';
  const hostId = 'host-session';
  const hostTranscript = path.join(root, 'brain', hostId, '.system_generated', 'logs', 'transcript.jsonl');
  const child1Id = 'child-1';
  const child1Transcript = path.join(root, 'brain', child1Id, '.system_generated', 'logs', 'transcript.jsonl');
  const child1Descriptor = path.join(root, 'brain', hostId, '.system_generated', 'subagents', `${child1Id}.json`);

  // 1. Missing db falls back to transcript counters with fallback model attribution
  const hostStep = {
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(1500).toISOString(),
    input_tokens: 150,
    output_tokens: 20,
    tool_calls: [{ name: 'invoke_subagent', args: { Model: 'pro' } }],
  };
  const hostGeneric = {
    step_index: 2,
    type: 'GENERIC',
    created_at: new Date(1600).toISOString(),
    content: `Created the following subagent:\n{\n  "conversationId": "${child1Id}"\n}`,
  };
  const childStep = {
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(2500).toISOString(),
    input_tokens: 80,
    output_tokens: 10,
  };

  const fsMissingDb = createAgyFs({
    [hostTranscript]: lines(hostStep, hostGeneric),
    [child1Descriptor]: JSON.stringify({ conversationId: child1Id }),
    [child1Transcript]: lines(childStep),
  });

  const resMissingDb = agy.read({
    ...query,
    sessionId: hostId,
    env: (name) => (name === 'ANTIGRAVITY_MODEL' ? 'gemini-2.5-flash' : undefined),
  }, fsMissingDb);

  assert.equal(resMissingDb.unavailable, undefined);
  assert.deepEqual(resMissingDb.rows, [
    {
      stage: 'spec',
      role: 'host',
      model: 'gemini-2.5-flash',
      effort: null,
      depth: 0,
      atMs: 1500,
      reasoningInOutput: false,
      input: 150,
      output: 20,
    },
    {
      stage: 'plan',
      role: 'subagent',
      model: 'pro',
      effort: null,
      depth: 1,
      atMs: 2500,
      reasoningInOutput: false,
      input: 80,
      output: 10,
    },
  ]);

  // 2. Database read errors (SQLITE_BUSY / EACCES) note unreadable files and keep transcript rows
  const hostDb = path.join(root, 'conversations', `${hostId}.db`);
  const fsDbError = createAgyFs(
    { [hostTranscript]: lines(hostStep), [hostDb]: Buffer.alloc(10) },
    {},
    {
      [hostDb]: () => {
        throw Object.assign(new Error('busy sentinel'), { code: 'SQLITE_BUSY' });
      },
    },
  );
  const resDbError = agy.read({ ...query, sessionId: hostId }, fsDbError);
  assert.equal(resDbError.notes?.host?.['unreadable files'], 1);
  assert.equal(resDbError.rows.length, 1);
  assert.equal(resDbError.rows[0]?.model, 'unknown');
  assert.ok(!JSON.stringify(resDbError).includes('busy sentinel'));

  // 3. Extra trailing row in db notes unparsed lines once and keeps steps enriched
  const singleStep = {
    step_index: 2,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(1500).toISOString(),
    input_tokens: 50,
    output_tokens: 5,
  };
  const blob0 = buildGenMetadataBlob({
    input: 50,
    output: 5,
    modelSlug: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon (Medium)',
    lastStepIndex: 1,
  });
  const blobExtra = buildGenMetadataBlob({
    input: 90,
    output: 9,
    modelSlug: 'gemini-4-argon',
    lastStepIndex: 3,
  });
  const fsExtraDb = createAgyFs(
    { [hostTranscript]: lines(singleStep), [hostDb]: Buffer.alloc(10) },
    {},
    { [hostDb]: [blob0, blobExtra] },
  );
  const resExtraDb = agy.read({ ...query, sessionId: hostId }, fsExtraDb);
  assert.equal(resExtraDb.rows.length, 1);
  assert.equal(resExtraDb.rows[0]?.model, 'gemini-4-argon');
  assert.equal(resExtraDb.notes?.host?.['unparsed lines'], 1);

  // 4. Mismatched counter / out-of-interval step degrades from mismatch onward
  const stepA = {
    step_index: 2,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(1500).toISOString(),
    input_tokens: 10,
    output_tokens: 2,
  };
  const stepB = {
    step_index: 5,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(2500).toISOString(),
    input_tokens: 20,
    output_tokens: 4,
  };
  const blobA = buildGenMetadataBlob({
    input: 10,
    output: 2,
    modelSlug: 'gemini-4-argon',
    lastStepIndex: 1,
  });
  const blobBMismatched = buildGenMetadataBlob({
    input: 999, // mismatch!
    output: 4,
    modelSlug: 'gemini-4-argon',
    lastStepIndex: 3,
  });
  const fsMismatch = createAgyFs(
    { [hostTranscript]: lines(stepA, stepB), [hostDb]: Buffer.alloc(10) },
    {},
    { [hostDb]: [blobA, blobBMismatched] },
  );
  const resMismatch = agy.read({
    ...query,
    sessionId: hostId,
    env: (n) => (n === 'ANTIGRAVITY_MODEL' ? 'fallback-model' : undefined),
  }, fsMismatch);
  assert.equal(resMismatch.rows.length, 2);
  assert.equal(resMismatch.rows[0]?.model, 'gemini-4-argon');
  assert.equal(resMismatch.rows[1]?.model, 'fallback-model');
  assert.equal(resMismatch.rows[1]?.effort, null);
  assert.equal(resMismatch.notes?.host?.['unparsed lines'], 1);

  // 5. Live-first 256 candidate cap with stale child filtering
  const subagentsDir = path.join(root, 'brain', hostId, '.system_generated', 'subagents');
  const capFiles: Record<string, string | Buffer> = {
    [hostTranscript]: lines(hostStep),
  };
  const capTimes: Record<string, number> = {};
  for (let i = 0; i < 262; i++) {
    const cid = `sub-${String(i).padStart(3, '0')}`;
    const desc = path.join(subagentsDir, `${cid}.json`);
    const ctrans = path.join(root, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl');
    capFiles[desc] = JSON.stringify({ conversationId: cid });
    capFiles[ctrans] = lines({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      created_at: new Date(2000).toISOString(),
      input_tokens: 1,
      output_tokens: 1,
    });
    // First 4 are stale (mtimeMs < startMs)
    capTimes[ctrans] = i < 4 ? 500 : 5000;
  }
  const fsCap = createAgyFs(capFiles, capTimes);
  const resCap = agy.read({ ...query, sessionId: hostId, startMs: 1000 }, fsCap);
  // Total children = 262. Stale = 4. Live = 258.
  // 256 live selected, 2 excess live.
  assert.equal(resCap.notes?.subagent?.['too many candidates'], 2);

  // 6. Oversized files and budget cap
  const oversizedFs = createAgyFs({
    [hostTranscript]: lines(hostStep),
  });
  const resOversizedHost = agy.read({ ...query, sessionId: hostId, budget: { remaining: 256 * 1024 * 1024 } }, {
    ...oversizedFs,
    stat: (f) => (f.endsWith('transcript.jsonl') ? { size: MAX_FILE_BYTES + 1, mtimeMs: 1000 } : oversizedFs.stat(f)),
  });
  assert.equal(resOversizedHost.unavailable, 'transcript over size cap');

  // Subagent oversized
  const fsOversizedSub = createAgyFs({
    [hostTranscript]: lines(hostStep, hostGeneric),
    [child1Descriptor]: JSON.stringify({ conversationId: child1Id }),
    [child1Transcript]: 'x',
  });
  const resOversizedSub = agy.read({ ...query, sessionId: hostId, budget: { remaining: 256 * 1024 * 1024 } }, {
    ...fsOversizedSub,
    stat: (f) => (f.includes(child1Id) && f.endsWith('transcript.jsonl') ? { size: MAX_FILE_BYTES + 1, mtimeMs: 1000 } : fsOversizedSub.stat(f)),
  });
  assert.equal(resOversizedSub.notes?.subagent?.['subagents over size cap'], 1);

  // Oversized DB records 'unreadable files' note
  const dbBlob = buildGenMetadataBlob({ input: 150, output: 20 });
  const fsOversizedDb = createAgyFs({
    [hostTranscript]: lines(singleStep),
  }, {}, {
    [path.join(root, 'conversations', `${hostId}.db`)]: [dbBlob],
  });
  const resOversizedDb = agy.read({ ...query, sessionId: hostId, budget: { remaining: 256 * 1024 * 1024 } }, {
    ...fsOversizedDb,
    stat: (f) => (f.endsWith('.db') ? { size: MAX_FILE_BYTES + 1, mtimeMs: 1000 } : fsOversizedDb.stat(f)),
  });
  assert.equal(resOversizedDb.notes?.host?.['unreadable files'], 1);
  assert.equal(resOversizedDb.rows.length, 1);
  assert.equal(resOversizedDb.rows[0]?.model, 'unknown');

  // Subagent descriptor discovery stops and records 'read budget reached' when budget exhausted
  const hostTranscriptContent = lines(hostStep, hostGeneric);
  const descContent = JSON.stringify({ conversationId: child1Id });
  const fsDescBudget = createAgyFs({
    [hostTranscript]: hostTranscriptContent,
    [child1Descriptor]: descContent,
  });
  const resDescBudget = agy.read({ ...query, sessionId: hostId, budget: { remaining: Buffer.byteLength(hostTranscriptContent) + Buffer.byteLength(descContent) - 1 } }, fsDescBudget);
  assert.equal(resDescBudget.notes?.subagent?.['read budget reached'], 1);

  // Large descriptor (>64KiB) capped at 64KiB without exhausting budget when budget has room
  const largeDescContent = JSON.stringify({ conversationId: child1Id, pad: 'x'.repeat(70000) });
  const fsLargeDesc = createAgyFs({
    [hostTranscript]: lines(singleStep),
    [child1Descriptor]: largeDescContent,
  });
  const resLargeDesc = agy.read({ ...query, sessionId: hostId, budget: { remaining: 1024 * 1024 } }, fsLargeDesc);
  assert.equal(resLargeDesc.notes?.subagent?.['read budget reached'], undefined);

  // 7. ANTIGRAVITY_APP_DATA_DIR override
  const customRoot = '/custom/data';
  const customTranscript = path.join(customRoot, 'brain', hostId, '.system_generated', 'logs', 'transcript.jsonl');
  const fsCustom = createAgyFs({
    [customTranscript]: lines(singleStep),
  });
  const resCustom = agy.read({
    ...query,
    sessionId: hostId,
    env: (n) => (n === 'ANTIGRAVITY_APP_DATA_DIR' ? customRoot : undefined),
  }, fsCustom);
  assert.equal(resCustom.rows.length, 1);
  assert.equal(resCustom.unavailable, undefined);

  // 8. Invalid childId rejection
  const invalidDesc = path.join(subagentsDir, 'invalid.json');
  const fsInvalid = createAgyFs({
    [hostTranscript]: lines(hostStep),
    [invalidDesc]: JSON.stringify({ conversationId: '../escaped' }),
  });
  const resInvalid = agy.read({ ...query, sessionId: hostId }, fsInvalid);
  assert.equal(resInvalid.rows.length, 1); // only host row
});
