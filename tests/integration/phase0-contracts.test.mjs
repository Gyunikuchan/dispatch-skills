import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Phase 0 workflow contracts', () => {
  it('discloses low/off, enabled targets, omitted models, fallbacks, and final deltas', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    assert.match(skill, /Resolved flow: level <level>/);
    assert.match(skill, /plan review <on\|off>/);
    assert.match(skill, /provider\s+default/);
    assert.match(skill, /native fallback/);
    assert.match(skill, /off — companion unavailable/);
    assert.match(skill, /Resolved flow unchanged after final scope check/);
    assert.match(skill, /exact phase\/target\/round\/consensus delta/);
  });

  it('removes the implicit HEAD~1 fallback and names the corrective action', () => {
    const prompt = read('skills/dispatch/references/templates/review-prompt.md') + read('skills/dispatch/references/templates/review-prompt-code.md');
    const skill = read('skills/dispatch-code-review/SKILL.md');
    const prepare = read('skills/dispatch/scripts/prepare-code-review.mjs');
    assert.doesNotMatch(prompt, /git diff HEAD~1/);
    assert.match(prompt, /Never substitute `HEAD~1`/);
    assert.match(skill, /No reviewable changes/);
    assert.match(skill, /explicit `range`/);
    assert.match(prepare, /resolveReviewScope\(\{\s*repoRoot,\s*explicitRange: request\.range/);
  });

  it('warns before OS-temp relocation and preserves exact destination reporting', () => {
    const implement = read('skills/implement-dispatch/SKILL.md');
    const alignment = read('skills/dispatch/references/review.md');
    assert.match(implement, /may be\s+deleted by the OS/);
    assert.match(implement, /destination/);
    assert.match(alignment, /may be deleted by the OS/);
    assert.match(alignment, /destination/);
  });
});
