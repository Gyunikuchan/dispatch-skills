/**
 * Test support for the v0.5 script driver (`dispatch.mjs --run` / `--next`).
 *
 * A scripted agent drives a stub-runner copy of the dispatch skill (see stub-dispatch.mjs)
 * over a throwaway Git repository. It records every argv it issues (AC1): driver calls, each
 * `launch` argv, and each host verify command.
 *
 * Driver action contract pinned here (schema `v: 1`):
 * - every action: `{ v: 1, action, stateFile, guidance: string[], error? }`;
 * - `launch`: `{ argv: string[], wave: { type: 'review'|'rebuttal'|'final', round }, keys? }`
 *   (`keys` lists the pending resolution-log keys on a rebuttal wave);
 * - `native-fallback`: `{ slot, promptPath, outputPath }`;
 * - `adjudicate`: `{ round, findings: [{ key, severity, locus, tag, defect, requiredChange,
 *   sourceKeys, restate?, reportPath? }] }`;
 * - `ask-user`: `{ question: 'rulings'|'opt-in'|'inputs', text, items?, missing? }`;
 * - `apply-fixes`: `{ clusters: [{ clusterId, findingIds, affectedPaths, verification }] }`;
 * - `verify`: `{ commands: string[], argv?, resultsPath? }` — with `argv` the driver runs the gate
 *   (`--verify`); the harness simulates that runner from `policy.verify` results unless the policy
 *   sets `realVerify`, then replies with only the policy's `criterionEvidence`;
 * - `author`: `{ path, template, defects }`;
 * - `done`: `{ outcome: 'complete'|'skipped'|'refused'|'failed'|'no-reviewable-changes'|'lint-defects',
 *   summary, reason?, command?, defects?, checkpointed? }`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ORCHESTRATOR_ENV } from './stub-dispatch.mjs';
import { scanResolutionLog } from '../../skills/dispatch/scripts/resolution-log.mjs';
import { materializedFingerprint } from '../../skills/dispatch/scripts/git-state.mjs';
import { captureRepositoryState } from '../../skills/dispatch/scripts/verification-evidence.mjs';

export const DRIVER_ACTIONS = Object.freeze([
  'ask-user', 'author', 'launch', 'native-fallback', 'adjudicate', 'apply-fixes', 'delegate-write', 'verify', 'done',
]);

// SECTION: fixtures

export const PLAN_BODY = [
  '# Plan',
  '',
  '## Success Criteria',
  '',
  '- [SC1] Implement and verify the sample.',
  '  - Changes: `src/app.js`',
  '  - Verify: `node --test tests/sample.test.mjs`',
  '  - Evidence: red',
  '  - Test rationale: Behavioral failure isolates the sample outcome and protects its regression.',
  '',
  '## Proposed Changes',
  '',
  '#### [MODIFY] src/app.js',
  '',
  '- First.',
  '',
  '## Verification Plan',
  '',
  '### Automated Tests',
  '',
  '- `node --test tests/sample.test.mjs`',
  '',
  '## Review Findings & Resolutions',
  '',
  '*No reviews conducted yet.*',
  '',
].join('\n');

const DESIGN_FIELDS = ['Outcome', 'Scope', 'Non-scope', 'Observable behavior', 'Affected contracts', 'Validation', 'Rollback boundary', 'Parallel safety'];

export const DESIGN_BODY = [
  '# Design',
  '',
  '## Context & Intent',
  'x',
  '## Goals & Requirements',
  'x',
  '## Increment Details',
  ['### I01', ...DESIGN_FIELDS.map((field) => `- ${field}: x`)].join('\n'),
  '## Final Integration',
  'x',
  '',
  '## Architecture & Boundaries',
  'A.',
  '',
  '## Alternatives & Decisions',
  'B.',
  '',
  '## Risks, Security & Operations',
  'C.',
  '',
  '## Increment Dependency Graph',
  '| ID | Priority | Summary | Prerequisites | Paths |',
  '| --- | ---: | --- | --- | --- |',
  '| I01 | 1 | Base | none | src/base.js |',
  '',
  '## Execution Status',
  'Ready.',
  '',
  '## Review Findings & Resolutions',
  '*No reviews conducted yet.*',
  '',
].join('\n');

/**
 * A temp Git repo with `src/app.js` committed, on a unique branch: the branch names the artifact
 * slug, and a shared slug could resolve to another test's relocated walkthrough in OS temp.
 */
