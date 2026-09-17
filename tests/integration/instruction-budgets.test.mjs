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

  for (const [file, ceiling] of Object.entries(budgets.phase4)) {
    it(`${file} does not grow beyond the Phase 4 baseline`, () => {
      const measured = measureText(fs.readFileSync(path.join(root, file), 'utf8'));
      assert.ok(measured.characters <= ceiling, `${file}: ${measured.characters} > ${ceiling}`);
      assert.ok(ceiling <= budgets.phase3[file], `${file}: Phase 4 baseline exceeds Phase 3`);
      assert.equal(measured.estimate, Math.ceil(measured.characters / 4));
    });
  }

  for (const [file, ceiling] of Object.entries(budgets.phase1)) {
    it(`${file} meets the Phase 1 compact-prompt target`, () => {
      const measured = measureText(fs.readFileSync(path.join(root, file), 'utf8'));
      assert.ok(measured.characters <= ceiling, `${file}: ${measured.characters} > ${ceiling}`);
      assert.ok(
        measured.characters <= Math.floor(budgets.phase0a[file] * 0.45),
        `${file}: ${measured.characters} is not at least 55% below ${budgets.phase0a[file]}`,
      );
      assert.equal(measured.estimate, Math.ceil(measured.characters / 4));
    });
  }

  it('gates the complete entry-point and normal implementation paths', () => {
    assert.deepEqual(Object.keys(budgets.phase4).sort(), [...normalPath].sort());
    const countPath = (files) => files.reduce(
      (sum, file) => sum + measureText(fs.readFileSync(path.join(root, file), 'utf8')).characters,
      0,
    );
    const entryCharacters = countPath(entryPoints);
    const normalCharacters = countPath(normalPath);
    assert.ok(
      entryCharacters <= budgets.aggregateBaselines.phase4.entryPointCharacters,
      `entry-point total: ${entryCharacters} > ${budgets.aggregateBaselines.phase4.entryPointCharacters}`,
    );
    assert.ok(
      normalCharacters <= budgets.aggregateBaselines.phase4.normalPathCharacters,
      `normal-path total: ${normalCharacters} > ${budgets.aggregateBaselines.phase4.normalPathCharacters}`,
    );
    assert.ok(
      Math.ceil(entryCharacters / 4) <= budgets.aggregateBaselines.phase4.entryPointEstimate,
      `entry-point estimate: ${Math.ceil(entryCharacters / 4)} > ${budgets.aggregateBaselines.phase4.entryPointEstimate}`,
    );
    assert.ok(
      Math.ceil(normalCharacters / 4) <= budgets.aggregateBaselines.phase4.normalPathEstimate,
      `normal-path estimate: ${Math.ceil(normalCharacters / 4)} > ${budgets.aggregateBaselines.phase4.normalPathEstimate}`,
    );
    assert.deepEqual(
      {
        entryPointCharacters: entryCharacters,
        entryPointEstimate: Math.ceil(entryCharacters / 4),
        normalPathCharacters: normalCharacters,
        normalPathEstimate: Math.ceil(normalCharacters / 4),
      },
      {
        entryPointCharacters: budgets.aggregateBaselines.phase4.entryPointCharacters,
        entryPointEstimate: budgets.aggregateBaselines.phase4.entryPointEstimate,
        normalPathCharacters: budgets.aggregateBaselines.phase4.normalPathCharacters,
        normalPathEstimate: budgets.aggregateBaselines.phase4.normalPathEstimate,
      },
    );
    for (const key of [
      'entryPointCharacters',
      'entryPointEstimate',
      'normalPathCharacters',
      'normalPathEstimate',
    ]) {
      assert.ok(
        budgets.aggregateBaselines.phase4[key] <= budgets.aggregateBaselines.phase3[key],
        `${key}: Phase 4 aggregate exceeds Phase 3`,
      );
    }
  });

  it('records bounded plan and code rebuttal paths', () => {
    const count = (files) => files.reduce(
      (sum, file) => sum + measureText(fs.readFileSync(path.join(root, file), 'utf8')).characters,
      0,
    );
    const shared = [
      'skills/dispatch/SKILL.md',
      'skills/implement-dispatch/SKILL.md',
      'skills/dispatch/references/alignment.md',
    ];
    const plan = count([
      ...shared,
      'skills/dispatch-plan-review/SKILL.md',
      'skills/dispatch-plan-review/references/rebuttal-template.md',
    ]);
    const code = count([
      ...shared,
      'skills/dispatch-code-review/SKILL.md',
      'skills/dispatch-code-review/references/rebuttal-template.md',
    ]);
    assert.equal(plan, budgets.aggregateBaselines.phase4.planRebuttalPathCharacters);
    assert.equal(Math.ceil(plan / 4), budgets.aggregateBaselines.phase4.planRebuttalPathEstimate);
    assert.equal(code, budgets.aggregateBaselines.phase4.codeRebuttalPathCharacters);
    assert.equal(Math.ceil(code / 4), budgets.aggregateBaselines.phase4.codeRebuttalPathEstimate);
    for (const key of [
      'planRebuttalPathCharacters',
      'planRebuttalPathEstimate',
      'codeRebuttalPathCharacters',
      'codeRebuttalPathEstimate',
    ]) {
      assert.ok(
        budgets.aggregateBaselines.phase4[key] <= budgets.aggregateBaselines.phase3[key],
        `${key}: Phase 4 aggregate exceeds Phase 3`,
      );
    }
  });

  it('defines shared workflow terms and disambiguates scope', () => {
    const alignment = fs.readFileSync(path.join(root, 'skills/dispatch/references/alignment.md'), 'utf8');
    for (const term of ['Candidate', 'Target', 'Reserve', 'Pin', 'Level', 'Round', 'Wave', 'Slot', 'Affinity']) {
      assert.match(alignment, new RegExp(`- \\*\\*${term}\\*\\*:`));
    }
    for (const meaning of ['Change scope', 'Review Scope', 'Installation scope']) {
      assert.match(alignment, new RegExp(`- \\*\\*${meaning}\\*\\*:`));
    }
  });

  it('documents exact, nearest-lower, and lowest-higher level inheritance', () => {
    const config = fs.readFileSync(path.join(root, 'skills/implement-dispatch/config.default.jsonc'), 'utf8');
    assert.match(config, /`medium` -> `medium` \(exact\)/);
    assert.match(config, /`high`\s+-> `medium` \(nearest lower\)/);
    assert.match(config, /`low`\s+-> `medium` \(lowest higher\)/);
    assert.doesNotMatch(config, /only ever rounded down/);
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
    assert.equal(
      budgets.aggregateBaselines.phase2.normalPathCharacters -
        budgets.aggregateBaselines.phase1.normalPathCharacters,
      budgets.intentionalPhase2Delta.normalPathCharacters,
    );
    assert.match(budgets.intentionalPhase2Delta.reason, /finding identity/);
    const projection = JSON.parse(fs.readFileSync(
      path.join(root, 'tests', 'fixtures', 'review-corpus', 'projection-baseline.json'),
      'utf8',
    ));
    assert.ok(projection.projectedCharacters < projection.canonicalCharacters);
    assert.equal(projection.phase1Baseline, 'bounded-review-view-v1');
  });
});
