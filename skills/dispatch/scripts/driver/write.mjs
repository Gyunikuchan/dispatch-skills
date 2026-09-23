import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadDispatchConfig } from '../config.mjs';
import { currentHead } from '../git-state.mjs';
import { resolveFlow } from '../resolve-flow.mjs';
import { parseImplementationOutcome, resolveImplementationTransition } from '../implementation-outcome.mjs';
import { emitAction, loadSchema, validateAgainstSchema } from './actions.mjs';
import { ledgerSegment } from './ordinary-state.mjs';
import { SKILL_ROOT } from './plan-phase.mjs';

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
function testsOnlyPrompt(state) {
  const data = state.ordinary;
  const repair = data.testsOnlyRepair;
  const document = {
    schemaVersion: 1,
    purpose: repair ? 'tests-only-admission-repair' : 'tests-only-red',
    manifest: testsOnlyManifest(data),
    boundaries: { writeOnly: data.testsOnlyPaths, productionChanges: false, retainExistingTestChanges: Boolean(repair) },
    envelope: { schemaVersion: 1, status: 'DONE|DONE_WITH_CONCERNS', stage: 'RED_READY', summary: 'non-empty string', evidence: 'exactly one RED-MATRIX <SC#> | <approved test path>:<test name> | exit <nonzero integer> test:<full name>[; test:<full name>...] per criterion; N/A | <non-empty class reason> only with an evidence-backed exception ruling' },
    ...(repair ? { admissionDefects: repair.defects } : {}),
  };
  return briefFile(state, `tests-only${repair ? '-repair' : ''}`, document);
}
/** Writes a hashed write brief beside the run state, so the host relays a path instead of the brief. */
function briefFile(state, name, document) {
  const content = `${JSON.stringify(document)}\n`;
  const hash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  const file = path.join(path.dirname(state.stateFile), `${state.runId}-${name}.json`);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { path: file, hash };
}
let packetSchema;
function productionPrompt(state) {
  const data = state.ordinary;
  const packet = {
    ...data.packet,
    instruction: 'Implement the smallest complete behavior satisfying the governing outcome and settled scope.',
    conflict: 'Return NEEDS_CONTEXT or BLOCKED with the exact conflict when evidence omits, conflicts with, or exceeds the governing outcome or scope.',
    governingPlan: state.planPath,
    redGate: data.redGate ?? 'validated',
    ...(data.carriedFindings?.length ? { reviewFindings: data.carriedFindings } : {}),
  };
  packetSchema ??= loadSchema('delegate-write').properties.fields.properties.packet.oneOf[1];
  const errors = validateAgainstSchema(packetSchema, packet, '$.packet');
  if (errors.length) throw new Error(`Invalid production packet: ${errors.join('; ')}`);
  return briefFile(state, `production-a${data.attempt}`, { schemaVersion: 1, purpose: 'production', packet });
}
export function writeAction(state) {
  const data = state.ordinary;
  const segment = ledgerSegment(state);
  if (!segment?.approved || segment.runId !== state.ledgerRunId) throw new Error('Recorded v1 approval is required before delegation.');
  const write = data.write;
  // Baseline (HEAD plus any pre-existing dirty paths) is captured once, at the first delegate-write
  // emission for this task: a later cascade hop's restore must undo only what that hop itself dirtied.
  if (write.baselineHead === undefined) write.baselineHead = currentHead(state.repoRoot);
  const testsOnly = data.launch === 'tests-only';
  const prompt = testsOnly ? testsOnlyPrompt(state) : productionPrompt(state);
  const cascadeContinuation = data.pendingCascadeContinuation ?? null;
  const restore = data.pendingRestore ?? null;
  delete data.pendingCascadeContinuation;
  delete data.pendingRestore;
  return emitAction(state, 'delegate-write', { fields: {
    stage: testsOnly ? 'tests-only' : 'production', launch: data.launch,
    attempt: data.attempt, model: write.models[write.candidate], effort: write.effort ?? null,
    platform: write.platform, cascadePosition: write.candidate, modelCascade: write.models,
    planPath: state.planPath, walkthroughPath: state.walkthroughPath,
    paths: testsOnly ? data.testsOnlyPaths : data.approvedPaths,
    criteria: (testsOnly ? data.redCriteria : data.criteria).map(({ id, title, evidence, paths, commands, review }) => ({ id, outcome: title, evidence, paths, commands, ...(review ? { review } : {}) })),
    promptPath: prompt.path, promptHash: prompt.hash,
    ...(testsOnly ? { continuation: data.testsOnlyRepair ? { kind: 'admission-repair', reuseChanges: true, defects: data.testsOnlyRepair.defects } : cascadeContinuation } : (cascadeContinuation ? { continuation: cascadeContinuation } : {})),
    ...(restore ? { restore } : {}),
    // The production packet lives in promptPath: the host relays a path, not ~30 KB of packet.
    packet: null,
    evidence: data.envelope?.evidence ?? [], context: data.continuationContext ?? null,
  } }, [
    'Launch the configured native write subagent with the exact model and effort; a launcher that fixes effort per agent definition selects the definition whose effort matches. Give it promptPath with promptHash, paths, criteria, and any evidence, context, continuation, or restore fields; do not restate the brief. Return its raw final implementation-outcome v1 envelope, or a launch rejection with reason; never substitute launcher defaults.',
    testsOnly ? `Read ${prompt.path} fully; its sha256 is ${prompt.hash}. It is the authoritative tests-only contract. ${data.testsOnlyRepair ? 'Continue with the existing test changes and repair only its listed admission defects.' : 'Edit only its approved test paths.'}` : `Read ${prompt.path} fully; its sha256 is ${prompt.hash}. Its packet is the authoritative production brief. Implement the smallest complete behavior satisfying the governing outcome and settled scope. Tests are evidence, not specification; return NEEDS_CONTEXT or BLOCKED on conflict.${data.carriedFindings?.length ? ' Close packet.reviewFindings (accepted RED test-review findings) within the approved paths.' : ''} Return COMPLETE with delivered production-path evidence: one \`CRITERION SC# | <paths> | <behavior>\` evidence row per criterion.`,
  ]);
}
export function outcomeTransition(state, reply, options = {}) {
  const data = state.ordinary;
  let envelope = null, parseError = null;
  try { envelope = parseImplementationOutcome(reply.raw ?? JSON.stringify(reply.envelope)); } catch (error) { parseError = error.message; }
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
