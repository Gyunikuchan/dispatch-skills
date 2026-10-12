import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createCheckout, worktreePath } from '../../../skills/dispatch/scripts/effects/checkout.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

test('delivery uses Git filemode default when the config key is absent', async () => {
  const cwd = tempDir(), runDir = tempDir(), ports = fakePorts(); let queried = false;
  ports.git.run = async (argv) => {
    if (argv[0] === 'rev-parse') return 'candidate';
    if (argv[0] === 'config') { queried = true; if (!argv.includes('--default=true')) throw Object.assign(new Error('unset'), { exitCode: 1 }); return 'true'; }
    return '';
  };
  const result = await createCheckout({ cwd, links: { create: () => {}, remove: () => {} } })({ kind: 'checkout', id: 'deliver', op: 'deliver', input: { base: 'base', revision: 'candidate' } }, ports, { runDir, attempt: 1 });
  assert.equal(result[0]?.type, 'CHECKOUT_DONE'); assert.equal(queried, true);
});

test('change receipt: delivery refuses a newer ignored destination before any caller mutation', async () => {
  const cwd = tempDir(), runDir = tempDir(), root = worktreePath(runDir, 'integration'), ports = fakePorts();
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(cwd, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(cwd, 'ignored.txt'), 'newer caller bytes');
  let writes = 0; ports.fs.writeBase64Atomic = () => { writes++; };
  ports.git.run = async (argv) => {
    if (argv[0] === 'rev-parse') return 'candidate';
    if (argv[0] === 'diff') return 'ignored.txt\0';
    if (argv[0] === 'hash-object') return 'c'.repeat(40);
    if (argv[0] === 'ls-tree') return `100644 blob ${argv[2] === 'base' ? 'a'.repeat(40) : 'b'.repeat(40)}\tignored.txt\0`;
    return '';
  };
  const result = (await createCheckout({ cwd, links: { create: () => {}, remove: () => {} } })({ kind: 'checkout', id: 'checkout.deliver.1', op: 'deliver', input: { base: 'base', revision: 'candidate' } }, ports, { runDir, attempt: 1 }))[0]!;
  assert.equal(result.type, 'CHECKOUT_DONE');
  if (result.type === 'CHECKOUT_DONE') assert.deepEqual(result.result['conflicts'], ['ignored.txt']);
  assert.equal(writes, 0); assert.equal(fs.readFileSync(path.join(cwd, 'ignored.txt'), 'utf8'), 'newer caller bytes');
});

test('level-journal: scope replacement checkout resets an incomplete transfer and replays it', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run');
  const originalName = 'task-t1', name = 'task-t1-scope-2';
  const original = worktreePath(runDir, originalName), target = worktreePath(runDir, name);
  fs.mkdirSync(path.join(original, 'src'), { recursive: true });
  fs.writeFileSync(path.join(original, 'src', 'a.ts'), 'writer draft');
  const ports = fakePorts();
  let additions = 0, resets = 0, applies = 0;
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'worktree' && argv[1] === 'add') {
      additions++;
      fs.mkdirSync(path.join(target, 'src'), { recursive: true });
      fs.writeFileSync(path.join(target, 'src', 'a.ts'), 'new prerequisite');
      return '';
    }
    if (argv[0] === 'reset') { resets++; fs.writeFileSync(path.join(target, 'src', 'a.ts'), 'new prerequisite'); return ''; }
    if (argv[0] === 'clean') return '';
    if (argv[0] === 'diff' && argv[1] === '--name-only') return at === original ? 'src/a.ts\0' : 'src/a.ts\0';
    if (argv[0] === 'diff' && argv[1] === '--binary') return 'tracked draft patch';
    if (argv[0] === 'apply') {
      applies++;
      fs.writeFileSync(path.join(target, 'src', 'a.ts'), 'writer draft rebased on prerequisite');
      return '';
    }
    if (argv[0] === 'ls-files') return '';
    throw new Error(`unexpected fake git call: ${argv.join(' ')}`);
  };
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const input = { name, originalName, revision: 'new-base', permitted: ['src/a.ts'], transferKey: 'scope-request:T1:new-base:signature', links: [], ignored: [] };
  const effect = (id: string): Extract<Effect, { kind: 'checkout' }> => ({ kind: 'checkout', id, op: 'scope-rebase', input });
  const writeAtomic = ports.fs.writeBase64Atomic;
  let interrupted = false;
  ports.fs.writeBase64Atomic = (file, contents) => {
    if (!interrupted && file.includes(path.join('scope-transfers'))) { interrupted = true; throw new Error('simulated interruption before transfer marker'); }
    writeAtomic(file, contents);
  };
  const first = (await handler(effect('checkout.scope-rebase.1'), ports, { runDir, attempt: 1 }))[0] as ResultEvent;
  assert.ok(first.type === 'EFFECT_FAILED' && /simulated interruption/.test(first.detail));
  assert.equal(fs.readFileSync(path.join(target, 'src', 'a.ts'), 'utf8'), 'writer draft rebased on prerequisite');
  ports.fs.writeBase64Atomic = writeAtomic;

  const replay = (await handler(effect('checkout.scope-rebase.2'), ports, { runDir, attempt: 1 }))[0] as ResultEvent;
  assert.equal(replay.type, 'CHECKOUT_DONE');
  if (replay.type === 'CHECKOUT_DONE') {
    assert.equal(replay.result['conflict'], false);
    assert.equal(replay.result['path'], target);
    assert.equal(replay.result['revision'], 'new-base');
    assert.deepEqual(replay.result['transferred'], ['src/a.ts']);
  }
  assert.equal(additions, 1);
  assert.equal(resets, 1);
  assert.equal(applies, 2);
});

