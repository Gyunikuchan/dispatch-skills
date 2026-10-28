import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePlan} from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';

test('red gaps isolate observed failures and distinguish required evidence',async()=>{
  const {redGaps}=await import('../../../skills/dispatch/scripts/toolkit/red.ts');
  const parsed=parsePlan('# Work\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n| T1 | Work | Works | none | SC1 |\n## Proposed Changes\n### T1 — Work\n#### [MODIFY] src/a.ts\n## Success Criteria\n- [SC1] Works\n  - Changes: src/a.ts\n  - Tests: tests/a.ts\n  - RED: `node --test tests/a.ts`\n  - Verify: `node --test tests/a.ts`\n  - Evidence: red\n## Verification Plan\n### Automated Tests\n- `node --test tests/a.ts`\n');
  assert.ok(parsed.ok,JSON.stringify(parsed)); if(!parsed.ok)return;
  const plan=parsed.plan, criterion=plan.criteria[0]!;
  const gaps=(report?:string,changed=['tests/a.ts'])=>redGaps({plan,task:'T1',changed,report});
  for(const report of [undefined,'SC1 tests/a.ts','## Changed files\ntests/a.ts\n## Commands\nnode tests/a.ts\n## Observed RED failures\nNone\n','## Observed RED failures\nNone\n## Commands\nSC1'])
    assert.deepEqual(gaps(report),[{criterion:'SC1',line:criterion.line,testsTouched:true}]);
  assert.deepEqual(gaps('## Observed RED failures\nSC1 failed\n',[]),[]);
  assert.deepEqual(gaps('## Observed RED failures\nnode --test tests/a.ts exited 1\n'),[]);
  assert.equal(gaps(undefined,[])[0]!.testsTouched,false);
  for(const patch of [{redException:'approved exception'},{evidence:'verify' as const},{red:null}])
    assert.deepEqual(redGaps({plan:{...plan,criteria:[{...criterion,...patch}]},task:'T1',changed:[],report:undefined}),[]);
});

test('red gaps accept a non-zero wrapper exit and ignore zero, null or absent exits',async()=>{
  const {redGaps}=await import('../../../skills/dispatch/scripts/toolkit/red.ts');
  const parsed=parsePlan('# Work\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n| T1 | Work | Works | none | SC1 |\n## Proposed Changes\n### T1 — Work\n#### [MODIFY] src/a.ts\n## Success Criteria\n- [SC1] Works\n  - Changes: src/a.ts\n  - Tests: tests/a.ts\n  - RED: `node --test tests/a.ts`\n  - Verify: `node --test tests/a.ts`\n  - Evidence: red\n## Verification Plan\n### Automated Tests\n- `node --test tests/a.ts`\n');
  assert.ok(parsed.ok,JSON.stringify(parsed)); if(!parsed.ok)return;
  const {plan}=parsed;
  const gaps=(redExits?:ReadonlyMap<string,number|null>)=>redGaps({plan,task:'T1',changed:[],...(redExits===undefined?{}:{redExits})});
  assert.deepEqual(gaps(new Map([['SC1',1]])),[]);
  assert.equal(gaps(new Map([['SC1',0]])).length,1);
  assert.equal(gaps(new Map([['SC1',null]])).length,1);
  assert.equal(gaps().length,1);
});
