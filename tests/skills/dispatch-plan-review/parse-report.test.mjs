import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  assertParserIntegrity,
  parseRebuttal,
  parseReport,
} from '../../../skills/dispatch-plan-review/scripts/parse-report.mjs';
import { generateSkillHashes } from '../../../skills/dispatch/scripts/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'skills', 'dispatch-plan-review', 'scripts', 'parse-report.mjs');

function finding(overrides = {}) {
  return {
    severity: 'MUST',
    locus: '§ Verification Plan',
    tag: 'testability',
    defect: 'No failure-path test is named.',
    requiredChange: 'Name the parser failure-path test.',
    ...overrides,
  };
}

function report(status, findings = []) {
  return JSON.stringify({ status, findings });
}

describe('plan review report parser', () => {
  it('fails when the shared dispatch parser violates its manifest', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-integrity-'));
    const own = path.join(parent, 'own');
    const dispatch = path.join(parent, 'dispatch');
    try {
      for (const directory of [own, dispatch]) {
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'SKILL.md'), '# valid\n');
        fs.writeFileSync(
          path.join(directory, 'skill-hashes.json'),
          `${JSON.stringify(generateSkillHashes(directory), null, 2)}\n`,
        );
      }
      fs.writeFileSync(path.join(dispatch, 'SKILL.md'), '# tampered\n');
      assert.throws(() => assertParserIntegrity(own, dispatch), /dispatch integrity failure/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('normalizes clean output', () => {
    assert.deepEqual(parseReport(report('CLEAN')), {
      schemaVersion: 1,
      reportKind: 'plan',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });
  });

  it('normalizes multiple findings', () => {
    const parsed = parseReport(report('FINDINGS', [
      finding(),
      finding({ severity: 'SHOULD', locus: '§ Rollback & Blast Radius', tag: 'compat' }),
    ]));
    assert.equal(parsed.findings.length, 2);
  });

  it('rejects malformed JSON and provider chrome', () => {
    assert.throws(
      () => parseReport('{broken'),
      (err) => err.diagnostics.some(({ message }) => /malformed JSON/.test(message)),
    );
    assert.throws(() => parseReport(`provider banner\n${report('CLEAN')}`), /Invalid delegate report/);
  });

  it('rejects invalid tags and severities', () => {
    assert.throws(
      () => parseReport(report('FINDINGS', [finding({ severity: 'BLOCKER', tag: 'runtime' })])),
      (err) =>
        err.diagnostics.some(({ field }) => field === 'severity') &&
        err.diagnostics.some(({ field }) => field === 'tag'),
    );
  });

  it('rejects duplicate findings and mismatched summary status', () => {
    const duplicate = finding();
    assert.throws(
      () => parseReport(report('CLEAN', [duplicate, duplicate])),
      (err) =>
        err.diagnostics.some(({ message }) => /duplicate/.test(message)) &&
        err.diagnostics.some(({ message }) => /CLEAN/.test(message)),
    );
    assert.throws(() => parseReport(report('FINDINGS')), /Invalid delegate report/);
  });

  it('requires the exact report shape and a plan-section locus', () => {
    assert.throws(
      () => parseReport(JSON.stringify({ type: 'summary', status: 'CLEAN', findings: [] })),
      (err) => err.diagnostics.some(({ message }) => /report fields/.test(message)),
    );
    assert.throws(
      () => parseReport(report('FINDINGS', [finding({ locus: 'src/file.mjs:L2' })])),
      (err) => err.diagnostics.some(({ field }) => field === 'locus'),
    );
  });

  it('uses exit 1 for invalid reports and exit 2 for invocation failures', () => {
    const invalid = spawnSync(process.execPath, [cli], {
      cwd: root,
      encoding: 'utf8',
      input: '{"status":"FINDINGS","findings":[]}\n',
    });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /"error": "invalid-report"/);

    const missing = spawnSync(process.execPath, [cli, '--file', 'missing-report.json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /could not read/);
  });

  it('validates exact rebuttal response key sets', () => {
    const parsed = parseRebuttal(JSON.stringify({
      responses: [{
        type: 'rebuttal',
        key: 'R1-F001',
        verdict: 'CONFIRM',
        evidence: '§ Verification Plan now names the failure case.',
      }],
    }), ['R1-F001']);
    assert.equal(parsed.mode, 'rebuttal');
    assert.equal(parsed.responses[0].verdict, 'CONFIRM');
    for (const responses of [
      [],
      [
        { type: 'rebuttal', key: 'R1-F001', verdict: 'REBUT', evidence: 'x' },
        { type: 'rebuttal', key: 'R1-F001', verdict: 'REBUT', evidence: 'x' },
      ],
      [{ type: 'rebuttal', key: 'R1-F999', verdict: 'REBUT', evidence: 'x' }],
      [{ type: 'rebuttal', key: 'R1-F001', verdict: 'UNKNOWN', evidence: 'x' }],
    ]) {
      assert.throws(
        () => parseRebuttal(JSON.stringify({ responses }), ['R1-F001']),
        /Invalid delegate report/,
      );
    }
  });

  it('requires rebuttal evidence to cite a plan or code locus', () => {
    assert.throws(
      () => parseRebuttal(JSON.stringify({
        responses: [{
          type: 'rebuttal',
          key: 'R1-F001',
          verdict: 'REBUT',
          evidence: 'The plan is still incomplete.',
        }],
      }), ['R1-F001']),
      (err) => err.diagnostics.some(({ field }) => field === 'evidence'),
    );
  });
});
