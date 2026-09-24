// @ts-check
import crypto from 'node:crypto';

/** @typedef {'pending'|'ready'|'active'|'complete'|'blocked'|'invalidated'|'reopened'} IncrementState */
/** @typedef {{ incrementStates?: Map<string, IncrementState>, amendments?: Map<string, any> }} FoldContext */

// SECTION: Ledger schema constants

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
  'increment-state', 'amendment', 'adjacent-fix', 'integration', 'manual-complete',
]);
const INCREMENT_STATES = new Set([
  'pending', 'ready', 'active', 'complete', 'blocked', 'invalidated', 'reopened',
]);
const AMENDMENT_STATES = new Set([
  'proposed', 'reviewed', 'prepared', 'activated', 'rejected', 'aborted',
]);
const AMENDMENT_TRANSITIONS = new Set([
  ['proposed', 'reviewed'], ['reviewed', 'prepared'], ['prepared', 'activated'],
  ['proposed', 'rejected'], ['reviewed', 'rejected'], ['prepared', 'rejected'],
  ['proposed', 'aborted'], ['reviewed', 'aborted'], ['prepared', 'aborted'],
].map(([from, to]) => `${from}->${to}`));
const INCREMENT_ID = /^I\d{2}$/;
const CLUSTER_ID = /^C-[0-9a-f]{12}$/;
const RUN_COMPLETE_RESULTS = new Set(['complete', 'stable-failure', 'aborted', 'design-approved-stop']);
const INTEGRATION_RESULTS = new Set(['pass', 'accepted-baseline-equivalent', 'regression']);
const PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;
const PATH_KEYS = new Set([
  'path', 'paths', 'dirtyPaths', 'governingPath', 'planPath', 'walkthroughPath',
  'targetPath', 'replacementPath',
]);
const PHASED_ACTIONS = new Set(['increment', 'integration']);
const INCREMENT_LEGAL_TRANSITIONS = new Set([
  'pending->ready', 'ready->active', 'active->complete',
  'complete->reopened', 'reopened->active', 'blocked->ready',
]);

// SECTION: Canonical JSON

/** Compares Unicode code points without locale-dependent collation. */
function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

/** @param {unknown} value */
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

/** Returns the byte-stable JSON representation used by ledger rows and fingerprints. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** Returns the repository's tagged SHA-256 representation. */
export function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

// SECTION: Event validation

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

