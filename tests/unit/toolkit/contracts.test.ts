import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import * as entry from '../../../skills/dispatch/scripts/dispatch.ts';
import { parseCommand, SESSION_ACTIONS } from '../../../skills/dispatch/scripts/lib/cli.ts';
import { TOOL_ACTIONS } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import {
  ACTION_CONTRACTS,
  CALL_TABLE_MAX_BYTES,
  renderCallTable,
  SESSION_CONTRACTS,
} from '../../../skills/dispatch/scripts/toolkit/contracts.ts';
import { KINDS, recordSchemas, validateRecord } from '../../../skills/dispatch/scripts/toolkit/records.ts';
import { sessionFixture } from './helpers/session.ts';

const HASH = 'sha256:' + 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

function sampleField(kind: string, phase: string | undefined, field: string): unknown {
  if (field === 'spec' || field === 'plan' || field === 'design') {
    return kind === 'bind' ? `${field}.md` : HASH;
  }
  if (field === 'before' || field === 'after') return kind === 'evidence' ? COMMIT : HASH;
  if (field === 'commandDigest' || field === 'taskSection') return HASH;
  if (
    field === 'tree' ||
    field === 'commit' ||
    field === 'from' ||
    field === 'fromTree' ||
    field === 'to' ||
    field === 'source' ||
    field === 'head' ||
    field === 'candidate'
  )
    return COMMIT;
  if (field === 'base') return phase === 'launched' ? { commit: COMMIT, taskSection: HASH, seq: 0 } : COMMIT;
  if (field === 'dest') return { branch: 'main', path: 'repo' };
  if (field === 'artifacts') return kind === 'evidence' ? { spec: HASH, plan: HASH } : ['reports/out.md'];
  if (field === 'reviewFix') return { review: 'code-1', round: 1, generation: 1, findings: ['R1-F001'], from: COMMIT };
  if (field === 'bullets') return [{ text: 'Check boundary', evidence: 'src/index.ts' }];
  if (field === 'trees') return { SC1: COMMIT };
  if (field === 'removed') return ['SC1'];
  if (kind === 'ruling' && field === 'paths') return ['src/file.ts', 'tests/file.test.ts'];
  if (field === 'affects' || field === 'paths' || field === 'differing') return ['T1'];
  if (field === 'open') return [];
  if (field === 'clean' || field === 'dirty' || field === 'noop') return field === 'clean';
  if (field === 'seq' || field === 'deleted' || field === 'merged' || field === 'exit') return 0;
  if (field === 'launch' || field === 'cycle') return 1;
  if (field === 'level') return 'medium';
  if (field === 'state') return 'open';
  if (field === 'artifact') return 'plan';
  if (field === 'class') return 'non-intent';
  if (field === 'outcome') return 'no-op';
  if (field === 'mode') return 'uncommitted';
  if (field === 'ruling') return 'accepted';
  if (field === 'impact') return 'degrades';
  if (field === 'trigger') return 'realistic';
  if (field === 'subject') return 'note:check';
  if (field === 'report') return 'reports/verify.md';
  return `${field}-value`;
}

