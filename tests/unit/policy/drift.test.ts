import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChange } from '../../../skills/dispatch/scripts/policy/drift.ts';
const base = { paths: ['src/a.ts'], expectedPaths: [], ownedPaths: [], inputs: [], dependenciesComplete: false };
test('relevance filter: valid expected output stays quiet without granting authority', () => { assert.equal(classifyChange({ ...base, expectedPaths: ['src/a.ts'] }).relevance, 'expected'); });
test('relevance filter: incomplete dependency coverage and caller-dirty inputs remain unknown', () => { assert.equal(classifyChange(base).relevance, 'unknown'); assert.equal(classifyChange({ ...base, paths: ['README.md'] }).relevance, 'unknown'); });
test('relevance filter: complete disjoint inputs establish irrelevance', () => { assert.equal(classifyChange({ ...base, dependenciesComplete: true }).relevance, 'irrelevant'); });
test('relevance filter: governed inputs and comparison changes are relevant', () => { assert.equal(classifyChange({ ...base, inputs: ['src/a.ts'] }).relevance, 'relevant'); assert.equal(classifyChange({ ...base, identityChanged: true }).relevance, 'relevant'); });
test('relevance filter: exact driver ownership does not exempt sibling scratch files', () => { assert.equal(classifyChange({ ...base, paths: ['.scratch/run/notes'], ownedPaths: ['.scratch/run/walkthrough'] }).relevance, 'unknown'); });
