import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('red quality and failure disposition contract', () => {
  it('SC1: carries parseable RED-MATRIX evidence in the existing envelope', () => {
    const contract = read('skills/dispatch/references/verbs/implement.md');
    assert.match(contract, /RED-MATRIX/);
    assert.match(read('skills/implement-dispatch/SKILL.md'), /RED-quality/);
  });

  it('SC2: defines checker CLI, mapped scope, stable identity, and exit statuses', () => {
    const script = read('skills/dispatch/scripts/red-quality.mjs');
    assert.match(script, /--plan/);
    assert.match(script, /--evidence/);
    assert.match(script, /--red/);
    assert.match(script, /criterionMappings|mapVerificationCommandsToPaths/);
    assert.match(script, /exitCode|process\.exitCode/);
  });

  it('SC3: distinguishes routine and risk-heavy pre-production review accounting', async () => {
    const contract = read('skills/dispatch/references/verbs/implement.md');
    assert.match(contract, /risk-heavy/i);
    assert.match(contract, /read-delegate/i);
    assert.match(contract, /routine/i);
    assert.match(contract, /degrad/i);
    const accounting = await import(path.join(root, 'skills/dispatch/scripts/risk-review-accounting.mjs'));
    assert.equal(typeof accounting.accountRiskReview, 'function');
    const before = { reviewEvents: 2, checkpoints: 1, ledgerEvents: 4 };
    const after = accounting.accountRiskReview({ before, riskHeavy: true, available: false });
    assert.deepEqual(after, before);
    assert.match(accounting.describeRiskReviewDegradation({ available: false }), /orchestrator-only|degrad/i);
  });

  it('SC4: preserves failed trees and orders failure-disposition before resume drift', () => {
    const contract = read('skills/dispatch/references/verbs/implement.md');
    assert.match(contract, /failure-disposition/);
    assert.match(contract, /inspect-first/);
    assert.match(contract, /post-snapshot|captured failure snapshot/i);
    assert.match(contract, /resolved.*stable-failure|stable-failure.*resolved/i);
    assert.match(read('skills/dispatch/scripts/ledger.mjs'), /resumeOrdinary/);
  });

  it('SC5: requires explicit, attributable-only reversion and stable-failure', async () => {
    const contract = read('skills/dispatch/references/verbs/implement.md');
    assert.match(contract, /explicit.*revert|revert.*explicit/i);
    assert.match(contract, /mixed.*path|non-separable/i);
    assert.match(contract, /stable-failure/);
    assert.match(read('skills/implement-dispatch/README.md'), /keep|revert|inspect/i);
    const attribution = await import(path.join(root, 'skills/dispatch/scripts/failure-attribution.mjs'));
    assert.equal(typeof attribution.attributablePaths, 'function');
    const base = { 'caller.txt': { objectId: 'base' } };
    const taskStart = { 'run.txt': { objectId: 'before' } };
    const failure = { 'run.txt': { objectId: 'after' } };
    assert.deepEqual(attribution.attributablePaths({ baseline: base, taskStart, failureSnapshot: failure, authorized: true }), ['run.txt']);
    assert.deepEqual(attribution.attributablePaths({ baseline: base, taskStart, failureSnapshot: failure, authorized: false }), []);
    assert.equal(attribution.failureAttribution({ baseline: { 'run.txt': { objectId: 'caller' } }, taskStart, failureSnapshot: failure, authorized: true }).allowed, false);
    assert.equal(attribution.failureAttribution({ baseline: base, taskStart, failureSnapshot: failure, currentState: { 'run.txt': { objectId: 'later' } }, authorized: true }).reason, 'post-failure-drift');
    assert.deepEqual(attribution.attributablePaths({ taskStart: {}, failureSnapshot: { 'new.txt': { objectId: 'new' } }, authorized: true }), ['new.txt']);
  });

  it('SC6: keeps release-specific I04 migration out of shipped skill documentation', () => {
    const readme = read('skills/implement-dispatch/README.md');
    assert.doesNotMatch(readme, /\bI04\b/);
    assert.match(readme, /RED-quality/);
  });

  it('SC7: keeps SKILL.md at or below the numeric 1,623-word bound', () => {
    const words = read('skills/implement-dispatch/SKILL.md').trim().split(/\s+/).length;
    assert.ok(words <= 1623, `SKILL.md has ${words} words`);
    assert.match(read('skills/implement-dispatch/SKILL.md'), /implement\.md#(?:red-quality|failure-disposition)/i);
  });
});
