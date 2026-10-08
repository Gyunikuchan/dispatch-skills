import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderReport, renderResolutionSection, renderWalkthrough, replaceResolutionSection } from '../../../skills/dispatch/scripts/domain/render.ts';
import type { ResolutionRound, WalkthroughView } from '../../../skills/dispatch/scripts/domain/types.ts';

const rounds: ResolutionRound[] = [{
  round: 1,
  reviewers: [{ slot: 'codex[0]', model: 'gpt-5', effort: 'high' }],
  failed: [{ slot: 'agy[0]', reason: 'quota <!-- hide -->' }],
  entries: [
    { id: 'R1-F001', severity: 'MUST', status: 'fixed', sources: ['codex[0]'], locus: 'src/a.ts:L3', category: 'correctness', defect: 'loop <!-- x --> spins', resolution: 'bounded' },
    { id: 'R1-F002', severity: 'SHOULD', status: 'duplicate', sources: ['codex[0]'], locus: 'src/a.ts:L4', category: 'correctness', defect: 'same', dupOf: 'R1-F001' },
  ],
}];

const view: WalkthroughView = {
  title: 'Add retry budget', delivered: 'Retries stop after three attempts', parent: 'user request', status: '1/1 SC passing',
  context: { ask: 'cap retries', decisions: ['three attempts (user)'] },
  changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'adds the counter' }],
  verification: [{ sc: 'SC1', outcome: 'stops | at three', evidence: 'red→green' }],
  finalGate: '`npm test` exit 0', deviations: [], followUps: ['tune backoff'], revisions: [], rounds,
};

test('walkthrough-minimum-contract: sections in order; Context only for a user-request parent; no <!--', () => {
  const out = renderWalkthrough(view);
  const order = ['# Add retry budget', '> **Delivered:**', '> **Parent:** user request', '> **Status:** 1/1 SC passing', '> **Deviations:** none',
    '## Context', '## Changes Made', '## Verification', '| SC | Outcome | Evidence |', 'Final gate:', '## Deviations & Follow-ups', '## Review Findings & Resolutions'];
  let at = -1;
  for (const marker of order) { const next = out.indexOf(marker); assert.ok(next > at, marker); at = next; }
  assert.ok(out.includes('stops \\| at three'));
  assert.ok(renderWalkthrough({ ...view, verification: [{ sc: 'SC1', outcome: 'a\\|b', evidence: '-' }] }).includes('a\\\\\\|b'));
  assert.ok(out.includes('- Follow-up: tune backoff'));
  assert.ok(!out.includes('## Revision Log'));
  assert.ok(!out.includes('<!--'));
  const planParent = renderWalkthrough({ ...view, parent: '.scratch/x/x.plan.md', revisions: [{ artifact: 'plan', reason: 'SC2 split' }] });
  assert.ok(!planParent.includes('## Context'));
  assert.ok(planParent.indexOf('## Revision Log') < planParent.indexOf('## Review Findings & Resolutions'));
});

