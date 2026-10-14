import { decodePrivate, encodePrivate } from '../domain/private-state.ts';
import { EngineFault } from '../domain/engine-fault.ts';
import type { StateCodec } from '../core/types.ts';
import type { RootState } from './root.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(part: string): never { throw new EngineFault(`checkpoint-state-invalid: ${part}`); }
const variants = {
  root: 'booting design ask plan review implement handoff retro done',
  ask: 'booting preparing wave native done failed',
  plan: 'booting author parsing review complete escalated failed',
  review: 'target-check booting prepare wave native rule decide-needs-user fix fix-verify decide-escalation decide-opt-in settled escalated failed skipped empty',
  implement: 'checking-host-event assessing-host-event drift hotfix-brief hotfix-write hotfix-envelope hotfix-snapshot hotfix-assessment hotfix-verify booting starting author parsing plan-review baseline-preflight baseline baseline-snapshot baseline-decision level-classification level-recommendation integration-conflict request-decision approval needs-user task-checkout task-brief task-prewrite-snapshot tasks plan-replacement task-envelope task-verify delivered-snapshot evidence concerns code-review post-review-snapshot trim-snapshot generated-verify generated-snapshot final-verify failure-snapshot failure complete stopped failed',
  design: 'author parse review approval baseline increment integration revision complete stopped failed',
  revision: 'author parse review scope-adjudication scope-user-decision resume stopped refused',
};
type Kind = keyof typeof variants;

function counters(value: unknown): void {
  if (!object(value) || !Object.values(value).every((counter) => Number.isSafeInteger(counter) && Number(counter) >= 0)) invalid('counters');
}

