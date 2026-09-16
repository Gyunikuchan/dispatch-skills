import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findUnsettledResolutionLines,
  scanResolutionLog,
} from '../../../skills/dispatch/scripts/resolution-log.mjs';

const document = [
  '# Plan',
  '',
  '## Proposed Changes',
  '',
  'Keep café behavior.',
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
  '- **[Resolved Dispute]** § C — intent: unclear → user ruled',
  '',
  '## Out of Scope',
  '',
  'Later work.',
].join('\n');

describe('resolution log scanner', () => {
  it('extracts semantic body, rounds, statuses, and unsettled lines', () => {
    const scan = scanResolutionLog(document);
    assert.equal(scan.rounds.length, 3);
    assert.equal(scan.rounds[0].counts.accepted, 1);
    assert.equal(scan.rounds[1].counts.pendingConfirmation, 1);
    assert.equal(scan.rounds[2].counts.disputed, 0);
    assert.deepEqual(scan.unsettled, [
      '- **[Rejected — pending confirmation]** § B — scope: broad → retained',
    ]);
    assert.match(scan.semanticBody, /## Proposed Changes/);
    assert.match(scan.semanticBody, /## Out of Scope/);
    assert.doesNotMatch(scan.semanticBody, /Round 1/);
  });

  it('normalizes CRLF and canonically equivalent Unicode before hashing', () => {
    const decomposed = document.replace('café', 'cafe\u0301').replace(/\n/g, '\r\n');
    assert.equal(
      scanResolutionLog(decomposed).canonicalLogHash,
      scanResolutionLog(document).canonicalLogHash,
    );
  });

  it('fails closed on duplicate sections, out-of-order rounds, and unterminated fences', () => {
    assert.throws(() => scanResolutionLog(`${document}\n## Review Findings & Resolutions\n### Round 4`), /duplicate/);
    assert.throws(() => scanResolutionLog(document.replace('### Round 3', '### Round 2')), /duplicate or out of order/);
    assert.throws(() => scanResolutionLog(`${document}\n\`\`\``), /unterminated fence/);
  });

  it('treats fences indented by four spaces as indented code', () => {
    const indented = document.replace(
      '```markdown\n- **[Disputed]** fenced example\n```',
      '    ```markdown\n- **[Disputed]** visible after indented code\n    ```',
    );
    assert.deepEqual(scanResolutionLog(indented).unsettled, [
      '- **[Rejected — pending confirmation]** § B — scope: broad → retained',
      '- **[Disputed]** visible after indented code',
    ]);
  });

  it('keeps the compatibility unsettled scan conservative for malformed logs', () => {
    const duplicate = `${document}\n## Review Findings & Resolutions\n- **[Disputed]** duplicate section`;
    assert.deepEqual(findUnsettledResolutionLines(duplicate), [
      '- **[Rejected — pending confirmation]** § B — scope: broad → retained',
      '- **[Disputed]** duplicate section',
    ]);
  });

  it('preserves pending-confirmation compatibility across dash spellings', () => {
    for (const dash of ['—', '–', '-', '--']) {
      const input = [
        '# Plan',
        '## Review Findings & Resolutions',
        '### Round 1',
        `- **[Rejected ${dash} pending confirmation]** § A — scope: retained`,
      ].join('\n');
      assert.equal(scanResolutionLog(input).rounds[0].counts.pendingConfirmation, 1);
      assert.equal(scanResolutionLog(input).unsettled.length, 1);
    }
  });
});
