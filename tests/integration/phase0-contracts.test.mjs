import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

describe('v0.5 unified contract', () => {
  it('makes dispatch the model-visible grammar and action loop', () => {
    const text = read('skills/dispatch/SKILL.md');
    assert.match(text, /ask\|plan\|design\|review\|implement/);
    for (const action of ['ask-user','author','launch','native-fallback','adjudicate','apply-fixes','delegate-write','verify','done']) assert.match(text, new RegExp(`\\b${action}\\b`));
    assert.match(text, /--help.*authoritative/s);
  });
  it('keeps every companion as a small user alias with a diagnostic', () => {
    for (const name of ['dispatch-plan-review','dispatch-code-review','dispatch-design-review','implement-dispatch']) {
      const text = read(`skills/${name}/SKILL.md`);
      assert.match(text, /disable-model-invocation: true/);
      assert.match(text, new RegExp(`${name} requires the dispatch skill`));
      assert.ok(text.trim().split(/\s+/).length < 100, `${name} is not a small alias`);
    }
  });
  it('does not inject code-review fixes', () => {
    const text = read('skills/dispatch-code-review/SKILL.md');
    assert.match(text, /only when it appears in the user's invocation/);
    assert.match(text, /otherwise the review is report-only/);
  });
});
