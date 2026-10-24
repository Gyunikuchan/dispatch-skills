import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const transfer = (r: Record<string, unknown>) => ({ conflicts: r['conflicts'], transferred: r['transferred'], already: r['already'] });

async function checkoutRepo() {

  const { nodePorts } = await import('../../skills/dispatch/scripts/core/ports.ts');
  const { createCheckout } = await import('../../skills/dispatch/scripts/effects/checkout.ts');
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-checkout-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  write('.gitignore', '.scratch/\nnode_modules/\n.env\n'); write('src/a.ts', 'a1\n'); write('src/b.ts', 'b1\n'); write('src/gone.ts', 'gone\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const runDir = path.join(repo, '.scratch/run'); fs.mkdirSync(runDir, { recursive: true });
  const ports = nodePorts();
  const handler = createCheckout({ cwd: repo, links: { create: (target, link) => fs.symlinkSync(target, link, 'junction'), remove: (link) => fs.unlinkSync(link) } });
  let id = 0;
  const invoke = async (name: string, input: Record<string, unknown> = {}) => {
    const [event] = await handler({ kind: 'checkout', id: `c.${++id}`, op: name as never, input }, ports, { runDir, attempt: 1 });
    assert.ok(event, 'checkout handler returned an event');
    return event;
  };
  const op = async (name: string, input: Record<string, unknown> = {}) => {
    const event = await invoke(name, input);
    assert.ok(event.type === 'CHECKOUT_DONE', JSON.stringify(event));
    return event.result as Record<string, unknown>;
  };
  return { repo, git, write, runDir, ports, invoke, op, read: (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8') };
}

test('checkout: baseline reproduces caller dirt and links ignored dependencies without deleting them on cleanup', async () => {
  const c = await checkoutRepo();
  c.write('src/a.ts', 'a-dirty\n'); c.write('src/new.ts', 'new\n'); fs.rmSync(path.join(c.repo, 'src/gone.ts')); c.write('node_modules/dep/index.js', 'dep'); c.write('.env', 'X=1');
  const baseline = await c.op('init'), root = String(baseline['path']);
  assert.equal(c.read(root, 'src/a.ts'), 'a-dirty\n'); assert.equal(c.read(root, 'src/new.ts'), 'new\n'); assert.equal(fs.existsSync(path.join(root, 'src/gone.ts')), false);
  assert.equal(c.read(root, 'node_modules/dep/index.js'), 'dep'); assert.equal(c.read(root, '.env'), 'X=1');
  assert.deepEqual((await c.op('init'))['base'], baseline['base']);
  const task = String((await c.op('task', { name: 't1', revision: baseline['base'], links: ['node_modules'], ignored: ['.env'] }))['path']);
  assert.equal(c.read(task, '.env'), 'X=1'); assert.equal(c.read(task, 'node_modules/dep/index.js'), 'dep');
  assert.deepEqual((await c.op('cleanup', { names: ['integration', 't1'], links: ['node_modules'] }))['removed'], ['integration', 't1']);
  assert.equal(c.read(c.repo, 'node_modules/dep/index.js'), 'dep'); assert.equal(c.read(c.repo, 'src/a.ts'), 'a-dirty\n');
});

test('checkout: task worktrees are isolated and integration is idempotent and keeps a conflict in place', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']), t2 = String((await c.op('task', { name: 't2', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 't1\n'); fs.writeFileSync(path.join(t2, 'src/a.ts'), 't2\n');
  assert.equal(c.read(t2, 'src/a.ts'), 't2\n'); assert.equal(c.read(c.repo, 'src/a.ts'), 'a1\n');
  const one = await c.op('commit', { name: 't1', base }), two = await c.op('commit', { name: 't2', base });
  assert.deepEqual(one['paths'], ['src/a.ts']); assert.equal((await c.op('commit', { name: 't1', base }))['revision'], one['revision']);
  const merged = await c.op('integrate', { task: 'T1', candidate: one['revision'], expected: base });
  assert.equal(merged['conflict'], false);
  assert.deepEqual(await c.op('integrate', { task: 'T1', candidate: one['revision'], expected: base }), { revision: merged['revision'], conflict: false, reused: true });
  const conflict = await c.op('integrate', { task: 'T2', candidate: two['revision'], expected: merged['revision'] });
  assert.equal(conflict['conflict'], true); assert.deepEqual(conflict['paths'], ['src/a.ts']); assert.equal(conflict['revision'], merged['revision']);
  assert.match(c.read(path.join(c.runDir, 'wt/integration'), 'src/a.ts'), /^<<<<<<< [^\n]*\nt1\n=======\nt2\n>>>>>>> /);
});

test('checkout: RED replay applies approved checkpoint files and rejects unapproved paths or differing content', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']), out = path.join(c.runDir, 'red.json');
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.mkdirSync(path.join(t1, 'tests')); fs.writeFileSync(path.join(t1, 'tests/a.test.ts'), 'red'); fs.rmSync(path.join(t1, 'src/b.ts'));
  const candidate = (await c.op('commit', { name: 't1', base }))['revision'];
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('red').toString('base64'), 'src/b.ts': null } }));
  const rejected = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts'] });
  assert.match(String(rejected['defects']), /not an approved task test path: src\/b\.ts/);

  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('differing assertion').toString('base64') } }));
  const mismatch = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts'] });
  assert.match(String(mismatch['defects']), /Submitted test differs from its RED checkpoint: tests\/a\.test\.ts/);

  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('red').toString('base64'), 'src/b.ts': null } }));
  const replay = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts', 'src/b.ts'] });
  assert.deepEqual(replay['defects'], []); assert.equal(c.read(String(replay['path']), 'tests/a.test.ts'), 'red'); assert.equal(fs.existsSync(path.join(String(replay['path']), 'src/b.ts')), false);
});