export function makeGitRepo({ dirty = false } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'driver-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', `driver-${path.basename(dir).slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.scratch', 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const value = 1;\n');
  git('add', 'src/app.js');
  git('commit', '--no-gpg-sign', '-qm', 'initial');
  if (dirty) fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const value = 2;\n');
  return { dir, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function writePlan(repoDir, name = '2026-09-22-sample.md', body = PLAN_BODY) {
  const file = path.join(repoDir, '.scratch', 'plan', name);
  fs.writeFileSync(file, body);
  return file;
}

export function writeDesign(repoDir, name = '2026-09-22-sample-design.md', body = DESIGN_BODY) {
  const file = path.join(repoDir, '.scratch', 'plan', name);
  fs.writeFileSync(file, body);
  return file;
}

export function implementationOutcome({
  status = 'DONE',
  stage = 'COMPLETE',
  summary = 'fixture implementation completed',
  evidence = ['fixture evidence'],
  ...extra
} = {}) {
  return { schemaVersion: 1, status, stage, summary, evidence, ...extra };
}

export function actionNames(trace) {
  return trace.map(({ action }) => action);
}

export function artifactSnapshot(repoDir) {
  const root = path.join(repoDir, '.scratch', 'plan');
  if (!fs.existsSync(root)) return {};
  return Object.fromEntries(fs.readdirSync(root).sort().map((name) => [
    name,
    fs.readFileSync(path.join(root, name), 'utf8')
      .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
      .replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>'),
  ]));
}

export function removeDriverState(action) {
  fs.rmSync(action.stateFile, { force: true });
}

export function walkthroughPath(repoDir) {
  const root = path.join(repoDir, '.scratch', 'plan');
  const names = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.endsWith('-walkthrough.md')) : [];
  assert.equal(names.length, 1, `expected one walkthrough, found: ${names.join(', ')}`);
  return path.join(root, names[0]);
}

// SECTION: stub reports

export function planFinding(overrides = {}) {
  return {
    severity: 'MUST',
    locus: '§ Verification Plan',
    tag: 'testability',
    defect: 'No failure-path test is named.',
    requiredChange: 'Name the failure-path test.',
    ...overrides,
  };
}

export function designFinding(overrides = {}) {
  return planFinding({ locus: '§ Architecture & Boundaries', tag: 'architecture', ...overrides });
}

export function codeFinding(overrides = {}) {
  return planFinding({ locus: 'src/app.js:L1', tag: 'correctness', defect: 'Value is wrong.', requiredChange: 'Fix the value.', ...overrides });
}

export const report = (findings = []) => JSON.stringify({ status: findings.length ? 'FINDINGS' : 'CLEAN', findings });

/** Stub results giving every provider the same stdout (or `{exit, failureKind}` overrides). */
export const allProviders = (stdout, extra = {}) => Object.fromEntries(
  ['claude', 'agy', 'copilot', 'opencode'].map((provider) => [provider, { stdout, ...extra }]),
);

export const rebuttal = (responses) => JSON.stringify({
  responses: responses.map(([key, verdict]) => ({ type: 'rebuttal', key, verdict, evidence: `§ Verification Plan supports the verdict on ${key}.` })),
});

// SECTION: process plumbing

function stubEnv({ results = {}, live = {}, extra = {} } = {}, logFile = null) {
  const env = { ...process.env };
  for (const key of ORCHESTRATOR_ENV) delete env[key];
  Object.assign(env, {
    DISPATCH_TELEMETRY: '0',
    DISPATCH_STUB_RESULTS: JSON.stringify(results),
    DISPATCH_STUB_LIVE: JSON.stringify(live),
    ...(logFile ? { DISPATCH_STUB_LOG: logFile } : {}),
    ...extra,
  });
  return env;
}

/** Spawns the fixture's dispatch.mjs in `cwd`. */
export function runDispatch(fixture, args, { cwd, results, live, env } = {}) {
  const res = spawnSync(process.execPath, [fixture.script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: stubEnv({ results, live, extra: env }),
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Asserts stdout is exactly one compact JSON line and returns the parsed action. */
export function parseAction(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  assert.equal(lines.length, 1, `expected exactly one stdout line, got:\n${stdout}`);
  assert.ok(!lines[0].includes('\n  '), 'action is compact JSON');
  const action = JSON.parse(lines[0]);
  assert.equal(action.v, 1);
  assert.ok(DRIVER_ACTIONS.includes(action.action), `unknown action ${action.action}`);
  assert.equal(typeof action.stateFile, 'string');
  assert.ok(Array.isArray(action.guidance), 'every action carries a guidance array');
  return action;
}

/** Runs a `launch` argv the way the agent would (background process, awaited) with stub results. */
export function runLaunch(fixture, argv, { cwd, results, live }) {
  const res = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: stubEnv({ results, live }, path.join(fixture.dir, 'stub-calls.jsonl')),
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function readLog(artifactPath) {
  return scanResolutionLog(fs.readFileSync(artifactPath, 'utf8'), { strict: true });
}

export function logEntries(artifactPath) {
  return readLog(artifactPath).rounds.flatMap((round) => round.entries.map((entry) => ({ ...entry, round: round.number })));
}

export function isDispatchArgv(argv) {
  return Array.isArray(argv) && argv.length >= 2 &&
    (argv[0] === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(argv[0])) &&
    path.basename(argv[1]) === 'dispatch.mjs';
}

// SECTION: scripted agent

/**
 * Default agent policy. Each hook may be overridden per test; hooks receive `(action, ctx)`.
 * `ctx` = { fixture, cwd, trace, argvLog, step, state } where `state` is scratch space for the test.
 */
const DEFAULT_POLICY = {
  // Stub results for a launch wave (the agent's background process); default: every slot CLEAN.
  waveResults: () => allProviders(report()),
  // `true` simulates a wave process that exited without writing its envelope.
  skipLaunch: () => false,
  launchReply: () => undefined,
  rule: (finding) => ({ status: 'accepted', scope: 'in-scope' }),
  fix: () => undefined,
  restate: () => null,
  askUser: (action) => {
    if (action.question === 'rulings') {
      return { answer: Object.fromEntries((action.items ?? []).map((item) => [item.key, 'accepted'])) };
    }
    if (action.question === 'opt-in') return { answer: 'none' };
    return { answer: { summary: 'Update the exported value', verification: { command: 'node --version', result: 'Passed' } } };
  },
  applyFixes: (action) => ({
    clusters: action.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied', paths: cluster.affectedPaths, note: 'edited' })),
  }),
  delegateWrite: (action) => ({ envelope: implementationOutcome({
    stage: action.fields?.stage === 'tests-only' ? 'RED_READY' : 'COMPLETE',
    summary: `${action.fields?.stage ?? 'production'} fixture completed`,
    evidence: [`attempt:${action.fields?.attempt ?? 1}`],
  }) }),
  verify: (action) => ({ results: action.commands.map((command) => ({
    command,
    exit: action.purpose === 'red' ? 1 : 0,
    evidence: action.purpose === 'red' ? 'test:SC1 expected RED after tests-only mutation' : 'ok',
    scopeHash: action.scopeHash,
    mutationEpoch: action.mutationEpoch,
  })) }),
  nativeFallback: (action) => {
    fs.writeFileSync(action.outputPath, report());
    return { slot: action.slot, captured: true, actual: {
      agentType: action.descriptor.agentType,
      model: action.descriptor.model,
      reasoningEffort: action.descriptor.reasoningEffort,
    } };
  },
  author: () => { throw new Error('unexpected author action'); },
};

function defaultRuling(finding, policy, action, ctx) {
  if (finding.restate) {
    const restated = policy.restate(finding, action, ctx);
    assert.ok(restated, 'test must restate prose findings');
    return { key: finding.key, ...restated };
  }
  const ruling = {
    key: finding.key,
    severity: finding.severity,
    scope: 'in-scope',
    locus: finding.locus,
    tag: finding.tag,
    defect: finding.defect,
    resolution: 'Verified against the artifact.',
    ...policy.rule(finding, action, ctx),
  };
  const fix = policy.fix(finding, action, ctx);
  if (fix) ruling.fix = fix;
  return ruling;
}

function writeInput(fixture, value) {
  const file = path.join(fixture.dir, `input-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return `@${file}`;
}

