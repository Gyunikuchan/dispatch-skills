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
