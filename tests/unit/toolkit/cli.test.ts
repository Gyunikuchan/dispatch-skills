import { nativeOpencodeIntrospection } from '../../../skills/dispatch/scripts/providers/opencode-runtime.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { nodeLinkFs } from '../../../skills/dispatch/scripts/lib/node-fs-ext.ts';
import { nodeProcess } from '../../../skills/dispatch/scripts/providers/node-process.ts';
import type { DelegateRequest, ProcessResult } from '../../../skills/dispatch/scripts/providers/types.ts';
import { main, nodeDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import type { HandlerContext, HandlerResult } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { ToolError } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { reviewFixFromCommit, reviewFixIdentity } from '../../../skills/dispatch/scripts/toolkit/integrate.ts';
import { checks as checkPlan, loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';

function useMemoryAtomicWrite(): () => void {
  const writeAtomic = nodeLinkFs.writeAtomic;
  nodeLinkFs.writeAtomic = (file, text) => fs.writeFileSync(file, text);
  return () => { nodeLinkFs.writeAtomic = writeAtomic; };
}

describe('toolkit CLI contract', () => {
  test('test cleanup trailer: clips a multiline reason and recovers the interrupted commit', async () => {
    const f = sessionFixture({memory:true});
    try {
      const from = 'a'.repeat(40), to = 'b'.repeat(40), tree = 'c'.repeat(40);
      const why = 'remove\n\t' + 'x'.repeat(77) + '😀' + 'y'.repeat(120);
      const criterion = 'SC1';
      const cleanup = { removed: [criterion], deleted: 2, merged: 1 };
      fs.mkdirSync(path.join(f.session, '.state/worktrees/integration'), {recursive:true});
      f.artifact('mission.spec.md', '# Mission\n');
      f.artifact('work.plan.md', [
        '# Work', '## Task Map', '| ID | Title | Outcome | Prerequisites | Criteria |',
        '| --- | --- | --- | --- | --- |', '| T1 | Tests | Tests pass | none | ' + criterion + ' |',
        '## Proposed Changes', '### T1 — Tests', '#### [MODIFY] tests/step.ts', '- Purpose: Tests behavior.',
        '## Success Criteria', '- [' + criterion + '] Tests pass', '  - Changes: tests/step.ts',
        '  - Tests: tests/step.ts', '  - Check: `node --version`', '  - Evidence: check',
        '## Verification Plan', '### Automated Tests', '- `node --version`',
      ].join('\n'));
      await appendRecord(f.session, {kind:'bind',key:'commit-inputs',by:'orchestrator',data:{spec:'mission.spec.md',plan:'work.plan.md'}}, f.deps);
      await appendRecord(f.session, {kind:'integrate',by:'tool',data:{phase:'opened',path:'.state/worktrees/integration',branch:'dispatch/test/integration',base:from,dest:{path:f.root,branch:'main'}}}, f.deps);
      const check = checkPlan(loadPlan(f.session, readManifest(f.session))).find(row => row.criterion === criterion)!;
      await appendRecord(f.session, {kind:'evidence',by:'tool',data:{
        criterion, commandDigest:check.commandDigest, tree, before:tree, after:tree, clean:true, exit:0, path:'.state/evidence/test.json',
      }}, f.deps);
      const file = path.join(f.root, 'test-cleanup.json');
      fs.writeFileSync(file, JSON.stringify(cleanup));
      let head = from, message = '';
      f.deps.run = async (argv) => {
        const args = argv.slice(1);
        let stdout = '';
        if (args[0] === 'rev-parse') {
          stdout = args[1] === 'HEAD' ? head : args[1] === 'HEAD^' ? from : tree;
        } else if (args[0] === 'diff') {
          if (head === from || args.includes(from)) stdout = 'tests/step.ts\0';
        } else if (args[0] === 'commit') {
          message = args.filter((_, index) => args[index - 1] === '-m').join('\n\n');
          head = to;
        } else if (args[0] === 'log') {
          stdout = message;
        } else if (args[0] !== 'ls-files' && args[0] !== 'add') {
          throw Error('Unexpected Git call: ' + JSON.stringify(argv));
        }
        return {exit:0,stdout,stderr:''};
      };
      const args = ['worktree','commit','--reason',why,'--test-cleanup',file,'--session',f.session];
      assert.equal(await main(args, {...f.deps, hook: () => { throw Error('interrupted'); }}), 2);
      assert.equal(message.split('\n\n')[0], 'fix(dispatch): remove ' + 'x'.repeat(77));
      f.lines.length = 0;
      assert.equal(await main(args, f.deps), 0);
      assert.equal(JSON.parse(fs.readFileSync(f.output().path!, 'utf8')).reason, why);
    } finally { f.cleanup(); }
  });
  test('commit retries distinguish corrupt correction metadata from completed retries', async () => {
    const f = sessionFixture({memory:true});
    try {
      const head = 'a'.repeat(40), reason = 'repair bounded SHOULD';
      const directory = path.join(f.session, '.state/worktrees/integration');
      fs.mkdirSync(directory, {recursive:true});
      f.artifact('mission.spec.md', '# Mission\n');
      f.artifact('work.plan.md', '# Work\n');
      await appendRecord(f.session, {kind: 'bind', key: 'commit-inputs', by: 'orchestrator', data: {spec: 'mission.spec.md', plan: 'work.plan.md'}}, f.deps);
      await appendRecord(f.session, {kind:'integrate',by:'tool',data:{phase:'opened',path:'.state/worktrees/integration',branch:'dispatch/test/integration',base:'b'.repeat(40),dest:{path:f.root,branch:'main'}}}, f.deps);
      const prefix = `fix(dispatch): ${reason}\n\nDispatch-Fix: ${readManifest(f.session).safeSessionId}\n`;
      const metadata = reviewFixIdentity({review:'code-integration',round:3,generation:1,findings:['R3-F001'],from:'b'.repeat(40)});
      let message = '';
      f.deps.run = async (argv) => {
        const args = argv.slice(1);
        if (args.join(' ') === 'rev-parse HEAD') return {exit:0,stdout:head,stderr:''};
        if (args[0] === 'diff' || args[0] === 'ls-files') return {exit:0,stdout:'',stderr:''};
        if (args[0] === 'log') return {exit:0,stdout:message,stderr:''};
        throw Error('Unexpected Git call: ' + JSON.stringify(argv));
      };
      for (const trailers of [
        `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: broken`,
        `Dispatch-Review-Fix: sha256:${'0'.repeat(64)}\nDispatch-Review-Fix-Data: ${metadata.data}`,
        `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: ${metadata.data}`,
      ]) {
        message = prefix + trailers;
        f.lines.length = 0;
        assert.equal(await main(['worktree','commit','--reason',reason,'--session',f.session],f.deps),1);
        assert.equal(f.output().reason,'invalid-review-fix');
        assert.equal(foldLedger(f.session).records.filter(row=>row.data['phase']==='fix').length,0);
      }
      message = prefix + `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: ${metadata.data}`;
      f.lines.length = 0;
      assert.equal(await main(['worktree','commit','--reason',reason,'--session',f.session],f.deps),0);
      f.lines.length = 0;
      assert.equal(await main(['worktree','commit','--reason',reason,'--session',f.session],f.deps),4);
      assert.equal(f.output().reason,'no-changes');
    } finally { f.cleanup(); }
  });
  test('review-fix commit splits correction metadata into trailer lines of at most 100 characters', async () => {
    const f = sessionFixture({memory:true});
    try {
      const reason = 'repair bounded SHOULD';
      fs.mkdirSync(path.join(f.session, '.state/worktrees/integration'), {recursive:true});
      f.artifact('mission.spec.md', '# Mission\n');
      f.artifact('work.plan.md', '# Work\n');
      await appendRecord(f.session, {kind: 'bind', key: 'commit-inputs', by: 'orchestrator', data: {spec: 'mission.spec.md', plan: 'work.plan.md'}}, f.deps);
      await appendRecord(f.session, {kind:'integrate',by:'tool',data:{phase:'opened',path:'.state/worktrees/integration',branch:'dispatch/test/integration',base:'b'.repeat(40),dest:{path:f.root,branch:'main'}}}, f.deps);
      const reviewFix = {review:'code-integration',round:3,generation:1,findings:['R3-F001','R3-F002','R3-F003','R3-F004','R3-F005','R3-F006'],from:'b'.repeat(40)};
      const file = path.join(f.root, 'review-fix.json');
      fs.writeFileSync(file, JSON.stringify(reviewFix));
      let head = 'a'.repeat(40), message = '';
      f.deps.run = async (argv) => {
        const args = argv.slice(1);
        if (args.join(' ') === 'rev-parse HEAD') return {exit:0,stdout:head,stderr:''};
        if (args[0] === 'diff') return {exit:0,stdout:'src/a.ts\0',stderr:''};
        if (args[0] === 'ls-files' || args[0] === 'add') return {exit:0,stdout:'',stderr:''};
        if (args[0] === 'commit') {
          message = args.filter((_, index) => args[index - 1] === '-m').join('\n\n');
          head = 'c'.repeat(40);
          return {exit:0,stdout:'',stderr:''};
        }
        throw Error('Unexpected Git call: ' + JSON.stringify(argv));
      };
      assert.equal(await main(['worktree','commit','--reason',reason,'--review-fix',file,'--session',f.session],f.deps),0);
      const lines = message.split('\n');
      assert.deepEqual(lines.filter(line => line.length > 100), []);
      assert.ok(lines.filter(line => line.startsWith('Dispatch-Review-Fix-Data: ')).length > 1);
      assert.deepEqual(reviewFixFromCommit(message), reviewFix);
      assert.deepEqual(foldLedger(f.session).records.find(row => row.data['phase'] === 'fix')?.data['reviewFix'], reviewFix);
    } finally { f.cleanup(); }
  });
  test('usage errors print one line without a result path', async () => {
    const f = sessionFixture({memory:true});
    try {
      for (const args of [['unknown', 'run'], ['lint', 'unknown'], ['lint', 'run'], ['lint', 'run', '--session', f.root]]) {
        f.lines.length = 0;
        assert.equal(await main(args, f.deps), 1);
        assert.equal(f.output().path, null);
        assert.ok(f.lines[0]!.endsWith('\n'));
      }
      fs.writeFileSync(path.join(f.session, 'manifest.json'), '{');
      f.lines.length = 0;
      assert.equal(await main(['lint', 'run', '--session', f.session], f.deps), 1);
      assert.equal(f.output().path, null);
    } finally { f.cleanup(); }
  });
  test('handlers persist success refusals and unexpected faults', async () => {
    const f = sessionFixture({memory:true});
    try {
      for (const [reason, exit] of [['invalid-input', 1], ['fault', 2], ['lock-held', 3], ['lint-errors', 4]] as const) {
        f.lines.length = 0;
        assert.equal(await main(['lint', 'run', '--session', f.session], { ...f.deps, handler: async () => { throw new ToolError(exit, reason, 'input field rejected'); } }), exit);
        const out = f.output();
        assert.equal(out.reason, reason);
        assert.ok(out.path?.startsWith(path.join(f.session, '.state', 'results')));
        assert.match(fs.readFileSync(out.path!, 'utf8'), /input field/);
      }
      for (const fail of [false, true]) {
        f.lines.length = 0;
        assert.equal(await main(['lint', 'run', '--session', f.session], { ...f.deps, handler: async () => {
          if (fail) throw new Error('broken handler');
          return { ok: true, summary: 'done', value: { answer: 42 }, exit: 0 };
        } }), fail ? 2 : 0);
        assert.ok(fs.existsSync(f.output().path!));
        assert.equal(f.output().ok, !fail);
      }
    } finally { f.cleanup(); }
  });
  test('output write failure reports fault without a path', async () => {
    const f = sessionFixture({memory:true});
    try {
      assert.equal(await main(['lint', 'run', '--session', f.session], { ...f.deps,
        handler: async () => ({ ok: true, summary: 'done', value: {}, exit: 0 }),
        writeResult: () => { throw new Error('disk full'); },
      }), 2);
      assert.equal(f.output().reason, 'fault');
      assert.equal(f.output().path, null);
    } finally { f.cleanup(); }
  });
  test('native-failed refuses malformed input and non-review tools', async () => {
    const f = sessionFixture({memory:true});
    try {
      const q = f.artifact('q.md', 'why');
      for (const args of [
        ['ask', 'run', q, '--session', f.session, '--host', 'codex', '--native-failed', 'no-equals'],
        ['review', 'run', 'worktree', '--session', f.session, '--host', 'codex', '--native-failed', '=reason'],
        ['review', 'run', 'worktree', '--session', f.session, '--host', 'codex', '--native-failed', 'a#1='],
      ]) {
        f.lines.length = 0;
        assert.equal(await main(args, f.deps), 1);
        assert.equal(f.output().reason, 'invalid-input');
      }
      f.lines.length = 0;
      assert.equal(await main(['status', 'show', '--session', f.session, '--native-failed', 'a#1=nope'], f.deps), 1);
      assert.equal(f.output().reason, 'invalid-input');
    } finally { f.cleanup(); }
  });
  test('pins flag is accepted on ask run and review run and rejected on other actions', async () => {
    const f = sessionFixture({memory:true});
    try {
      const q = f.artifact('q.md', 'why');
      for (const action of [['ask', 'run', q], ['review', 'run', 'worktree']]) {
        f.lines.length = 0;
        let seenPins: unknown;
        const exit = await main([...action, '--session', f.session, '--host', 'codex', '--pins', '(all)'], {
          ...f.deps,
          handler: async (ctx) => { seenPins = ctx.values['pins']; return { ok: true, summary: 'ok', value: {}, exit: 0 }; },
        });
        assert.equal(exit, 0, action.join(' '));
        assert.equal(seenPins, '(all)', action.join(' '));
      }
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex', '--pins', '(all)'], f.deps), 1);
      assert.equal(f.output().reason, 'invalid-input');
    } finally { f.cleanup(); }
  });
  test('ledger append accepts bom record', async () => {
    const f = sessionFixture({memory:true});
    try {
      const file = f.artifact('bom-record.json', '\uFEFF' + JSON.stringify({kind:'note',key:'bom-note',by:'orchestrator',data:{text:'bom record'}}));
      assert.equal(await main(['ledger', 'append', '--session', f.session, file], f.deps), 0);
      assert.equal(f.output().ok, true);
      assert.deepEqual(foldLedger(f.session).records.filter(row=>row.key==='bom-note').map(row=>row.kind), ['note']);
    } finally { f.cleanup(); }
  });
});

test('lint run summary lists first defects with remaining count', async () => {
  const f = sessionFixture({memory:true});
  try {
    f.artifact('work.plan.context.md', '# Context map: work\n');
    const file = f.artifact('work.plan.md', '# Work\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n## Success Criteria\n');
    assert.equal(await main(['lint', 'run', file, '--session', f.session], f.deps), 4);
    assert.equal(f.output().reason, 'lint-errors');
    assert.match(f.output().summary, /^plan: 4 errors, 2 warnings; sha256:[0-9a-f]{64}; first 5: L- proposed-changes: .*; L4 task-map: .*; L- verification-plan: .*; L5 success-criteria: .*; L- missing-section: .*; \+1 more in result$/);
  } finally { f.cleanup(); }
});

test('host-sensitive actions refuse missing or unknown host without manifest change', async () => {
  const f = sessionFixture({memory:true});
  try {
    const q = f.artifact('q.md', 'why');
    const values = f.artifact('explorer.json', JSON.stringify({objective: 'Map.', questions: '- Q?', outputPath: 'out.md'}));
    const cleanupValues = f.artifact('cleanup.json', JSON.stringify({base: 'a'.repeat(40), integrationPath: 'integration'}));
    const cases: string[][] = [
      ['doctor', 'run'],
      ['review', 'run', q, '--kind', 'plan'],
      ['ask', 'run', q],
      ['brief', 'render', 'T1'],
      ['brief', 'explorer', values],
      ['brief', 'test-cleanup', cleanupValues],
      ['brief', 'verifier', values],
    ];
    for (const args of cases) {
      const before = fs.readFileSync(path.join(f.session, 'manifest.json'), 'utf8');
      f.lines.length = 0;
      assert.equal(await main([...args, '--session', f.session], f.deps), 1, args.join(' '));
      assert.equal(f.output().reason, 'usage', args.join(' '));
      assert.equal(fs.readFileSync(path.join(f.session, 'manifest.json'), 'utf8'), before, args.join(' '));
      f.lines.length = 0;
      assert.equal(await main([...args, '--session', f.session, '--host', 'unknown-x'], f.deps), 1, args.join(' '));
      assert.equal(f.output().reason, 'usage', args.join(' '));
      assert.equal(fs.readFileSync(path.join(f.session, 'manifest.json'), 'utf8'), before, args.join(' '));
    }
  } finally { f.cleanup(); }
});

test('host flag refused on other actions', async () => {
  const f = sessionFixture({memory:true});
  try {
    const before = fs.readFileSync(path.join(f.session, 'manifest.json'), 'utf8');
    for (const args of [
      ['status', 'show'],
      ['ledger', 'query'],
      ['check', 'run'],
      ['report', 'render'],
      ['diagnostics', 'render'],
      ['worktree', 'create', 'T1'],
    ]) {
      f.lines.length = 0;
      assert.equal(await main([...args, '--session', f.session, '--host', 'claude'], f.deps), 1, args.join(' '));
      assert.equal(f.output().reason, 'usage', args.join(' '));
      assert.equal(fs.readFileSync(path.join(f.session, 'manifest.json'), 'utf8'), before, args.join(' '));
    }
  } finally { f.cleanup(); }
});

test('host flag replaces recorded host and reroutes voices', async () => {
  const f = sessionFixture({memory:true});
  try {
    const manifestFile = path.join(f.session, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify({...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), host: 'claude'}));
    let seen: {manifestHost: unknown; orchestrator: unknown} | null = null;
    const deps = {...f.deps, handler: async (context: HandlerContext): Promise<HandlerResult> => {
      seen = {manifestHost: context.manifest.host, orchestrator: context.deps.orchestrator};
      return {ok: true, summary: 'done', value: {}, exit: 0};
    }};
    f.lines.length = 0;
    assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'opencode'], deps), 0);
    assert.equal(readManifest(f.session).host, 'opencode');
    assert.deepEqual((seen as unknown as {manifestHost: unknown}).manifestHost, 'opencode');
    assert.equal((seen as unknown as {orchestrator: {platform: string}}).orchestrator.platform, 'opencode');
    f.lines.length = 0;
    assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'github-copilot'], deps), 0);
    assert.equal(readManifest(f.session).host, 'copilot');
  } finally { f.cleanup(); }
});