/**
 * @param {any} value
 * @param {any} label
 * @param {{ allowScratch?: boolean }} [options]
 */
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
      exact(data, ['governingPath', 'governingHash', 'rootSlug', 'action', 'baseline'],
        ['repair', 'design', 'increment'], 'run-start.data');
      repositoryPath(data.governingPath, 'run-start.data.governingPath', { allowScratch: true });
      if (!SHA256.test(data.governingHash)) throw new Error('run-start.data.governingHash must be sha256');
      string(data.rootSlug, 'run-start.data.rootSlug');
      enumeration(data.action, ['ordinary', 'design', 'increment', 'integration'], 'run-start.data.action');
      if (data.repair !== undefined && typeof data.repair !== 'boolean') throw new Error('run-start.data.repair must be boolean');
      if (data.action === 'ordinary' && event.v !== 1) throw new Error('Ordinary segments require ledger version 1');
      if (data.action === 'ordinary' && data.design !== undefined) throw new Error('run-start.data.design is only valid on phased actions');
      if (data.action !== 'ordinary' && event.v !== 2) throw new Error('Phased segments require ledger version 2');
      if (data.action === 'increment' || data.action === 'integration') {
        exact(data.design, ['path', 'revision'], [], 'run-start.data.design');
        repositoryPath(data.design.path, 'run-start.data.design.path', { allowScratch: true });
        if (data.design.path !== data.governingPath) throw new Error('run-start.data.design.path must equal governingPath');
        if (data.design.revision !== data.governingHash) throw new Error('run-start.data.design.revision must equal governingHash');
      }
      if (data.action === 'increment') {
        exact(data.increment, ['id', 'planPath', 'walkthroughPath', 'planHash'], [], 'run-start.data.increment');
        if (!INCREMENT_ID.test(data.increment.id)) throw new Error('run-start.data.increment.id must match I<nn>');
        repositoryPath(data.increment.planPath, 'run-start.data.increment.planPath', { allowScratch: true });
        repositoryPath(data.increment.walkthroughPath, 'run-start.data.increment.walkthroughPath', { allowScratch: true });
        if (!SHA256.test(data.increment.planHash)) throw new Error('run-start.data.increment.planHash must be sha256');
      }
      if (data.action !== 'increment' && data.increment !== undefined) {
        throw new Error('run-start.data.increment is only valid on increment actions');
      }
      exact(data.baseline, ['commit', 'repositoryState', 'dirtyPaths'], [], 'run-start.data.baseline');
      if (!OBJECT_ID.test(data.baseline.commit)) throw new Error('run-start baseline commit must be an object id');
      if (!SHA256.test(data.baseline.repositoryState)) throw new Error('run-start repositoryState must be sha256');
      strings(data.baseline.dirtyPaths, 'run-start baseline dirtyPaths');
      data.baseline.dirtyPaths.forEach((item, index) => repositoryPath(item, `run-start baseline dirtyPaths[${index}]`));
      break;
    case 'increment-state':
      exact(data, ['incrementId', 'prior', 'next', 'cause', 'affectedDependents'], [], 'increment-state.data');
      if (!INCREMENT_ID.test(data.incrementId)) throw new Error('increment-state.incrementId must match I<nn>');
      enumeration(data.prior, [...INCREMENT_STATES], 'increment-state.prior');
      enumeration(data.next, [...INCREMENT_STATES], 'increment-state.next');
      string(data.cause, 'increment-state.cause');
      strings(data.affectedDependents, 'increment-state.affectedDependents');
      data.affectedDependents.forEach((item, index) => {
        if (!INCREMENT_ID.test(item)) throw new Error(`increment-state.affectedDependents[${index}] must match I<nn>`);
      });
      break;
    case 'amendment': {
      const stateName = data.state;
      enumeration(stateName, [...AMENDMENT_STATES], 'amendment.state');
      const base = ['amendmentId', 'state', 'affectedIncrements'];
      if (stateName === 'prepared') {
        exact(data, [...base, 'baseRevision', 'candidateHash', 'targetPath', 'replacementPath'],
          ['reconciliationState'], 'amendment.data');
        if (!SHA256.test(data.baseRevision)) throw new Error('amendment.data.baseRevision must be sha256');
        if (!SHA256.test(data.candidateHash)) throw new Error('amendment.data.candidateHash must be sha256');
        repositoryPath(data.targetPath, 'amendment.data.targetPath', { allowScratch: true });
        repositoryPath(data.replacementPath, 'amendment.data.replacementPath', { allowScratch: true });
      } else if (stateName === 'activated') {
        exact(data, [...base, 'baseRevision', 'candidateHash'], ['reconciliationState'], 'amendment.data');
        if (!SHA256.test(data.baseRevision)) throw new Error('amendment.data.baseRevision must be sha256');
        if (!SHA256.test(data.candidateHash)) throw new Error('amendment.data.candidateHash must be sha256');
      } else {
        for (const banned of ['baseRevision', 'candidateHash', 'targetPath', 'replacementPath']) {
          if (data[banned] !== undefined) throw new Error(`amendment.data.${banned} is rejected on ${stateName}`);
        }
        exact(data, base, ['reconciliationState'], 'amendment.data');
      }
      if (data.reconciliationState !== undefined) string(data.reconciliationState, 'amendment.data.reconciliationState');
      strings(data.affectedIncrements, 'amendment.data.affectedIncrements');
      data.affectedIncrements.forEach((item, index) => {
        if (!INCREMENT_ID.test(item)) throw new Error(`amendment.data.affectedIncrements[${index}] must match I<nn>`);
      });
      string(data.amendmentId, 'amendment.data.amendmentId');
      break;
    }
    case 'adjacent-fix':
      exact(data, ['findingIds', 'clusterId', 'attempts', 'result'], [], 'adjacent-fix.data');
      strings(data.findingIds, 'adjacent-fix.data.findingIds');
      if (data.findingIds.length === 0) throw new Error('adjacent-fix.data.findingIds must be non-empty');
      if (!CLUSTER_ID.test(data.clusterId)) throw new Error('adjacent-fix.data.clusterId must match C-<12 hex>');
      if (!Array.isArray(data.attempts) || data.attempts.some(item => !Number.isSafeInteger(item) || item < 1)) {
        throw new Error('adjacent-fix.data.attempts must be positive integers');
      }
      enumeration(data.result, ['complete', 'failed', 'aborted'], 'adjacent-fix.data.result');
      break;
    case 'integration':
      exact(data, ['scopeId', 'verificationRefs', 'reviewRefs', 'result'], [], 'integration.data');
      string(data.scopeId, 'integration.data.scopeId');
      strings(data.verificationRefs, 'integration.data.verificationRefs');
      strings(data.reviewRefs, 'integration.data.reviewRefs');
      enumeration(data.result, [...INTEGRATION_RESULTS], 'integration.data.result');
      break;
    case 'manual-complete':
      exact(data, ['reviewer', 'reason', 'redEvidence', 'criterionEvidence', 'fingerprint'], [], 'manual-complete.data');
      string(data.reviewer, 'manual-complete.data.reviewer');
      string(data.reason, 'manual-complete.data.reason');
      if (data.redEvidence !== null) string(data.redEvidence, 'manual-complete.data.redEvidence');
      if (!Array.isArray(data.criterionEvidence) || data.criterionEvidence.length === 0) throw new Error('manual-complete.data.criterionEvidence must be non-empty');
      data.criterionEvidence.forEach((item, index) => {
        exact(item, ['criterionId', 'evidence'], [], `manual-complete.data.criterionEvidence[${index}]`);
        string(item.criterionId, 'manual-complete criterionId');
        string(item.evidence, 'manual-complete evidence');
      });
      object(data.fingerprint, 'manual-complete.data.fingerprint');
      break;
    case 'run-complete':
      exact(data, ['result', 'evidenceRefs'], [], 'run-complete.data');
      enumeration(data.result, ['complete', 'stable-failure', 'aborted', ...(event.v === 2 ? ['design-approved-stop'] : [])], 'run-complete.data.result');
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
      enumeration(data.transition, [...TRANSITIONS].filter(transition => transition !== 'complete'), 'implementation-attempt.data.transition');
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
      enumeration(data.kind, ['plan', 'code', ...(event.v === 2 ? ['design', 'integration'] : [])], 'review.data.kind');
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