test('level-journal: scope replacement refuses destination symlink ancestors before draft writes', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run');
  const originalName = 'task-t1', name = 'task-t1-scope-2';
  const original = worktreePath(runDir, originalName), target = worktreePath(runDir, name);
  fs.mkdirSync(path.join(original, 'src'), { recursive: true });
  fs.writeFileSync(path.join(original, 'src', 'new.ts'), 'writer draft');
  const ports = fakePorts();
  const inspect = ports.fs.inspectPath;
  ports.fs.inspectPath = (file) => path.resolve(file) === path.resolve(target, 'src')
    ? { kind: 'symlink', mode: 0o777, linkTarget: '../outside', realPath: path.join(cwd, 'outside') }
    : inspect(file);
  let writes = 0;
  const writeAtomic = ports.fs.writeBase64Atomic;
  ports.fs.writeBase64Atomic = (file, contents) => { writes++; writeAtomic(file, contents); };
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'worktree' && argv[1] === 'add') { fs.mkdirSync(target, { recursive: true }); return ''; }
    if (argv[0] === 'diff' && argv[1] === '--name-only') return '';
    if (argv[0] === 'ls-files' && at === original) return 'src/new.ts\0';
    throw new Error(`unexpected fake git call: ${argv.join(' ')}`);
  };
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const input = { name, originalName, revision: 'new-base', permitted: ['src/new.ts'], transferKey: 'scope-request:T1:new-base:signature', links: [], ignored: [] };
  const [event] = await handler({ kind: 'checkout', id: 'checkout.scope-rebase.1', op: 'scope-rebase', input }, ports, { runDir, attempt: 1 });
  assert.ok(event?.type === 'CHECKOUT_DONE');
  if (event?.type === 'CHECKOUT_DONE') {
    assert.equal(event.result['conflict'], true);
    assert.match(String(event.result['detail']), /symlink ancestor/);
  }
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'outside', 'new.ts')), false);
});

test('task checkout with keep rewinds HEAD to the input without discarding the draft', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run');
  fs.mkdirSync(worktreePath(runDir, 'task-t1'), { recursive: true });
  const ports = fakePorts();
  const calls: string[] = [];
  ports.git.run = async (argv) => { calls.push(argv.join(' ')); return argv[0] === 'rev-parse' ? 'input-rev\n' : ''; };
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const events = await handler({ kind: 'checkout', id: 'c1', op: 'task', input: { name: 'task-t1', revision: 'input-rev', keep: true, links: [], ignored: [] } }, ports, { runDir } as never) as ResultEvent[];
  assert.equal(events[0]?.type, 'CHECKOUT_DONE');
  assert.ok(calls.includes('reset -q --mixed input-rev'));
  assert.ok(!calls.some((call) => call.startsWith('clean') || call.includes('--hard')));
});

// SECTION: Integration conflicts, resolutions, and trim (stateful fake Git; unit tests spawn nothing)

