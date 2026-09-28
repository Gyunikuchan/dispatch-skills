import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  RUN_ID_PATTERN, SLUG_MAX, claimDeliverable, compoundDeliverable, createCacheDir, createRun, deliverable, runFile, runFileName, runFilePath,
  runScratch, stateCache, stateFile, truncateSlug,
} from '../../../../skills/dispatch/scripts/lib/session-paths.mjs';

const MODULE = new URL('../../../../skills/dispatch/scripts/lib/session-paths.mjs', import.meta.url);

describe('session paths', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-paths-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('builds grammar names in scope order', () => {
    assert.equal(runFileName({ round: 2, kind: 'prompt', ext: 'md' }), 'r2.prompt.md');
    assert.equal(runFileName({ round: 1, provider: 'codex', slot: 2, kind: 'trace', ext: 'log' }), 'r1-codex-2.trace.log');
    assert.equal(runFileName({ stage: 3, qualifier: 'unit-tests', kind: 'verify', ext: 'log' }), 's3-unit-tests.verify.log');
    assert.equal(runFileName({ round: 1, provider: 'agy', slot: 1, attempt: 3, kind: 'brief', ext: 'md' }), 'r1-agy-1-a3.brief.md');
    assert.equal(runFileName({ round: 1, attempt: 1, kind: 'drive', ext: 'log' }), 'r1.drive.log');
    assert.equal(runFileName({ kind: 'slots', ext: 'jsonl' }), 'slots.jsonl');
  });

  it('rejects invalid components and unknown kinds', () => {
    assert.throws(() => runFileName({ round: 1, kind: 'notes', ext: 'md' }), /Unknown run file kind/);
    assert.throws(() => runFileName({ round: 1, kind: 'report', ext: 'txt' }), /extension/);
    assert.throws(() => runFileName({ round: 0, kind: 'prompt', ext: 'md' }), /round/);
    assert.throws(() => runFileName({ round: 1, stage: 1, kind: 'prompt', ext: 'md' }), /not both/);
    assert.throws(() => runFileName({ round: 1, provider: 'Codex', slot: 1, kind: 'trace', ext: 'log' }), /provider/);
    assert.throws(() => runFileName({ round: 1, provider: 'codex', kind: 'trace', ext: 'log' }), /together/);
    assert.throws(() => runFileName({ stage: 1, qualifier: '../x', kind: 'verify', ext: 'log' }), /qualifier/);
    assert.throws(() => createRun('review', root), /Unknown run kind/);
    assert.throws(() => deliverable('Bad Slug', 'plan', { root }), /slug/);
    assert.throws(() => deliverable('ok', 'handoff', { root }), /deliverable type/);
    assert.throws(() => stateFile('../escape', root), /Invalid state file/);
  });

  it('truncates slugs to 40 characters at a word boundary', () => {
    const slug = truncateSlug('flat-typed-collision-safe-session-layout-for-dispatch');
    assert.equal(slug, 'flat-typed-collision-safe-session-layout');
    assert.ok(slug.length <= SLUG_MAX);
    assert.equal(truncateSlug('a'.repeat(50)), 'a'.repeat(40));
    assert.equal(truncateSlug('short'), 'short');
  });

  it('places deliverables at the root and machine state under .state', () => {
    assert.equal(deliverable('session-layout', 'plan', { root }), path.join(root, 'session-layout.plan.md'));
    fs.writeFileSync(path.join(root, 'session-layout.plan.md'), '');
    assert.equal(deliverable('session-layout', 'plan', { root }), path.join(root, 'session-layout.plan.md'));
    const real = fs.realpathSync(root);
    assert.equal(stateFile('telemetry.jsonl', root), path.join(real, '.state', 'telemetry.jsonl'));
    assert.equal(stateCache('baseline.json', root), path.join(real, '.state', 'cache', 'baseline.json'));
    assert.equal(createCacheDir('tree', root), path.join(real, '.state', 'cache', 'tree-1'));
    assert.equal(createCacheDir('tree', root), path.join(real, '.state', 'cache', 'tree-2'));
  });

  it('allocates NNN-<kind> run folders in sequence', () => {
    const first = createRun('plan-review', root);
    const second = createRun('code-review', root);
    assert.equal(first.id, '001-plan-review');
    assert.equal(second.id, '002-code-review');
    assert.match(second.id, RUN_ID_PATTERN);
    assert.equal(runScratch(first.id, root), path.join(first.dir, 'scratch'));
    assert.equal(runFilePath(first.id, { kind: 'state', ext: 'json' }, root), path.join(first.dir, 'state.json'));
  });

  it('refuses allocation past 999 runs', () => {
    fs.mkdirSync(path.join(root, '.state', 'runs', '999-ask'), { recursive: true });
    assert.throws(() => createRun('ask', root), /Run sequence exhausted for this session\./);
  });

  it('allocates distinct run folders under concurrent creators', async () => {
    const script = `import { createRun } from ${JSON.stringify(MODULE.href)};
      process.stdout.write(createRun('ask', process.argv[1]).id);`;
    const ids = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err))));
    })));
    assert.equal(new Set(ids).size, 6);
    assert.deepEqual([...ids].sort(), ['001-ask', '002-ask', '003-ask', '004-ask', '005-ask', '006-ask']);
  });

  it('claims a deliverable per subject and advances a different subject to the next free name', () => {
    const real = fs.realpathSync(root);
    const first = claimDeliverable('layout', 'plan', 'objective A', { root });
    assert.equal(first, path.join(root, 'layout.plan.md'));
    fs.writeFileSync(first, '');
    assert.equal(claimDeliverable('layout', 'plan', 'objective A', { root }), first);
    assert.equal(claimDeliverable('layout', 'plan', 'objective B', { root }), path.join(root, 'layout-2.plan.md'));
    assert.equal(claimDeliverable('layout', 'plan', 'objective C', { root }), path.join(root, 'layout-3.plan.md'));
    assert.equal(claimDeliverable('layout', 'plan', 'objective B', { root }), path.join(root, 'layout-2.plan.md'));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(real, '.state', 'deliverables.json'), 'utf8'))), ['layout.plan.md', 'layout-2.plan.md', 'layout-3.plan.md']);
    fs.writeFileSync(path.join(root, 'manual.plan.md'), '');
    assert.equal(claimDeliverable('manual', 'plan', 'anything', { root }), path.join(root, 'manual.plan.md'));
    const full = 'a'.repeat(SLUG_MAX);
    claimDeliverable(full, 'plan', 'first', { root });
    assert.equal(claimDeliverable(full, 'plan', 'second', { root }), path.join(root, `${'a'.repeat(SLUG_MAX - 2)}-2.plan.md`));
  });

  it('builds compound deliverables from capped slugs and rejects invalid ones', () => {
    const design = 'a'.repeat(SLUG_MAX);
    assert.equal(compoundDeliverable(`${design}-i01-${'b'.repeat(SLUG_MAX)}`, 'plan', { root }), path.join(root, `${design}-i01-${'b'.repeat(SLUG_MAX)}.plan.md`));
    assert.equal(compoundDeliverable(`${design}-integration`, 'walkthrough', { root }), path.join(root, `${design}-integration.walkthrough.md`));
    assert.throws(() => compoundDeliverable('Bad_Name-i01-x', 'plan', { root }), /must be/);
    assert.throws(() => compoundDeliverable('design-root', 'plan', { root }), /must be/);
    assert.throws(() => compoundDeliverable(`${'c'.repeat(SLUG_MAX + 1)}-i01-driver`, 'plan', { root }), /exceeds/);
    assert.throws(() => compoundDeliverable('d-i01-ok', 'ledger', { root }), /Unknown deliverable type/);
    assert.throws(() => compoundDeliverable('demo-i01-foundation-i02-switch', 'plan', { root }), /ambiguous/);
    assert.throws(() => compoundDeliverable(`demo-i01-${'e'.repeat(SLUG_MAX)}-i02-x`, 'plan', { root }), /ambiguous/);
  });

  it('advances -a<N> when a launch-scoped file exists', () => {
    const { id, dir } = createRun('code-review', root);
    const spec = { round: 1, provider: 'codex', slot: 1, kind: 'trace', ext: 'log', contents: 'x' };
    assert.equal(runFile(id, spec, root), path.join(dir, 'r1-codex-1.trace.log'));
    assert.equal(runFile(id, spec, root), path.join(dir, 'r1-codex-1-a2.trace.log'));
    assert.equal(runFile(id, spec, root), path.join(dir, 'r1-codex-1-a3.trace.log'));
    assert.equal(fs.readFileSync(path.join(dir, 'r1-codex-1.trace.log'), 'utf8'), 'x');
  });
});
