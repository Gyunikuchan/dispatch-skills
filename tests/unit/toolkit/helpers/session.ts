import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { memoryNodeFs } from '../../../helpers/memory-node-fs.ts';
import path from 'node:path';
import type { CliDeps } from '../../../../skills/dispatch/scripts/toolkit/cli.ts';
import type { DelegateRequest, ModeId, ProviderId, RunOutcome } from '../../../../skills/dispatch/scripts/providers/types.ts';
import { canonicalRepositoryRoot } from '../../../../skills/dispatch/scripts/lib/session.ts';

export function sessionFixture(options: { memory?: boolean } = {}) {
  const root = options.memory ? path.join(os.tmpdir(), 'toolkit-' + randomUUID()) : fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-'));
  const restore = options.memory ? memoryNodeFs(root) : null;
  const session = path.join(root, '.scratch', 'dispatch-skills', '20261023T0000Z-test');
  fs.mkdirSync(session,{recursive:true});
  fs.writeFileSync(path.join(session, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, folderName: path.basename(session), sessionId: 'test', safeSessionId: 'test', repositoryRoot: canonicalRepositoryRoot(root),
  }));
  const lines: string[] = [];
  const sleeps: number[] = [];
  const replies = new Map<string, RunOutcome>();
  const launches: {provider:ProviderId; request:DelegateRequest; mode:ModeId}[]=[];
  const deps: CliDeps = {
    run: async () => { throw new Error('Unit tests must not spawn processes'); },
    delegate: async(provider,request,mode)=>{
      launches.push({provider,request,mode});
      const outcome=replies.get(provider+':'+request.model);
      if(!outcome)throw new Error('Unscripted delegate '+provider+':'+request.model);
      return {outcome,invocations:[]};
    },
    modes:()=>['cli'],orchestrator:null,liveness:{claude:true,agy:true,codex:true,copilot:true,opencode:true},
    stdout: (line) => lines.push(line), env: {}, clock: () => 0,
    sleep: async (ms) => { sleeps.push(ms); }, pid: 42, host: 'test-host', isAlive: () => false,
    skillRoot: path.resolve('skills/dispatch'),
  };
  const artifact = (name: string, source: string) => { const file = path.join(root, name); fs.writeFileSync(file, source); return file; };
  const script=(provider:string,model:string,text:string|RunOutcome)=>replies.set(provider+':'+model,typeof text==='string'?{status:'ok',text,resume:null,sessionId:null}:text);
  return { root, session, lines, sleeps, deps, artifact,script,launches,
    output: () => { if (lines.length !== 1) throw new Error('Expected one output line'); return JSON.parse(lines[0]!) as { ok: boolean; summary: string; path: string | null; reason?: string }; },
    cleanup: () => { if (restore) restore(); else fs.rmSync(root, { recursive: true, force: true }); },
  };
}
