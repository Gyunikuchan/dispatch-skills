import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { loadConfig, parseJsonc, stripJsonc, validateConfig } from '../../../skills/dispatch/scripts/lib/config.ts';
import { writeConcurrency } from '../../../skills/dispatch/scripts/machines/implement-tasks.ts';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');

test('config resolution is first-existing-wins with no merge', () => {
  const files: Record<string, string> = {
    [path.join('/s', 'config.local.jsonc')]: '{ "read-delegates": { "claude": [] } }',
    [path.join('/s', 'config.jsonc')]: '{ "read-delegates": { "codex": [] }, "phases": { "x": 1 } }',
  };
  const local = loadConfig('/s', (file) => files[file] ?? null);
  assert.equal(local.path, path.join('/s', 'config.local.jsonc'));
  assert.deepEqual(local.config, { 'read-delegates': { claude: [] }, 'write-subagents': {}, phases: {} });
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
  assert.deepEqual(validateConfig(parseJsonc(fs.readFileSync(path.join(SKILL, 'config.sample.jsonc'), 'utf8'))), []);
});

const minimal = { 'read-delegates': { codex: { targets: [{ low: { model: 'm' } }] } } };

test('write-concurrency accepts positive integers', () => {
  assert.deepEqual(validateConfig({ ...minimal, 'write-concurrency': 3 }), []);
  assert.equal(writeConcurrency({ 'write-concurrency': 3 }), 3);
});

test('write-concurrency rejects invalid values and defaults to 1', () => {
  for (const value of [0, -1, 1.5, '2', true]) assert.match(validateConfig({ ...minimal, 'write-concurrency': value }).join(' '), /write-concurrency must be a positive integer/);
  assert.equal(writeConcurrency({}), 1);
});
