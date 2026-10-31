import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { currentPlatform } from '../../skills/dispatch/scripts/lib/platform.ts';
import { nodeProcess } from '../../skills/dispatch/scripts/providers/node-process.ts';
import { nativeOpencodeIntrospection } from '../../skills/dispatch/scripts/providers/opencode-runtime.ts';
import { opencode } from '../../skills/dispatch/scripts/providers/opencode.ts';
import { runDelegate, type RunnerFs, type RunnerPorts } from '../../skills/dispatch/scripts/providers/runner.ts';
import type { DelegateRequest } from '../../skills/dispatch/scripts/providers/types.ts';

type Scenario = 'inspect' | 'hang' | 'unsupported' | 'success' | 'failure' | 'timeout' | 'cap' | 'exit-with-descendant' | 'closed-stdio-success' | 'closed-stdio-failure';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeFixture(scenario: Scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-lifecycle-'));
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree);
  const argsPath = path.join(root, 'args.json');
  const childPidPath = path.join(root, 'child.pid');
  const source = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
if (${JSON.stringify(scenario)} === 'unsupported') {
  process.stderr.write("error: unrecognized option '--standalone'\\n");
  process.exit(2);
}
if (!args.includes('--standalone')) {
  process.stderr.write("error: missing required --standalone flag\\n");
  process.exit(2);
}
if (args.includes('debug') && ${JSON.stringify(scenario)} === 'inspect') {
  process.stdout.write(JSON.stringify({ args, configDir: process.env.OPENCODE_CONFIG_DIR ?? null, hasApiKey: Object.hasOwn(process.env, 'OPENAI_API_KEY') }));
  process.exit(0);
}
if (args.includes('debug') && ${JSON.stringify(scenario)} === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(scenario)} === 'closed-stdio-success' || ${JSON.stringify(scenario)} === 'closed-stdio-failure') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  process.stdout.write(args.includes('debug') ? '[]' : 'private run complete');
  process.exit(${JSON.stringify(scenario)} === 'closed-stdio-failure' ? 7 : 0);
} else if (${JSON.stringify(scenario)} === 'failure') {
  process.stderr.write('controlled provider failure\\n');
  process.exit(7);
} else if (${JSON.stringify(scenario)} === 'timeout' || ${JSON.stringify(scenario)} === 'cap') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  if (${JSON.stringify(scenario)} === 'cap') process.stdout.write('x'.repeat(200000));
  else process.stdout.write('started\\n');
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(scenario)} === 'exit-with-descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: process.platform === 'win32' });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  process.stdout.write('private CLI exits while its server child stays open\\n');
  process.exit(0);
} else if (args.includes('debug')) {
  process.stdout.write(JSON.stringify(args));
} else {
  process.stdout.write('private run complete');
}
`;
  const scriptPath = path.join(root, 'fixture.cjs');
  fs.writeFileSync(scriptPath, source);
  let binary: string;
  if (process.platform === 'win32') {
    binary = path.join(root, 'opencode.cmd');
    fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    binary = path.join(root, 'opencode');
    fs.writeFileSync(binary, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  }
  const request: DelegateRequest = {
    promptPath: path.join(worktree, 'prompt.md'), model: null, effort: null, sandbox: false, schemaPath: null, resume: null,
    cwd: worktree, timeoutMs: scenario === 'timeout' || scenario === 'exit-with-descendant' ? 400 : 2500, agent: 'explore', readOnlyVerified: true,
    outputCapBytes: scenario === 'cap' ? 64 : 1024, attachments: [], logPath: path.join(worktree, 'delegate.log'),
    briefPath: path.join(worktree, 'brief.md'),
  };
  let descendantStopped = false;
  const stopDescendant = async () => {
    if (descendantStopped) return;
    if (fs.existsSync(childPidPath)) {
      const pid = Number(fs.readFileSync(childPidPath, 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, 'fixture wrote an invalid descendant PID');
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await assertOwnedProcessExited(pid);
    }
    descendantStopped = true;
  };
  const cleanup = async () => {
    await stopDescendant();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, worktree, argsPath, childPidPath, binary, request, stopDescendant, cleanup };
}

function runnerPorts(binary: string, promptPath: string, body = 'OpenCode lifecycle probe'): RunnerPorts {
  const runnerFs: RunnerFs = {
    readText: (file) => file === promptPath ? body : '',
    writeText: (file, text) => fs.writeFileSync(file, text),
    realpath: (file) => { try { return fs.realpathSync(file); } catch { return null; } },
    size: (file) => { try { return fs.statSync(file).size; } catch { return null; } },
    readPrefix: (file, max) => { try { return fs.readFileSync(file).subarray(0, max).toString('utf8'); } catch { return ''; } },
  };
  return {
    process: nodeProcess,
    clock: { now: () => Date.now(), every: (ms, fn) => { const timer = setInterval(fn, ms); timer.unref(); return () => clearInterval(timer); } },
    fs: runnerFs,
    env: process.env,
    platform: currentPlatform(),
    binary,
    nonce: () => 'lifecycle-test',
  };
}

async function withServiceSentinel<T>(run: () => Promise<T>): Promise<T> {
  const service = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(service, 'spawn');
  try {
    const result = await run();
    assert.equal(service.exitCode, null);
    assert.equal(service.signalCode, null);
    return result;
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit');
      service.kill();
      await exited;
    }
  }
}

async function assertOwnedProcessExited(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await pause(20);
  }
  assert.fail(`owned OpenCode descendant ${pid} remained alive after teardown`);
}

function ownedProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

test('OpenCode inspection uses a private server and releases its directory', async () => {
  await withServiceSentinel(async () => {
    const fixture = makeFixture('inspect');
    try {
      const configDir = path.join(fixture.root, 'private-config');
      const inspect = nativeOpencodeIntrospection(fixture.binary, fixture.request, {
        ...process.env, OPENCODE_CONFIG_DIR: configDir, OPENAI_API_KEY: 'must-not-reach-the-child',
      }, 4000);
      const inspected = (command: string) => ({ args: ['--standalone', 'debug', command], configDir, hasApiKey: false });
      assert.deepEqual(await inspect('config'), inspected('config'));
      assert.deepEqual(await inspect('agents'), inspected('agents'));
      assert.equal(fs.existsSync(`${fixture.request.logPath}.introspect-config`), false);
      assert.equal(fs.existsSync(`${fixture.request.logPath}.introspect-agents`), false);
      fs.rmSync(fixture.worktree, { recursive: true });
      assert.equal(fs.existsSync(fixture.worktree), false);
    } finally { await fixture.cleanup(); }
  });
});

test('OpenCode inspection timeout settles its owned descendant and rejects unsupported standalone', async () => {
  await withServiceSentinel(async () => {
    const hanging = makeFixture('hang');
    try {
      const startedAt = Date.now();
      const inspect = nativeOpencodeIntrospection(hanging.binary, hanging.request, process.env, 400);
      const failure = await inspect('config').then(() => null, (error: unknown) => error);
      assert.match(String(failure), /effective-config-unverified: opencode-lifecycle-timeout/);
      assert.ok(Date.now() - startedAt < 2500);
      const childPid = Number(fs.readFileSync(hanging.childPidPath, 'utf8'));
      await assertOwnedProcessExited(childPid);
      fs.rmSync(hanging.worktree, { recursive: true });
    } finally { await hanging.cleanup(); }

    const unsupported = makeFixture('unsupported');
    try {
      const inspect = nativeOpencodeIntrospection(unsupported.binary, unsupported.request, process.env, 1500);
      await assert.rejects(inspect('config'), /OpenCode binary does not support --standalone/i);
      assert.equal(fs.existsSync(`${unsupported.request.logPath}.introspect-config`), false);
      fs.rmSync(unsupported.worktree, { recursive: true });
    } finally { await unsupported.cleanup(); }
  });
});

test('OpenCode private runs settle success, failure, timeout, and output cap', async () => {
  await withServiceSentinel(async () => {
    for (const scenario of ['success', 'failure', 'timeout', 'cap', 'exit-with-descendant'] as const) {
      const fixture = makeFixture(scenario);
      try {
        const startedAt = Date.now();
        const ports = runnerPorts(fixture.binary, fixture.request.promptPath);
        const result = await runDelegate(opencode, fixture.request, 'cli', ports);
        const args = JSON.parse(fs.readFileSync(fixture.argsPath, 'utf8')) as string[];
        assert.ok(args.includes('--standalone'), `${scenario} run did not request a private server`);
        if (scenario === 'success') assert.equal(result.outcome.status, 'ok');
        if (scenario === 'failure') assert.equal(result.outcome.status, 'fail');
        if (scenario === 'timeout') {
          assert.equal(result.outcome.status, 'fail');
          assert.equal(result.outcome.status === 'fail' && result.outcome.cls, 'timeout');
        }
        if (scenario === 'cap') {
          assert.equal(result.outcome.status, 'fail');
          assert.equal(result.outcome.status === 'fail' && result.outcome.cls, 'buffer');
        }
        let removable = true;
        if (scenario === 'exit-with-descendant') {
          assert.ok(Date.now() - startedAt < 3000, 'private CLI descendant teardown exceeded its bound');
          const childPid = Number(fs.readFileSync(fixture.childPidPath, 'utf8'));
          assert.equal(result.outcome.status, 'fail', JSON.stringify({outcome:result.outcome,childAlive:ownedProcessAlive(childPid)}));
          assert.equal(result.outcome.status === 'fail' && result.outcome.cls, 'timeout');
          if (process.platform === 'win32') {
            assert.equal(ownedProcessAlive(childPid), true, 'fixture must expose the accepted escaped-child limit');
            assert.match(result.outcome.status === 'fail' ? result.outcome.detail : '', /retain the worktree and verify process exit/);
            removable = false;
          } else await assertOwnedProcessExited(childPid);
          // Fixture teardown happens only after lifecycle evidence has been checked.
        }
        if (scenario === 'timeout' || scenario === 'cap') {
          const childPid = Number(fs.readFileSync(fixture.childPidPath, 'utf8'));
          await assertOwnedProcessExited(childPid);
        }
        if (!removable) { assert.ok(fs.existsSync(fixture.worktree)); continue; }
        try { fs.rmSync(fixture.worktree, { recursive: true }); }
        catch (error) { assert.fail(`${scenario} worktree removal failed after the run settled: ${String(error)}`); }
        assert.equal(fs.existsSync(fixture.worktree), false);
      } finally { await fixture.cleanup(); }
    }
  });
});


test('OpenCode closed-stdio descendants expose the accepted Windows limit and settle the POSIX group', async () => {
  await withServiceSentinel(async () => {
    for(const family of ['run','config','agents'] as const) for(const scenario of ['closed-stdio-success','closed-stdio-failure'] as const) {
      const fixture=makeFixture(scenario);
      try {
        let lifecycleFailure=false;
        if(family==='run') {
          const result=await runDelegate(opencode,fixture.request,'cli',runnerPorts(fixture.binary,fixture.request.promptPath));
          lifecycleFailure=!!result.result?.lifecycleError;
          if(process.platform==='win32')assert.equal(result.outcome.status,scenario==='closed-stdio-success'?'ok':'fail');
        } else {
          try {await nativeOpencodeIntrospection(fixture.binary,fixture.request,process.env,2500)(family);}
          catch(error) {lifecycleFailure=/opencode-lifecycle-timeout/.test(String(error));if(!lifecycleFailure)assert.equal(scenario,'closed-stdio-failure');}
        }
        const pid=Number(fs.readFileSync(fixture.childPidPath,'utf8'));
        const alive=ownedProcessAlive(pid);
        if(process.platform==='win32') {
          // Immediate CLI exit cannot confirm a detached child's exit without native containment.
          assert.equal(alive,true,'fixture must expose the accepted detached-child limit');
          assert.ok(fs.existsSync(fixture.worktree));
        } else {
          await assertOwnedProcessExited(pid);
          assert.equal(lifecycleFailure,false,'a confirmed POSIX process group exit must preserve the CLI result');
          fs.rmSync(fixture.worktree,{recursive:true});
          assert.equal(fs.existsSync(fixture.worktree),false);
        }
      } finally {await fixture.cleanup();}
    }
  });
});
