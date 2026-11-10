import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { main, nodeDeps, type CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { normalizeProvider } from '../../../skills/dispatch/scripts/policy/roster.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
export const planSource = ['# Work', '', '## Task Map', '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |', '| T1 | File | Works | none | SC1 |', '', '## Proposed Changes', '### T1 — File', '#### [MODIFY] src/file.ts', '- Purpose: implements behavior.', '', '## Success Criteria', '- [SC1] File works', '  - Changes: src/file.ts', '  - Verify: `node -e "process.exit(0)"`', '  - Evidence: verify', '', '## Verification Plan', '### Automated Tests', '- `node -e "process.stdout.write(\'contract\')"`', ''].join('\n');

// Plan and design lint require a sibling context map; Coverage stays empty so plan lint adds no coverage warnings.
export const contextMapSource = ['# Context map: work', '', '> **Commit:** 0000000', '>', '> **Tool:** text', '', '## Map', '', '## Coverage', ''].join('\n');

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
    fs.writeFileSync(path.join(baseTemplate, 'work.plan.context.md'), contextMapSource);
    fs.writeFileSync(path.join(baseTemplate, 'work.spec.md'), '# Spec\n## Requirements\n### REQ-1 — Work\n- Acceptance: works\n');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
  }
  return baseTemplate;
}

