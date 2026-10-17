import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyChange, type ChangeInput, type Relevance } from '../../../skills/dispatch/scripts/policy/drift.ts';

const base: ChangeInput = { paths: ['src/a.ts'], expectedPaths: [], ownedPaths: [], inputs: [], dependenciesComplete: false };

// SECTION: Relevance classification

test('relevance suggestion: classifies change relevance from expected, governed, or dependency boundaries', () => {
  const cases: [string, ChangeInput, Relevance, RegExp?][] = [
    ['expected when matching expectedPaths', { ...base, expectedPaths: ['src/a.ts'] }, 'expected'],
    ['unknown when dependency coverage is incomplete', base, 'unknown'],
    ['unknown when caller-dirty input path changed', { ...base, paths: ['README.md'] }, 'unknown'],
    ['unknown when driver ownedPaths do not cover sibling scratch files', { ...base, paths: ['.scratch/run/notes'], ownedPaths: ['.scratch/run/walkthrough'] }, 'unknown'],
    ['irrelevant when disjoint inputs and dependencies complete', { ...base, dependenciesComplete: true }, 'irrelevant', /suggests/],
    ['relevant when governed input changed', { ...base, inputs: ['src/a.ts'] }, 'relevant'],
    ['relevant when identity changed', { ...base, identityChanged: true }, 'relevant', /suggestion/],
  ];
  for (const [desc, input, expectedRelevance, reasonPattern] of cases) {
    const result = classifyChange(input);
    assert.equal(result.relevance, expectedRelevance, desc);
    if (reasonPattern) assert.match(result.reason, reasonPattern, desc);
  }
});

// SECTION: Path normalization

test('relevance suggestion: complete path observation keeps every changed path', () => {
  assert.deepEqual(classifyChange({ ...base, paths: ['./b.ts', 'a\\c.ts', 'b.ts'] }).paths, ['a/c.ts', 'b.ts']);
});
