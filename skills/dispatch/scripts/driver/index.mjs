/**
 * Driver entry router (R3): `dispatch.mjs --run <verb> …` and `--next --state <file> [--input <json>]`
 * each print exactly one compact JSON action. Holds no phase logic; phase modules own that.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_PROVIDERS, PROVIDER_ALIASES } from '../common.mjs';
import { LEVELS } from '../config.mjs';
import { KIND_NAMES } from '../review-kinds.mjs';
import { emitAction, validateReply } from './actions.mjs';
import { createRunState } from './state.mjs';
import { advanceReview, startReview } from './review-phase.mjs';
import { advanceImplement, startImplement } from './implement-phase.mjs';
import { readRunSidecar, readRunState } from './state.mjs';

const DISPATCH_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dispatch.mjs');
const VERBS = ['plan', 'design', 'review', 'implement'];
const LEVEL_SOURCES = ['explicit', 'classified'];
const VALUE_FLAGS = new Set([
  '--run', '--state', '--input', '--kind', '--phases', '--orchestrator', '--orchestrator-model',
  '--level', '--level-source', '--pins',
]);
const BOOLEAN_FLAGS = new Set(['--next', '--fix', '--verbose']);

export const DRIVER_FLAGS = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];

export const DRIVER_HELP = `Driver (script-driven phases; each call prints one JSON action):
  --run <verb>                ${VERBS.join('|')} (design becomes available in v0.5 I05)
  --kind <kind>               Review kind: ${KIND_NAMES.join('|')} (default: inferred from the argument)
  --fix                       Apply accepted fixes (review is report-only by default)
  --phases from:<phase>       Start phase for implement (not accepted by review)
  --next                      Advance a run; requires --state
  --state <file>              State file named by the previous action's stateFile
  --input <json|@file>        Reply to the previous action (omit for launch)
  --verbose                   Add report bodies and diagnostics to actions
  -- <argument>               Review target: plan/design/walkthrough path or Git range
`;

class UsageError extends Error {}

/** True when argv (before `--`) asks for the driver. */
export function isDriverInvocation(args) {
  const separator = args.indexOf('--');
  return (separator === -1 ? args : args.slice(0, separator)).some((arg) => arg === '--run' || arg === '--next' || arg.startsWith('--run='));
}

function parseDriverArgs(args) {
  const out = { fix: false, next: false, verbose: false, argument: null };
  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    if (raw === '--') {
      const rest = args.slice(index + 1);
      if (rest.length > 1) throw new UsageError('Pass exactly one argument after --.');
      out.argument = rest[0] ?? null;
      break;
    }
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq !== -1 ? raw.slice(0, eq) : raw;
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOLEAN_FLAGS.has(flag)) {
      out[key] = true;
    } else if (VALUE_FLAGS.has(flag)) {
      const value = eq !== -1 && flag !== raw ? raw.slice(eq + 1) : args[++index];
      if (value === undefined || (value.startsWith('--') && flag !== '--input')) throw new UsageError(`${flag} requires a value.`);
      if (out[key] !== undefined) throw new UsageError(`${flag} given twice.`);
      out[key] = value;
    } else {
      throw new UsageError(`Unknown driver argument "${raw}".`);
    }
  }
  return out;
}

function normalizeOrchestrator(raw) {
  const lower = String(raw ?? '').toLowerCase();
  const key = PROVIDER_ALIASES[lower] ?? lower;
  if (!KNOWN_PROVIDERS.includes(key)) {
    throw new UsageError(`--orchestrator must be one of ${KNOWN_PROVIDERS.join(', ')}.`);
  }
  return key;
}

