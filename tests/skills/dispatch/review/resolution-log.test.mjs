import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findUnsettledResolutionLines,
  formatApplicationRecord,
  formatSourceMapLine,
  nextFindingId,
  scanResolutionLog,
} from '../../../../skills/dispatch/scripts/review/resolution-log.mjs';

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

const roundSources = (n) => `- **Sources:** ${JSON.stringify({
  [`plan-review:R${n}:claude:0`]: {
    provider: 'claude', candidateIndex: 0, model: 'opus', effort: 'medium', status: 'target', session: null, substitutesFor: null,
  },
})}`;
const PENDING_B = '- **[Rejected — pending confirmation]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § B — scope: broad → retained';

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
  roundSources(1),
  '- **[Accepted]** [R1-F001] [SHOULD] [sources=plan-review:R1:claude:0] § A — test: missing → added',
  '',
  '### Round 2 — Copilot',
  '',
  roundSources(2),
  PENDING_B,
  '',
  '### Round 3 — Claude',
  '',
  roundSources(3),
  '```markdown',
  '- **[Disputed]** fenced example',
  '```',
  '- **[Resolved Dispute]** [R3-F001] [MUST] [sources=plan-review:R3:claude:0] § C — intent: unclear → user ruled',
  '',
  '## Out of Scope',
  '',
  'Later work.',
].join('\n');