/**
 * Drives one run to `done`. Returns `{ trace, argvLog, done }`.
 * `argvLog` holds every argv the agent issued: driver invocations, launch argv, and verify commands
 * (recorded as `['<verify>', command]`).
 */
export function drive(fixture, {
  cwd,
  runArgs,
  policy: overrides = {},
  maxSteps = 80,
  onAction = null,
  restartWhen = null,
  state = {},
}) {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  const trace = [];
  const argvLog = [];
  const ctx = { fixture, cwd, trace, argvLog, state, step: 0, restarts: 0 };
  const invoke = (args) => {
    argvLog.push([process.execPath, fixture.script, ...args]);
    const res = runDispatch(fixture, args, { cwd });
    assert.equal(res.status, 0, `dispatch ${args.join(' ')} failed: ${res.stderr}`);
    return parseAction(res.stdout);
  };
  let action = invoke(['--run', ...runArgs]);
  for (; ctx.step < maxSteps; ctx.step++) {
    trace.push(action);
    onAction?.(action, ctx);
    if (restartWhen?.(action, ctx)) {
      removeDriverState(action);
      ctx.restarts += 1;
      action = invoke(['--run', ...runArgs]);
      continue;
    }
    if (action.action === 'done') return { trace, argvLog, done: action, restarts: ctx.restarts };
    let input;
    switch (action.action) {
      case 'launch': {
        assert.ok(isDispatchArgv(action.argv), `launch argv must be a dispatch.mjs invocation: ${JSON.stringify(action.argv)}`);
        if (!action.replyOnly && !policy.skipLaunch(action, ctx)) {
          argvLog.push(action.argv);
          const res = runLaunch(fixture, action.argv, { cwd, results: policy.waveResults(action, ctx) });
          ctx.lastLaunch = res;
        }
        input = action.earlyFallbacks ? policy.launchReply(action, ctx) ?? { earlyFallbacks: [] } : undefined;
        break;
      }
      case 'adjudicate':
        input = { rulings: action.findings.map((finding) => defaultRuling(finding, policy, action, ctx)) };
        break;
      case 'ask-user':
        input = policy.askUser(action, ctx);
        break;
      case 'apply-fixes':
        input = policy.applyFixes(action, ctx);
        break;
      case 'delegate-write':
        input = policy.delegateWrite(action, ctx);
        break;
      case 'verify':
        if (!action.argv) for (const command of action.commands) argvLog.push(['<verify>', command]);
        input = verifyInput(action, policy, ctx, fixture, cwd);
        break;
      case 'native-fallback':
        input = policy.nativeFallback(action, ctx);
        break;
      case 'author':
        input = policy.author(action, ctx);
        break;
      default:
        throw new Error(`scripted agent cannot handle ${action.action}`);
    }
    const args = ['--next', '--state', action.stateFile];
    if (input !== undefined) args.push('--input', writeInput(fixture, input));
    action = invoke(args);
  }
  throw new Error(`run did not reach done within ${maxSteps} steps: ${trace.map((a) => a.action).join(' → ')}`);
}

