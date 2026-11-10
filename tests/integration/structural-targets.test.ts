import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { KINDS, validateRecord } from '../../skills/dispatch/scripts/toolkit/records.ts';
import { reviewPrompt } from '../../skills/dispatch/scripts/toolkit/prompts.ts';
import { qualityCriteria } from '../../skills/dispatch/scripts/toolkit/domain/prompt.ts';
import type { QualityConsumer } from '../../skills/dispatch/scripts/toolkit/domain/prompt.ts';
import type { ReviewKind } from '../../skills/dispatch/scripts/toolkit/domain/types.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('toolkit stays within the structural size budgets', () => {
  const files = fs.readdirSync(path.join(root, 'skills/dispatch/scripts'), { recursive: true })
    .map(String).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const lines = files.reduce((total, file) => total +
    fs.readFileSync(path.join(root, 'skills/dispatch/scripts', file), 'utf8').split('\n').length - 1, 0);
  // NOTE: 15200 ceiling covers the approved runtime verification stage.
  assert.ok(
    lines <= 15200,
    `driver TS LOC ${lines} exceeds 15200 budget. Streamline, consolidate, or refactor without squashing or stripping comments; raising the budget requires explicit authorization.`
  );
  assert.ok(
    KINDS.length <= 14,
    `ledger kinds ${KINDS.length} exceeds 14 budget. Streamline, consolidate, or refactor without squashing or stripping comments; raising the budget requires explicit authorization.`
  );
  const bytes = fs.statSync(path.join(root, 'skills/dispatch/SKILL.md')).size;
  // NOTE: 8512 covers the verification route and the read-once tool contract rule that every branch needs.
  assert.ok(
    bytes <= 8512,
    `SKILL.md bytes ${bytes} exceeds 8512 budget. Move branch-specific detail to references; raise the budget only for rules that every branch needs, per AGENTS.md Documentation Standards.`
  );
});

const STEP_BUDGET = 37067;
const PLAN_AUTHORING_BUDGET = 36914;
const GUIDES = ['ask', 'design', 'plan', 'implement', 'review', 'verify'] as const;

function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Byte size of a whole reference file, or of the section under an anchor heading.
function sectionBytes(file: string, anchor: string | null): number {
  const text = fs.readFileSync(path.join(root, 'skills/dispatch', file), 'utf8');
  if (!anchor) return Buffer.byteLength(text);
  const lines = text.split('\n');
  const start = lines.findIndex((line) => {
    const match = /^(#{2,4})\s+(.*?)\s*$/.exec(line);
    return match !== null && slug(match[2]!) === anchor;
  });
  assert.ok(start >= 0, `${file}#${anchor} resolves to a heading`);
  const level = /^(#{2,4})/.exec(lines[start]!)![1]!.length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const match = /^(#{2,4})\s+/.exec(lines[index]!);
    if (match && match[1]!.length <= level) { end = index; break; }
  }
  return Buffer.byteLength(lines.slice(start, end).join('\n'));
}

test('verb steps stay within the per-step byte budgets', () => {
  const skillBytes = fs.statSync(path.join(root, 'skills/dispatch/SKILL.md')).size;
  for (const guide of GUIDES) {
    const rel = `references/verbs/${guide}.md`;
    const text = fs.readFileSync(path.join(root, 'skills/dispatch', rel), 'utf8');
    assert.ok(text.includes('## Step reads'), `${rel} states its step table`);
    const rows = text.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Step') && !line.startsWith('| ---'));
    assert.ok(rows.length > 0, `${rel} has step rows`);
    const guideBytes = fs.statSync(path.join(root, 'skills/dispatch', rel)).size;
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean);
      const links = [...cells[1]!.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
      assert.equal(links.length, 1, `${guide} step links exactly one file: ${row}`);
      const target = links[0]![2]!;
      assert.ok(!/^(https?:|mailto:|<)/.test(target), `${guide} step links a relative path: ${target}`);
      const [ref, anchor] = target.split('#');
      const file = path.posix.normalize(path.posix.join('references/verbs', ref!));
      const total = sectionBytes(file, anchor ?? null) + skillBytes + guideBytes;
      assert.ok(total <= STEP_BUDGET, `${guide} step reads ${total} bytes exceed ${STEP_BUDGET}: ${row.trim()}`);
      if (guide === 'plan') {
        assert.ok(total <= PLAN_AUTHORING_BUDGET, `plan authoring step reads ${total} bytes exceed ${PLAN_AUTHORING_BUDGET}: ${row.trim()}`);
      }
    }
  }
});

test('rendered packs stay within the per-actor byte budgets', () => {
  const skillRoot = path.join(root, 'skills/dispatch');
  const templateBytes = (name: string) => fs.statSync(path.join(skillRoot, 'references/templates', name)).size;
  const bar = fs.readFileSync(path.join(skillRoot, 'references/templates/quality-bar.md'), 'utf8');
  const specStage = fs.readFileSync(path.join(skillRoot, 'references/spec-stage.md'), 'utf8');
  const qualityBytes = (consumer: QualityConsumer) => Buffer.byteLength(qualityCriteria(bar, consumer, 0, specStage));
  const promptBytes = (kind: ReviewKind) => Buffer.byteLength(reviewPrompt(kind, {
    skillRoot, spec: { path: 's', hash: 'h' }, artifact: 'a',
    planPath: 'None', taskSummary: 't', scope: 's', turnTarget: 1, round: 1,
  }));
  // NOTE: pack budgets from factory.plan.md SC5. The explorer/map/shared component
  // estimates (5418/1824/5396) predate the T1 audience tags and the T6 map-budget
  // sentence; the test enforces the pack totals plus the components that still hold.
  assert.ok(promptBytes('code') <= 14648, `code reviewer prompt exceeds 14648 budget`);
  assert.ok(promptBytes('plan') <= 16653, `plan reviewer prompt exceeds 16653 budget`);
  assert.ok(promptBytes('design') <= 12439, `design reviewer prompt exceeds 12439 budget`);
  const writer = templateBytes('writer-brief.md') + qualityBytes('writer');
  assert.ok(writer <= 10520, `writer brief pack ${writer} exceeds 10520 budget`);
  const explorerBrief = templateBytes('explorer-brief.md');
  assert.ok(explorerBrief <= 5418, `explorer brief template ${explorerBrief} exceeds 5418 budget`);
  const explorer = explorerBrief + templateBytes('context-map.md') + qualityBytes('explorer');
  assert.ok(explorer <= 12638, `explorer pack ${explorer} exceeds 12638 budget`);
  const cleanupQuality = qualityBytes('cleanup');
  assert.ok(cleanupQuality <= 7653, `test-cleanup rendered quality ${cleanupQuality} exceeds 7653 budget`);
  assert.ok(templateBytes('verifier-brief.md') <= 4096, 'verifier brief exceeds 4096 bytes');
  const cleanupBrief = templateBytes('test-cleanup-brief.md');
  assert.ok(cleanupBrief <= 1870, `test-cleanup brief template ${cleanupBrief} exceeds 1870 budget`);
  const cleanup = cleanupBrief + cleanupQuality;
  assert.ok(cleanup <= 9523, `test-cleanup pack ${cleanup} exceeds 9523 budget`);
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
      { phase: 'verification', cycle: 1, outcome: 'no-op', head: commit, reason: 'Nothing runnable', open: [] },
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
