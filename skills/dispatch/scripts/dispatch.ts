import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { designRevision, dispatchMachine, findDesignDelivery, findSettledPlan, previewReceipt, send, start } from './core/interpreter.ts';
import { faultFrame } from './core/frame.ts';
import { readJournal } from './core/journal.ts';
import { nodePorts } from './core/ports.ts';
import { STALL_HINT_MS } from './core/progress.ts';
import type { Frame, Level, RunStartedEvent } from './core/types.ts';
import { createHandlers } from './effects/index.ts';
import { createGit } from './effects/git.ts';
import { sessionDirOf } from './effects/handoff.ts';
import { claimPath, donePath, heartbeatPath, inputPath, readClaim, runWaveWorker, type WorkerDeps, type WaveDeps } from './effects/wave.ts';
import { parseCommand, UsageError, type Command } from './lib/cli.ts';
import { doctorReport, formatDoctor } from './lib/doctor.ts';
import { loadConfig, validateConfig } from './lib/config.ts';
import { checkIntegrity, integrityDiagnostic } from './lib/integrity.ts';
import { nodeLinkFs } from './lib/node-fs-ext.ts';
import { currentPlatform, detectOrchestrator } from './lib/platform.ts';
import { canonicalRepositoryRoot, createRun, findRepoRoot, handoffSession, initializeSession, platformSessionId, reactivateSession, readManifest, restoreSessionPaths, storeSessionPaths } from './lib/session.ts';
import { LEVELS, normalizeProvider, parsePins, resolveLevel, resolveRoster, selectLevel, type LevelMap, type ReadDelegate } from './policy/roster.ts';
import { createDiscovery } from './providers/discovery.ts';
import { SPECS, isProviderId } from './providers/index.ts';
import { createOpencodePreparePorts, nativeOpencodeIntrospection, resolveEffectiveOpencodeLaunch } from './providers/opencode-runtime.ts';
import { nodeProcess } from './providers/node-process.ts';
import { runDelegate, type RunnerFs } from './providers/runner.ts';
import type { ProviderId } from './providers/types.ts';

