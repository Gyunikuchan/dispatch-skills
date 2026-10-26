import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Fold } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import type { LedgerRecord } from '../../../skills/dispatch/scripts/toolkit/records.ts';
const row = (seq: number, kind: string, data: Record<string, any>): LedgerRecord => ({seq,kind,data,key:String(seq),at:'now',by:'tool'});
const launch = row(2,'writer',{phase:'launched',task:'T1',path:'.state/worktrees/T1-1',base:{commit:'base',taskSection:'section',seq:1}});
const fold = (...records: LedgerRecord[]): Fold => ({records,lastSeq:records.at(-1)?.seq ?? 0,torn:null});
describe('writer records', () => {
  it('detects task edits after the launch boundary only', async () => {
    const {isStale}=await import('../../../skills/dispatch/scripts/toolkit/writers.ts');
    assert.equal(isStale(fold(launch),launch,'changed'),true);
    for (const [seq,affects,expected] of [[3,['T1'],true],[3,['T2'],false],[3,[],false],[1,['T1'],false]] as const) {
      assert.equal(isStale(fold(row(seq,'edit',{affects}),launch),launch,'section'),expected);
    }
  });
  it('derives every writer state and retains superseded launches', async () => {
    const {launches,writerStates}=await import('../../../skills/dispatch/scripts/toolkit/writers.ts');
    const observe = () => ({exists:true,dirty:false,head:'base'});
    const state = (f: Fold, o=observe) => writerStates(f,['T1'],o).at(-1)!.state;
    assert.equal(state(fold()),'unlaunched');
    assert.equal(state(fold(launch)),'no-progress');
    assert.equal(state(fold(launch),()=>({exists:true,dirty:true,head:'base'})),'ready-to-submit');
    assert.equal(state(fold(launch),()=>({exists:true,dirty:false,head:'commit'})),'ready-to-submit');
    assert.equal(state(fold(launch),()=>({exists:false,dirty:false,head:''})),'missing-worktree');
    assert.equal(state(fold(launch,row(3,'writer',{phase:'abandoned',task:'T1',launch:1}))),'launch-abandoned');
    const again=row(3,'writer',{...launch.data});
    assert.equal(launches(fold(launch,again),'T1')[0]!.superseded,true);
    assert.equal(writerStates(fold(launch,again),['T1'],observe)[0]!.state,'launch-abandoned');
    const finished=row(3,'writer',{phase:'finished',task:'T1',launch:1,candidate:'commit'});
    assert.equal(state(fold(launch,finished)),'candidate-unintegrated');
    assert.equal(state(fold(launch,finished,row(4,'integrate',{phase:'done',task:'T1',commit:'picked'}))),'integrated');
    assert.equal(state(fold(launch,finished,row(4,'integrate',{phase:'abandoned',task:'T1',candidate:'commit'}))),'integration-abandoned');
  });
  it('uncommitted consumers treat the integration as terminal by source', async () => {
    const {terminalWorktrees}=await import('../../../skills/dispatch/scripts/toolkit/writers.ts');
    const opened=row(1,'integrate',{phase:'opened',path:'integration'});
    const delivered=row(5,'integrate',{phase:'delivered',mode:'uncommitted',source:'head'});
    assert.deepEqual(terminalWorktrees(fold(opened,delivered),{integration:{head:'head'}}),['integration']);
    assert.deepEqual(terminalWorktrees(fold(opened,delivered),{integration:{head:'other'}}),[]);
  });
  it('squash terminal uses source and retains unfinished writer work', async () => {
    const {terminalWorktrees}=await import('../../../skills/dispatch/scripts/toolkit/writers.ts');
    const opened=row(1,'integrate',{phase:'opened',path:'integration'});
    const delivered=row(5,'integrate',{phase:'delivered',mode:'squash',source:'head',to:'caller'});
    const observed={integration:{head:'head'}};
    assert.deepEqual(terminalWorktrees(fold(opened,launch,delivered),observed),[]);
    const abandoned=row(3,'writer',{phase:'abandoned',task:'T1',launch:1});
    assert.deepEqual(terminalWorktrees(fold(opened,launch,abandoned,delivered),observed).sort(),['.state/worktrees/T1-1','integration']);
    assert.deepEqual(terminalWorktrees(fold(opened,row(2,'integrate',{phase:'closed'})),observed),['integration']);
    const finished=row(3,'writer',{phase:'finished',task:'T1',launch:1,candidate:'commit'});
    assert.deepEqual(terminalWorktrees(fold(opened,launch,finished,delivered),observed),[]);
    assert.deepEqual(terminalWorktrees(fold(opened,launch,finished,row(4,'integrate',{phase:'done',task:'T1',commit:'picked'}),delivered),observed).sort(),['.state/worktrees/T1-1','integration']);
    assert.deepEqual(terminalWorktrees(fold(opened,delivered),{integration:{head:'other'}}),[]);
  });
});
