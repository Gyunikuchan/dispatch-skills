import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { main, nodeDeps, type CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
export const planSource = ['# Work', '', '## Task Map', '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |', '| T1 | File | Works | none | SC1 |', '', '## Proposed Changes', '### T1 — File', '#### [MODIFY] src/file.ts', '- Purpose: implements behavior.', '', '## Success Criteria', '- [SC1] File works', '  - Changes: src/file.ts', '  - Verify: `node -e "process.exit(0)"`', '  - Evidence: verify', '', '## Verification Plan', '### Automated Tests', '- `node -e "process.stdout.write(\'contract\')"`', ''].join('\n');

let baseTemplate: string | null = null;
function getBaseTemplate(): string {
  if (!baseTemplate) {
    baseTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-template-'));
    process.on('exit', () => { try { fs.rmSync(baseTemplate!, { recursive: true, force: true }); } catch {} });
    const git = (args: string[]) => { const r = spawnSync('git', args, { cwd: baseTemplate!, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    git(['init', '-b', 'main']);
    fs.appendFileSync(path.join(baseTemplate, '.git/config'), '\n[core]\n\tautocrlf = false\n[user]\n\tname = Toolkit Test\n\temail = test@example.test\n');
    fs.mkdirSync(path.join(baseTemplate, 'src'));
    fs.writeFileSync(path.join(baseTemplate, 'src/file.ts'), 'initial\n');
    fs.writeFileSync(path.join(baseTemplate, '.gitignore'), '20261023T0000Z-test/\nignored\n');
    fs.writeFileSync(path.join(baseTemplate, 'work.plan.md'), planSource);
    fs.writeFileSync(path.join(baseTemplate, 'work.spec.md'), '# Spec\n## Requirements\n### REQ-1 — Work\n- Acceptance: works\n');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
  }
  return baseTemplate;
}

export const transientTarget='tests/step.transient.test.ts';
export const transientPlanSource=planSource.replace('#### [MODIFY] src/file.ts','#### [NEW] '+transientTarget).replace('  - Changes: src/file.ts','  - Changes: '+transientTarget+'\n  - Tests: '+transientTarget+'\n  - Retain: transient\n  - Covered by: FINAL').replace('  - Evidence: verify','  - Verify: `node -e "process.exit(0)"` [FINAL]\n  - Evidence: verify');

let transientTemplate: string | null = null;
function getTransientTemplate(): string {
  if (!transientTemplate) {
    transientTemplate = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-transient-template-'));
    process.on('exit', () => { try { fs.rmSync(transientTemplate!, { recursive: true, force: true }); } catch {} });
    fs.cpSync(getBaseTemplate(), transientTemplate, { recursive: true });
    fs.writeFileSync(path.join(transientTemplate, 'work.plan.md'), transientPlanSource);
    const git = (args: string[]) => { const r = spawnSync('git', args, { cwd: transientTemplate!, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    git(['add', '.']);
    git(['commit', '--amend', '-m', 'base']);
  }
  return transientTemplate;
}

export async function toolkitRepo(source = planSource, files: Record<string,string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'toolkit-git-'));
  const session = path.join(root, '20261023T0000Z-test');
  const git = (args: string[], cwd = root) => { const r = spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
  if (source === transientPlanSource && Object.keys(files).length === 0) {
    fs.cpSync(getTransientTemplate(), root, { recursive: true });
  } else {
    fs.cpSync(getBaseTemplate(), root, { recursive: true });
    if (source !== planSource || Object.keys(files).length > 0) {
      if (source !== planSource) fs.writeFileSync(path.join(root, 'work.plan.md'), source);
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
      }
      git(['add', '.']);
      git(['commit', '--amend', '-m', 'base']);
    }
  }
  fs.mkdirSync(session);
  fs.writeFileSync(path.join(session,'manifest.json'),JSON.stringify({schemaVersion:1,folderName:path.basename(session),sessionId:'test',safeSessionId:'test',repositoryRoot:root}));
  const deps = nodeDeps();
  await appendRecord(session,{kind:'bind',by:'orchestrator',key:'bind',data:{spec:'work.spec.md',plan:'work.plan.md'}},deps);
  const approve = async () => appendRecord(session,{kind:'approval',by:'user',quote:'approved',key:'approval:' + foldLedger(session).lastSeq,data:currentHashes(root,latest(foldLedger(session),'bind'))},deps);
  const level = async (value='low') => appendRecord(session,{kind:'level',by:'orchestrator',key:'level:' + foldLedger(session).lastSeq,data:{level:value}},deps);
  const edit = async (data: object) => appendRecord(session,{kind:'edit',by:'orchestrator',key:'edit:' + foldLedger(session).lastSeq,data},deps);
  const run = async (args: string[], hook?: CliDeps['hook']) => { const lines: string[]=[]; const exit=await main([...args,'--session',session],{...deps,stdout:line=>lines.push(line),...(hook ? {hook} : {})}); assert.equal(lines.length,1); const output=JSON.parse(lines[0]!); assert.ok(Buffer.byteLength(output.summary)<=1024); return {exit,output,value: output.path ? JSON.parse(fs.readFileSync(output.path,'utf8')) : null}; };
  const spawned = (args: string[], entry = path.resolve('skills/dispatch/scripts/toolkit/cli.ts'), env?: NodeJS.ProcessEnv) => spawnSync(process.execPath,[entry,...args,'--session',session],{encoding:'utf8',windowsHide:true,env:env ?? process.env});
  const concurrent = (args: string[], entry = path.resolve('skills/dispatch/scripts/toolkit/cli.ts'), env?: NodeJS.ProcessEnv) => new Promise<{exit:number; output:any; value:any}>((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,...args,'--session',session],{windowsHide:true,env:env ?? process.env});
    let stdout=''; let stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b); child.on('error',reject);
    child.on('close',exit=>{try {const lines=stdout.trim().split(/\r?\n/); assert.equal(lines.length,1,stderr); const output=JSON.parse(lines[0]!); assert.ok(Buffer.byteLength(output.summary)<=1024); resolve({exit:exit??1,output,value:JSON.parse(fs.readFileSync(output.path,'utf8'))});} catch(error){reject(error);}});
  });
  return {root,session,deps,git,run,spawned,concurrent,approve,level,edit, integration:path.join(session,'.state/worktrees/integration'), cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

export async function transientRepo(source=transientPlanSource,writerFiles:Record<string,string>={}) {
 const r=await toolkitRepo(source); await r.level(); const made=await r.run(['worktree','create','T1']);
 assert.equal(made.output.ok,true,JSON.stringify(made));const writer=path.join(r.session,made.value.path);
 for(const [file,text] of Object.entries({[transientTarget]:'step\n',...writerFiles})){fs.mkdirSync(path.dirname(path.join(writer,file)),{recursive:true});fs.writeFileSync(path.join(writer,file),text);}
 assert.equal((await r.run(['worktree','submit','T1'])).exit,0);assert.equal((await r.run(['worktree','integrate','T1'])).exit,0);
 assert.equal((await r.run(['verify','run'])).output.ok,true);return r;
}
export function captureIntegrationReview(r:Awaited<ReturnType<typeof toolkitRepo>>,round=1,findings:Record<string,unknown>[]=[]){
 const dir=path.join(r.session,'.state/reviews/code-integration/round-'+round);fs.mkdirSync(path.join(dir,'gen-1/slots'),{recursive:true});
 const hashes=currentHashes(r.root,latest(foldLedger(r.session),'bind'));
 const base=foldLedger(r.session).records.find(x=>x.data['phase']==='opened')!.data['base'];
 fs.writeFileSync(path.join(dir,'round.json'),JSON.stringify({round,startSeq:foldLedger(r.session).lastSeq,generation:1,cap:3,roster:[{slot:'reviewer'},{slot:'unused-reserve',reserve:true}],scope:'Full review',artifacts:hashes,spec:{hash:hashes.spec},target:{base,head:r.git(['rev-parse','HEAD'],r.integration)}}));
 fs.writeFileSync(path.join(dir,'gen-1/slots/reviewer.json'),JSON.stringify({slot:'reviewer',state:'done',text:'{"status":"CLEAN","findings":[]}'}));
 fs.writeFileSync(path.join(dir,'findings.json'),JSON.stringify({review:'code-integration',round,failed:[],findings}));return dir;
}
