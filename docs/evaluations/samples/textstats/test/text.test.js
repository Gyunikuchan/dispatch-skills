import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords, tokenize } from '../src/text.js';

test('tokenize returns lowercase words and keeps apostrophes inside words', () => {
  assert.deepEqual(tokenize("Green, BLUE! Don't stop."), ['green', 'blue', "don't", 'stop']);
});

test('tokenize includes Unicode letters and digits', () => {
  assert.deepEqual(tokenize('Été 42 東京'), ['été', '42', '東京']);
});

test('tokenize returns no words for empty or punctuation-only text', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('... -- !!!'), []);
});

test('countWords counts tokens', () => {
  assert.equal(countWords("One, two; don't."), 3);
});

test('tokenize rejects non-string input', () => {
  assert.throws(() => tokenize(null), TypeError);
});
