// `verify`: run each command sequentially through the platform shell, log each run to `<run>/<effectId>.<n>.log`,
// and fingerprint the tree after the last command. A red command is a domain result, not an effect failure.

import path from 'node:path';
import type { Effect, Handler } from '../core/types.ts';
import type { OsId } from '../lib/platform.ts';
import type { Git } from './git.ts';

type VerifyEffect = Extract<Effect, { kind: 'verify' }>;

export type VerifyDeps = { os: OsId; cwd: string; git: Git };
export type CommandResult = { command: string; exit: number; logPath: string };

/** `cmd.exe /d /s /c` on Windows (no AutoRun, verbatim quoting), `sh -c` elsewhere. */
export function shellArgv(os: OsId, command: string): string[] {
  return os === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
}

const commandOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof (value as { command?: unknown }).command === 'string') return (value as { command: string }).command;
  return null;
};

export function createVerify(deps: VerifyDeps): Handler<VerifyEffect> {
  return async (effect, ports, ctx) => {
    const results: CommandResult[] = [];
    for (const [index, raw] of effect.commands.entries()) {
      const command = commandOf(raw);
      if (command === null) return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'config', detail: `commands[${index}]: expected { command }` }];
      const logPath = path.join(ctx.runDir, `${effect.id}.${index + 1}.log`);
      let exit: number;
      let log: string;
      try {
        const run = await ports.spawn.run(shellArgv(deps.os, command), { cwd: deps.cwd });
        exit = run.exit;
        log = `$ ${command}\n${run.stdout}${run.stderr ? `\n[stderr]\n${run.stderr}` : ''}\n[exit ${run.exit}]\n`;
      } catch (error) {
        exit = 127;
        log = `$ ${command}\n[spawn error] ${error instanceof Error ? error.message : String(error)}\n`;
      }
      try { ports.fs.writeAtomic(logPath, log); } catch (error) {
        return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `log: ${error instanceof Error ? error.message : String(error)}` }];
      }
      results.push({ command, exit, logPath });
    }
    let fingerprint;
    try { fingerprint = await deps.git.fingerprint(deps.cwd); } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `fingerprint: ${error instanceof Error ? error.message : String(error)}` }];
    }
    return [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results, fingerprint }];
  };
}
