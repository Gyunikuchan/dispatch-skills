import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseImplementationOutcome } from '../../../../skills/dispatch/scripts/verification/implementation-outcome.mjs';

const done = {
  schemaVersion: 1,
  status: 'DONE',
  stage: 'COMPLETE',
  summary: 'Implemented the requested scope.',
  evidence: ['tests/example.test.mjs'],
};
const redReady = { ...done, stage: 'RED_READY' };

// SECTION: Envelope parsing and validation

describe('parseImplementationOutcome', () => {
  it('accepts a raw JSON envelope', () => {
    assert.deepEqual(parseImplementationOutcome(JSON.stringify(done)), done);
  });

  it('accepts exactly one fenced JSON envelope and ignores surrounding prose', () => {
    assert.deepEqual(
      parseImplementationOutcome(`Finished.\n\n\`\`\`json\n${JSON.stringify(done)}\n\`\`\``),
      done,
    );
  });

  it('rejects prose-only, duplicate, and unknown-version outcomes', () => {
    assert.throws(() => parseImplementationOutcome('done'), /terminal envelope/i);
    assert.throws(
      () => parseImplementationOutcome(
        `\`\`\`json\n${JSON.stringify(done)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(done)}\n\`\`\``,
      ),
      /exactly one/i,
    );
    assert.throws(
      () => parseImplementationOutcome(`\`\`\`json\n${JSON.stringify(done)}\n\`\`\`\n\`\`\`\n${JSON.stringify(done)}\n\`\`\``),
      /exactly one/i,
    );
    assert.throws(() => parseImplementationOutcome(`\`\`\`jsonc\n${JSON.stringify(done)}\n\`\`\``), /json language tag/);
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify(done).replace('{', '{"status":"BLOCKED",')),
      /duplicate keys/,
    );
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify({ ...done, schemaVersion: 2 })),
      /schemaVersion/i,
    );
  });

  it('enforces status-specific fields and evidence', () => {
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify({ ...done, evidence: [] })),
      /evidence/i,
    );
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify({
        ...done,
        status: 'DONE_WITH_CONCERNS',
        concerns: [],
      })),
      /concerns/i,
    );
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify({
        ...done,
        status: 'NEEDS_CONTEXT',
        evidence: [],
      })),
      /missingContext/i,
    );
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify({
        ...done,
        status: 'BLOCKED',
        evidence: [],
      })),
      /blockers/i,
    );
  });

  it('rejects illegal status and stage pairs and unknown fields', () => {
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify({
        ...redReady,
        status: 'BLOCKED',
        evidence: [],
        blockers: ['architecture'],
      })),
      /RED_READY/i,
    );
    assert.throws(
      () => parseImplementationOutcome(JSON.stringify({ ...done, extra: true })),
      /unknown field/i,
    );
  });
});
