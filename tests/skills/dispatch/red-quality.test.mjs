import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import * as verificationEvidence from '../../../skills/dispatch/scripts/verification-evidence.mjs';
import { parseIdentifiers } from '../../../skills/dispatch/scripts/red-quality.mjs';

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
    '  - Evidence: red',
    '  - Test rationale: Behavioral failure isolates the value contract and protects regression.',
    '- [SC2] Recovery.',
    '  - Changes: src/value.js',
    '  - Verify: `node --test tests/value.test.mjs`',
    '  - Evidence: red',
    '  - Test rationale: Recovery behavior has stable interruption coverage and durable regression value.',
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

  it('parses identifiers containing spaces up to the next semicolon', () => {
    assert.deepEqual(parseIdentifiers('exit 1 test:hops A then B'), ['test:hops A then B']);
    assert.deepEqual(parseIdentifiers('exit 1 test:hops A then B; error:second one'), ['test:hops A then B', 'error:second one']);
    assert.deepEqual(parseIdentifiers('exit 1 test:value'), ['test:value']);
  });

  it('admits a spaced full test-name identifier as a RED-MATRIX row', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:hops A then B',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:hops A then B',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:hops A then B'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 0, result.stderr);
  });

  it('matches a command shared by two criteria against the union of their row identifiers', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:first case',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:second case',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:first case', 'test:second case'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 0, result.stderr);
  });

  it('rejects a mismatched identity even against the shared-command union', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:first case',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:second case',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:unrelated case'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /identity mismatch/i);
  });

  it('ignores a RED result for a command mapped to no red criterion', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:value',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['error:unrelated aggregate failure'], diagnostic: 'unrelated', command: 'npm test' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 0, result.stderr);
  });

  it('bounds the exit-1 match so exit 100 is never treated as exit 1 (SC6)', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 100 test:value',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:value',
    ] }));
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:value'], diagnostic: 'failed', command: 'node --test tests/value.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    // SC1's row claims "exit 100", which must not be read as a bare "exit 1" match against
    // the RED exit status of 1 — an unbounded pattern would wrongly pass this as a match.
    assert.equal(result.status, 1, 'an exit-100 row must not satisfy an exit-1 RED result');
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  });

  it('flags a RED command that matches no red-mapped criterion command instead of silently passing (SC6)', () => {
    const f = fixture();
    fs.writeFileSync(f.evidence, JSON.stringify({ evidence: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:value',
    ] }));
    // The host ran a completely unrelated command; it matches no red-mapped criterion command,
    // so the checker must guard against silently treating this as a pass.
    fs.writeFileSync(f.red, JSON.stringify({ exitStatus: 1, identifiers: ['test:value'], diagnostic: 'failed', command: 'node --test tests/typo-unrelated.test.mjs' }));
    const result = run(['--plan', f.plan, '--evidence', f.evidence, '--red', f.red]);
    assert.equal(result.status, 1, 'a RED command mapped to no red criterion must not silently pass');
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
    assert.match(result.stderr, /unmapped command/i);
  });

  it('drops a blank identifier (colon with only whitespace after it) from parseIdentifiers (SC6)', () => {
    assert.deepEqual(parseIdentifiers('exit 1 test:    ; error:x'), ['error:x']);
    assert.deepEqual(parseIdentifiers('exit 1 test:   '), []);
  });

  it('reuses exported mappings and failure identity helpers', () => {
    assert.equal(typeof verificationEvidence.criterionMappings, 'function');
    assert.deepEqual(mapVerificationCommandsToPaths('## Success Criteria\n- [SC1] x.\n  - Changes: src/a.js\n  - Verify: `npm test`\n', ['npm test']), { 'npm test': ['src/a.js'] });
    const one = failureIdentity({ exitStatus: 1, identifiers: ['T'], diagnostic: 'failed at 2026-09-20T00:00:00Z' });
    const two = failureIdentity({ exitStatus: 1, identifiers: ['T'], diagnostic: 'different prose' });
    assert.equal(compareFailureIdentity(one, two), true);
  });
});
