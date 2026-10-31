import { nativeOpencodeIntrospection } from '../../../skills/dispatch/scripts/providers/opencode-runtime.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { nodeProcess } from '../../../skills/dispatch/scripts/providers/node-process.ts';
import type { DelegateRequest, ProcessResult } from '../../../skills/dispatch/scripts/providers/types.ts';
import { main, nodeDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { ToolError } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { reviewFixIdentity } from '../../../skills/dispatch/scripts/toolkit/integrate.ts';

describe('toolkit CLI contract', () => {
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


test('OpenCode preparation classifies bounded lifecycle failures through the native delegate caller', async (t) => {
  const request: DelegateRequest = {promptPath:'/prompt',model:null,effort:null,sandbox:false,schemaPath:null,resume:null,cwd:process.cwd(),timeoutMs:60000,agent:null,outputCapBytes:1000,attachments:[],logPath:'/unused',briefPath:'/unused'};
  const result = (stderrTail = '', stdout = '[]'): ProcessResult => ({exit:stderrTail?2:0,signal:null,stdout,stdoutPath:'/unused',stderrTail,durationMs:0,timedOut:false,truncated:false});
  for (const scenario of ['child-unconfirmed','killer-unconfirmed','timeout','unsupported','permission','invalid-json','group-unconfirmed','spawn-failure'] as const) {
    await t.test(scenario, {skip:scenario==='killer-unconfirmed'&&process.platform!=='win32'}, async (t) => {
      t.mock.timers.enable();
      if(scenario==='group-unconfirmed'){const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{...descriptor,value:'linux'});t.after(()=>Object.defineProperty(process,'platform',descriptor));}
      t.mock.method(fs,'existsSync',()=>true);
      t.mock.method(fs,'statSync',()=>({isFile:()=>true,mode:0o755}));
      t.mock.method(fs,'readdirSync',()=>[]);
      t.mock.method(fs,'unlinkSync',()=>{});
      let settle: (value: ProcessResult)=>void = ()=>{};
      const childDone = new Promise<ProcessResult>(resolve=>{settle=resolve;});
      const launches: string[][] = [];
      t.mock.method(nodeProcess,'start',(launch:{argv:string[]})=>{
        launches.push(launch.argv);
        if (launch.argv[0]==='taskkill') {
          if(scenario==='killer-unconfirmed') {settle(result());return {pid:2,done:new Promise(()=>{})};}
          if(scenario==='timeout') settle(result('terminated'));
          return {pid:2,done:Promise.resolve(result())};
        }
        return {pid:scenario==='spawn-failure'?-1:50,done:scenario==='unsupported'?Promise.resolve(result('Unrecognized flag: --standalone in command opencode debug config')):scenario==='permission'?Promise.resolve(result('permission denied')):scenario==='group-unconfirmed'?Promise.resolve(result()):scenario==='invalid-json'?Promise.resolve(result('', 'credential-must-not-leak')):childDone};
      });
      t.mock.method(nodeProcess as Required<typeof nodeProcess>,'settleGroup',async()=>scenario!=='group-unconfirmed');
      let signals=0;
      t.mock.method(nodeProcess,'signal',()=>{signals++;if(scenario==='timeout')settle(result('terminated'));});
      const pending = nodeDeps().delegate('opencode',request,'cli');
      const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
      await flush();
      if(['child-unconfirmed','killer-unconfirmed','timeout','spawn-failure'].includes(scenario)) {
        t.mock.timers.tick(5000); await flush();
        if(scenario==='spawn-failure')settle(result('spawn opencode ENOENT'));
        else {t.mock.timers.tick(1000); await flush();}
      }
      let settled = false;
      void pending.then(()=>{settled=true;}); await flush();
      assert.equal(settled,true,'inspection must settle at the per-command deadline plus grace');
      const run = await pending;
      assert.equal(run.outcome.status,'fail');
      if(run.outcome.status!=='fail')return;
      assert.equal(run.outcome.cls,['child-unconfirmed','killer-unconfirmed','timeout','group-unconfirmed'].includes(scenario)?'timeout':'config',run.outcome.detail);
      assert.doesNotMatch(run.outcome.detail,/credential-must-not-leak/);
      if(run.outcome.cls==='timeout')assert.match(run.outcome.detail,/effective-config-unverified: opencode-lifecycle-timeout/);
      assert.equal(run.invocations[0]?.launched,false);
      assert.equal(launches.filter(argv=>argv[0]!=='taskkill').length,1);
      assert.deepEqual(launches[0]?.slice(-3),['--standalone','debug','config']);
      if(scenario==='spawn-failure') {
        assert.equal(signals,0);
        assert.equal(launches.some(argv=>argv[0]==='taskkill'),false);
      }
    });
  }
});



test('OpenCode inspection preserves an in-budget result when confirmed group settlement uses its grace',async(t)=>{
  t.mock.timers.enable();
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
  Object.defineProperty(process,'platform',{...descriptor,value:'linux'});
  t.after(()=>Object.defineProperty(process,'platform',descriptor));
  t.mock.method(fs,'unlinkSync',()=>{});
  const request={cwd:process.cwd(),logPath:'/unused'} as DelegateRequest;
  for(const scenario of ['success','nonzero','truncated'] as const){
    let finish!:(result:ProcessResult)=>void;let confirm!:(value:boolean)=>void;
    t.mock.method(nodeProcess,'start',()=>({pid:50,done:new Promise<ProcessResult>(resolve=>{finish=resolve;})}));
    t.mock.method(nodeProcess as Required<typeof nodeProcess>,'settleGroup',()=>new Promise<boolean>(resolve=>{confirm=resolve;}));
    const pending=nativeOpencodeIntrospection('opencode',request,{},100)('config');
    const checked=pending.then(value=>({value,error:null}),error=>({value:null,error:String(error)}));
    t.mock.timers.tick(90);
    finish({exit:scenario==='nonzero'?7:0,signal:null,stdout:'[]',stdoutPath:'/unused',stderrTail:'',durationMs:90,timedOut:false,truncated:scenario==='truncated'});
    for(let i=0;i<8;i++)await Promise.resolve();
    t.mock.timers.tick(100);confirm(true);
    const result=await checked;
    if(scenario==='success')assert.deepEqual(result,{value:[],error:null});
    else assert.match(result.error??'',/effective-config-unverified: native introspection failed/);
  }
});
