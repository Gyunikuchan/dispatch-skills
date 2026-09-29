import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { OVERLAY_ROOT } from './scan.ts';

export const MATRIX_FILE = 'tests/preserved-behaviour.json';
const KEY = /^(grammar|delegates|review|implement|design|session|walkthrough)-[a-z0-9]+(-[a-z0-9]+)*$/;
const INCREMENT = /^I0[1-9]$/;

/** Reads an overlay-relative file, or null when absent. */
export type ReadFile = (overlayPath: string) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isPathList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** DD8: shape, unique keys, listed files exist and name their key, and `complete` requires coverage on every row. */
export function checkMatrix(matrix: unknown, read: ReadFile): string[] {
  const where = `preserved-behaviour rule: ${MATRIX_FILE}`;
  if (!isRecord(matrix) || typeof matrix['complete'] !== 'boolean' || !Array.isArray(matrix['rows'])) {
    return [`${where} must be { complete: boolean, rows: [] }; restore that shape`];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, row] of matrix['rows'].entries()) {
    if (!isRecord(row) || typeof row['key'] !== 'string' || typeof row['clause'] !== 'string' || typeof row['increment'] !== 'string'
      || !isPathList(row['tests']) || !isPathList(row['checks'])) {
      errors.push(`${where} row ${index} must be { key, clause, increment, tests: [], checks: [] }; fix the row`);
      continue;
    }
    const key = row['key'];
    if (!KEY.test(key)) errors.push(`${where} key ${key} must be kebab-case <area>-<slug>; rename it`);
    if (!INCREMENT.test(row['increment'])) errors.push(`${where} ${key} names increment ${row['increment']}; use its owning I0n`);
    if (seen.has(key)) errors.push(`${where} key ${key} repeats; merge or rename the rows`);
    seen.add(key);
    for (const file of [...row['tests'], ...row['checks']]) {
      const text = read(file);
      if (text === null) errors.push(`${where} ${key} lists missing ${file}; fix the path or remove it`);
      else if (!text.includes(key)) errors.push(`${where} ${key} lists ${file}, which never mentions ${key}; name the key in the covering test`);
    }
    if (matrix['complete'] === true && row['tests'].length + row['checks'].length === 0) {
      errors.push(`${where} is complete but ${key} lists no test or check; cover the row or set complete: false`);
    }
  }
  return errors;
}

const readOverlay: ReadFile = (file) => {
  try { return fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8'); } catch { return null; }
};

test('the seeded matrix is well formed and incomplete', () => {
  const matrix = JSON.parse(fs.readFileSync(path.join(OVERLAY_ROOT, MATRIX_FILE), 'utf8')) as { complete: boolean; rows: unknown[] };
  assert.deepEqual(checkMatrix(matrix, readOverlay), []);
  assert.equal(matrix.complete, false);
  assert.equal(matrix.rows.length, 66);
});

test('violations name the rule and the fix', () => {
  const files: Record<string, string> = { 'tests/unit/a.test.ts': 'covers review-dedup', 'tests/unit/b.test.ts': 'nothing' };
  const read: ReadFile = (file) => files[file] ?? null;
  const row = (key: string, tests: string[]) => ({ key, clause: 'c', increment: 'I02', tests, checks: [] });
  const errors = checkMatrix({ complete: true, rows: [
    row('review-dedup', ['tests/unit/a.test.ts']),
    row('review-dedup', ['tests/unit/b.test.ts', 'tests/unit/missing.test.ts']),
    row('Bad_Key', []),
  ] }, read);
  assert.deepEqual(errors.map((error) => error.replace(/^preserved-behaviour rule: tests\/preserved-behaviour\.json /, '')), [
    'key review-dedup repeats; merge or rename the rows',
    'review-dedup lists tests/unit/b.test.ts, which never mentions review-dedup; name the key in the covering test',
    'review-dedup lists missing tests/unit/missing.test.ts; fix the path or remove it',
    'key Bad_Key must be kebab-case <area>-<slug>; rename it',
    'is complete but Bad_Key lists no test or check; cover the row or set complete: false',
  ]);
  assert.match(checkMatrix([], read)[0] ?? '', /must be \{ complete: boolean, rows: \[\] \}/);
});