describe('contracts and help call table', () => {
  test('recordSchemas covers every ledger kind and phase matching validateRecord', () => {
    const schemas = recordSchemas();
    assert.deepEqual(
      schemas.map((schema) => schema.kind),
      [...KINDS],
    );
    const writer = schemas.find((schema) => schema.kind === 'writer');
    const integrate = schemas.find((schema) => schema.kind === 'integrate');
    assert.ok(writer?.phased && writer.phases.length === 3);
    assert.ok(integrate?.phased && integrate.phases.length === 12);

    for (const schema of schemas) {
      if (!schema.phased) {
        const data: Record<string, unknown> = {};
        for (const field of schema.required) data[field] = sampleField(schema.kind, undefined, field);
        if (schema.kind === 'bind') data['plan'] = 'plan.md';
        assert.doesNotThrow(
          () => validateRecord({ kind: schema.kind, by: 'user', quote: 'approved', key: `k:${schema.kind}`, data }),
          `${schema.kind} required fields pass validation`,
        );
        for (const reqField of schema.required) {
          const incomplete = { ...data };
          delete incomplete[reqField];
          assert.throws(
            () =>
              validateRecord({
                kind: schema.kind,
                by: 'user',
                quote: 'approved',
                key: `k:${schema.kind}:no-${reqField}`,
                data: incomplete,
              }),
            { reason: 'invalid-record' },
            `${schema.kind} rejects missing required field ${reqField}`,
          );
        }
        for (const field of schema.optional) {
          const withOptional = { ...data, [field]: sampleField(schema.kind, undefined, field) };
          if (schema.kind === 'ruling' && field === 'paths')
            withOptional['subject'] = 'review:code-integration:R1-F001';
          if (schema.kind === 'ruling' && (field === 'impact' || field === 'trigger')) {
            withOptional['subject'] = 'review:plan-1:R1-F001';
            withOptional['impact'] = sampleField(schema.kind, undefined, 'impact');
            withOptional['trigger'] = sampleField(schema.kind, undefined, 'trigger');
          }
          assert.doesNotThrow(
            () =>
              validateRecord({
                kind: schema.kind,
                by: 'user',
                quote: 'approved',
                key: `k:${schema.kind}:${field}`,
                data: withOptional,
              }),
            `${schema.kind} optional field ${field} is accepted`,
          );
        }
        continue;
      }

      for (const phaseSchema of schema.phases) {
        const data: Record<string, unknown> = { phase: phaseSchema.phase };
        for (const field of phaseSchema.required) data[field] = sampleField(schema.kind, phaseSchema.phase, field);
        assert.doesNotThrow(
          () => validateRecord({ kind: schema.kind, by: 'tool', key: `k:${schema.kind}:${phaseSchema.phase}`, data }),
          `${schema.kind} (${phaseSchema.phase}) required fields pass validation`,
        );
        for (const reqField of phaseSchema.required) {
          const incomplete = { ...data };
          delete incomplete[reqField];
          assert.throws(
            () =>
              validateRecord({
                kind: schema.kind,
                by: 'tool',
                key: `k:${schema.kind}:${phaseSchema.phase}:no-${reqField}`,
                data: incomplete,
              }),
            { reason: 'invalid-record' },
            `${schema.kind} (${phaseSchema.phase}) rejects missing required field ${reqField}`,
          );
        }
        for (const field of phaseSchema.optional) {
          const withOptional: Record<string, unknown> = {
            ...data,
            [field]: sampleField(schema.kind, phaseSchema.phase, field),
          };
          if (schema.kind === 'integrate' && phaseSchema.phase === 'verification') {
            withOptional['outcome'] = 'proved';
            withOptional['report'] = 'reports/verify.md';
          }
          assert.doesNotThrow(
            () =>
              validateRecord({
                kind: schema.kind,
                by: 'tool',
                key: `k:${schema.kind}:${phaseSchema.phase}:${field}`,
                data: withOptional,
              }),
            `${schema.kind} (${phaseSchema.phase}) optional field ${field} is accepted`,
          );
        }
      }
    }
  });

  test('ACTION_CONTRACTS and SESSION_CONTRACTS match CLI action registries', () => {
    assert.deepEqual(Object.keys(ACTION_CONTRACTS).sort(), [...TOOL_ACTIONS].sort());
    for (const action of TOOL_ACTIONS) {
      const contract = ACTION_CONTRACTS[action];
      assert.ok(contract && contract.arguments.startsWith(action), `action contract for ${action}`);
    }

    assert.deepEqual([...SESSION_ACTIONS], ['init', 'reactivate', 'quota-reprobe']);
    assert.deepEqual(Object.keys(SESSION_CONTRACTS).sort(), [...SESSION_ACTIONS].sort());
    for (const action of SESSION_ACTIONS) {
      const contract = SESSION_CONTRACTS[action];
      assert.ok(contract && contract.arguments.startsWith(`session ${action}`), `session contract for ${action}`);
    }
    assert.throws(() => parseCommand(['session', 'bogus']), /session requires init, reactivate, or quota-reprobe/);
  });

  test('renderCallTable and dispatch help call table emit all contracts within the byte limit', async () => {
    const rendered = renderCallTable();
    assert.ok(rendered.startsWith('### call table\n'));
    assert.ok(rendered.endsWith('\n'));
    const bytes = Buffer.byteLength(rendered, 'utf8');
    assert.ok(bytes <= CALL_TABLE_MAX_BYTES, `renderCallTable() is ${bytes} bytes (limit ${CALL_TABLE_MAX_BYTES})`);

    assert.match(rendered, /subagent assigned a map[^\n]*`lint run` on that map only/i);
    assert.match(rendered, /\{ok, summary, path, reason\?\}/);
    assert.match(rendered, /Windows PowerShell 5\.1/);
    assert.match(rendered, /ledger append <record\.json\|-> --session <session>/);

    const rows = rendered
      .split('\n')
      .filter((line) => line.startsWith('| '))
      .slice(2);
    const rowSet = new Set(
      rows.map((line) => {
        const cells = line
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean);
        return `${cells[0]}:${cells[1]}`;
      }),
    );

    for (const action of TOOL_ACTIONS) {
      assert.ok(rowSet.has(`action:${action}`), `missing action row ${action}`);
    }
    for (const sessionAction of SESSION_ACTIONS) {
      assert.ok(rowSet.has(`session:session ${sessionAction}`), `missing session row ${sessionAction}`);
    }
    for (const schema of recordSchemas()) {
      if (!schema.phased) {
        assert.ok(rowSet.has(`record:${schema.kind}`), `missing flat record row ${schema.kind}`);
        const row = rows.find((line) => line.startsWith(`| record | ${schema.kind} |`)) ?? '';
        for (const field of schema.required) assert.ok(row.includes(field), `${schema.kind} row includes ${field}`);
        for (const field of schema.optional)
          assert.ok(row.includes(`${field}?`), `${schema.kind} row includes ${field}?`);
      } else {
        for (const phaseSchema of schema.phases) {
          const heading = `${schema.kind} (${phaseSchema.phase})`;
          assert.ok(rowSet.has(`record:${heading}`), `missing phased row ${heading}`);
          const row = rows.find((line) => line.startsWith(`| record | ${heading} |`)) ?? '';
          for (const field of phaseSchema.required) assert.ok(row.includes(field), `${heading} row includes ${field}`);
          for (const field of phaseSchema.optional)
            assert.ok(row.includes(`${field}?`), `${heading} row includes ${field}?`);
        }
      }
    }

    const f = sessionFixture();
    try {
      const code = await entry.main(['help', 'call', 'table'], { ...f.deps, skillRoot: path.join(f.root, 'missing') });
      assert.equal(code, 0);
      assert.equal(f.lines.length, 1);
      assert.equal(f.lines[0], rendered);
    } finally {
      f.cleanup();
    }
  });
});
