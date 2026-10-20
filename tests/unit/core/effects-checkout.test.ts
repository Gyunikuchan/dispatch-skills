import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, Ports, ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createCheckout, worktreePath } from '../../../skills/dispatch/scripts/effects/checkout.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';

test('delivery replay: interrupted completed pick retries provenance without reset or duplicate pick', async () => {
  const cwd = tempDir(), runDir = tempDir(), root = worktreePath(runDir, 'integration'), ports = fakePorts();
  memoryRunFs(ports, runDir);
  ports.fs.mkdir(root, { recursive: true }); ports.fs.mkdir(worktreePath(runDir, 'integration-archive'), { recursive: true });
  const completed: string[] = [], picks: string[] = []; let interrupted = false, resets = 0;
  ports.git.run = async (argv) => {
    if (argv[0] === 'reset' || argv[0] === 'clean') { resets++; return ''; }
    if (argv[0] === 'rev-list' && argv.some((arg) => arg.startsWith('--grep='))) return 'newbase';
    if (argv[0] === 'rev-list') return argv.includes('oldbase..oldhead') ? 'first\nsecond\nthird' : completed.join('\n');
    if (argv[0] === 'log') return argv.at(-1) === 'newbase' ? 'dispatch baseline\n\nDispatch-Baseline: {}' : `(cherry picked from commit ${argv.at(-1)!.replace('new-', '')})`;
    if (argv[0] === 'rev-parse') { if (argv.includes('CHERRY_PICK_HEAD')) throw new Error('no active pick'); return completed.at(-1) ?? 'newbase'; }
    if (argv.includes('cherry-pick')) {
      const candidate = argv.at(-1)!; picks.push(candidate); completed.push(`new-${candidate}`);
      if (candidate === 'second' && !interrupted) { interrupted = true; throw new Error('result lost after completed commit'); }
      return '';
    }
    return '';
  };
  const effect: Extract<Effect, { kind: 'checkout' }> = { kind: 'checkout', id: 'replay.1', op: 'init', input: { rebase: true, archivedName: 'integration-archive', replay: { base: 'oldbase', head: 'oldhead' } } };
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const interruptedResult = (await handler(effect, ports, { runDir, attempt: 1 }))[0]!;
  assert.equal(interruptedResult.type, 'EFFECT_FAILED', 'an absent active pick needs explicit effect recovery, not conflict resolution');
  const resumed = (await handler(effect, ports, { runDir, attempt: 2 }))[0]!;
  assert.equal(resumed.type, 'CHECKOUT_DONE');
  if (resumed.type === 'CHECKOUT_DONE') assert.deepEqual(resumed.result['replayed'], ['first', 'second', 'third'].map((from) => ({ from, to: `new-${from}` })));
  assert.deepEqual(picks, ['first', 'second', 'third']); assert.equal(resets, 0);
});

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
  memoryRunFs(ports, cwd);
  ports.fs.mkdir(root, { recursive: true }); ports.fs.writeAtomic(path.join(cwd, '.gitignore'), 'ignored.txt\n');
  ports.fs.writeAtomic(path.join(cwd, 'ignored.txt'), 'newer caller bytes');
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
  assert.equal(writes, 0); assert.equal(ports.fs.readText(path.join(cwd, 'ignored.txt')), 'newer caller bytes');
});

