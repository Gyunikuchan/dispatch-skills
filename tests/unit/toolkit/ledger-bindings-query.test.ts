import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, foldLedger, latest, queryLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { KINDS } from '../../../skills/dispatch/scripts/toolkit/records.ts';
import type { JsonObject } from './helpers/json.ts';
import { narrow, refusal } from './helpers/json.ts';

test('ledger bindings preserve rulings queries and input validation', async () => {
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
    const hash = 'sha256:' + 'a'.repeat(64),
      git = 'a'.repeat(40);
    f.artifact('s.spec.md', 'spec');
    f.artifact('p.plan.md', 'plan');
    const binding = { kind: 'bind', key: 'bind', by: 'orchestrator', data: { spec: 's.spec.md', plan: 'p.plan.md' } };
    assert.equal((await call(binding)).exit, 0);
    for (const ruling of ['X', 'Y', 'X']) {
      assert.ok((await add('ruling', { subject: 's', ruling, rationale: 'r' })).seq > 0);
    }
    for (const state of ['open', 'resolved', 'open']) {
      assert.ok((await add('escalation', { id: 'e', state, summary: 's' })).seq > 0);
    }
    assert.equal(latest(foldLedger(f.session), 'escalation')?.data['state'], 'open');
    assert.equal(foldLedger(f.session).records.filter((r) => r.kind === 'ruling').length, 3);
    await assert.rejects(
      add('edit', {
        artifact: 'design',
        before: hash,
        after: hash,
        class: 'non-intent',
        affects: [],
        rationale: 'r',
        diffRef: 'd',
      }),
      (error: unknown) => {
        const failure = narrow(error, refusal);
        assert.equal(failure.reason, 'invalid-record');
        assert.match(failure.message ?? '', /append a bind record that includes it first/i);
        assert.match(failure.message ?? '', /currently bound artifact kinds:.*\bplan\b.*\bspec\b/i);
        return true;
      },
    );
    fs.unlinkSync(path.join(f.root, 's.spec.md'));
    assert.equal((await call(binding)).value.deduped, true);
    for (const phase of ['deliver-started', 'delivered']) {
      assert.equal(
        (
          await call({
            kind: 'integrate',
            key: phase,
            by: 'tool',
            data: { phase, mode: 'uncommitted', dest: { branch: 'b', path: 'p' }, from: git, source: git },
          })
        ).exit,
        0,
      );
    }
    assert.equal(
      foldLedger(f.session).records.filter((r) => r.kind === 'integrate' && r.data['mode'] === 'uncommitted').length,
      2,
    );
    f.lines.length = 0;
    assert.equal(await main(['ledger', 'query', '--session', f.session, '--kind', 'integrate'], f.deps), 0);
    assert.equal(JSON.parse(fs.readFileSync(f.output().path!, 'utf8')).length, 2);
    const folded = foldLedger(f.session);
    assert.equal(queryLedger(folded, { kind: 'integrate', since: '0' }).length, 2);
    assert.equal(queryLedger(folded, { since: folded.records[0]!.seq }).length, folded.records.length - 1);
    assert.equal(queryLedger(folded, { key: folded.records[0]!.key }).length, 1);
    for (const filter of [{ kind: 'bad' }, { since: '-1' }, { since: 'wat' }]) {
      assert.throws(
        () => queryLedger(folded, filter),
        (error: unknown) => {
          const failure = narrow(error, refusal);
          assert.equal(failure.reason, 'invalid-input');
          if (filter.kind === 'bad') {
            assert.equal(failure.message, `filter.kind must be one of: ${KINDS.join(', ')}.`);
          } else {
            assert.equal(failure.message, 'filter.since must be a nonnegative safe integer.');
          }
          return true;
        },
      );
    }
    f.lines.length = 0;
    assert.equal(await main(['ledger', 'query', '--session', f.session, '--kind', 'bad'], f.deps), 1);
    assert.equal(f.output().reason, 'invalid-input');
    for (const file of ['missing', f.root]) {
      f.lines.length = 0;
      assert.equal(await main(['ledger', 'append', '--session', f.session, file], f.deps), 1);
      assert.equal(f.output().reason, 'invalid-input');
      assert.equal(f.output().summary, 'Cannot read record file ' + path.resolve(file));
    }
    for (const extra of [[], [input, input]]) {
      f.lines.length = 0;
      assert.equal(await main(['ledger', 'append', '--session', f.session, ...extra], f.deps), 1);
      assert.equal(f.output().reason, 'invalid-input');
      assert.match(f.output().summary, /ledger append <record\.json\|->/);
    }
    fs.writeFileSync(input, 'bad');
    f.lines.length = 0;
    assert.equal(await main(['ledger', 'append', '--session', f.session, input], f.deps), 1);
    assert.equal(f.output().reason, 'invalid-input');
    assert.ok(f.output().summary.startsWith('Record file ' + path.resolve(input) + ' is not valid JSON: '));
    const ledger = path.join(f.session, 'ledger.jsonl');
    const bytes = fs.readFileSync(ledger, 'utf8');
    const first = JSON.parse(bytes.split('\n')[0]!);
    fs.appendFileSync(ledger, JSON.stringify(first) + '\n');
    const corrupt = fs.readFileSync(ledger, 'utf8');
    await assert.rejects(add('note', { text: 'n' }), { reason: 'ledger-corrupt' });
    assert.equal(fs.readFileSync(ledger, 'utf8'), corrupt);
  } finally {
    f.cleanup();
  }
});

