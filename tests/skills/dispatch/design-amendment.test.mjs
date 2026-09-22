import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  abortAmendment,
  activateAmendment,
  prepareAmendment,
  recoverAmendment,
  rejectAmendment,
} from '../../../skills/dispatch/scripts/design-amendment.mjs';
import { appendEvent, ensureLedgerNamespace, governingHash } from '../../../skills/dispatch/scripts/ledger.mjs';
import { parseEventLine } from '../../../skills/dispatch/scripts/ledger-events.mjs';

const oid = 'c'.repeat(40);
const at = '2026-09-20T00:00:00.000Z';
const runId = '22222222-2222-4222-8222-222222222222';

const DESIGN_BODY = [
  '---',
  JSON.stringify({ dispatch: { schemaVersion: 1, kind: 'design', slug: 'demo' } }),
  '---',
  '# Demo design',
  '',
  '## Architecture & Boundaries',
  'boundaries',
  '## Alternatives & Decisions',
  'choices',
  '## Risks, Security & Operations',
  'risks',
  '## Increment Dependency Graph',
  '| ID | Priority | Summary | Prerequisites | Paths |',
  '| --- | ---: | --- | --- | --- |',
  '| I01 | 1 | one | none | a |',
  '',
  '## Execution Status',
  '<!-- machine-managed; excluded from governed content -->',
  '',
  '## Review Findings & Resolutions',
  '*No reviews conducted yet.*',
  '',
].join('\n');

