import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CliDeps } from './cli.ts';
import { ToolError } from './output.ts';
export const git = (deps: CliDeps, cwd: string, args: string[], env?: NodeJS.ProcessEnv) => deps.run(['git',...args],{cwd,...(env ? {env} : {})});
export async function gitOk(deps: CliDeps, cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await git(deps,cwd,args,env);
  if (result.exit!==0) throw new ToolError(2,'fault',result.stderr || result.stdout || 'Git exited ' + result.exit);
  return result.stdout.trim();
}
export const headTree = (deps: CliDeps, cwd: string) => gitOk(deps,cwd,['rev-parse','HEAD^{tree}']);
export async function testedTree(deps: CliDeps, session: string, cwd: string): Promise<string> {
  const directory=path.join(session,'.state/tmp'); fs.mkdirSync(directory,{recursive:true});
  const index=path.join(directory,randomUUID()+'.index');
  const env={GIT_INDEX_FILE:index};
  try {
    await gitOk(deps,cwd,['read-tree','HEAD'],env);
    await gitOk(deps,cwd,['add','-A'],env);
    return await gitOk(deps,cwd,['write-tree'],env);
  } finally { fs.rmSync(index,{force:true}); fs.rmSync(index+'.lock',{force:true}); }
}
export async function changedPaths(deps: CliDeps, cwd: string, base: string): Promise<string[]> {
  const tracked=await git(deps,cwd,['diff','--name-only','--no-renames','-z',base,'--']);
  if(tracked.exit) throw new ToolError(2,'fault',tracked.stderr);
  const untracked=await git(deps,cwd,['ls-files','--others','--exclude-standard','-z']);
  if(untracked.exit) throw new ToolError(2,'fault',untracked.stderr);
  return [...new Set([...tracked.stdout.split('\0'),...untracked.stdout.split('\0')].filter(Boolean))];
}
