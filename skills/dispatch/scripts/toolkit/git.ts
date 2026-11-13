import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CliDeps } from './cli.ts';
import { ToolError } from './output.ts';
export const git = (deps: CliDeps, cwd: string, args: string[], env?: NodeJS.ProcessEnv, stdin?: string) => deps.run(['git',...args],{cwd,...(env ? {env} : {}),...(stdin!==undefined ? {stdin} : {})});
export async function gitRaw(deps: CliDeps, cwd: string, args: string[], env?: NodeJS.ProcessEnv, stdin?: string): Promise<string> {
  const result = await git(deps,cwd,args,env,stdin);
  if (result.exit!==0) throw new ToolError(2,'fault',result.stderr || result.stdout || 'Git exited ' + result.exit);
  return result.stdout;
}
export const gitOk = async (deps: CliDeps, cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> => (await gitRaw(deps,cwd,args,env)).trim();
export const headTree = (deps: CliDeps, cwd: string) => gitOk(deps,cwd,['rev-parse','HEAD^{tree}']);
export const splitPaths = (text: string) => text.split('\0').filter(Boolean);
export const gitPaths = async (deps: CliDeps, cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string[]> => splitPaths(await gitRaw(deps,cwd,args,env));
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
  const tracked = await gitPaths(deps,cwd,['diff','--name-only','--no-renames','-z',base,'--']);
  const untracked = await gitPaths(deps,cwd,['ls-files','--others','--exclude-standard','-z']);
  return [...new Set([...tracked,...untracked])];
}
