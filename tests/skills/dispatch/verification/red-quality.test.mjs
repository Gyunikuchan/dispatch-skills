import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkRedQuality, parseIdentifiers } from '../../../../skills/dispatch/scripts/verification/red-quality.mjs';

const COMMAND = 'node --test tests/value.test.mjs';
const BASE_PLAN = [
  '## Success Criteria',
  '- [SC1] Basic behavior.',
  '  - Changes: src/value.js',
  `  - Verify: \`${COMMAND}\``,
  '  - Evidence: red',
  '  - Test rationale: Behavioral failure isolates the value contract and protects regression.',
  '- [SC2] Recovery.',
  '  - Changes: src/value.js',
  `  - Verify: \`${COMMAND}\``,
  '  - Evidence: red',
  '  - Test rationale: Recovery behavior has stable interruption coverage and durable regression value.',
  '## Proposed Changes',
  '#### [MODIFY] src/value.js',
].join('\n');

const VALID_ROWS = [
  'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:value',
  'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:value',
];

function defects({ plan = BASE_PLAN, rows = VALID_ROWS, red = {} } = {}) {
  return checkRedQuality(plan, { evidence: rows }, {
    exitStatus: 1,
    identifiers: ['test:value'],
    diagnostic: 'failed',
    command: COMMAND,
    ...red,
  });
}

// SECTION: Matrix grammar and coverage

describe('RED evidence matrix', () => {
  it('accepts one primary row per mapped criterion', () => {
    assert.deepEqual(defects(), []);
  });

  for (const [name, rows, diagnostic] of [
    ['duplicate', [VALID_ROWS[0], VALID_ROWS[0], VALID_ROWS[1]], /duplicate/i],
    ['missing', [VALID_ROWS[0]], /missing/i],
    ['unmapped', ['RED-MATRIX SC1 | unrelated.test.mjs | exit 1 test:value', VALID_ROWS[1]], /unmapped/i],
    ['weak identity', ['RED-MATRIX SC1 | tests/value.test.mjs | failed', VALID_ROWS[1]], /identity/i],
    ['malformed', ['RED-MATRIX SC1 | malformed', VALID_ROWS[1]], /grammar/i],
  ]) {
    it(`rejects ${name} rows`, () => {
      assert.match(defects({ rows }).join('; '), diagnostic);
    });
  }

  it('supports reasoned N/A rows and requires recovery-class evidence', () => {
    assert.deepEqual(defects({ rows: [
      'RED-MATRIX SC1 | N/A | validation is not applicable to this class',
      VALID_ROWS[1],
    ] }), []);
    assert.match(defects({ rows: [VALID_ROWS[0], VALID_ROWS[0].replace('SC1', 'SC2')] }).join('; '), /interruption|resume/i);
  });
});

// SECTION: Failure identity and command attribution

describe('observed RED result', () => {
  it('matches normalized diagnostics when identifiers are unavailable', () => {
    assert.deepEqual(defects({
      rows: [
        'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 failed at 2026-09-20T00:00:00Z',
        'RED-MATRIX SC2 | N/A | recovery is not applicable to this diagnostic check',
      ],
      red: { identifiers: [], diagnostic: 'failed at 2026-09-21T00:00:00Z' },
    }), []);
  });

  it('unions spaced identifiers for criteria sharing one command', () => {
    const rows = [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 1 test:first case',
      'RED-MATRIX SC2 | tests/value.test.mjs | interruption and resume exit 1 test:second case',
    ];
    assert.deepEqual(defects({ rows, red: { identifiers: ['test:first case', 'test:second case'] } }), []);
    assert.match(defects({ rows, red: { identifiers: ['test:unrelated case'] } }).join('; '), /identity mismatch/i);
  });

  it('rejects mismatched exit status and test command without prefix collisions', () => {
    assert.match(defects({ rows: [
      'RED-MATRIX SC1 | tests/value.test.mjs | exit 100 test:value',
      VALID_ROWS[1],
    ] }).join('; '), /exit status mismatch/i);
    assert.match(defects({ red: { command: 'node --test tests/typo-unrelated.test.mjs' } }).join('; '), /unmapped command/i);
    assert.match(defects({ red: { exitStatus: 2 } }).join('; '), /exit status mismatch/i);
  });

  it('matches a multi-command criterion row only against the command running its cited file', () => {
    const other = 'node --test tests/driver.test.mjs';
    const plan = [
      '## Success Criteria',
      '- [SC1] Two-layer behavior.',
      '  - Changes: src/value.js, tests/value.test.mjs, tests/driver.test.mjs',
      `  - Verify: \`${COMMAND}\``,
      `  - Verify: \`${other}\``,
      '  - Evidence: red',
      '  - Test rationale: Helper and driver layers each fail on the missing contract.',
      '## Proposed Changes',
      '#### [MODIFY] src/value.js',
    ].join('\n');
    const rows = ['RED-MATRIX SC1 | tests/value.test.mjs:helper case | exit 1 test:helper case'];
    assert.deepEqual(defects({ plan, rows, red: { identifiers: ['test:helper case'] } }), []);
    assert.deepEqual(defects({ plan, rows, red: { command: other, identifiers: ['test:driver case'] } }), []);
    assert.match(defects({ plan, rows, red: { identifiers: ['test:unrelated case'] } }).join('; '), /identity mismatch/i);
  });

  it('ignores aggregate commands that map to no RED criterion', () => {
    assert.deepEqual(defects({ red: {
      command: 'npm test',
      identifiers: ['error:unrelated aggregate failure'],
      diagnostic: 'unrelated',
    } }), []);
  });
});

// SECTION: Identifier parsing

describe('RED identifier parsing', () => {
  it('retains spaces through semicolons and drops blank identities', () => {
    assert.deepEqual(parseIdentifiers('exit 1 test:hops A then B; error:second one'), [
      'test:hops A then B',
      'error:second one',
    ]);
    assert.deepEqual(parseIdentifiers('exit 1 test:    ; error:x'), ['error:x']);
    assert.deepEqual(parseIdentifiers('exit 1 test:   '), []);
  });
});
