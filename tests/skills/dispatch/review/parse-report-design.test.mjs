import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRebuttal, parseReport } from '../../../../skills/dispatch/scripts/review/parse-report.mjs';

describe('design review report parsing', () => {
  it('accepts design tags and section loci', () => {
    const parsed = parseReport('design', JSON.stringify({ status: 'CLEAN', findings: [] }));
    assert.equal(parsed.reportKind, 'design');
    const findings = parseReport('design', JSON.stringify({
      status: 'FINDINGS',
      findings: [{ severity: 'MUST', locus: '§ Architecture & Boundaries', tag: 'graph-correctness', defect: 'd', requiredChange: 'r' }],
    }));
    assert.equal(findings.findings.length, 1);
  });

  it('parses a design rebuttal', () => {
    const parsed = parseRebuttal('design', JSON.stringify({
      responses: [{ type: 'rebuttal', key: 'R1-F001', verdict: 'CONFIRM', evidence: '§ Architecture & Boundaries covers it.' }],
    }), ['R1-F001']);
    assert.equal(parsed.mode, 'rebuttal');
    assert.equal(parsed.responses[0].verdict, 'CONFIRM');
  });

  it('names the three kinds for a missing or unknown kind', () => {
    for (const kind of [undefined, 'essay']) {
      assert.throws(() => parseReport(kind, '{}'), /plan|code|design/);
    }
  });
});