function gitInit(repo) {
  const result = spawnSync('git', ['init', '--quiet', '--initial-branch=work'], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0);
  for (const args of [['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['commit', '--allow-empty', '--no-gpg-sign', '-qm', 'initial']]) {
    const configured = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
  }
}


function approvedDesign() {
  return `${DESIGN_BODY}<!-- approval marker -->\n`;
}

describe('design amendment transactions', { concurrency: false }, () => {
  function staging() {
    return path.join(path.dirname(designPath), `.${path.basename(designPath)}`);
  }
  let tempRoot;
  let repo;
  let designPath;
  let ledgerPath;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-tmp-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-repo-'));
    gitInit(repo);
    repo = fs.realpathSync(repo);
    designPath = path.join(repo, '.scratch', 'plan', '2026-09-20-demo-design.md');
    fs.mkdirSync(path.dirname(designPath), { recursive: true });
    fs.writeFileSync(designPath, approvedDesign());
    const namespace = ensureLedgerNamespace({ tempRoot, repoHash: 'abcdef123456', env: { USER: 'test/user' } });
    ledgerPath = path.join(namespace, 'demo-ledger.md');
    appendEvent(ledgerPath, {
      v: 2, seq: 1, type: 'run-start', runId, at,
      data: {
        governingPath: path.relative(repo, designPath).replaceAll('\\', '/'),
        governingHash: governedHash(approvedDesign()),
        rootSlug: 'demo', action: 'design',
        baseline: { commit: oid, repositoryState: `sha256:${'a'.repeat(64)}`, dirtyPaths: [] },
      },
    });
    appendEvent(ledgerPath, {
      v: 2, seq: 2, type: 'approval', runId, at,
      data: { governingHash: governedHash(approvedDesign()), decision: 'approved', actor: 'user' },
    });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function governedHash(source) {
    return governingHash(source, { kind: 'design' }).hash;
  }

  function candidatePath(content) {
    const candidate = path.join(tempRoot, 'candidate-design.md');
    fs.writeFileSync(candidate, content);
    return candidate;
  }

  function amendmentEvents() {
    return fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
      .map(parseEventLine)
      .filter(event => event.type === 'amendment');
  }

  it('prepare→activate swaps content and approval atomically with ordered durable events', () => {
    const candidate = candidatePath(approvedDesign().replace('boundaries', 'revised boundaries'));
    const priorHash = governedHash(approvedDesign());
    const prepared = prepareAmendment({
      designPath, candidatePath: candidate, ledgerPath,
      baseRevision: priorHash, affectedIncrements: ['I01'],
    });
    const events = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(parseEventLine);
    assert.equal(events.at(-1).type, 'amendment');
    assert.equal(events.at(-1).data.state, 'prepared');
    assert.equal(events.at(-1).data.baseRevision, priorHash);
    assert.ok(events.at(-1).data.targetPath.endsWith('2026-09-20-demo-design.md'));
    assert.ok(events.at(-1).data.replacementPath.endsWith('demo-design.md.tmp'));
    assert.ok(path.basename(events.at(-1).data.replacementPath).startsWith('.'));
    assert.equal(fs.existsSync(`${staging()}.bak`), true);
    assert.equal(fs.readFileSync(`${staging()}.bak`, 'utf8'), approvedDesign());
    assert.equal(fs.existsSync(`${staging()}.tmp`), true);

    const activated = activateAmendment({ designPath, ledgerPath, amendmentId: prepared.amendmentId });
    assert.equal(activated.state, 'activated');
    const bodyOf = source => source.slice(source.indexOf('\n---\n') + 5);
    assert.equal(
      fs.readFileSync(designPath, 'utf8').slice(fs.readFileSync(designPath, 'utf8').indexOf('\n---\n') + 5),
      approvedDesign().replace('boundaries', 'revised boundaries').slice(approvedDesign().indexOf('\n---\n') + 5),
    );
    assert.equal(fs.existsSync(`${staging()}.bak`), false);
    assert.equal(fs.existsSync(`${staging()}.tmp`), false);
    const ordered = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(parseEventLine);
    const states = ordered.filter(e => e.type === 'amendment').map(e => e.data.state);
    assert.deepEqual(states, ['proposed', 'reviewed', 'prepared', 'activated']);
    const approval = ordered.find(e => e.type === 'approval');
    assert.equal(approval.data.governingHash, priorHash);
    const metadata = JSON.parse(fs.readFileSync(designPath, 'utf8').split('---\n')[1]);
    assert.equal(metadata.dispatch.approvedContentHash, governedHash(approvedDesign().replace('boundaries', 'revised boundaries')));
    assert.match(metadata.dispatch.approvedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('refuses a no-op amendment whose candidate governed hash equals its base', () => {
    assert.throws(
      () => prepareAmendment({
        designPath,
        candidatePath: candidatePath(approvedDesign()),
        ledgerPath,
        baseRevision: governedHash(approvedDesign()),
        affectedIncrements: [],
      }),
      /no-op|identical/i,
    );
    assert.equal(amendmentEvents().length, 0);
  });

  it('refuses prepare when the canonical design does not carry the prior revision', () => {
    const priorHash = governedHash(approvedDesign());
    fs.writeFileSync(designPath, approvedDesign().replace('risks', 'mutated risks'));
    assert.throws(
      () => prepareAmendment({
        designPath,
        candidatePath: candidatePath(approvedDesign().replace('boundaries', 'x')),
        ledgerPath,
        baseRevision: priorHash,
        affectedIncrements: [],
      }),
      /needs-reconciliation|does not carry/i,
    );
  });

  it('reject and abort leave the canonical design untouched and clean staging', () => {
    const candidate = candidatePath(approvedDesign().replace('boundaries', 'rejected boundaries'));
    const priorHash = governedHash(approvedDesign());
    const prepared = prepareAmendment({
      designPath, candidatePath: candidate, ledgerPath,
      baseRevision: priorHash, affectedIncrements: ['I01'],
    });
    rejectAmendment({ designPath, ledgerPath, amendmentId: prepared.amendmentId });
    assert.equal(fs.readFileSync(designPath, 'utf8'), approvedDesign());
    assert.equal(fs.existsSync(`${staging()}.bak`), false);
    assert.equal(fs.existsSync(`${staging()}.tmp`), false);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(parseEventLine).at(-1).data.state, 'rejected');

    const prepared2 = prepareAmendment({
      designPath,
      candidatePath: candidatePath(approvedDesign().replace('choices', 'aborted choices')),
      ledgerPath,
      baseRevision: priorHash,
      affectedIncrements: [],
    });
    abortAmendment({ designPath, ledgerPath, amendmentId: prepared2.amendmentId });
    assert.equal(fs.readFileSync(designPath, 'utf8'), approvedDesign());
    assert.equal(fs.existsSync(`${staging()}.tmp`), false);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(parseEventLine).at(-1).data.state, 'aborted');
  });

  it('recover reports the pre-rename window for a ruling and leaves the canonical intact', () => {
    prepareAmendment({
      designPath,
      candidatePath: candidatePath(approvedDesign().replace('boundaries', 'revised')),
      ledgerPath,
      baseRevision: governedHash(approvedDesign()),
      affectedIncrements: [],
    });
    const recovered = recoverAmendment({ designPath, ledgerPath });
    assert.equal(recovered.state, 'pre-rename');
    assert.equal(fs.readFileSync(designPath, 'utf8'), approvedDesign());
    assert.equal(fs.existsSync(`${staging()}.tmp`), true);
  });

  it('recover completes a post-rename interruption and resume reports the activated revision', () => {
    const candidate = approvedDesign().replace('boundaries', 'revised');
    prepareAmendment({
      designPath,
      candidatePath: candidatePath(candidate),
      ledgerPath,
      baseRevision: governedHash(approvedDesign()),
      affectedIncrements: [],
    });
    fs.writeFileSync(designPath, candidate);
    const recovered = recoverAmendment({ designPath, ledgerPath });
    assert.equal(recovered.state, 'activated-recovered');
    const metadata = JSON.parse(fs.readFileSync(designPath, 'utf8').split('---\n')[1]);
    assert.equal(metadata.dispatch.approvedContentHash, governedHash(candidate));
    const lastAmendment = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(parseEventLine).at(-1);
    assert.equal(lastAmendment.data.state, 'activated');
    assert.equal(lastAmendment.data.candidateHash, governedHash(candidate));
  });

  it('recover enters reconciliation when neither hash matches and preserves both copies', () => {
    prepareAmendment({
      designPath,
      candidatePath: candidatePath(approvedDesign().replace('boundaries', 'revised')),
      ledgerPath,
      baseRevision: governedHash(approvedDesign()),
      affectedIncrements: [],
    });
    fs.writeFileSync(designPath, approvedDesign().replace('risks', 'neither revision'));
    const recovered = recoverAmendment({ designPath, ledgerPath });
    assert.equal(recovered.state, 'needs-reconciliation');
    assert.equal(fs.existsSync(`${staging()}.bak`), true);
    assert.equal(fs.existsSync(`${staging()}.tmp`), true);
  });

  it('recover removes orphaned staging files in the post-activation cleanup window', () => {
    const candidate = approvedDesign().replace('boundaries', 'revised');
    const candidateHash = governedHash(candidate);
    const priorHash = governedHash(approvedDesign());
    const stagingFile = `${staging()}.tmp`;
    const proposedData = {
      amendmentId: 'A01', state: 'proposed', affectedIncrements: [],
    };
    const reviewedData = { amendmentId: 'A01', state: 'reviewed', affectedIncrements: [] };
    const preparedData = {
      amendmentId: 'A01', state: 'prepared', baseRevision: priorHash, candidateHash,
      affectedIncrements: [], targetPath: path.relative(repo, designPath).replaceAll('\\', '/'),
      replacementPath: `.${path.relative(repo, designPath).replaceAll('\\', '/')}.tmp`,
    };
    appendEvent(ledgerPath, { v: 2, seq: 3, type: 'amendment', runId, at, data: proposedData });
    appendEvent(ledgerPath, { v: 2, seq: 4, type: 'amendment', runId, at, data: reviewedData });
    appendEvent(ledgerPath, { v: 2, seq: 5, type: 'amendment', runId, at, data: preparedData });
    fs.writeFileSync(`${staging()}.bak`, approvedDesign());
    fs.writeFileSync(`${staging()}.tmp`, candidate);
    fs.writeFileSync(designPath, candidate);
    appendEvent(ledgerPath, {
      v: 2, seq: 6, type: 'amendment', runId, at,
      data: { amendmentId: 'A01', state: 'activated', baseRevision: priorHash, candidateHash, affectedIncrements: [] },
    });
    const recovered = recoverAmendment({ designPath, ledgerPath });
    assert.equal(recovered.state, 'cleanup-complete');
    assert.equal(fs.existsSync(`${staging()}.bak`), false);
    assert.equal(fs.existsSync(`${staging()}.tmp`), false);
  });

  it('records invalidation for affected increments on activation', () => {
    const candidate = approvedDesign().replace('boundaries', 'revised');
    const prepared = prepareAmendment({
      designPath,
      candidatePath: candidatePath(candidate),
      ledgerPath,
      baseRevision: governedHash(approvedDesign()),
      affectedIncrements: ['I01'],
      affectedDependents: [],
    });
    activateAmendment({ designPath, ledgerPath, amendmentId: prepared.amendmentId });
    const events = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(parseEventLine);
    const amendment = events.filter(e => e.type === 'amendment').at(-1);
    assert.equal(amendment.data.state, 'activated');
    assert.equal(amendment.data.affectedIncrements.includes('I01'), true);
    assert.equal(amendment.data.candidateHash, governedHash(candidate));
    const stateEvents = events.filter(e => e.type === 'increment-state');
    assert.equal(stateEvents.length, 1);
    assert.equal(stateEvents[0].data.incrementId, 'I01');
    assert.equal(stateEvents[0].data.next, 'invalidated');
    assert.match(stateEvents[0].data.cause, /amendment:A-/);
  });

  it('recover reports the pre-staging window when the prepared event landed before staging', () => {
    prepareAmendment({
      designPath,
      candidatePath: candidatePath(approvedDesign().replace('boundaries', 'revised')),
      ledgerPath,
      baseRevision: governedHash(approvedDesign()),
      affectedIncrements: [],
    });
    for (const stagingPath of [`${staging()}.bak`, `${staging()}.tmp`]) {
      if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { force: true });
    }
    const recovered = recoverAmendment({ designPath, ledgerPath });
    assert.equal(recovered.state, 'pre-staging');
    assert.equal(fs.readFileSync(designPath, 'utf8'), approvedDesign());
  });
});