test('level-journal: scope replacement checkout resets an incomplete transfer and replays it', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run');
  const originalName = 'task-t1', name = 'task-t1-scope-2';
  const original = worktreePath(runDir, originalName), target = worktreePath(runDir, name);
  const ports = fakePorts();
  memoryRunFs(ports, cwd);
  ports.fs.mkdir(path.join(original, 'src'), { recursive: true });
  ports.fs.writeAtomic(path.join(original, 'src', 'a.ts'), 'writer draft');
  let additions = 0, resets = 0, applies = 0;
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'worktree' && argv[1] === 'add') {
      additions++;
      ports.fs.mkdir(path.join(target, 'src'), { recursive: true });
      ports.fs.writeAtomic(path.join(target, 'src', 'a.ts'), 'new prerequisite');
      return '';
    }
    if (argv[0] === 'reset') { resets++; ports.fs.writeAtomic(path.join(target, 'src', 'a.ts'), 'new prerequisite'); return ''; }
    if (argv[0] === 'clean') return '';
    if (argv[0] === 'diff' && argv[1] === '--name-only') return at === original ? 'src/a.ts\0' : 'src/a.ts\0';
    if (argv[0] === 'diff' && argv[1] === '--binary') return 'tracked draft patch';
    if (argv[0] === 'apply') {
      applies++;
      ports.fs.writeAtomic(path.join(target, 'src', 'a.ts'), 'writer draft rebased on prerequisite');
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
  assert.equal(ports.fs.readText(path.join(target, 'src', 'a.ts')), 'writer draft rebased on prerequisite');
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
  const ports = fakePorts();
  memoryRunFs(ports, cwd);
  ports.fs.mkdir(path.join(original, 'src'), { recursive: true });
  ports.fs.writeAtomic(path.join(original, 'src', 'new.ts'), 'writer draft');
  const inspect = ports.fs.inspectPath;
  ports.fs.inspectPath = (file) => path.resolve(file) === path.resolve(target, 'src')
    ? { kind: 'symlink', mode: 0o777, linkTarget: '../outside', realPath: path.join(cwd, 'outside') }
    : inspect(file);
  let writes = 0;
  const writeAtomic = ports.fs.writeBase64Atomic;
  ports.fs.writeBase64Atomic = (file, contents) => { writes++; writeAtomic(file, contents); };
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'worktree' && argv[1] === 'add') { ports.fs.mkdir(target, { recursive: true }); return ''; }
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
  assert.equal(ports.fs.exists(path.join(cwd, 'outside', 'new.ts')), false);
});

test('task checkout with keep rewinds HEAD to the input without discarding the draft', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run');
  const ports = fakePorts();
  memoryRunFs(ports, cwd);
  ports.fs.mkdir(worktreePath(runDir, 'task-t1'), { recursive: true });
  const calls: string[] = [];
  ports.git.run = async (argv) => { calls.push(argv.join(' ')); return argv[0] === 'rev-parse' ? 'input-rev\n' : ''; };
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const events = await handler({ kind: 'checkout', id: 'c1', op: 'task', input: { name: 'task-t1', revision: 'input-rev', keep: true, links: [], ignored: [] } }, ports, { runDir } as never) as ResultEvent[];
  assert.equal(events[0]?.type, 'CHECKOUT_DONE');
  assert.ok(calls.includes('reset -q --mixed input-rev'));
  assert.ok(!calls.some((call) => call.startsWith('clean') || call.includes('--hard')));
});

// SECTION: Draft snapshots before a task reset (scripted Git; the e2e suite proves the same contract on real Git)

const INPUT = 'a'.repeat(40), PRIOR = 'b'.repeat(40), WRITER_COMMIT = 'd'.repeat(40), ZERO = '0'.repeat(40);
const DRAFT = 'refs/dispatch/drafts/0a1b2c3d-001/t1-implement.checkout.7';

/** One task worktree's HEAD, dirtiness, and the repository refs; `commit` captures the dirty draft. */
function draftGit(ports: Ports, start: { head: string; dirty: boolean; refs?: Record<string, string> }) {
  const state = { head: start.head, dirty: start.dirty, refs: new Map(Object.entries(start.refs ?? {})), commits: 0 };
  const calls: string[] = [];
  ports.git.run = async (argv) => {
    calls.push(argv.join(' '));
    const args = argv.filter((arg, i) => arg !== '-c' && argv[i - 1] !== '-c');
    switch (args[0]) {
      case 'rev-parse': {
        if (!args.includes('--verify')) return `${state.head}\n`;
        const target = state.refs.get(args.at(-1)!);
        if (!target) throw new Error('fatal: needed a single revision');
        return `${target}\n`;
      }
      case 'status': return state.dirty ? ' M src/a.ts\0?? src/new.ts\0' : '';
      case 'commit': state.commits++; state.head = String(state.commits).padStart(40, 'c'); state.dirty = false; return '';
      case 'update-ref': {
        if (args[1] === '-d') { state.refs.delete(args[2]!); return ''; }
        if (args[3] !== ZERO || state.refs.has(args[1]!)) throw new Error(`fatal: cannot lock ref '${args[1]}': reference already exists`);
        state.refs.set(args[1]!, args[2]!); return '';
      }
      case 'reset': state.head = args.at(-1)!; state.dirty = false; return '';
      case 'for-each-ref': { const prefix = args.at(-1)!; return [...state.refs.keys()].filter((ref) => ref.startsWith(`${prefix}/`)).map((ref) => `${ref}\n`).join(''); }
      default: return '';
    }
  };
  return { state, calls };
}

