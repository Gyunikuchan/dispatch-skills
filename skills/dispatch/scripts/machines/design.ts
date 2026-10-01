import type { Await, DesignApproval, Event, HostEvent, RunStartedEvent } from '../core/types.ts';
import type { ParsedDesign } from '../domain/types.ts';
import { asParsedDesign } from '../domain/design.ts';
import { beginApproval, beginBoundImplement, stepImplement, implementAwait, implementData, validateImplement, type ImplementState } from './implement.ts';
import { incrementPathMatches } from '../domain/plan.ts';
import { beginReview, stepReview, reviewAwait, reviewData, validateReview, reviewSpecFromRun, type ReviewState } from './review.ts';
import { beginDesignRevision, stepDesignRevision, designRevisionAwait, designRevisionData, validateDesignRevision, type DesignRevisionState } from './design-revision.ts';
import { answers, isRecord, never, nextId, stay, type Counters, type Step } from './types.ts';
import { slugOf } from './plan.ts';
import { beginRevision, stepRevision, reboundRevision, revisionAwait, revisionData, validateRevision, type RevisionState } from './revision.ts';

export type DesignContext = {
  run: RunStartedEvent; path: string; counters: Counters; design: ParsedDesign | null; hash: string | null;
  approval: DesignApproval | null; baseline: string | null;
  completed: readonly string[]; ownership: Readonly<Record<string, readonly string[]>>;
  histories: Readonly<Record<string, readonly ImplementState[]>>; revisions: readonly { before: string; after: string; reason: string; invalidated: readonly string[] }[];
  repairs: Readonly<Record<string, readonly string[]>>;
  revisionReviewRound: number; integrationRound: number;
  designReview: ReviewState | null; integrationReview: ReviewState | null;
};
export type DesignState =
  | { tag: 'author'; c: DesignContext; defects: readonly Readonly<Record<string, unknown>>[] }
  | { tag: 'parse'; c: DesignContext; effectId: string; afterReview: boolean }
  | { tag: 'review'; c: DesignContext; review: ReviewState }
  | { tag: 'approval'; c: DesignContext }
  | { tag: 'baseline'; c: DesignContext; effectId: string }
  | { tag: 'increment'; c: DesignContext; increment: string; child: ImplementState }
  | { tag: 'plan-revision'; c: DesignContext; increment: string; child: RevisionState }
  | { tag: 'integration'; c: DesignContext; review: ReviewState; scopeEffectId?: string }
  | { tag: 'revision'; c: DesignContext; child: DesignRevisionState; parent?: DesignState }
  | { tag: 'complete'; c: DesignContext; summary: string }
  | { tag: 'failed'; c: DesignContext; summary: string };
