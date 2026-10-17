import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderCompactResolutionSection, renderReport, renderResolutionSection, renderWalkthrough, replaceResolutionSection, reviewLogPathOf } from '../../../skills/dispatch/scripts/domain/render.ts';
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
  assert.ok(report.startsWith('# Code review\n\n> **Summary:** 1 fixed'));
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

test('compact-findings: deliverable keeps summary table and log keeps full entries', () => {
  assert.equal(reviewLogPathOf('s/x.plan.md'), 's/x.review-log.md');
  assert.equal(reviewLogPathOf('s\\x.design.md'), 's\\x.review-log.md');
  assert.equal(reviewLogPathOf('s/x.walkthrough.md'), 's/x.walkthrough.review-log.md');
  const input = [{ ...rounds[0]!, entries: [{ ...rounds[0]!.entries[0]!, defect: 'The loop spins forever. The second sentence explains the cause.', requiredChange: 'Bound the loop.', resolution: 'Keep the interface.\nAdd the counter.' }, rounds[0]!.entries[1]!] },
    { round: 2, reviewers: [], failed: [], entries: [{ ...rounds[0]!.entries[0]!, id: 'R2-F001', status: 'rejected' as const, severity: 'CONSIDER' as const, resolution: 'Out | of scope.' }] }];
  const section = renderResolutionSection(input);
  const prior = replaceResolutionSection('# Review log\n', renderResolutionSection([{ ...rounds[0]!, entries: [{ ...rounds[0]!.entries[0]!, id: 'R1-F009', resolution: 'Prior ruling.' }] }]), 'run-1');
  const log = replaceResolutionSection(prior, section, 'run-2');
  assert.equal(replaceResolutionSection(log, section, 'run-2'), log);
  assert.match(log, /### Review run-1[\s\S]*##### R1-F009[\s\S]*### Review run-2\n\n#### Round 1[\s\S]*##### R1-F001/);
  assert.match(log, /Finding: The loop spins forever. The second sentence explains the cause./);
  assert.match(log, /Required change: Bound the loop./);
  assert.match(log, /- Ruling:\n  Keep the interface.  \n  Add the counter.  \n/);
  const compact = renderCompactResolutionSection(log, 'x.review-log.md');
  assert.equal(renderCompactResolutionSection(log, 'x.review-log.md'), compact);
  assert.ok(compact.startsWith('## Review Findings & Resolutions\n\n'));
  assert.match(compact, /Reviews: 2 · Rounds: 3 · Findings: 4 \(Fixed 2, Duplicate 1, Rejected 1\) · Full log: \[x\.review-log\.md\]\(x\.review-log\.md\)/);
  assert.equal((compact.match(/\]\(/g) ?? []).length, 1);
  assert.match(compact, /\| Review \| ID \| Round \| Severity \| Status \| Ruling \|/);
  assert.match(compact, /\| 1 \| R1-F009 \| 1 \| MUST \| Fixed \| Prior ruling\. \|/);
  assert.match(compact, /\| 2 \| R1-F001 \| 1 \| MUST \| Fixed \| Keep the interface\. \|/);
  assert.match(compact, /\| 2 \| R1-F002 \| 1 \| SHOULD \| Duplicate \| — \|/);
  assert.match(compact, /\| 2 \| R2-F001 \| 2 \| CONSIDER \| Rejected \| Out \\\| of scope\. \|/);
  assert.equal((compact.match(/^\| \d+ \| R\d-F\d{3} /gm) ?? []).length, 4);
  assert.ok(!/^#{3,} /m.test(compact));
  assert.ok(!compact.includes('Finding:'));
  assert.match(renderCompactResolutionSection('# Review log\n', 'a b.review-log.md'), /Findings: 0 · Full log: \[a b\.review-log\.md\]\(<a b\.review-log\.md>\)/);
});

test('compact-ruling-clip: long rulings are cut in the table and kept whole in the log', () => {
  const long = `Keep the interface ${'and document the reason '.repeat(6)}end.`;
  const log = replaceResolutionSection('# Review log\n', renderResolutionSection([{ ...rounds[0]!, entries: [{ ...rounds[0]!.entries[0]!, resolution: long }] }]), 'run-1');
  assert.ok(log.includes(long));
  const row = renderCompactResolutionSection(log, 'x.review-log.md').split('\n').find((text) => text.startsWith('| 1 | R1-F001 '))!;
  const cell = row.split(' | ').at(-1)!.replace(/ \|$/, '');
  assert.equal(cell.length, 80);
  assert.ok(cell.endsWith('…'));
  assert.ok(long.startsWith(cell.slice(0, -1)));
  const emoji = renderCompactResolutionSection(replaceResolutionSection('# Review log\n', renderResolutionSection([{ ...rounds[0]!, entries: [{ ...rounds[0]!.entries[0]!, resolution: '😀'.repeat(100) }] }]), 'run-1'), 'x.review-log.md');
  assert.ok(emoji.includes(`| ${'😀'.repeat(79)}… |`));
});

test('compact-review-number: ungrouped history counts as run 1 before keyed runs', () => {
  const ungrouped = replaceResolutionSection('# Review log\n', renderResolutionSection(rounds));
  const log = replaceResolutionSection(ungrouped, renderResolutionSection([{ ...rounds[0]!, entries: [{ ...rounds[0]!.entries[0]!, id: 'R1-F001' }] }]), 'run-2');
  const compact = renderCompactResolutionSection(log, 'x.review-log.md');
  assert.match(compact, /^\| 1 \| R1-F001 \|/m);
  assert.match(compact, /^\| 1 \| R1-F002 \|/m);
  assert.match(compact, /^\| 2 \| R1-F001 \|/m);
});

test('report-summary-table: report lists summary table before full entries', () => {
  const report = renderReport({ title: 'Code review', kind: 'code', target: 'HEAD~1..HEAD', summary: '1 fixed', rounds });
  const table = report.indexOf('| Review | ID | Round | Severity | Status | Ruling |');
  assert.ok(table > report.indexOf('## Review Findings & Resolutions'));
  assert.ok(table < report.indexOf('### Round 1'));
  assert.ok(report.indexOf('Findings: 2 (Fixed 1, Duplicate 1)') < table);
  assert.ok(!report.includes('Full log:'));
  assert.match(report, /\| 1 \| R1-F001 \| 1 \| MUST \| Fixed \| bounded \|/);
  assert.match(report, /#### R1-F001\n\n- Status: \*\*\[Fixed\]\*\*/);
  assert.match(report, /#### R1-F002\n\n- Status: \*\*\[Duplicate\]\*\*/);
  assert.ok(!renderReport({ title: 'Review', kind: 'code', target: 'HEAD', summary: 'none', rounds: [] }).includes('| ID |'));
});

test('readable artifact rendering: complete findings retain sanitized technical text without invented rulings', () => {
  for (const defect of ['No terminator or safe boundary', 'Use e.g. This example.', 'Call `helper.ts`. This fails.', 'The URL is https://a.example/path. This fails.', 'Use Dr. Smith. More detail.']) {
    const { resolution: _resolution, ...entry } = rounds[0]!.entries[0]!;
    const output = renderResolutionSection([{ ...rounds[0]!, entries: [{ ...entry, defect }] }]);
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

test('readable artifact rendering: summary lines and nested notes preserve verification', () => {
  const output = renderWalkthrough({ ...view, changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'Add counter.\nKeep API.' }] });
  assert.equal((output.match(/^> \*\*.*$/gm) ?? []).length, 4);
  assert.equal((output.match(/^>$/gm) ?? []).length, 4);
  assert.match(output, /- #### \[MODIFY\] `src\/a.ts`\n  - Changes: Add counter.  \n    Keep API./);
  assert.ok(output.includes('Final gate: `npm test` exit 0'));
  assert.ok(output.includes('stops \\| at three'));
  assert.ok(!output.includes('\n\n\n## Verification'));
});

test('readable artifact rendering: continuation markers remain note text', () => {
  const output = renderWalkthrough({ ...view, changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'Changed.\n# heading\n```md\n- list\n| table\n1. ordered\n===\n___\n<div>\n<!-- comment -->' }] });
  for (const marker of ['\\# heading', '\\```md', '\\- list', '\\| table', '1\\. ordered', '\\===', '\\___', '\\<div>']) assert.ok(output.includes(`    ${marker}  \n`));
  assert.ok(!output.includes('<!--'));
});

test('readable artifact rendering: report leads with recorded summary and unresolved actions', () => {
  const report = renderReport({ title: 'Review', kind: 'code', target: 'HEAD', summary: 'Recorded state', rounds });
  assert.match(report, /> \*\*Summary:\*\* Recorded state\n>\n> \*\*Kind:/);
  assert.ok(report.startsWith('# Review\n\n> **Summary:** Recorded state\n>\n'));
  assert.match(report, /Required action:.*failed reviewer coverage/);
  for (const status of ['accepted', 'pending-rejection', 'needs-user', 'deferred'] as const) {
    const output = renderReport({ title: 'Review', kind: 'plan', target: 'plan', summary: 'Recorded', rounds: [{ ...rounds[0]!, failed: [], entries: [{ ...rounds[0]!.entries[0]!, status }] }] });
    assert.match(output, /Required action:.*R1-F001/);
    if (status === 'accepted') assert.match(output, /apply or verify accepted change/);
  }
  for (const status of ['fixed', 'rejected', 'downgraded', 'closed-by-reviewer', 'closed-by-orchestrator', 'duplicate'] as const) {
    const output = renderReport({ title: 'Review', kind: 'plan', target: 'plan', summary: 'Recorded', rounds: [{ ...rounds[0]!, failed: [], entries: [{ ...rounds[0]!.entries[0]!, status }] }] });
    assert.match(output, /Required action: No action recorded/);
  }
  assert.match(renderReport({ title: 'Review', kind: 'code', target: 'HEAD', summary: 'Not reviewed', rounds: [] }), /No action recorded/);
});

test('resolution entry renders reviewer tag line', () => {
  const entry = { ...rounds[0]!.entries[0]!, category: 'uncategorized', originalTag: 'robust<!--x-->ness' };
  const section = renderResolutionSection([{ ...rounds[0]!, entries: [entry] }]);
  assert.match(section, /- Category: uncategorized\n- Reviewer tag: robust&lt;!--x--&gt;ness\n- Finding:/);
  assert.ok(!section.includes('<!--'));
});

test('resolution entry without original tag has no reviewer tag line', () => {
  const section = renderResolutionSection(rounds);
  assert.ok(!section.includes('Reviewer tag'));
  assert.match(section, /- Category: correctness\n- Finding:/);
});

test('superseded finding renders Superseded', () => {
  const entry = { ...rounds[0]!.entries[0]!, status: 'superseded' as const };
  const round = { ...rounds[0]!, entries: [entry], failed: [] };
  const output = renderResolutionSection([round]);
  assert.ok(output.includes('**[Superseded]**'));
  assert.ok(!output.includes('Rejected'));
  assert.match(renderReport({ title: 'Review', summary: 'done', kind: 'code', target: 'main..HEAD', rounds: [round] }), /Required action: No action recorded/);
});