/** Validates one event against its versioned schema and returns it unchanged. */
export function validateEvent(event) {
  exact(event, ['v', 'seq', 'type', 'runId', 'at', 'data'], [], 'event');
  if (![1, 2].includes(event.v)) throw new Error(`Unknown ledger version ${event.v}`);
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error('event.seq must be a positive integer');
  if (!EVENT_TYPES.has(event.type)) throw new Error(`Unknown event type ${event.type}`);
  if (!UUID.test(event.runId)) throw new Error('event.runId must be a UUID');
  if (!UTC_MILLIS.test(event.at) || Number.isNaN(Date.parse(event.at))) throw new Error('event.at must be UTC RFC 3339 with milliseconds');
  if (event.v === 1 && ['increment-state', 'amendment', 'adjacent-fix', 'integration'].includes(event.type)) {
    throw new Error(`Unknown event type ${event.type} for ledger version 1`);
  }
  validateData(event);
  return event;
}

// SECTION: Row serialization

/** Serializes one validated event as a newline-terminated Markdown ledger row. */
export function serializeEvent(event) {
  validateEvent(event);
  return `- event: ${canonicalJson(event)}\n`;
}

/** Parses one row and rejects JSON that is valid but not byte-canonical. */
export function parseEventLine(line) {
  if (!line.startsWith('- event: ')) throw new Error('Malformed ledger line');
  let event;
  try { event = JSON.parse(line.slice(9)); } catch { throw new Error('Malformed ledger JSON'); }
  validateEvent(event);
  // Byte-exact canonical form also rejects duplicate keys and reordered properties.
  if (line.slice(9) !== canonicalJson(event)) throw new Error('Ledger line is not canonical JSON');
  return event;
}