type FakeCommit = { parent: string | null; message: string; tree: ReadonlyMap<string, string> };

/** Minimal Git model for one worktree: commits, index, unmerged paths, CHERRY_PICK_HEAD; files live on disk under `root`. */
function fakeGit(root: string) {
  const commits = new Map<string, FakeCommit>();
  let index = new Map<string, string>(), headRev = '', pick: string | null = null;
  const unmergedPaths = new Set<string>();
  const disk = (): Map<string, string> => {
    const out = new Map<string, string>();
    if (!fs.existsSync(root)) return out;
    for (const entry of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      const file = entry.split(path.sep).join('/'), absolute = path.join(root, file);
      if (fs.statSync(absolute).isFile()) out.set(file, fs.readFileSync(absolute, 'utf8'));
    }
    return out;
  };
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
  const tree = (rev: string) => { const found = commits.get(rev.replace(/\^$/, '')); if (!found) throw new Error(`unknown revision ${rev}`); return found.tree; };
  const add = (parent: string | null, message: string, files: ReadonlyMap<string, string>) => {
    const id = `c${commits.size + 1}`.padEnd(8, '0'); commits.set(id, { parent, message, tree: new Map(files) }); return id;
  };
  const resetHard = (rev: string) => {
    const target = tree(rev), files = disk(), prior = headRev ? tree(headRev) : new Map<string, string>();
    for (const file of new Set([...index.keys(), ...prior.keys()])) if (!target.has(file) && files.has(file)) fs.rmSync(path.join(root, file));
    for (const [file, content] of target) write(file, content);
    headRev = rev; index = new Map(target); unmergedPaths.clear(); pick = null;
  };
  const dirty = () => {
    const files = disk(), head = tree(headRev);
    return unmergedPaths.size > 0 || [...new Set([...files.keys(), ...index.keys(), ...head.keys()])].some((file) => files.get(file) !== index.get(file) || index.get(file) !== head.get(file));
  };
  const list = (files: Iterable<string>) => [...files].map((file) => `${file}\0`).join('');
  const run = async (argv: readonly string[]): Promise<string> => {
    const args = [...argv];
    while (args[0] === '-c') args.splice(0, 2);
    const [cmd, ...rest] = args;
    switch (cmd) {
      case 'rev-parse': {
        if (rest.includes('CHERRY_PICK_HEAD')) { if (!pick) throw new Error('no CHERRY_PICK_HEAD'); return `${pick}\n`; }
        const rev = rest[0]!;
        if (rev === 'HEAD') return `${headRev}\n`;
        const parent = commits.get(rev.replace(/\^$/, ''))?.parent;
        if (!parent) throw new Error(`no parent ${rev}`);
        return `${parent}\n`;
      }
      case 'update-ref': pick = rest[1]!; return '';
      case 'log': {
        if (rest[0] === '-1') return commits.get(rest[2] ?? headRev)!.message;
        const [from, to] = rest[1]!.split('..') as [string, string];
        const messages: string[] = [];
        for (let at: string | null = to; at && at !== from; at = commits.get(at)?.parent ?? null) messages.push(commits.get(at)!.message);
        return messages.join('\n');
      }
      case 'reset': resetHard(rest[2]!); return '';
      case 'clean': for (const file of disk().keys()) if (!index.has(file)) fs.rmSync(path.join(root, file)); return '';
      case 'status': return dirty() ? ' M changed\n' : '';
      case 'cherry-pick': {
        const candidate = commits.get(rest[1]!)!, base = tree(candidate.parent!), head = tree(headRev);
        for (const file of new Set([...base.keys(), ...candidate.tree.keys()])) {
          const theirs = candidate.tree.get(file), before = base.get(file), ours = head.get(file);
          if (theirs === before || theirs === ours) continue;
          if (ours === before) {
            if (theirs === undefined) { fs.rmSync(path.join(root, file)); index.delete(file); } else { write(file, theirs); index.set(file, theirs); }
            continue;
          }
          write(file, `<<<<<<< HEAD\n${ours ?? ''}=======\n${theirs ?? ''}>>>>>>> candidate\n`);
          unmergedPaths.add(file);
        }
        if (unmergedPaths.size) throw new Error('CONFLICT (content): Merge conflict');
        return '';
      }
      case 'diff': {
        if (rest.includes('--diff-filter=U')) return list(unmergedPaths);
        const revs = rest.filter((arg) => !arg.startsWith('-'));
        if (revs.length === 2) {
          const a = tree(revs[0]!), b = tree(revs[1]!);
          return list([...new Set([...a.keys(), ...b.keys()])].filter((file) => a.get(file) !== b.get(file)));
        }
        const base = tree(revs[0]!), files = disk();
        if (rest.includes('--cached')) return list([...new Set([...base.keys(), ...index.keys()])].filter((file) => index.get(file) !== base.get(file)));
        return list([...new Set([...base.keys(), ...index.keys()])].filter((file) => unmergedPaths.has(file) || files.get(file) !== base.get(file)));
      }
      case 'ls-files': return list([...disk().keys()].filter((file) => !index.has(file)));
      case 'add': {
        const files = disk(), paths = rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [...new Set([...files.keys(), ...index.keys()])];
        for (const file of paths) { if (files.has(file)) index.set(file, files.get(file)!); else index.delete(file); unmergedPaths.delete(file); }
        return '';
      }
      case 'commit': {
        if (unmergedPaths.size) throw new Error('unmerged files');
        headRev = add(headRev, rest[rest.indexOf('-m') + 1]!, index);
        pick = null;
        return '';
      }
      default: throw new Error(`unexpected fake git call: ${argv.join(' ')}`);
    }
  };
  return {
    run, commits,
    /** Seeds a commit; `null` content deletes the path from the parent's tree. */
    commit(parent: string | null, files: Record<string, string | null>, message = 'seed'): string {
      const next = new Map(parent ? tree(parent) : []);
      for (const [file, content] of Object.entries(files)) { if (content === null) next.delete(file); else next.set(file, content); }
      return add(parent, message, next);
    },
    checkout(rev: string) { fs.mkdirSync(root, { recursive: true }); resetHard(rev); },
    get pick() { return pick; },
    get head() { return headRev; },
    unmerged: () => [...unmergedPaths].sort(),
  };
}

