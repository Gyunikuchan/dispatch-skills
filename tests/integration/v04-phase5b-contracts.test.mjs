import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { buildScratchPaths, isReservedOrdinarySlug } from '../../skills/dispatch/scripts/resolve-artifact-paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative) {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

describe('v0.4 Phase 5B contracts', () => {
  it('defines canonical phased artifact paths and reserved ordinary slugs', () => {
    assert.equal(buildScratchPaths('2026-09-21', 'root', 'design'), '.scratch/plan/2026-09-21-root-design.md');
    assert.equal(buildScratchPaths('2026-09-21', 'root-i01-one', 'increment-plan'), '.scratch/plan/2026-09-21-root-i01-one-plan.md');
    assert.equal(buildScratchPaths('2026-09-21', 'root-i01-one', 'increment-walkthrough'), '.scratch/plan/2026-09-21-root-i01-one-walkthrough.md');
    assert.equal(buildScratchPaths('2026-09-21', 'root', 'integration-walkthrough'), '.scratch/plan/2026-09-21-root-integration-walkthrough.md');
    for (const slug of ['root-design', 'root-integration', 'root-integration-walkthrough', 'root-i01-one', 'demo-i02-switch-plan']) {
      assert.equal(isReservedOrdinarySlug(slug), true, slug);
    }
  });

  it('ships the design-path resume form and the increment loop', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    assert.match(skill, /\/implement-dispatch <design-path>/);
    assert.match(skill, /Increment Dependency Graph|Execution Status/);
    assert.match(skill, /tests-only|RED_READY/);
    assert.doesNotMatch(skill, /Increment execution, amendments, and integration remain unavailable/);
    assert.match(skill, /One increment per invocation|one increment per invocation/);
    assert.match(skill, /adjacent-fix/);
    assert.match(skill, /Recommended Follow-ups/);
    assert.match(skill, /Next Action/);
    assert.match(skill, /design-approved-stop/);
  });

  it('names baseline-before-first-dispatch and the durable stop in implement-dispatch prose', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    assert.match(skill, /baseline/i);
    assert.match(skill, /run-complete/);
    const contract = read('skills/implement-dispatch/references/design-contract.md');
    assert.match(contract, /increment/i);
    assert.doesNotMatch(contract, /unavailable until a later capability exists/);
    assert.match(contract, /integration/i);
  });

  it('documents amendment write-ahead, backup, and activation rules', () => {
    const contract = read('skills/implement-dispatch/references/design-contract.md');
    assert.match(contract, /prepared/i);
    assert.match(contract, /\.bak/);
    assert.match(contract, /\.tmp/);
    assert.match(contract, /activated/i);
    assert.match(contract, /reconcil/i);
    const ledgerContract = read('skills/implement-dispatch/references/ledger-contract.md');
    assert.match(ledgerContract, /increment-state/);
    assert.match(ledgerContract, /amendment/);
    assert.match(ledgerContract, /adjacent-fix/);
    assert.match(ledgerContract, /integration/);
  });

  it('requires final integration on a separate invocation with aggregate review and relocation rules', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    assert.match(skill, /final integration|integration gate/i);
    assert.match(skill, /integration-walkthrough/);
    assert.match(skill, /never relocate the ledger|never relocated/i);
  });

  it('ships the Execution Status template shape and drops unavailability wording', () => {
    const template = read('skills/dispatch-design-review/references/design-template.md');
    assert.match(template, /## Execution Status/);
    assert.match(template, /Next Action/);
    assert.match(template, /ready|completed/);
    for (const readme of ['skills/dispatch-design-review/README.md', 'skills/implement-dispatch/README.md']) {
      const text = read(readme);
      assert.doesNotMatch(text, /increment execution is not (yet )?available/i);
      assert.doesNotMatch(text, /not available in this (phase|release)/i);
    }
  });
});