test('checkout: delivery transfers integrated changes and refuses caller drift without writing', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 'a2\n'); fs.rmSync(path.join(t1, 'src/gone.ts'));
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  c.write('src/a.ts', 'caller drift\n');
  const collision = await c.op('deliver', { base, revision });
  assert.deepEqual(collision['conflicts'], ['src/a.ts']); assert.deepEqual(collision['transferred'], []);
  assert.equal((collision['collision'] as { kind: string }).kind, 'newer-content');
  assert.equal(c.read(c.repo, 'src/a.ts'), 'caller drift\n'); assert.equal(fs.existsSync(path.join(c.repo, 'src/gone.ts')), true);
  c.write('src/a.ts', 'a1\n');
  assert.deepEqual(transfer(await c.op('deliver', { base, revision })), { conflicts: [], transferred: ['src/a.ts', 'src/gone.ts'], already: [] });
  assert.equal(c.read(c.repo, 'src/a.ts'), 'a2\n');
  assert.deepEqual(transfer(await c.op('deliver', { base, revision })), { conflicts: [], transferred: [], already: ['src/a.ts', 'src/gone.ts'] });
});

test('checkout: integration discards an interrupted uncommitted cherry-pick before replaying the candidate', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 't1\n');
  const candidate = String((await c.op('commit', { name: 't1', base }))['revision']);
  const integration = path.join(c.runDir, 'wt/integration');
  execFileSync('git', ['cherry-pick', '--no-commit', candidate], { cwd: integration, windowsHide: true });
  const merged = await c.op('integrate', { task: 'T1', candidate, expected: base });
  assert.equal(merged['conflict'], false); assert.equal(c.read(integration, 'src/a.ts'), 't1\n');
});

test('checkout: delivery refuses a caller ancestor directory replaced by an external link', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 'a2\n');
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-outside-'));
  fs.cpSync(path.join(c.repo, 'src'), outside, { recursive: true }); fs.rmSync(path.join(c.repo, 'src'), { recursive: true }); fs.symlinkSync(outside, path.join(c.repo, 'src'), 'junction');
  assert.deepEqual((await c.op('deliver', { base, revision }))['conflicts'], ['src/a.ts']);
  assert.equal(fs.readFileSync(path.join(outside, 'a.ts'), 'utf8'), 'a1\n');
});

test('checkout: baseline and delivery preserve executable modes', { skip: process.platform === 'win32' && 'POSIX file modes' }, async () => {
  const c = await checkoutRepo();
  c.write('bin/run.sh', 'echo\n'); fs.chmodSync(path.join(c.repo, 'bin/run.sh'), 0o755);
  const base = String((await c.op('init'))['base']);
  assert.equal(fs.statSync(path.join(c.runDir, 'wt/integration/bin/run.sh')).mode & 0o111, 0o111);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.chmodSync(path.join(t1, 'src/a.ts'), 0o755);
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  assert.deepEqual((await c.op('deliver', { base, revision }))['transferred'], ['src/a.ts']);
  assert.equal(fs.statSync(path.join(c.repo, 'src/a.ts')).mode & 0o111, 0o111);
});
