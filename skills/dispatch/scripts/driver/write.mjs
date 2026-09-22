import { loadDispatchConfig } from '../config.mjs';
import { resolveFlow } from '../resolve-flow.mjs';
import { parseImplementationOutcome, resolveImplementationTransition } from '../implementation-outcome.mjs';
import { emitAction } from './actions.mjs';
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
export function writeAction(state) {
  const data = state.ordinary;
  const segment = ledgerSegment(state);
  if (!segment?.approved || segment.runId !== state.ledgerRunId) throw new Error('Recorded v1 approval is required before delegation.');
  const write = data.write;
  return emitAction(state, 'delegate-write', { fields: {
    stage: data.launch === 'tests-only' ? 'tests-only' : 'production', launch: data.launch,
    attempt: data.attempt, model: write.models[write.candidate], effort: write.effort ?? null,
    platform: write.platform, cascadePosition: write.candidate, modelCascade: write.models,
    planPath: state.planPath, walkthroughPath: state.walkthroughPath,
    paths: data.launch === 'tests-only' ? data.testPaths : data.approvedPaths,
    evidence: data.envelope?.evidence ?? [], context: data.continuationContext ?? null,
  } }, [
    'Launch the configured native write subagent with the exact model and effort. Return its raw final implementation-outcome v1 envelope, or a launch rejection with reason; never substitute launcher defaults.',
    data.launch === 'tests-only' ? 'Only edit classified test paths. Return RED_READY with one primary RED-MATRIX row per mapped criterion; the host must observe attributable RED before production.' : 'Implement approved paths only. Return COMPLETE with evidence; host verification and shared code review determine completion.',
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