/** Two tasks edit `src/shared.ts` from one base; T1 is integrated, so T2's candidate conflicts. */
function conflictFixture() {
  const cwd = tempDir(), runDir = path.join(cwd, 'run'), root = worktreePath(runDir, 'integration');
  const git = fakeGit(root), ports = fakePorts();
  ports.git.run = (argv) => git.run(argv);
  const base = git.commit(null, { 'src/shared.ts': 'base\n', 'src/other.ts': 'other\n' });
  const integrated = git.commit(base, { 'src/shared.ts': 'from T1\n' }, 'dispatch integrate T1');
  const candidate = git.commit(base, { 'src/shared.ts': 'from T2\n', 'src/t2.ts': 't2\n' }, 'dispatch task');
  git.checkout(integrated);
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  let seq = 0;
  const op = async (kind: 'integrate' | 'resolve' | 'reset', input: Record<string, unknown>) => {
    const [event] = await handler({ kind: 'checkout', id: `checkout.${kind}.${++seq}`, op: kind, input }, ports, { runDir, attempt: 1 });
    return event as ResultEvent;
  };
  const result = (event: ResultEvent) => { assert.equal(event.type, 'CHECKOUT_DONE', JSON.stringify(event)); return event.type === 'CHECKOUT_DONE' ? event.result : {}; };
  const integrate = () => op('integrate', { task: 'T2', candidate, expected: integrated });
  const resolveInput = (attempt: number, expected: string, permitted = ['src/shared.ts', 'src/t2.ts'], base = integrated) => ({ tasks: ['T1', 'T2'], candidate, attempt, expected, base, permitted });
  const writeFile = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
  const readFile = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  return { git, root, integrated, candidate, op, result, integrate, resolveInput, writeFile, readFile };
}

test('preserves conflicted integration tree', async () => {
  const f = conflictFixture();
  const first = f.result(await f.integrate());
  assert.deepEqual([first['conflict'], first['revision'], first['paths']], [true, f.integrated, ['src/shared.ts']]);
  assert.equal(f.git.pick, f.candidate);
  f.writeFile('src/shared.ts', 'merged by orchestrator\n');
  const retry = f.result(await f.integrate());
  assert.deepEqual([retry['conflict'], retry['revision'], retry['paths'], retry['reused']], [true, f.integrated, ['src/shared.ts'], true]);
  assert.equal(f.readFile('src/shared.ts'), 'merged by orchestrator\n');
  assert.equal(f.readFile('src/t2.ts'), 't2\n');
});

