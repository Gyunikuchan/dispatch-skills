import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findUnsettledResolutionLines,
  nextFindingId,
  scanResolutionLog,
} from '../../../skills/dispatch/scripts/resolution-log.mjs';

const sourceMap = JSON.stringify({
  'plan-review:R2:claude:0': {
    provider: 'claude',
    candidateIndex: 0,
    model: 'opus',
    effort: 'medium',
    status: 'target',
    session: 'session-1',
    substitutesFor: null,
  },
  'plan-review:R2:copilot:0': {
    provider: 'copilot',
    candidateIndex: 0,
    model: 'gpt',
    effort: 'high',
    status: 'replacement',
    session: null,
    substitutesFor: 'plan-review:R2:agy:0',
  },
});

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

  it('parses enriched findings and structured source maps without parsing prose', () => {
    const input = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 2 — Claude and Copilot',
      `- **Sources:** ${sourceMap}`,
      '- **[Rejected — pending confirmation]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0,plan-review:R2:copilot:0] § A — scope: text contains ] and → delimiters → retained',
      '- **[Disputed]** [R2-F002] [MUST] [sources=plan-review:R2:claude:0] § B — intent: x → y',
    ].join('\n');
    const scan = scanResolutionLog(input);
    assert.equal(scan.rounds[0].entries[0].id, 'R2-F001');
    assert.equal(scan.rounds[0].entries[0].severity, 'SHOULD');
    assert.deepEqual(scan.rounds[0].entries[0].sourceKeys, [
      'plan-review:R2:claude:0',
      'plan-review:R2:copilot:0',
    ]);
    assert.equal(scan.unsettledItems[0].key, 'R2-F001');
    assert.equal(scan.unsettledItems[0].lineNumber, 5);
    assert.equal(nextFindingId(input, 2), 'R2-F003');
  });

  it('gives legacy findings invocation-local keys, severity, and coarse affinity', () => {
    const scan = scanResolutionLog([
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 4 — Claude and Copilot, 2026-09-17',
      '- **[Disputed]** § A — tag (CONSIDER): x → y',
    ].join('\n'));
    assert.deepEqual(scan.unsettledItems[0], {
      key: 'legacy:R4:L4',
      id: null,
      severity: 'CONSIDER',
      sourceKeys: ['legacy:R4:claude', 'legacy:R4:copilot'],
      status: 'disputed',
      lineNumber: 4,
      originalLine: '- **[Disputed]** § A — tag (CONSIDER): x → y',
    });
  });

  it('keeps pre-Phase 2 enriched-looking source keys readable without a source map', () => {
    const scan = scanResolutionLog([
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 5 — Host',
      '- **[Disputed]** [R5-F002] [MUST] [sources=host:gpt-5.6-sol:rereview] § A — tag: x → y',
    ].join('\n'));
    assert.equal(scan.unsettledItems[0].key, 'R5-F002');
    assert.deepEqual(scan.unsettledItems[0].sourceKeys, ['host:gpt-5.6-sol:rereview']);
  });

  it('rejects malformed or duplicate IDs and invalid source-map references', () => {
    const base = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 2',
      `- **Sources:** ${sourceMap}`,
      '- **[Disputed]** [R2-F001] [MUST] [sources=plan-review:R2:claude:0] § A — tag: x → y',
    ].join('\n');
    assert.throws(() => scanResolutionLog(`${base}\n${base.split('\n').at(-1)}`), /duplicate finding IDs/);
    assert.throws(
      () => scanResolutionLog(base.replace('R2-F001', 'R2-F1')),
      /malformed enriched finding prefix/,
    );
    assert.throws(
      () => scanResolutionLog(base.replace('plan-review:R2:claude:0] §', 'plan-review:R2:opencode:0] §')),
      /source absent/,
    );
    assert.throws(
      () => scanResolutionLog(base.replace(`- **Sources:** ${sourceMap}\n`, '')),
      /without a structured source map/,
    );
    assert.throws(
      () => scanResolutionLog(base.replace('"provider":"claude"', '"provider":"copilot"')),
      /source map entry/,
    );
    assert.throws(
      () => scanResolutionLog(base.replace('"candidateIndex":0', '"candidateIndex":9')),
      /source map entry/,
    );
    assert.throws(
      () => scanResolutionLog(base.replace('plan-review:R2:claude:0', 'plan-review:R3:claude:0')),
      /source map entry|invalid source key/,
    );
    assert.throws(
      () => scanResolutionLog(base.replace(
        'plan-review:R2:agy:0',
        'code-review:R2:agy:0',
      )),
      /source map entry/,
    );
  });
});
