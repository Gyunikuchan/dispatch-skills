import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
describe('evidence eligibility', () => {
  test('only clean passing current tree and command evidence verifies a check', async () => {
    const { eligibility } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const checks = [{ criterion: 'SC1', commands: ['node a'], commandDigest: 'digest' }];
    const good = { criterion: 'SC1', commandDigest: 'digest', tree: 'tree', clean: true, before: 'tree', after: 'tree', exit: 0 };
    const fold = (data: object[]) => ({ records: data.map((data, i) => ({ seq: i + 1, key: '' + i, at: '', kind: 'evidence', by: 'tool', data })), lastSeq: data.length, torn: null });
    const trees = { headTree: 'tree', testedTree: 'tree' };
    assert.equal(eligibility(fold([good]), checks, trees)[0]!.state, 'verified');
    for (const patch of [{tree:'old'}, {clean:false}, {after:'other'}, {exit:1}, {commandDigest:'old'}]) {
      assert.equal(eligibility(fold([{...good, ...patch}]), checks, trees)[0]!.state, 'missing');
    }
    assert.equal(eligibility(fold([good]), checks, {...trees, testedTree:'dirty'})[0]!.state, 'missing');
    assert.equal(eligibility(fold([{...good, exit:1}, good]), checks, trees)[0]!.state, 'verified');
    assert.equal(eligibility(fold([good, {...good, exit:1}]), checks, trees)[0]!.state, 'verified');
  });

  test('criterion statuses', async () => {
    const { criterionStatuses } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const checks = [
      { criterion: 'verified', commands: ['node verify.ts'], commandDigest: 'digest-verified' },
      { criterion: 'manual', commands: [], commandDigest: 'digest-manual' },
      { criterion: 'manual-only', commands: [], commandDigest: 'digest-manual-only' },
      { criterion: 'waived', commands: [], commandDigest: 'digest-waived' },
      { criterion: 'failed', commands: ['node fail.ts'], commandDigest: 'digest-failed' },
      { criterion: 'mutated', commands: ['node mutate.ts'], commandDigest: 'digest-mutated' },
      { criterion: 'older-tree', commands: ['node old.ts'], commandDigest: 'digest-older' },
      { criterion: 'stale-command', commands: ['node stale.ts'], commandDigest: 'digest-stale' },
      { criterion: 'dirty-checkout', commands: ['node dirty.ts'], commandDigest: 'digest-dirty' },
      { criterion: 'contract', commands: [], commandDigest: 'digest-contract' },
    ];
    const evidence = (criterion: string, patch: Record<string, unknown> = {}) => ({
      criterion,
      commandDigest: `digest-${criterion}`,
      tree: 'head-tree',
      clean: true,
      before: 'head-tree',
      after: 'head-tree',
      exit: 0,
      path: `evidence/${criterion}.md`,
      ...patch,
    });
    const fold = (input: { kind: 'evidence' | 'manual-complete' | 'waiver'; data: Record<string, unknown>; by?: string; quote?: string }[]) => ({
      records: input.map((record, index) => ({
        seq: index + 1,
        key: `key-${index}`,
        at: '',
        by: record.by ?? 'tool',
        kind: record.kind,
        data: record.data,
        ...(record.quote !== undefined ? { quote: record.quote } : {}),
      })),
      lastSeq: input.length,
      torn: null,
    });
    const rows = criterionStatuses(fold([
      { kind: 'evidence', data: evidence('verified') },
      { kind: 'manual-complete', by: 'user', quote: 'manual quote', data: { criterion: 'verified', evidence: 'manual/proof.md' } },
      { kind: 'waiver', by: 'user', quote: 'waiver quote', data: { criterion: 'verified', reason: 'waived if needed' } },
      { kind: 'manual-complete', by: 'user', quote: 'manual quote', data: { criterion: 'manual', evidence: 'manual/path.md' } },
      { kind: 'waiver', by: 'user', quote: 'waiver quote', data: { criterion: 'manual', reason: 'waiver reason' } },
      { kind: 'manual-complete', by: 'user', quote: 'manual only quote', data: { criterion: 'manual-only', evidence: 'manual/only.md' } },
      { kind: 'waiver', by: 'user', quote: 'waived quote', data: { criterion: 'waived', reason: 'approved exception' } },
      { kind: 'evidence', data: evidence('failed', { exit: 1 }) },
      { kind: 'evidence', data: evidence('mutated', { after: 'other-tree' }) },
      { kind: 'evidence', data: evidence('older-tree', { tree: 'old-tree' }) },
      { kind: 'evidence', data: evidence('stale-command', { commandDigest: 'old-digest' }) },
      { kind: 'evidence', data: evidence('dirty-checkout') },
      { kind: 'evidence', data: evidence('contract') },
      { kind: 'waiver', by: 'user', quote: 'contract exception', data: { criterion: 'contract', reason: 'no contract test' } },
    ]), checks, { headTree: 'head-tree', testedTree: 'head-tree' });
    const byCriterion = new Map(rows.map((row) => [row.criterion, row]));

    assert.deepEqual([...byCriterion].map(([criterion, row]) => [criterion, row.state]), [
      ['verified', 'verified'], ['manual', 'manual'], ['manual-only', 'manual'], ['waived', 'waived'],
      ['failed', 'missing'], ['mutated', 'missing'], ['older-tree', 'missing'], ['stale-command', 'missing'],
      ['dirty-checkout', 'missing'], ['contract', 'verified'],
    ]);
    assert.equal(byCriterion.get('verified')?.evidence, 'evidence/verified.md');
    assert.deepEqual(
      { seq: byCriterion.get('manual')?.seq, quote: byCriterion.get('manual')?.quote, evidence: byCriterion.get('manual')?.evidence },
      { seq: 4, quote: 'manual quote', evidence: 'manual/path.md' },
    );
    assert.deepEqual(
      { seq: byCriterion.get('manual-only')?.seq, quote: byCriterion.get('manual-only')?.quote, evidence: byCriterion.get('manual-only')?.evidence },
      { seq: 6, quote: 'manual only quote', evidence: 'manual/only.md' },
    );
    assert.deepEqual(
      { seq: byCriterion.get('waived')?.seq, quote: byCriterion.get('waived')?.quote, reason: byCriterion.get('waived')?.reason },
      { seq: 7, quote: 'waived quote', reason: 'approved exception' },
    );
    assert.equal(byCriterion.get('contract')?.evidence, 'evidence/contract.md');
    const manualContract = criterionStatuses(fold([
      { kind: 'manual-complete', by: 'user', quote: 'contract manual quote', data: { criterion: 'contract', evidence: 'manual/contract.md' } },
    ]), [checks[9]!], { headTree: 'head-tree', testedTree: 'head-tree' });
    assert.deepEqual(
      { state: manualContract[0]?.state, quote: manualContract[0]?.quote, evidence: manualContract[0]?.evidence },
      { state: 'manual', quote: 'contract manual quote', evidence: 'manual/contract.md' },
    );
    assert.equal(criterionStatuses(fold([]), [checks[9]!], { headTree: 'head-tree', testedTree: 'head-tree' })[0]?.state, 'missing');

    const withoutIntegration = criterionStatuses(fold([
      { kind: 'evidence', data: evidence('verified') },
      { kind: 'manual-complete', by: 'user', quote: 'manual quote', data: { criterion: 'manual', evidence: 'manual/path.md' } },
      { kind: 'waiver', by: 'user', quote: 'waived quote', data: { criterion: 'waived', reason: 'approved exception' } },
      { kind: 'waiver', by: 'user', quote: 'contract exception', data: { criterion: 'contract', reason: 'no contract test' } },
    ]), checks, null);
    assert.deepEqual(withoutIntegration.map(({ criterion, state }) => [criterion, state]), [
      ['verified', 'missing'], ['manual', 'manual'], ['manual-only', 'missing'], ['waived', 'waived'],
      ['failed', 'missing'], ['mutated', 'missing'], ['older-tree', 'missing'], ['stale-command', 'missing'],
      ['dirty-checkout', 'missing'], ['contract', 'waived'],
    ]);
    const dirtyCheckout = criterionStatuses(fold([
      { kind: 'evidence', data: evidence('dirty-checkout') },
    ]), [checks[8]!], { headTree: 'head-tree', testedTree: 'dirty-tree' });
    assert.equal(dirtyCheckout[0]?.state, 'missing');
  });
});

