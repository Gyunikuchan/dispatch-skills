import assert from 'node:assert/strict'; import { describe, it } from 'node:test'; import { lintDesign } from '../../../skills/dispatch-design-review/scripts/design-lint.mjs';
import { designExtras } from '../../fixtures/design-sections.mjs';
import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const lintScript=fileURLToPath(new URL('../../../skills/dispatch-design-review/scripts/design-lint.mjs', import.meta.url));
const base=`# D\n${designExtras(['I01','I02'])}\n## Architecture & Boundaries\nx\n## Alternatives & Decisions\nx\n## Risks, Security & Operations\nx\n## Increment Dependency Graph\n| ID | Priority | Summary | Prerequisites | Paths |\n| --- | ---: | --- | --- | --- |\n| I01 | 1 | one | none | a |\n| I02 | 2 | two | I01 | b |`;
describe('design lint',()=>{
  it('accepts a valid graph independent of row priority order',()=>assert.equal(lintDesign(base.replace('| I01 | 1 | one | none | a |\n| I02 | 2 | two | I01 | b |','| I02 | 2 | two | I01 | b |\n| I01 | 1 | one | none | a |')).valid,true));
  it('requires every increment detail field',()=>{
    const linted=lintDesign(base.replace('- Parallel safety: x\n### I02','### I02'));
    assert.deepEqual(linted.diagnostics,[{code:'missing-increment-field',id:'I01',field:'Parallel safety'}]);
    assert.ok(lintDesign(base.replace('## Final Integration','## Other')).diagnostics.some(d=>d.code==='missing-section'));
  });
  it('rejects cycles',()=>assert.ok(lintDesign(base.replace('I01 | 1 | one | none','I01 | 1 | one | I02')).diagnostics.some(d=>d.code==='cycle')));
  it('rejects missing and non-sequential increments',()=>{
    assert.ok(lintDesign(base.replace(/^\| I\d{2}.*$/gm, '')).diagnostics.some(d=>d.code==='missing-increments'));
    assert.ok(lintDesign(base.replace('I02 | 2','I05 | 2')).diagnostics.some(d=>d.code==='invalid-id-sequence'));
  });
  it('ignores increment rows outside the graph section and reports them as missing increments',()=>{
    const stray = base.replace('## Increment Dependency Graph','## Other Section') + '\n| I03 | 3 | outside | none | c |';
    const linted = lintDesign(stray);
    assert.ok(linted.diagnostics.some(d=>d.code==='missing-increments'));
  });
  it('does not parse a populated Execution Status mirror as graph rows',()=>{
    const mirrored = `${base}\n\n## Execution Status\n| ID | State | Next Action |\n| --- | --- | --- |\n| I01 | complete | - |\n| I02 | ready | implement I02 |\n`;
    assert.equal(lintDesign(mirrored).valid, true);
  });
  it('runs as a CLI: prints JSON and exits 1 on an invalid design',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'design-lint-'));
    try {
      const valid=path.join(dir,'valid.md'); const invalid=path.join(dir,'invalid.md');
      fs.writeFileSync(valid,base); fs.writeFileSync(invalid,base.replace('## Final Integration','## Other'));
      const ok=spawnSync(process.execPath,[lintScript,valid],{encoding:'utf8'});
      assert.equal(ok.status,0); assert.equal(JSON.parse(ok.stdout).valid,true);
      const bad=spawnSync(process.execPath,[lintScript,invalid],{encoding:'utf8'});
      assert.equal(bad.status,1); assert.equal(JSON.parse(bad.stdout).valid,false);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
});
