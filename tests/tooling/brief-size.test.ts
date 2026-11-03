import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const loadBriefSize = () => import('../../scripts/brief-size.ts');

test('brief size reports preserve exact UTF-8 section accounting', async () => {
  const { measureBrief } = await loadBriefSize();
  const text = [
    '\uFEFFPreamble λ\r\n',
    '## Intro\r\n',
    'α🙂\r\n',
    '````markdown\r\n',
    '## hidden by backtick\r\n',
    '~~~~\r\n',
    '```\r\n',
    '````` \r\n',
    '~~~md\r\n',
    '## hidden by tilde\r\n',
    '~~~~~ \r\n',
    '## Intro\r\n',
    'End',
  ].join('');
  const report = measureBrief(text);
  assert.deepEqual(report, {
    totalBytes: 138,
    sections: [
      { heading: null, occurrence: 1, bytes: 16 },
      { heading: 'Intro', occurrence: 1, bytes: 109 },
      { heading: 'Intro', occurrence: 2, bytes: 13 },
    ],
  });
  assert.equal(Buffer.byteLength(text), 138);
  assert.equal(report.sections.reduce((total, section) => total + section.bytes, 0), report.totalBytes);

  assert.deepEqual(measureBrief(''), { totalBytes: 0, sections: [] });
  const unsectioned = measureBrief('plain 💾\ntext');
  assert.deepEqual(unsectioned, { totalBytes: 15, sections: [{ heading: null, occurrence: 1, bytes: 15 }] });
  assert.equal(unsectioned.sections.reduce((total, section) => total + section.bytes, 0), unsectioned.totalBytes);
});

test('brief size command reports inputs and errors without writes', async () => {
  const { runBriefSize } = await loadBriefSize();
  const reads: string[] = [], stdout: string[] = [], stderr: string[] = [];
  const io = {
    readText(file: string) {
      reads.push(file);
      if (file === 'missing.md') throw new Error('file unavailable');
      return file === 'first.md' ? '## First\nα' : 'Preamble';
    },
    writeStdout(text: string) { stdout.push(text); },
    writeStderr(text: string) { stderr.push(text); },
  };

  assert.equal(runBriefSize(['first.md', 'second.md'], io), 0);
  assert.deepEqual(reads, ['first.md', 'second.md']);
  assert.deepEqual(JSON.parse(stdout[0]!), [
    { file: 'first.md', totalBytes: 11, sections: [{ heading: 'First', occurrence: 1, bytes: 11 }] },
    { file: 'second.md', totalBytes: 8, sections: [{ heading: null, occurrence: 1, bytes: 8 }] },
  ]);
  assert.deepEqual(stderr, []);

  stdout.length = 0;
  assert.equal(runBriefSize([], io), 1);
  assert.match(stderr.at(-1) ?? '', /brief-file/);
  assert.equal(stdout.length, 0);
  assert.equal(runBriefSize(['missing.md'], io), 1);
  assert.match(stderr.at(-1) ?? '', /missing\.md.*file unavailable/);
  assert.equal(stdout.length, 0);
});

test('agent-consumed markdown files report soft byte-budget diagnostics via measureBrief', async (t) => {
  const { measureBrief } = await loadBriefSize();
  const files = [
    'skills/dispatch/SKILL.md',
    'skills/dispatch/references/artifact-readability.md',
    'skills/dispatch/references/decision-frame.md',
    'skills/dispatch/references/diagnostics.md',
    'skills/dispatch/references/glossary.md',
    'skills/dispatch/references/grounding.md',
    'skills/dispatch/references/providers.md',
    'skills/dispatch/references/review-rules.md',
    'skills/dispatch/references/self-build.md',
    'skills/dispatch/references/spec-stage.md',
    'skills/dispatch/references/toolkit.md',
    'skills/dispatch/references/worktree-cleanup.md',
    'skills/dispatch/references/verbs/ask.md',
    'skills/dispatch/references/verbs/design.md',
    'skills/dispatch/references/verbs/implement.md',
    'skills/dispatch/references/verbs/plan.md',
    'skills/dispatch/references/verbs/review.md',
    'skills/dispatch/references/templates/context-map.md',
    'skills/dispatch/references/templates/design.md',
    'skills/dispatch/references/templates/explorer-brief.md',
    'skills/dispatch/references/templates/plan.md',
    'skills/dispatch/references/templates/quality-bar.md',
    'skills/dispatch/references/templates/review-prompt-code.md',
    'skills/dispatch/references/templates/review-prompt-design.md',
    'skills/dispatch/references/templates/review-prompt-plan.md',
    'skills/dispatch/references/templates/review-prompt.md',
    'skills/dispatch/references/templates/review-severity.md',
    'skills/dispatch/references/templates/spec.md',
    'skills/dispatch/references/templates/test-cleanup-brief.md',
    'skills/dispatch/references/templates/walkthrough.md',
    'skills/dispatch/references/templates/writer-brief.md',
  ];
  const baselines: Record<string, number> = {
    'spec.md': 3365, 'plan.md': 13190, 'design.md': 4334, 'walkthrough.md': 4669,
    'quality-bar.md': 13710, 'toolkit.md': 27475, 'explorer-brief.md': 4701,
  };
  assert.equal(files.length, 31);
  let totalBytes = 0;
  for (const file of files) {
    const report = measureBrief(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
    assert.ok(Number.isFinite(report.totalBytes) && report.totalBytes > 0, file);
    for (const section of report.sections) assert.ok(Number.isFinite(section.bytes) && section.bytes > 0, file);
    totalBytes += report.totalBytes;
    const baseline = baselines[file.split('/').at(-1)!];
    if (baseline) t.diagnostic(`${file}: ${report.totalBytes} B; baseline ${baseline} B; delta ${report.totalBytes - baseline} B`);
  }
  assert.ok(Number.isFinite(totalBytes) && totalBytes > 0);
  t.diagnostic(`30 agent-consumed Markdown files: ${totalBytes} B; baseline 155687 B; delta ${totalBytes - 155687} B`);
  for (const [kind, baseline] of [['code', 13849], ['plan', 17847], ['design', 13132]] as const) {
    const file = `tests/fixtures/review-prompt-golden/${kind}.md`;
    const { totalBytes: bytes } = measureBrief(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
    t.diagnostic(`${file}: ${bytes} B; baseline ${baseline} B; delta ${bytes - baseline} B`);
  }
});