test('walkthrough-minimum-contract: resolution and report sections render rounds, reviewers, failed targets, statuses', () => {
  const section = renderResolutionSection(rounds);
  assert.ok(section.includes('### Round 1'));
  assert.ok(section.includes('- Reviewers: codex[0] gpt-5 (high)'));
  assert.ok(section.includes('- Failed: agy[0] (quota'));
  assert.match(section, /#### R1-F001\n\n- Status: \*\*\[Fixed\]\*\*\n- Severity: MUST/);
  assert.ok(section.includes('[dup=R1-F001]'));
  assert.ok(!section.includes('<!--'));
  assert.ok(renderResolutionSection([]).includes('*No reviews conducted yet.*'));
  const report = renderReport({ title: 'Code review', kind: 'code', target: 'HEAD~1..HEAD', summary: '1 fixed', rounds });
  assert.ok(report.startsWith('# Code review\n\n> **Kind:** code review'));
  assert.ok(!report.includes('<!--'));
});

test('walkthrough-minimum-contract: replaceResolutionSection swaps only the exact heading section', () => {
  const doc = '# T\n\n```md\n## Review Findings & Resolutions\n```\n\n## Review Findings & Resolutions\nold\n\n## Out of Scope\nkeep\n';
  const out = replaceResolutionSection(doc, renderResolutionSection([]));
  assert.ok(out.includes('```md\n## Review Findings & Resolutions\n```'));
  assert.ok(!out.includes('old'));
  assert.ok(out.includes('## Out of Scope\nkeep'));
  assert.ok(replaceResolutionSection('# T\n', 'X').endsWith('# T\n\nX\n'));
});

test('walkthrough-minimum-contract: comment markers in change paths are neutralised', () => {
  const out = renderWalkthrough({ ...view, changes: [{ action: 'NEW', path: 'a<!--b.ts', note: 'x' }] });
  assert.ok(!out.includes('<!--'));
});

test('walkthrough-minimum-contract: change lines use a spaced em-dash', () => {
  assert.ok(renderWalkthrough(view).includes('- **[MODIFY]** `src/a.ts` — adds the counter'));
});

test('walkthrough-minimum-contract: an info-string fence line does not close an open fence', () => {
  const doc = ['# D', '```', '```md', '## Review Findings & Resolutions', 'example', '```', '', '## Review Findings & Resolutions', 'old'].join('\n');
  const out = replaceResolutionSection(doc, '## Review Findings & Resolutions\nnew');
  assert.ok(out.includes('example') && out.includes('new') && !out.includes('old'));
});


test('review history preserves prior runs and updates the current run without duplicates', () => {
  const original = '# Plan\n\n## Review Findings & Resolutions\nNo reviews conducted yet.\n\n## Out of Scope\nkeep\n';
  const first = replaceResolutionSection(original, renderResolutionSection(rounds), 'run-1');
  const second = replaceResolutionSection(first, renderResolutionSection([]), 'run-2');
  const updated = replaceResolutionSection(second, renderResolutionSection([{ ...rounds[0]!, entries: [] }]), 'run-1');
  assert.equal((updated.match(/### Review run-1/g) ?? []).length, 1);
  assert.match(updated, /### Review run-2/);
  assert.ok(!updated.includes('R1-F001'));
  assert.match(updated, /## Out of Scope\nkeep/);
  assert.equal(replaceResolutionSection(updated, renderResolutionSection([{ ...rounds[0]!, entries: [] }]), 'run-1'), updated);
});

test('review history retains existing ungrouped rounds', () => {
  const original = replaceResolutionSection('# Plan\n', renderResolutionSection(rounds));
  const updated = replaceResolutionSection(original, renderResolutionSection([]), 'new-run');
  assert.match(updated, /### Round 1[\s\S]*R1-F001[\s\S]*### Review new-run/);
});

test('readable review rendering: excerpts link full findings and preserve exact multiline rulings', () => {
  const input = [{ ...rounds[0]!, entries: [{ ...rounds[0]!.entries[0]!, defect: 'The loop spins forever. The second sentence explains the cause.', requiredChange: 'Bound the loop.', resolution: 'Keep the interface.\nAdd the counter.' }] }];
  const excerpt = renderResolutionSection(input, { mode: 'excerpt', reportRef: '../full%20report.md' });
  assert.match(excerpt, /- Finding excerpt: The loop spins forever.\n/);
  assert.ok(!excerpt.includes('second sentence'));
  assert.match(excerpt, /- Ruling:\n  Keep the interface.  \n  Add the counter.  \n/);
  assert.match(excerpt, /\[R1-F001\]\(\.\.\/full%20report.md#r1-f001\)/);
  const full = renderReport({ title: 'Review', target: 'plan.md', kind: 'plan', summary: 'Recorded', rounds: input });
  assert.match(full, /#### R1-F001/);
  assert.match(full, /The second sentence explains the cause./);
  assert.match(full, /Required change: Bound the loop./);
  const owned = replaceResolutionSection('# Plan\n', excerpt, 'run');
  assert.match(owned, /### Review run\n\n#### Round 1[\s\S]*##### R1-F001/);
  assert.equal(replaceResolutionSection(owned, excerpt, 'run'), owned);
});

test('readable review rendering: ambiguous sentence boundaries retain the complete finding', () => {
  for (const defect of ['No terminator or safe boundary', 'Use e.g. This example.', 'Call `helper.ts`. This fails.', 'The URL is https://a.example/path. This fails.', 'Use Dr. Smith. More detail.']) {
    const { resolution: _resolution, ...entry } = rounds[0]!.entries[0]!;
    const output = renderResolutionSection([{ ...rounds[0]!, entries: [{ ...entry, defect }] }], { mode: 'excerpt' });
    // Existing sanitization removes code delimiters before rendering.
    assert.ok(output.includes(defect.replace(/`/g, '')));
    assert.ok(!output.includes('- Ruling:'));
  }
});

test('readable review rendering: all dispositions, duplicate relations, failed and empty rounds survive', () => {
  const statuses = ['accepted', 'fixed', 'rejected', 'pending-rejection', 'downgraded', 'needs-user', 'closed-by-reviewer', 'closed-by-orchestrator', 'duplicate', 'deferred'] as const;
  const output = renderResolutionSection([{ ...rounds[0]!, entries: statuses.map(status => ({ ...rounds[0]!.entries[0]!, status })) }, { round: 2, reviewers: [], failed: [], entries: [] }]);
  for (const label of ['Accepted', 'Fixed', 'Rejected', 'Rejected — Pending Confirmation', 'Downgraded', 'Needs User', 'Rejected — Closed by Reviewer', 'Rejected — Closed by Orchestrator', 'Duplicate', 'Deferred']) assert.ok(output.includes(`**[${label}]**`));
  assert.match(output, /- Sources: codex\[0\]\n- Location: src\/a.ts:L3\n- Category: correctness/);
  assert.match(output, /### Round 2\n\n- Reviewers: none\n- No findings./);
  assert.match(renderResolutionSection(rounds), /Duplicate: R1-F001 \[dup=R1-F001\]/);
  assert.match(renderResolutionSection(rounds, { mode: 'excerpt', reportRef: 'review.report.md' }), /Duplicate: \[R1-F001\]\(review.report.md#r1-f001\)/);
  assert.ok(!output.includes('<!--'));
});

test('readable review rendering: retained duplicate IDs do not link to another review run', () => {
  const section = renderResolutionSection(rounds);
  const first = replaceResolutionSection('# Plan\n', section, 'run-1');
  const history = replaceResolutionSection(first, section, 'run-2');
  assert.equal((history.match(/Duplicate: R1-F001 \[dup=R1-F001\]/g) ?? []).length, 2);
  assert.ok(!history.includes('](#r1-f001)'));
  assert.equal(replaceResolutionSection(history, section, 'run-2'), history);
});
