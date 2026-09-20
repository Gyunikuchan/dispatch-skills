import crypto from 'node:crypto';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TRANSITIONS = new Set([
  'run-red', 'verify', 'concern-ruling', 'resume', 'continue', 'replace',
  'change-blocking-condition', 'escalate', 'stop-user-ruling', 'complete',
]);
const EVENT_TYPES = new Set([
  'run-start', 'run-complete', 'task-start', 'implementation-attempt',
  'verification', 'task-complete', 'ruling', 'review', 'approval',
]);
const PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;

function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

const PATH_KEYS = new Set(['path', 'paths', 'dirtyPaths', 'governingPath', 'planPath', 'walkthroughPath', 'targetPath', 'replacementPath']);

function canonicalize(value, location = '$', pathValue = false) {
  if (typeof value === 'string') return pathValue ? value : value.normalize('NFC');
  if (value === null || typeof value === 'boolean') return value;
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === 'number') throw new Error(`${location} must contain integers only`);
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${location}[${index}]`, pathValue));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${location} must contain JSON values only`);
  }
  return Object.fromEntries(
    Object.keys(value).sort(compareCodePoints).map(key => [
      key.normalize('NFC'),
      canonicalize(value[key], `${location}.${key}`, PATH_KEYS.has(key)),
    ]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function exact(value, required, optional = [], label = 'object') {
  object(value, label);
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is unknown`);
}

function string(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function strings(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be a string array`);
}

function repositoryPath(value, label, { allowScratch = false } = {}) {
  string(value, label);
  if (!PATH_PATTERN.test(value) || value.startsWith('./') || value.includes('//')) {
    throw new Error(`${label} must be a normalized repository-relative slash path`);
  }
  if (!allowScratch && (value === '.scratch' || value.startsWith('.scratch/'))) {
    throw new Error(`${label} cannot be inside .scratch`);
  }
}

function enumeration(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}`);
}

function validateData(event) {
  const { data, type } = event;
  object(data, `${type}.data`);
  switch (type) {
    case 'run-start':
      exact(data, ['governingPath', 'governingHash', 'rootSlug', 'action', 'baseline'], [], 'run-start.data');
      repositoryPath(data.governingPath, 'run-start.data.governingPath', { allowScratch: true });
      if (!SHA256.test(data.governingHash)) throw new Error('run-start.data.governingHash must be sha256');
      string(data.rootSlug, 'run-start.data.rootSlug');
      enumeration(data.action, ['ordinary'], 'run-start.data.action');
      exact(data.baseline, ['commit', 'repositoryState', 'dirtyPaths'], [], 'run-start.data.baseline');
      if (!OBJECT_ID.test(data.baseline.commit)) throw new Error('run-start baseline commit must be an object id');
      if (!SHA256.test(data.baseline.repositoryState)) throw new Error('run-start repositoryState must be sha256');
      strings(data.baseline.dirtyPaths, 'run-start baseline dirtyPaths');
      data.baseline.dirtyPaths.forEach((item, index) => repositoryPath(item, `run-start baseline dirtyPaths[${index}]`));
      break;
    case 'run-complete':
      exact(data, ['result', 'evidenceRefs'], [], 'run-complete.data');
      enumeration(data.result, ['complete', 'stable-failure', 'aborted'], 'run-complete.data.result');
      strings(data.evidenceRefs, 'run-complete.data.evidenceRefs');
      break;
    case 'task-start':
      exact(data, ['taskId', 'attemptBudget', 'paths', 'preState'], ['parentTaskId'], 'task-start.data');
      string(data.taskId, 'task-start.data.taskId');
      if (!Number.isSafeInteger(data.attemptBudget) || data.attemptBudget < 1) throw new Error('task-start attemptBudget must be positive');
      strings(data.paths, 'task-start.data.paths');
      data.paths.forEach((item, index) => repositoryPath(item, `task-start.data.paths[${index}]`));
      if (!SHA256.test(data.preState)) throw new Error('task-start preState must be sha256');
      if (data.parentTaskId !== undefined) string(data.parentTaskId, 'task-start.data.parentTaskId');
      break;
    case 'implementation-attempt':
      exact(data, ['taskId', 'attempt', 'launch', 'target', 'terminalEnvelope', 'evidence', 'transition'], [], 'implementation-attempt.data');
      string(data.taskId, 'implementation-attempt.data.taskId');
      if (!Number.isSafeInteger(data.attempt) || data.attempt < 1) throw new Error('attempt must be positive');
      enumeration(data.launch, ['tests-only', 'full', 'continuation'], 'implementation-attempt.data.launch');
      exact(data.target, ['platform'], ['model', 'effort', 'sessionHandle'], 'implementation-attempt.data.target');
      string(data.target.platform, 'target.platform');
      if (data.terminalEnvelope !== null) object(data.terminalEnvelope, 'terminalEnvelope');
      strings(data.evidence, 'implementation-attempt.data.evidence');
      enumeration(data.transition, [...TRANSITIONS], 'implementation-attempt.data.transition');
      break;
    case 'verification':
      exact(data, ['taskId', 'attempt', 'result', 'commandRefs', 'transition'], ['failureIdentity'], 'verification.data');
      string(data.taskId, 'verification.data.taskId');
      if (!Number.isSafeInteger(data.attempt) || data.attempt < 1) throw new Error('verification attempt must be positive');
      enumeration(data.result, ['red', 'pass', 'accepted-baseline-equivalent', 'regression'], 'verification.data.result');
      strings(data.commandRefs, 'verification.data.commandRefs');
      enumeration(data.transition, [...TRANSITIONS], 'verification.data.transition');
      if (data.result === 'red' && !data.failureIdentity) throw new Error('red verification requires failureIdentity');
      if (data.failureIdentity !== undefined) object(data.failureIdentity, 'verification.data.failureIdentity');
      if (data.transition === 'complete' && data.result === 'regression') throw new Error('regression cannot complete');
      break;
    case 'task-complete':
      exact(data, ['taskId', 'paths', 'head', 'preState', 'resultState', 'diffHash'], [], 'task-complete.data');
      string(data.taskId, 'task-complete.data.taskId');
      strings(data.paths, 'task-complete.data.paths');
      data.paths.forEach((item, index) => repositoryPath(item, `task-complete.data.paths[${index}]`));
      if (!OBJECT_ID.test(data.head)) throw new Error('task-complete head must be an object id');
      for (const key of ['preState', 'resultState', 'diffHash']) if (!SHA256.test(data[key])) throw new Error(`${key} must be sha256`);
      break;
    case 'ruling':
      exact(data, ['key', 'decision', 'reason', 'costIfWrong', 'state'], [], 'ruling.data');
      for (const key of ['key', 'decision', 'reason', 'costIfWrong']) string(data[key], `ruling.data.${key}`);
      enumeration(data.state, ['open', 'resolved', 'superseded'], 'ruling.data.state');
      break;
    case 'review':
      exact(data, ['kind', 'round', 'counts', 'checkpointRef'], [], 'review.data');
      enumeration(data.kind, ['plan', 'code'], 'review.data.kind');
      if (!Number.isSafeInteger(data.round) || data.round < 1) throw new Error('review round must be positive');
      exact(data.counts, ['accepted', 'rejected', 'resolvedDispute', 'disputed', 'pendingConfirmation', 'unknown'], [], 'review.data.counts');
      for (const count of Object.values(data.counts)) if (!Number.isSafeInteger(count) || count < 0) throw new Error('review counts must be non-negative integers');
      string(data.checkpointRef, 'review.data.checkpointRef');
      break;
    case 'approval':
      exact(data, ['governingHash', 'decision', 'actor'], [], 'approval.data');
      if (!SHA256.test(data.governingHash)) throw new Error('approval governingHash must be sha256');
      enumeration(data.decision, ['approved', 'rejected'], 'approval.data.decision');
      enumeration(data.actor, ['user'], 'approval.data.actor');
      break;
  }
}

export function validateEvent(event) {
  exact(event, ['v', 'seq', 'type', 'runId', 'at', 'data'], [], 'event');
  if (event.v !== 1) throw new Error(`Unknown ledger version ${event.v}`);
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error('event.seq must be a positive integer');
  if (!EVENT_TYPES.has(event.type)) throw new Error(`Unknown event type ${event.type}`);
  if (!UUID.test(event.runId)) throw new Error('event.runId must be a UUID');
  if (!UTC_MILLIS.test(event.at) || Number.isNaN(Date.parse(event.at))) throw new Error('event.at must be UTC RFC 3339 with milliseconds');
  validateData(event);
  return event;
}

export function serializeEvent(event) {
  validateEvent(event);
  return `- event: ${canonicalJson(event)}\n`;
}

export function parseEventLine(line) {
  if (!line.startsWith('- event: ')) throw new Error('Malformed ledger line');
  let event;
  try { event = JSON.parse(line.slice(9)); } catch { throw new Error('Malformed ledger JSON'); }
  return validateEvent(event);
}

function taskFor(state, taskId) {
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`Task "${taskId}" has not started`);
  return task;
}

export function foldEvents(events) {
  const state = {
    runId: null, terminal: false, needsReconciliation: false, completedTasks: new Map(),
    tasks: new Map(), rulings: new Map(), reviews: [], latestSeq: 0, governingHash: null,
    approved: false,
  };
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    validateEvent(event);
    if (event.seq <= state.latestSeq) throw new Error('Ledger sequence must strictly increase');
    if (state.terminal) throw new Error('run-complete must be the final event');
    if (!state.runId) {
      if (event.type !== 'run-start') throw new Error('run-start must be first');
      state.runId = event.runId;
      state.governingHash = event.data.governingHash;
      state.runStart = event.data;
    } else if (event.runId !== state.runId) {
      throw new Error('Segment runId changed without run-start');
    }
    if (eventIndex === 1 && event.type !== 'approval' &&
        !(event.type === 'ruling' && event.data.key === 'reconciliation')) {
      throw new Error('approval must immediately follow run-start');
    }
    state.latestSeq = event.seq;
    switch (event.type) {
      case 'task-start': {
        if (!state.approved) throw new Error('Task cannot start before approval');
        if (state.tasks.has(event.data.taskId)) throw new Error(`Task "${event.data.taskId}" already started`);
        let nextAttempt = 1;
        if (event.data.parentTaskId) {
          const parent = taskFor(state, event.data.parentTaskId);
          nextAttempt = parent.latestAttempt + 1;
        }
        state.tasks.set(event.data.taskId, {
          ...event.data, latestAttempt: nextAttempt - 1, nextAttempt, lastAttempt: null,
          lastVerification: null, complete: false,
        });
        break;
      }
      case 'implementation-attempt': {
        const task = taskFor(state, event.data.taskId);
        if (task.complete) throw new Error('Completed task cannot restart');
        const attempt = event.data.attempt;
        if (attempt < task.nextAttempt || attempt > task.nextAttempt) {
          if (!(event.data.launch === 'continuation' && attempt === task.latestAttempt)) throw new Error('Illegal attempt number');
        }
        if (event.data.launch === 'continuation') {
          if (!task.lastVerification || task.lastVerification.data.result !== 'red' ||
              task.lastVerification.data.attempt !== attempt) throw new Error('Continuation requires matching red verification');
        } else {
          task.latestAttempt = attempt;
          task.nextAttempt = attempt + 1;
        }
        task.lastAttempt = event;
        break;
      }
      case 'verification': {
        const task = taskFor(state, event.data.taskId);
        if (!task.lastAttempt || task.lastAttempt.data.attempt !== event.data.attempt) throw new Error('Verification requires matching attempt');
        const attemptTransition = task.lastAttempt.data.transition;
        if (event.data.result === 'red') {
          if (attemptTransition !== 'run-red') throw new Error('Red verification requires run-red');
        } else if (!['verify', 'concern-ruling'].includes(attemptTransition)) {
          throw new Error('Verification requires verify or concern-ruling');
        }
        if (task.terminalVerificationAttempt === event.data.attempt && event.data.result !== 'red') {
          throw new Error('Only one terminal verification is allowed per attempt');
        }
        task.lastVerification = event;
        if (event.data.result !== 'red') task.terminalVerificationAttempt = event.data.attempt;
        break;
      }
      case 'task-complete': {
        const task = taskFor(state, event.data.taskId);
        if (!task.lastVerification || task.lastVerification.data.transition !== 'complete') throw new Error('task-complete requires complete verification');
        task.complete = true;
        task.completion = event.data;
        state.completedTasks.set(event.data.taskId, event.data);
        break;
      }
      case 'ruling':
        state.rulings.set(event.data.key, event.data);
        if (event.data.key === 'reconciliation') state.needsReconciliation = event.data.state !== 'resolved';
        break;
      case 'approval':
        state.approved = event.data.decision === 'approved';
        break;
      case 'review':
        state.reviews.push(event.data);
        break;
      case 'run-complete':
        state.terminal = true;
        state.result = event.data.result;
        break;
    }
  }
  return state;
}

export function foldSegments(events) {
  const segments = [];
  let current = [];
  for (const event of events) {
    if (event.type === 'run-start' && current.length) {
      segments.push(foldEvents(current));
      current = [];
    }
    current.push(event);
  }
  if (current.length) segments.push(foldEvents(current));
  return segments;
}

export function selectOrdinarySegment(events, governingHash) {
  const segments = foldSegments(events);
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (!segment.terminal && segment.governingHash === governingHash) return segment;
  }
  return null;
}