// SECTION: Segment folding

function taskFor(state, taskId) {
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`Task "${taskId}" has not started`);
  return task;
}

/**
 * Folds a single run segment into resumable state.
 *
 * @param {any[]} events
 * @param {FoldContext} [context] - State carried across phased segments.
 */
export function foldEvents(events, context = {}) {
  const state = {
    runId: null, version: undefined, terminal: false, needsReconciliation: false, completedTasks: new Map(),
    tasks: new Map(), rulings: new Map(), reviews: [], latestSeq: 0, governingHash: null,
    approved: false,
    // phased-run fold state (v2 increment/integration segments)
    increments: context.incrementStates instanceof Map ? new Map(context.incrementStates) : new Map(),
    amendments: context.amendments instanceof Map ? new Map(context.amendments) : new Map(),
    adjacentFixes: [], integrations: [],
    activeIncrementId: null, segmentAction: null, reopenedIncrementIds: new Set(),
    sawTaskEvent: false, sawIntegrationEvidence: false,
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
      state.segmentAction = event.data.action;
      state.designBinding = event.data.design ?? null;
      if (event.data.action === 'increment') {
        state.activeIncrementId = event.data.increment.id;
        state.approved = true; // the approved design revision binding is the phased approval gate
      }
      if (event.data.action === 'integration') state.approved = true;
    } else if (event.runId !== state.runId) {
      throw new Error('Segment runId changed without run-start');
    }
    if (eventIndex === 1 && state.runStart?.action === 'ordinary' && event.type !== 'approval' &&
        !(event.type === 'ruling' && event.data.key === 'reconciliation')) {
      throw new Error('approval must immediately follow ordinary run-start');
    }
    if (eventIndex === 1 && state.runStart?.repair && !(event.type === 'ruling' && event.data.key === 'reconciliation')) {
      throw new Error('repair run-start must be followed by reconciliation ruling');
    }
    if (event.v !== state.version && state.version !== undefined) throw new Error('Ledger version cannot change within a segment');
    if (eventIndex === 0) state.version = event.v;
    state.latestSeq = event.seq;
    const taskEvent = ['task-start', 'implementation-attempt', 'verification', 'task-complete'].includes(event.type);
    if (taskEvent) {
      if (state.segmentAction === 'design' || state.segmentAction === 'integration') {
        throw new Error(`${state.segmentAction} segments cannot contain implementation tasks`);
      }
      state.sawTaskEvent = true;
      if (state.segmentAction === 'increment' && state.activeIncrementId) {
        state.increments.set(state.activeIncrementId, 'active');
      }
    }
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
          ...event.data, incrementId: state.segmentAction === 'increment' ? state.activeIncrementId : null,
          latestAttempt: nextAttempt - 1, nextAttempt, maxAttempt: nextAttempt - 1 + event.data.attemptBudget, lastAttempt: null,
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
        if (attempt > task.maxAttempt) throw new Error('Attempt exceeds task attemptBudget');
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
        state.approval = event.data;
        break;
      case 'review':
        if (event.data.kind === 'integration') state.sawIntegrationEvidence = true;
        state.reviews.push(event.data);
        break;
      case 'run-complete':
        state.terminal = true;
        state.result = event.data.result;
        if (state.segmentAction === 'increment' && state.activeIncrementId) {
          const allComplete = tasksForUnitsComplete([...state.tasks.values()]);
          // Preserve blocked/invalidated states recorded inside the segment.
          if ((state.increments.get(state.activeIncrementId) ?? 'active') === 'active') {
            state.increments.set(state.activeIncrementId, allComplete ? 'complete' : 'ready');
          }
          state.activeIncrementId = null;
        }
        break;
      case 'increment-state': {
        const { incrementId, prior, next } = event.data;
        if (!state.designBinding && !['increment', 'integration', 'design'].includes(state.segmentAction)) {
          throw new Error('increment-state requires an existing design binding');
        }
        const current = state.increments.get(incrementId) ?? 'pending';
        if (current !== prior) {
          throw new Error(`increment-state prior "${prior}" does not match folded state "${current}" for ${incrementId}`);
        }
        if (!incrementTransitionLegal(prior, next)) {
          throw new Error(`Illegal increment-state transition ${prior}->${next}`);
        }
        if (prior === 'invalidated' && next === 'pending') {
          const activated = state.activatedAmendmentsFor?.get(incrementId) ?? [];
          if (activated.length === 0) {
            throw new Error(`invalidated->pending for ${incrementId} requires a prior activated amendment affecting it`);
          }
        }
        state.increments.set(incrementId, next);
        if (next === 'reopened') {
          for (const [taskId, task] of state.tasks) {
            if (task.incrementId === incrementId) {
              state.tasks.delete(taskId);
              state.completedTasks.delete(taskId);
            }
          }
        }
        break;
      }
      case 'amendment': {
        const { amendmentId, state: amendmentState, affectedIncrements } = event.data;
        const current = state.amendments.get(amendmentId)?.state ?? null;
        const transitionKey = `${current ?? 'none'}->${amendmentState}`;
        if (current && (current === 'activated' || current === 'rejected' || current === 'aborted')) {
          throw new Error(`Amendment "${amendmentId}" is terminal; no further amendment events are legal`);
        }
        const legal = current
          ? AMENDMENT_TRANSITIONS.has(transitionKey)
          : amendmentState === 'proposed';
        if (!legal) {
          throw new Error(`Illegal amendment state transition ${transitionKey}`);
        }
        const { baseRevision, candidateHash } = event.data;
        state.amendments.set(amendmentId, { state: amendmentState, affectedIncrements, baseRevision, candidateHash });
        if (amendmentState === 'activated') {
          state.activatedAmendmentsFor = state.activatedAmendmentsFor ?? new Map();
          for (const incrementId of affectedIncrements) {
            const list = state.activatedAmendmentsFor.get(incrementId) ?? [];
            list.push(amendmentId);
            state.activatedAmendmentsFor.set(incrementId, list);
          }
        }
        break;
      }
      case 'adjacent-fix': {
        if (!state.tasks.has(event.data.clusterId)) {
          throw new Error(`adjacent-fix cluster "${event.data.clusterId}" has no task events`);
        }
        state.adjacentFixes.push(event.data);
        break;
      }
      case 'integration': {
        if (state.segmentAction !== 'integration') {
          throw new Error('integration events are only legal in integration segments');
        }
        if (!state.sawIntegrationEvidence) {
          throw new Error('integration events require prior verification/review evidence');
        }
        state.integrations.push(event.data);
        break;
      }
    }
  }
  return state;
}