type S = Step<DesignState>;
const sharedContractMarker = '[shared-contract]';
const failed = (c: DesignContext, summary: string): S => stay({ tag: 'failed', c, summary });
export function beginDesign(run: RunStartedEvent, counters: Counters = {}): S {
  const path = typeof run.overrides['path'] === 'string' ? run.overrides['path'] : /\.design\.md$/i.test(run.argument) ? run.argument.trim() : `${slugOf(run.argument)}.design.md`;
  const c: DesignContext = { run, path, counters, design: null, hash: null, approval: run.designApproval ?? null, baseline: null, completed: [], ownership: {}, histories: {}, revisions: [], repairs: {}, revisionReviewRound: 0, integrationRound: 0, designReview: null, integrationReview: null };
  return run.verb === 'implement' ? parse(c, false) : stay({ tag: 'author', c, defects: [] });
}
function parse(c: DesignContext, afterReview: boolean): S {
  const next = nextId(c.counters, 'design', 'parse-artifact');
  return { state: { tag: 'parse', c: { ...c, counters: next.counters }, effectId: next.id, afterReview }, effects: [{ kind: 'parse-artifact', id: next.id, path: c.path, artifact: 'design' }] };
}
function reviewed(c0: DesignContext, result: Step<ReviewState>, integration = false): S {
  const review = result.state;
  const c = { ...c0, counters: 'c' in review ? { ...c0.counters, ...review.c.counters } : c0.counters, integrationRound: integration && 'c' in review ? Math.max(c0.integrationRound, review.c.round) : c0.integrationRound, designReview: integration ? c0.designReview : review, integrationReview: integration ? review : c0.integrationReview };
  if (review.tag === 'settled' || review.tag === 'skipped') return integration ? stay({ tag: 'complete', c, summary: 'Every increment and bounded integration completed.' }) : parse(c, true);
  if (['failed', 'escalated', 'empty'].includes(review.tag)) return failed(c, `${integration ? 'Integration' : 'Design'} review did not settle: ${review.tag}`);
  return { state: { tag: integration ? 'integration' : 'review', c, review }, effects: result.effects };
}
export function selectReady(design: ParsedDesign, completed: readonly string[]): string | null {
  return [...design.increments].sort((a, b) => a.priority - b.priority).find((row) => !completed.includes(row.id) && row.prerequisites.every((id) => completed.includes(id)))?.id ?? null;
}
function deliver(c: DesignContext): S {
  if (!c.design || !c.hash || c.approval?.hash !== c.hash) return failed(c, 'Delivery requires journal-owned approval of the current governed revision.');
  const increment = selectReady(c.design, c.completed);
  if (increment) {
    const session = c.run.overrides['sessionDir'];
    if (typeof session !== 'string') return failed(c, 'Delivery requires a journal-bound session directory.');
    const run: RunStartedEvent = { ...c.run, verb: 'implement', argument: `${session}/${slugOf(c.path)}-${increment.toLowerCase()}.plan.md`, overrides: { ...c.run.overrides, path: `${session}/${slugOf(c.path)}-${increment.toLowerCase()}.plan.md` } };
    const details = c.design.details[increment] ?? {};
    const contract = Object.fromEntries(Object.entries(details).filter(([key]) => ['outcome', 'affected contracts', 'rollback boundary'].includes(key.toLowerCase())));
    const result = beginBoundImplement(run, { path: c.path, revision: c.hash, increment, contract, paths: c.design.increments.find((row) => row.id === increment)!.paths, approval: c.approval, repair: c.repairs[increment] ?? [] }, c.counters);
    return { state: { tag: 'increment', c, increment, child: result.state }, effects: result.effects };
  }
  if (c.completed.length !== c.design.increments.length) return failed(c, 'No ready increment remains; prerequisite graph is blocked.');
  if (!c.baseline || c.completed.some((id) => !c.ownership[id]?.length)) return failed(c, 'Integration requires the recorded ancestor baseline and ownership for every increment.');
  const ownership = Object.fromEntries(c.completed.map((id) => [id, c.ownership[id]!]));
  const built = reviewSpecFromRun(c.run, 'code', 'report', '');
  if (!built.ok) return failed(c, built.error);
  const offset = c.integrationRound;
  const result = beginReview({ ...built.spec, context: JSON.stringify({ integration: { baseline: c.baseline, ownership, revision: c.hash }, objective: c.design.box['TL;DR'] }) }, 'design.integration', c.counters);
  if ('c' in result.state) result.state = { ...result.state, c: { ...result.state.c, round: result.state.c.round + offset } };
  if (result.state.tag === 'skipped') {
    const next = nextId(c.counters, 'design.integration', 'prepare-review');
    return { state: { tag: 'integration', c: { ...c, counters: next.counters }, review: result.state, scopeEffectId: next.id }, effects: [{ kind: 'prepare-review', id: next.id, review: { ...built.spec, roster: [] }, round: 1, scope: { scope: 'full', carried: [], integration: { baseline: c.baseline, ownership, revision: c.hash } } }] };
  }
  result.effects = result.effects.map((effect) => effect.kind === 'prepare-review' ? { ...effect, round: effect.round + offset, scope: { ...effect.scope, integration: { baseline: c.baseline, ownership, revision: c.hash } } } : effect);
  return reviewed(c, result, true);
}
function incrementResult(c0: DesignContext, increment: string, result: Step<ImplementState>): S {
  const child = result.state;
  const c = { ...c0, counters: 'c' in child && child.c ? { ...c0.counters, ...child.c.counters } : c0.counters };
  if (child.tag === 'complete') {
    return deliver({ ...c, completed: [...new Set([...c.completed, increment])], ownership: { ...c.ownership, [increment]: [...new Set([...c.ownership[increment] ?? [], ...child.c.changedPaths])] }, histories: { ...c.histories, [increment]: [...c.histories[increment] ?? [], child] } });
  }
  if (child.tag === 'revision-request') {
    const revision = beginRevision(child.parent, child.event);
    return { state: { tag: 'plan-revision', c, increment, child: revision.state }, effects: revision.effects };
  }
  if (child.tag === 'failed' || child.tag === 'stopped') return failed(c, `Increment ${increment}: ${implementData(child)['summary'] ?? child.tag}`);
  return { state: { tag: 'increment', c, increment, child }, effects: result.effects };
}
export function stepDesign(state: DesignState, event: Event): S {
  if (event.type === 'REVISE' && event.artifact === 'design' && !validateDesign(state, event)) {
    const result = beginDesignRevision(state.c, event);
    return { state: { tag: 'revision', c: state.c, child: result.state, parent: state }, effects: result.effects };
  }
  switch (state.tag) {
    case 'author': return event.type === 'AUTHORED' && event.path === state.c.path ? parse(state.c, false) : stay(state);
    case 'parse': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return failed(state.c, event.detail);
      if (event.type !== 'ARTIFACT_PARSED' || event.kind !== 'design' || !answers(event, state.effectId)) return stay(state);
      const design = asParsedDesign(event.parsed);
      if (event.defects.length || !design || !/^sha256:[a-f0-9]{64}$/.test(event.hash)) return stay({ tag: 'author', c: state.c, defects: event.defects.length ? event.defects : [{ message: 'Invalid design payload or governed hash.' }] });
      const c = { ...state.c, design, hash: event.hash };
      if (c.run.verb === 'implement' && c.approval?.hash === event.hash) {
        const next = nextId(c.counters, 'design', 'snapshot');
        return { state: { tag: 'baseline', c: { ...c, counters: next.counters }, effectId: next.id }, effects: [{ kind: 'snapshot', id: next.id, since: null }] };
      }
      c.approval = null;
      if (state.afterReview) return stay({ tag: 'approval', c });
      const built = reviewSpecFromRun(c.run, 'design', 'fix', c.path);
      return built.ok ? reviewed(c, beginReview(built.spec, 'design.review', c.counters)) : failed(c, built.error);
    }
    case 'review': return reviewed(state.c, stepReview(state.review, event));
    case 'approval': {
      if (event.type !== 'DECISION' || event.kind !== 'approval' || validateDesign(state, event)) return stay(state);
      if (event.answer === 'stop') return failed(state.c, 'User declined design approval.');
      const answer = event.answer as { by: 'user'; quote: string; hash: string };
      const c = { ...state.c, approval: answer };
      if (c.run.verb === 'design') return stay({ tag: 'complete', c, summary: `Design approved at ${c.hash}; authoring complete.` });
      const next = nextId(c.counters, 'design', 'snapshot');
      return { state: { tag: 'baseline', c: { ...c, counters: next.counters }, effectId: next.id }, effects: [{ kind: 'snapshot', id: next.id, since: null }] };
    }
    case 'baseline':
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return failed(state.c, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId)) return stay(state);
      return typeof event.fingerprint['head'] === 'string' && /^[a-f0-9]{40,64}$/.test(event.fingerprint['head']) ? deliver({ ...state.c, baseline: event.fingerprint['head'] }) : failed(state.c, 'Integration baseline must be a concrete Git commit.');
    case 'increment': return incrementResult(state.c, state.increment, stepImplement(state.child, event));
    case 'plan-revision': {
      const result = stepRevision(state.child, event);
      const c = { ...state.c, counters: result.state.r.c.counters };
      if (result.state.tag === 'refused') return incrementResult(c, state.increment, stay(result.state.r.parent));
      if (result.state.tag === 'resume') {
        const rebound = reboundRevision(result.state);
        const parent = result.state.r.parent;
        if (result.state.r.grew) return incrementResult(c, state.increment, beginApproval(rebound));
        const child: ImplementState = parent.tag === 'evidence' ? { ...parent, c: rebound, ids: rebound.plan!.criteria.filter((row) => !rebound.evidence[row.id]).map((row) => row.id) } : { ...parent, c: rebound } as ImplementState;
        return incrementResult(c, state.increment, stay(child));
      }
      return { state: { ...state, c, child: result.state }, effects: result.effects };
    }
    case 'integration': {
      if (state.review.tag === 'skipped') {
        if (!answers(event, state.scopeEffectId ?? null)) return stay(state);
        if (event.type === 'EFFECT_FAILED') return failed(state.c, event.detail);
        return event.type === 'REVIEW_PREPARED' && event.scope['empty'] !== true ? stay({ tag: 'complete', c: state.c, summary: 'Every increment completed; integration scope validated and review skipped (rounds 0).' }) : failed(state.c, 'Integration scope validation did not produce owned changes.');
      }
      const result = stepReview(state.review, event);
      if (result.state.tag === 'settled') {
        const accepted = result.state.c.findings.filter((row) => row.status === 'accepted' || row.status === 'downgraded');
        if (accepted.length) {
          const c = { ...state.c, counters: result.state.c.counters, integrationRound: Math.max(state.c.integrationRound, result.state.c.round), integrationReview: result.state };
          const repairs: Record<string, string[]> = {};
          const shared: string[] = [];
          for (const finding of accepted) {
            const paths = finding.fix?.paths ?? [finding.locus.replace(/:L?\d+.*$/, '')];
            const ownersByPath = paths.map((p) => Object.entries(c.ownership).filter(([, owned]) => owned.includes(p)).map(([id]) => id));
            if (!paths.length || ownersByPath.some((owners) => owners.length !== 1)) return failed(c, 'Integration defect ownership is ambiguous or lost.');
            const owners = [...new Set(ownersByPath.flat())];
            const evidence = `${finding.id}: ${finding.defect}; ${finding.requiredChange}`;
            if (owners.length > 1 || finding.resolution?.includes(sharedContractMarker)) shared.push(evidence);
            else (repairs[owners[0]!] ??= []).push(evidence);
          }
          const rebound = { ...c, completed: c.completed.filter((id) => !repairs[id]), repairs: { ...c.repairs, ...repairs } };
          if (shared.length) {
            const revision = beginDesignRevision(rebound, { type: 'REVISE', artifact: 'design', reason: 'Integration shared contract defect', evidence: shared.join('\n') });
            return { state: { tag: 'revision', c: rebound, child: revision.state, parent: { ...state, c: rebound, review: result.state } }, effects: revision.effects };
          }
          return deliver(rebound);
        }
      }
      return reviewed(state.c, result, true);
    }
    case 'revision': {
      const result = stepDesignRevision(state.child, event);
      if (result.state.tag === 'refused') return state.parent && state.parent.tag !== 'integration' && /objective cannot change/.test(result.state.error) ? stay({ ...state.parent, c: { ...state.parent.c, counters: result.state.c.counters, revisionReviewRound: result.state.c.revisionReviewRound } }) : failed(result.state.c, result.state.error);
      if (result.state.tag === 'resume') {
        const r = result.state;
        const original = r.c.approval;
        const approval: DesignApproval | null = original && r.hash !== original.hash ? {
          by: 'revision', quote: original.quote, hash: r.hash, basedOn: original.by === 'user' ? original.hash : original.basedOn,
          revisions: [...original.by === 'revision' ? original.revisions : [], { before: r.c.hash!, after: r.hash }],
        } : original;
        const present = new Set(r.design.increments.map((row) => row.id));
        const ownership: Record<string, string[]> = {};
        const transferred = new Set<string>();
        for (const [previous, paths] of Object.entries(r.c.ownership)) for (const path of paths) {
          const owners = r.design.increments.filter((row) => row.paths.some((scope) => incrementPathMatches(path, scope)));
          if (owners.length !== 1) return failed(r.c, `Design revision cannot reconcile previously changed path ${path}: ${owners.length} owners in the revised design.`);
          const owner = owners[0]!.id;
          (ownership[owner] ??= []).push(path);
          if (owner !== previous) transferred.add(owner);
        }
        for (const id of Object.keys(ownership)) ownership[id] = [...new Set(ownership[id])];
        const invalidated = new Set([...r.delta.invalidated, ...transferred]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const row of r.design.increments) if (!invalidated.has(row.id) && row.prerequisites.some((id) => invalidated.has(id))) { invalidated.add(row.id); grew = true; }
        }
        const c = { ...r.c, path: r.workingPath, design: r.design, hash: r.hash, approval, completed: r.c.completed.filter((id) => !invalidated.has(id) && present.has(id)), ownership, repairs: Object.fromEntries(Object.entries(r.c.repairs).filter(([id]) => present.has(id) && !invalidated.has(id))), revisions: [...r.c.revisions, { before: r.c.hash!, after: r.hash, reason: r.reason, invalidated: [...invalidated] }] };
        const parent = state.parent;
        if (parent?.tag === 'increment' && !invalidated.has(parent.increment) && !r.delta.removed.includes(parent.increment)) {
          const child = parent.child;
          if (!('c' in child) || !child.c?.designBinding || !approval) return failed(c, 'Active increment lost its governing design binding.');
          const context = { ...child.c, counters: { ...child.c.counters, ...c.counters }, designBinding: { ...child.c.designBinding, path: c.path, revision: c.hash, approval } };
          return stay({ tag: 'increment', c, increment: parent.increment, child: { ...child, c: context } as ImplementState });
        }
        return c.run.verb === 'implement' ? deliver(c) : stay({ tag: 'approval', c: { ...c, approval: null } });
      }
      return { state: { tag: 'revision', c: result.state.c, child: result.state, ...(state.parent ? { parent: state.parent } : {}) }, effects: result.effects };
    }
    case 'complete': case 'failed': return stay(state);
    default: return never(state, 'design state');
  }
}
export function designAwait(state: DesignState): Await | null {
  switch (state.tag) {
    case 'author': return 'author'; case 'approval': return 'decide';
    case 'review': return reviewAwait(state.review);
    case 'integration': return state.scopeEffectId ? null : reviewAwait(state.review);
    case 'plan-revision': return revisionAwait(state.child);
    case 'increment': return implementAwait(state.child); case 'revision': return designRevisionAwait(state.child);
    case 'complete': case 'failed': return 'done'; case 'parse': case 'baseline': return null;
    default: return never(state, 'design state');
  }
}
function projectDesignData(state: DesignState): Readonly<Record<string, unknown>> {
  if (state.tag === 'author') return { artifact: 'design', path: state.c.path, template: 'references/templates/design.md', defects: state.defects };
  if (state.tag === 'approval') return { kind: 'approval', hash: state.c.hash, question: 'Approve this governed design revision.', options: ['approve', 'stop'], required: { by: 'user', quote: 'non-empty', hash: state.c.hash } };
  if (state.tag === 'increment') return { ...implementData(state.child), increment: state.increment, revision: state.c.hash };
  if (state.tag === 'revision') return designRevisionData(state.child);
  if (state.tag === 'plan-revision') return revisionData(state.child);
  if (state.tag === 'review' || state.tag === 'integration') return { ...reviewData(state.review), baseline: state.c.baseline, ownership: state.c.ownership, ...(state.tag === 'integration' && reviewAwait(state.review) === 'rule' ? { sharedContract: { rulingField: 'rulings[id].reason', marker: sharedContractMarker, instruction: 'Include the marker for a shared contract defect confined to one owner; acceptance requests design revision.' } } : {}) };
  if (state.tag === 'complete' || state.tag === 'failed') return { outcome: state.tag, summary: state.summary, completion: { governedDesign: { path: state.c.path, revision: state.c.hash }, hash: state.c.hash, approval: state.c.approval, completed: state.c.completed, ownership: state.c.ownership } };
  return {};
}
export function designData(state: DesignState): Readonly<Record<string, unknown>> { return { ...projectDesignData(state), governedDesign: { path: state.c.path, revision: state.c.hash } }; }
export function validateDesign(state: DesignState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return state.tag === 'increment' && event.artifact === 'plan' ? validateImplement(state.child, event) : event.artifact !== 'design' ? 'Only design revision is available on the design parent.' : !state.c.design || !state.c.hash || designAwait(state) === null || state.tag === 'complete' || state.tag === 'failed' || state.tag === 'revision' || state.tag === 'plan-revision' || state.tag === 'increment' && implementAwait(state.child) === 'write' ? 'Finish the outstanding effect or writer before design revision.' : null;
  if (state.tag === 'approval' && event.type === 'DECISION') return event.kind !== 'approval' || event.answer !== 'stop' && (!isRecord(event.answer) || event.answer['by'] !== 'user' || typeof event.answer['quote'] !== 'string' || !event.answer['quote'].trim() || event.answer['hash'] !== state.c.hash) ? 'Approval requires user attribution, quote, and the current governed hash.' : null;
  if (state.tag === 'author' && event.type === 'AUTHORED' && event.path !== state.c.path) return 'event.path: expected governed design path.';
  if (state.tag === 'review' || state.tag === 'integration') return validateReview(state.review, event);
  if (state.tag === 'increment') return validateImplement(state.child, event);
  if (state.tag === 'plan-revision') return validateRevision(state.child, event);
  if (state.tag === 'revision') return validateDesignRevision(state.child, event);
  return null;
}
export const transitions = [
  { from: 'author', on: 'AUTHORED', to: 'parse' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'author' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'review' }, { from: 'parse', on: 'ARTIFACT_PARSED', to: 'approval' }, { from: 'parse', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'approval', on: 'DECISION', to: 'complete' }, { from: 'approval', on: 'DECISION', to: 'baseline' }, { from: 'approval', on: 'DECISION', to: 'failed' }, { from: 'baseline', on: 'SNAPSHOT', to: 'increment' }, { from: 'baseline', on: 'SNAPSHOT', to: 'failed' }, { from: 'baseline', on: 'EFFECT_FAILED', to: 'failed' },
  ...['WAVE_DONE', 'RULINGS', 'ARTIFACT_PARSED', 'DECISION'].map((on) => ({ from: 'review', on, to: 'parse' })),
  ...['REVIEW_PREPARED', 'DECISION', 'EFFECT_FAILED'].map((on) => ({ from: 'review', on, to: 'failed' })),
  { from: 'parse', on: 'ARTIFACT_PARSED', to: 'baseline' },
  { from: 'increment', on: 'SNAPSHOT', to: 'plan-revision' },
  { from: 'increment', on: 'VERIFY_DONE', to: 'integration' },
  { from: 'increment', on: 'SNAPSHOT', to: 'failed' },
  { from: 'plan-revision', on: 'ARTIFACT_PARSED', to: 'increment' },
  { from: 'plan-revision', on: 'DECISION', to: 'increment' },
  ...['author', 'review', 'approval', 'increment', 'integration'].map((from) => ({ from, on: 'REVISE', to: 'revision' })),
  ...['increment', 'revision', 'complete', 'failed'].map((to) => ({ from: 'integration', on: 'RULINGS', to })),
  { from: 'integration', on: 'WAVE_DONE', to: 'complete' },
  { from: 'integration', on: 'REVIEW_PREPARED', to: 'complete' },
  { from: 'integration', on: 'REVIEW_PREPARED', to: 'failed' },
  { from: 'integration', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'integration', on: 'DECISION', to: 'complete' },
  { from: 'integration', on: 'DECISION', to: 'failed' },
  ...['author', 'review', 'approval', 'increment', 'integration', 'failed'].map((to) => ({ from: 'revision', on: 'ARTIFACT_PARSED', to })),
  { from: 'revision', on: 'EFFECT_FAILED', to: 'failed' },
];
