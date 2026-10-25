import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parsePlan } from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';
export const PLAN = ['# Work', '', '## Task Map', '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |', '| T1 | File | Works | none | SC1 |', '', '## Proposed Changes', '### T1 — File', '#### [NEW] src/file.ts', '- Purpose: implements behavior.', '', '## Success Criteria', '- [SC1] File works', '  - Changes: src/file.ts', '  - Verify: `node -e "process.exit(0)"`', '  - Evidence: verify', '', '## Verification Plan', '### Automated Tests', '- `node -e "process.exit(0)"`', '- `node -e "process.stdout.write(\'contract\')"`', ''].join('\n');
export function parsed(source = PLAN) { const result = parsePlan(source); assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('plan'); return result.plan; }
describe('plan view', () => {
  test('task identity ignores positions and tracks task behavior and command changes', async () => {
    const { taskSection, checks, ownedPaths } = await import('../../../skills/dispatch/scripts/toolkit/plan-view.ts');
    const plan = parsed();
    assert.deepEqual(ownedPaths(plan, 'T1'), ['src/file.ts']);
    assert.equal(taskSection(plan, 'T1'), taskSection(parsed('\n\n' + PLAN), 'T1'));
    for (const source of [PLAN.replace('implements behavior', 'implements new behavior'), PLAN.replace('File works', 'File runs'), PLAN.replace('process.exit(0)', 'process.exit(1)')]) assert.notEqual(taskSection(plan,'T1'), taskSection(parsed(source),'T1'));
    assert.notEqual(checks(plan)[0]!.commandDigest, checks(parsed(PLAN.replace('process.exit(0)', 'process.exit(1)')))[0]!.commandDigest);
    assert.deepEqual(checks(plan).map(c => [c.criterion,c.commands.length]), [['SC1',1],['contract',1]]);
    assert.throws(() => ownedPaths(plan,'T99'), /unknown task/i);
  });
});

test('final checks preserve retained contracts',async()=>{const {checks,finalChecks,commandDigest}=await import('../../../skills/dispatch/scripts/toolkit/plan-view.ts');const base=parsed();const plan={...base,criteria:[{...base.criteria[0]!,retain:'transient' as const,verify:[{command:'step',final:false},{command:'retained',final:true}]},{...base.criteria[0]!,id:'SC2',verify:[{command:'durable',final:false}]}]};const rows=finalChecks(plan);assert.deepEqual(rows.map(c=>[c.criterion,c.commands]),[['final:SC1',['retained']],['final:SC2',['durable']],['final:contract',checks(plan).at(-1)!.commands]]);assert.equal(rows[0]!.commandDigest,commandDigest({criterion:'final:SC1',commands:['retained']}));assert.notEqual(rows[0]!.commandDigest,checks(plan)[0]!.commandDigest);});
