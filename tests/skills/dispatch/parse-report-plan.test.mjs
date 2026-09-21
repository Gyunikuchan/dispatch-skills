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
} from '../../../skills/dispatch/scripts/parse-report.mjs';
import { generateSkillHashes } from '../../../skills/dispatch/scripts/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'skills', 'dispatch', 'scripts', 'parse-report.mjs');

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
    const dispatch = path.join(parent, 'dispatch');
    try {
      for (const directory of [dispatch]) {
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'SKILL.md'), '# valid\n');
        fs.writeFileSync(
          path.join(directory, 'skill-hashes.json'),
          `${JSON.stringify(generateSkillHashes(directory), null, 2)}\n`,
        );
      }
      fs.writeFileSync(path.join(dispatch, 'SKILL.md'), '# tampered\n');
      assert.throws(() => assertParserIntegrity(dispatch), /dispatch integrity failure/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('normalizes clean output', () => {
    assert.deepEqual(parseReport('plan', report('CLEAN')), {
      schemaVersion: 1,
      reportKind: 'plan',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });
  });

  it('unwraps fenced json blocks', () => {
    assert.deepEqual(parseReport('plan', `\`\`\`json\n${report('CLEAN')}\n\`\`\``), {
      schemaVersion: 1,
      reportKind: 'plan',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });
  });

  it('unwraps fenced json blocks preceded by preamble text or followed by trailing commentary', () => {
    const preamble = `Here is my review report:\n\`\`\`json\n${report('CLEAN')}\n\`\`\``;
    assert.deepEqual(parseReport('plan', preamble), {
      schemaVersion: 1,
      reportKind: 'plan',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });

    const trailing = `\`\`\`json\n${report('CLEAN')}\n\`\`\`\nHope this review was helpful!`;
    assert.deepEqual(parseReport('plan', trailing), {
      schemaVersion: 1,
      reportKind: 'plan',
      summary: { type: 'summary', status: 'CLEAN' },
      findings: [],
    });
  });

  it('normalizes multiple findings', () => {
    const parsed = parseReport('plan', report('FINDINGS', [
      finding(),
      finding({ severity: 'SHOULD', locus: '§ Rollback & Blast Radius', tag: 'rollback' }),
    ]));
    assert.equal(parsed.findings.length, 2);
  });

  it('rejects malformed JSON and extracts reports behind provider chrome', () => {
    assert.throws(
      () => parseReport('plan', '{broken'),
      (err) => err.diagnostics.some(({ message }) => /malformed JSON/.test(message)),
    );
    assert.equal(parseReport('plan', `provider banner\n${report('CLEAN')}\nThanks!`).summary.status, 'CLEAN');
    assert.throws(() => parseReport('plan', 'banner\n{broken'), (err) => err.prose === true);
  });

  it('reads locus-citing prose before a CLEAN block as prose, not a clean review', () => {
    const text = `MUST § Proposed Changes omits the migration.\n${report('CLEAN')}`;
    assert.throws(() => parseReport('plan', text), (err) => err.prose === true);
    const echoed = `Example: {"locus":"§ <Plan heading>"}\n${report('CLEAN')}`;
    assert.equal(parseReport('plan', echoed).summary.status, 'CLEAN');
  });

  it('rejects invalid tags and severities', () => {
    assert.throws(
      () => parseReport('plan', report('FINDINGS', [finding({ severity: 'BLOCKER', tag: 'runtime' })])),
      (err) =>
        err.diagnostics.some(({ field }) => field === 'severity') &&
        err.diagnostics.some(({ field }) => field === 'tag'),
    );
  });

  it('rejects duplicate findings and mismatched summary status', () => {
    const duplicate = finding();
    assert.throws(
      () => parseReport('plan', report('CLEAN', [duplicate, duplicate])),
      (err) =>
        err.diagnostics.some(({ message }) => /duplicate/.test(message)) &&
        err.diagnostics.some(({ message }) => /CLEAN/.test(message)),
    );
    assert.throws(() => parseReport('plan', report('FINDINGS')), /Invalid delegate report/);
  });

  it('requires the exact report shape and a plan-section locus', () => {
    assert.throws(
      () => parseReport('plan', JSON.stringify({ type: 'summary', status: 'CLEAN', findings: [] })),
      (err) => err.diagnostics.some(({ message }) => /report fields/.test(message)),
    );
    assert.throws(
      () => parseReport('plan', report('FINDINGS', [finding({ locus: 'src/file.mjs:L2' })])),
      (err) => err.prose === true && err.diagnostics.some(({ field }) => field === 'locus'),
    );
    assert.equal(
      parseReport('plan', report('FINDINGS', [finding({ locus: '§Verification Plan' })])).findings[0].locus,
      '§ Verification Plan',
    );
  });

  it('uses exit 3 for prose or schema-mismatched reports and exit 1 for empty ones', () => {
    const run = (input, extra = []) => spawnSync(process.execPath, [cli, '--kind', 'plan', ...extra], {
      cwd: root,
      encoding: 'utf8',
      input,
    });
    const prose = run('No defects found after reviewing the scope.\n');
    assert.equal(prose.status, 3, prose.stderr);
    assert.match(prose.stderr, /"error": "prose-report"/);

    const truncated = run('{"status":"FINDINGS","findings":[\n');
    assert.equal(truncated.status, 3, truncated.stderr);

    const empty = run('  \n');
    assert.equal(empty.status, 1, empty.stderr);
    assert.match(empty.stderr, /"error": "invalid-report"/);

    const mismatched = run(report('FINDINGS', [finding({ tag: 'test-gap' })]));
    assert.equal(mismatched.status, 3, mismatched.stderr);
    assert.match(mismatched.stderr, /"field": "tag"/);
    assert.equal(run('{}').status, 1);

    const packetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-report-prose-'));
    try {
      const packet = path.join(packetDir, 'packet.json');
      fs.writeFileSync(packet, JSON.stringify({ findings: [{ key: 'R1-F001' }] }));
      const rebuttal = run('I confirm R1-F001.\n', ['--rebuttal-packet', packet]);
      assert.equal(rebuttal.status, 3, rebuttal.stderr);
    } finally {
      fs.rmSync(packetDir, { recursive: true, force: true });
    }
  });

  it('uses exit 1 for invalid reports and exit 2 for invocation failures', () => {
    const invalid = spawnSync(process.execPath, [cli, '--kind', 'plan'], {
      cwd: root,
      encoding: 'utf8',
      input: '{"status":"FINDINGS","findings":[]}\n',
    });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /"error": "invalid-report"/);

    const missing = spawnSync(process.execPath, [cli, '--kind', 'plan', '--file', 'missing-report.json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /could not read/);
  });

  it('validates exact rebuttal response key sets', () => {
    const parsed = parseRebuttal('plan', JSON.stringify({
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
        () => parseRebuttal('plan', JSON.stringify({ responses }), ['R1-F001']),
        /Invalid delegate report/,
      );
    }
  });

  it('requires rebuttal evidence to cite a plan or code locus', () => {
    assert.throws(
      () => parseRebuttal('plan', JSON.stringify({
        responses: [{
          type: 'rebuttal',
          key: 'R1-F001',
          verdict: 'REBUT',
          evidence: 'The plan is still incomplete.',
        }],
      }), ['R1-F001']),
      (err) => err.diagnostics.some(({ field }) => field === 'evidence'),
    );
    const parsed = parseRebuttal('plan', JSON.stringify({
      responses: [{ type: 'rebuttal', key: 'R1-F001', verdict: 'CONFIRM', evidence: '§Verification Plan covers it.' }],
    }), ['R1-F001']);
    assert.equal(parsed.responses[0].verdict, 'CONFIRM');
  });
});
