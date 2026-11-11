import type { HostUsageFs } from './host-usage/types.ts';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { currentPlatform, orchestratorFor, type Orchestrator } from '../lib/platform.ts';
import { createDiscovery } from '../providers/discovery.ts';
import { SPECS, isProviderId } from '../providers/index.ts';
import { runDelegate, sandboxBlocked } from '../providers/runner.ts';
import { nodeProcess, nodeRunnerFs } from '../providers/node-process.ts';
import { sanitizeText } from './domain/sanitize.ts';
import { createOpencodePreparePorts, nativeOpencodeIntrospection, resolveEffectiveOpencodeLaunch } from '../providers/opencode-runtime.ts';
import { normalizeProvider } from '../policy/roster.ts';
import type { DelegateRequest, LifecycleStep, ModeId, ProviderId, RunResult } from '../providers/types.ts';
import { verifyRun } from './verify.ts';
import { renderBrief, renderExplorerBrief, renderTestCleanupBrief, renderVerifierBrief } from './brief.ts';
import { create, submit, abandon } from './writers.ts';
import { integrate, continueIntegration, commit, abort } from './integrate.ts';
import { deliver, close, cleanup } from './deliver.ts';
import { readManifest, recordHost, type Manifest } from '../lib/session.ts';
import { stripBom } from '../lib/fs-ext.ts';
import { lintArtifact } from './lint.ts';
import { appendRecords, foldLedger, queryLedger } from './ledger.ts';
import { capSummary, summaryWithItems, ToolError, writeResult, type ToolResult } from './output.ts';
import { doctorReport } from './doctor.ts';
import { statusReport } from './status.ts';
import { askRun } from './ask.ts';
import { reviewRun } from './review.ts';
import { reportComplete, reportRender } from './report.ts';
import type { DiagnosticEvent } from './domain/diagnostics.ts';
import { diagnosticsRender, observeTool } from './diagnostics.ts';
import { refreshFindingsSection, rulingReview } from './review-findings.ts';
import { reviewId } from './confirmations.ts';

export type HandlerResult = { ok: boolean; summary: string; value: unknown; exit: number; reason?: string };
export type HandlerContext = { session: string; manifest: Manifest; args: string[]; values: Record<string, string | boolean | (string | boolean)[] | undefined>; deps: CliDeps };
export type CliDeps = {
  hostUsageFs?: HostUsageFs;
  diagnostics?: (event: DiagnosticEvent) => void;
  delegate: (provider: ProviderId, request: DelegateRequest, mode: ModeId) => Promise<RunResult>;
  modes: (provider: ProviderId) => readonly ModeId[];
  orchestrator: Orchestrator | null;
  liveness: Readonly<Record<string, boolean>>;
  sandboxSupported?: Readonly<Record<string, boolean>>;
  run: (argv: string[], options: {cwd: string; env?: NodeJS.ProcessEnv; stdin?: string}) => Promise<{exit: number; stdout: string; stderr: string}>;
  hook?: (point: string) => Promise<void> | void;
  stdout: (line: string) => void;
  env: NodeJS.ProcessEnv;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  pid: number;
  host: string;
  isAlive: (pid: number) => boolean;
  skillRoot: string;
  handler?: (context: HandlerContext) => Promise<HandlerResult>;
  writeResult?: typeof writeResult;
};

