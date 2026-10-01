import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './scan.ts';

// The cutover adds no dependency; native stripping defines the approved engine range.
export const EXPECTED = { dependencies: [] as string[], devDependencies: ['@types/node', 'husky', 'typescript'], engines: { node: '^22.18 || >=23.6' } };

export function checkPackage(pkg: Record<string, unknown>): string[] {
  const keys = (value: unknown) => Object.keys(typeof value === 'object' && value !== null ? value : {}).sort();
  const errors: string[] = [];
  const fix = 'remove it, or record the escalation and update EXPECTED in the same change';
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const extra = keys(pkg[field]).filter((name) => !EXPECTED[field].includes(name));
    if (extra.length) errors.push(`package rule: ${field} adds ${extra.join(', ')}; ${fix}`);
  }
  if (JSON.stringify(pkg['engines']) !== JSON.stringify(EXPECTED.engines)) {
    errors.push(`package rule: engines is ${JSON.stringify(pkg['engines'])}, expected ${JSON.stringify(EXPECTED.engines)}; ${fix}`);
  }
  return errors;
}

test('root package.json adds no dependency and uses the approved engine range', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(checkPackage(pkg), []);
});

test('a new dependency or engines change fails with the rule and the fix', () => {
  const errors = checkPackage({ dependencies: { zod: '1' }, devDependencies: { husky: '1' }, engines: { node: '>=24' } });
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? '', /^package rule: dependencies adds zod; remove it/);
  assert.match(errors[1] ?? '', /^package rule: engines is \{"node":">=24"\}/);
});
