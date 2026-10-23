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
});