test('an unreadable fanout record still counts as a native launch', async () => {
  const {generationLaunchedNative} = await import('../../../skills/dispatch/scripts/toolkit/review.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  try {
    const dir = path.join(root, 'round-1');
    fs.mkdirSync(path.join(dir, 'gen-1'), {recursive: true});
    assert.equal(generationLaunchedNative(dir, 1), false, 'a missing record means no native voice');
    fs.writeFileSync(path.join(dir, 'gen-1', 'fanout.json'), JSON.stringify({nativeLaunched: true}));
    assert.equal(generationLaunchedNative(dir, 1), true, 'a launched record stays launched');
    fs.writeFileSync(path.join(dir, 'gen-1', 'fanout.json'), 'torn json{{{');
    assert.equal(generationLaunchedNative(dir, 1), true, 'a torn record fails closed to launched');
    fs.rmSync(path.join(dir, 'gen-1', 'fanout.json'));
    fs.mkdirSync(path.join(dir, 'gen-1', 'fanout.json'));
    assert.equal(generationLaunchedNative(dir, 1), true, 'an unreadable record fails closed to launched');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('cli ledger append formats array summary and refreshes findings for new and deduplicated ruling batches', async () => {
  const f = sessionFixture({memory:true});
  const restoreAtomicWrite = useMemoryAtomicWrite();
  try {
    const spec = f.artifact('mission.spec.md', '# Mission\n## Intent & Problem\nKeep work recoverable.\n');
    const plan = f.artifact('work.plan.md', '# Work\n\n## Review Findings & Resolutions\nDriver note.\n');
    const relative = (file: string) => path.relative(f.root, file).split(path.sep).join('/');
    const append = async (name: string, record: unknown) => {
      const file = path.join(f.root, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(record));
      f.lines.length = 0;
      const exit = await main(['ledger', 'append', file, '--session', f.session], f.deps);
      const output = f.output();
      const value = exit === 0 ? JSON.parse(fs.readFileSync(output.path!, 'utf8')) as Record<string, unknown> : null;
      return {exit, output, value};
    };

    await append('bind', {kind:'bind', by:'orchestrator', key:'bind', data:{spec:relative(spec), plan:relative(plan)}});

    const review = 'plan-work.plan';
    const directory = path.join(f.session, '.state', 'reviews', review, 'round-1');
    fs.mkdirSync(directory, {recursive:true});
    fs.writeFileSync(path.join(directory, 'round.json'), JSON.stringify({round:1, generation:1, cap:2, roster:[]}));
    fs.writeFileSync(path.join(directory, 'findings.json'), JSON.stringify({review, round:1, findings:[
      {id:'R1-F001', severity:'SHOULD'}, {id:'R1-F002', severity:'SHOULD'},
    ]}));
    const rulings = [
      {kind:'ruling', by:'orchestrator', key:'ruling-F001', data:{subject:`review:${review}:R1-F001`, ruling:'accepted', rationale:'Fixed'}},
      {kind:'ruling', by:'orchestrator', key:'ruling-F002', data:{subject:`review:${review}:R1-F002`, ruling:'deferred', rationale:'Later'}},
    ];
    const first = await append('rulings', rulings);
    assert.equal(first.exit, 0);
    assert.equal(first.output.summary, '2 records (last seq 3)');
    assert.deepEqual({seq:first.value!['seq'], deduped:first.value!['deduped'], count:first.value!['count'], results:first.value!['results'], findingsSection:first.value!['findingsSection']}, {
      seq:3, deduped:false, count:2, results:[{seq:2,deduped:false},{seq:3,deduped:false}], findingsSection:'updated',
    });
    assert.match(fs.readFileSync(plan, 'utf8'), /Round 1 \(plan-work\.plan\): 2 findings/);

    const retried = await append('rulings', rulings);
    assert.equal(retried.output.summary, '2 records (last seq 3, all deduped)');
    assert.deepEqual({seq:retried.value!['seq'], deduped:retried.value!['deduped'], count:retried.value!['count'], results:retried.value!['results'], findingsSection:retried.value!['findingsSection']}, {
      seq:3, deduped:true, count:2, results:[{seq:2,deduped:true},{seq:3,deduped:true}], findingsSection:'unchanged',
    });

    const acceptedF002 = {kind:'ruling', by:'orchestrator', key:'ruling-F002-accepted', data:{subject:`review:${review}:R1-F002`, ruling:'accepted', rationale:'Now fixed'}};
    const mixed = await append('mixed', [rulings[0], acceptedF002]);
    assert.equal(mixed.output.summary, '2 records (last seq 4)');
    assert.deepEqual({seq:mixed.value!['seq'], deduped:mixed.value!['deduped'], count:mixed.value!['count'], results:mixed.value!['results'], findingsSection:mixed.value!['findingsSection']}, {
      seq:4, deduped:false, count:2, results:[{seq:2,deduped:true},{seq:4,deduped:false}], findingsSection:'updated',
    }, JSON.stringify(mixed.value));
    assert.match(fs.readFileSync(plan, 'utf8'), /F002 \| 1 \| SHOULD \|[^|]*\| Accepted \|/);

    const single = await append('single', {kind:'note', by:'orchestrator', key:'single-note', data:{text:'single'}});
    assert.equal(single.output.summary, 'seq 5 appended');
    assert.deepEqual({seq:single.value!['seq'], deduped:single.value!['deduped']}, {seq:5, deduped:false});
    assert.equal('findingsSection' in single.value!, false);
    const singleRetry = await append('single', {kind:'note', by:'orchestrator', key:'single-note', data:{text:'single'}});
    assert.equal(singleRetry.output.summary, 'seq 5 deduped');
    assert.deepEqual({seq:singleRetry.value!['seq'], deduped:singleRetry.value!['deduped']}, {seq:5, deduped:true});
  } finally {restoreAtomicWrite(); f.cleanup();}
});

// SECTION: refusal pointer
test('the retired brief action returns unknown action', async () => {
  const f = sessionFixture({memory:true});
  try {
    let dispatched = false;
    const exit = await main(['brief', ['fix', 'check'].join('-'), 'work.plan.md', '--session', f.session, '--host', 'claude'], {
      ...f.deps,
      handler: async () => {
        dispatched = true;
        return {ok: true, summary: 'dispatched', value: {}, exit: 0};
      },
    });
    assert.equal(exit, 1);
    assert.equal(f.output().reason, 'usage');
    assert.equal(f.output().summary, 'Unknown tool or action');
    assert.equal((f.output() as {help?: string}).help, 'call table');
    assert.equal(dispatched, false);
  } finally { f.cleanup(); }
});

test('refusal names the section for a resolved action and the call table otherwise', async () => {
  const f = sessionFixture({memory:true});
  const help = () => (f.output() as {help?: string}).help;
  const run = async (args: string[], mutate: (deps: typeof f.deps) => void = () => {}) => {
    f.lines.length = 0;
    const deps = {...f.deps};
    mutate(deps);
    return main(args, deps);
  };
  try {
    // Unresolved action and parse failure on a valid action.
    assert.equal(await run(['bogus', 'action', '--session', f.session]), 1);
    assert.equal(help(), 'call table');
    assert.equal(await run(['--session', f.session]), 1);
    assert.equal(help(), 'call table');
    assert.equal(await run(['status', 'show', '--unknown-flag', '--session', f.session]), 1);
    assert.equal(help(), 'status show');
    // Handler fault and result-write fault.
    assert.equal(await run(['status', 'show', '--session', f.session], deps => { deps.handler = async () => { throw new Error('boom'); }; }), 2);
    assert.equal(help(), 'status show');
    assert.equal(await run(['status', 'show', '--session', f.session], deps => { deps.writeResult = () => { throw new Error('disk'); }; }), 2);
    assert.equal(help(), 'status show');
    // Gate refusal.
    const file = f.artifact('bad.plan.md', '# Work\n');
    assert.equal(await run(['lint', 'run', file, '--session', f.session]), 4);
    assert.equal(f.output().reason, 'lint-errors');
    assert.equal(help(), 'lint run');
    // native-pending and ok:true carry no pointer.
    assert.equal(await run(['status', 'show', '--session', f.session], deps => { deps.handler = async () => ({ok: false, value: {}, summary: 'pending', exit: 4, reason: 'native-pending'}); }), 4);
    assert.equal('help' in f.output(), false);
    assert.equal(await run(['status', 'show', '--session', f.session], deps => { deps.handler = async () => ({ok: true, value: {}, summary: 'fine', exit: 0}); }), 0);
    assert.equal('help' in f.output(), false);
  } finally { f.cleanup(); }
});

test('check run is registered, accepts --task, and verify run is unknown', async () => {
  const f = sessionFixture({memory:true});
  try {
    let seenTask: unknown;
    const exit = await main(['check', 'run', '--session', f.session, '--task', 'T1'], {
      ...f.deps,
      handler: async (ctx) => { seenTask = ctx.values['task']; return {ok: true, summary: 'ok', value: {}, exit: 0}; },
    });
    assert.equal(exit, 0);
    assert.equal(seenTask, 'T1');
    f.lines.length = 0;
    assert.equal(await main(['status', 'show', '--session', f.session, '--task', 'T1'], f.deps), 1);
    assert.equal(f.output().reason, 'invalid-input');
    f.lines.length = 0;
    assert.equal(await main(['verify', 'run', '--session', f.session], f.deps), 1);
    assert.equal(f.output().reason, 'usage');
  } finally { f.cleanup(); }
});

test('rejects --reuse and --fresh outside check run or combined', async () => {
  const f = sessionFixture({ memory: true });
  try {
    for (const flag of ['--reuse', '--fresh']) {
      for (const argv of [
        ['status', 'show', flag, '--session', f.session],
        ['doctor', 'run', flag, '--host', 'opencode', '--session', f.session],
      ]) {
        f.lines.length = 0;
        assert.equal(await main(argv, f.deps), 1, argv.join(' '));
        assert.equal(f.output().reason, 'invalid-input', argv.join(' '));
      }

      let seenFlag: unknown;
      f.lines.length = 0;
      const exit = await main(['check', 'run', flag, '--session', f.session], {
        ...f.deps,
        handler: async (ctx) => {
          seenFlag = ctx.values[flag.slice(2)];
          return { ok: true, summary: 'ok', value: {}, exit: 0 };
        },
      });
      assert.equal(exit, 0, flag);
      assert.equal(seenFlag, true, flag);
    }

    f.lines.length = 0;
    assert.equal(await main(['check', 'run', '--reuse', '--fresh', '--session', f.session], f.deps), 1);
    assert.equal(f.output().reason, 'invalid-input');
  } finally { f.cleanup(); }
});
test('rejects --probe outside doctor run and surfaces probe-failed on doctor run --probe', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skillRoot = path.join(f.root, 'probe-skill');
    fs.mkdirSync(skillRoot);
    fs.writeFileSync(path.join(skillRoot, 'config.jsonc'), JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': { codex: { low: { model: 'writer' } } },
      'utility-subagents': { codex: { model: 'reader', 'context-limit': 300000 } },
    }));
    const calls: string[] = [];
    const deps = { ...f.deps, skillRoot, probe: {
      discovery: { resolve: () => ({ status: 'path' as const, path: 'codex' }), doctor: () => [], probes: 0 },
      spawn: async (binary: string) => {
        calls.push(binary);
        return { exit: 1, stdout: 'untrusted subprocess text', stderr: '' };
      },
    } };
    assert.equal(await main(['status', 'show', '--session', f.session, '--probe'], deps), 1);
    assert.equal(f.output().reason, 'invalid-input');
    assert.match(f.output().summary, /--probe is only for doctor run/);
    assert.deepEqual(calls, []);

    f.lines.length = 0;
    assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex', '--level', 'low', '--probe'], deps), 0);
    const output = f.output();
    assert.deepEqual([output.ok, output.reason, calls], [false, 'probe-failed', ['codex']]);
    const reportText = fs.readFileSync(output.path!, 'utf8');
    const report = JSON.parse(reportText);
    assert.deepEqual([report.level, report.reason, report.probes[0].failureCategory], ['low', 'probe-failed', 'probe-error']);
    assert.equal(reportText.includes('untrusted subprocess text'), false);
  } finally { f.cleanup(); }
});

