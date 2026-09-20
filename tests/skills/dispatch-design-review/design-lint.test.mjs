import assert from 'node:assert/strict'; import { describe, it } from 'node:test'; import { lintDesign } from '../../../skills/dispatch-design-review/scripts/design-lint.mjs';
const base=`# D\n\n## Architecture & Boundaries\nx\n## Alternatives & Decisions\nx\n## Risks, Security & Operations\nx\n## Increment Dependency Graph\n| ID | Priority | Summary | Prerequisites | Paths |\n| --- | ---: | --- | --- | --- |\n| I01 | 1 | one | none | a |\n| I02 | 2 | two | I01 | b |`;
describe('design lint',()=>{
  it('accepts a valid graph independent of row priority order',()=>assert.equal(lintDesign(base.replace('| I01 | 1 | one | none | a |\n| I02 | 2 | two | I01 | b |','| I02 | 2 | two | I01 | b |\n| I01 | 1 | one | none | a |')).valid,true));
  it('rejects cycles',()=>assert.ok(lintDesign(base.replace('I01 | 1 | one | none','I01 | 1 | one | I02')).diagnostics.some(d=>d.code==='cycle')));
  it('rejects missing and non-sequential increments',()=>{
    assert.ok(lintDesign(base.replace(/^\| I\d{2}.*$/gm, '')).diagnostics.some(d=>d.code==='missing-increments'));
    assert.ok(lintDesign(base.replace('I02 | 2','I05 | 2')).diagnostics.some(d=>d.code==='invalid-id-sequence'));
  });
});