test('recovers conflict after interrupted integrate', async () => {
  const f = conflictFixture();
  // Interrupted after the cherry-pick conflicted and its pick was recorded, before the result was journaled.
  await f.git.run(['cherry-pick', '--no-commit', f.candidate]).catch(() => '');
  await f.git.run(['update-ref', 'CHERRY_PICK_HEAD', f.candidate]);
  const recovered = f.result(await f.integrate());
  assert.deepEqual([recovered['conflict'], recovered['revision'], recovered['paths']], [true, f.integrated, ['src/shared.ts']]);
  assert.equal(f.git.head, f.integrated);
  assert.match(f.readFile('src/shared.ts'), /^<<<<<<< HEAD/m);
});

test('reset aborts in-progress cherry-pick', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  const reset = f.result(await f.op('reset', { name: 'integration', revision: f.integrated }));
  assert.equal(reset['revision'], f.integrated);
  assert.equal(f.git.pick, null);
  assert.deepEqual(f.git.unmerged(), []);
  assert.equal(f.readFile('src/shared.ts'), 'from T1\n');
  assert.equal(fs.existsSync(path.join(f.root, 'src', 't2.ts')), false);
});

test('refuses resolution with conflict markers', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  const refused = f.result(await f.op('resolve', f.resolveInput(1, f.integrated)));
  assert.deepEqual([refused['refused'], refused['paths'], refused['revision']], ['markers', ['src/shared.ts'], f.integrated]);
  assert.equal(f.git.head, f.integrated);
  assert.equal(f.git.pick, f.candidate);
  assert.deepEqual(f.git.unmerged(), ['src/shared.ts']);
});

test('refuses resolution outside permitted paths', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  f.writeFile('src/shared.ts', 'from T1 and T2\n');
  f.writeFile('src/other.ts', 'unrelated edit\n');
  fs.writeFileSync(path.join(f.root, 'notes.txt'), 'untracked\n');
  const refused = f.result(await f.op('resolve', f.resolveInput(1, f.integrated)));
  assert.deepEqual([refused['refused'], refused['paths'], refused['retained']], ['out-of-scope', ['notes.txt', 'src/other.ts'], []]);
  assert.equal(f.git.head, f.integrated);
  assert.deepEqual(f.git.unmerged(), ['src/shared.ts']);
});

test('reuses committed resolution on retry', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  f.writeFile('src/shared.ts', 'from T1 and T2\n');
  const resolved = f.result(await f.op('resolve', f.resolveInput(1, f.integrated)));
  assert.deepEqual([resolved['paths'], resolved['reused']], [['src/shared.ts', 'src/t2.ts'], undefined]);
  const revision = String(resolved['revision']), message = f.git.commits.get(revision)!.message;
  assert.notEqual(revision, f.integrated);
  assert.ok(message.includes(`Dispatch-Candidate: ${f.candidate}\n`) && message.includes('Dispatch-Resolves: T1,T2 attempt 1'), message);
  assert.equal(f.git.pick, null);
  const commits = f.git.commits.size;
  const replay = f.result(await f.op('resolve', f.resolveInput(1, f.integrated)));
  assert.deepEqual([replay['revision'], replay['paths'], replay['reused']], [revision, ['src/shared.ts', 'src/t2.ts'], true]);
  assert.equal(f.git.commits.size, commits);
  // Uncommitted edits on top of the resolution are not a replay of the same attempt.
  f.writeFile('src/shared.ts', 'edited after the resolution\n');
  assert.equal((await f.op('resolve', f.resolveInput(1, f.integrated))).type, 'EFFECT_FAILED');
});

test('refuses replay of committed resolution outside a narrowed permitted set', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  f.writeFile('src/shared.ts', 'from T1 and T2\n');
  f.result(await f.op('resolve', f.resolveInput(1, f.integrated)));
  const replay = await f.op('resolve', f.resolveInput(1, f.integrated, ['src/shared.ts']));
  assert.equal(replay.type, 'EFFECT_FAILED');
  assert.match(JSON.stringify(replay), /outside the permitted set: src\/t2\.ts/);
});

