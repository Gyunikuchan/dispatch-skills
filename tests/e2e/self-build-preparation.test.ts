import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from '../helpers/e2e.ts';

const referencePath = new URL('../../skills/dispatch/references/self-build.md', import.meta.url);
const reference = fs.readFileSync(referencePath, 'utf8');
const block = (heading: string) => {
  const section = reference.split(/^## /m).find(value => value.split(/\r?\n/, 1)[0] === heading)!;
  return [...section.matchAll(/^```javascript\r?\n([\s\S]*?)^```\s*$/gm)][0]![1]!;
};

test('documented preparation rejects unsafe ownership and linked paths', async t => {
  const scenario = async (name: string, run: (c: Awaited<ReturnType<typeof setup>>) => void, fresh = false, worktree = false) => {
    await t.test(name, async () => {
      const c = await setup(fresh, worktree);
      try { run(c); } finally { c.f.cleanup(); }
    });
  };
  async function setup(fresh = false, worktree = false) {
    const f = fixture();
    let targetRepo = f.repo;
    if (worktree) {
      targetRepo = path.join(f.dir, 'worktree');
      f.git('worktree', 'add', '--detach', targetRepo, 'HEAD');
    }
    const initialized = worktree ? spawnSync(process.execPath, [f.entry, 'session', 'init', '--session-id', 'worktree', '--objective', 'Fresh worktree preparation'], { cwd: targetRepo, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' } }) : null;
    if (initialized) assert.equal(initialized.status, 0, initialized.stderr);
    const session = initialized ? JSON.parse(initialized.stdout).sessionDir as string : await f.initialize({ spec: !fresh });
    if (!fresh) fs.mkdirSync(path.join(session, '.state'), { recursive: true });
    const scratch = path.join(session, '.state/scratch');
    const entry = path.join(f.dir, 'materialize.mjs');
    fs.writeFileSync(entry, block('Prepare the session'));
    const invoke = (helper: string, args: string[]) => spawnSync(process.execPath, [helper, ...args], {
      cwd: f.repo, encoding: 'utf8', windowsHide: true, timeout: 25000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' },
    });
    const materialize = (target = targetRepo, selected = session, heading = 'Capture controller', ref = fileURLToPath(referencePath)) => {
      const result = invoke(entry, [ref, target, selected, heading]);
      // The baseline entry has three arguments; replay its documented layout to expose its write boundary.
      return result.status !== 0 && /Unknown helper/.test(result.stderr)
        ? invoke(entry, [ref, selected, heading]) : result;
    };
    const capture = () => {
      const result = materialize(); assert.equal(result.status, 0, result.stderr);
      const source = path.join(targetRepo, 'selected'); fs.cpSync(f.skill, source, { recursive: true });
      const dest = path.join(scratch, 'controller/skills/dispatch'), inventory = path.join(scratch, 'inventory.json');
      const captured = invoke(result.stdout.trim(), ['--target', targetRepo, '--session', session, '--source', source, '--dest', dest, '--inventory', inventory]);
      assert.equal(captured.status, 0, captured.stderr);
      return { dest, inventory, record: JSON.parse(captured.stdout) as { identity: string; files: { path: string }[] } };
    };
    return { f, session, scratch, invoke, materialize, capture };
  }

  for (const worktree of [false, true]) await scenario(`fresh initialized ${worktree ? 'worktree' : 'repository'} completes materialization capture and verification`, c => {
    assert.equal(fs.existsSync(path.join(c.session, '.state')), false);
    assert.deepEqual(fs.readdirSync(c.session), ['manifest.json']);
    const { dest, inventory, record } = c.capture();
    const helper = c.materialize(undefined, undefined, 'Verify controller');
    assert.equal(helper.status, 0, helper.stderr);
    const verified = c.invoke(helper.stdout.trim(), ['--dest', dest, '--inventory', inventory]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).identity, record.identity);
  }, true, worktree);

  await scenario('invalid git marker grants no helper write authority', c => {
    fs.renameSync(path.join(c.f.repo, '.git'), path.join(c.f.dir, 'saved-git'));
    fs.mkdirSync(path.join(c.f.repo, '.git'));
    const result = c.materialize();
    assert.equal(fs.existsSync(c.scratch), false, 'invalid repository created scratch');
    assert.notEqual(result.status, 0, 'invalid repository accepted');
  });

  await scenario('complete preparation verifies selected source and reuses identical helpers', c => {
    const { dest, inventory, record } = c.capture();
    const helper = path.join(c.scratch, 'capture-controller.mjs');
    const before = fs.statSync(helper).mtimeMs;
    assert.equal(c.materialize().status, 0);
    assert.equal(fs.statSync(helper).mtimeMs, before);
    const result = c.materialize(c.f.repo, c.session, 'Verify controller');
    assert.equal(result.status, 0, result.stderr);
    const verified = c.invoke(result.stdout.trim(), ['--dest', dest, '--inventory', inventory]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).identity, record.identity);
    for (const prefix of ['scripts/', 'references/', 'references/templates/']) assert.ok(record.files.some(file => file.path.startsWith(prefix)));
    for (const name of ['SKILL.md', 'config.local.jsonc', 'config.sample.jsonc', 'skill-hashes.json']) assert.ok(record.files.some(file => file.path === name));
  });

  for (const kind of ['uninitialized', 'outside', 'forged ownership', 'invalid identity', 'non-repository']) {
    await scenario(`materialization refuses ${kind} before writing`, c => {
      let session = c.session, target = c.f.repo;
      if (kind === 'uninitialized') { session = path.join(c.f.repo, '.scratch/uninitialized'); fs.mkdirSync(session); }
      if (kind === 'outside') { session = path.join(c.f.dir, path.basename(c.session)); fs.cpSync(c.session, session, { recursive: true }); }
      if (kind === 'non-repository') { target = c.f.dir; }
      if (kind === 'forged ownership' || kind === 'invalid identity') {
        const file = path.join(session, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (kind === 'forged ownership') manifest.repositoryRoot = c.f.dir; else manifest.safeSessionId = 'forged';
        fs.writeFileSync(file, JSON.stringify(manifest));
      }
      const output = path.join(session, '.state/scratch/capture-controller.mjs');
      const result = c.materialize(target, session);
      assert.equal(fs.existsSync(output), false, `unsafe ${kind} wrote a helper`);
      assert.notEqual(result.status, 0, `unsafe ${kind} accepted`);
    });
  }

  for (const kind of ['target', 'session', '.state', 'scratch', 'helper']) {
    await scenario(`materialization refuses linked ${kind} without changing external bytes`, c => {
      const external = path.join(c.f.dir, 'external'); fs.mkdirSync(external);
      const sentinel = path.join(external, 'sentinel'); fs.writeFileSync(sentinel, 'preserve');
      let target = c.f.repo, session = c.session;
      if (kind === 'target') { target = path.join(c.f.dir, 'linked-repo'); fs.symlinkSync(c.f.repo, target, 'junction'); }
      if (kind === 'session') {
        session = path.join(c.f.repo, '.scratch', 'linked-session'); fs.symlinkSync(c.session, session, 'junction');
      }
      if (kind === '.state') {
        const state = path.join(c.session, '.state'); fs.renameSync(state, path.join(c.f.dir, 'saved-state')); fs.symlinkSync(external, state, 'junction');
      }
      if (kind === 'scratch') {
        if (fs.existsSync(c.scratch)) fs.renameSync(c.scratch, path.join(c.f.dir, 'saved-scratch'));
        fs.symlinkSync(external, c.scratch, 'junction');
      }
      if (kind === 'helper') {
        fs.mkdirSync(c.scratch, { recursive: true });
        fs.symlinkSync(external, path.join(c.scratch, 'capture-controller.mjs'), 'junction');
      }
      const result = c.materialize(target, session);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
      assert.deepEqual(fs.readdirSync(external), ['sentinel']);
      assert.notEqual(result.status, 0, `linked ${kind} accepted`);
    });
  }

  await scenario('different helper bytes remain intact', c => {
    fs.mkdirSync(c.scratch, { recursive: true });
    const helper = path.join(c.scratch, 'capture-controller.mjs'); fs.writeFileSync(helper, 'preserve');
    assert.notEqual(c.materialize().status, 0);
    assert.equal(fs.readFileSync(helper, 'utf8'), 'preserve');
  });
  for (const kind of ['duplicate section', 'duplicate fence', 'missing fence']) {
    await scenario(`ambiguous reference ${kind} creates no helper`, c => {
      const ref = path.join(c.f.dir, 'invalid.md');
      const section = `## Capture controller\n\n\x60\x60\x60javascript\nconsole.log('unused');\n\x60\x60\x60\n`;
      fs.writeFileSync(ref, kind === 'duplicate section' ? section + section : kind === 'missing fence' ? '## Capture controller\n' : section + '\n\x60\x60\x60javascript\nconsole.log(2);\n\x60\x60\x60\n');
      assert.notEqual(c.materialize(c.f.repo, c.session, 'Capture controller', ref).status, 0);
      assert.equal(fs.existsSync(path.join(c.scratch, 'capture-controller.mjs')), false);
    });
  }

  await scenario('invalid capture inputs create no snapshot and preserve existing output', c => {
    const result = c.materialize(); assert.equal(result.status, 0, result.stderr);
    const helper = result.stdout.trim(), dest = path.join(c.scratch, 'snapshot'), inventory = path.join(c.scratch, 'inventory.json');
    const args = ['--target', c.f.repo, '--session', c.session, '--source', c.f.skill, '--dest', dest, '--inventory', inventory];
    fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'sentinel'), 'preserve');
    assert.notEqual(c.invoke(helper, args).status, 0);
    assert.equal(fs.existsSync(inventory), false);
    assert.equal(fs.readFileSync(path.join(dest, 'sentinel'), 'utf8'), 'preserve');
    const missing = path.join(c.f.dir, 'incomplete'); fs.mkdirSync(missing);
    args[5] = missing; args[7] = path.join(c.scratch, 'fresh');
    assert.notEqual(c.invoke(helper, args).status, 0);
    assert.equal(fs.existsSync(args[7]!), false); assert.equal(fs.existsSync(inventory), false);
  });

  await scenario('restore validates source before preserving corrupt bytes and restoring inventory', c => {
    const { dest, inventory } = c.capture();
    const helper = path.join(c.f.dir, 'restore.mjs'); fs.writeFileSync(helper, block('Resume or recover'));
    const changed = path.join(dest, 'SKILL.md'); fs.writeFileSync(changed, 'corrupt');
    const stage = path.join(c.scratch, 'stage'), bad = path.join(c.f.dir, 'bad'); fs.mkdirSync(bad);
    assert.notEqual(c.invoke(helper, [inventory, bad, stage]).status, 0);
    assert.equal(fs.existsSync(stage), false); assert.equal(fs.readFileSync(changed, 'utf8'), 'corrupt');
    const result = c.invoke(helper, [inventory, c.f.skill, stage]); assert.equal(result.status, 0, result.stderr);
    const restored = JSON.parse(result.stdout) as { quarantine: string };
    assert.equal(fs.readFileSync(path.join(restored.quarantine, 'SKILL.md'), 'utf8'), 'corrupt');
    assert.equal(fs.readFileSync(changed, 'utf8'), fs.readFileSync(path.join(c.f.skill, 'SKILL.md'), 'utf8'));
    assert.equal(fs.existsSync(stage), false);
  });

  await scenario('ledger preflight preserves both records on linked or conflicting ownership', c => {
    const helper = path.join(c.f.dir, 'ledger.mjs'); fs.writeFileSync(helper, block('Bounded manual repair'));
    fs.mkdirSync(c.scratch, { recursive: true });
    const task = path.join(c.scratch, 'task.json'), ledger = path.join(c.scratch, 'worktrees.json'), tree = path.join(c.scratch, 'tree');
    const args = [c.session, task, ledger, 'create', tree, 'owner', 'host'];
    assert.equal(c.invoke(helper, args).status, 0);
    const original = fs.readFileSync(ledger, 'utf8');
    const row = JSON.parse(fs.readFileSync(task, 'utf8')); row.owner = 'other'; fs.writeFileSync(task, JSON.stringify(row));
    assert.notEqual(c.invoke(helper, [c.session, task, ledger]).status, 0);
    assert.equal(fs.readFileSync(ledger, 'utf8'), original);
    const external = path.join(c.f.dir, 'external'); fs.mkdirSync(external);
    const linked = path.join(c.scratch, 'linked'); fs.symlinkSync(external, linked, 'junction');
    assert.notEqual(c.invoke(helper, [c.session, path.join(linked, 'task.json'), ledger, 'create', tree + '-new', 'owner', 'host']).status, 0);
    assert.deepEqual(fs.readdirSync(external), []); assert.equal(fs.readFileSync(ledger, 'utf8'), original);
  });

  await scenario('cleanup preflights all paths before deletion and records retention', c => {
    const helper = path.join(c.f.dir, 'cleanup.mjs'); fs.writeFileSync(helper, block('Retain or clean controller artifacts'));
    fs.mkdirSync(c.scratch, { recursive: true });
    const owned = path.join(c.scratch, 'owned'), outside = path.join(c.f.dir, 'sentinel'), log = path.join(c.scratch, 'lifecycle.jsonl');
    fs.writeFileSync(owned, 'owned'); fs.writeFileSync(outside, 'preserve');
    assert.notEqual(c.invoke(helper, [c.session, log, 'complete', owned, outside]).status, 0);
    assert.equal(fs.readFileSync(owned, 'utf8'), 'owned'); assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
    assert.equal(fs.existsSync(log), false);
    assert.equal(c.invoke(helper, [c.session, log, 'retained', owned]).status, 0);
    assert.equal(fs.readFileSync(owned, 'utf8'), 'owned');
    assert.equal(c.invoke(helper, [c.session, log, 'complete', owned]).status, 0);
    assert.equal(fs.existsSync(owned), false);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).disposition), ['retained', 'complete']);
  });
});