test('pruned evidence requires exact transition and final tree',async()=>{
 const {criterionStatuses}=await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
 const pre=[{criterion:'SC1',commands:['step'],commandDigest:'pre'}],final=[{criterion:'final:contract',commands:['retained'],commandDigest:'final'}];
 const artifacts={spec:'spec',plan:'plan'};
 const rows=[{criterion:'SC1',commandDigest:'pre',tree:'source',before:'source',after:'source',clean:true,exit:0,path:'history.json',artifacts},{criterion:'final:contract',commandDigest:'final',tree:'target',before:'target',after:'target',clean:true,exit:0,path:'final.json',artifacts}];
 const fold=(data=rows)=>({lastSeq:2,torn:null,records:data.map((data,i)=>({seq:i+1,key:String(i),at:'',kind:'evidence',by:'tool',data}))});
 const transition={sourceTree:'source',tree:'target',pre,final,transient:['SC1'],sourceSeq:2,artifacts};
 const current={headTree:'target',testedTree:'target'};
 const status=criterionStatuses(fold(),pre,current,transition)[0]!;assert.equal(status.state,'verified');assert.equal(status.evidence,'history.json');assert.match(status.reason!,/source tree source; final evidence \[final:contract\]\(final.json\)/);
 assert.equal(criterionStatuses(fold(),pre,current)[0]!.state,'missing');
 for(const patch of [{sourceTree:'other'},{tree:'other'},{sourceSeq:1},{artifacts:{spec:'changed'}},{pre:[{...pre[0]!,commandDigest:'changed'}]}])assert.equal(criterionStatuses(fold(),pre,current,{...transition,...patch})[0]!.state,'missing');
 for(const patch of [{exit:1},{after:'mutated'},{commandDigest:'stale'},{clean:false},{tree:'unrelated'}])assert.equal(criterionStatuses(fold([rows[0]!,{...rows[1]!,...patch}]),pre,current,transition)[0]!.state,'missing');
 assert.equal(criterionStatuses(fold(),pre,{...current,testedTree:'dirty'},transition)[0]!.state,'missing');
});