// SECTION: driver-run verification

function repoSnapshot(cwd) {
  const capture = captureRepositoryState(cwd);
  capture.entries = Object.fromEntries(Object.entries(capture.entries).filter(([file]) => !file.startsWith('.scratch/')));
  return capture;
}

/** Decorates a driver-run verify action with the per-command scope hashes its evidence must cite. */
function decorateVerify(action, cwd) {
  const state = JSON.parse(fs.readFileSync(action.stateFile, 'utf8'));
  const data = state.ordinary, pending = data.verification;
  const scopeHashes = Object.fromEntries(pending.commands.map((command) => [command, materializedFingerprint(cwd, data.scopes?.[command] ?? data.approvedPaths).digest]));
  action.scopeHashes = scopeHashes;
  action.scopeHash = scopeHashes[pending.commands[0]];
  return pending;
}

/** Writes the results file the `--verify` runner would, from policy-supplied per-command results. */
function simulateVerify(action, pending, reply, cwd) {
  const original = Object.fromEntries(Object.entries(pending.substitutions ?? {}).map(([from, to]) => [to, from]));
  const results = pending.commands.map((command) => {
    const ran = pending.substitutions?.[command] ?? command;
    const given = reply.results.find((item) => item.command === ran || item.command === command || original[item.command] === command) ?? { exit: 0 };
    return {
      command, ran, exit: given.exit, counts: null, identifiers: given.identifiers ?? [],
      diagnostic: given.exit === 0 ? '' : String(given.diagnostic ?? given.evidence ?? ''), logPath: '',
      scopeHash: given.scopeHash ?? action.scopeHashes[command], mutationEpoch: given.mutationEpoch ?? action.mutationEpoch, changed: [],
    };
  });
  const record = { v: 1, token: pending.token, purpose: pending.purpose, results, generated: [], mutationEpoch: action.mutationEpoch, final: repoSnapshot(cwd) };
  fs.writeFileSync(action.resultsPath, `${JSON.stringify(record)}\n`);
}