export function nodeDeps(): CliDeps {
  const platform = currentPlatform();
  const discovery = createDiscovery(SPECS, platform, {
    list: dir => { try {return fs.readdirSync(dir);}catch{return [];} }, exists:fs.existsSync,
    executable(file) {try{return fs.statSync(file).isFile() && (platform.os === 'win32' || (fs.statSync(file).mode & 0o111)!==0);}catch{return false;}},
  });
  const modes = (provider:ProviderId) => SPECS[provider].modes.filter(mode=>discovery.resolve(provider,mode.id).status==='path').map(mode=>mode.id);
  const runnerFs = nodeRunnerFs;
  return {
    modes, orchestrator:null,
    liveness:Object.fromEntries(Object.keys(SPECS).map(provider=>[provider,modes(provider as ProviderId).length>0])),
    sandboxSupported:Object.fromEntries(Object.entries(SPECS).map(([provider,spec])=>[provider,!sandboxBlocked(spec,true,platform)])),
    async delegate(provider,request,mode) {
      // Preflight steps belong to this call's first invocation only, never to a later retry or reserve call.
      const steps:LifecycleStep[]=[];
      let attached=false;
      const attach=(rows:RunResult['invocations'])=>{const first=rows[0];if(!attached&&first){attached=true;if(steps.length)first.lifecycleSteps=[...steps,...(first.lifecycleSteps??[])];}return rows;};
      const notify=(row:RunResult['invocations'][number])=>{attach([row]);try{request.onInvocation?.(row);}catch{}};
      const failedLaunch=(cls:'not-found'|'config'|'timeout',detail:string):RunResult=>{
        const row:RunResult['invocations'][number]={provider,model:request.model,mode,effort:request.effort,launched:false,outcome:cls};notify(row);
        return {outcome:{status:'fail',cls,detail},invocations:[row]};
      };
      const binary=discovery.resolve(provider,mode).path;
      if(!binary)return failedLaunch('not-found',provider+': missing '+mode);
      const deadline=Date.now()+request.timeoutMs;
      let resolved=request;
      // A blocked sandbox skips introspection so the runner gate refuses before any process starts.
      if(provider==='opencode'&&!sandboxBlocked(SPECS[provider],request.sandbox,platform)){
        try{resolved=await resolveEffectiveOpencodeLaunch(request,nativeOpencodeIntrospection(binary,request,process.env,request.timeoutMs,request.collectLifecycle?steps:undefined));}
        catch(error){const detail=String(error);return failedLaunch(/effective-config-unverified: opencode-lifecycle-timeout:/.test(detail)?'timeout':'config',detail);}
        if(resolved.readOnlyBestEffort)process.stderr.write('[dispatch] opencode: explore agent is not verified read-only (best effort)\n');
      }
      resolved={...resolved,timeoutMs:Math.max(1,deadline-Date.now()),...(request.onInvocation?{onInvocation:notify}:{})};
      try{
      const run=await runDelegate(SPECS[provider],resolved,mode,{
        process:nodeProcess,fs:runnerFs,env:process.env,platform,binary,nonce:crypto.randomUUID,workspaceRoot:request.cwd,
        clock:{now:()=>Date.now(),every:(ms,fn)=>{const timer=setInterval(fn,ms);return()=>clearInterval(timer);}},
        ...(provider==='opencode'?{prepare:createOpencodePreparePorts(deadline)}:{}),
      });
      attach(run.invocations);return run;
      }catch(error){attach((error as Partial<RunResult>).invocations??[]);throw error;}
    },
    run: (argv, options) => new Promise((resolve, reject) => {
      // cmd.exe must receive the plan command without Node's argument quoting.
      const child = spawn(argv[0]!, argv.slice(1), {cwd: options.cwd, env: {...process.env,...options.env}, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' && argv[0]!.toLowerCase() === 'cmd.exe', stdio: 'pipe'});
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', exit => resolve({exit: exit ?? 1,stdout,stderr}));
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
      child.stdin.end(options.stdin);
    }),
    stdout: (line) => { process.stdout.write(line); }, env: process.env, clock: () => Date.now(),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)), pid: process.pid, host: os.hostname(),
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
    skillRoot: fileURLToPath(new URL('../..', import.meta.url)),
  };
}