async function draftCheckout(op: 'task' | 'reset', start: Parameters<typeof draftGit>[1], input: Record<string, unknown>, exists = true) {
  const cwd = tempDir(), runDir = path.join(cwd, 'run'), ports = fakePorts();
  memoryRunFs(ports, cwd);
  if (exists) ports.fs.mkdir(worktreePath(runDir, 'task-t1'), { recursive: true });
  const git = draftGit(ports, start);
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const [event] = await handler({ kind: 'checkout', id: 'implement.checkout.7', op, input: { name: 'task-t1', revision: INPUT, ...(op === 'task' ? { reset: true, links: [], ignored: [] } : {}), ...input } }, ports, { runDir } as never) as ResultEvent[];
  assert.equal(event?.type, 'CHECKOUT_DONE', JSON.stringify(event));
  return { ...git, result: event?.type === 'CHECKOUT_DONE' ? event.result as Record<string, unknown> : {}, path: worktreePath(runDir, 'task-t1') };
}

test('draft snapshot of a dirty task or relaunch reset commits the draft and creates its ref before the hard reset', async () => {
  for (const op of ['task', 'reset'] as const) {
    const { state, calls, result, path: root } = await draftCheckout(op, { head: INPUT, dirty: true }, { snapshot: DRAFT });
    assert.deepEqual(result, { path: root, revision: INPUT, snapshot: DRAFT }, op);
    const captured = state.refs.get(DRAFT);
    assert.ok(captured && captured !== INPUT, `${op} ref holds the draft commit`);
    const commit = calls.find((call) => call.includes(' commit '));
    assert.match(commit ?? '', /core\.hooksPath=\.dispatch-no-hooks.*--no-verify/, op);
    assert.ok(calls.indexOf(`update-ref ${DRAFT} ${captured} ${ZERO}`) >= 0, `${op} creates the ref only when absent`);
    assert.ok(calls.indexOf(`update-ref ${DRAFT} ${captured} ${ZERO}`) < calls.indexOf(`reset -q --hard ${INPUT}`), `${op} keeps the draft before discarding it`);
    assert.ok(calls.includes('clean -q -fd'), op);
    assert.deepEqual([state.head, state.dirty], [INPUT, false], op);
  }
});

test('draft snapshot of a committed draft on a clean tree refs its HEAD without another commit', async () => {
  const { state, calls, result } = await draftCheckout('reset', { head: WRITER_COMMIT, dirty: false }, { snapshot: DRAFT });
  assert.equal(result['snapshot'], DRAFT);
  assert.equal(state.refs.get(DRAFT), WRITER_COMMIT);
  assert.equal(state.commits, 0);
  assert.ok(!calls.some((call) => call.includes(' commit ')));
});

test('draft snapshot with an existing ref skips to the reset and is never overwritten', async () => {
  const { state, calls, result } = await draftCheckout('task', { head: INPUT, dirty: true, refs: { [DRAFT]: WRITER_COMMIT } }, { snapshot: DRAFT });
  assert.equal(result['snapshot'], DRAFT);
  assert.equal(state.refs.get(DRAFT), WRITER_COMMIT);
  assert.ok(!calls.some((call) => call.includes(' commit ') || call.startsWith('update-ref') || call.startsWith('add')));
  assert.deepEqual([state.head, state.dirty], [INPUT, false]);
});

test('draft snapshot is not written without a draft', async () => {
  const cases: [string, Parameters<typeof draftGit>[1], Record<string, unknown>, boolean][] = [
    ['clean at the input', { head: INPUT, dirty: false }, { snapshot: DRAFT }, true],
    ['clean at the prior input', { head: PRIOR, dirty: false }, { snapshot: DRAFT, draftBase: PRIOR }, true],
    ['new worktree', { head: INPUT, dirty: false }, { snapshot: DRAFT }, false],
  ];
  for (const [name, start, input, exists] of cases) {
    const { state, calls, result } = await draftCheckout('task', start, input, exists);
    assert.equal(result['snapshot'], null, name);
    assert.equal(state.refs.size, 0, name);
    assert.ok(!calls.some((call) => call.includes(' commit ') || call.startsWith('update-ref')), name);
  }
});

test('without a draft snapshot input the reset runs exactly as before', async () => {
  for (const op of ['task', 'reset'] as const) {
    const { calls, result, path: root } = await draftCheckout(op, { head: PRIOR, dirty: true }, {});
    assert.deepEqual(calls, [`reset -q --hard ${INPUT}`, 'clean -q -fd', 'rev-parse HEAD'], op);
    assert.deepEqual(result, { path: root, revision: INPUT }, op);
  }
});

