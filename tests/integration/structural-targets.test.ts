import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { KINDS, validateRecord } from '../../skills/dispatch/scripts/toolkit/records.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('toolkit stays within the structural size budgets', () => {
  const files = fs.readdirSync(path.join(root, 'skills/dispatch/scripts'), { recursive: true })
    .map(String).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const lines = files.reduce((total, file) => total +
    fs.readFileSync(path.join(root, 'skills/dispatch/scripts', file), 'utf8').split('\n').length - 1, 0);
  // NOTE: 12,080 covers review-loop diagnostics, host usage adapters and tables, severity derivation, review-budget state, coverage rounds, OpenCode lifecycle measurements, the session-declared host, the sandbox roster filter and unresolved-locus handling.
  assert.ok(
    lines <= 12080,
    `driver TS LOC ${lines} exceeds 12080 budget. Streamline, consolidate, or refactor without squashing or stripping comments; raising the budget requires explicit authorization.`
  );
  assert.ok(
    KINDS.length <= 14,
    `ledger kinds ${KINDS.length} exceeds 14 budget. Streamline, consolidate, or refactor without squashing or stripping comments; raising the budget requires explicit authorization.`
  );
  const bytes = fs.statSync(path.join(root, 'skills/dispatch/SKILL.md')).size;
  // NOTE: 7,424 keeps rules that every branch needs inline, because a must-load reference adds a tool call each run.
  assert.ok(
    bytes <= 7424,
    `SKILL.md bytes ${bytes} exceeds 7424 budget. Move branch-specific detail to references; raise the budget only for rules that every branch needs, per AGENTS.md Documentation Standards.`
  );
});

test('ledger authority is limited to approval, exceptions and user-selected levels', () => {
  const hash = 'sha256:' + 'a'.repeat(64), commit = 'b'.repeat(40);
  const dest = { branch: 'main', path: '/repo' };
  const data: Record<string, Record<string, unknown>[]> = {
    bind: [{ spec: 'spec.md', plan: 'plan.md', design: 'design.md' }],
    approval: [{ spec: hash, plan: hash, design: hash }],
    confirm: [{ spec: hash }],
    level: ['low', 'medium', 'high', 'xhigh', 'max'].map(level => ({ level })),
    waiver: [{ criterion: 'SC1', reason: 'User accepted the limit' }],
    'manual-complete': [{ criterion: 'SC1', evidence: 'User observed the result' }],
    escalation: [{ id: 'decision', state: 'open', summary: 'Need an intent decision' }],
    ruling: [{ subject: 'review:finding', ruling: 'accepted', rationale: 'Verified defect' }],
    note: [{ text: 'Resume from status' }],
    edit: [{ artifact: 'plan', before: hash, after: hash, class: 'non-intent', affects: [], rationale: 'Clarify command', diffRef: 'diff.md' }],
    evidence: [{ criterion: 'SC1', commandDigest: hash, tree: commit, clean: true, before: commit, after: commit, exit: 0, path: 'result.json' }],
    writer: [
      { phase: 'launched', task: 'task', path: '/writer', base: { commit, taskSection: hash, seq: 0 } },
      { phase: 'finished', task: 'task', launch: 1, candidate: commit },
      { phase: 'abandoned', task: 'task', launch: 1, reason: 'Retry' },
    ],
    integrate: [
      { phase: 'opened', path: '/integration', branch: 'session', base: commit, dest },
      { phase: 'started', task: 'task', candidate: commit },
      { phase: 'conflict', task: 'task', paths: ['source.ts'] },
      { phase: 'done', task: 'task', commit },
      { phase: 'abandoned', task: 'task', candidate: commit, reason: 'Retry' },
      { phase: 'fix', commit, reason: 'Review repair' },
      { phase: 'test-cleanup', from: commit, fromTree: commit, to: commit, removed: ['SC1'], deleted: 1, merged: 0 },
      { phase: 'deliver-started', mode: 'uncommitted', dest, from: commit, source: commit },
      { phase: 'delivered', mode: 'uncommitted', dest, from: commit, source: commit },
      { phase: 'closed', reason: 'Session complete' },
    ],
    focus: [{ bullets: [{ text: 'Review the completion gate', evidence: 'src/report.ts' }] }],
  };
  assert.deepEqual(Object.keys(data).sort(), [...KINDS].sort());
  for (const kind of KINDS) for (const value of data[kind]!) {
    const record = { kind, key: `${kind}:${value['phase'] ?? value['level'] ?? 'record'}`, data: value };
    const userOnly = ['approval', 'confirm', 'waiver', 'manual-complete'].includes(kind) ||
      (kind === 'level' && ['xhigh', 'max'].includes(String(value['level'])));
    const label = record.key;
    assert.doesNotThrow(() => validateRecord({ ...record, by: 'user', quote: 'I approve this action.' }), label);
    if (userOnly) {
      for (const by of ['orchestrator', 'tool']) {
        assert.throws(() => validateRecord({ ...record, by, quote: 'I approve this action.' }),
          { reason: 'user-only' }, `${label} rejects ${by}`);
      }
      for (const quote of [undefined, '', '   ']) {
        assert.throws(() => validateRecord({ ...record, by: 'user', ...(quote === undefined ? {} : { quote }) }),
          { reason: 'user-only' }, `${label} requires a user quote`);
      }
    } else {
      assert.doesNotThrow(() => validateRecord({ ...record, by: 'orchestrator' }), label);
    }
  }
});