const handlers: Record<string, (context: HandlerContext) => Promise<HandlerResult>> = {
  'ask run': askRun,
  'review run': reviewRun,
  'report render': reportRender,
  'report complete': reportComplete,
  'diagnostics render': diagnosticsRender,
  'brief render': renderBrief,
  'brief explorer': renderExplorerBrief,
  'brief test-cleanup': renderTestCleanupBrief,
  'brief verifier': renderVerifierBrief,
  'worktree integrate': integrate,
  'worktree continue': continueIntegration,
  'worktree commit': commit,
  'worktree abort': abort,
  'worktree deliver': deliver,
  'worktree close': close,
  'worktree cleanup': cleanup,
  'worktree create': create,
  'worktree submit': submit,
  'worktree abandon': abandon,
  'verify run': verifyRun,
  'ledger append': async ({ session, manifest, args, deps }) => {
    if (args.length !== 1) throw new ToolError(1, 'invalid-input', 'ledger append takes one record file: ledger append <record.json> --session <session>');
    const file = path.resolve(args[0]!);
    let text: string;
    try {text = stripBom(fs.readFileSync(file, 'utf8'));}
    catch {throw new ToolError(1, 'invalid-input', 'Cannot read record file ' + file);}
    let input: unknown;
    try {input = JSON.parse(text);}
    catch (error) {throw new ToolError(1, 'invalid-input', 'Record file ' + file + ' is not valid JSON: ' + (error as SyntaxError).message);}
    let findingsSection: ReturnType<typeof refreshFindingsSection> | null = null;
    let findingsSectionReason: string | undefined;
    const appended = await appendRecords(session, input, deps, { onCommit: () => {
      const reviews = new Set<string>();
      for (const item of Array.isArray(input) ? input : [input]) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const data = record['data'];
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        // A bind that follows a review renders the rounds its refreshes skipped; a bind before any review leaves the artifact alone.
        if (record['kind'] === 'bind') {
          for (const kind of ['plan', 'design'] as const) {
            const relative = (data as Record<string, unknown>)[kind];
            if (typeof relative !== 'string') continue;
            const review = reviewId(kind, path.resolve(manifest.repositoryRoot, relative));
            if (fs.existsSync(path.join(session, '.state', 'reviews', review))) reviews.add(review);
          }
          continue;
        }
        if (record['kind'] !== 'ruling') continue;
        const subject = (data as Record<string, unknown>)['subject'];
        const review = typeof subject === 'string' ? rulingReview(subject) : null;
        if (review) reviews.add(review);
      }
      for (const review of reviews) {
        findingsSection = refreshFindingsSection(session, manifest, review, reason => { findingsSectionReason = reason; });
        if (findingsSection !== 'skipped') findingsSectionReason = undefined;
      }
    }});
    const value = {
      ...appended,
      ...(findingsSection ? { findingsSection, ...(findingsSectionReason ? { findingsSectionReason } : {}) } : {}),
    };
    const summary = Array.isArray(input)
      ? appended.count + ' records (last seq ' + appended.seq + (appended.deduped ? ', all deduped' : '') + ')'
      : 'seq ' + value.seq + (value.deduped ? ' deduped' : ' appended');
    return { ok: true, value, summary, exit: 0 };
  },
  'ledger query': async ({ session, values, args }) => {
    if (args.length) throw new ToolError(1, 'invalid-input', 'query takes only filters');
    const value = queryLedger(foldLedger(session), { kind: values['kind'], key: values['key'], since: values['since'] });
    return { ok: true, value, summary: value.length + ' records; last ' + JSON.stringify(value.at(-1) ?? null), exit: 0 };
  },
  'doctor run': async ({ session, manifest, values, args, deps }) => {
    if (args.length) throw new ToolError(1, 'invalid-input', 'doctor takes only options');
    const value = doctorReport(session, deps.skillRoot, values['level'], orchestratorFor(manifest.host, name => deps.env[name])?.platform ?? null, deps.liveness, deps.sandboxSupported);
    return { ok: value.ok, value, summary: JSON.stringify(value), exit: 0, ...(value.reason ? { reason: value.reason } : {}) };
  },
  'status show': async ({ session, manifest, args, deps }) => {
    if (args.length) throw new ToolError(1, 'invalid-input', 'status takes no arguments');
    const value = await statusReport(session, manifest.repositoryRoot, deps);
    return { ok: true, value, summary: JSON.stringify(value), exit: 0 };
  },
  'lint run': async ({ args, manifest }) => {
    if (args.length !== 1) throw new ToolError(1, 'invalid-input', 'artifact requires one path');
    const value = lintArtifact(path.resolve(args[0]!), { repositoryRoot: manifest.repositoryRoot });
    const ok = value.errors.length === 0;
    const items = [...value.errors, ...value.warnings].map(defect => 'L' + (defect.line ?? '-') + ' ' + defect.code + ': ' + defect.message);
    return { ok, value, summary: summaryWithItems(value.kind + ': ' + value.errors.length + ' errors, ' + value.warnings.length + ' warnings; ' + value.hash, items),
      exit: ok ? 0 : 4, ...(ok ? {} : { reason: 'lint-errors' }) };
  },
};

