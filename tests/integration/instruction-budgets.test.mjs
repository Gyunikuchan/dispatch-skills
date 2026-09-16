import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { measureText } from '../../skills/dispatch/scripts/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const budgets = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'instruction-budgets.json'), 'utf8'));
const entryPoints = [
  'skills/dispatch/SKILL.md',
  'skills/dispatch-plan-review/SKILL.md',
  'skills/dispatch-code-review/SKILL.md',
  'skills/implement-dispatch/SKILL.md',
];
const normalPath = [
  ...entryPoints,
  'skills/dispatch/references/alignment.md',
  'skills/dispatch-plan-review/references/prompt-template.md',
  'skills/dispatch-code-review/references/prompt-template.md',
  'skills/dispatch-plan-review/references/plan-template.md',
  'skills/dispatch-code-review/references/walkthrough-template.md',
];

describe('instruction character ratchet', () => {
  it('uses the shared NFC code-point and ceiling estimator', () => {
    assert.deepEqual(measureText('e\u0301😀'), { characters: 2, estimate: 1 });
  });

  for (const [file, ceiling] of Object.entries(budgets.phase0c)) {
    it(`${file} does not grow beyond the Phase 0C baseline`, () => {
      const measured = measureText(fs.readFileSync(path.join(root, file), 'utf8'));
      assert.ok(measured.characters <= ceiling, `${file}: ${measured.characters} > ${ceiling}`);
      assert.equal(measured.estimate, Math.ceil(measured.characters / 4));
    });
  }

  it('gates the complete entry-point and normal implementation paths', () => {
    assert.deepEqual(Object.keys(budgets.phase0c).sort(), [...normalPath].sort());
    const countPath = (files) => files.reduce(
      (sum, file) => sum + measureText(fs.readFileSync(path.join(root, file), 'utf8')).characters,
      0,
    );
    const entryCharacters = countPath(entryPoints);
    const normalCharacters = countPath(normalPath);
    assert.ok(
      entryCharacters <= budgets.aggregateBaselines.phase0c.entryPointCharacters,
      `entry-point total: ${entryCharacters} > ${budgets.aggregateBaselines.phase0c.entryPointCharacters}`,
    );
    assert.ok(
      normalCharacters <= budgets.aggregateBaselines.phase0c.normalPathCharacters,
      `normal-path total: ${normalCharacters} > ${budgets.aggregateBaselines.phase0c.normalPathCharacters}`,
    );
    assert.equal(
      Math.ceil(entryCharacters / 4),
      budgets.aggregateBaselines.phase0c.entryPointEstimate,
    );
    assert.equal(
      Math.ceil(normalCharacters / 4),
      budgets.aggregateBaselines.phase0c.normalPathEstimate,
    );
  });

  it('records Phase 0A, the intentional 0B delta, and the projected Phase 1 baseline', () => {
    assert.ok(budgets.phase0a['skills/implement-dispatch/SKILL.md'] < budgets.phase0b['skills/implement-dispatch/SKILL.md']);
    assert.equal(budgets.aggregateBaselines.phase0a.entryPointCharacters, 39027);
    assert.equal(budgets.aggregateBaselines.phase0a.normalPathCharacters, 71170);
    assert.match(budgets.intentionalPhase0bDelta.reason, /correctness\/UX/);
    const measuredDelta = Object.keys(budgets.phase0a).reduce(
      (sum, file) => sum + budgets.phase0b[file] - budgets.phase0a[file],
      0,
    );
    assert.equal(measuredDelta, budgets.intentionalPhase0bDelta.characters);
    const projection = JSON.parse(fs.readFileSync(
      path.join(root, 'tests', 'fixtures', 'review-corpus', 'projection-baseline.json'),
      'utf8',
    ));
    assert.ok(projection.projectedCharacters < projection.canonicalCharacters);
    assert.equal(projection.phase1Baseline, 'bounded-review-view-v1');
  });
});
