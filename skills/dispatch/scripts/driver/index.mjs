// @ts-check
/**
 * Driver entry router (R3): `dispatch.mjs --run <verb> …` and `--next --state <file> [--input <json>]`
 * each print exactly one compact JSON action. Holds no phase logic; phase modules own that.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { requireToplevel } from '../lib/git-root.mjs';
import { KNOWN_PROVIDERS, PROVIDER_ALIASES } from '../lib/providers.mjs';
import { CLASSIFIABLE_LEVELS, LEVELS, assertClassifiableLevel } from '../lib/config.mjs';
import { KIND_NAMES } from '../review/kinds.mjs';
import { getCurrentBranch, parseIncrementArtifactPath, resolveSlug, sanitizeSlug } from '../artifacts/resolve-paths.mjs';
import { bindWorkflowSession, openSession } from '../lib/session-temp.mjs';
import { DriverError, toError, validateReply } from './actions.mjs';
import { advanceReview, startReview } from './review-phase.mjs';
import { advanceImplement, startImplement } from './implement-phase.mjs';
import { advanceDesign, resumeDesignPath, startDesign } from './design-phase.mjs';
import { advanceAsk, startAsk } from './ask-phase.mjs';
import { inferReviewKind } from './review-policy.mjs';
import { save } from './implement-state.mjs';
import { bindStateSession, createRunState, gitRoot, readRunSidecar, readRunState, resumeCommand, writeRunSidecar } from './state.mjs';

export { resumeCommand };

// SECTION: CLI contract

const DISPATCH_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dispatch.mjs');
const VERBS = ['ask', 'design', 'plan', 'review', 'implement'];
const LEVEL_SOURCES = ['explicit', 'classified'];
const VALUE_FLAGS = new Set([
  '--run', '--state', '--input', '--kind', '--phases', '--orchestrator', '--orchestrator-model',
  '--level', '--level-source', '--pins', '--check-envelope',
]);
const BOOLEAN_FLAGS = new Set(['--next', '--drive', '--fix', '--verbose', '--verify']);

export const DRIVER_FLAGS = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];

export const DRIVER_HELP = `Driver (script-driven phases; each call prints one JSON action):
  --run <verb>                ${VERBS.join('|')} (design authoring and increment execution supported)
  --kind <kind>               Review kind: ${KIND_NAMES.join('|')} (default: inferred from the argument)
  --fix                       Apply accepted fixes (review is report-only by default)
  --phases from:<phase>       Start phase for implement (not accepted by review)
  --next                      Advance a run; requires --state
  --drive                     Like --next, then run each launch (no early fallbacks) and verify argv and
                              advance until an action needs the host; prints only that action
  --verify                    Run the pending verify action's commands; requires --state
  --check-envelope <file>     Check the pending delegate-write's expected envelope file;
                              requires --state; exits 1 listing each defect
  --state <file>              State file named by the previous action's stateFile
  --input <json|@file>        Reply to the previous action (omit for launch)
  --orchestrator <platform>   Orchestrating platform (required with --run)
  --orchestrator-model <model> Orchestrator's own model, excluded from its platform's targets
  --level <level>             Effort level: ${LEVELS.join('|')}
  --level-source <source>     How the level was chosen: ${LEVEL_SOURCES.join('|')} (classified: ${CLASSIFIABLE_LEVELS.join('|')})
  --pins <pins>               Provider names, a count, or all (comma-separated)
  --verbose                   Add report bodies and diagnostics to actions
  -- <argument>               Artifact path, Git range, or the ask question
`;

// Named so toError classifies it as `reply` without importing this module.
class UsageError extends Error { name = 'UsageError'; }

/** Fills `out` as it parses, so a later failure still exposes the flags consumed before it. */
function parseDriverArgs(args, out = /** @type {any} */ ({})) {
  Object.assign(out, { fix: false, next: false, verbose: false, argument: null });
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
  if (parsed.state || parsed.input !== undefined) throw new UsageError('--state and --input belong to --next.');
  if (parsed.phases !== undefined && parsed.run !== 'implement') throw new UsageError('--phases is not accepted by this run.');
  if (['ask', 'design', 'plan', 'implement'].includes(parsed.run) && !parsed.argument?.trim()) throw new UsageError(`${parsed.run} requires an ask or canonical artifact path after --.`);
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
  try {
    assertClassifiableLevel(parsed.level, parsed.levelSource);
  } catch (error) {
    throw new UsageError(error.message);
  }
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

function readInput(raw) {
  if (raw === undefined) return undefined;
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--input is not valid JSON (pass inline JSON or @<file>): ${err.message}`);
  }
}

function artifactSlug(value, kind, repoRoot) {
  const absolute = path.resolve(repoRoot, String(value ?? ''));
  if (fs.existsSync(absolute)) {
    try {
      const source = fs.readFileSync(absolute, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
      const metadata = frontmatter ? JSON.parse(frontmatter)?.dispatch : null;
      if (typeof metadata?.slug === 'string' && metadata.slug) return metadata.slug;
    } catch { /* NOTE: the filename remains a deterministic fallback for uncheckpointed artifacts. */ }
  }
  const base = path.basename(String(value ?? '')).replace(/\.md$/i, '');
  const withoutKind = base.replace(/\.(?:spec|design|plan|walkthrough)$/i, '');
  return sanitizeSlug(withoutKind)?.slice(0, 60) ?? null;
}

/** Binds a governed invocation before it can resolve any artifact or ledger path. */
function bindInvocationSession(invocation, cwd) {
  const repoRoot = path.resolve(gitRoot(cwd));
  let artifactKind = 'plan', slug = null;
  if (invocation.verb === 'design' || (invocation.verb === 'implement' && /\.design\.md$/i.test(invocation.argument ?? ''))) {
    artifactKind = 'design';
    slug = /\.md$/i.test(invocation.argument ?? '') ? artifactSlug(invocation.argument, 'design', repoRoot) : sanitizeSlug(invocation.argument)?.slice(0, 60);
  } else if (invocation.verb === 'review') {
    const inferred = invocation.kind
      ? { kind: invocation.kind, ...(invocation.argument ? { artifactPath: invocation.argument } : {}) }
      : inferReviewKind(invocation.argument, { cwd });
    const artifactPath = 'artifactPath' in inferred ? inferred.artifactPath : undefined;
    const walkthroughPath = 'walkthroughPath' in inferred ? inferred.walkthroughPath : undefined;
    if (inferred.kind === 'design') {
      artifactKind = 'design';
      slug = artifactSlug(artifactPath ?? invocation.argument, 'design', repoRoot);
    } else if (inferred.kind === 'plan') {
      artifactKind = 'plan';
      slug = artifactSlug(artifactPath ?? invocation.argument, 'plan', repoRoot);
    } else {
      const target = walkthroughPath ?? (/\.md$/i.test(invocation.argument ?? '') ? invocation.argument : null);
      const increment = target ? parseIncrementArtifactPath(path.relative(repoRoot, path.resolve(repoRoot, target)).split(path.sep).join('/')) : null;
      if (increment) {
        artifactKind = 'design';
        slug = increment.designRootSlug;
      } else {
        artifactKind = 'plan';
        slug = target ? artifactSlug(target, 'plan', repoRoot) : null;
        if (!slug) slug = resolveSlug({ branch: getCurrentBranch(repoRoot), orchestrator: invocation.orchestrator }).slug;
      }
    }
  } else {
    slug = /\.md$/i.test(invocation.argument ?? '')
      ? artifactSlug(invocation.argument, 'plan', repoRoot)
      : sanitizeSlug(invocation.argument ?? '')?.slice(0, 60);
  }
  slug ??= artifactKind === 'design' ? 'design' : invocation.verb === 'plan' ? 'implementation' : `workflow-${crypto.createHash('sha256').update(String(invocation.argument ?? invocation.verb)).digest('hex').slice(0, 12)}`;
  return bindWorkflowSession({ repositoryRoot: repoRoot, artifactKind, artifactPath: invocation.argument, slug, objective: invocation.argument ?? invocation.verb });
}

async function next(parsed) {
  if (!parsed.state) throw new UsageError('--next requires --state <file>.');
  bindStateSession(parsed.state);
  // Serialize replies, including review subprocess completion, before reading the cached transition.
  try { readRunState(parsed.state); } catch { return advanceLocked(parsed); }
  const lock = `${path.resolve(parsed.state)}.advance.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') throw new DriverError('state', `Driver advance lock exists at ${lock}.`, 'verify no process owns it, then remove the stale lock and resume with --next.');
    throw error;
  }
  try { return await advanceLocked(parsed); }
  finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
async function advanceLocked(parsed) {
  let state;
  try {
    state = readRunState(parsed.state);
  } catch (err) {
    const invocation = readRunSidecar(parsed.state);
    if (!invocation && err?.code === 'STATE_UNREADABLE') throw new DriverError('state', err.message, "check that --state names this run's state.json, or start a new run with --run.");
    if (!invocation) throw err;
    throw new DriverError('state', err.message, `Resume the run with: ${resumeCommand(invocation)}`);
  }
  const expected = state.pending;
  if (!expected || expected.action === 'done') throw new UsageError('This run has finished; start a new one with --run.');
  const reply = readInput(parsed.input);
  if (expected.action === 'delegate-write' && !expected.fields?.expectedEnvelopePath) throw new UsageError('Pending delegate-write has no expected envelope path.');
  const checked = validateReply(expected.action, reply);
  // An invalid reply re-emits the pending action unchanged; state does not advance.
  if (!checked.ok) return { ...expected, error: { kind: 'reply', message: checked.errors.join('; ') } };
  if (expected.action === 'ask-user' && (reply?.extend === true || reply?.stop === true) && !expected.options?.includes(reply.extend ? 'extend' : 'stop')) {
    return { ...expected, error: { kind: 'reply', message: `${reply.extend ? 'extend' : 'stop'} is only available at the round cap.` } };
  }
  if (state.invocation?.verb === 'ask') return advanceAsk(state, checked.value);
  if (state.invocation?.verb === 'design') return advanceDesign(state, checked.value).then((action) => save(state, action));
  if (state.designPath) return advanceImplement(state, checked.value);
  return ['implement', 'plan'].includes(state.invocation?.verb)
    ? advanceImplement(state, checked.value)
    : advanceReview(state, checked.value);
}

/**
 * Runs one driver step (or a `--drive` run of steps). Returns the process exit code: 0 with one JSON
 * action on stdout, 2 with a usage or state diagnostic on stderr.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [options]
 */
export async function runDriver(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  /** @type {any} */
  const parsed = {};
  try {
    parseDriverArgs(argv, parsed);
    let action;
    if (parsed.verify) {
      if (parsed.run !== undefined || parsed.next || parsed.input !== undefined) throw new UsageError('--verify takes only --state.');
      if (!parsed.state) throw new UsageError('--verify requires --state <file>.');
      const { runVerification } = await import('./verify-run.mjs');
      stdout.write(`${JSON.stringify(runVerification(parsed.state))}\n`);
      return 0;
    }
    if (parsed.checkEnvelope !== undefined) {
      if (parsed.run !== undefined || parsed.next || parsed.drive || parsed.input !== undefined) throw new UsageError('--check-envelope takes only --state.');
      if (!parsed.state) throw new UsageError('--check-envelope requires --state <file>.');
      const { checkEnvelope } = await import('./write.mjs');
      const result = checkEnvelope(parsed.state, parsed.checkEnvelope);
      stdout.write(`${JSON.stringify(result)}
`);
      return result.ok ? 0 : 1;
    }
    if (parsed.drive) {
      if (parsed.run !== undefined || parsed.next) throw new UsageError('--drive replaces --next and cannot start a run.');
      if (!parsed.state) throw new UsageError('--drive requires --state <file>.');
      const { drive } = await import('./drive.mjs');
      action = await drive(parsed, { advance: (state, input) => next({ ...parsed, state, input }), stderr });
    } else if (parsed.next) {
      if (parsed.run !== undefined) throw new UsageError('--run and --next are exclusive.');
      action = await next(parsed);
    } else {
      const invocation = { ...normalizeRun(parsed), terminalHandoff: true };
      if (invocation.verb === 'ask') {
        openSession({ repositoryRoot: path.resolve(cwd), objective: invocation.argument ?? invocation.verb });
        action = await startAsk({ invocation, cwd, resumeCommand: resumeCommand(invocation) });
      } else if (invocation.verb === 'design') {
        const repoRoot = requireToplevel(cwd);
        bindInvocationSession(invocation, cwd);
        const state = createRunState({ invocation, repoRoot, resumeCommand: resumeCommand(invocation), dispatchScript: DISPATCH_SCRIPT, ordinary: {}, pending: null });
        writeRunSidecar(state, invocation);
        action = save(state, startDesign(state));
      } else if (invocation.verb === 'implement' && invocation.argument?.endsWith('.design.md')) {
        const repoRoot = requireToplevel(cwd);
        bindInvocationSession(invocation, cwd);
        const state = createRunState({ invocation, repoRoot, resumeCommand: resumeCommand(invocation), dispatchScript: DISPATCH_SCRIPT, ordinary: {}, pending: null });
        writeRunSidecar(state, invocation);
        action = save(state, await resumeDesignPath(state));
      } else {
        bindInvocationSession(invocation, cwd);
        action = ['implement', 'plan'].includes(invocation.verb)
          ? await startImplement({ invocation, cwd, dispatchScript: DISPATCH_SCRIPT, resumeCommand: resumeCommand(invocation) })
          : await startReview({ invocation, cwd, dispatchScript: DISPATCH_SCRIPT, resumeCommand: resumeCommand(invocation) });
      }
    }
    stdout.write(`${JSON.stringify(action)}\n`);
    return 0;
  } catch (err) {
    // Fatal exits keep stdout empty and leave the persisted pending action untouched.
    const error = toError(err);
    // parsed holds what the parser consumed before any failure, so --state is named only when it was parsed.
    const stateArg = /** @type {any} */ (parsed).state;
    // One line per fatal exit: replace only line breaks, so paths with repeated spaces stay exact.
    const flat = (/** @type {unknown} */ text) => String(text).replace(/[\r\n\u2028\u2029]+/g, ' ');
    stderr.write(`[dispatch driver] ${error.kind}: ${flat(error.message)}${error.next ? ` | next: ${flat(error.next)}` : ''}${stateArg ? ` | state: ${flat(stateArg)}` : ''}\n`);
    return 2;
  }
}
