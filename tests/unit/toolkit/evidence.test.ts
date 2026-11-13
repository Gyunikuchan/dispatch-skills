import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Check } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
describe('evidence eligibility', () => {
  test('only clean passing current tree and command evidence verifies a check', async () => {
    const { eligibility } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const checks: Check[] = [{ criterion: 'SC1', commands: ['node a'], commandDigest: 'digest', evidenceClass: 'check' }];
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
    const checks: Check[] = [
      { criterion: 'verified', commands: ['node verify.ts'], commandDigest: 'digest-verified', evidenceClass: 'check' },
      { criterion: 'manual', commands: [], commandDigest: 'digest-manual', evidenceClass: 'review' },
      { criterion: 'manual-only', commands: [], commandDigest: 'digest-manual-only', evidenceClass: 'review' },
      { criterion: 'waived', commands: [], commandDigest: 'digest-waived', evidenceClass: 'review' },
      { criterion: 'review-tool', commands: ['node review.ts'], commandDigest: 'digest-review-tool', evidenceClass: 'review' },
      { criterion: 'failed', commands: ['node fail.ts'], commandDigest: 'digest-failed', evidenceClass: 'check' },
      { criterion: 'mutated', commands: ['node mutate.ts'], commandDigest: 'digest-mutated', evidenceClass: 'check' },
      { criterion: 'older-tree', commands: ['node old.ts'], commandDigest: 'digest-older', evidenceClass: 'check' },
      { criterion: 'stale-command', commands: ['node stale.ts'], commandDigest: 'digest-stale', evidenceClass: 'check' },
      { criterion: 'dirty-checkout', commands: ['node dirty.ts'], commandDigest: 'digest-dirty', evidenceClass: 'check' },
      { criterion: 'contract', commands: [], commandDigest: 'digest-contract', evidenceClass: 'contract' },
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
      { kind: 'evidence', data: evidence('review-tool') },
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
      ['verified', 'verified'], ['manual', 'manual'], ['manual-only', 'manual'], ['waived', 'waived'], ['review-tool', 'missing'],
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
    ]), [checks[10]!], { headTree: 'head-tree', testedTree: 'head-tree' });
    assert.deepEqual(
      { state: manualContract[0]?.state, quote: manualContract[0]?.quote, evidence: manualContract[0]?.evidence },
      { state: 'manual', quote: 'contract manual quote', evidence: 'manual/contract.md' },
    );
    assert.equal(criterionStatuses(fold([]), [checks[10]!], { headTree: 'head-tree', testedTree: 'head-tree' })[0]?.state, 'missing');

    const withoutIntegration = criterionStatuses(fold([
      { kind: 'evidence', data: evidence('verified') },
      { kind: 'manual-complete', by: 'user', quote: 'manual quote', data: { criterion: 'manual', evidence: 'manual/path.md' } },
      { kind: 'waiver', by: 'user', quote: 'waived quote', data: { criterion: 'waived', reason: 'approved exception' } },
      { kind: 'waiver', by: 'user', quote: 'contract exception', data: { criterion: 'contract', reason: 'no contract test' } },
    ]), checks, null);
    assert.deepEqual(withoutIntegration.map(({ criterion, state }) => [criterion, state]), [
      ['verified', 'missing'], ['manual', 'manual'], ['manual-only', 'missing'], ['waived', 'waived'], ['review-tool', 'missing'],
      ['failed', 'missing'], ['mutated', 'missing'], ['older-tree', 'missing'], ['stale-command', 'missing'],
      ['dirty-checkout', 'missing'], ['contract', 'waived'],
    ]);
    const dirtyCheckout = criterionStatuses(fold([
      { kind: 'evidence', data: evidence('dirty-checkout') },
    ]), [checks[9]!], { headTree: 'head-tree', testedTree: 'dirty-tree' });
    assert.equal(dirtyCheckout[0]?.state, 'missing');
  });
});

test('cleanup keeps pre-cleanup evidence only for removed criteria',async()=>{
 const {criterionStatuses}=await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
 const checks: Check[]=[{criterion:'SC1',commands:['step'],commandDigest:'one',evidenceClass:'check'},{criterion:'SC2',commands:['kept'],commandDigest:'two',evidenceClass:'check'}];
 const row=(criterion:string,commandDigest:string,tree:string,patch={})=>({criterion,commandDigest,tree,before:tree,after:tree,clean:true,exit:0,path:criterion+'.json',...patch});
 const fold=(data:Record<string,unknown>[])=>({lastSeq:data.length,torn:null,records:data.map((data,i)=>({seq:i+1,key:String(i),at:'',kind:'evidence',by:'tool',data}))});
 const cleanup={from:'source-commit',fromTree:'source',removed:['SC1'],trees:{SC1:'source'}};
 const current={headTree:'target',testedTree:'target'};
 const state=(rows:Record<string,unknown>[],binding:typeof cleanup|null=cleanup,tree=current)=>criterionStatuses(fold(rows),checks,tree,binding).map(s=>s.state).join();
 const rows=[row('SC1','one','source'),row('SC2','two','target')];
 const [removed,kept]=criterionStatuses(fold(rows),checks,current,cleanup);
 assert.equal(removed!.state,'verified');assert.equal(removed!.evidence,'SC1.json');assert.match(removed!.reason!,/verified at source; tests removed in cleanup/);
 assert.equal(kept!.state,'verified');assert.equal(kept!.reason,undefined);
 assert.equal(state(rows,null),'missing,verified');
 assert.equal(state([row('SC1','one','source'),row('SC2','two','source')]),'verified,missing');
 for(const patch of [{exit:1},{after:'mutated'},{clean:false},{commandDigest:'stale'},{tree:'other'}])assert.equal(state([row('SC1','one','source',patch),rows[1]!]),'missing,verified');
 assert.equal(state(rows,cleanup,{...current,testedTree:'dirty'}),'verified,missing');
});