function verifyInput(action, policy, ctx, fixture, cwd) {
  if (!action.argv) return policy.verify(action, ctx);
  const pending = decorateVerify(action, cwd);
  if (policy.realVerify) {
    ctx.argvLog.push(action.argv);
    const res = runDispatch(fixture, action.argv.slice(2), { cwd });
    assert.equal(res.status, 0, `verify runner failed: ${res.stderr}`);
    ctx.lastVerify = JSON.parse(res.stdout.trim().split('\n').at(-1));
    for (const result of ctx.lastVerify.results) action.scopeHashes[result.command] = result.scopeHash;
    action.scopeHash = ctx.lastVerify.results[0]?.scopeHash;
    const reply = policy.verify(action, ctx) ?? {};
    const evidence = reply.criterionEvidence ?? (reply.results ?? []).flatMap((item) => item.criterionEvidence ?? []);
    return evidence.length ? { criterionEvidence: evidence } : undefined;
  }
  for (const command of action.commands) ctx.argvLog.push(['<verify>', command]);
  const reply = policy.verify(action, ctx);
  if (reply?.criterionEvidence && !reply.results) return { criterionEvidence: reply.criterionEvidence };
  simulateVerify(action, pending, reply, cwd);
  const evidence = reply.criterionEvidence ?? reply.results.flatMap((item) => item.criterionEvidence ?? []);
  return evidence.length ? { criterionEvidence: evidence } : undefined;
}

/** AC1: every recorded command is a dispatch.mjs invocation or a host verify command. */
export function assertOnlyDispatchArgv(argvLog) {
  for (const argv of argvLog) {
    if (argv[0] === '<verify>') continue;
    assert.ok(isDispatchArgv(argv), `non-dispatch command issued: ${JSON.stringify(argv)}`);
  }
}

export function readBatchFile(argv) {
  const index = argv.indexOf('--batch-file');
  assert.ok(index > 0, 'launch argv carries --batch-file');
  return JSON.parse(fs.readFileSync(argv[index + 1], 'utf8'));
}