test('cleanup checkpoint flags are scoped to ledger append', async () => {
  const f = sessionFixture({memory: true});
  try {
    assert.equal(await main(['ledger', 'append', '-', '--cleanup', 'skip', '--session', f.session], {...f.deps, readStdin: () => '{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'}), 4);
    assert.equal(await main(['status', 'show', '--cleanup', 'skip', '--session', f.session], f.deps), 1);
    assert.equal(await main(['ledger', 'append', '-', '--resume', '--session', f.session], f.deps), 1);
    assert.equal(await main(['ledger', 'append', 'receipt.json', '--cleanup', 'skip', '--session', f.session], f.deps), 1);
    const note = {kind: 'note', by: 'tool', key: 'test-cleanup:skip:1:' + 'a'.repeat(40), data: {text: 'handwritten'}};
    const append = (key: string) => main(['ledger', 'append', '-', '--session', f.session],
      {...f.deps, readStdin: () => JSON.stringify({...note, key})});
    assert.equal(await append(note.key), 1);
    assert.equal(await append('test-cleanup:skip'), 0);
  } finally { f.cleanup(); }
});

test('accepts optional correlation on review runs only', async () => {
  const f = sessionFixture({memory: true});
  try {
    const ref = '01234567-89ab-4def-8123-0123456789ab';
    assert.equal(await main(['status', 'show', '--resume-ref', ref, '--session', f.session], f.deps), 1);
    assert.match(f.output().summary, /--resume-ref is only for review run/);
    const seen: unknown[] = [];
    const deps = {...f.deps, handler: async (ctx: HandlerContext) => {
      seen.push(ctx.values['resume-ref']);
      return {ok: true, exit: 0, summary: 'ok', value: {}};
    }};
    const review = ['review', 'run', 'integration', '--host', 'codex', '--session', f.session];
    assert.equal(await main(review, deps), 0);
    assert.equal(await main([...review, '--resume-ref', ref], deps), 0);
    assert.deepEqual(seen, [undefined, ref]);
  } finally { f.cleanup(); }
});
