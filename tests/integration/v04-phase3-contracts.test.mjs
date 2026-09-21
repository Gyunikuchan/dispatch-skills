import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

describe('v0.4 deterministic plan-lint contracts', () => {
  it('canonical template places stable criteria before changes and emits executable test bullets', () => {
    const template = read('skills/dispatch/references/templates/plan.md');
    const criteriaAt = template.indexOf('## Success Criteria');
    const changesAt = template.indexOf('## Proposed Changes');
    assert.ok(criteriaAt !== -1 && criteriaAt < changesAt);
    assert.match(template, /- \[SC(?:#|\d+)\]/);
    assert.match(template, /^\s+- Changes:/m);
    assert.match(template, /^\s+- Verify: `[^`]+`/m);
    assert.match(template, /^- `[^`]+`|^- None: <reason>/m);
  });

  it('standalone handling asks only closed decisions with choices', () => {
    const skill = read('skills/dispatch-plan-review/SKILL.md');
    assert.match(skill, /plan-lint/);
    assert.match(skill, /non-empty `choices`|choices.*non-empty/s);
    assert.match(skill, /diagnostics.*stop|report.*defects.*stop/s);
    assert.match(skill, /never.*replay|not.*replay/s);
  });

  it('orchestrated handling repairs owned lint defects without accounting consumption', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    // R7 (v0.5 I02): the legacy-coverage gate is gone, so no contract passes artifactOwned.
    for (const rel of ['skills/implement-dispatch/SKILL.md', 'skills/dispatch-plan-review/SKILL.md', 'skills/dispatch-code-review/SKILL.md']) {
      assert.doesNotMatch(read(rel), /artifactOwned/, rel);
    }
    assert.match(skill, /\[SC#\].*Changes:.*Verify:/s);
    assert.match(skill, /plan-lint/);
    assert.match(skill, /fix|repair/);
    assert.match(skill, /re-prepare/);
    assert.match(skill, /without.*(?:ask|user)/s);
    assert.match(skill, /neither.*review round.*budget|without.*review round.*budget/s);
  });

  it('documents conservative command-to-path mapping and unavailable evidence', () => {
    const contract = read('skills/dispatch/references/verbs/implement.md');
    assert.match(contract, /exact trimmed-string match/i);
    assert.match(contract, /every criterion.*Changes:|all.*criteria.*Changes:/is);
    assert.match(contract, /full approved path set/i);
    assert.match(contract, /None:.*unavailable/is);
  });
});
