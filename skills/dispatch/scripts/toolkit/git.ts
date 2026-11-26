import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ToolError } from "./output.ts";

export interface GitDeps {
  run: (
    argv: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string }
  ) => Promise<{ exit: number; stdout: string; stderr: string }>;
}

export const git = async (
  deps: GitDeps,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  stdin?: string
) =>
  await deps.run(["git", ...args], {
    cwd,
    ...(env && { env }),
    ...(stdin !== undefined && { stdin }),
  });

export const gitRaw = async (
  deps: GitDeps,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  stdin?: string
) => {
  const result = await git(deps, cwd, args, env, stdin);

  if (result.exit !== 0) {
    throw new ToolError(
      2,
      "fault",
      result.stderr || result.stdout || `Git exited ${result.exit}`
    );
  }

  return result.stdout;
};

export const gitOk = async (
  deps: GitDeps,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => {
  const raw = await gitRaw(deps, cwd, args, env);

  return raw.trim();
};

export const headTree = async (deps: GitDeps, cwd: string) =>
  await gitOk(deps, cwd, ["rev-parse", "HEAD^{tree}"]);

export const splitPaths = (text: string) => text.split("\0").filter(Boolean);

export const gitPaths = async (
  deps: GitDeps,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => splitPaths(await gitRaw(deps, cwd, args, env));

export const testedTree = async (
  deps: GitDeps,
  session: string,
  cwd: string
) => {
  const directory = path.join(session, ".state/tmp");
  fs.mkdirSync(directory, { recursive: true });
  const index = path.join(directory, `${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };

  try {
    await gitOk(deps, cwd, ["read-tree", "HEAD"], env);
    await gitOk(deps, cwd, ["add", "-A"], env);

    return await gitOk(deps, cwd, ["write-tree"], env);
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
};

export const changedPaths = async (
  deps: GitDeps,
  cwd: string,
  base: string
) => {
  const tracked = await gitPaths(deps, cwd, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    base,
    "--",
  ]);

  const untracked = await gitPaths(deps, cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);

  return [...new Set([...tracked, ...untracked])];
};
