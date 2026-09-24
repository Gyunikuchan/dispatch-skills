// @ts-check

const STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED']);
const STAGES = new Set(['RED_READY', 'COMPLETE']);
const VERIFICATION_RESULTS = new Set([
  'red',
  'pass',
  'accepted-baseline-equivalent',
  'regression',
]);
const COMMON_FIELDS = new Set([
  'schemaVersion',
  'status',
  'stage',
  'summary',
  'evidence',
  'concerns',
  'missingContext',
  'blockers',
]);

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
}

/**
 * @param {any} value
 * @param {any} field
 * @param {{ nonEmpty?: boolean }} [options]
 */
function requireStringArray(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('terminal envelope must be a JSON object');
  }
  const unknown = Object.keys(value).filter(key => !COMMON_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`terminal envelope has unknown field "${unknown[0]}"`);
  if (value.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (!STATUSES.has(value.status)) throw new Error(`unknown terminal status "${value.status}"`);
  if (!STAGES.has(value.stage)) throw new Error(`unknown terminal stage "${value.stage}"`);
  if (value.stage === 'RED_READY' && !['DONE', 'DONE_WITH_CONCERNS'].includes(value.status)) {
    throw new Error(`RED_READY is illegal with status ${value.status}`);
  }
  requireString(value.summary, 'summary');
  requireStringArray(value.evidence, 'evidence', {
    nonEmpty: ['DONE', 'DONE_WITH_CONCERNS'].includes(value.status),
  });

  const statusFields = {
    DONE_WITH_CONCERNS: 'concerns',
    NEEDS_CONTEXT: 'missingContext',
    BLOCKED: 'blockers',
  };
  for (const field of ['concerns', 'missingContext', 'blockers']) {
    const required = statusFields[value.status] === field;
    if (required) {
      requireStringArray(value[field], field, { nonEmpty: true });
    } else if (value[field] !== undefined) {
      requireStringArray(value[field], field);
      if (value[field].length > 0) {
        throw new Error(`${field} must be omitted or empty for status ${value.status}`);
      }
    }
  }
  return value;
}

// JSON.parse keeps the last duplicate silently; scan object key tokens per nesting level instead.
function hasDuplicateKeys(source) {
  const stack = [];
  for (const [token, string, colon] of source.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}[\]]/g)) {
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (colon && stack.at(-1)) {
      const key = JSON.parse(string);
      if (stack.at(-1).has(key)) return true;
      stack.at(-1).add(key);
    }
  }
  return false;
}

export function parseImplementationOutcome(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('missing terminal envelope');
  }
  // Every fence counts toward the one-envelope rule; only a bare `json` tag is accepted.
  const fences = [...text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];
  if (fences.length > 1) throw new Error('expected exactly one terminal envelope');
  if (fences.length === 1 && fences[0][1].trim().toLowerCase() !== 'json') {
    throw new Error('terminal envelope fence must use the json language tag');
  }

  let source;
  if (fences.length === 1) {
    source = fences[0][2];
  } else {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      throw new Error('missing terminal envelope');
    }
    source = trimmed;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('terminal envelope is not valid JSON');
  }
  if (hasDuplicateKeys(source)) throw new Error('terminal envelope has duplicate keys');
  return validateEnvelope(parsed);
}

function retryTransition({ attempt, targetKind, escalation }) {
  if (targetKind === 'self') {
    return attempt < 2
      ? { action: 'replace', consumesAttempt: true }
      : { action: 'stop-user-ruling', consumesAttempt: true };
  }
  if (attempt < 2) return { action: 'replace', consumesAttempt: true };
  if (attempt >= 3) {
    return { action: 'stop-user-ruling', consumesAttempt: true };
  }
  if (!escalation || !['available', 'exhausted'].includes(escalation.status)) {
    throw new Error('escalation must be available or exhausted for delegated Attempt 2');
  }
  if (escalation.status === 'exhausted') {
    requireString(escalation.reason, 'escalation.reason');
    return { action: 'stop-user-ruling', consumesAttempt: true };
  }
  requireString(escalation.level, 'escalation.level');
  requireString(escalation.model, 'escalation.model');
  if (escalation.effort !== undefined) requireString(escalation.effort, 'escalation.effort');
  const target = { level: escalation.level, model: escalation.model };
  if (escalation.effort !== undefined) target.effort = escalation.effort;
  return { action: 'escalate', consumesAttempt: true, target };
}