/** Normalized `--run` invocation, recorded in the sidecar. */
function normalizeRun(parsed) {
  if (!VERBS.includes(parsed.run)) throw new UsageError(`--run must be one of ${VERBS.join('|')}.`);
  if (!['review', 'plan', 'implement'].includes(parsed.run)) {
    throw new UsageError(`--run ${parsed.run} is not available until v0.5 I05.`);
  }
  if (parsed.state || parsed.input !== undefined) throw new UsageError('--state and --input belong to --next.');
  if (parsed.phases !== undefined && parsed.run !== 'implement') throw new UsageError('--phases is not accepted by this run.');
  if (['plan', 'implement'].includes(parsed.run) && !parsed.argument?.trim()) throw new UsageError(`${parsed.run} requires an ask or canonical plan path after --.`);
  if (parsed.phases !== undefined && !/^from:(?:plan|plan-review|baseline|implementation|code-review|handoff)$/.test(parsed.phases)) throw new UsageError('--phases requires exactly one from:<ordinary-phase>.');
  if (!parsed.orchestrator) throw new UsageError('--run requires --orchestrator <platform>.');
  if (parsed.kind !== undefined && !KIND_NAMES.includes(parsed.kind)) {
    throw new UsageError(`--kind must be one of ${KIND_NAMES.join('|')}.`);
  }
  if (parsed.levelSource !== undefined) {
    if (parsed.level === undefined) throw new UsageError('--level-source requires --level.');
    if (!LEVEL_SOURCES.includes(parsed.levelSource)) throw new UsageError(`--level-source must be ${LEVEL_SOURCES.join('|')}.`);
  }
  if (parsed.level !== undefined && !LEVELS.includes(parsed.level)) throw new UsageError(`--level must be one of ${LEVELS.join('|')}.`);
  return {
    verb: parsed.run,
    kind: parsed.kind ?? null,
    argument: parsed.argument,
    fix: parsed.fix,
    orchestrator: normalizeOrchestrator(parsed.orchestrator),
    orchestratorModel: parsed.orchestratorModel ?? null,
    level: parsed.level ?? 'medium',
    levelSource: parsed.level === undefined ? 'default' : (parsed.levelSource ?? 'explicit'),
    phases: parsed.phases ?? null,
    pins: parsed.pins ?? null,
    verbose: parsed.verbose,
  };
}

const quote = (value) => (/[\s"']/.test(value) ? JSON.stringify(value) : value);

/** The exact `--run` command that resumes (or relaunches) a recorded invocation. */
export function resumeCommand(invocation) {
  const parts = ['node', quote(DISPATCH_SCRIPT), '--run', invocation.verb];
  if (invocation.kind) parts.push('--kind', invocation.kind);
  if (invocation.fix) parts.push('--fix');
  if (invocation.phases) parts.push('--phases', invocation.phases);
  if (invocation.levelSource !== 'default') parts.push('--level', invocation.level, '--level-source', invocation.levelSource);
  if (invocation.pins) parts.push('--pins', quote(invocation.pins));
  parts.push('--orchestrator', invocation.orchestrator);
  if (invocation.orchestratorModel) parts.push('--orchestrator-model', quote(invocation.orchestratorModel));
  if (invocation.argument) parts.push('--', quote(invocation.argument));
  return parts.join(' ');
}

function readInput(raw) {
  if (raw === undefined) return undefined;
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--input is not valid JSON: ${err.message}`);
  }
}

async function next(parsed) {
  if (!parsed.state) throw new UsageError('--next requires --state <file>.');
  // Serialize replies, including review subprocess completion, before reading the cached transition.
  try { readRunState(parsed.state); } catch { return advanceLocked(parsed); }
  const lock = `${path.resolve(parsed.state)}.advance.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') throw new UsageError(`Driver advance lock exists at ${lock}; verify no process owns it, then remove the stale lock and resume with --next.`);
    throw error;
  }
  try { return await advanceLocked(parsed); }
  finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
function advanceLocked(parsed) {
  let state;
  try {
    state = readRunState(parsed.state);
  } catch (err) {
    const invocation = readRunSidecar(parsed.state);
    throw new UsageError(invocation
      ? `${err.message} Resume the run with: ${resumeCommand(invocation)}`
      : err.message);
  }
  const expected = state.pending;
  if (!expected || expected.action === 'done') throw new UsageError('This run has finished; start a new one with --run.');
  const reply = readInput(parsed.input);
  const checked = validateReply(expected.action, reply);
  // An invalid reply re-emits the pending action unchanged; state does not advance.
  if (!checked.ok) return { ...expected, error: checked.errors.join('; ') };
  return ['implement', 'plan'].includes(state.invocation?.verb)
    ? advanceImplement(state, checked.value)
    : advanceReview(state, checked.value);
}

/**
 * Runs one driver step. Returns the process exit code: 0 with one JSON action on stdout, 2 with a
 * usage or state diagnostic on stderr.
 */
export async function runDriver(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const parsed = parseDriverArgs(argv);
    let action;
    if (parsed.next) {
      if (parsed.run !== undefined) throw new UsageError('--run and --next are exclusive.');
      action = await next(parsed);
    } else {
      const invocation = normalizeRun(parsed);
      action = ['implement', 'plan'].includes(invocation.verb)
        ? await startImplement({ invocation, cwd, dispatchScript: DISPATCH_SCRIPT, resumeCommand: resumeCommand(invocation) })
        : await startReview({ invocation, cwd, dispatchScript: DISPATCH_SCRIPT, resumeCommand: resumeCommand(invocation) });
    }
    stdout.write(`${JSON.stringify(action)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`[dispatch driver] ${err.message}\n`);
    return 2;
  }
}
