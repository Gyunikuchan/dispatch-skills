// Real `ProcessPort` over node:child_process: detached (own group on POSIX), stdout streamed to the slot log up to
// the cap, stderr tail kept in memory. Deadline/idleness tree kills stay in the runner; OpenCode run and inspection
// request bounded POSIX group settlement after normal completion and timeout/failure.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { batchInvocation, type RunnerFs } from './runner.ts';
import type { Launch, ProcessPort, ProcessResult } from './types.ts';

export const nodeRunnerFs: RunnerFs = {
  readText: file => fs.readFileSync(file, 'utf8'),
  writeText: (file, text) => fs.writeFileSync(file, text, {mode: 0o600}),
  realpath: file => { try { return fs.realpathSync(file); } catch { return null; } },
  readdir: dir => { try { return fs.readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } },
  size: file => { try { const info = fs.statSync(file); return info.isFile() ? info.size : null; } catch { return null; } },
  readPrefix(file, max) { const fd = fs.openSync(file, 'r'); try { const bytes = Buffer.alloc(max); return bytes.subarray(0, fs.readSync(fd, bytes)).toString('utf8'); } finally { fs.closeSync(fd); } },
};

const STDERR_TAIL = 4000;
const LINE_CARRY_MAX = 64 * 1024;

export function stdoutLines(onLine: (line: string, fragment?: boolean) => void) {
  let carry = Buffer.alloc(0);
  let fragmented = false;
  return {
    write(chunk: Buffer) {
      let data = Buffer.concat([carry, chunk]);
      while (data.length) {
        const newline = data.indexOf(10);
        if (newline >= 0 && newline <= LINE_CARRY_MAX) {
          let line = data.subarray(0, newline);
          if (line.at(-1) === 13) line = line.subarray(0, -1);
          onLine(line.toString('utf8'), fragmented);
          fragmented = false;
          data = data.subarray(newline + 1);
        } else if (data.length > LINE_CARRY_MAX) {
          fragmented = true;
          onLine(data.subarray(0, LINE_CARRY_MAX).toString('utf8'), true);
          data = data.subarray(LINE_CARRY_MAX);
        } else break;
      }
      carry = Buffer.from(data);
    },
    end() { if (carry.length) onLine(carry.toString('utf8'), fragmented); carry = Buffer.alloc(0); fragmented = false; },
  };
}

export const nodeProcess: ProcessPort = {
  start(launch: Launch, io: { logPath: string; capBytes: number; onActivity?: () => void; onLine?: (line: string, fragment?: boolean) => void }) {
    const started = process.hrtime.bigint();
    const [command, ...args] = launch.argv;
    if (!command) throw new Error('nodeProcess.start: empty argv');
    // ComSpec is the host's own cmd.exe location; shell stays off and batchInvocation escapes every argument.
    const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
      ? batchInvocation(command, args, process.env['ComSpec'] || 'cmd.exe') : null;
    // Open the log first so a failure cannot orphan a running child.
    const log = fs.openSync(io.logPath, 'w', 0o600);
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
    const lines = io.onLine ? stdoutLines(io.onLine) : null;
    const chunks: Buffer[] = [];
    let written = 0;
    let truncated = false;
    let stderr = '';
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelCap = () => {
      if (capTimer) return;
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill('SIGKILL'));
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
      capTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.kill('SIGKILL'); }, 1000);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      io.onActivity?.();
      lines?.write(chunk);
      const room = io.capBytes - written;
      if (room <= 0) { truncated = true; cancelCap(); return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      fs.writeSync(log, piece);
      chunks.push(piece);
      written += piece.length;
      if (truncated) cancelCap();
    });
    child.stderr?.on('data', (chunk: Buffer) => { io.onActivity?.(); stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL); });
    const done = new Promise<ProcessResult>((resolve) => {
      let settled = false;
      // 'error' and 'close' can both fire; settle once.
      const finish = (exit: number | null, signal: string | null, extra = ''): void => {
        if (settled) return;
        settled = true;
        if (capTimer) clearTimeout(capTimer);
        lines?.end();
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
  async settleGroup(pid, budgetMs) {
    if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 1) return false;
    const state = (): 'alive' | 'gone' | 'unknown' => {
      try { process.kill(-pid, 0); return 'alive'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'; }
    };
    const signal = (value: 'SIGTERM' | 'SIGKILL'): boolean => {
      try { process.kill(-pid, value); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const initial = state();
    if (initial === 'gone') return true;
    if (initial !== 'alive' || budgetMs <= 0 || !signal('SIGTERM')) return false;
    const deadline = Date.now() + budgetMs;
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.floor(budgetMs / 2))));
    const afterTerm = state();
    if (afterTerm === 'gone') return true;
    if (afterTerm !== 'alive' || !signal('SIGKILL')) return false;
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())));
    return state() === 'gone';
  },
  signal(pid, signal) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  },
};
