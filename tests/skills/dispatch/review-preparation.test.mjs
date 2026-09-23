import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import {
  advanceInvocationState,
  assertObjectKeys,
  assertPreparationIntegrity,
  buildReviewView,
  changedKeys,
  checkpointDriftRemedy,
  completeInvocationState,
  createDispatchFiles,
  createInvocationState,
  FIELD_HINTS,
  readArtifact,
  readInvocationState,
  readJsonRequest,
  requireNode22,
  semanticSectionHashes,
  settledWritesMismatch,
  sha256,
  writeArtifactMetadata,
} from '../../../skills/dispatch/scripts/review-preparation.mjs';
import { generateSkillHashes } from '../../../skills/dispatch/scripts/common.mjs';

const tempDirs = [];
const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-preparation-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('review preparation primitives', () => {
  it('requires Node 22 and hashes normalized text deterministically', () => {
    assert.doesNotThrow(() => requireNode22('22.0.0'));
    assert.throws(() => requireNode22('21.9.0'), /Node\.js 22\+/);
    assert.equal(sha256('e\u0301\r\n'), sha256('\u00e9\n'));
  });

  it('loads bounded request files and rejects non-objects', () => {
    const dir = makeDir();
    const request = path.join(dir, 'request.json');
    fs.writeFileSync(request, '{"mode":"standalone"}');
    assert.deepEqual(readJsonRequest(request), { mode: 'standalone' });
    fs.writeFileSync(request, '[]');
    assert.throws(() => readJsonRequest(request), /one JSON object/);
    fs.writeFileSync(request, 'x'.repeat(64 * 1024 + 1));
    assert.throws(() => readJsonRequest(request), /exceeds 64 KiB/);
  });

  it('round-trips metadata without changing the artifact body', () => {
    const dir = makeDir();
    const artifact = path.join(dir, 'plan.md');
    const body = '# Plan\r\n\r\n## Proposed Changes\r\n\r\nText.\r\n';
    fs.writeFileSync(artifact, body);
    const before = readArtifact(artifact);
    writeArtifactMetadata(artifact, {
      schemaVersion: 1,
      kind: 'plan',
      slug: 'sample',
      invocationId: 'invocation-1',
      contentHash: sha256('body'),
      sectionHashes: { 'Proposed Changes': sha256('section') },
      reviewedAt: '2026-09-17T00:00:00.000Z',
    }, { expectedDocumentHash: before.documentHash });
    const after = readArtifact(artifact, { kind: 'plan', slug: 'sample' });
    assert.equal(after.body, body);
    assert.equal(after.metadata.kind, 'plan');
    assert.throws(
      () => writeArtifactMetadata(artifact, after.metadata, { expectedDocumentHash: before.documentHash }),
      /changed before metadata checkpoint/,
    );
  });

  it('rejects malformed and incompatible metadata', () => {
    const dir = makeDir();
    const artifact = path.join(dir, 'plan.md');
    fs.writeFileSync(artifact, '---\n{"dispatch":{"schemaVersion":2,"kind":"plan","slug":"sample"}}\n---\n# Plan\n');
    assert.throws(() => readArtifact(artifact, { kind: 'plan' }), /Unsupported.*schemaVersion/);
    fs.writeFileSync(artifact, '---\n{bad}\n---\n# Plan\n');
    assert.throws(() => readArtifact(artifact), /malformed JSON/);
    fs.writeFileSync(artifact, [
      '---',
      '{"dispatch":{"schemaVersion":1,"kind":"plan","slug":"sample","invocationId":"invocation-1","contentHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sectionHashes":{},"reviewedAt":"2026-02-30T00:00:00Z"}}',
      '---',
      '# Plan',
    ].join('\n'));
    assert.throws(() => readArtifact(artifact), /canonical UTC|must not be empty/);
  });

  it('builds metadata-free bounded views', () => {
    const artifact = [
      '---',
      '{"dispatch":{"schemaVersion":1,"kind":"plan","slug":"sample","contentHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}',
      '---',
      '# Plan',
      '',
      '## Proposed Changes',
      'Text.',
      '',
      '## Review Findings & Resolutions',
      '### Round 1',
      '- *No actionable findings.*',
    ].join('\n');
    const view = buildReviewView(artifact, { canonicalPath: 'plan.md', nextRound: 2 });
    assert.match(view.contents, /# Plan/);
    assert.doesNotMatch(view.contents, /schemaVersion|dispatch/);
  });

  it('plan-review prompt template states the read-only inspection bound (SC1)', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const template = fs.readFileSync(path.join(root, 'skills/dispatch/references/templates/review-prompt-plan.md'), 'utf8');
    assert.match(template, /inspect(?:ing)? by reading and searching files/i,
      'the plan-review prompt must state the read-only bound');
    assert.match(template, /run no test or build commands/i,
      'the plan-review prompt must forbid running test or build commands');
  });

  it('builds a code-review view with a readable verification table and no Ordinary execution evidence block (SC1)', () => {
    const record = {
      schemaVersion: 1,
      ordinary: {
        // acceptVerification's persisted record shape (driver/verification.mjs).
        criteria: [{ id: 'SC1', commands: ['node --test tests/value.test.mjs'] }],
        completionResults: [
          { command: 'node --test tests/value.test.mjs', exitStatus: 0, pass: 3, fail: 0, identifiers: [], diagnostic: '', criterionEvidence: [], scopeHash: 'sha256:x', mutationEpoch: 1, changed: [] },
        ],
      },
    };
    const artifact = [
      '---',
      '{"dispatch":{"schemaVersion":1,"kind":"code","slug":"sample","contentHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}',
      '---',
      '# Walkthrough',
      '',
      '## Verification & Validation',
      'Host verification is recorded in Ordinary execution evidence with evidence class, revision, result, and limitations.',
      '',
      '## Ordinary execution evidence',
      '```json',
      JSON.stringify(record),
      '```',
      '',
      '## Review Findings & Resolutions',
      '### Round 1',
      '- *No actionable findings.*',
    ].join('\n');
    const view = buildReviewView(artifact, { canonicalPath: 'walkthrough.md', nextRound: 2, kind: 'code' });
    assert.doesNotMatch(view.contents, /## Ordinary execution evidence/,
      'the code-review walkthrough view must omit the ~145 KB Ordinary execution evidence JSON block');
    assert.match(view.contents, /\|\s*Command\s*\|\s*Exit\s*\|/i,
      'the review view must contain a readable verification table with a Command/Exit header');
    assert.match(view.contents, /node --test tests\/value\.test\.mjs/,
      'the rendered table must carry the actual verification command');
  });

  it('consumes invocation generations exactly once', () => {
    const dir = makeDir();
    const artifact = path.join(dir, 'plan.md');
    fs.writeFileSync(artifact, '# Plan\n');
    const created = createInvocationState({
      kind: 'plan',
      artifactPath: artifact,
      snapshot: { contentHash: sha256('one') },
      expectedSourceKeys: ['plan-review:R1:claude:0'],
    });

    tempDirs.push(created.cleanupPath);
    const advanced = advanceInvocationState(created.context, { round: 1 });
    assert.equal(advanced.context.generation, 1);
    assert.throws(() => advanceInvocationState(created.context), /stale, replayed, forked/);
    completeInvocationState(advanced.context);
    assert.throws(() => advanceInvocationState(advanced.context), /already completed/);
  });

  it('validates an invocation path before creating its lock', () => {
    const dir = makeDir();
    const outside = path.join(dir, 'forged.json');
    const lock = `${outside}.lock`;
    assert.throws(() => advanceInvocationState({
      schemaVersion: 1,
      invocationId: 'forged-invocation',
      statePath: outside,
      generation: 0,
      token: 'x',
    }), /statePath must be beneath OS temp|statePath is invalid/);
    assert.equal(fs.existsSync(lock), false);
  });

  it('explains invocation state removed before checkpoint', () => {
    const artifactPath = path.join(makeDir(), 'plan.md');
    fs.writeFileSync(artifactPath, '# Plan\n');
    const created = createInvocationState({
      kind: 'plan',
      artifactPath,
      snapshot: { contentHash: sha256('x'), sectionHashes: {} },
    });
    fs.rmSync(created.cleanupPath, { recursive: true, force: true });
    assert.throws(
      () => readInvocationState(created.context),
      /no longer exists; it was removed before checkpoint.*prior checkpoint is retained.*invocationCleanupPath only after checkpoint or abort.*rerun preparation/s,
    );
  });

  it('explains a removed state file inside a surviving invocation dir', () => {
    const artifactPath = path.join(makeDir(), 'plan.md');
    fs.writeFileSync(artifactPath, '# Plan\n');
    const created = createInvocationState({
      kind: 'code',
      artifactPath,
      snapshot: { contentHash: sha256('x'), sectionHashes: {} },
    });
    tempDirs.push(created.cleanupPath);
    fs.rmSync(created.context.statePath);
    assert.throws(() => readInvocationState(created.context), /no longer exists; it was removed before checkpoint/);
  });

  it('keeps containment errors for missing paths outside invocation dirs', () => {
    const dir = makeDir();
    assert.throws(() => readInvocationState({
      schemaVersion: 1,
      invocationId: 'forged-invocation',
      statePath: path.join(dir, 'gone', 'state.json'),
      generation: 0,
      token: 'x',
    }), /statePath is invalid|statePath must be beneath OS temp/);
  });

  it('disambiguates duplicate H2 headings in sectionHashes', () => {
    const doc = [
      '# Plan',
      '## Changes',
      'First changes block',
      '## Changes',
      'Second changes block',
      '## Review Findings & Resolutions',
      '### Round 1',
      '- *No findings*',
    ].join('\n');
    const { sectionHashes } = semanticSectionHashes(doc);
    assert.ok(sectionHashes['Changes'], 'first Changes heading present');
    assert.ok(sectionHashes['Changes#2'], 'second duplicate Changes heading disambiguated as Changes#2');
    assert.notEqual(sectionHashes['Changes'], sectionHashes['Changes#2'], 'different hashes for distinct content');
  });

  it('selectively emits --response-schema-file in createDispatchFiles based on platform schema support', () => {
    const baseParams = {
      prompt: 'Test prompt',
      attachments: [],
      responseSchemaPath: 'schema.json',
      dispatchScriptPath: 'dispatch.mjs',
    };

    // 1. Batch mode -> should include schema file
    const batchRes = createDispatchFiles({
      ...baseParams,
      batch: { targets: [], reserves: [] },
    });
    tempDirs.push(...batchRes.cleanupPaths);
    assert.ok(batchRes.dispatch.argv.includes('--response-schema-file'));

    // 2. No selector -> should include schema file
    const noSelectorRes = createDispatchFiles({
      ...baseParams,
      selector: null,
    });
    tempDirs.push(...noSelectorRes.cleanupPaths);
    assert.ok(noSelectorRes.dispatch.argv.includes('--response-schema-file'));

    // 3. Claude selector -> should include schema file
    const claudeRes = createDispatchFiles({
      ...baseParams,
      selector: { provider: 'claude' },
    });
    tempDirs.push(...claudeRes.cleanupPaths);
    assert.ok(claudeRes.dispatch.argv.includes('--response-schema-file'));

    // 4. Non-Claude selector (agy) -> should NOT include schema file
    const agyRes = createDispatchFiles({
      ...baseParams,
      selector: { provider: 'agy' },
    });
    tempDirs.push(...agyRes.cleanupPaths);
    assert.equal(agyRes.dispatch.argv.includes('--response-schema-file'), false);

    // 5. Non-Claude selector (opencode) -> should NOT include schema file
    const opencodeRes = createDispatchFiles({
      ...baseParams,
      selector: { provider: 'opencode' },
    });
    tempDirs.push(...opencodeRes.cleanupPaths);
    assert.equal(opencodeRes.dispatch.argv.includes('--response-schema-file'), false);
  });

  it('routes dispatch output to a cleaned-up temp file named in the manifest', () => {
    const res = createDispatchFiles({
      prompt: 'Test prompt',
      attachments: [],
      responseSchemaPath: 'schema.json',
      dispatchScriptPath: 'dispatch.mjs',
      batch: { targets: [], reserves: [] },
    });
    tempDirs.push(...res.cleanupPaths);
    const index = res.dispatch.argv.indexOf('--output-file');
    assert.ok(index > 0);
    assert.equal(res.dispatch.argv[index + 1], res.dispatch.outputPath);
    assert.ok(res.cleanupPaths.includes(path.dirname(res.dispatch.outputPath)));
  });

  it('computes sorted changed keys across previous and current records', () => {
    assert.deepEqual(changedKeys({ a: 1, b: 2 }, { a: 1, b: 3 }), ['b']);
    assert.deepEqual(changedKeys({ a: 1 }, { a: 1, b: 2 }), ['b']);
    assert.deepEqual(changedKeys({ b: 2, a: 1 }, {}), ['a', 'b']);
    assert.deepEqual(changedKeys({}, {}), []);
  });
});

