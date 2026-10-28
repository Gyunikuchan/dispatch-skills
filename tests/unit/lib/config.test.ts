import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';

import { loadConfig, parseJsonc, stripJsonc, validateConfig } from '../../../skills/dispatch/scripts/lib/config.ts';


// SECTION: Configuration loading and validation

test('config resolution is first-existing-wins with no merge', () => {
  const files: Record<string, string> = {
    [path.join('/s', 'config.local.jsonc')]: '{ "read-delegates": { "claude": [] } }',
    [path.join('/s', 'config.jsonc')]: '{ "read-delegates": { "codex": [] }, "phases": { "x": 1 } }',
  };
  const local = loadConfig('/s', (file) => files[file] ?? null);
  assert.equal(local.path, path.join('/s', 'config.local.jsonc'));
  assert.deepEqual(local.config, { 'read-delegates': { claude: [] }, 'write-subagents': {}, 'explore-subagents': {}, phases: {} });
  const only = loadConfig('/s', (file) => (file.endsWith(`${path.sep}config.jsonc`) ? files[file] ?? null : null));
  assert.deepEqual(only.config['phases'], { x: 1 });
  assert.throws(() => loadConfig('/s', () => null), /Config file not found.*config\.sample\.jsonc/);
  // A read error other than absence propagates instead of falling through to config.jsonc.
  assert.throws(() => loadConfig('/s', (file) => { if (file.endsWith('config.local.jsonc')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return files[file] ?? null; }), /EACCES/);
});

test('JSONC comments and trailing commas strip without touching strings', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x // not a comment", /* b */ "b": [1, 2,], }'), { a: 'x // not a comment', b: [1, 2] });
  assert.equal(stripJsonc('"a,}"'), '"a,}"');
});

test('strict validation rejects unknown keys naming config.sample.jsonc; the shipped sample validates', () => {
  const problems = validateConfig({ 'read-delegates': { claude: [] }, bogus: 1 });
  assert.ok(problems.some((problem) => /Unrecognized top-level key "bogus".*config\.sample\.jsonc/.test(problem)));
  assert.ok(validateConfig({}).some((problem) => /Missing required table "read-delegates"/.test(problem)));
  assert.deepEqual(validateConfig(parseJsonc(fs.readFileSync(new URL('../../../skills/dispatch/config.sample.jsonc', import.meta.url), 'utf8'))), []);
});

test('explore-subagents validates level entries and a boolean deep', () => {
  const valid = {
    ...minimal,
    'explore-subagents': {
      codex: {
        low: { model: 'fast-explorer', effort: 'low', deep: true },
        high: { model: 'strong-explorer', deep: false },
      },
    },
  };
  assert.deepEqual(validateConfig(valid), []);

  const invalidCases: Array<[unknown, RegExp]> = [
    [{ bogus: { low: { model: 'fast-explorer' } } }, /explore-subagents: unknown platform "bogus"/],
    [{ codex: { bogus: { model: 'fast-explorer' } } }, /explore-subagents\.codex has unrecognized key "bogus"/],
    [{ codex: { low: { model: 'fast-explorer', unknown: true } } }, /explore-subagents\.codex\.low has unrecognized key "unknown"/],
    [{ codex: { low: { model: ' ' } } }, /explore-subagents\.codex\.low\.model must be a nonblank string/],
    [{ codex: { low: { model: 'fast-explorer', deep: 'yes' } } }, /explore-subagents\.codex\.low\.deep must be a boolean/],
  ];
  for (const [table, expected] of invalidCases) {
    assert.match(validateConfig({ ...minimal, 'explore-subagents': table }).join(' '), expected);
  }

  assert.match(
    validateConfig({ ...minimal, 'write-subagents': { codex: { low: { model: 'writer', deep: true } } } }).join(' '),
    /write-subagents\.codex\.low has unrecognized key "deep"\. Valid keys: model, effort/,
  );
});

// SECTION: Write concurrency

const minimal = { 'read-delegates': { codex: { targets: [{ low: { model: 'm' } }] } } };

test('write-concurrency validates positive integers and accepts omission', () => {
  assert.deepEqual(validateConfig(minimal), []);
  assert.deepEqual(validateConfig({ ...minimal, 'write-concurrency': 3 }), []);
  for (const value of [0, -1, 1.5, '2', true]) {
    assert.match(validateConfig({ ...minimal, 'write-concurrency': value }).join(' '), /write-concurrency must be a positive integer/);
  }
});