function tasksForUnitsComplete(tasks) {
  return tasks.length > 0 && tasks.every(task => task.complete);
}

function incrementTransitionLegal(prior, next) {
  const unfinished = ['pending', 'ready', 'active', 'reopened', 'blocked'];
  if (unfinished.includes(prior) && (next === 'blocked' || next === 'invalidated')) return true;
  if (prior === 'invalidated' && next === 'pending') return true;
  return INCREMENT_LEGAL_TRANSITIONS.has(`${prior}->${next}`);
}

/** Folds each run-start-delimited segment independently. */
export function foldSegments(events) {
  return splitRawSegments(events).map(segment => foldEvents(segment));
}

// SECTION: Segment selection

/** Selects the newest matching unterminated ordinary segment. */
export function selectOrdinarySegment(events, governingHash) {
  const segments = foldSegments(events);
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (!segment.terminal && segment.runStart?.action === 'ordinary' && segment.governingHash === governingHash) return segment;
  }
  return null;
}

/** Selects the newest approved design segment or unresolved repair segment. */
export function selectDesignSegment(events, governingHash) {
  const segments = foldSegments(events);
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (segment.runStart?.action !== 'design' || segment.governingHash !== governingHash) continue;
    if (segment.runStart.repair && segment.rulings?.get('reconciliation')?.state === 'resolved') continue;
    // Approval-less amendment-only design segments are never the durable design stop; repair
    // (reconciliation) segments remain selectable so their ruling can be resolved.
    if (!segment.runStart.repair && (!segment.approval || segment.approval.decision !== 'approved')) continue;
    return segment;
  }
  return null;
}

