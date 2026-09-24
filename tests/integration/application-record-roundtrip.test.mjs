import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateConsensus } from '../../skills/dispatch/scripts/review/consensus.mjs';
import { formatApplicationRecord } from '../../skills/dispatch/scripts/review/resolution-log.mjs';
import { buildReviewView } from '../../skills/dispatch/scripts/review/preparation.mjs';

// Every strict consumer of the resolution log must accept canonical application records
// and reject malformed ones the same way.
const sourceMap = JSON.stringify({
  'plan-review:R1:claude:0': {
    provider: 'claude', candidateIndex: 0, model: 'opus', effort: 'medium',
    status: 'target', session: 'session-1', substitutesFor: null,
  },
});
const record = formatApplicationRecord({
  v: 1, findingId: 'R1-F001', state: 'unapplied', scope: 'in-scope',
  affectedPaths: ['src/foo.ts'], dependsOn: [], verification: ['npm test'], reason: 'default recommendation',
});
const log = application => [
  '# Plan', '', '## Proposed Changes', '- stuff', '',
  '## Review Findings & Resolutions', '### Round 1',
  `- **Sources:** ${sourceMap}`,
  '- **[Accepted]** [R1-F001] [SHOULD] [sources=plan-review:R1:claude:0] § A — tag: x → y',
  application,
].join('\n');

describe('application record round trip', () => {
  it('is accepted by consensus and the review view', () => {
    assert.equal(evaluateConsensus(log(record)).exit, 0);
    const view = buildReviewView(log(record), { canonicalPath: 'plan.md', nextRound: 2 });
    assert.match(view.contents, /application: \{"v":1/);
  });

  it('is rejected consistently when malformed', () => {
    const malformed = record.replace('"state":"unapplied"', '"state":"bogus"');
    assert.equal(evaluateConsensus(log(malformed)).exit, 2);
    assert.throws(() => buildReviewView(log(malformed), { canonicalPath: 'plan.md', nextRound: 2 }), /application record/);
  });
});