test('repairs failed resolution as new attempt', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  f.writeFile('src/shared.ts', 'first resolution\n');
  const first = String(f.result(await f.op('resolve', f.resolveInput(1, f.integrated)))['revision']);
  // The resolution check failed; the orchestrator repairs in place and resolves attempt 2 from the first resolution.
  f.writeFile('src/shared.ts', 'repaired resolution\n');
  f.writeFile('src/other.ts', 'out of scope\n');
  const refused = f.result(await f.op('resolve', f.resolveInput(2, first)));
  assert.deepEqual([refused['refused'], refused['paths'], f.git.head], ['out-of-scope', ['src/other.ts'], first]);
  f.writeFile('src/other.ts', 'other\n');
  const repaired = f.result(await f.op('resolve', f.resolveInput(2, first)));
  const revision = String(repaired['revision']);
  assert.deepEqual([f.git.commits.get(revision)!.parent, repaired['paths'], repaired['reused']], [first, ['src/shared.ts'], undefined]);
  assert.ok(f.git.commits.get(revision)!.message.includes('Dispatch-Resolves: T1,T2 attempt 2'));
  const replay = f.result(await f.op('resolve', f.resolveInput(2, first)));
  assert.deepEqual([replay['revision'], replay['reused']], [revision, true]);
  assert.equal(f.readFile('src/shared.ts'), 'repaired resolution\n');
});

test('repair refuses retained earlier-attempt path outside a narrowed permitted set', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  f.writeFile('src/shared.ts', 'first resolution\n');
  const first = String(f.result(await f.op('resolve', f.resolveInput(1, f.integrated)))['revision']);
  // A scope-narrowing AMEND removed src/t2.ts; the repair touches only src/shared.ts, but attempt 1 committed src/t2.ts.
  f.writeFile('src/shared.ts', 'repaired resolution\n');
  const refused = f.result(await f.op('resolve', f.resolveInput(2, first, ['src/shared.ts'])));
  assert.deepEqual([refused['refused'], refused['paths'], refused['retained'], f.git.head], ['out-of-scope', ['src/t2.ts'], ['src/t2.ts'], first]);
});

test('resolution commit restages staged content to the scanned working tree', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  f.writeFile('src/other.ts', '<<<<<<< HEAD\nother\n=======\nx\n>>>>>>> candidate\n');
  await f.git.run(['add', '--', 'src/other.ts']);
  f.writeFile('src/other.ts', 'other\n');
  f.writeFile('src/shared.ts', 'from T1 and T2\n');
  const resolved = f.result(await f.op('resolve', f.resolveInput(1, f.integrated, ['src/shared.ts', 'src/t2.ts', 'src/other.ts'])));
  const committed = f.git.commits.get(String(resolved['revision']))!.tree;
  assert.equal(committed.get('src/other.ts'), 'other\n');
  assert.ok(![...committed.values()].some((content) => content.includes('<<<<<<<')));
  assert.deepEqual(resolved['paths'], ['src/shared.ts', 'src/t2.ts']);
});

/** Caller checkout with transient test files; `hash` is the fake blob id of the content. */
function trimFixture() {
  const cwd = tempDir(), runDir = path.join(cwd, 'run'), ports = fakePorts();
  const blob = (content: string) => `blob-${Buffer.from(content).toString('hex')}`;
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'hash-object' && at === cwd) return `${blob(fs.readFileSync(path.join(cwd, argv[2]!), 'utf8'))}\n`;
    throw new Error(`unexpected fake git call: ${argv.join(' ')}`);
  };
  const put = (file: string, content: string) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), content); };
  put('tests/a.test.ts', 'transient a\n');
  put('tests/b.test.ts', 'transient b\n');
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const trim = async (files: { path: string; hash: string }[], allowed: string[]) => {
    const [event] = await handler({ kind: 'checkout', id: 'checkout.trim.1', op: 'trim', input: { files, allowed } }, ports, { runDir, attempt: 1 });
    assert.equal(event?.type, 'CHECKOUT_DONE', JSON.stringify(event));
    return event?.type === 'CHECKOUT_DONE' ? event.result : {};
  };
  const exists = (file: string) => fs.existsSync(path.join(cwd, file));
  const files = [{ path: 'tests/a.test.ts', hash: blob('transient a\n') }, { path: 'tests/b.test.ts', hash: blob('transient b\n') }];
  return { cwd, ports, put, trim, exists, files, allowed: files.map((file) => file.path) };
}

