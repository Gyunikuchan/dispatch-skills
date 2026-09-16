import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  buildReviewView,
  writeReviewView,
} from '../../../skills/implement-dispatch/scripts/build-review-view.mjs';

const artifact = [
  '# Plan',
  '',
  '## Proposed Changes',
  '',
  '- Keep the semantic body.',
  '',
  '## Review Findings & Resolutions',
  '',
  '### Round 1 — Claude',
  '',
  '- **[Accepted]** § A — test: missing → added',
  '',
  '### Round 2 — Copilot',
  '',
  '- **[Rejected — pending confirmation]** § B — scope: broad → retained',
  '',
  '### Round 3 — Claude',
  '',
  '```markdown',
  '- **[Disputed]** fenced example',
  '```',
  '- *No actionable findings.*',
].join('\n');

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bounded review views', () => {
  it('keeps body, previous round, live findings, and fixed older summaries', () => {
    const view = buildReviewView(artifact, { canonicalPath: '.scratch/plan/x.md', nextRound: 4 });
    assert.match(view.contents, /Keep the semantic body/);
    assert.match(view.contents, /R1 settled accepted=1 rejected=0 resolved=0 disputed=0 unknown=0 hash=[a-f0-9]{12}/);
    assert.match(view.contents, /Live findings from older rounds/);
    assert.match(view.contents, /R2: \*\*\[Rejected — pending confirmation\]/);
    assert.match(view.contents, /Immediately preceding round/);
    assert.match(view.contents, /### Round 3/);
    assert.equal((view.contents.match(/### Round 1/g) ?? []).length, 0);
  });

  it('writes a private temporary view without mutating the canonical artifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-view-test-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'artifact.md');
    fs.writeFileSync(file, artifact);
    const before = fs.readFileSync(file, 'utf8');
    const result = writeReviewView({ artifact: file, nextRound: 4 });
    tempDirs.push(path.dirname(result.viewPath));
    assert.ok(fs.existsSync(result.viewPath));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.match(fs.readFileSync(result.viewPath, 'utf8'), /read-only review projection/);
  });

  it('rejects stale next-round values and malformed structures', () => {
    assert.throws(() => buildReviewView(artifact, { canonicalPath: 'x', nextRound: 3 }), /does not follow/);
    assert.throws(() => buildReviewView(
      artifact.replace('### Round 3', '### Round 2'),
      { canonicalPath: 'x', nextRound: 4 },
    ), /duplicate or out of order/);
  });

  it('uses the last round number and preserves semantic-body whitespace', () => {
    const nonContiguous = artifact
      .replace('### Round 2 — Copilot', '### Round 4 — Copilot')
      .replace('### Round 3 — Claude', '### Round 5 — Claude')
      .replace('- Keep the semantic body.', '- Keep the semantic body.\n\n\n```text\none\n\n\ntwo\n```');
    const view = buildReviewView(nonContiguous, { canonicalPath: 'x', nextRound: 6 });
    assert.match(view.contents, /one\n\n\ntwo/);
  });
});