test('review evidence never qualifies on the current or cleanup tree', async () => {
  const { eligibility, criterionStatuses, verifiedStage } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
  const checks: Check[] = [
    { criterion: 'SC1', commands: ['step'], commandDigest: 'one', evidenceClass: 'check' },
    { criterion: 'SC2', commands: ['review'], commandDigest: 'two', evidenceClass: 'review' },
    { criterion: 'contract', commands: [], commandDigest: 'contract-digest', evidenceClass: 'contract' },
  ];
  const row = (criterion: string, commandDigest: string, tree: string) => ({ criterion, commandDigest, tree, before: tree, after: tree, clean: true, exit: 0, path: criterion + '.json' });
  const records = [row('SC1', 'one', 'source'), row('SC2', 'two', 'source'), row('contract', 'contract-digest', 'target')];
  const fold = { lastSeq: records.length, torn: null, records: records.map((data, index) => ({ seq: index + 1, key: String(index), at: '', kind: 'evidence', by: 'tool', data })) };
  const cleanup = { from: 'source-commit', fromTree: 'source', removed: ['SC1', 'SC2'], trees: { SC1: 'source', SC2: 'source' } };
  const current = { headTree: 'target', testedTree: 'target' };

  assert.deepEqual(eligibility(fold, [checks[1]!], current, true), [{ criterion: 'SC2', state: 'missing' }]);
  assert.deepEqual(criterionStatuses(fold, checks, current, cleanup).map(({ criterion, state }) => [criterion, state]), [
    ['SC1', 'verified'], ['SC2', 'missing'], ['contract', 'verified'],
  ]);
  assert.equal(verifiedStage(fold, checks, current, cleanup), true);
  assert.equal(eligibility(fold, [checks[2]!], { headTree: 'target', testedTree: 'dirty' })[0]?.state, 'missing');
});