export const TOOL_ACTIONS = Object.keys(handlers);

export async function main(argv: string[], deps: CliDeps = nodeDeps()): Promise<number> {
  const print = (result: ToolResult) => {
    const { exit, ...output } = result;
    // Refusals name the toolkit.md section to read; argv (not parsed positionals) keeps a parse failure on a valid action pointed at its section.
    const help = output.ok || output.reason === 'native-pending' ? undefined : handlers[(argv[0] ?? '') + ' ' + (argv[1] ?? '')] ? argv[0] + ' ' + argv[1] : 'call table';
    deps.stdout(JSON.stringify({ ...output, summary: capSummary(output.summary), ...(help ? { help } : {}) }) + '\n');
    return exit;
  };
  let parsed: ReturnType<typeof parseArgs>;
  let session: string;
  let manifest: Manifest;
  let tool: string;
  let action: string;
  try {
    const args = argv.flatMap((arg, index) => arg === '--since' && /^-\d/.test(argv[index + 1] ?? '')
      ? [arg + '=' + argv[index + 1]] : index > 0 && argv[index - 1] === '--since' && /^-\d/.test(arg) ? [] : [arg]);
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      session: { type: 'string' }, level: { type: 'string' }, kind: { type: 'string' }, key: { type: 'string' }, since: { type: 'string' },
      'test-cleanup': {type: 'string'}, commit: {type: 'string'}, criteria: {type: 'string'}, reason: {type: 'string'}, 'review-fix': {type: 'string'}, 'ack-stale': {type: 'string'}, relaunch: {type: 'boolean'}, spec: {type: 'string'},
      'native-failed': {type: 'string', multiple: true}, host: {type: 'string'},
    } });
    [tool = '', action = ''] = parsed.positionals;
    if (!handlers[tool + ' ' + action]) throw new Error('Unknown tool or action');
    if (parsed.values['test-cleanup'] !== undefined && (tool !== 'worktree' || action !== 'commit')) throw new Error('--test-cleanup is only for worktree commit');
    if (parsed.values['commit'] !== undefined && (tool !== 'worktree' || action !== 'deliver')) throw new ToolError(1, 'invalid-input', '--commit is only for worktree deliver');
    const nativeFailedRaw = parsed.values['native-failed'];
    if (nativeFailedRaw !== undefined) {
      const isReviewOrAsk = (tool === 'review' && action === 'run') || (tool === 'ask' && action === 'run');
      if (!isReviewOrAsk) throw new ToolError(1, 'invalid-input', '--native-failed is only for review run and ask run');
      const entries = Array.isArray(nativeFailedRaw) ? nativeFailedRaw : [nativeFailedRaw];
      const sanitized: string[] = [];
      const hashes: string[] = [];
      for (const entry of entries) {
        if (typeof entry !== 'string') throw new ToolError(1, 'invalid-input', '--native-failed must be <attempt>=<reason>');
        const eq = entry.indexOf('=');
        if (eq <= 0) throw new ToolError(1, 'invalid-input', '--native-failed must be <attempt>=<reason>');
        const attempt = entry.slice(0, eq).trim();
        const rawReason = entry.slice(eq + 1);
        if (!attempt || !rawReason.trim()) throw new ToolError(1, 'invalid-input', '--native-failed must be <attempt>=<reason>');
        const rawTrimmed = rawReason.trim();
        // A BLOCKED reason hashes its extracted raw so a CLI report and a native reply share one identity.
        if (rawTrimmed.startsWith('BLOCKED:')) {
          const extracted = rawTrimmed.slice('BLOCKED:'.length).trim();
          const reason = 'BLOCKED: ' + (sanitizeText(extracted).slice(0, 200) || '(reason removed by sanitizer)');
          sanitized.push(`${attempt}=${reason}`);
          hashes.push(crypto.createHash('sha256').update(extracted).digest('hex'));
        } else {
          const reason = sanitizeText(rawTrimmed).slice(0, 200) || '(reason removed by sanitizer)';
          sanitized.push(`${attempt}=${reason}`);
          hashes.push(crypto.createHash('sha256').update(rawTrimmed).digest('hex'));
        }
      }
      parsed.values['native-failed'] = sanitized as never;
      (parsed.values as Record<string, unknown>)['native-failed-hash'] = hashes;
    }
    if (typeof parsed.values['session'] !== 'string') throw new Error('Missing --session');
    session = path.resolve(parsed.values['session']);
    manifest = readManifest(session);
    const hostSensitive = (tool === 'doctor' && action === 'run') || (tool === 'review' && action === 'run')
      || (tool === 'ask' && action === 'run') || (tool === 'brief' && (action === 'render' || action === 'explorer' || action === 'test-cleanup' || action === 'verifier'));
    const hostRaw = parsed.values['host'];
    if (hostSensitive) {
      if (typeof hostRaw !== 'string') throw new Error('Missing --host');
      const normalized = normalizeProvider(hostRaw);
      if (!isProviderId(normalized)) throw new Error(`Unknown --host; use ${Object.keys(SPECS).join(', ')}`);
      recordHost(session, normalized);
      manifest = { ...manifest, host: normalized };
    } else if (hostRaw !== undefined) {
      throw new Error('--host is only for doctor run, review run, ask run, brief render, brief explorer, brief test-cleanup and brief verifier');
    }
  } catch (error) {
    if (error instanceof ToolError) return print({ ok: false, summary: error.message, path: null, reason: error.reason, exit: error.exit });
    return print({ ok: false, summary: error instanceof Error ? error.message : String(error), path: null, reason: 'usage', exit: 1 });
  }
  const kind = typeof parsed.values['kind'] === 'string' ? parsed.values['kind']
    : parsed.positionals[2]?.endsWith('.plan.md') ? 'plan' : parsed.positionals[2]?.endsWith('.design.md') ? 'design' : undefined;
  // A recorded host builds the orchestrator; a copy keeps the caller's deps unmodified.
  deps = { ...deps, orchestrator: orchestratorFor(manifest.host, name => deps.env[name]) ?? deps.orchestrator };
  const observation = tool === 'report' || tool === 'diagnostics' ? undefined : observeTool(session, tool, action, kind, deps);
  let outcome: HandlerResult;
  try {
    outcome = await (deps.handler ?? handlers[tool + ' ' + action]!)({
      session, manifest, args: parsed.positionals.slice(2), values: parsed.values, deps: observation?.deps ?? deps,
    });
  } catch (error) {
    const fault = error instanceof ToolError ? error : new ToolError(2, 'fault', error instanceof Error ? error.message : String(error));
    outcome = { ok: false, summary: fault.message, reason: fault.reason, exit: fault.exit, value: { reason: fault.reason, message: fault.message } };
  }
  observation?.finish(outcome);
  try {
    const resultPath = (deps.writeResult ?? writeResult)(session, tool, action, outcome.value);
    const reason = outcome.reason ?? (outcome.ok && (tool === 'ask' || tool === 'review') ? 'complete' : undefined);
    return print({ ok: outcome.ok, summary: outcome.summary, path: resultPath, exit: outcome.exit, ...(reason ? { reason } : {}) });
  } catch (error) {
    return print({ ok: false, summary: error instanceof Error ? error.message : String(error), path: null, reason: 'fault', exit: 2 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
