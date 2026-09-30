// Real `ProcessPort` over node:child_process: detached (own group on POSIX), stdout streamed to the slot log up to
// the cap, stderr tail kept in memory. Timeouts and tree kill stay in the runner.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { batchInvocation } from './runner.ts';
import type { Launch, ProcessPort, ProcessResult } from './types.ts';

const STDERR_TAIL = 4000;

export const nodeProcess: ProcessPort = {
  start(launch: Launch, io: { logPath: string; capBytes: number }) {
    const started = process.hrtime.bigint();
    const [command, ...args] = launch.argv;
    if (!command) throw new Error('nodeProcess.start: empty argv');
    const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
      ? batchInvocation(command, args, process.env['ComSpec'] || 'cmd.exe') : null;
    // Open the log first so a failure cannot orphan a running child.
    const log = fs.openSync(io.logPath, 'w');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(batch ? batch.command : command, batch ? batch.args : args, {
      cwd: launch.cwd,
      env: launch.env,
      detached: process.platform !== 'win32',
      stdio: [launch.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: batch !== null,
    });
    } catch (error) {
      fs.closeSync(log);
      throw error;
    }
    if (launch.stdin !== null) child.stdin?.end(launch.stdin);
    const chunks: Buffer[] = [];
    let written = 0;
    let truncated = false;
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const room = io.capBytes - written;
      if (room <= 0) { truncated = true; return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      fs.writeSync(log, piece);
      chunks.push(piece);
      written += piece.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL); });
    const done = new Promise<ProcessResult>((resolve) => {
      let settled = false;
      // 'error' and 'close' can both fire; settle once.
      const finish = (exit: number | null, signal: string | null, extra = ''): void => {
        if (settled) return;
        settled = true;
        fs.closeSync(log);
        resolve({
          exit, signal, stdout: Buffer.concat(chunks).toString('utf8'), stdoutPath: io.logPath,
          stderrTail: (stderr + extra).slice(-STDERR_TAIL), durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          timedOut: false, truncated,
        });
      };
      child.once('error', (error) => finish(null, null, `\n${error.message}`));
      child.once('close', (code, signal) => finish(code, signal));
    });
    return { pid: child.pid ?? -1, done };
  },
  signal(pid, signal) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  },
};