function state(value: unknown, kind: Kind, depth = 0): void {
  if (depth > 128 || !object(value) || typeof value['tag'] !== 'string' || !variants[kind].split(' ').includes(value['tag'])) invalid(`${kind} variant`);
  const item = value as Record<string, unknown>, tag = String(item['tag']);
  const required = (shape: Record<string, string>): void => {
    for (const [key, type] of Object.entries(shape)) {
      const field = item[key];
      if (type === 'array' ? !Array.isArray(field) : type === 'object' ? !object(field) : typeof field !== type) invalid(`${kind}.${tag}.${key}`);
    }
  };
  if (kind === 'root') {
    if (tag === 'booting') return;
    if (!object(item['run']) || typeof item['run']['verb'] !== 'string' || typeof item['run']['argument'] !== 'string' || typeof item['run']['slug'] !== 'string') invalid('run');
    if (['handoff', 'retro', 'done'].includes(tag)) {
      if (tag === 'handoff') required({ effectId: 'string' });
      counters(item['counters']);
      if (!object(item['done']) || typeof item['done']['outcome'] !== 'string') invalid('completion');
      if (item['last'] !== null) {
        const last = item['last'];
        if (!object(last) || !['ask', 'plan', 'review', 'implement', 'design'].includes(String(last['verb']))) invalid('retained child');
        state((last as Record<string, unknown>)['state'], (last as Record<string, unknown>)['verb'] as Kind, depth + 1);
      }
    } else state(item['child'], tag as Kind, depth + 1);
    return;
  }
  if (tag === 'booting') { counters(item['counters']); return; }
  const context = item['c'];
  if (context === null && tag === 'failed' && ['ask', 'plan', 'implement'].includes(kind)) return;
  if (!object(context)) invalid(`${kind} context`);
  const c = context as Record<string, unknown>;
  counters(c['counters']);
  if (kind === 'review') for (const key of ['priorManifest', 'targetManifest', 'fixCandidate'] as const) {
    const reference = c[`${key}Ref`];
    if (reference !== undefined && (!object(reference) || reference['kind'] !== 'review-manifest' || reference['version'] !== 1 || reference['path'] !== c[key]
      || typeof reference['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(reference['sha256']) || !Number.isSafeInteger(reference['bytes']) || Number(reference['bytes']) < 1)) invalid('review manifest reference');
  }
  if (kind === 'implement') {
    if (c['pendingReplay'] !== undefined) {
      const pending = c['pendingReplay'];
      if (!object(pending) || !object(pending['input']) || !object(pending['input']['replay'])) invalid('pending delivery replay');
      const input = pending['input'], replay = input['replay'] as Record<string, unknown>;
      if (input['rebase'] !== true || typeof input['archivedName'] !== 'string' || !input['archivedName'] || ['base', 'head'].some((key) => typeof replay[key] !== 'string' || !replay[key]) || !Array.isArray(pending['sources']) || !pending['sources'].length || pending['sources'].some((source) => typeof source !== 'string' || !source) || !pending['sources'].includes(replay['head'])) invalid('pending delivery replay');
      const sources = pending['sources'] as unknown[];
      if (new Set(sources).size !== sources.length || (object(c['tasks']) ? Object.values(c['tasks']) : []).concat(Array.isArray(c['retiredTasks']) ? c['retiredTasks'] : []).some((record) => object(record) && typeof record['integrated'] === 'string' && !sources.includes(record['integrated']))) invalid('pending delivery replay sources');
      if (pending['conflict'] !== undefined) {
        const conflict = pending['conflict'];
        if (!object(conflict) || !object(conflict['replay'])) invalid('pending delivery replay conflict');
        if (['task', 'candidate', 'base', 'head', 'detail'].some((key) => typeof conflict[key] !== 'string') || !Number.isSafeInteger(conflict['attempt']) || Number(conflict['attempt']) < 0 || ['paths', 'evidence'].some((key) => !Array.isArray(conflict[key]) || conflict[key].some((value: unknown) => typeof value !== 'string'))) invalid('pending delivery replay conflict');
        const source = conflict['replay'];
        if (['archivedName', 'base', 'head'].some((key) => source[key] !== (key === 'archivedName' ? input[key] : replay[key]))) invalid('pending delivery replay conflict');
        if (source['owners'] !== undefined && (!Array.isArray(source['owners']) || !source['owners'].length || source['owners'].some((owner) => !object(owner) || typeof owner['task'] !== 'string' || !owner['task'] || ['paths', 'commands'].some((key) => !Array.isArray(owner[key]) || owner[key].some((value: unknown) => typeof value !== 'string' || !value.trim()))))) invalid('pending delivery replay ownership');
      }
    }
    if (['checking-host-event', 'assessing-host-event', 'hotfix-brief', 'hotfix-envelope', 'hotfix-snapshot', 'hotfix-assessment', 'hotfix-verify', 'starting', 'parsing', 'baseline-preflight', 'baseline', 'baseline-snapshot', 'task-checkout', 'task-brief', 'task-prewrite-snapshot', 'plan-replacement', 'task-envelope', 'task-verify', 'delivered-snapshot', 'post-review-snapshot', 'trim-snapshot', 'generated-verify', 'generated-snapshot', 'final-verify', 'failure-snapshot'].includes(tag)) required({ effectId: 'string' });
    if (['checking-host-event', 'assessing-host-event', 'drift'].includes(tag)) required({ parked: 'object' });
    if (['task-brief', 'task-prewrite-snapshot', 'task-envelope', 'task-verify'].includes(tag)) required({ task: 'string' });
    if (tag === 'task-checkout') required({ step: 'string' });
    if (tag === 'integration-conflict') required({ conflict: 'object' });
    if (object(item['conflict']) && item['conflict']['replay'] !== undefined) {
      const replay = item['conflict']['replay'];
      if (!object(replay) || ['archivedName', 'base', 'head'].some((key) => typeof replay[key] !== 'string' || !replay[key])) invalid('delivery replay identity');
      if (object(replay) && replay['owners'] !== undefined && (!Array.isArray(replay['owners']) || !replay['owners'].length || replay['owners'].some((owner) => !object(owner) || typeof owner['task'] !== 'string' || !owner['task'] || ['paths', 'commands'].some((key) => !Array.isArray(owner[key]) || owner[key].some((value: unknown) => typeof value !== 'string' || !value.trim()))))) invalid('delivery replay ownership');
    }
    if (tag === 'request-decision') required({ request: 'object', stage: 'string' });
    if (tag === 'evidence') required({ ids: 'array', verify: 'array' });
    if (tag === 'failure') required({ reason: 'string', changedPaths: 'array' });
    if (['complete', 'stopped', 'failed'].includes(tag)) required({ summary: 'string' });
    if (!object(c['run']) || typeof c['planPath'] !== 'string' || !object(c['tasks']) || !object(c['evidence']) || !object(c['records']) || !Number.isSafeInteger(c['mutationEpoch']) || Number(c['mutationEpoch']) < 0) invalid('implementation context');
    for (const task of Object.values(c['tasks'])) {
      if (!object(task) || typeof task['status'] !== 'string' || typeof task['signature'] !== 'string' || !Number.isSafeInteger(task['attempt']) || Number(task['attempt']) < 0) invalid('task identity');
    }
    for (const key of ['planReview', 'codeReview']) if (c[key] !== null) state(c[key], 'review', depth + 1);
  } else if (kind === 'review') {
    if (['prepare', 'wave', 'fix-verify'].includes(tag) && (typeof c['effectId'] !== 'string' || !c['effectId'])) invalid('review effect identity');
    if (tag === 'native') required({ slots: 'array' });
    if (['fix', 'fix-verify'].includes(tag)) required({ clusters: 'array', pass: 'string' });
    if (tag === 'wave') required({ phase: 'string' });
    if (tag === 'settled') required({ exit: 'object', followUps: 'array' });
    if (!object(c['spec']) || !Number.isSafeInteger(c['round']) || !Array.isArray(c['history']) || !Array.isArray(c['rounds']) || !Array.isArray(c['findings'])) invalid('review context');
  } else if (kind === 'design' || kind === 'revision') {
    if (kind === 'design' && ['parse', 'baseline'].includes(tag)) required({ effectId: 'string' });
    if (!object(c['run']) || typeof c['path'] !== 'string' || !object(c['histories']) || !Array.isArray(c['completed']) || !Array.isArray(c['revisions'])) invalid('design context');
    for (const history of Object.values(c['histories'])) {
      if (!Array.isArray(history)) invalid('design history');
      for (const entry of history as unknown[]) state(entry, 'implement', depth + 1);
    }
    for (const key of ['designReview', 'integrationReview']) if (c[key] !== null) state(c[key], 'review', depth + 1);
  } else {
    if (typeof c['path'] !== 'string') invalid(`${kind} path`);
    if (kind === 'ask' && ['preparing', 'wave'].includes(tag) || kind === 'plan' && tag === 'parsing') if (typeof c['effectId'] !== 'string' || !c['effectId']) invalid(`${kind} effect identity`);
    if (kind === 'ask' && tag === 'native') required({ slots: 'array' });
  }
  if (typeof item['effectId'] !== 'undefined' && typeof item['effectId'] !== 'string') invalid('effect identity');
  if (item['parent'] !== undefined) state(item['parent'], kind, depth + 1);
  if (item['before'] && kind === 'review') state(item['before'], kind, depth + 1);
  if (item['origin'] && kind === 'implement') state(item['origin'], kind, depth + 1);
  if (item['review'] !== undefined && item['review'] !== null) state(item['review'], 'review', depth + 1);
  if (item['child'] !== undefined) state(item['child'], kind === 'design' && tag === 'revision' ? 'revision' : 'implement', depth + 1);
  if (kind === 'implement' && ['checking-host-event', 'assessing-host-event', 'drift'].includes(tag) && !object(item['parent'])) invalid('suspended state');
  if (kind === 'review' && tag === 'target-check' && (!object(item['before']) || !object(item['pending']))) invalid('review continuation');
  if (kind === 'design' && ['increment', 'revision'].includes(tag) && !object(item['child'])) invalid('design child');
}

export const rootStateCodec: StateCodec<RootState> = {
  name: 'dispatch-root', version: 1, runtime: () => 'dispatch-root:unbound',
  encode(value) { state(value, 'root'); return encodePrivate(value); },
  decode(value) { const result = decodePrivate(value); state(result, 'root'); return result as RootState; },
};
