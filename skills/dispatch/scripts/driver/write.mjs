// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadDispatchConfig } from '../lib/config.mjs';
import { currentHead } from '../lib/git-state.mjs';
import { resolveFlow } from '../lib/resolve-flow.mjs';
import { assembleTemplate, fillTemplate } from '../review/fill-template.mjs';
import { parseImplementationOutcome, resolveImplementationTransition } from '../verification/implementation-outcome.mjs';
import { emitAction, loadSchema, validateAgainstSchema } from './actions.mjs';
import { ledgerSegment } from './implement-state.mjs';
import { SKILL_ROOT } from './plan-phase.mjs';
import { bindStateSession, readRunState } from './state.mjs';
import { validateRedAdmission } from './verification.mjs';

// SECTION: Write target and validation

/** Resolves the configured write model cascade and escalation policy. */
export function resolveWrite(state) {
  const { config } = loadDispatchConfig({ skillRoot: SKILL_ROOT });
  const flow = resolveFlow({ platform: state.invocation.orchestrator, level: state.invocation.level, implementationFields: 'model,effort' }, {}, config);
  const resolved = flow.implementation;
  const models = Array.isArray(resolved.model) ? resolved.model : [resolved.model];
  if (models.some(model => typeof model !== 'string' || !model)) throw new Error('Configured write-subagent model is required.');
  const escalation = { ...resolved.escalation };
  const escalationModels = escalation.status === 'available' ? (Array.isArray(escalation.model) ? escalation.model : [escalation.model]) : [];
  if (escalationModels.length) escalation.model = escalationModels[0];
  return { ...resolved, escalation, escalationModels, models, candidate: 0 };
}
function testsOnlyManifest(data) {
  return data.redCriteria.map(({ id, title, paths, commands }) => ({ id, outcome: title, approvedTestPaths: paths.filter(file => data.testsOnlyPaths.includes(file)), commands, expected: 'RED for the stated observable with a stable failure identity' }));
}
// SECTION: writer self-check
// The brief names the exact `--check-envelope` command, so the writer repairs its own envelope
// instead of spending a relay round trip on a driver rejection.
function selfCheck(state, expectedEnvelopePath) {
  const quote = value => (/[\s"']/.test(value) ? JSON.stringify(value) : value);
  return {
    command: [process.execPath, state.dispatchScript, '--check-envelope', expectedEnvelopePath, '--state', state.stateFile].map(quote).join(' '),
  };
}
/** Production criteria lacking a `CRITERION SC# | … <owned path> …` evidence row. */
export function missingTrace(criteria, envelope) {
  const rows = envelope?.evidence?.filter(item => typeof item === 'string' && item.startsWith('CRITERION ')) ?? [];
  return criteria.filter(criterion => !rows.some(row => row.startsWith(`CRITERION ${criterion.id} |`) && criterion.paths.some(file => row.includes(file))));
}
/**
 * Checks a write subagent's envelope file as acceptance would, without advancing the run.
 * @param {any} state
 * @param {string} file
 * @param {{ allowLegacySelfCheck?: boolean }} [options]
 * @returns {{ envelope?: any, errors: string[] }}
 */
export function inspectEnvelope(state, file, { allowLegacySelfCheck = false } = {}) {
  const data = state.ordinary;
  const expected = state.pending?.action === 'delegate-write'
    ? state.pending.fields?.expectedEnvelopePath
    : data.expectedEnvelopePath;
  const errors = [];
  const legacySelfCheck = !expected && allowLegacySelfCheck;
  if (!expected && !legacySelfCheck) {
    return { errors: [`Legacy pending delegate-write has no expected envelope path; inline outcomes are refused. Resume with ${state.resumeCommand} to reissue a current-format write action.`] };
  }
  if (state.pending?.action === 'delegate-write' && data.expectedEnvelopePath !== expected) {
    return { errors: ['Pending delegate-write envelope path does not match the saved run path.'] };
  }
  if (expected && file !== expected) {
    const kind = data.previousEnvelopePaths?.includes(file) ? 'stale' : 'foreign';
    return { errors: [`The ${kind} envelope path does not match the pending action's expected path.`] };
  }
  const sessionDir = path.resolve(path.dirname(state.stateFile));
  const absolute = path.resolve(file);
  const relative = path.relative(sessionDir, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { errors: ['The expected envelope path must name a file inside the run session directory.'] };
  }
  if (legacySelfCheck && !path.basename(absolute).startsWith(`${state.runId}-`)) {
    return { errors: ['A legacy pending write can self-check only an envelope file named for this run inside its session directory.'] };
  }
  let stats;
  try { stats = fs.lstatSync(absolute); }
  catch { return { errors: [`Expected envelope file is missing: ${expected}`] }; }
  if (stats.isSymbolicLink()) return { errors: ['Expected envelope file must not be a symbolic link.'] };
  if (!stats.isFile()) return { errors: ['Expected envelope path must be a regular file.'] };
  let envelope;
  try { envelope = parseImplementationOutcome(fs.readFileSync(absolute, 'utf8')); }
  catch (error) { return { errors: [`Expected envelope file is invalid: ${error.message}`] }; }
  if (data.launch !== 'tests-only' && ['DONE', 'DONE_WITH_CONCERNS'].includes(envelope.status)) {
    if (envelope.stage !== 'COMPLETE') errors.push(`A production DONE envelope must report stage COMPLETE (got ${envelope.stage}).`);
    errors.push(...missingTrace(data.criteria, envelope).map(item => `Evidence needs a row "CRITERION ${item.id} | <one of: ${item.paths.join(', ')}> | <delivered behavior>".`));
  }
  return { envelope, errors };
}
export function checkEnvelope(stateFile, file) {
  bindStateSession(stateFile);
  const state = readRunState(stateFile);
  if (state.pending?.action !== 'delegate-write') throw new Error('No delegate-write is pending for this state.');
  const legacy = !state.pending.fields?.expectedEnvelopePath;
  const { envelope, errors } = inspectEnvelope(state, file, { allowLegacySelfCheck: legacy });
  if (!errors.length && state.ordinary.launch === 'tests-only' && ['DONE', 'DONE_WITH_CONCERNS'].includes(envelope.status)) errors.push(...validateRedAdmission(state, envelope));
  return errors.length ? { ok: false, errors } : { ok: true, ...(legacy ? { warning: `Legacy pending action was self-checked only; resume with ${state.resumeCommand} to reissue a current-format write action.` } : {}) };
}
function testsOnlyPrompt(state, expectedEnvelopePath) {
  const data = state.ordinary;
  const repair = data.testsOnlyRepair;
  const document = {
    schemaVersion: 1,
    purpose: repair ? 'tests-only-admission-repair' : 'tests-only-red',
    manifest: testsOnlyManifest(data),
    boundaries: { writeOnly: data.testsOnlyPaths, productionChanges: false, retainExistingTestChanges: Boolean(repair) },
    envelope: { schemaVersion: 1, status: 'DONE|DONE_WITH_CONCERNS', stage: 'RED_READY', summary: 'non-empty string', evidence: 'exactly one RED-MATRIX <SC#> | <approved test path>:<test name> | exit <nonzero integer> test:<full name>[; test:<full name>...] per criterion; N/A | <non-empty class reason> only with an evidence-backed exception ruling', concerns: 'array of non-empty strings, only with DONE_WITH_CONCERNS' },
    expectedEnvelopePath,
    selfCheck: selfCheck(state, expectedEnvelopePath),
    ...(repair ? { admissionDefects: repair.defects } : {}),
  };
  return briefFile(state, `tests-only${repair ? '-repair' : ''}`, document, 'tests-only');
}
/** Writes a hashed write brief beside the run state, so the host relays a path instead of the brief. */
function briefFile(state, name, document, kind) {
  const frame = path.join(SKILL_ROOT, 'references/templates/write-brief.md');
  const block = path.join(SKILL_ROOT, `references/templates/write-brief-${kind}.md`);
  const { template, variables } = assembleTemplate(frame, block);
  const prose = fillTemplate(template, variables, {
    'Expected Envelope Path': document.expectedEnvelopePath,
    'Self Check Command': document.selfCheck.command,
  });
  const content = `${JSON.stringify({ brief: prose, ...document })}\n`;
  const hash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  const file = path.join(path.dirname(state.stateFile), `${state.runId}-${name}.json`);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { path: file, hash };
}
let packetSchema;
function productionPrompt(state, expectedEnvelopePath) {
  const data = state.ordinary;
  const packet = {
    ...data.packet,
    // Required packet fields preserve its schema while prose lives in the brief template.
    instruction: 'Follow the production instruction in brief.',
    conflict: 'Follow the conflict rule in brief.',
    governingPlan: state.planPath,
    redGate: data.redGate ?? 'validated',
  };
  packetSchema ??= loadSchema('delegate-write').properties.fields.properties.packet.oneOf[1];
  const errors = validateAgainstSchema(packetSchema, packet, '$.packet');
  if (errors.length) throw new Error(`Invalid production packet: ${errors.join('; ')}`);
  return briefFile(state, `production-a${data.attempt}`, {
    schemaVersion: 1, purpose: 'production', packet,
    envelope: { schemaVersion: 1, status: 'DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED', stage: 'COMPLETE', summary: 'non-empty string', evidence: 'array of strings holding one CRITERION <SC#> | <owning production path> | <delivered behavior> row per criterion', 'concerns|missingContext|blockers': 'array of non-empty strings, only with DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED respectively' },
    expectedEnvelopePath,
    selfCheck: selfCheck(state, expectedEnvelopePath),
  }, 'production');
}
// SECTION: Delegation action

/** Emits the next tests-only or production write delegation. */
export function writeAction(state) {
  const data = state.ordinary;
  const segment = ledgerSegment(state);
  if (!segment?.approved || segment.runId !== state.ledgerRunId) throw new Error('Recorded v1 approval is required before delegation.');
  const write = data.write;
  // Baseline (HEAD plus any pre-existing dirty paths) is captured once, at the first delegate-write
  // emission for this task: a later cascade hop's restore must undo only what that hop itself dirtied.
  if (write.baselineHead === undefined) write.baselineHead = currentHead(state.repoRoot);
  if (data.expectedEnvelopePath) {
    data.previousEnvelopePaths ??= [];
    if (!data.previousEnvelopePaths.includes(data.expectedEnvelopePath)) data.previousEnvelopePaths.push(data.expectedEnvelopePath);
  }
  const expectedEnvelopePath = path.join(path.dirname(state.stateFile), `${state.runId}-write-${crypto.randomUUID()}.json`);
  data.expectedEnvelopePath = expectedEnvelopePath;
  const testsOnly = data.launch === 'tests-only';
  const prompt = testsOnly ? testsOnlyPrompt(state, expectedEnvelopePath) : productionPrompt(state, expectedEnvelopePath);
  const cascadeContinuation = data.pendingCascadeContinuation ?? null;
  const restore = data.pendingRestore ?? null;
  const recoveryNote = data.writeRecoveryNote;
  delete data.pendingCascadeContinuation;
  delete data.pendingRestore;
  delete data.writeRecoveryNote;
  return emitAction(state, 'delegate-write', { fields: {
    stage: testsOnly ? 'tests-only' : 'production', launch: data.launch,
    attempt: data.attempt, model: write.models[write.candidate], effort: write.effort ?? null,
    platform: write.platform, cascadePosition: write.candidate, modelCascade: write.models,
    planPath: state.planPath, walkthroughPath: state.walkthroughPath,
    paths: testsOnly ? data.testsOnlyPaths : data.approvedPaths,
    expectedEnvelopePath,
    criteria: (testsOnly ? data.redCriteria : data.criteria).map(({ id, title, evidence, paths, commands, review }) => ({ id, outcome: title, evidence, paths, commands, ...(review ? { review } : {}) })),
    promptPath: prompt.path, promptHash: prompt.hash,
    ...(testsOnly ? { continuation: data.testsOnlyRepair ? { kind: 'admission-repair', reuseChanges: true, defects: data.testsOnlyRepair.defects } : cascadeContinuation } : (cascadeContinuation ? { continuation: cascadeContinuation } : {})),
    ...(restore ? { restore } : {}),
    // The production packet lives in promptPath: the host relays a path, not ~30 KB of packet.
    packet: null,
    evidence: data.envelope?.evidence ?? [], context: data.continuationContext ?? null,
  } }, [
    'Launch the configured native write subagent with the exact model and effort; a launcher that fixes effort per agent definition selects the definition whose effort matches. Give it promptPath with promptHash, paths, criteria, expectedEnvelopePath, and any evidence, context, continuation, or restore fields; do not restate the brief. Reply {"envelopePath": "<expectedEnvelopePath>"}, or {"rejected": true, "reason": "..."} if the launch is refused; never substitute launcher defaults.',
    testsOnly ? `Read ${prompt.path} fully; its sha256 is ${prompt.hash}. It is the authoritative tests-only contract. ${data.testsOnlyRepair ? 'Continue with the existing test changes and repair only its listed admission defects.' : 'Edit only its approved test paths.'}` : `Read ${prompt.path} fully; its sha256 is ${prompt.hash}. Its packet is the authoritative production brief. Implement the smallest complete behavior satisfying the governing outcome and settled scope. Tests are evidence, not specification; return NEEDS_CONTEXT or BLOCKED on conflict. Return COMPLETE with delivered production-path evidence: one \`CRITERION SC# | <paths> | <behavior>\` evidence row per criterion.`,
    ...(recoveryNote ? [recoveryNote] : []),
  ]);
}
export function outcomeTransition(state, reply, options = {}) {
  const data = state.ordinary;
  let envelope = reply.validatedEnvelope ?? null, parseError = null;
  if (!envelope) try { envelope = parseImplementationOutcome(reply.raw ?? JSON.stringify(reply.envelope)); } catch (error) { parseError = error.message; }
  const transition = resolveImplementationTransition({
    terminalEnvelope: envelope, launch: data.launch, attempt: data.attempt, targetKind: 'delegate',
    resumable: false, contextContinuationUsed: false, escalation: data.write.escalation,
    ...(data.launch === 'continuation' ? { continuationOf: 'full' } : {}), ...options,
  });
  return { envelope, parseError, transition };
}
export function verificationTransition(state, result, kind) {
  const data = state.ordinary;
  return resolveImplementationTransition({ launch: data.launch, attempt: data.attempt, targetKind: 'delegate', resumable: false,
    escalation: data.write.escalation, verificationResult: result, verificationKind: kind,
    ...(data.launch === 'continuation' ? { continuationOf: 'full' } : {}),
  });
}