describe('assertObjectKeys', () => {
  const allowed = ['artifactPath', 'roundId', 'invocationContext'];

  it('suggests a mapped hint only when the receiver accepts it', () => {
    assert.throws(() => assertObjectKeys({ plan: 'x' }, allowed, 'request', FIELD_HINTS),
      /unsupported field "plan"; did you mean "artifactPath"\?; allowed: artifactPath, roundId, invocationContext\./);
    assert.throws(() => assertObjectKeys({ walkthrough: 'x' }, allowed, 'request', FIELD_HINTS),
      (err) => !/did you mean/.test(err.message) && /allowed:/.test(err.message));
  });

  it('falls back to the nearest allowed name within edit distance 2', () => {
    assert.throws(() => assertObjectKeys({ roundid: 'x' }, allowed, 'request'), /did you mean "roundId"\?/);
    assert.throws(() => assertObjectKeys({ roundIx: 'x' }, allowed, 'request'), /did you mean "roundId"\?/);
    assert.throws(() => assertObjectKeys({ surprise: true }, allowed, 'request'), (err) => !/did you mean/.test(err.message));
  });
});

describe('settledWritesMismatch', () => {
  it('names both sides of the delta and the resend remedy', () => {
    const message = settledWritesMismatch(
      'settledWrites.paths',
      'code changes',
      ['src/kept.ts', 'src/unexpected.ts'],
      ['src/kept.ts', 'src/missing.ts'],
    );
    assert.match(message, /settledWrites\.paths do not match observed code changes/);
    assert.match(message, /declared but unchanged: src\/missing\.ts/);
    assert.match(message, /changed but undeclared: src\/unexpected\.ts/);
    assert.match(message, /set to \["src\/kept\.ts","src\/unexpected\.ts"\]/);
    assert.match(message, /rerun preparation/);
  });

  it('renders an empty observed set as []', () => {
    const message = settledWritesMismatch('settledWrites.sections', 'plan changes', [], ['Proposed Changes']);
    assert.match(message, /declared but unchanged: Proposed Changes/);
    assert.match(message, /changed but undeclared: none/);
    assert.match(message, /set to \[\]/);
  });

  it('reports "none" for an empty declared set', () => {
    const message = settledWritesMismatch('settledWrites.sections', 'plan changes', ['Verification Plan'], []);
    assert.match(message, /declared but unchanged: none/);
    assert.match(message, /changed but undeclared: Verification Plan/);
    assert.match(message, /set to \["Verification Plan"\]/);
  });

  it('explains that the resolution-log section is never a settled write', () => {
    const message = settledWritesMismatch('settledWrites.sections', 'plan changes', [], ['Review Findings & Resolutions']);
    assert.match(message, /set to \[\]/);
    assert.match(message, /resolution-log section is excluded from settled writes/);
  });

  it('keeps missing/unexpected wording for invocation targets', () => {
    const message = settledWritesMismatch('settlement.terminalSourceKeys', 'invocation targets', ['a'], ['b']);
    assert.match(message, /missing: b; unexpected: a/);
    assert.match(message, /set to \["a"\]/);
  });
});