/**
 * @param {{ terminalEnvelope?: any, launch: string, attempt: number, targetKind: string, resumable?: boolean, contextContinuationUsed?: boolean, escalation?: any, verificationResult?: any, verificationKind?: string, continuationOf?: string, concernsResolved?: boolean }} options
 */
export function resolveImplementationTransition({
  terminalEnvelope,
  launch,
  attempt,
  targetKind,
  resumable,
  contextContinuationUsed,
  escalation,
  verificationResult,
  verificationKind,
  continuationOf,
  concernsResolved = false,
}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  if (!['delegate', 'self'].includes(targetKind)) throw new Error(`unknown targetKind "${targetKind}"`);
  if (!['tests-only', 'full', 'continuation'].includes(launch)) {
    throw new Error(`unknown launch "${launch}"`);
  }
  if (
    (launch === 'continuation' && !['tests-only', 'full'].includes(continuationOf)) ||
    (launch !== 'continuation' && continuationOf !== undefined)
  ) {
    throw new Error('continuationOf must be tests-only or full exactly when launch is continuation');
  }

  if (verificationResult !== undefined) {
    if (!VERIFICATION_RESULTS.has(verificationResult)) {
      throw new Error(`unknown verification result "${verificationResult}"`);
    }
    if (verificationKind === 'red-gate') {
      if (verificationResult === 'red') {
        return { action: resumable ? 'resume' : 'continue', consumesAttempt: false };
      }
      return retryTransition({ attempt, targetKind, escalation });
    }
    if (verificationKind !== 'final') throw new Error(`unknown verificationKind "${verificationKind}"`);
    if (verificationResult === 'pass' || verificationResult === 'accepted-baseline-equivalent') {
      return { action: 'complete', consumesAttempt: false };
    }
    return retryTransition({ attempt, targetKind, escalation });
  }

  if (!terminalEnvelope) return retryTransition({ attempt, targetKind, escalation });
  const envelope = validateEnvelope(terminalEnvelope);
  const testsOnlyLaunch =
    launch === 'tests-only' || (launch === 'continuation' && continuationOf === 'tests-only');
  const validStage =
    (testsOnlyLaunch &&
      ((envelope.stage === 'RED_READY' && ['DONE', 'DONE_WITH_CONCERNS'].includes(envelope.status)) ||
        (envelope.stage === 'COMPLETE' && ['NEEDS_CONTEXT', 'BLOCKED'].includes(envelope.status)))) ||
    ((launch === 'full' || (launch === 'continuation' && continuationOf === 'full')) &&
      envelope.stage === 'COMPLETE');
  if (!validStage) return retryTransition({ attempt, targetKind, escalation });

  if (envelope.status === 'BLOCKED') {
    if ((targetKind === 'self' && attempt >= 2) || (targetKind === 'delegate' && attempt >= 3)) {
      return { action: 'stop-user-ruling', consumesAttempt: true };
    }
    return { action: 'change-blocking-condition', consumesAttempt: true };
  }
  if (envelope.status === 'NEEDS_CONTEXT') {
    if (targetKind === 'self') {
      return contextContinuationUsed
        ? { action: 'stop-user-ruling', consumesAttempt: false }
        : { action: 'resume', consumesAttempt: false };
    }
    if (resumable && !contextContinuationUsed) {
      return { action: 'resume', consumesAttempt: false };
    }
    return retryTransition({ attempt, targetKind, escalation });
  }
  if (envelope.status === 'DONE_WITH_CONCERNS') {
    if (!concernsResolved) return { action: 'concern-ruling', consumesAttempt: false };
  }
  return {
    action: envelope.stage === 'RED_READY' ? 'run-red' : 'verify',
    consumesAttempt: false,
  };
}
