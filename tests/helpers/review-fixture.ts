import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { main, type CliDeps } from '../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord } from '../../skills/dispatch/scripts/toolkit/ledger.ts';
import { artifactHash } from '../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { memoryNodeFs } from './memory-node-fs.ts';

export const CLEAN = JSON.stringify({status:'CLEAN',findings:[]});
export const report = (locus = '§ Work', defect = 'Concurrent writes overwrite captured results', severity = 'SHOULD') => JSON.stringify({status:'FINDINGS',findings:[{severity,tag:'reliability',locus,defect,requiredChange:'Keep writes isolated until finalization'}]});
export const CONTEXT_MAP='# Context map: work\n\n> **Commit:** abc123\n>\n> **Tool:** text\n\n## Map\n- Work — `work.plan.md:1`\n';
const templates=['review-prompt.md','review-prompt-plan.md','review-prompt-design.md','review-prompt-code.md','quality-bar.md'].map(file=>[file,fs.readFileSync(path.resolve('skills/dispatch/references/templates',file),'utf8')] as const);
export async function fixture(bound=true, confirmed=true) {
  // A shallow virtual root avoids physical ancestor probes in quota-path validation.
  const root=path.join(path.parse(os.tmpdir()).root,'review-'+crypto.randomUUID());
  const cleanup=memoryNodeFs(root);
  const session=path.join(root,'.scratch/dispatch-skills/20261023T0000Z-test');
  fs.mkdirSync(session,{recursive:true});
  fs.writeFileSync(path.join(session,'manifest.json'),JSON.stringify({schemaVersion:1,folderName:path.basename(session),sessionId:'test',safeSessionId:'test',repositoryRoot:fs.realpathSync(root)}));
  const lines:string[]=[], launches:{provider:Parameters<CliDeps['delegate']>[0];request:Parameters<CliDeps['delegate']>[1];mode:Parameters<CliDeps['delegate']>[2]}[]=[];
  const deps:CliDeps={
    run:async()=>{throw new Error('Unit tests must not spawn processes');},
    delegate:async()=>{throw new Error('Unscripted delegate');},
    modes:()=>['cli'],orchestrator:null,liveness:{claude:true,agy:true,codex:true,copilot:true,opencode:true},
    stdout:line=>lines.push(line),env:{},clock:()=>0,sleep:async()=>{},pid:42,host:'test-host',isAlive:()=>false,skillRoot:path.resolve('skills/dispatch'),
  };
  const f={root,session,lines,launches,deps,cleanup,
    artifact:(name:string,source:string)=>{const file=path.join(root,name);fs.writeFileSync(file,source);return file;},
    output:()=>{assert.equal(lines.length,1);return JSON.parse(lines[0]!) as {ok:boolean;summary:string;path:string|null;reason?:string};},
  };
  const skill=path.join(f.root,'skill');
  fs.mkdirSync(path.join(skill,'references/templates'),{recursive:true});
  for(const [file,source] of templates)fs.writeFileSync(path.join(skill,'references/templates',file),source);
  f.deps.skillRoot=skill;
  const config=(native=false)=>fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({
    'read-delegates':native?{codex:{nativeSubagentsOnly:true,targets:[{low:{model:'native'}}]}}:{claude:{targets:[{low:{model:'fake'}}]},agy:{targets:[{low:{model:'fake'}}]}},
    phases:{'plan-review':{targets:{low:0,medium:2},rounds:{low:0,medium:2}},'code-review':{targets:{low:2},rounds:{low:2}}},
  }));config();
  const spec=f.artifact('mission.spec.md','# Mission\n## Intent & Problem\nKeep captured work recoverable.\n## Requirements\n### REQ-1 — Works\n');
  const plan=f.artifact('work.plan.md','# Work\n## Work\nOriginal body.\n## Review Findings & Resolutions\nDriver log.\n');
  f.artifact('work.context.md',CONTEXT_MAP);
  let key=0;
  const add=(kind:string,data:object)=>appendRecord(f.session,{kind,by:'orchestrator',key:'input-'+key++,data},f.deps);
  if(bound) await add('bind',{spec:'mission.spec.md',plan:'work.plan.md'});
  const confirm=(specPath=spec)=>appendRecord(f.session,{kind:'confirm',by:'user',quote:'Approved',key:'confirm:'+key++,data:{spec:artifactHash('spec',fs.readFileSync(specPath,'utf8'))}},f.deps);
  if(confirmed) await confirm();
  f.deps.delegate=async(provider,request,mode)=>{
    f.launches.push({provider,request,mode});
    return {outcome:{status:'ok',text:report(),resume:null,sessionId:null},invocations:[]};
  };
  const call=async(kind='plan',target=plan,level='medium')=>{
    f.lines.length=0;
    const exit=await main(['review','run',target,'--kind',kind,'--level',level,'--session',f.session],f.deps);
    const output=f.output();
    return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};
  };
  const directory=path.join(f.session,'.state/reviews/plan-work.plan');
  const read=(round:number,file:string)=>JSON.parse(fs.readFileSync(path.join(directory,'round-'+round,file),'utf8'));
  return {...f,spec,plan,add,call,confirm,directory,read,config};
}