const ENTRY = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(ENTRY), '..');
const policy = { levels: LEVELS, pins: (text: string) => {
  const pins = parsePins(text);
  if (pins.kind === 'providers' && pins.keys.some((key) => !isProviderId(key))) throw new UsageError('Pins name an unknown provider');
  return pins;
}, provider: (text: string) => { const id = normalizeProvider(text); return isProviderId(id) ? id : null; } };
const textFlag = (command: Command, name: string): string | undefined => typeof command.flags[name] === 'string' ? command.flags[name] as string : undefined;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const runnerFs: RunnerFs = {
  readText: (file) => fs.readFileSync(file, 'utf8'), writeText: (file, text) => fs.writeFileSync(file, text, { mode: 0o600 }),
  realpath: (file) => { try { return fs.realpathSync(file); } catch { return null; } },
  size: (file) => { try { const s = fs.statSync(file); return s.isFile() ? s.size : null; } catch { return null; } },
  readPrefix(file, max) { const fd = fs.openSync(file, 'r'); try { const bytes = Buffer.alloc(max); return bytes.subarray(0, fs.readSync(fd, bytes)).toString('utf8'); } finally { fs.closeSync(fd); } },
};
function runtime() {
  const ports = nodePorts(), platform = currentPlatform();
  const discovery = createDiscovery(SPECS, platform, {
    list: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } }, exists: fs.existsSync,
    executable(file) { try { return fs.statSync(file).isFile() && (platform.os === 'win32' || (fs.statSync(file).mode & 0o111) !== 0); } catch { return false; } },
  });
  return { ports, platform, discovery };
}
function workerDeps(): WorkerDeps {
  const { ports, platform, discovery } = runtime();
  return {
    fs: nodeLinkFs, proc: ports.proc, clock: ports.clock, specs: SPECS,
    configSelectors: Object.fromEntries(['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'].flatMap((key) => { const value = ports.env.get(key); return typeof value === 'string' ? [[key, value]] : []; })),
    modes: (provider) => SPECS[provider].modes.filter((mode) => discovery.resolve(provider, mode.id).status === 'path').map((mode) => mode.id),
    async run(provider, request, mode) {
      const binary = discovery.resolve(provider, mode).path;
      if (!binary) return { status: 'fail', cls: 'not-found', detail: `${provider}: missing ${mode}` };
      const deadline = Date.now() + request.timeoutMs;
      let resolved = request;
      if (provider === 'opencode') {
        try { resolved = await resolveEffectiveOpencodeLaunch(request, nativeOpencodeIntrospection(binary, request, process.env, request.timeoutMs)); }
        catch (error) { return { status: 'fail', cls: 'config', detail: String(error) }; }
      }
      resolved = { ...resolved, timeoutMs: Math.max(1, deadline - Date.now()) };
      return (await runDelegate(SPECS[provider], resolved, mode, { process: nodeProcess, clock: ports.clock, fs: runnerFs, env: process.env, platform, binary, nonce: crypto.randomUUID, workspaceRoot: request.cwd, ...(provider === 'opencode' ? { prepare: createOpencodePreparePorts(deadline) } : {}) })).outcome;
    },
  };
}
function waveRuntime(): Omit<WaveDeps, 'context'> {
  const { ports } = runtime();
  return {
    fs: nodeLinkFs, proc: ports.proc, clock: ports.clock,
    launchWorker(runDir, id, attempt) {
      const child = spawn(process.execPath, [ENTRY, 'wave-worker', '--run', runDir, '--effect', id, '--attempt', String(attempt)], { detached: true, stdio: 'ignore', windowsHide: true, cwd: process.cwd(), env: process.env });
      child.on('error', (error) => ports.proc.stderr(`wave worker launch: ${error.message}\n`)); child.unref();
    },
    async awaitWorker(runDir, id, attempt) {
      const input = JSON.parse(fs.readFileSync(inputPath(runDir, id), 'utf8')) as { timeoutMs: number };
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(claimPath(runDir, id, attempt))) { if (Date.now() > deadline) throw new Error('worker did not publish its claim'); await pause(25); }
      while (!fs.existsSync(donePath(runDir, id, attempt))) {
        const state = readClaim({ fs: nodeLinkFs, proc: ports.proc, clock: ports.clock }, runDir, id, attempt, input.timeoutMs);
        if (state.kind !== 'live') return;
        await pause(25);
      }
    },
  };
}
function handlers(repo: string, orchestrator: ProviderId) {
  const { ports, platform } = runtime();
  return createHandlers({ cwd: repo, skillRoot: SKILL_ROOT, os: platform.os, git: createGit(ports.git), tempRoot: os.tmpdir(), workspaceRoot: path.join(repo, '.scratch/dispatch-skills'), orchestratorPlatform: orchestrator, wave: waveRuntime(),
    selfCheckCommand: (runDir, eventPath) => `node "${ENTRY}" send --run "${runDir}" --event "@${eventPath}" --dry-run` });
}
function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function activate(dir: string, repo: string): string {
  const manifest = readManifest(dir);
  if (manifest.repositoryRoot !== canonicalRepositoryRoot(repo)) throw new UsageError('Session belongs to another repository');
  const expected = path.join(repo, '.scratch/dispatch-skills', manifest.folderName);
  const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  return normalize(dir) === normalize(expected) ? fs.realpathSync(dir) : reactivateSession(dir, repo);
}
function publish(dir: string): string {
  const expected = path.join(os.tmpdir(), 'dispatch-skills', path.basename(dir));
  const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  return normalize(dir) === normalize(expected) ? fs.realpathSync(dir) : handoffSession(dir);
}
function finish(frame: Frame, runDir: string): Frame {
  if (frame.await !== 'done' || !frame.data['handoff']) return frame;
  const source = sessionDirOf(runDir);
  try {
    const destination = publish(source);
    return { ...restoreSessionPaths(storeSessionPaths(frame, source), destination), run: path.join(destination, '.state/runs', path.basename(runDir)).replaceAll('\\', '/') };
  } catch (error) { return { ...frame, data: { ...frame.data, handoff: source, warning: String(error) } }; }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let command: Command;
  try { command = parseCommand(argv, policy); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  const runDir = path.resolve(textFlag(command, 'run') ?? '.');
  try {
    if (command.command === 'wave-worker') { await runWaveWorker(runDir, textFlag(command, 'effect')!, Number(command.flags['attempt']), workerDeps()); return 0; }
    if (command.command === 'doctor') {
      const { discovery, platform } = runtime();
      let config: Record<string, unknown> = {}, configPath: string | null = null, problems: string[] = [];
      try { const loaded = loadConfig(SKILL_ROOT); config = loaded.config; configPath = loaded.path; problems = validateConfig(config); } catch (error) { problems.push(String(error)); }
      const level = (textFlag(command, 'level') ?? 'medium') as Level;
      let roster: unknown = null;
      try { roster = resolveRoster({ level, readDelegates: (config['read-delegates'] ?? {}) as Record<string, ReadDelegate>, orchestrator: detectOrchestrator((name) => process.env[name]), liveness: Object.fromEntries(Object.keys(SPECS).map((id) => [id, discovery.doctor().some((row) => row.provider === id && row.status === 'path')])) }); } catch (error) { problems.push(String(error)); }
      const selected = (value: unknown) => {
        const map = value as LevelMap<unknown> | undefined;
        return { selectedLevel: selectLevel(LEVELS.filter((key) => map?.[key] !== undefined), level) ?? null, value: resolveLevel(map, level) ?? null };
      };
      const writers = Object.fromEntries(Object.entries((config['write-subagents'] ?? {}) as Record<string, unknown>).map(([provider, value]) => [provider, selected(value)]));
      const phases = Object.fromEntries(Object.entries((config['phases'] ?? {}) as Record<string, Record<string, unknown>>).map(([phase, value]) => [phase, { targets: selected(value['targets']), rounds: selected(value['rounds']), only: value['only'] ?? null }]));
      const resolution = Object.fromEntries(Object.entries((config['read-delegates'] ?? {}) as Record<string, ReadDelegate>).map(([provider, value]) => [provider, value.targets?.map(selected) ?? []]));
      const report = doctorReport({ node: process.version, configPath, problems, integrity: checkIntegrity(SKILL_ROOT), level, roster: { effective: roster, resolution }, phases, writers, probes: discovery.doctor().map((row) => ({ ...row, sandbox: SPECS[row.provider].sandbox?.supported(platform) ?? null })) });
      if (command.flags['json']) emit(report); else process.stdout.write(`${formatDoctor(report)}\n`);
      return 0;
    }
    if (command.command === 'session') {
      const repo = findRepoRoot(process.cwd()); if (!repo) throw new UsageError('session requires a Git repository');
      let dir: string;
      if (command.action === 'init') {
        const id = textFlag(command, 'session-id') ?? platformSessionId((name) => process.env[name]) ?? crypto.randomUUID();
        dir = initializeSession({ repositoryRoot: repo, sessionId: id, sessionTitle: textFlag(command, 'objective')!, now: new Date() });
      } else if (command.action === 'reactivate') dir = activate(path.resolve(textFlag(command, 'session-dir')!), repo);
      else dir = publish(path.resolve(textFlag(command, 'session-dir')!));
      emit({ v: 1, sessionDir: dir, sessionId: readManifest(dir).sessionId }); return 0;
    }
    const { ports } = runtime();
    if (command.command === 'start') {
      const diagnostic = integrityDiagnostic(checkIntegrity(SKILL_ROOT)); if (diagnostic) throw new Error(diagnostic);
      const repo = findRepoRoot(process.cwd()); if (!repo) throw new UsageError('start requires a Git repository');
      const sessionDir = activate(path.resolve(textFlag(command, 'session-dir')!), repo);
      const loaded = loadConfig(SKILL_ROOT), problems = validateConfig(loaded.config); if (problems.length) throw new UsageError(problems.join('\n'));
      const provider = textFlag(command, 'provider'), pins = textFlag(command, 'pins');
      if (provider && pins) throw new UsageError('Use --provider or --pins, not both');
      const overrides: Record<string, unknown> = {};
      for (const key of ['model', 'effort', 'kind']) if (textFlag(command, key)) overrides[key] = textFlag(command, key);
      if (textFlag(command, 'timeout')) overrides['timeout'] = Number(command.flags['timeout']);
      const orchestrator = normalizeProvider(textFlag(command, 'orchestrator')!) as ProviderId;
      const orchestratorModel = detectOrchestrator((name) => process.env[name], { platform: orchestrator, ...(textFlag(command, 'orchestrator-model') ? { model: textFlag(command, 'orchestrator-model')! } : {}) })?.model ?? null;
      const level = (textFlag(command, 'level') ?? 'medium') as Level;
      const argument = command.verb === 'implement' && /\.(?:plan|design)\.md$/i.test(command.argument) ? path.resolve(repo, command.argument) : command.argument;
      if (command.verb === 'implement' && /\.design\.md$/i.test(argument)) {
        const revision = designRevision(fs.readFileSync(argument, 'utf8')); overrides['designRevision'] = revision;
        const existing = findDesignDelivery(ports, path.join(sessionDir, '.state/runs'), dispatchMachine, { path: argument, revision });
        if (existing) {
          const result = await send({ runDir: existing.runDir, machine: dispatchMachine, handlers: handlers(repo, orchestrator), ports, dryRun: existing.finished, runRel: path.relative(repo, existing.runDir).replaceAll('\\', '/') });
          if (result.frame) emit(finish(result.frame, existing.runDir)); if (result.message) process.stderr.write(`${result.message}\n`); return result.exitCode;
        }
      }
      if (command.verb === 'implement' && /\.plan\.md$/i.test(argument) && fs.existsSync(argument)) {
        const settled = findSettledPlan(ports, path.join(sessionDir, '.state/runs'), dispatchMachine, repo, { path: argument });
        if (settled) overrides['settledPlan'] = settled;
      }
      const runKind = command.verb === 'review' ? `${textFlag(command, 'kind') ?? (/\.plan\.md$/i.test(argument) ? 'plan' : /\.design\.md$/i.test(argument) ? 'design' : 'code')}-review` as 'code-review' | 'plan-review' | 'design-review' : command.verb!;
      const reserved = createRun(sessionDir, runKind);
      const config = { ...loaded.config };
      if (!pins && !provider) {
        const { discovery } = runtime();
        config['read-delegates'] = Object.fromEntries(Object.entries(loaded.config['read-delegates'] as Record<string, ReadDelegate>).filter(([key, delegate]) => {
          const id = normalizeProvider(key) as ProviderId;
          return delegate.nativeSubagentsOnly === true ? id === orchestrator : SPECS[id].modes.some((mode) => discovery.resolve(id, mode.id).status === 'path');
        }));
      }
      const runStarted: RunStartedEvent = { type: 'RUN_STARTED', verb: command.verb!, argument, level, levelSource: command.flags['level-source'] as 'explicit' | 'classified', pins: pins ? policy.pins(pins) : provider ? policy.pins(`(${provider})`) : null, fix: command.flags['fix'] === true, orchestrator, orchestratorModel, overrides, config, repo: { root: repo } };
      const result = await start({ runDir: reserved.dir, reservedRun: true, runStarted, machine: dispatchMachine, handlers: handlers(repo, orchestrator), ports, runRel: path.relative(repo, reserved.dir).replaceAll('\\', '/') });
      if (result.frame) emit(finish(result.frame, reserved.dir)); if (result.message) process.stderr.write(`${result.message}\n`); return result.exitCode;
    }
    const journal = readJournal(ports, runDir), started = journal.lines.find((line) => line.type === 'RUN_STARTED');
    if (!started) throw new Error('Run has no RUN_STARTED journal record');
    if (command.command === 'send' && !command.flags['dry-run']) { const diagnostic = integrityDiagnostic(checkIntegrity(SKILL_ROOT)); if (diagnostic) throw new Error(diagnostic); }
    const repoData = started.data['repo'] as Record<string, unknown>, repo = String(repoData['root'] ?? findRepoRoot(process.cwd()) ?? process.cwd());
    const orchestrator = String(started.data['orchestrator']) as ProviderId;
    let rawEvent: string | undefined = textFlag(command, 'event');
    if (rawEvent?.startsWith('@')) rawEvent = fs.readFileSync(path.resolve(rawEvent.slice(1)), 'utf8');
    const effectHandlers = handlers(repo, orchestrator);
    const result = await send({ runDir, machine: dispatchMachine, handlers: effectHandlers, ports, runRel: path.relative(repo, runDir).replaceAll('\\', '/'), ...(rawEvent !== undefined ? { rawEvent } : {}), dryRun: command.command === 'status' || command.flags['dry-run'] === true,
      preview: (state, event) => previewReceipt(state, event, effectHandlers, ports, runDir) });
    if (command.command === 'status' && result.frame) {
      let progress: unknown = null;
      try { progress = JSON.parse(fs.readFileSync(path.join(runDir, 'progress.json'), 'utf8')); } catch { /* no effect yet */ }
      const claims = fs.readdirSync(runDir).flatMap((name) => {
        const match = /^(.*)\.a(\d+)\.claim\.json$/.exec(name);
        if (!match) return [];
        const effect = match[1]!, attempt = Number(match[2]);
        const input = JSON.parse(nodeLinkFs.readText(inputPath(runDir, effect)) ?? '{"timeoutMs":1800000}') as { timeoutMs: number };
        return [{ effect, attempt, claim: readClaim({ fs: nodeLinkFs, proc: ports.proc, clock: ports.clock }, runDir, effect, attempt, input.timeoutMs), heartbeat: nodeLinkFs.readText(heartbeatPath(runDir, effect, attempt)) }];
      });
      const at = typeof progress === 'object' && progress !== null ? (progress as Record<string, unknown>)['at'] : null;
      const stalled = typeof at === 'string' && Date.now() - Date.parse(at) > STALL_HINT_MS;
      emit({ ...result.frame, progress: { snapshot: progress, workers: claims, ...(stalled ? { hint: 'No recent progress; inspect worker claims and command logs before resuming.' } : {}) } });
    } else if (result.frame) emit(command.flags['dry-run'] ? result.frame : finish(result.frame, runDir));
    if (result.message) process.stderr.write(`${result.message}\n`); return result.exitCode;
  } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`${error.message}\n`); return 1; }
    emit(faultFrame(command.command === 'start' ? '' : runDir, error instanceof Error ? error.message : String(error))); return 2;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
