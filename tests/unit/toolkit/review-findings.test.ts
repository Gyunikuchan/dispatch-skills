import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { renderFindingsSection, reviewRows, refreshFindingsSection, rulingReview } from '../../../skills/dispatch/scripts/toolkit/review-findings.ts';
import type { Manifest } from '../../../skills/dispatch/scripts/lib/session.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-findings-'));
  const session = path.join(root, '.scratch', 'dispatch-skills', '20261028T0000Z-review-findings');
  const docs = path.join(root, 'docs');
  fs.mkdirSync(session, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  return {
    root, session, docs,
    manifest: { repositoryRoot: root } as Manifest,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function addRound(session: string, review: string, round: number, findings: readonly object[], roster: readonly object[] = [], generation = 1): void {
  const directory = path.join(session, '.state', 'reviews', review, `round-${round}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'round.json'), JSON.stringify({ round, generation, cap: 2, roster }));
  fs.writeFileSync(path.join(directory, 'findings.json'), JSON.stringify({ review, round, findings }));
}

function addSlotOutcome(session: string, review: string, round: number, generation: number, physicalSlot: string, outcome: object): void {
  const directory = path.join(session, '.state', 'reviews', review, `round-${round}`, `gen-${generation}`, 'slots');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${physicalSlot}.json`), JSON.stringify(outcome) + '\n');
}

function bind(f: ReturnType<typeof fixture>): void {
  const plan = path.join(f.docs, 'work.plan.md');
  const design = path.join(f.docs, 'strategy.design.md');
  fs.writeFileSync(path.join(f.session, 'ledger.jsonl'), JSON.stringify({
    kind: 'bind', by: 'orchestrator', key: 'bind', seq: 1, at: '2026-10-28T00:00:00.000Z',
    data: { spec: 'mission.spec.md', plan: path.relative(f.root, plan), design: path.relative(f.root, design) },
  }) + '\n');
}

test('completed CLEAN rounds render with per-round relative links', () => {
  const f = fixture();
  try {
    const review = 'plan-work.plan';
    addRound(f.session, review, 1, [{ id: 'R1-F001', severity: 'SHOULD' }]);
    addRound(f.session, review, 2, []);
    const result = reviewRows(f.session, foldLedger(f.session), [], [review]);
    const rendered = renderFindingsSection(result.rows, result.rounds.map(round => ({ ...round, path: path.resolve(f.session, round.path) })), path.join(f.session, 'docs'));

    assert.equal(result.rounds.length, 2);
    assert.match(rendered, /\| plan-work\.plan \| R1-F001 \| 1 \| SHOULD \| — \| Open \|/);
    assert.match(rendered, /Round 1 \(plan-work\.plan\): 1 findings — \[findings\]\(\.\.\/\.state\/reviews\/plan-work\.plan\/round-1\/findings\.json\)/);
    assert.match(rendered, /Round 2 \(plan-work\.plan\): 0 findings — \[findings\]\(\.\.\/\.state\/reviews\/plan-work\.plan\/round-2\/findings\.json\)/);
    assert.doesNotMatch(rendered, /No reviews conducted yet/);
  } finally { f.cleanup(); }
});

test('findings sources use current responder metadata and explicit unknowns', () => {
  const f = fixture();
  try {
    const review = 'plan-work.plan';
    const sources = ['reviewer[0]', 'reserve-target[0]', 'native[0]', 'historical[0]', 'null[0]'];
    addRound(f.session, review, 1, [{ id: 'R1-F001', severity: 'MUST', sources }], [
      { slot: 'reviewer[0]', provider: 'claude', model: ['configured-first', 'configured-fallback'], effort: 'low' },
      { slot: 'reserve-target[0]', provider: 'claude', model: ['target-configured'], effort: 'low' },
      { slot: 'reserve[0]', provider: 'codex', model: ['reserve-configured'], effort: 'xhigh', reserve: true },
      { slot: 'native[0]', provider: 'codex', model: ['native-configured'], effort: 'low', native: true },
      { slot: 'historical[0]', provider: 'claude', model: ['legacy-first', 'legacy-fallback'], effort: 'medium' },
      { slot: 'null[0]', provider: 'opencode', model: ['opencode-configured'], effort: 'medium' },
    ], 2);
    addSlotOutcome(f.session, review, 1, 1, 'reviewer[0]', {
      slot: 'reviewer[0]', state: 'done', text: 'stale',
      responder: { slot: 'reviewer[0]', provider: 'claude', model: 'stale-generation-model', native: false },
    });
    addSlotOutcome(f.session, review, 1, 2, 'reviewer[0]', {
      slot: 'reviewer[0]', state: 'done', text: 'fallback response',
      responder: { slot: 'reviewer[0]', provider: 'claude', model: 'actual-fallback', native: false },
    });
    addSlotOutcome(f.session, review, 1, 2, 'reserve[0]', {
      slot: 'reserve-target[0]', state: 'done', text: 'reserve response',
      responder: { slot: 'reserve[0]', provider: 'codex', model: 'reserve-actual', native: false },
    });
    addSlotOutcome(f.session, review, 1, 2, 'native[0]', {
      slot: 'native[0]', state: 'done', text: 'native response',
      responder: { slot: 'native[0]', provider: 'codex', model: 'native-model', native: true },
    });
    addSlotOutcome(f.session, review, 1, 2, 'historical[0]', {
      slot: 'historical[0]', state: 'done', text: 'historical response',
    });
    addSlotOutcome(f.session, review, 1, 2, 'null[0]', {
      slot: 'null[0]', state: 'done', text: 'null-model response',
      responder: { slot: 'null[0]', provider: 'opencode', model: null, native: false },
    });
    const result = reviewRows(f.session, foldLedger(f.session), [], [review]);

    const expected = [
      'actual-fallback/low',
      'reserve-actual/xhigh',
      'native-model',
      'unknown (claude/historical[0])',
      'unknown (opencode/null[0])/medium',
    ];
    assert.deepEqual(result.rows[0]!.sources, expected);
    const rendered = renderFindingsSection(result.rows, [], f.docs);
    assert.ok(rendered.includes(`| MUST | ${expected.join(', ')} | Open |`));
  } finally { f.cleanup(); }
});

test('plan and design refresh only the findings section and preserve governed hashes', () => {
  const f = fixture();
  try {
    bind(f);
    const plan = path.join(f.docs, 'work.plan.md');
    const design = path.join(f.docs, 'strategy.design.md');
    const before = new Map([
      [plan, '# Work\r\n\r\n## Review Findings & Resolutions\r\nDriver notes\r\n\r\n## Next\r\nKeep this plan.\r\n'],
      [design, '# Strategy\r\n\r\n## Review Findings & Resolutions\r\nOld findings\r\n\r\n## Next\r\nKeep this design.\r\n'],
    ]);
    for (const [file, source] of before) fs.writeFileSync(file, source);
    addRound(f.session, 'plan-work.plan', 1, [{ id: 'R1-F001', severity: 'SHOULD', sources: ['plan-reviewer[0]'] }], [
      { slot: 'plan-reviewer[0]', provider: 'claude', model: ['configured-plan-reviewer'], effort: 'medium' },
    ]);
    addRound(f.session, 'design-strategy.design', 1, [{ id: 'R1-F001', severity: 'MUST' }]);
    addSlotOutcome(f.session, 'plan-work.plan', 1, 1, 'plan-reviewer[0]', {
      slot: 'plan-reviewer[0]', state: 'done', text: 'plan finding',
      responder: { slot: 'plan-reviewer[0]', provider: 'claude', model: 'actual-plan-reviewer', native: false },
    });

    for (const [kind, file, review] of [
      ['plan', plan, 'plan-work.plan'],
      ['design', design, 'design-strategy.design'],
    ] as const) {
      const original = before.get(file)!;
      const hash = artifactHash(kind, original);
      const suffix = original.slice(original.indexOf('## Next'));
      const first = refreshFindingsSection(f.session, f.manifest, review);
      assert.equal(first, 'updated');
      const updated = fs.readFileSync(file, 'utf8');
      assert.equal(updated.slice(0, updated.indexOf('## Review Findings & Resolutions')), original.slice(0, original.indexOf('## Review Findings & Resolutions')));
      assert.ok(updated.endsWith(suffix));
      assert.equal(artifactHash(kind, updated), hash);
      assert.match(updated, /Round 1/);
      if (kind === 'plan') assert.match(updated, /\| SHOULD \| actual-plan-reviewer\/medium \| Open \|/);
      assert.equal(refreshFindingsSection(f.session, f.manifest, review), 'unchanged');
    }
  } finally { f.cleanup(); }
});

test('refresh appends a missing findings section and skips unmatched reviews', () => {
  const f = fixture();
  try {
    bind(f);
    const plan = path.join(f.docs, 'work.plan.md');
    fs.writeFileSync(plan, '# Work\n\n## Next\nKeep this plan.\n');
    addRound(f.session, 'plan-work.plan', 1, [{ id: 'R1-F001', severity: 'SHOULD' }]);

    let reason = '';
    const unmatched = refreshFindingsSection(f.session, f.manifest, 'plan-other.plan', detail => { reason = detail; });
    assert.equal(unmatched, 'skipped');
    assert.match(reason, /bound/i);
    assert.equal(fs.readFileSync(plan, 'utf8'), '# Work\n\n## Next\nKeep this plan.\n');

    const appended = refreshFindingsSection(f.session, f.manifest, 'plan-work.plan');
    assert.equal(appended, 'updated');
    const source = fs.readFileSync(plan, 'utf8');
    assert.match(source, /## Review Findings & Resolutions/);
    assert.match(source, /Round 1 \(plan-work\.plan\): 1 findings/);
    assert.match(source, /## Next\nKeep this plan\./);
  } finally { f.cleanup(); }
});

test('rulingReview accepts only plan and design review finding subjects', () => {
  assert.equal(rulingReview('review:plan-work.plan:R1-F001'), 'plan-work.plan');
  assert.equal(rulingReview('review:design-strategy.design:R12-F009'), 'design-strategy.design');
  assert.equal(rulingReview('review:code-src-file:R1-F001'), null);
  assert.equal(rulingReview('review:plan-work.plan:not-a-finding'), null);
});

// SECTION: Corrected severity in rendered rows

function ledgerWith(f: ReturnType<typeof fixture>, rulings: readonly object[]): void {
  const rows = rulings.map((data, index) => ({kind: 'ruling', by: 'orchestrator', key: 'r' + index, seq: index + 1, at: '2026-10-28T00:00:00.000Z', data: {subject: 'review:plan-work.plan:R1-F001', ...data}}));
  fs.writeFileSync(path.join(f.session, 'ledger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
const DEGRADES = {ruling: 'accepted', impact: 'degrades', trigger: 'realistic', rationale: 'impact: the Verify gate surfaces this gap'};
const BLOCKS = {ruling: 'accepted', impact: 'blocks', trigger: 'realistic', rationale: 'impact: the promised outcome fails'};

test('corrected severity: rows reflect latest corrected severity rules across accepted, deferred, and rejected rulings', () => {
  const cases: [string, string, readonly object[], string, string | undefined][] = [
    ['MUST', 'blocks', [DEGRADES], 'SHOULD', 'MUST'],
    ['MUST', 'blocks', [DEGRADES, {ruling: 'deferred', rationale: 'Later'}], 'SHOULD', 'MUST'],
    ['MUST', 'blocks', [DEGRADES, {ruling: 'accepted', rationale: 'Applied the fix'}], 'SHOULD', 'MUST'],
    ['SHOULD', 'degrades', [BLOCKS], 'MUST', undefined],
    ['SHOULD', 'degrades', [BLOCKS, DEGRADES], 'SHOULD', undefined],
    ['MUST', 'blocks', [], 'MUST', undefined],
    ['MUST', 'blocks', [DEGRADES, {ruling: 'rejected', rationale: 'The code prevents it'}], 'MUST', undefined],
    ['SHOULD', 'degrades', [BLOCKS, {ruling: 'rejected', rationale: 'The code prevents it'}], 'MUST', undefined],
    ['SHOULD', 'degrades', [DEGRADES, {ruling: 'rejected', rationale: 'The code prevents it'}], 'SHOULD', undefined],
  ];
  const f = fixture();
  try {
    for (const [stored, impact, rulings, severity, downgradedFrom] of cases) {
      addRound(f.session, 'plan-work.plan', 1, [{id: 'R1-F001', severity: stored, impact, trigger: 'realistic'}]);
      ledgerWith(f, rulings);
      const [row] = reviewRows(f.session, foldLedger(f.session), [], ['plan-work.plan']).rows;
      assert.equal(row!.severity, severity, JSON.stringify(rulings));
      assert.equal(row!.downgradedFrom, downgradedFrom, JSON.stringify(rulings));
    }
  } finally { f.cleanup(); }
});

// SECTION: Budget summary

test('native responder shows configured effort beside the model', () => {
  const f = fixture();
  try {
    const review = 'plan-work.plan';
    addRound(f.session, review, 1, [{id: 'R1-F001', severity: 'MUST', sources: ['claude[0]', 'agy[0]']}], [
      {slot: 'claude[0]', provider: 'claude', model: ['a','b'], effort: 'high'},
      {slot: 'agy[0]', provider: 'agy', model: ['target-model'], effort: 'low'},
      {slot: 'codex[0]', provider: 'codex', model: ['reserve-model'], effort: 'xhigh', reserve: true},
    ], 1);
    addSlotOutcome(f.session, review, 1, 1, 'claude[0]', {
      slot: 'claude[0]', state: 'done', text: 'finding',
      responder: {slot: 'claude[0]', provider: 'claude', model: 'a', native: true, effort: 'high'},
    });
    addSlotOutcome(f.session, review, 1, 1, 'agy[0]', {
      slot: 'agy[0]', state: 'done', text: 'reserve finding',
      responder: {slot: 'agy[0]', provider: 'codex', model: 'reserve-model', native: true, effort: 'xhigh'},
    });
    const result = reviewRows(f.session, foldLedger(f.session), [], [review]);
    assert.deepEqual(result.rows[0]!.sources, ['a/high', 'reserve-model/xhigh']);
  } finally {f.cleanup();}
});

test('review summary refreshes budget from current ledger', () => {
  const f = fixture();
  try {
    bind(f);
    const plan = path.join(f.docs, 'work.plan.md');
    fs.writeFileSync(plan, '# Work\n\n## Review Findings & Resolutions\nDriver notes\n');
    addRound(f.session, 'plan-work.plan', 1, []);
    addRound(f.session, 'plan-work.plan', 2, [{ id: 'R2-F001', severity: 'MUST' }]);
    assert.equal(refreshFindingsSection(f.session, f.manifest, 'plan-work.plan'), 'updated');
    assert.match(fs.readFileSync(plan, 'utf8'), /Budget \(plan-work\.plan\): next round 3 requires-continuation \(cap 2, ceiling 4\)/);

    fs.appendFileSync(path.join(f.session, 'ledger.jsonl'), JSON.stringify({
      kind: 'ruling', by: 'orchestrator', key: 'accepted', seq: 2, at: '2026-10-28T00:00:00.000Z',
      data: { subject: 'review:plan-work.plan:R2-F001', ruling: 'accepted', rationale: 'Fixed' },
    }) + '\n');
    assert.equal(refreshFindingsSection(f.session, f.manifest, 'plan-work.plan'), 'updated');
    assert.match(fs.readFileSync(plan, 'utf8'), /Budget \(plan-work\.plan\): next round 3 allowed \(cap 2, ceiling 4\)/);
  } finally { f.cleanup(); }
});

test('origin: marker renders beside a recurrence marker', () => {
  const f = fixture();
  try {
    const review = 'plan-work.plan';
    addRound(f.session, review, 1, [
      { id: 'R1-F001', severity: 'SHOULD', origin: 'original' },
      { id: 'R1-F002', severity: 'SHOULD', recurrence: { of: 'R0-F001' }, origin: 'fix-induced' },
      { id: 'R1-F003', severity: 'SHOULD', origin: 'invented' },
    ]);
    const result = reviewRows(f.session, foldLedger(f.session), [], [review]);
    assert.deepEqual(result.rows.map(row => row.origin), ['original', 'fix-induced', undefined]);
    const rendered = renderFindingsSection(result.rows, [], f.session);
    assert.match(rendered, /\| Open \(origin original\) \|/);
    assert.match(rendered, /\| Open \(recurs R0-F001\) \(origin fix-induced\) \|/);
    assert.match(rendered, /R1-F003 \| 1 \| SHOULD \| — \| Open \|/);
  } finally { f.cleanup(); }
});