test('final evidence cannot reuse an older success after a failed rerun',async()=>{
 const {criterionStatuses}=await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
 const check={criterion:'SC1',commands:['step'],commandDigest:'step'},final={criterion:'final:SC1',commands:['retained'],commandDigest:'retained'},artifacts={spec:'s',plan:'p'};
 const rows=[{criterion:'SC1',commandDigest:'step',tree:'source',before:'source',after:'source',clean:true,exit:0,artifacts},{criterion:'final:SC1',commandDigest:'retained',tree:'target',before:'target',after:'target',clean:true,exit:0,artifacts}];
 const fold=(data=rows)=>({lastSeq:data.length,torn:null,records:data.map((data,index)=>({seq:index+1,key:String(index),kind:'evidence',by:'tool',at:'',data}))});
 const transition={sourceTree:'source',tree:'target',pre:[check],final:[final],transient:['SC1'],sourceSeq:2,artifacts},current={headTree:'target',testedTree:'target'};
 assert.equal(criterionStatuses(fold(),[check],current,transition)[0]!.state,'verified');
 assert.equal(criterionStatuses(fold([...rows,{...rows[1]!,exit:7}]),[check],current,transition)[0]!.state,'missing');
 assert.equal(criterionStatuses(fold([{...rows[0]!,artifacts:{spec:'changed',plan:'p'}},rows[1]!]),[check],current,transition)[0]!.state,'missing');
 const durable={...check,criterion:'SC2'};assert.equal(criterionStatuses(fold([{...rows[0]!,criterion:'SC2',tree:'target',before:'target',after:'target'},rows[1]!]),[durable],current,{...transition,transient:[]})[0]!.state,'missing');
});


test('pruned review-only criteria retain validated historical evidence without an empty final row',async()=>{
 const {criterionStatuses}=await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
 const fold=(data:Record<string,unknown>[])=>({lastSeq:data.length,torn:null,records:data.map((data,index)=>({seq:index+1,key:String(index),kind:'evidence',by:'tool',at:'',data}))});
 const check={criterion:'SC2',commands:[],commandDigest:'review'},final={criterion:'final:contract',commands:['retained'],commandDigest:'retained'},artifacts={spec:'s',plan:'p'};
 const source={criterion:'SC2',commandDigest:'review',tree:'source',before:'source',after:'source',clean:true,exit:0,artifacts,path:'review-source.json'};
 const target={criterion:'final:contract',commandDigest:'retained',tree:'target',before:'target',after:'target',clean:true,exit:0,artifacts};
 const transition={sourceTree:'source',tree:'target',pre:[check],final:[final],transient:['SC1'],sourceSeq:2,artifacts};
 const current={headTree:'target',testedTree:'target'};
 const status=(rows:Record<string,unknown>[],patch={})=>criterionStatuses(fold(rows),[check],current,{...transition,...patch})[0]!;
 assert.equal(status([source,target]).state,'verified');assert.equal(status([source,target]).evidence,'review-source.json');assert.match(status([source,target]).reason!,/historical pre-prune/);
 for(const rows of [[source],[{...source,exit:1},target],[{...source,artifacts:{spec:'changed'}},target],[source,{...target,exit:1}],[target]])assert.equal(status(rows).state,'missing');
 assert.equal(status([source,target],{sourceSeq:1}).state,'missing');assert.equal(status([source,target],{tree:'other'}).state,'missing');
});