test('draft snapshot cleanup deletes only refs under its own run prefix', async () => {
  const cwd = tempDir(), runDir = path.join(cwd, 'run'), ports = fakePorts();
  memoryRunFs(ports, cwd);
  const own = ['refs/dispatch/drafts/0a1b2c3d-001/t1-implement.checkout.3', 'refs/dispatch/drafts/0a1b2c3d-001/t2-implement.checkout.9'];
  const others = ['refs/dispatch/drafts/0a1b2c3d-002/t1-implement.checkout.3', 'refs/dispatch/drafts/ffffffff-001/t1-implement.checkout.3'];
  const { state } = draftGit(ports, { head: INPUT, dirty: false, refs: Object.fromEntries([...own, ...others].map((ref) => [ref, WRITER_COMMIT])) });
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const [done] = await handler({ kind: 'checkout', id: 'implement.checkout.20', op: 'cleanup', input: { names: [], links: [], drafts: 'refs/dispatch/drafts/0a1b2c3d-001' } }, ports, { runDir } as never) as ResultEvent[];
  assert.equal(done?.type, 'CHECKOUT_DONE', JSON.stringify(done));
  assert.deepEqual([...state.refs.keys()].sort(), others);
  for (const drafts of ['refs/heads', 'refs/dispatch/drafts', 'refs/dispatch/drafts/../heads']) {
    const [refused] = await handler({ kind: 'checkout', id: 'implement.checkout.21', op: 'cleanup', input: { names: [], links: [], drafts } }, ports, { runDir } as never) as ResultEvent[];
    assert.equal(refused?.type, 'EFFECT_FAILED', drafts);
  }
  assert.deepEqual([...state.refs.keys()].sort(), others);
});

// SECTION: Integration conflicts, resolutions, and trim (stateful fake Git; unit tests spawn nothing)

type FakeCommit = { parent: string | null; message: string; tree: ReadonlyMap<string, string> };

