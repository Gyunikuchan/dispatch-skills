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
} from '../../../skills/dispatch-code-review/scripts/parse-report.mjs';
import { generateSkillHashes } from '../../../skills/dispatch/scripts/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'skills', 'dispatch-code-review', 'scripts', 'parse-report.mjs');

function finding(overrides = {}) {
  return {
    severity: 'MUST',
    locus: 'src/value.mjs:L2',
    tag: 'runtime',
    defect: 'The branch dereferences a missing value.',
    requiredChange: 'Guard the missing-value branch.',
    ...overrides,
  };
}

function report(status, findings = []) {
  return JSON.stringify({ status, findings });
}

describe('code review report parser', () => {
  it('fails when the shared dispatch parser violates its manifest', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'code-parser-integrity-'));
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
      reportKind: 'code',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });
  });

  it('unwraps fenced json blocks', () => {
    assert.deepEqual(parseReport(`\`\`\`json\n${report('CLEAN')}\n\`\`\``), {
      schemaVersion: 1,
      reportKind: 'code',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });
  });

  it('unwraps fenced json blocks preceded by preamble text or followed by trailing commentary', () => {
    const preamble = `Here is my review report:\n\`\`\`json\n${report('CLEAN')}\n\`\`\``;
    assert.deepEqual(parseReport(preamble), {
      schemaVersion: 1,
      reportKind: 'code',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });

    const trailing = `\`\`\`json\n${report('CLEAN')}\n\`\`\`\nHope this review was helpful!`;
    assert.deepEqual(parseReport(trailing), {
      schemaVersion: 1,
      reportKind: 'code',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });
  });

  it('normalizes multiple findings', () => {
    const parsed = parseReport(report('FINDINGS', [
      finding(),
      finding({ severity: 'CONSIDER', locus: 'test/value.test.mjs:L8', tag: 'test-gap' }),
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
      () => parseReport(report('FINDINGS', [finding({ severity: 'BLOCKER', tag: 'verification' })])),
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

  it('requires the exact report shape and an exact code locus', () => {
    assert.throws(
      () => parseReport(JSON.stringify({ type: 'summary', status: 'CLEAN', findings: [] })),
      (err) => err.diagnostics.some(({ message }) => /report fields/.test(message)),
    );
    for (const locus of [
      '§ Verification Plan',
      '/src/value.mjs:L2',
      '../src/value.mjs:L2',
      String.raw`C:\src\value.mjs:L2`,
      'src/value.mjs:L1:L2',
      'src/value.mjs:2',
    ]) {
      assert.throws(
        () => parseReport(report('FINDINGS', [finding({ locus })])),
        (err) => err.diagnostics.some(({ field }) => field === 'locus'),
      );
    }
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

  it('shares strict rebuttal validation with plan review', () => {
    const parsed = parseRebuttal(JSON.stringify({
      responses: [{
        type: 'rebuttal',
        key: 'R2-F004',
        verdict: 'INTENT-DISPUTE',
        evidence: 'src/value.mjs:L2 does not state the intended compatibility boundary.',
      }],
    }), ['R2-F004']);
    assert.deepEqual(parsed.responses.map(({ key, verdict }) => ({ key, verdict })), [
      { key: 'R2-F004', verdict: 'INTENT-DISPUTE' },
    ]);
    assert.throws(
      () => parseRebuttal(JSON.stringify({
        responses: [{
          type: 'rebuttal',
          key: 'R2-F004',
          verdict: 'CONFIRM',
          evidence: 'x',
          extra: true,
        }],
      }), ['R2-F004']),
      /Invalid delegate report/,
    );
  });

  it('requires rebuttal evidence to cite a code locus', () => {
    assert.throws(
      () => parseRebuttal(JSON.stringify({
        responses: [{
          type: 'rebuttal',
          key: 'R2-F004',
          verdict: 'CONFIRM',
          evidence: 'The change is correct.',
        }],
      }), ['R2-F004']),
      (err) => err.diagnostics.some(({ field }) => field === 'evidence'),
    );
  });
});
