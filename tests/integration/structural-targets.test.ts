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
  // NOTE: 18814 covers review timing and unknown evidence for native substitutions and malformed timing facts, user decisions in settled rows, hot units in the review summary head, per-round review workload with its round windows and host read, the rendered fix-check brief (`brief fix-check`) with its unrenderable-name citation withhold and the listed-path exclude for such a citation, the per-round spec snapshot in `review run`, and review-fix metadata split into trailer lines that pass commitlint line limits. Pass 5 adds lint run --edit with path-specific edit history across rebinds, round findings files and host turns per round.
  assert.ok(
    lines <= 18814,
    `driver TS LOC ${lines} exceeds 18814 budget. Cut or consolidate first without squashing or stripping comments; a genuine new behaviour or rule may raise the budget with the reason recorded beside it and reported in the handoff; duplicates never justify a raise.`
  );
  assert.ok(
    KINDS.length <= 14,
    `ledger kinds ${KINDS.length} exceeds 14 budget. Cut or consolidate first without squashing or stripping comments; a genuine new behaviour or rule may raise the budget with the reason recorded beside it and reported in the handoff; duplicates never justify a raise.`
  );
  const bytes = fs.statSync(path.join(root, 'skills/dispatch/SKILL.md')).size;
  // NOTE: 10100 covers the subagent role table, shared native subagent rules, research explorer inline limits, delegation thresholds, and retained explorer follow-up rules.
  assert.ok(
    bytes <= 10100,
    `SKILL.md bytes ${bytes} exceeds 10100 budget. Move branch-specific detail to references first; a genuine rule that every branch needs may raise the budget with the reason recorded beside it and reported in the handoff, per AGENTS.md Documentation Standards; duplicates never justify a raise.`
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
  // NOTE: Pack budgets enforce totals and current component limits.
  // NOTE: Reviewer prompt ceilings reflect consolidated prompts.
  assert.ok(promptBytes('code') <= 14333, `code reviewer prompt exceeds 14333 budget`);
  assert.ok(promptBytes('plan') <= 16690, `plan reviewer prompt exceeds 16690 budget`);
  // NOTE: 12552 covers the input-producer clause in the design reviewer prompt.
  assert.ok(promptBytes('design') <= 12552, `design reviewer prompt exceeds 12552 budget`);
  const writer = templateBytes('writer-brief.md') + qualityBytes('writer');
  // NOTE: 10784 covers the writer contract and separate task and assigned-fix reply forms.
  assert.ok(writer <= 10784, `writer brief pack ${writer} exceeds 10784 budget`);
  const explorerBrief = templateBytes('explorer-brief.md');
  // NOTE: 7977 covers the explorer brief's split threshold, coherence, validation, reading, and output requirements.
  assert.ok(explorerBrief <= 7977, `explorer brief template ${explorerBrief} exceeds 7977 budget`);
  const explorer = explorerBrief + templateBytes('context-map.md') + qualityBytes('explorer');
  assert.ok(explorer <= 12638, `explorer pack ${explorer} exceeds 12638 budget`);
  const cleanupQuality = qualityBytes('cleanup');
  assert.ok(cleanupQuality <= 7653, `test-cleanup rendered quality ${cleanupQuality} exceeds 7653 budget`);
  assert.ok(templateBytes('verifier-brief.md') <= 4096, 'verifier brief exceeds 4096 bytes');
  const cleanupBrief = templateBytes('test-cleanup-brief.md');
  assert.ok(cleanupBrief <= 1870, `test-cleanup brief template ${cleanupBrief} exceeds 1870 budget`);
  const cleanup = cleanupBrief + cleanupQuality;
  assert.ok(cleanup <= 9523, `test-cleanup pack ${cleanup} exceeds 9523 budget`);
  // NOTE: The hand-filled brief needs its own budget for the child authority and reply contract.
  const incrementBrief = templateBytes('increment-orchestrator-brief.md');
  assert.ok(incrementBrief <= 4096, `increment orchestrator brief ${incrementBrief} exceeds 4096 bytes`);
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
      { phase: 'test-cleanup', from: commit, fromTree: commit, to: commit, removed: ['SC1'], deleted: 1, merged: 0, trees: { SC1: commit } },
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

// Split dense prose first; raise this cap only with the reason beside it.
test('reference prose lines stay within the line byte cap', () => {
  const skill = path.join(root, 'skills/dispatch');
  const files = ['SKILL.md', ...fs.readdirSync(path.join(skill, 'references'), { recursive: true })
    .map(String).map(file => `references/${file.replaceAll('\\', '/')}`)
    .filter(file => file.endsWith('.md') && !file.startsWith('references/readme/') && file !== 'references/templates/quality-bar.md')];
  for (const file of files) {
    let fence: string | null = null;
    for (const [index, line] of fs.readFileSync(path.join(skill, file), 'utf8').split(/\r?\n/).entries()) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker[0]!;
        else if (marker[0] === fence) fence = null;
        continue;
      }
      if (fence || /^\s*\|/.test(line)) continue;
      const bytes = Buffer.byteLength(line);
      assert.ok(bytes <= 1200, `${file}:${index + 1} is ${bytes} bytes; split first, else raise the cap with the reason beside it`);
    }
  }
});
