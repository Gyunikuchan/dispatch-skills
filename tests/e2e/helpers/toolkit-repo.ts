import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { main, nodeDeps, type CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
export const planSource = ['# Work', '', '## Task Map', '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |', '| T1 | File | Works | none | SC1 |', '', '## Proposed Changes', '### T1 — File', '#### [MODIFY] src/file.ts', '- Purpose: implements behavior.', '', '## Success Criteria', '- [SC1] File works', '  - Changes: src/file.ts', '  - Verify: `node -e "process.exit(0)"`', '  - Evidence: verify', '', '## Verification Plan', '### Automated Tests', '- `node -e "process.stdout.write(\'contract\')"`', ''].join('\n');
export async function toolkitRepo(source = planSource, files: Record<string,string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'toolkit-git-'));
  const session = path.join(root, '20261023T0000Z-test');
  const git = (args: string[], cwd = root) => { const r = spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
  git(['init','-b','main']); git(['config','user.email','test@example.test']); git(['config','user.name','Toolkit Test']);
  git(['config','core.autocrlf','false']);
  fs.mkdirSync(path.join(root,'src')); fs.writeFileSync(path.join(root,'src/file.ts'),'initial\n'); fs.writeFileSync(path.join(root,'.gitignore'),'20261023T0000Z-test/\nignored\n');
  fs.writeFileSync(path.join(root,'work.plan.md'),source); fs.writeFileSync(path.join(root,'work.spec.md'),'# Spec\n## Requirements\n### REQ-1 — Work\n- Acceptance: works\n');
  for(const [file,text] of Object.entries(files)) {fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true}); fs.writeFileSync(path.join(root,file),text);}
  git(['add','.']); git(['commit','-m','base']);
  fs.mkdirSync(session);
  fs.writeFileSync(path.join(session,'manifest.json'),JSON.stringify({schemaVersion:1,folderName:path.basename(session),sessionId:'test',safeSessionId:'test',repositoryRoot:root}));
  const deps = nodeDeps();
  await appendRecord(session,{kind:'bind',by:'orchestrator',key:'bind',data:{spec:'work.spec.md',plan:'work.plan.md'}},deps);
  const approve = async () => appendRecord(session,{kind:'approval',by:'user',quote:'approved',key:'approval:' + foldLedger(session).lastSeq,data:currentHashes(root,latest(foldLedger(session),'bind'))},deps);
  const level = async (value='low') => appendRecord(session,{kind:'level',by:'orchestrator',key:'level:' + foldLedger(session).lastSeq,data:{level:value}},deps);
  const edit = async (data: object) => appendRecord(session,{kind:'edit',by:'orchestrator',key:'edit:' + foldLedger(session).lastSeq,data},deps);
  const run = async (args: string[], hook?: CliDeps['hook']) => { const lines: string[]=[]; const exit=await main([...args,'--session',session],{...deps,stdout:line=>lines.push(line),...(hook ? {hook} : {})}); assert.equal(lines.length,1); const output=JSON.parse(lines[0]!); assert.ok(Buffer.byteLength(output.summary)<=1024); return {exit,output,value: output.path ? JSON.parse(fs.readFileSync(output.path,'utf8')) : null}; };
  const spawned = (args: string[]) => spawnSync(process.execPath,[path.resolve('skills/dispatch/scripts/toolkit/cli.ts'),...args,'--session',session],{encoding:'utf8',windowsHide:true});
  const concurrent = (args: string[]) => new Promise<{exit:number; output:any; value:any}>((resolve,reject)=>{
    const child=spawn(process.execPath,[path.resolve('skills/dispatch/scripts/toolkit/cli.ts'),...args,'--session',session],{windowsHide:true});
    let stdout=''; let stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b); child.on('error',reject);
    child.on('close',exit=>{try {const lines=stdout.trim().split(/\r?\n/); assert.equal(lines.length,1,stderr); const output=JSON.parse(lines[0]!); assert.ok(Buffer.byteLength(output.summary)<=1024); resolve({exit:exit??1,output,value:JSON.parse(fs.readFileSync(output.path,'utf8'))});} catch(error){reject(error);}});
  });
  return {root,session,deps,git,run,spawned,concurrent,approve,level,edit, integration:path.join(session,'.state/worktrees/integration'), cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
