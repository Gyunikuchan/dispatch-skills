import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env['TEXTSTATS_ROOT'];
if (!root) throw new Error('TEXTSTATS_ROOT must name the sample working copy');
const modulePath = pathToFileURL(path.join(root, 'src', 'text.js')).href;
const { wordFrequency } = await import(modulePath);

test('wordFrequency sorts by count and then word and respects top', () => {
  assert.deepEqual(wordFrequency('pear apple pear plum apple pear', { top: 2 }), [
    { word: 'pear', count: 3 },
    { word: 'apple', count: 2 },
  ]);
});

test('wordFrequency sorts equal counts alphabetically', () => {
  assert.deepEqual(wordFrequency('zebra apple cherry', { top: 3 }), [
    { word: 'apple', count: 1 },
    { word: 'cherry', count: 1 },
    { word: 'zebra', count: 1 },
  ]);
});

test('wordFrequency returns an empty list for text without words', () => {
  assert.deepEqual(wordFrequency('--- !!!', { top: 5 }), []);
});

test('wordFrequency rejects a top below one or a non-integer', () => {
  assert.throws(() => wordFrequency('one', { top: 0 }), RangeError);
  assert.throws(() => wordFrequency('one', { top: 1.5 }), RangeError);
});
