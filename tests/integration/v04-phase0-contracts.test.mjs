import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('v0.4 core correctness contracts', () => {
  it('orders baseline before approval and requires fresh final evidence', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    const section = skill.slice(skill.indexOf('## 3. Baseline, approval, and implementation'), skill.indexOf('## 4. Review and settle code'));
    assert.ok(section.indexOf('Run the baseline') < section.indexOf('Present the settled plan'));
    assert.match(skill, /known red — unchanged/);
    assert.match(skill, /fresh host output/);
    assert.match(skill, /tests-only stage/);
    assert.match(skill, /side-effect reconciliation/);
    assert.match(skill, /never downgrade/);
  });

  it('single-sources missing runner result fallback', () => {
    const dispatch = read('skills/dispatch/SKILL.md');
    const sentence = /completion notification without a parseable runner result/g;
    assert.equal(dispatch.match(sentence)?.length, 1);
    for (const file of [
      'skills/dispatch-plan-review/SKILL.md',
      'skills/dispatch-code-review/SKILL.md',
    ]) {
      const skill = read(file);
      assert.match(skill, /dispatch\/SKILL\.md#run/);
      assert.doesNotMatch(skill, sentence);
    }
  });

  it('rejects speculative and decision-conflicting findings', () => {
    const alignment = read('skills/dispatch/references/alignment.md');
    assert.match(alignment, /success reports are claims, not verification/);
    assert.match(alignment, /unused capability/);
    assert.match(alignment, /user-approved decision/);
    assert.match(alignment, /Related unclear findings/);
  });

  it('defines a downstream-neutral minimum walkthrough', () => {
    const contract = read('skills/dispatch/references/walkthrough-contract.md');
    const template = read('skills/dispatch-code-review/references/walkthrough-template.md');
    const headings = [...contract.matchAll(/`(## [^`]+)`/g)].map((match) => match[1]);
    assert.match(contract, /## Verification & Validation/);
    assert.match(contract, /\*No reviews conducted yet\.\*/);
    assert.doesNotMatch(contract, /dispatch-code-review/);
    assert.deepEqual(headings, [
      '## Changes Made',
      '## Verification & Validation',
      '## Key Deviations',
      '## Review Findings & Resolutions',
      '## Follow-ups',
    ]);
    for (const heading of headings) assert.match(template, new RegExp(`^${heading}$`, 'm'));
    assert.match(template, /Command: `<test command>` — exit <status>/);
  });
});