describe('checkpointDriftRemedy', () => {
  it('appends the rerun remedy to a drift diagnostic', () => {
    const message = checkpointDriftRemedy('The selected review range changed during the invocation.');
    assert.match(message, /^The selected review range changed during the invocation\. /);
    assert.match(message, /Rerun preparation; the prior checkpoint is retained\.$/);
  });
});

describe('fence-aware excluded-section stripping', () => {
  const design = (body) => [
    '# D',
    '',
    '## Architecture & Boundaries',
    'content',
    ...body,
    '',
    '## Alternatives & Decisions',
    'choices',
  ].join('\n');

  it('strips the real Execution Status section', () => {
    const hashes = semanticSectionHashes(design([
      '## Execution Status',
      'ready',
    ]), { excludedSections: ['Execution Status'] });
    assert.equal(Object.hasOwn(hashes.sectionHashes, 'Execution Status'), false);
  });

  it('does not treat a fenced Execution Status heading as the section start', () => {
    const source = design([
      '## Preparation',
      '```md',
      '## Execution Status',
      'example inside a fence',
      '```',
    ]);
    const hashes = semanticSectionHashes(source, { excludedSections: ['Execution Status'] });
    assert.equal(Object.hasOwn(hashes.sectionHashes, 'Execution Status'), false);
    assert.equal(Object.hasOwn(hashes.sectionHashes, 'Preparation'), true);
    assert.match(hashes.sectionHashes['Preparation'] ? 'present' : 'missing', /present/);
  });

  it('fails closed on fenced ## lines inside the excluded section', () => {
    // A stray fence pairing with a later one would otherwise hide governed sections from the hash.
    const source = design(['## Execution Status', '```', 'rows', '## Governed', 'body', '```']);
    assert.throws(
      () => semanticSectionHashes(source, { excludedSections: ['Execution Status'] }),
      /Fenced `## ` heading inside ## Execution Status/,
    );
  });

  it('bounds the governed design excerpt', async () => {
    const { governingDesignExcerpt } = await import('../../../skills/dispatch/scripts/review-preparation.mjs');
    const excerpt = governingDesignExcerpt(design([
      '## Execution Status',
      'rows',
    ]), { revision: `sha256:${'a'.repeat(64)}` });
    assert.match(excerpt.revision, /^sha256:[a-f0-9]{64}$/);
    assert.ok(excerpt.excerpt.length <= 4000);
    assert.match(excerpt.excerpt, /## Architecture & Boundaries/);
    assert.doesNotMatch(excerpt.excerpt, /## Execution Status/);
  });
});

describe('assertPreparationIntegrity', () => {
  it('verifies only the dispatch skill', () => {
    const dispatchDir = makeDir();
    fs.writeFileSync(path.join(dispatchDir, 'SKILL.md'), '# valid\n');
    fs.writeFileSync(path.join(dispatchDir, 'skill-hashes.json'), `${JSON.stringify(generateSkillHashes(dispatchDir), null, 2)}\n`);
    assert.equal(assertPreparationIntegrity.length, 1, 'single dispatch target');
    assertPreparationIntegrity(dispatchDir);
    fs.writeFileSync(path.join(dispatchDir, 'SKILL.md'), '# tampered\n');
    assert.throws(() => assertPreparationIntegrity(dispatchDir), /dispatch skill integrity failure/);
  });
});
