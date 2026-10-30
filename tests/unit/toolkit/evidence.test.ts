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

test('cleanup keeps pre-cleanup evidence only for removed criteria',async()=>{
 const {criterionStatuses}=await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
 const checks=[{criterion:'SC1',commands:['step'],commandDigest:'one'},{criterion:'SC2',commands:['kept'],commandDigest:'two'}];
 const row=(criterion:string,commandDigest:string,tree:string,patch={})=>({criterion,commandDigest,tree,before:tree,after:tree,clean:true,exit:0,path:criterion+'.json',...patch});
 const fold=(data:Record<string,unknown>[])=>({lastSeq:data.length,torn:null,records:data.map((data,i)=>({seq:i+1,key:String(i),at:'',kind:'evidence',by:'tool',data}))});
 const cleanup={from:'source-commit',fromTree:'source',removed:['SC1']};
 const current={headTree:'target',testedTree:'target'};
 const state=(rows:Record<string,unknown>[],binding:typeof cleanup|null=cleanup,tree=current)=>criterionStatuses(fold(rows),checks,tree,binding).map(s=>s.state).join();
 const rows=[row('SC1','one','source'),row('SC2','two','target')];
 const [removed,kept]=criterionStatuses(fold(rows),checks,current,cleanup);
 assert.equal(removed!.state,'verified');assert.equal(removed!.evidence,'SC1.json');assert.match(removed!.reason!,/verified at source-commit; tests removed in cleanup/);
 assert.equal(kept!.state,'verified');assert.equal(kept!.reason,undefined);
 assert.equal(state(rows,null),'missing,verified');
 assert.equal(state([row('SC1','one','source'),row('SC2','two','source')]),'verified,missing');
 for(const patch of [{exit:1},{after:'mutated'},{clean:false},{commandDigest:'stale'},{tree:'other'}])assert.equal(state([row('SC1','one','source',patch),rows[1]!]),'missing,verified');
 assert.equal(state(rows,cleanup,{...current,testedTree:'dirty'}),'verified,missing');
});
