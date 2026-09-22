import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import * as verificationEvidence from '../../../skills/dispatch/scripts/verification-evidence.mjs';

const {
  mapVerificationCommandsToPaths,
  failureIdentity,
  compareFailureIdentity,
} = verificationEvidence;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const checker = path.join(root, 'skills/dispatch/scripts/red-quality.mjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-quality-'));
  const plan = path.join(dir, 'plan.md');
  const evidence = path.join(dir, 'evidence.json');
  const red = path.join(dir, 'red.json');
  fs.writeFileSync(plan, [
    '## Success Criteria',
    '- [SC1] Basic behavior.',
    '  - Changes: src/value.js',
    '  - Verify: `node --test tests/value.test.mjs`',
    '- [SC2] Recovery.',
    '  - Changes: src/value.js',
    '  - Verify: `node --test tests/value.test.mjs`',
    '## Proposed Changes',
    '#### [MODIFY] src/value.js',
  ].join('\n'));
  return { dir, plan, evidence, red };
}

function run(args) {
  if (!fs.existsSync(checker)) return { status: 1, stdout: '', stderr: 'missing implementation: red-quality checker\n' };
  return spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
}

describe('red-quality checker', () => {
  it('accepts one primary row per mapped criterion and emits normalized JSON', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:value',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:value'], diagnostic: 'failed at 2026-09-20T00:00:00Z', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).status, 'valid');
  });

  for (const [name, evidence, diagnostic] of [
    ['duplicate', ['RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value', 'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value'], /duplicate/i],
    ['missing', ['RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value'], /missing/i],
    ['unmapped', ['RED-MATRIX SC1 | unrelated.test.mjs | exit 1 test:value', 'RED-MATRIX SC2 | tests/value.test.mjs | exit 1 test:value'], /unmapped/i],
    ['weak identity', ['RED-MATRIX SC1 | tests/value.test.mjs | failed'], /identity/i],
  ]) {
    it(`rejects ${name} matrix defects independently`, () => {
      const f = fixture();
      fs.writeFileSync(f.evidence, JSON.stringify({ evidence }));
      fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:value'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
      const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
      assert.match(result.stderr, diagnostic);
    });
  }

  it('rejects a RED record whose command or exit status mismatches the matrix', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: ['RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value'] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 2, identifiers: ['test:value'], diagnostic: 'failed', command: 'node --test tests/other.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
    assert.match(result.stderr, /mismatch|command|exit/i);
  });

  it('matches a stable identity even when only the normalized diagnostic is equal', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 failed at 2026-09-20T00:00:00Z',
      'RED-MATRIX SC2 | N/A | recovery is not applicable to this diagnostic check',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: [], diagnostic: 'failed at 2026-09-21T00:00:00Z', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  });

  it('returns exit 2 for invalid checker input rather than a quality failure', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, '{not-json');
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1 }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  });

  it('rejects malformed RED-MATRIX grammar as a quality defect', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: ['RED-MATRIX SC1 | malformed'] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:value'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
    assert.match(result.stderr, /grammar|matrix|row|malformed/i);
  });

  it('supports N/A with a non-empty class-inapplicability reason', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | N/A | validation is not applicable to this class',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:value',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:value'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
    assert.equal(run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]).status, 0);
  });

  it('requires interruption/resume and adversarial rows for applicable criterion classes', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value',
      'RED-MATRIX SC2 | tests/value.test.mjs | exit 1 test:value',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:value'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /interruption|resume|adversarial/i);
  });

  it('reuses exported mappings and failure identity helpers', () => {
    assert.equal(typeof verificationEvidence.criterionMappings, 'function');
    assert.deepEqual(mapVerificationCommandsToPaths('## Success Criteria\n- [SC1] x.\n  - Changes: src/a.js\n  - Verify: `npm test`\n', ['npm test']), { 'npm test': ['src/a.js'] });
    const one = failureIdentity({ exitStatus: 1, identifiers: ['T'], diagnostic: 'failed at 2026-09-20T00:00:00Z' });
    const two = failureIdentity({ exitStatus: 1, identifiers: ['T'], diagnostic: 'different prose' });
    assert.equal(compareFailureIdentity(one, two), true);
  });
});