describe('resolution log scanner', () => {
  it('keeps semantic and log state identical with dispatch metadata', () => {
    const base = [
      '# Plan',
      '',
      '## Proposed Changes',
      'Text.',
      '',
      '## Review Findings & Resolutions',
      '### Round 1',
      roundSources(1),
      '- **[Accepted]** [R1-F001] [SHOULD] [sources=plan-review:R1:claude:0] § A — test: issue → fixed',
    ].join('\n');
    const metadata = [
      '---',
      '{"dispatch":{"schemaVersion":1,"kind":"plan","slug":"sample","invocationId":"invocation-1","contentHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sectionHashes":{"Proposed Changes":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"reviewedAt":"2026-09-17T00:00:00Z"}}',
      '---',
      base,
    ].join('\n');
    const plain = scanResolutionLog(base);
    const enriched = scanResolutionLog(metadata);
    assert.equal(enriched.semanticBody, plain.semanticBody);
    assert.equal(enriched.canonicalLogHash, plain.canonicalLogHash);
    assert.deepEqual(enriched.rounds, plain.rounds);
    assert.throws(() => scanResolutionLog('---\n{bad}\n---\n# Plan'), /malformed JSON/);
    assert.throws(() => scanResolutionLog('---\n{"dispatch":{} }\n# Plan'), /unterminated frontmatter/);
  });

  it('extracts semantic body, rounds, statuses, and unsettled lines', () => {
    const scan = scanResolutionLog(document);
    assert.equal(scan.rounds.length, 3);
    assert.equal(scan.rounds[0].counts.accepted, 1);
    assert.equal(scan.rounds[1].counts.pendingConfirmation, 1);
    assert.equal(scan.rounds[2].counts.disputed, 0);
    assert.deepEqual(scan.unsettled, [PENDING_B]);
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
      '    ```markdown\n- **[Disputed]** [R3-F002] [MUST] [sources=plan-review:R3:claude:0] § D — t: visible after indented code\n    ```',
    );
    assert.deepEqual(scanResolutionLog(indented).unsettled, [
      PENDING_B,
      '- **[Disputed]** [R3-F002] [MUST] [sources=plan-review:R3:claude:0] § D — t: visible after indented code',
    ]);
  });

  it('keeps the compatibility unsettled scan conservative for malformed logs', () => {
    const duplicate = `${document}\n## Review Findings & Resolutions\n- **[Disputed]** [R1-F009] [MUST] [sources=plan-review:R1:claude:0] § D — t: duplicate section`;
    assert.deepEqual(findUnsettledResolutionLines(duplicate), [
      PENDING_B,
      '- **[Disputed]** [R1-F009] [MUST] [sources=plan-review:R1:claude:0] § D — t: duplicate section',
    ]);
  });

  it('preserves pending-confirmation compatibility across dash spellings', () => {
    for (const dash of ['—', '–', '-', '--']) {
      const input = [
        '# Plan',
        '## Review Findings & Resolutions',
        '### Round 1',
        roundSources(1),
        `- **[Rejected ${dash} pending confirmation]** [R1-F001] [SHOULD] [sources=plan-review:R1:claude:0] § A — scope: retained`,
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

  it('strictly rejects non-enriched resolution bullets and tolerant parsing skips them', () => {
    const bare = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 4 — Claude and Copilot, 2026-09-17',
      '- **[Disputed]** § A — tag (CONSIDER): x → y',
    ].join('\n');
    assert.throws(() => scanResolutionLog(bare));
    const tolerant = scanResolutionLog(bare, { strict: false });
    assert.deepEqual(tolerant.unsettledItems, []);
  });

  it('strictly rejects an enriched bullet with an unknown status label and tolerant parsing skips it', () => {
    const unknown = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 1',
      roundSources(1),
      '- **[Maybe Later]** [R1-F001] [SHOULD] [sources=plan-review:R1:claude:0] § A — tag: x → y',
    ].join('\n');
    assert.throws(() => scanResolutionLog(unknown));
    assert.deepEqual(scanResolutionLog(unknown, { strict: false }).unsettledItems, []);
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

  it('parses valid application continuation records and validates them', () => {
    const appRecord = {
      v: 1,
      findingId: 'R2-F001',
      state: 'unapplied',
      scope: 'in-scope',
      affectedPaths: ['src/bar.ts', 'src/foo.ts'],
      dependsOn: [],
      verification: ['npm test -- foo'],
      reason: 'default recommendation',
    };
    const log = [
      '# Plan',
      '## Proposed Changes',
      'Content',
      '## Review Findings & Resolutions',
      '### Round 2',
      `- **Sources:** ${sourceMap}`,
      '- **[Accepted]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § A — tag: x → y',
      formatApplicationRecord(appRecord),
    ].join('\n');

    const scan = scanResolutionLog(log);
    assert.equal(scan.rounds.length, 1);
    assert.equal(scan.rounds[0].entries.length, 1);
    assert.deepEqual(scan.rounds[0].entries[0].application, appRecord);
    assert.match(scan.semanticBody, /## Proposed Changes/);
    assert.doesNotMatch(scan.semanticBody, /application:/);
  });

  it('rejects invalid or misplaced application records in strict mode', () => {
    const validEntry = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 2',
      `- **Sources:** ${sourceMap}`,
      '- **[Accepted]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § A — tag: x → y',
    ].join('\n');

    // Mismatched findingId
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F002","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /findingId "R2-F002" does not match entry ID "R2-F001"/,
    );

    // Unsorted affectedPaths
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/z.ts","src/a.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /affectedPaths must be sorted/,
    );

    // Invalid path format
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["../foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /normalized repository-relative slash path/,
    );

    // Non-canonical key order
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"findingId":"R2-F001","v":1,"state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /canonical form/,
    );

    // dependsOn must hold finding IDs
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":["src/foo.ts"],"verification":["npm test"],"reason":"test"}`),
      /dependsOn entries must be finding IDs/,
    );

    // Multi-digit round IDs are valid dependsOn entries
    assert.doesNotThrow(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":["R10-F001"],"verification":["npm test"],"reason":"test"}`),
    );
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":["R1d-F001"],"verification":["npm test"],"reason":"test"}`),
      /dependsOn entries must be finding IDs/,
    );

    // Invalid version
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":2,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /v must be 1/,
    );

    // Duplicate application record
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /duplicate application records/,
    );

    // Attached to non-accepted finding
    const rejectedEntry = validEntry.replace('[Accepted]', '[Rejected / Downgraded]');
    assert.throws(
      () => scanResolutionLog(`${rejectedEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /application record cannot be attached to finding with status "rejected"/,
    );

    // Application before any entry
    const beforeEntry = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 2',
      `- **Sources:** ${sourceMap}`,
      '  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}',
      '- **[Accepted]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § A — tag: x → y',
    ].join('\n');
    assert.throws(() => scanResolutionLog(beforeEntry), /Application record appears before any resolution entry/);

    // Non-adjacent application record (intervening text)
    const nonAdjacentEntry = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 2',
      `- **Sources:** ${sourceMap}`,
      '- **[Accepted]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § A — tag: x → y',
      'Intervening comment text',
      '  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}',
    ].join('\n');
    assert.throws(() => scanResolutionLog(nonAdjacentEntry), /application record must immediately follow its resolution entry/);

    // Non-adjacent application record (intervening blank line)
    const blankLineEntry = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 2',
      `- **Sources:** ${sourceMap}`,
      '- **[Accepted]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § A — tag: x → y',
      '',
      '  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["src/foo.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}',
    ].join('\n');
    assert.throws(() => scanResolutionLog(blankLineEntry), /application record must immediately follow its resolution entry/);

    // Windows drive-letter absolute path rejected
    assert.throws(
      () => scanResolutionLog(`${validEntry}\n  - application: {"v":1,"findingId":"R2-F001","state":"unapplied","scope":"in-scope","affectedPaths":["C:/w/a.ts"],"dependsOn":[],"verification":["npm test"],"reason":"test"}`),
      /normalized repository-relative slash path/,
    );
  });
});

describe('formatSourceMapLine', () => {
  it('formats a line the strict resolution-log parser accepts', () => {
    const record = (provider, overrides = {}) => ({
      provider, candidateIndex: 0, model: null, effort: 'medium', status: 'target', session: null, substitutesFor: null, ...overrides,
    });
    const line = formatSourceMapLine({
      'plan-review:R2:agy:0': record('agy'),
      'plan-review:R2:opencode:0': record('opencode', { status: 'reserve', substitutesFor: 'plan-review:R2:claude:0' }),
    });
    const doc = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 1 — 2026-09-18',
      '### Round 2 — 2026-09-18',
      line,
      '- **[Accepted]** [R2-F001] [MUST] [sources=plan-review:R2:agy:0] § Plan — correctness: gap → fixed.',
    ].join('\n');
    assert.equal(Object.keys(scanResolutionLog(doc, { strict: true }).rounds[1].sourceMap).length, 2);
  });
});
