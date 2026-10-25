import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSpec } from '../../../../skills/dispatch/scripts/toolkit/domain/spec.ts';

const section = (heading: string, body: string) => `## ${heading}\n${body}\n`;
const REQS = '### REQ-1 — Lint specs\n- Acceptance: lint runs.\n\n### REQ-2 — Name IDs\nSee SC1 and T2 in the plan.\n- Acceptance: IDs parse.\n';
const DECS = '### DEC-1 — Format (user)\n- Choice: hybrid\n';

function spec(parts: Partial<Record<string, string | null>> = {}, order?: readonly string[]): string {
  const bodies: Record<string, string | null> = {
    'Intent & Problem': 'Why.', Background: 'Facts.', Requirements: REQS, 'Non-goals': '- none', Constraints: '- portable',
    Decisions: DECS, 'Discussion Record': '- agreed', 'Open Questions': '- none', ...parts,
  };
  const headings = order ?? Object.keys(bodies);
  return `# Spec\n\n> **Status:** draft\n\n${headings.filter((h) => bodies[h] !== null).map((h) => section(h, bodies[h]!)).join('\n')}`;
}

const codes = (source: string, level: 'low' | 'medium' = 'medium') => {
  const result = parseSpec(source, { level });
  return [...(result.ok ? [] : result.defects), ...result.warnings].map((d) => d.code);
};

test('spec lint reports missing sections by level', () => {
  assert.ok(parseSpec(spec(), { level: 'medium' }).ok);

  const lowSource = spec({ Background: null, Decisions: null, 'Discussion Record': null, 'Open Questions': null });
  assert.ok(parseSpec(lowSource, { level: 'low' }).ok);
  assert.deepEqual(codes(lowSource, 'medium'), ['missing-section', 'missing-section', 'missing-section', 'missing-section']);

  assert.deepEqual(codes(spec({ Constraints: null }), 'low'), ['missing-section']);
});

test('spec lint: section order reports an out-of-order section', () => {
  const order = ['Intent & Problem', 'Requirements', 'Background', 'Non-goals', 'Constraints', 'Decisions', 'Discussion Record', 'Open Questions'];
  assert.deepEqual(codes(spec({}, order)), ['section-order']);
});

test('spec lint: ids are returned in order', () => {
  const result = parseSpec(spec(), { level: 'medium' });
  assert.ok(result.ok);
  assert.deepEqual(result.spec.reqIds, ['REQ-1', 'REQ-2']);
  assert.deepEqual(result.spec.decIds, ['DEC-1']);
});

test('spec lint: ids with gaps or duplicates are id-sequence', () => {
  assert.deepEqual(codes(spec({ Requirements: '### REQ-1 — A\n- Acceptance: a\n### REQ-3 — B\n- Acceptance: b\n' })), ['id-sequence']);
  assert.deepEqual(codes(spec({ Decisions: '### DEC-1 — A\n### DEC-1 — B\n' })), ['id-sequence']);
});

test('spec lint: ids in malformed headings are malformed-id', () => {
  assert.deepEqual(codes(spec({ Requirements: `${REQS}### Requirement three\n- Acceptance: c\n` })), ['malformed-id']);
  assert.deepEqual(codes(spec({ Decisions: `${DECS}### REQ-2 — misplaced\n` })), ['malformed-id']);
});

test('spec lint: ids that use plan, criterion, increment, or finding forms are colliding-id', () => {
  for (const id of ['T1', 'SC2', 'I01', 'R1', 'R1-F2']) {
    assert.deepEqual(codes(spec({ Requirements: `${REQS}### ${id} — Collides\n- Acceptance: c\n` })), ['colliding-id'], id);
  }
});

test('spec lint: a decision heading that uses a plan ID form is colliding-id', () => {
  assert.deepEqual(codes(spec({ Decisions: `${DECS}### T1 — Collides
` })), ['colliding-id']);
});

test('spec lint: ids in prose are not defects', () => {
  assert.ok(parseSpec(spec({ 'Intent & Problem': 'Cites SC1, T2, I01, and R1-F1.' }), { level: 'medium' }).ok);
});

test('spec lint: ids absent from requirements are missing-requirement', () => {
  assert.deepEqual(codes(spec({ Requirements: 'Nothing yet.' })), ['missing-requirement']);
});

test('spec lint: acceptance bullet is required per requirement', () => {
  assert.deepEqual(codes(spec({ Requirements: '### REQ-1 — A\nNo check.\n' })), ['missing-acceptance']);
});

test('spec lint reports invalid IDs and missing acceptance in duplicated Requirements sections', () => {
  const source = `${spec()}\n## Requirements\n### T9 — Shadow\n- Acceptance: hidden.\n\n### REQ-3 — Unchecked\nNo check.\n`;
  const result = parseSpec(source, { level: 'medium' });
  assert.ok(!result.ok);
  const found: string[] = [...result.defects, ...result.warnings].map((d) => d.code);
  for (const code of ['duplicate-section', 'colliding-id', 'missing-acceptance']) assert.ok(found.includes(code), `${code} in ${found.join(',')}`);
  assert.ok(result.warnings.some((d) => d.code === 'missing-acceptance' && d.message.startsWith('REQ-3 ')));
});

test('spec lint reports duplicated Decisions sections and malformed decision IDs', () => {
  const source = `${spec()}\n## Decisions\n### Decision two\n- Choice: x\n`;
  const found = codes(source);
  assert.ok(found.includes('duplicate-section'), found.join(','));
  assert.ok(found.includes('malformed-id'), found.join(','));
});
