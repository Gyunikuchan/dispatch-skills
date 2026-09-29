import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MATCH_JACCARD, convergence, matchFinding, parseLocus, similarity } from '../../../../skills/dispatch/scripts/review/rounds.mjs';
import { formatRoundPolicyRecord, formatSourceMapLine, scanResolutionLog } from '../../../../skills/dispatch/scripts/review/resolution-log.mjs';
import { findingKey, roundHistory } from '../../../../skills/dispatch/scripts/driver/review-phase.mjs';

const key = (locus, tag, text) => ({ ...parseLocus(locus, 'linux'), tag, text });
const DEFECT = 'Retry loop never resets the attempt counter after a successful request';
const REWORDED = 'The attempt counter is not reset after a successful request, so the retry loop exhausts early';

describe('convergence', () => {
  it('matches a reworded finding at a nearby line with the same tag', () => {
    assert.ok(matchFinding(key('src/a.mjs:L10', 'correctness', DEFECT), key('src/a.mjs:L14', 'correctness', REWORDED)));
  });

  it('does not match distinct findings, other tags, far lines, or other paths', () => {
    const base = key('src/a.mjs:L10', 'correctness', DEFECT);
    assert.equal(matchFinding(base, key('src/a.mjs:L11', 'correctness', 'Logger writes secrets to stdout in debug mode')), false);
    assert.equal(matchFinding(base, key('src/a.mjs:L10', 'performance', DEFECT)), false);
    assert.equal(matchFinding(base, key('src/a.mjs:L16', 'correctness', DEFECT)), false);
    assert.equal(matchFinding(base, key('src/b.mjs:L10', 'correctness', DEFECT)), false);
  });

  it('tokenizes lowercase alphanumerics, drops short tokens and stopwords, and pins the boundary', () => {
    assert.equal(similarity('The API is OK', 'the api'), 1);
    assert.equal(similarity('alpha beta gamma', 'alpha delta epsilon'), 0.2);
    assert.ok(similarity('alpha beta gamma', 'alpha beta delta') >= MATCH_JACCARD);
    assert.equal(similarity('alpha beta gamma delta', 'alpha beta epsilon zeta eta theta'), 0.25);
  });

  it('never matches empty text on location and tag alone', () => {
    assert.equal(similarity('', ''), 0);
    assert.equal(matchFinding(key('src/a.mjs:L10', 'correctness', ''), key('src/a.mjs:L10', 'correctness', '')), false);
  });

  it('halts as regression when a fixed finding is re-raised', () => {
    const history = [{ ...key('src/a.mjs:L10', 'correctness', DEFECT), id: 'R1-F001', status: 'applied' }];
    assert.deepEqual(convergence({ findings: [key('src/a.mjs:L12', 'correctness', REWORDED)], history }), { halt: true, kind: 'regression', ids: ['R1-F001'] });
  });

  it('lets a first re-raise through and halts on the second as deadlock', () => {
    const entry = { ...key('src/a.mjs:L10', 'correctness', DEFECT), id: 'R1-F001', status: 'pendingConfirmation' };
    const finding = key('src/a.mjs:L10', 'correctness', REWORDED);
    assert.deepEqual(convergence({ findings: [finding], history: [{ ...entry, reraise: 0 }] }), { halt: false, reraised: ['R1-F001'] });
    assert.deepEqual(convergence({ findings: [finding], history: [{ ...entry, reraise: 1 }] }), { halt: true, kind: 'deadlock', ids: ['R1-F001'] });
    assert.deepEqual(convergence({ findings: [key('src/z.mjs:L1', 'correctness', REWORDED)], history: [{ ...entry, reraise: 1 }] }), { halt: false, reraised: [] });
  });

  it('builds history from the log, dereferencing duplicate entries and reading reraise', () => {
    const sources = formatSourceMapLine({ 'code-review:R1:claude:0': { provider: 'claude', candidateIndex: 0, model: 'opus', effort: null, status: 'target', session: null, substitutesFor: null } });
    const markdown = [
      '# Walkthrough', '', '## Review Findings & Resolutions', '### Round 1 — 2026-09-29', sources,
      `- **[Rejected — Pending Confirmation]** [R1-F001] [MUST] [sources=code-review:R1:claude:0] src/a.mjs:L10 — correctness: ${DEFECT} → Counter resets in finally.`,
      formatRoundPolicyRecord({ id: 'R1-F001', reraise: 1 }),
      '- **[Rejected — Pending Confirmation]** [R1-F002] [MUST] [sources=code-review:R1:claude:0] [dup=R1-F001] src/a.mjs:L10 → see R1-F001',
      '',
    ].join('\n');
    const history = roundHistory(scanResolutionLog(markdown, { strict: true }));
    assert.deepEqual(history.map(({ id, status, reraise, path, line, tag }) => ({ id, status, reraise, path, line, tag })), [
      { id: 'R1-F001', status: 'pendingConfirmation', reraise: 1, path: 'src/a.mjs', line: 10, tag: 'correctness' },
      { id: 'R1-F002', status: 'pendingConfirmation', reraise: 0, path: 'src/a.mjs', line: 10, tag: 'correctness' },
    ]);
    assert.equal(history[1].text, DEFECT);
    const halted = convergence({ findings: [findingKey({ locus: 'src/a.mjs:L11', tag: 'correctness', defect: REWORDED })], history });
    assert.deepEqual(halted, { halt: true, kind: 'deadlock', ids: ['R1-F001'] });
  });
});
