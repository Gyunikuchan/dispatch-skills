import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import type { JsonObject } from './helpers/json.ts';

test('ledger bindings validate paths and gate stale approvals', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const input = f.artifact('record.json', '');
    let n = 0;
    const call = async (record: unknown) => {
      f.lines.length = 0;
      fs.writeFileSync(input, JSON.stringify(record));
      const exit = await main(['ledger', 'append', '--session', f.session, input], f.deps);
      const output = f.output();
      return { exit, output, value: output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null };
    };
    const add = (kind: string, data: JsonObject, extra: JsonObject = {}) =>
      appendRecord(f.session, { kind, data, by: 'orchestrator', key: 'k' + n++, ...extra }, f.deps);
    const hash = 'sha256:' + 'a'.repeat(64);
    f.artifact('s.spec.md', 'spec');
    f.artifact('p.plan.md', 'plan');
    for (const spec of ['../escape', 'C:/absolute', 'missing']) {
      await assert.rejects(add('bind', { spec, plan: 'p.plan.md' }), { reason: 'invalid-record' });
    }
    const badBind = await call({
      kind: 'bind',
      key: 'bad-bind',
      by: 'orchestrator',
      data: { spec: 'missing', plan: 'p.plan.md' },
    });
    assert.equal(badBind.exit, 1);
    assert.equal(badBind.output.reason, 'invalid-record');
    await assert.rejects(add('approval', { spec: hash, plan: hash }, { by: 'user', quote: 'yes' }), {
      reason: 'invalid-record',
      message: /append a bind record/,
    });
    const binding = { kind: 'bind', key: 'bind', by: 'orchestrator', data: { spec: 's.spec.md', plan: 'p.plan.md' } };
    assert.equal((await call(binding)).exit, 0);
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    await assert.rejects(add('approval', { ...hashes, design: hash }, { by: 'user', quote: 'yes' }), {
      reason: 'approval-stale',
    });
    f.artifact('d.design.md', 'design');
    assert.ok((await add('bind', { ...binding.data, design: 'd.design.md' })).seq > 0);
    await assert.rejects(add('approval', hashes, { by: 'user', quote: 'yes' }), { reason: 'approval-stale' });
    assert.ok((await add('bind', binding.data)).seq > 0);
    await assert.rejects(add('approval', { spec: hashes.spec }, { by: 'user', quote: 'yes' }), {
      reason: 'invalid-record',
    });
    const approval = { kind: 'approval', key: 'approval', by: 'user', quote: 'yes', data: hashes };
    const approved = await call(approval);
    assert.equal(approved.exit, 0);
    f.artifact('p.plan.md', 'changed');
    assert.equal((await call(approval)).value.seq, approved.value.seq);
    await assert.rejects(add('approval', hashes, { by: 'user', quote: 'yes' }), { reason: 'approval-stale' });
    f.artifact('p.plan.md', 'plan');
    assert.ok((await call({ ...approval, key: 'approval-again' })).value.seq > approved.value.seq);
  } finally {
    f.cleanup();
  }
});