describe('cleanup evidence rule', () => {
  const mkCheck = (criterion: string, commandDigest = `digest-${criterion}`): Check => ({
    criterion, commands: ['node test.ts'], commandDigest, evidenceClass: 'check',
  });
  const mkRow = (criterion: string, tree: string, patch: Record<string, unknown> = {}) => ({
    criterion, commandDigest: `digest-${criterion}`, tree, before: tree, after: tree, clean: true, exit: 0, path: `${criterion}.json`, ...patch,
  });
  const mkFold = (records: Record<string, unknown>[]) => ({
    lastSeq: records.length,
    torn: null,
    records: records.map((data, index) => ({ seq: index + 1, key: `k-${index}`, at: '', kind: 'evidence', by: 'tool', data })),
  });
  const criteria = [
    { id: 'SC1', changes: ['src/one.ts'], tests: ['tests/one.test.ts'] },
    { id: 'SC2', changes: ['src/two.ts'], tests: ['tests/two.test.ts'] },
  ];
  const checkRows = [mkCheck('SC1'), mkCheck('SC2')];

  test('cleanup evidence accepts an earlier tree when declared paths are unchanged', async () => {
    const { cleanupEvidence } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const fold = mkFold([mkRow('SC1', 'early-tree')]);
    const diffs = new Map([['early-tree', ['src/two.ts', 'tests/two.test.ts']]]);
    assert.deepEqual(cleanupEvidence(fold, checkRows, criteria, ['SC1'], 'pre-cleanup-tree', diffs), {
      ok: true,
      trees: { SC1: 'early-tree' },
    });
  });

  test('cleanup evidence is stale when a changes path changed', async () => {
    const { cleanupEvidence } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const fold = mkFold([mkRow('SC1', 'early-tree')]);
    const diffs = new Map([['early-tree', ['src/one.ts']]]);
    assert.deepEqual(cleanupEvidence(fold, checkRows, criteria, ['SC1'], 'pre-cleanup-tree', diffs), {
      ok: false,
      stale: ['SC1'],
    });
  });

  test('cleanup evidence is stale when a tests path changed', async () => {
    const { cleanupEvidence } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const fold = mkFold([mkRow('SC1', 'early-tree')]);
    const diffs = new Map([['early-tree', ['tests/one.test.ts']]]);
    assert.deepEqual(cleanupEvidence(fold, checkRows, criteria, ['SC1'], 'pre-cleanup-tree', diffs), {
      ok: false,
      stale: ['SC1'],
    });
  });

  test('cleanup evidence is stale when a path under a declared directory changed', async () => {
    const { cleanupEvidence } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const dirCriteria = [
      { id: 'SC1', changes: ['skills/dispatch/references/'], tests: ['tests/one.test.ts'] },
      { id: 'SC2', changes: ['skills/dispatch/references-other/'], tests: [] },
    ];
    const fold = mkFold([mkRow('SC1', 'early-tree')]);
    const siblingOnly = new Map([['early-tree', ['skills/dispatch/references-other/note.md']]]);
    assert.deepEqual(cleanupEvidence(fold, checkRows, dirCriteria, ['SC1'], 'pre-cleanup-tree', siblingOnly), {
      ok: true,
      trees: { SC1: 'early-tree' },
    });
    const underDir = new Map([['early-tree', ['skills/dispatch/references/toolkit.md']]]);
    assert.deepEqual(cleanupEvidence(fold, checkRows, dirCriteria, ['SC1'], 'pre-cleanup-tree', underDir), {
      ok: false,
      stale: ['SC1'],
    });
  });

  test('cleanup evidence is stale when an undeclared path changed', async () => {
    const { cleanupEvidence } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const fold = mkFold([mkRow('SC1', 'early-tree')]);
    const diffs = new Map([['early-tree', ['tests/helpers/shared.ts']]]);
    assert.deepEqual(cleanupEvidence(fold, checkRows, criteria, ['SC1'], 'pre-cleanup-tree', diffs), {
      ok: false,
      stale: ['SC1'],
    });
  });

  test('cleanup evidence is stale when later evidence failed', async () => {
    const { cleanupEvidence } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const fold = mkFold([mkRow('SC1', 'early-tree'), mkRow('SC1', 'mid-tree', { exit: 1 })]);
    const diffs = new Map<string, string[]>([['early-tree', []]]);
    assert.deepEqual(cleanupEvidence(fold, checkRows, criteria, ['SC1'], 'pre-cleanup-tree', diffs), {
      ok: false,
      stale: ['SC1'],
    });
  });

  test('cleanup evidence status names the evidence tree', async () => {
    const { criterionStatuses, verifiedStage } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const fold = mkFold([mkRow('SC1', 'early-tree'), mkRow('SC2', 'target-tree')]);
    const binding = { from: 'cleanup-base-commit', fromTree: 'pre-cleanup-tree', removed: ['SC1'], trees: { SC1: 'early-tree' } };
    const current = { headTree: 'target-tree', testedTree: 'target-tree' };
    const statuses = criterionStatuses(fold, checkRows, current, binding);
    assert.equal(statuses[0]!.state, 'verified');
    assert.equal(statuses[0]!.reason, 'verified at early-tree; tests removed in cleanup');
    assert.equal(verifiedStage(fold, checkRows, current, binding), true);
    const missingTree = { from: 'cleanup-base-commit', fromTree: 'early-tree', removed: ['SC1'], trees: {} };
    assert.equal(criterionStatuses(fold, checkRows, current, missingTree)[0]!.state, 'missing');
    assert.equal(verifiedStage(fold, checkRows, current, missingTree), false);
  });

  test('gitPaths preserves leading whitespace on NUL-delimited filenames', async () => {
    const { gitPaths, gitOk, gitRaw } = await import('../../../skills/dispatch/scripts/toolkit/git.ts');
    const { cleanupEvidence, matchesDeclared } = await import('../../../skills/dispatch/scripts/toolkit/evidence.ts');
    const calls: Array<{ stdin?: string }> = [];
    const deps = {
      run: async (_argv: string[], opts: { stdin?: string }) => {
        calls.push(opts);
        return { exit: 0, stdout: ' foo.ts\0src/two.ts\0', stderr: '' };
      },
    } as unknown as Parameters<typeof gitPaths>[0];
    const paths = await gitPaths(deps, '.', ['diff', '--name-only', '--no-renames', '-z']);
    assert.deepEqual(paths, [' foo.ts', 'src/two.ts']);
    assert.equal('stdin' in calls[0]!, false);
    assert.equal(await gitRaw(deps, '.', ['update-index', '-z', '--index-info'], undefined, 'payload\0'), ' foo.ts\0src/two.ts\0');
    assert.equal(calls[1]!.stdin, 'payload\0');
    assert.equal(await gitOk(deps, '.', ['diff', '--name-only', '-z']), 'foo.ts\0src/two.ts\0');
    const spaceCriteria = [
      { id: 'SC1', changes: ['src/one.ts'], tests: ['tests/one.test.ts'] },
      { id: 'SC2', changes: ['foo.ts', 'src/two.ts'], tests: [] },
    ];
    assert.equal(matchesDeclared(' foo.ts', ['foo.ts']), false);
    assert.equal(matchesDeclared('tests/sub/step.test.ts', ['tests/']), true);
    assert.deepEqual(cleanupEvidence(mkFold([mkRow('SC1', 'early-tree')]), checkRows, spaceCriteria, ['SC1'], 'pre-cleanup-tree', new Map([['early-tree', paths]])), {
      ok: false,
      stale: ['SC1'],
    });
  });
});