function designIdentity(runStart) {
  if (!runStart) return null;
  const action = runStart?.data?.action ?? null;
  const governingPath = runStart?.data?.governingPath ?? null;
  const design = runStart?.data?.design ?? null;
  const rootSlug = runStart?.data?.rootSlug ?? null;
  const path = action === 'design' ? governingPath : design?.path ?? null;
  return path
    ? { path: String(path).replaceAll('\\', '/').replace(/^\.\//, ''), rootSlug }
    : null;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.path === right.path && left.rootSlug === right.rootSlug);
}

function splitRawSegments(events) {
  const segments = [];
  let current = [];
  for (const event of events) {
    if (event.type === 'run-start' && current.length) {
      segments.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length) segments.push(current);
  return segments;
}

// SECTION: Cross-segment design runs

/** Cross-segment design-run fold: merges every valid segment for the matching design identity
 *  (normalized design path + root slug) across approved revisions, carrying increment states,
 *  amendments, adjacent-fixes, integration results, and rulings. */
export function foldDesignRun(events) {
  const rawSegments = splitRawSegments(events);
  let identity = null;
  const relevant = [];
  for (const raw of rawSegments) {
    const segmentIdentity = designIdentity(raw[0]);
    if (!identity) {
      if (!segmentIdentity) continue;
      identity = segmentIdentity;
      relevant.push(raw);
      continue;
    }
    if (segmentIdentity && sameIdentity(segmentIdentity, identity)) relevant.push(raw);
  }
  if (relevant.length === 0) return null;
  const designSegments = [];
  const incrementSegments = [];
  const foldedSegments = [];
  let incrementStates = new Map();
  let amendments = new Map();
  for (const raw of relevant) {
    const action = raw[0].data?.action;
    if (action === 'design' && !raw[0].data?.repair) designSegments.push(raw);
    if (PHASED_ACTIONS.has(action)) incrementSegments.push(raw);
    let folded;
    try {
      folded = foldEvents(raw, { incrementStates, amendments });
    } catch (error) {
      return { status: 'needs-reconciliation', diagnostic: error.message };
    }
    foldedSegments.push(folded);
    incrementStates = folded.increments;
    amendments = folded.amendments;
  }
  if (designSegments.length === 0 && incrementSegments.length === 0) return null;
  const completedTasks = new Map();
  let needsReconciliation = false;
  const rulings = new Map();
  let integrationPassed = false;
  let latestUnterminated = null;
  let activeIncrementId = null;
  for (const folded of foldedSegments) {
    for (const [taskId, completion] of folded.completedTasks) completedTasks.set(taskId, completion);
    for (const [key, ruling] of folded.rulings ?? new Map()) rulings.set(key, ruling);
    needsReconciliation = needsReconciliation || folded.needsReconciliation;
    if (folded.integrations?.some(item => item.result === 'pass') &&
        ![...folded.increments.values()].some(stateName => stateName !== 'complete')) {
      integrationPassed = true;
    }
    if (!folded.terminal) {
      latestUnterminated = folded;
      activeIncrementId = folded.activeIncrementId ?? null;
    }
  }
  const approvalBearingIndex = (() => {
    for (let index = foldedSegments.length - 1; index >= 0; index--) {
      if (relevant[index][0].data?.action !== 'design') continue;
      if (foldedSegments[index].approval?.decision === 'approved') return index;
    }
    return null;
  })();
  let approvalRevision = null;
  if (approvalBearingIndex !== null) approvalRevision = foldedSegments[approvalBearingIndex].approval.governingHash;
  // Reject increment/integration segments binding a revision unknown to the folded run.
  const knownRevisions = new Set();
  for (const folded of foldedSegments) {
    if (folded.approval?.governingHash) knownRevisions.add(folded.approval.governingHash);
  }
  for (const raw of relevant) {
    for (const event of raw) {
      if (event.type === 'amendment' && event.data.state === 'activated') knownRevisions.add(event.data.candidateHash);
    }
  }
  for (const raw of incrementSegments) {
    const bound = raw[0].data?.design?.revision ?? null;
    const segmentApproval = foldedSegments[relevant.indexOf(raw)]?.approval?.governingHash ?? null;
    if (segmentApproval) continue;
    if (bound && !knownRevisions.has(bound)) {
      return {
        status: 'needs-reconciliation',
        diagnostic: `Increment segment binds revision ${bound} that matches no approval-bearing revision in the folded run.`,
      };
    }
  }
  return {
    status: 'ok',
    identity,
    incrementStates,
    amendments,
    rulings,
    completedTasks,
    needsReconciliation,
    activeIncrementId: latestUnterminated?.runStart?.action === 'increment' ? activeIncrementId : null,
    integrationPassed,
    approvalRevision,
    latestUnterminated,
  };
}

/** Derives exactly one next action from a design-run fold, in total precedence order:
 *  resolve-reconciliation > resolve-amendment:<id> > resolve-ruling:<key> > resume-increment > implement:I<nn> >
 *  final-integration > complete. Final integration requires every folded increment to be
 *  `complete`; `reopened` increments are resumable/implementable, and `blocked`/`invalidated`
 *  increments without a ready successor resolve to the reconciliation/ruling path. */
export function nextDesignAction(fold) {
  if (!fold) return { action: 'complete' };
  if (fold.status === 'needs-reconciliation') return { action: 'resolve-reconciliation', diagnostic: fold.diagnostic };
  if (fold.needsReconciliation) return { action: 'resolve-reconciliation' };
  for (const [amendmentId, amendment] of fold.amendments ?? new Map()) {
    if (['proposed', 'reviewed', 'prepared'].includes(amendment.state)) {
      return { action: 'resolve-amendment', amendmentId };
    }
  }
  for (const [key, ruling] of fold.rulings ?? new Map()) {
    if (ruling.state === 'open') return { action: 'resolve-ruling', rulingKey: key };
  }
  if (fold.activeIncrementId) return { action: 'resume-increment', incrementId: fold.activeIncrementId };
  const states = fold.incrementStates ?? new Map();
  const priorities = fold.incrementPriorities ?? null;
  const priorityOf = id => (priorities?.get?.(id) ?? Number(id.slice(1)));
  // Only 'ready' and 'reopened' are implementable; 'pending' stays pending until the graph
  // promotion (mergedIncrementStates) proves every prerequisite complete.
  const ready = [...states.entries()]
    .filter(([, stateName]) => stateName === 'ready' || stateName === 'reopened')
    .map(([id]) => id)
    .sort((left, right) => priorityOf(left) - priorityOf(right));
  if (ready.length > 0) return { action: 'implement', incrementId: ready[0] };
  // An empty state map is never vacuously complete.
  const allComplete = states.size > 0 && [...states.values()].every(stateName => stateName === 'complete');
  if (allComplete && !fold.integrationPassed) return { action: 'final-integration' };
  if (allComplete && fold.integrationPassed) return { action: 'complete' };
  // Incomplete increments remain (blocked/invalidated) with nothing implementable: the
  // reconciliation umbrella covers the pending user ruling.
  return {
    action: 'resolve-reconciliation',
    diagnostic: 'Incomplete increments remain but none is implementable; a user ruling is required.',
  };
}