const run = async (text: string) => {
  const f = sessionFixture({ memory: true });
  try {
    const exit = await main(['ledger', 'append', '--session', f.session, '-'], { ...f.deps, readStdin: () => text });
    const output = f.output();
    return {
      exit,
      reason: output.reason,
      value: output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null,
      records: foldLedger(f.session).records,
    };
  } finally {
    f.cleanup();
  }
};

test('stdin ledger appends validate records and preserve atomic batches', async () => {
  const single = JSON.stringify({ kind: 'note', by: 'orchestrator', key: 'one', data: { text: 'one' } });
  const batch = JSON.stringify([
    { kind: 'note', by: 'orchestrator', key: 'one', data: { text: 'one' } },
    { kind: 'note', by: 'orchestrator', key: 'two', data: { text: 'two' } },
  ]);
  const invalidBatch = JSON.stringify([
    { kind: 'note', by: 'orchestrator', key: 'one', data: { text: 'one' } },
    { kind: 'invalid' },
  ]);

  // Valid single, batch and BOM-prefixed batch append atomically.
  for (const text of [single, batch, '\ufeff' + batch]) {
    const r = await run(text);
    assert.equal(r.exit, 0, text);
    assert.equal(r.records.length, text === single ? 1 : 2, text);
  }
  // Malformed stdin (including empty input) is invalid-input with no records.
  for (const text of ['bad', '']) {
    const r = await run(text);
    assert.equal(r.exit, 1, JSON.stringify(text));
    assert.equal(r.reason, 'invalid-input');
    assert.match(r.value.message, /^Records from stdin are not valid JSON: /);
    assert.deepEqual(r.records, []);
  }
  // Invalid records (including an empty batch) fail atomically with no records.
  for (const text of [invalidBatch, '[]']) {
    const r = await run(text);
    assert.equal(r.reason, 'invalid-record', text);
    assert.deepEqual(r.records, [], text);
  }
  // Unreadable stdin fails before validation.
  for (const readStdin of [
    undefined,
    () => {
      throw new Error('read failed');
    },
  ]) {
    const f = sessionFixture({ memory: true });
    try {
      assert.equal(
        await main(['ledger', 'append', '--session', f.session, '-'], {
          ...f.deps,
          ...(readStdin && { readStdin }),
        }),
        1,
      );
      assert.equal(f.output().reason, 'invalid-input');
      assert.equal(f.output().summary, 'Cannot read records from stdin');
      assert.deepEqual(foldLedger(f.session).records, []);
    } finally {
      f.cleanup();
    }
  }
});

test('ledger file appends match stdin validation results', async () => {
  const single = JSON.stringify({ kind: 'note', by: 'orchestrator', key: 'one', data: { text: 'one' } });
  const batch = JSON.stringify([
    { kind: 'note', by: 'orchestrator', key: 'one', data: { text: 'one' } },
    { kind: 'note', by: 'orchestrator', key: 'two', data: { text: 'two' } },
  ]);
  const invalidBatch = JSON.stringify([
    { kind: 'note', by: 'orchestrator', key: 'one', data: { text: 'one' } },
    { kind: 'invalid' },
  ]);
  for (const text of [single, batch, invalidBatch]) {
    const results = [];
    for (const stdin of [false, true]) {
      const f = sessionFixture({ memory: true });
      try {
        const file = f.artifact('record.json', text);
        const exit = await main(['ledger', 'append', '--session', f.session, stdin ? '-' : file], {
          ...f.deps,
          ...(stdin && { readStdin: () => text }),
        });
        const output = f.output();
        results.push({
          exit,
          reason: output.reason,
          value: output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null,
          records: foldLedger(f.session).records,
        });
      } finally {
        f.cleanup();
      }
    }
    assert.deepEqual(results[1], results[0], text);
  }
});