/** Minimal Git model for one worktree: commits, index, unmerged paths, CHERRY_PICK_HEAD; files live under `root`. */
function fakeGit(root: string, ports: Ports) {
  const commits = new Map<string, FakeCommit>();
  let index = new Map<string, string>(), headRev = '', pick: string | null = null;
  const unmergedPaths = new Set<string>();
  const disk = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const file of ports.fs.listFiles(root)) {
      out.set(file, ports.fs.readText(path.join(root, file)));
    }
    return out;
  };
  const write = (file: string, content: string) => { ports.fs.writeAtomic(path.join(root, file), content); };
  const tree = (rev: string) => { const found = commits.get(rev.replace(/\^$/, '')); if (!found) throw new Error(`unknown revision ${rev}`); return found.tree; };
  const add = (parent: string | null, message: string, files: ReadonlyMap<string, string>) => {
    const id = `c${commits.size + 1}`.padEnd(8, '0'); commits.set(id, { parent, message, tree: new Map(files) }); return id;
  };
  const resetHard = (rev: string) => {
    const target = tree(rev), files = disk(), prior = headRev ? tree(headRev) : new Map<string, string>();
    for (const file of new Set([...index.keys(), ...prior.keys()])) if (!target.has(file) && files.has(file)) ports.fs.remove(path.join(root, file));
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
      case 'clean': for (const file of disk().keys()) if (!index.has(file)) ports.fs.remove(path.join(root, file)); return '';
      case 'status': return dirty() ? ' M changed\n' : '';
      case 'cherry-pick': {
        const candidate = commits.get(rest[1]!)!, base = tree(candidate.parent!), head = tree(headRev);
        for (const file of new Set([...base.keys(), ...candidate.tree.keys()])) {
          const theirs = candidate.tree.get(file), before = base.get(file), ours = head.get(file);
          if (theirs === before || theirs === ours) continue;
          if (ours === before) {
            if (theirs === undefined) { ports.fs.remove(path.join(root, file)); index.delete(file); } else { write(file, theirs); index.set(file, theirs); }
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
    checkout(rev: string) { resetHard(rev); },
    get pick() { return pick; },
    get head() { return headRev; },
    unmerged: () => [...unmergedPaths].sort(),
  };
}

/** Two tasks edit `src/shared.ts` from one base; T1 is integrated, so T2's candidate conflicts. */
function conflictFixture() {
  const cwd = tempDir(), runDir = path.join(cwd, 'run'), root = worktreePath(runDir, 'integration');
  const ports = fakePorts();
  memoryRunFs(ports, cwd);
  const git = fakeGit(root, ports);
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
  const writeFile = (file: string, content: string) => ports.fs.writeAtomic(path.join(root, file), content);
  const readFile = (file: string) => ports.fs.readText(path.join(root, file));
  return { ports, git, root, integrated, candidate, op, result, integrate, resolveInput, writeFile, readFile };
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
  assert.equal(f.ports.fs.exists(path.join(f.root, 'src', 't2.ts')), false);
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
  f.writeFile('notes.txt', 'untracked\n');
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
  memoryRunFs(ports, cwd);
  const blob = (content: string) => `blob-${Buffer.from(content).toString('hex')}`;
  ports.git.run = async (argv, at) => {
    if (argv[0] === 'hash-object' && at === cwd) return `${blob(ports.fs.readText(path.join(cwd, argv[2]!)))}\n`;
    throw new Error(`unexpected fake git call: ${argv.join(' ')}`);
  };
  const put = (file: string, content: string) => { ports.fs.writeAtomic(path.join(cwd, file), content); };
  put('tests/a.test.ts', 'transient a\n');
  put('tests/b.test.ts', 'transient b\n');
  const handler = createCheckout({ cwd, links: { create: () => {}, remove: () => {} } });
  const trim = async (files: { path: string; hash: string }[], allowed: string[]) => {
    const [event] = await handler({ kind: 'checkout', id: 'checkout.trim.1', op: 'trim', input: { files, allowed } }, ports, { runDir, attempt: 1 });
    assert.equal(event?.type, 'CHECKOUT_DONE', JSON.stringify(event));
    return event?.type === 'CHECKOUT_DONE' ? event.result : {};
  };
  const exists = (file: string) => ports.fs.exists(path.join(cwd, file));
  const files = [{ path: 'tests/a.test.ts', hash: blob('transient a\n') }, { path: 'tests/b.test.ts', hash: blob('transient b\n') }];
  return { cwd, ports, put, trim, exists, files, allowed: files.map((file) => file.path) };
}

test('trim refuses invalid or modified paths', async () => {
  // unlisted path
  const f1 = trimFixture();
  const unlisted = await f1.trim(f1.files, ['tests/a.test.ts']);
  assert.deepEqual(unlisted['refused'], [{ path: 'tests/b.test.ts', reason: 'not-allowed' }]);
  assert.deepEqual([f1.exists('tests/a.test.ts'), f1.exists('tests/b.test.ts')], [true, true]);

  // changed file
  const f2 = trimFixture();
  f2.put('tests/b.test.ts', 'edited by the caller\n');
  const changed = await f2.trim(f2.files, f2.allowed);
  assert.deepEqual(changed['refused'], [{ path: 'tests/b.test.ts', reason: 'changed' }]);
  assert.deepEqual([f2.exists('tests/a.test.ts'), f2.exists('tests/b.test.ts')], [true, true]);

  // redirected ancestor
  const f3 = trimFixture();
  const inspect = f3.ports.fs.inspectPath;
  f3.ports.fs.inspectPath = (file) => path.resolve(file) === path.resolve(f3.cwd, 'tests')
    ? { kind: 'symlink', mode: 0o777, linkTarget: '../outside', realPath: path.join(path.dirname(f3.cwd), 'outside') }
    : inspect(file);
  const redirected = await f3.trim(f3.files, f3.allowed);
  assert.deepEqual(redirected['refused'], [{ path: 'tests/a.test.ts', reason: 'redirected' }, { path: 'tests/b.test.ts', reason: 'redirected' }]);
  assert.deepEqual([f3.exists('tests/a.test.ts'), f3.exists('tests/b.test.ts')], [true, true]);
});

test('trim treats absent file as done', async () => {
  const f = trimFixture();
  f.ports.fs.remove(path.join(f.cwd, 'tests/a.test.ts'));
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
  f.ports.fs.remove(path.join(f.cwd, 'tests/b.test.ts'));
  const handler = createCheckout({ cwd: f.cwd, links: { create: () => {}, remove: () => {} } });
  const [event] = await handler({ kind: 'checkout', id: 'checkout.trim.2', op: 'trim', input: { observe: ['tests/a.test.ts', 'tests/b.test.ts'] } }, f.ports, { runDir: path.join(f.cwd, 'run'), attempt: 1 });
  assert.equal(event?.type, 'CHECKOUT_DONE');
  if (event?.type === 'CHECKOUT_DONE') assert.deepEqual(event.result['observed'], { 'tests/a.test.ts': f.files[0]!.hash, 'tests/b.test.ts': null });
  assert.ok(f.exists('tests/a.test.ts'));
});

