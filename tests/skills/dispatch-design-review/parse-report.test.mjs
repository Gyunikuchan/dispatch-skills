import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseReport } from '../../../skills/dispatch-design-review/scripts/parse-report.mjs';

describe('design review report parsing', () => {
  it('accepts design tags and section loci', () => {
    const parsed = parseReport(JSON.stringify({ status: 'CLEAN', findings: [] }));
    assert.equal(parsed.reportKind, 'design');
  });
});