export async function toolkitRepo(source = planSource, files: Record<string,string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'toolkit-git-'));
  const session = path.join(root, '20261023T0000Z-test');
  const git = (args: string[], cwd = root) => { const r = spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
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
  fs.mkdirSync(session);
  fs.writeFileSync(path.join(session,'manifest.json'),JSON.stringify({schemaVersion:1,folderName:path.basename(session),sessionId:'test',safeSessionId:'test',repositoryRoot:root}));
  const deps = nodeDeps();
  // These tests stub `delegate`, so rosters must not depend on the host sandbox.
  delete deps.sandboxSupported;
  await appendRecord(session,{kind:'bind',by:'orchestrator',key:'bind',data:{spec:'work.spec.md',plan:'work.plan.md'}},deps);
  const bound=currentHashes(root,latest(foldLedger(session),'bind'));
  await appendRecord(session,{kind:'confirm',by:'user',quote:'confirmed',key:'confirm',data:{spec:bound.spec}},deps);
  const approve = async () => {
    const hashes=currentHashes(root,latest(foldLedger(session),'bind'));
    await appendRecord(session,{kind:'confirm',by:'user',quote:'confirmed',key:'confirm:' + foldLedger(session).lastSeq,data:{spec:hashes.spec}},deps);
    return appendRecord(session,{kind:'approval',by:'user',quote:'approved',key:'approval:' + foldLedger(session).lastSeq,data:hashes},deps);
  };
  const level = async (value='low') => appendRecord(session,{kind:'level',by:'orchestrator',key:'level:' + foldLedger(session).lastSeq,data:{level:value}},deps);
  const edit = async (data: object) => appendRecord(session,{kind:'edit',by:'orchestrator',key:'edit:' + foldLedger(session).lastSeq,data},deps);
  const HOST_SENSITIVE = new Set(['doctor run', 'review run', 'ask run', 'brief render', 'brief explorer', 'brief test-cleanup', 'brief verifier']);
  const withHost = (args: string[]) => {
    if (args.includes('--host')) return args;
    if (!HOST_SENSITIVE.has(args[0] + ' ' + args[1])) return args;
    const platform = (deps.orchestrator as {platform: string} | null)?.platform;
    let host: string;
    if (typeof platform === 'string' && platform) host = normalizeProvider(platform);
    else {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(deps.skillRoot, 'config.jsonc'), 'utf8')) as {['read-delegates']?: Record<string, unknown>};
        const present = new Set(Object.keys(config['read-delegates'] ?? {}).map(key => normalizeProvider(key)));
        host = ['opencode', 'claude', 'agy', 'copilot', 'codex'].find(candidate => !present.has(candidate)) ?? 'opencode';
      } catch { host = 'opencode'; }
    }
    return [...args, '--host', host];
  };
  const run = async (args: string[], hook?: CliDeps['hook'], seedVerification = true) => { if (seedVerification && args[0] === 'worktree' && args[1] === 'deliver') { const fold = foldLedger(session); const opened = fold.records.findLast(r => r.kind === 'integrate' && r.data['phase'] === 'opened'); if (opened && !fold.records.some(r => r.seq > opened.seq && r.kind === 'integrate' && r.data['phase'] === 'verification')) await appendRecord(session, {kind:'integrate',by:'orchestrator',data:{phase:'verification',cycle:1,outcome:'no-op',head:opened.data['base'],reason:'fixture',open:[]}}, deps); } const lines: string[]=[]; const exit=await main([...withHost(args),'--session',session],{...deps,stdout:line=>lines.push(line),...(hook ? {hook} : {})}); assert.equal(lines.length,1); const output=JSON.parse(lines[0]!); assert.ok(Buffer.byteLength(output.summary)<=1024); return {exit,output,value: output.path ? JSON.parse(fs.readFileSync(output.path,'utf8')) : null}; };
  const spawned = (args: string[], entry = path.resolve('skills/dispatch/scripts/toolkit/cli.ts'), env?: NodeJS.ProcessEnv) => spawnSync(process.execPath,[entry,...withHost(args),'--session',session],{encoding:'utf8',windowsHide:true,env:env ?? process.env});
  const concurrent = (args: string[], entry = path.resolve('skills/dispatch/scripts/toolkit/cli.ts'), env?: NodeJS.ProcessEnv) => new Promise<{exit:number; output:any; value:any}>((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,...withHost(args),'--session',session],{windowsHide:true,env:env ?? process.env});
    let stdout=''; let stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b); child.on('error',reject);
    child.on('close',exit=>{try {const lines=stdout.trim().split(/\r?\n/); assert.equal(lines.length,1,stderr); const output=JSON.parse(lines[0]!); assert.ok(Buffer.byteLength(output.summary)<=1024); resolve({exit:exit??1,output,value:JSON.parse(fs.readFileSync(output.path,'utf8'))});} catch(error){reject(error);}});
  });
  return {root,session,deps,git,run,spawned,concurrent,approve,level,edit, integration:path.join(session,'.state/worktrees/integration'), cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

export function captureIntegrationReview(r:Awaited<ReturnType<typeof toolkitRepo>>,round=1,findings:Record<string,unknown>[]=[]){
 const dir=path.join(r.session,'.state/reviews/code-integration/round-'+round);fs.mkdirSync(path.join(dir,'gen-1/slots'),{recursive:true});
 const hashes=currentHashes(r.root,latest(foldLedger(r.session),'bind'));
 const base=foldLedger(r.session).records.find(x=>x.data['phase']==='opened')!.data['base'];
 fs.writeFileSync(path.join(dir,'round.json'),JSON.stringify({round,startSeq:foldLedger(r.session).lastSeq,generation:1,cap:3,roster:[{slot:'reviewer'},{slot:'unused-reserve',reserve:true}],scope:'Full review',artifacts:hashes,spec:{path:path.join(r.root,'work.spec.md'),hash:hashes.spec},target:{base,head:r.git(['rev-parse','HEAD'],r.integration)}}));
 fs.writeFileSync(path.join(dir,'gen-1/slots/reviewer.json'),JSON.stringify({slot:'reviewer',state:'done',text:'{"status":"CLEAN","findings":[]}'}));
 fs.writeFileSync(path.join(dir,'findings.json'),JSON.stringify({review:'code-integration',round,failed:[],findings}));return dir;
}

export function setupTestSkill(deps: CliDeps, session: string, name = 'skill', config: object = {}) {
  const skill = path.join(session, name);
  fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
  fs.cpSync(path.join(deps.skillRoot, 'references/templates'), path.join(skill, 'references/templates'), { recursive: true });
  fs.copyFileSync(path.join(deps.skillRoot, 'references/spec-stage.md'), path.join(skill, 'references/spec-stage.md'));
  fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify(config));
  return skill;
}
