import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  createSessionLogger,
  createTraceWriter,
  emitCompletionBanner,
  emitInitBanner,
  resolveRunnerExitCode,
  runDelegateCapture,
  spawnCli,
  spawnCliSync,
  terminateProcessTree,
} from '../../../skills/dispatch/scripts/common.mjs';

// ---------------------------------------------------------------------------
// SECTION: Session Logging & Banners
// ---------------------------------------------------------------------------

describe('common: session logging & banners', () => {
  it('creates dedicated session log file without errors', () => {
    const logger = createSessionLogger('test-provider');
    assert.ok(logger.logFile.includes('test-provider'));
    assert.ok(logger.logFile.startsWith(os.tmpdir()));
    assert.ok(!logger.logFile.includes('.scratch'));
    logger.write('Sample log line\n');
    logger.close();

    assert.ok(fs.existsSync(logger.logFile));
    fs.unlinkSync(logger.logFile);
  });

  it('createSessionLogger: write after close does not throw or emit', async () => {
    const logger = createSessionLogger('test-after-close');
    logger.write('before-close\n');
    logger.close();
    assert.doesNotThrow(() => logger.write('after-close\n'));
    assert.doesNotThrow(() => logger.close());

    // The stream flushes asynchronously; wait for the pre-close line before asserting.
    let content = '';
    for (let i = 0; i < 50 && !content.includes('before-close'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      content = fs.readFileSync(logger.logFile, 'utf8');
    }
    assert.ok(content.includes('before-close'));
    assert.ok(!content.includes('after-close'));
    fs.unlinkSync(logger.logFile);
  });

  it('emitInitBanner formats standard banner with provider, model, effort, session, mode, and log', () => {
    let captured = '';
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      emitInitBanner({
        provider: 'Claude Code [desktop] (claude)',
        model: 'claude-3-7-sonnet',
        effort: 'high',
        sessionLink: 'https://example.com/session',
        mode: 'READ-ONLY',
        logFile: '/tmp/test.log',
      });
      assert.equal(
        captured,
        '[dispatch] Provider: Claude Code [desktop] (claude) | Model: claude-3-7-sonnet | Effort: high | Session: https://example.com/session | Mode: READ-ONLY | Log: /tmp/test.log\n',
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('emitInitBanner formats array model and omits null/undefined fields', () => {
    let captured = '';
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      emitInitBanner({
        provider: 'Antigravity 2.0 (agy)',
        model: ['gemini-3.8-flash', 'gemini-3.7-flash'],
        effort: null,
        logFile: '/tmp/test.log',
        mode: 'READ-ONLY',
      });
      assert.equal(
        captured,
        '[dispatch] Provider: Antigravity 2.0 (agy) | Model: gemini-3.8-flash, gemini-3.7-flash | Mode: READ-ONLY | Log: /tmp/test.log\n',
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('emitCompletionBanner formats completion banner with provider, resume, exitCode, and truncated', () => {
    let captured = '';
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      emitCompletionBanner({
        provider: 'OpenCode (LM Studio)',
        sessionLink: 'http://127.0.0.1:1234/v1',
        exitCode: 0,
        truncated: 'timeout',
      });
      assert.equal(
        captured,
        '[dispatch] Done: OpenCode (LM Studio) | Exit: 0 | Resume: http://127.0.0.1:1234/v1 | Truncated: timeout\n',
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  describe('createTraceWriter', () => {
    it('returns null when verbose is off', () => {
      assert.equal(createTraceWriter(false), null);
    });

    it('suppresses with a notice when stderr is not a terminal', () => {
      const origIsTTY = process.stderr.isTTY;
      let captured = '';
      const origWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        captured += chunk;
        return true;
      };
      try {
        process.stderr.isTTY = false;
        const trace = createTraceWriter(true);
        assert.equal(trace, null);
        assert.match(captured, /-v suppressed \(stderr is not a terminal\)/);
      } finally {
        process.stderr.isTTY = origIsTTY;
        process.stderr.write = origWrite;
      }
    });

    it('returns a stderr sink when verbose and stderr is a terminal', () => {
      const origIsTTY = process.stderr.isTTY;
      let captured = '';
      const origWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        captured += chunk;
        return true;
      };
      try {
        process.stderr.isTTY = true;
        const trace = createTraceWriter(true);
        assert.equal(typeof trace, 'function');
        trace('chunk-through-trace');
        assert.equal(captured, 'chunk-through-trace');
      } finally {
        process.stderr.isTTY = origIsTTY;
        process.stderr.write = origWrite;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// SECTION: Spawn & Batch Escaping
// ---------------------------------------------------------------------------

describe('common: subprocess spawning & escaping', () => {
  it('spawns a binary directly with spawnCliSync', () => {
    const result = spawnCliSync(process.execPath, ['-e', 'console.log("direct")'], {
      encoding: 'utf8',
    });
    assert.equal(String(result.stdout).trim(), 'direct');
  });

  it('spawns a process with spawnCli and handles lifecycle', (t, done) => {
    const child = spawnCli(process.execPath, ['-e', 'console.log("async")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      assert.equal(code, 0);
      assert.equal(out.trim(), 'async');
      done();
    });
  });

  it('spawnCli rejects a newline argument for a .cmd launcher', { skip: process.platform !== 'win32' }, () => {
    assert.throws(
      () => spawnCli('C:\\fake\\tool.cmd', ['line1\nline2', 'after']),
      /batch launcher argument contains a newline/,
    );
    assert.throws(
      () => spawnCliSync('C:\\fake\\tool.cmd', ['a\rb']),
      /batch launcher argument contains a newline/,
    );
  });

  it('round-trips a single-line metacharacter argument through a real .cmd launcher', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cmd-echo-'));
    try {
      fs.writeFileSync(path.join(dir, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      const launcher = path.join(dir, 'echo.cmd');
      fs.writeFileSync(launcher, `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
      const arg = 'a & b " c ^ d <e> | f (g) !h!';
      const res = spawnCliSync(launcher, [arg, 'second'], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), [arg, 'second']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminateProcessTree safely handles null or dead child', () => {
    assert.doesNotThrow(() => terminateProcessTree(null));
    assert.doesNotThrow(() => terminateProcessTree({ pid: 99999999 }));
  });

  it(
    'terminateProcessTree kills a grandchild, not just the direct child',
    { skip: process.platform === 'win32' ? 'POSIX process groups only' : false },
    async () => {
      // The defect: killing only the direct child left the real delegate CLI running, still
      // consuming tokens after the timeout fired.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-tree-'));
      try {
        const grandchild = path.join(dir, 'grandchild.js');
        fs.writeFileSync(grandchild, 'setInterval(() => {}, 1000);');
        const parent = path.join(dir, 'parent.js');
        fs.writeFileSync(
          parent,
          `const cp = require('node:child_process');
const kid = cp.spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });
process.stdout.write(String(kid.pid));
setInterval(() => {}, 1000);`,
        );

        const child = spawnCli(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'ignore'] });
        const grandchildPid = await new Promise((resolve) => {
          let buf = '';
          child.stdout.on('data', (c) => {
            buf += c.toString();
            if (buf.trim()) resolve(Number(buf.trim()));
          });
        });

        const alive = (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        assert.ok(alive(grandchildPid), 'the grandchild started');

        terminateProcessTree(child);
        // SIGKILL follows SIGTERM after 1s; allow for it plus scheduling slack.
        for (let i = 0; i < 40 && alive(grandchildPid); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(alive(grandchildPid), false, 'the grandchild was terminated with the group');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// SECTION: runDelegateCapture — shared delegate subprocess lifecycle
// ---------------------------------------------------------------------------

describe('common: runDelegateCapture (shared executor machinery)', () => {
  /**
   * Builds a fake child emitting scripted stdout/stderr chunks, then closing (or erroring).
   * The `spawnChild` factory is runDelegateCapture's own seam, so no child_process mocking
   * is needed — a plain EventEmitter child is the whole harness.
   */
  function fakeChild({ stdout = [], stderr = [], exitCode = 0, signal = null, delayMs = 0, error = null, events = ['close'] } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    const emitScripted = () => {
      for (const chunk of stdout) child.stdout.emit('data', Buffer.from(chunk));
      for (const chunk of stderr) child.stderr.emit('data', Buffer.from(chunk));
      if (error) {
        child.emit('error', error);
      }
      if (events.includes('close')) {
        child.emit('close', exitCode, signal);
      }
    };
    if (delayMs > 0) {
      setTimeout(emitScripted, delayMs);
    } else {
      process.nextTick(emitScripted);
    }
    return child;
  }

  it('captures stdout/stderr and forwards the assembled onClose result', async () => {
    const result = await runDelegateCapture({
      spawnChild: () => fakeChild({ stdout: ['answer body'], stderr: ['warning line'] }),
      timeoutSeconds: 30,
      maxBufferMb: 1,
      onClose: (outcome) => ({
        stdout: outcome.stdoutBuffer,
        stderr: outcome.stderrBuffer,
        code: outcome.code,
        truncated: outcome.truncated,
      }),
    });
    assert.deepEqual(result, { stdout: 'answer body', stderr: 'warning line', code: 0, truncated: null });
  });

  it('writes every chunk to the session logger and the trace sink, without closing the logger', async () => {
    const logLines = [];
    const traced = [];
    const sessionLogger = { logFile: '/tmp/fake.log', write: (chunk) => logLines.push(chunk), close: () => {} };
    await runDelegateCapture({
      spawnChild: () => fakeChild({ stdout: ['out'], stderr: ['err'] }),
      timeoutSeconds: 30,
      maxBufferMb: 1,
      sessionLogger,
      trace: (chunk) => traced.push(String(chunk)),
      onClose: (outcome) => outcome,
    });
    assert.equal(logLines.length, 2);
    assert.equal(traced.length, 2);
    // Logger ownership stays with the caller: the helper must not close it (claude holds one
    // logger across a whole cascade, so a helper-side close would silence later attempts).
    assert.doesNotThrow(() => sessionLogger.write('still-open'));
  });

  it('maps a timeout kill to truncated timeout (child closes after the timer fired)', async () => {
    const result = await runDelegateCapture({
      spawnChild: () => fakeChild({ stdout: ['partial'], exitCode: null, signal: 'SIGTERM', delayMs: 150 }),
      timeoutSeconds: 0.05,
      maxBufferMb: 1,
      onClose: (outcome) => ({
        truncated: outcome.truncated,
        isTimedOut: outcome.isTimedOut,
        code: outcome.code,
        signal: outcome.signal,
      }),
    });
    assert.equal(result.isTimedOut, true);
    assert.equal(result.truncated, 'timeout');
    assert.equal(result.code, null);
  });

  it('maps a buffer-cap kill to truncated buffer and exit code 137', async () => {
    const result = await runDelegateCapture({
      spawnChild: () => fakeChild({ stdout: ['x'.repeat(1024 * 1024), 'y'.repeat(1024 * 1024)] }),
      timeoutSeconds: 30,
      maxBufferMb: 1,
      onClose: (outcome) => ({
        truncated: outcome.truncated,
        isBufferExceeded: outcome.isBufferExceeded,
        exitCode: resolveRunnerExitCode({
          code: outcome.code,
          signal: outcome.signal,
          truncated: outcome.truncated,
          cleanStdout: 'kept',
        }),
      }),
    });
    assert.equal(result.isBufferExceeded, true);
    assert.equal(result.truncated, 'buffer');
    assert.equal(result.exitCode, 137);
  });

  it('does not apply the buffer cap to stderr', async () => {
    const result = await runDelegateCapture({
      spawnChild: () => fakeChild({ stdout: ['out'], stderr: ['e'.repeat(5 * 1024 * 1024)] }),
      timeoutSeconds: 30,
      maxBufferMb: 1,
      onClose: (outcome) => ({
        truncated: outcome.truncated,
        stderrLength: outcome.stderrBuffer.length,
        stdoutLength: outcome.stdoutBuffer.length,
      }),
    });
    assert.equal(result.truncated, null);
    assert.equal(result.stdoutLength, 3);
    assert.equal(result.stderrLength, 5 * 1024 * 1024);
  });

  it('rejects on a spawn error with err.code=1, err.stderr, and the onFail annotation', async () => {
    const boom = new Error('spawn gone');
    await assert.rejects(
      runDelegateCapture({
        spawnChild: () => fakeChild({ stderr: ['recorded stderr'], error: boom, events: [] }),
        timeoutSeconds: 30,
        maxBufferMb: 1,
        onFail: (err) => {
          err.failureKind = 'auth';
        },
        onClose: (outcome) => outcome,
      }),
      (err) => {
        assert.equal(err, boom);
        assert.equal(err.code, 1);
        assert.equal(err.stderr, 'recorded stderr');
        assert.equal(err.failureKind, 'auth');
        return true;
      },
    );
  });

  it('error-then-close settles once: no onClose run and no double banner', async () => {
    let onCloseRan = false;
    const boom = new Error('spawn gone');
    const completions = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      completions.push(String(chunk));
      return true;
    };
    try {
      await assert.rejects(
        runDelegateCapture({
          spawnChild: () => fakeChild({ error: boom, events: ['close'] }),
          timeoutSeconds: 30,
          maxBufferMb: 1,
          onClose: (outcome) => {
            onCloseRan = true;
            return outcome;
          },
        }),
        (err) => err === boom,
      );
      assert.equal(onCloseRan, false, 'close after error must not run the success path');
      assert.ok(!completions.some((line) => line.includes('[dispatch] Done:')), 'no completion banner after error');
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('delivers arrival-ordered chunks to the onChunk hook', async () => {
    const seen = [];
    await runDelegateCapture({
      spawnChild: () => fakeChild({ stdout: ['one'], stderr: ['two'] }),
      timeoutSeconds: 30,
      maxBufferMb: 1,
      onChunk: (stream, chunk) => seen.push(`${stream}:${chunk.toString('utf8')}`),
      onClose: (outcome) => outcome,
    });
    assert.deepEqual(seen, ['stdout:one', 'stderr:two']);
  });
});