test('trim refuses unlisted path', async () => {
  const f = trimFixture();
  const result = await f.trim(f.files, ['tests/a.test.ts']);
  assert.deepEqual(result['refused'], [{ path: 'tests/b.test.ts', reason: 'not-allowed' }]);
  assert.deepEqual([f.exists('tests/a.test.ts'), f.exists('tests/b.test.ts')], [true, true]);
});

test('trim refuses changed file', async () => {
  const f = trimFixture();
  f.put('tests/b.test.ts', 'edited by the caller\n');
  const result = await f.trim(f.files, f.allowed);
  assert.deepEqual(result['refused'], [{ path: 'tests/b.test.ts', reason: 'changed' }]);
  assert.deepEqual([f.exists('tests/a.test.ts'), f.exists('tests/b.test.ts')], [true, true]);
});

test('trim refuses redirected ancestor', async () => {
  const f = trimFixture();
  const inspect = f.ports.fs.inspectPath;
  f.ports.fs.inspectPath = (file) => path.resolve(file) === path.resolve(f.cwd, 'tests')
    ? { kind: 'symlink', mode: 0o777, linkTarget: '../outside', realPath: path.join(path.dirname(f.cwd), 'outside') }
    : inspect(file);
  const result = await f.trim(f.files, f.allowed);
  assert.deepEqual(result['refused'], [{ path: 'tests/a.test.ts', reason: 'redirected' }, { path: 'tests/b.test.ts', reason: 'redirected' }]);
  assert.deepEqual([f.exists('tests/a.test.ts'), f.exists('tests/b.test.ts')], [true, true]);
});

test('trim treats absent file as done', async () => {
  const f = trimFixture();
  fs.rmSync(path.join(f.cwd, 'tests/a.test.ts'));
  const first = await f.trim(f.files, f.allowed);
  assert.deepEqual([first['trimmed'], first['already'], first['refused']], [['tests/b.test.ts'], ['tests/a.test.ts'], []]);
  const retry = await f.trim(f.files, f.allowed);
  assert.deepEqual([retry['trimmed'], retry['already'], retry['refused']], [[], ['tests/a.test.ts', 'tests/b.test.ts'], []]);
  assert.deepEqual([f.exists('tests/a.test.ts'), f.exists('tests/b.test.ts')], [false, false]);
});

test('refuses markers in repair attempt', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  f.writeFile('src/shared.ts', 'first resolution\n');
  const first = String(f.result(await f.op('resolve', f.resolveInput(1, f.integrated)))['revision']);
  f.writeFile('src/shared.ts', '<<<<<<< HEAD\nrepair\n=======\nother\n>>>>>>> candidate\n');
  const refused = f.result(await f.op('resolve', f.resolveInput(2, first)));
  assert.deepEqual([refused['refused'], refused['paths'], f.git.head], ['markers', ['src/shared.ts'], first]);
});

test('refuses markers in staged resolution file', async () => {
  const f = conflictFixture();
  f.result(await f.integrate());
  await f.git.run(['add', '--', 'src/shared.ts']);
  assert.deepEqual(f.git.unmerged(), []);
  const refused = f.result(await f.op('resolve', f.resolveInput(1, f.integrated)));
  assert.deepEqual([refused['refused'], refused['paths'], f.git.head], ['markers', ['src/shared.ts'], f.integrated]);
});

test('trim observe reports caller blobs', async () => {
  const f = trimFixture();
  fs.rmSync(path.join(f.cwd, 'tests/b.test.ts'));
  const handler = createCheckout({ cwd: f.cwd, links: { create: () => {}, remove: () => {} } });
  const [event] = await handler({ kind: 'checkout', id: 'checkout.trim.2', op: 'trim', input: { observe: ['tests/a.test.ts', 'tests/b.test.ts'] } }, f.ports, { runDir: path.join(f.cwd, 'run'), attempt: 1 });
  assert.equal(event?.type, 'CHECKOUT_DONE');
  if (event?.type === 'CHECKOUT_DONE') assert.deepEqual(event.result['observed'], { 'tests/a.test.ts': f.files[0]!.hash, 'tests/b.test.ts': null });
  assert.ok(f.exists('tests/a.test.ts'));
});
