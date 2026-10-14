// Root machine (spec §5.3): verb selection, review kind inference, terminal handoff, `done` projection, host-event
// validation, and driver-owned Markdown rendering (resolution sections, plan Task Maps, and the standalone report; not an effect).

import type { Await, Event, HostEvent, Machine, Ports, RunStartedEvent, Verb } from '../core/types.ts';
import {
  renderCompactResolutionSection, renderReport, renderResolutionSection, replaceResolutionSection, resolutionSectionOf, reviewLogPathOf, walkthroughPathOf,
} from '../domain/render.ts';
import type { ReviewKind } from '../domain/types.ts';
import { parsePlan, renderTaskMap, replaceTaskMapSection } from '../domain/plan.ts';
import { askAwait, askData, askSpecFromRun, beginAsk, stepAsk, validateAsk, type AskState } from './ask.ts';
import { beginPlan, planAwait, planData, planInputFromRun, slugOf, stepPlan, validatePlan, type PlanState } from './plan.ts';
import {
  beginReview, isReviewTerminal, resolutionRounds, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState,
} from './review.ts';
import { implementAwait, implementData, implementMachine, renderImplementWalkthrough, stepImplement, validateImplement, type ImplementState } from './implement.ts';
import { answers, isRecord, never, nextId, stay, type Claim, type Counters, type DoneData, type Step } from './types.ts';
import { executionBindingDeferred, reconfigureRoot } from './execution-config.ts';
import { refreshedRun } from '../domain/execution-config.ts';
import { rootStateCodec } from './checkpoint.ts';
import { beginDesign, stepDesign, designAwait, designData, validateDesign, type DesignState } from './design.ts';

export type RunInfo = { verb: Verb; argument: string; slug: string; defaults?: RunStartedEvent };

export type RootState =
  | { tag: 'design'; run: RunInfo; child: DesignState }
  | { tag: 'booting' }
  | { tag: 'ask'; run: RunInfo; child: AskState }
  | { tag: 'plan'; run: RunInfo; child: PlanState }
  | { tag: 'review'; run: RunInfo; child: ReviewState }
  | { tag: 'implement'; run: RunInfo; child: ImplementState }
  | { tag: 'handoff'; run: RunInfo; last: Child | null; counters: Counters; effectId: string; done: DoneData }
  | { tag: 'retro'; run: RunInfo; last: Child | null; counters: Counters; done: DoneData; handoff: string | null; warning: string | null }
  | { tag: 'done'; run: RunInfo; last: Child | null; counters: Counters; done: DoneData; handoff: string | null; warning: string | null };

export type Child = { verb: 'design'; state: DesignState } | { verb: 'ask'; state: AskState } | { verb: 'plan'; state: PlanState } | { verb: 'review'; state: ReviewState } | { verb: 'implement'; state: ImplementState };

type S = Step<RootState>;

// SECTION: Kind inference

/** `--kind` wins; else `.plan.md` → plan, `.design.md` → design, otherwise code (range, paths, or working tree). */
export function inferKind(argument: string, overrides: Readonly<Record<string, unknown>>): ReviewKind {
  const kind = overrides['kind'];
  if (kind === 'plan' || kind === 'design' || kind === 'code') return kind;
  const target = argument.trim();
  if (/\.plan\.md$/i.test(target)) return 'plan';
  if (/\.design\.md$/i.test(target)) return 'design';
  return 'code';
}

// SECTION: Child plumbing

function childOf(state: RootState): Child | null {
  switch (state.tag) {
    case 'design': return { verb: 'design', state: state.child };
    case 'ask': return { verb: 'ask', state: state.child };
    case 'plan': return { verb: 'plan', state: state.child };
    case 'review': return { verb: 'review', state: state.child };
    case 'implement': return { verb: 'implement', state: state.child };
    case 'handoff': case 'retro': case 'done': return state.last;
    case 'booting': return null;
    default: return never(state, 'root state');
  }
}

function countersOf(child: Child): Counters {
  const state = child.state;
  if ('c' in state && state.c !== null) return state.c.counters;
  return 'counters' in state ? state.counters : {};
}

function terminal(child: Child): boolean {
  switch (child.verb) {
    case 'design': return child.state.tag === 'complete' || child.state.tag === 'stopped' || child.state.tag === 'failed';
    case 'ask': return child.state.tag === 'done' || child.state.tag === 'failed';
    case 'plan': return child.state.tag === 'complete' || child.state.tag === 'escalated' || child.state.tag === 'failed';
    case 'review': return isReviewTerminal(child.state);
    case 'implement': return child.state.tag === 'complete' || child.state.tag === 'stopped' || child.state.tag === 'failed';
    default: return never(child, 'child');
  }
}

function childData(child: Child): Readonly<Record<string, unknown>> {
  switch (child.verb) {
    case 'design': return designData(child.state);
    case 'ask': return askData(child.state);
    case 'plan': return planData(child.state);
    case 'review': return reviewData(child.state);
    case 'implement': return implementData(child.state);
    default: return never(child, 'child');
  }
}

function doneOf(child: Child): DoneData {
  const data = childData(child);
  const outcome = data['outcome'] as DoneData['outcome'];
  const done: DoneData = { outcome, summary: String(data['summary'] ?? outcome) };
  if (Array.isArray(data['claims'])) done.claims = data['claims'] as readonly Claim[];
  if (Array.isArray(data['failed'])) done.completion = { failed: data['failed'] };
  if (isRecord(data['completion'])) done.completion = data['completion'];
  return done;
}

function toHandoff(run: RunInfo, last: Child | null, counters: Counters, done: DoneData): S {
  const { id, counters: next } = nextId(counters, 'root', 'handoff');
  return { state: { tag: 'handoff', run, last, counters: next, effectId: id, done }, effects: [{ kind: 'handoff', id, terminal: true }] };
}

function wrap(run: RunInfo, child: Child, effects: Step<unknown>['effects']): S {
  if (terminal(child)) return toHandoff(run, child, countersOf(child), doneOf(child));
  switch (child.verb) {
    case 'design': return { state: { tag: 'design', run, child: child.state }, effects };
    case 'ask': return { state: { tag: 'ask', run, child: child.state }, effects };
    case 'plan': return { state: { tag: 'plan', run, child: child.state }, effects };
    case 'review': return { state: { tag: 'review', run, child: child.state }, effects };
    case 'implement': return { state: { tag: 'implement', run, child: child.state }, effects };
    default: return never(child, 'child');
  }
}

const failed = (run: RunInfo, summary: string): S => toHandoff(run, null, {}, { outcome: 'failed', summary });

function boot(event: RunStartedEvent): S {
  const run: RunInfo = { verb: event.verb, argument: event.argument, slug: slugOf(event.argument, event.verb), defaults: event };
  event = { ...event, overrides: { ...event.overrides, artifactSlug: run.slug } };
  switch (event.verb) {
    case 'ask': {
      const built = askSpecFromRun(event);
      if (!built.ok) return failed(run, built.error);
      const result = beginAsk(built.spec, 'ask', {});
      return wrap(run, { verb: 'ask', state: result.state }, result.effects);
    }
    case 'plan': {
      const built = planInputFromRun(event);
      if (!built.ok) return failed(run, built.error);
      const result = beginPlan(built.input, 'plan', {});
      return wrap(run, { verb: 'plan', state: result.state }, result.effects);
    }
    case 'review': {
      const kind = inferKind(event.argument, event.overrides);
      const built = reviewSpecFromRun(event, kind, event.fix ? 'fix' : 'report', event.argument.trim());
      if (!built.ok) return failed(run, built.error);
      const result = beginReview(built.spec, 'review', {});
      return wrap(run, { verb: 'review', state: result.state }, result.effects);
    }
    case 'implement': {
      if (/\.design\.md$/i.test(event.argument.trim()) || event.overrides['kind'] === 'design') {
        const result = beginDesign(event);
        return wrap(run, { verb: 'design', state: result.state }, result.effects);
      }
      const result = stepImplement(implementMachine.initial(), event);
      return wrap(run, { verb: 'implement', state: result.state }, result.effects);
    }
    case 'design': {
      const result = beginDesign(event);
      return wrap(run, { verb: 'design', state: result.state }, result.effects);
    }
    default: return never(event.verb, 'verb');
  }
}

// SECTION: Step

export function stepRoot(state: RootState, event: Event): S {
  switch (state.tag) {
    case 'design': { const result = stepDesign(state.child, event); return wrap(state.run, { verb: 'design', state: result.state }, result.effects); }
    case 'booting': return event.type === 'RUN_STARTED' ? boot(event) : stay(state);
    case 'ask': { const result = stepAsk(state.child, event); return wrap(state.run, { verb: 'ask', state: result.state }, result.effects); }
    case 'plan': { const result = stepPlan(state.child, event); return wrap(state.run, { verb: 'plan', state: result.state }, result.effects); }
    case 'review': { const result = stepReview(state.child, event); return wrap(state.run, { verb: 'review', state: result.state }, result.effects); }
    case 'implement': { const result = stepImplement(state.child, event); return wrap(state.run, { verb: 'implement', state: result.state }, result.effects); }
    case 'handoff': {
      const base = { run: state.run, last: state.last, counters: state.counters, done: state.done };
      // The journaled diagnostics decision governs the rest of the run, so replay never consults live settings.
      if (event.type === 'HANDOFF_DONE' && answers(event, state.effectId)) return stay({ tag: event.diagnostics === true ? 'retro' : 'done', ...base, handoff: event.destination, warning: event.warning });
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return stay({ tag: 'done', ...base, handoff: null, warning: `handoff failed: ${event.cls}: ${event.detail}` });
      return stay(state);
    }
    case 'retro': {
      const { tag: _tag, ...rest } = state;
      return event.type === 'RETRO' ? stay({ tag: 'done', ...rest }) : stay(state);
    }
    case 'done': return stay(state);
    default: return never(state, 'root state');
  }
}

function awaitOf(state: RootState): Await | null {
  switch (state.tag) {
    case 'design': return designAwait(state.child);
    case 'ask': return askAwait(state.child);
    case 'plan': return planAwait(state.child);
    case 'review': return reviewAwait(state.child);
    case 'implement': return implementAwait(state.child);
    case 'retro': return 'retro';
    case 'done': return 'done';
    case 'booting': case 'handoff': return null;
    default: return never(state, 'root state');
  }
}

function project(state: RootState): { at: string; data: Readonly<Record<string, unknown>> } {
  switch (state.tag) {
    case 'design': return { at: `design › ${state.child.tag}`, data: designData(state.child) };
    case 'booting': case 'handoff': return { at: `root › ${state.tag}`, data: {} };
    case 'ask': return { at: `ask › ${state.child.tag}`, data: askData(state.child) };
    case 'plan': return { at: `plan › ${state.child.tag}${state.child.tag === 'review' ? ` › ${state.child.review.tag}` : ''}`, data: planData(state.child) };
    case 'review': return { at: `review › ${state.child.tag}`, data: reviewData(state.child) };
    case 'implement': return { at: `implement › ${state.child.tag}${state.child.tag === 'plan-review' || state.child.tag === 'code-review' ? ` › ${state.child.review.tag}` : ''}`, data: implementData(state.child) };
    case 'retro': return { at: `${state.run.verb} › retro`, data: { kind: 'retro' } };
    case 'done': {
      const data: Record<string, unknown> = { ...state.done, handoff: state.handoff };
      if (state.warning !== null) data['warning'] = state.warning;
      return { at: `${state.run.verb} › done`, data };
    }
    default: return never(state, 'root state');
  }
}

function validate(state: RootState, event: HostEvent): string | null {
  // NOTE: only an active implementation child consumes dispositions; suspended children cannot receive them.
  if (event.changeDispositions && state.tag !== 'implement' && !(state.tag === 'design' && state.child.tag === 'increment' && !(event.type === 'REVISE' && event.artifact === 'design'))) return 'event.changeDispositions: this run has no change observation to dispose.';
  // NOTE: only an active review frame lists review observations; elsewhere a selection would be silently dropped.
  if (event.type === 'REVIEW_USE' && !Array.isArray(project(state).data['reviewObservations'])) return 'event.type: REVIEW_USE needs an active review frame with a target change observation.';
  switch (state.tag) {
    case 'design': return validateDesign(state.child, event);
    case 'ask': return validateAsk(state.child, event);
    case 'plan': return validatePlan(state.child, event);
    case 'review': return validateReview(state.child, event);
    case 'implement': return validateImplement(state.child, event);
    case 'booting': case 'handoff': case 'retro': case 'done': return null;
    default: return never(state, 'root state');
  }
}

// SECTION: Render

/** The session root when the run dir sits at `<session>/.state/runs/<id>`; the run dir otherwise. */
export function sessionDirOf(runDir: string): string {
  const stripped = runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
  return stripped === runDir ? runDir.replace(/[\\/]+$/, '') : stripped;
}

export const reportPathOf = (runDir: string, slug: string): string => `${sessionDirOf(runDir)}/${slug}.report.md`;

function writeIfChanged(ports: Ports, file: string, text: string): void {
  if (ports.fs.exists(file) && ports.fs.readText(file) === text) return;
  ports.fs.writeAtomic(file, text);
}

function reviewKeyOf(runDir: string, machinePath: string): string {
  const session = sessionDirOf(runDir).replace(/\\/g, '/').split('/').at(-1);
  const run = runDir.replace(/\\/g, '/').split('/').at(-1);
  return `${session}/${run}/${machinePath}`;
}

/**
 * Records `section` under `key` in the sibling review log, then writes `doc` to `file` with the compact section.
 * A new log starts from `seedLog` (the log of the artifact `file` was copied from) or from full inline history.
 */
function writeReviewHistory(ports: Ports, file: string, doc: string, section: string, key: string, seedLog?: string): void {
  const logPath = reviewLogPathOf(file), logName = logPath.split(/[\\/]/).at(-1)!;
  let prior = ports.fs.exists(logPath) ? ports.fs.readText(logPath) : null;
  if (prior === null) {
    const seeded = seedLog && seedLog !== logPath && ports.fs.exists(seedLog) ? resolutionSectionOf(ports.fs.readText(seedLog)) : null;
    // NOTE: a deliverable rendered before the log existed carries full history inline; move it into the new log.
    const inline = ports.fs.exists(file) ? resolutionSectionOf(ports.fs.readText(file)) : null;
    const legacy = [seeded, inline].find((history) => history && /^#{3,} /m.test(history)) ?? '';
    // An unreviewed deliverable keeps its empty-state section and gets no log.
    if (!legacy && !/^#{3,} /m.test(section)) return writeIfChanged(ports, file, replaceResolutionSection(doc, section));
    prior = `# Review log: ${file.split(/[\\/]/).at(-1)}\n${legacy ? `\n${legacy}\n` : ''}`;
  }
  const log = replaceResolutionSection(prior, section, key);
  writeIfChanged(ports, logPath, log);
  writeIfChanged(ports, file, replaceResolutionSection(doc, renderCompactResolutionSection(log, logName)));
}

function writeSection(ports: Ports, file: string, review: ReviewState, runDir: string, seedLog?: string): void {
  if (!('c' in review) || !review.c.rounds.length || !ports.fs.exists(file)) return;
  const rounds = resolutionRounds(review.c);
  writeReviewHistory(ports, file, ports.fs.readText(file), renderResolutionSection(rounds), reviewKeyOf(runDir, review.c.path), seedLog);
}

/** Writes the driver-owned Task Map into a plan that parses; a plan with defects keeps its text until the author fixes it. */
function writeTaskMap(ports: Ports, file: string): void {
  if (!ports.fs.exists(file)) return;
  const source = ports.fs.readText(file);
  const parsed = parsePlan(source);
  if (parsed.ok) writeIfChanged(ports, file, replaceTaskMapSection(source, renderTaskMap(parsed.plan)));
}

function renderImplementation(ports: Ports, implementation: ImplementState, walkthroughPath: string, runDir: string): void {
  // NOTE: an AMEND binds the run to its amended plan text; the file is written once so reruns see the bound hash.
  for (const amendment of 'c' in implementation ? implementation.c?.amendments ?? [] : []) {
    if (!ports.fs.exists(amendment.path)) ports.fs.writeAtomic(amendment.path, amendment.text);
    // The Task Map is outside the governed hash, so adding it keeps the bound revision; replacement plans stay as supplied.
    if ((amendment.kind ?? 'amend') === 'amend') writeTaskMap(ports, amendment.path);
  }
  // A plan this run authored gets its map once it parses and keeps it current through review fixes; supplied plans stay as written.
  const authored = 'c' in implementation && implementation.tag !== 'author' && implementation.c?.plan ? implementation.c.authoredPlan : undefined;
  if (authored) writeTaskMap(ports, authored);
  if ('c' in implementation && implementation.c?.planReview) writeSection(ports, implementation.c.planPath, implementation.c.planReview, runDir);
  const walkthrough = renderImplementWalkthrough(implementation);
  if (walkthrough) writeReviewHistory(ports, walkthroughPath, walkthrough, resolutionSectionOf(walkthrough)!, reviewKeyOf(runDir, 'implementation'));
}

function render(state: RootState, ports: Ports, runDir: string): void {
  const child = childOf(state);
  if (!child || state.tag === 'booting') return;
  if (child.verb === 'design') {
    const design = child.state;
    if (design.c.designReview && 'c' in design.c.designReview) writeSection(ports, design.c.designReview.c.spec.target, design.c.designReview, runDir);
    const integration = design.c.integrationReview;
    if (integration && 'c' in integration) {
      if (ports.fs.exists(design.c.path)) writeSection(ports, design.c.path, integration, runDir);
      else writeIfChanged(ports, reportPathOf(runDir, `${state.run.slug}-integration`), renderReport({ title: 'Design integration', kind: 'code', target: design.c.path, summary: `Integration of ${design.c.hash}`, rounds: resolutionRounds(integration.c) }));
    }
    if (design.tag === 'revision') {
      const r = design.child;
      if (!ports.fs.exists(r.workingPath)) ports.fs.writeAtomic(r.workingPath, ports.fs.readText(r.c.path));
      // The copy's compact section links the source log; the revision's own log starts from it so both histories survive.
      if (r.tag === 'review') writeSection(ports, r.workingPath, r.review, runDir, reviewLogPathOf(r.c.path));
    }
    if (design.tag === 'review') writeSection(ports, design.c.path, design.review, runDir);
    for (const [id, history] of Object.entries(design.c.histories)) {
      renderImplementation(ports, history.at(-1)!, walkthroughPathOf(sessionDirOf(runDir), state.run.slug, id), runDir);
    }
    if (design.tag === 'increment') {
      renderImplementation(ports, design.child, walkthroughPathOf(sessionDirOf(runDir), state.run.slug, design.increment), runDir);
    }
    return;
  }
  if (child.verb === 'plan') {
    const plan = child.state;
    // An authored plan reaches review only after it parses; later fixes refresh the map on each render.
    if ('review' in plan && plan.review !== null && plan.c) writeTaskMap(ports, plan.c.input.path);
    if ('review' in plan && plan.review !== null && 'c' in plan.review) writeSection(ports, plan.review.c.spec.target, plan.review, runDir);
    return;
  }
  if (child.verb === 'implement') {
    renderImplementation(ports, child.state, walkthroughPathOf(sessionDirOf(runDir), state.run.slug), runDir);
    return;
  }
  if (child.verb !== 'review') return;
  const review = child.state;
  if (!('c' in review) || !review.c.rounds.length) return;
  const { spec } = review.c;
  const summary = isReviewTerminal(review) ? String(reviewData(review)['summary']) : `round ${review.c.round} in progress (${review.tag})`;
  const owner = spec.kind === 'code' ? spec.governing?.walkthroughPath : spec.target;
  if (owner && ports.fs.exists(owner)) writeSection(ports, owner, review, runDir);
  else writeIfChanged(ports, reportPathOf(runDir, state.run.slug), renderReport({
    title: `Review: ${spec.target || 'working tree'}`, kind: spec.kind, target: spec.target || 'working tree', summary, rounds: resolutionRounds(review.c),
  }));
}

// SECTION: Machine

export const rootTransitions = [
  { from: 'booting', on: 'RUN_STARTED', to: 'design' },
  { from: 'design', on: 'DECISION', to: 'handoff' },
  { from: 'design', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'implement', on: 'RECOVERY_ASSESSED', to: 'handoff' },
  { from: 'booting', on: 'RUN_STARTED', to: 'ask' },
  { from: 'booting', on: 'RUN_STARTED', to: 'plan' },
  { from: 'booting', on: 'RUN_STARTED', to: 'review' },
  { from: 'booting', on: 'RUN_STARTED', to: 'implement' },
  { from: 'booting', on: 'RUN_STARTED', to: 'handoff' },
  { from: 'ask', on: 'WAVE_DONE', to: 'handoff' },
  { from: 'ask', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'plan', on: 'ARTIFACT_PARSED', to: 'handoff' },
  { from: 'plan', on: 'WAVE_DONE', to: 'handoff' },
  { from: 'plan', on: 'RULINGS', to: 'handoff' },
  { from: 'plan', on: 'DECISION', to: 'handoff' },
  { from: 'plan', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'review', on: 'REVIEW_PREPARED', to: 'handoff' },
  { from: 'review', on: 'WAVE_DONE', to: 'handoff' },
  { from: 'review', on: 'RULINGS', to: 'handoff' },
  { from: 'review', on: 'DECISION', to: 'handoff' },
  { from: 'review', on: 'VERIFY_DONE', to: 'handoff' },
  { from: 'review', on: 'ARTIFACT_PARSED', to: 'handoff' },
  { from: 'review', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'implement', on: 'EFFECT_FAILED', to: 'handoff' },
  { from: 'implement', on: 'SNAPSHOT', to: 'handoff' },
  { from: 'implement', on: 'VERIFY_DONE', to: 'handoff' },
  { from: 'handoff', on: 'HANDOFF_DONE', to: 'done' },
  { from: 'handoff', on: 'HANDOFF_DONE', to: 'retro' },
  { from: 'handoff', on: 'EFFECT_FAILED', to: 'done' },
  { from: 'retro', on: 'RETRO', to: 'done' },
] as const;

export const rootMachine: Machine<RootState> = {
  codec: rootStateCodec,
  initial: () => ({ tag: 'booting' }),
  step: stepRoot,
  awaitOf,
  project,
  transitions: rootTransitions,
  validate,
  render,
  ownedArtifacts(state, runDir) {
    const session = sessionDirOf(runDir), owned = [`${session}/manifest.json`, `${session}/diagnostics.md`];
    if (!('run' in state)) return owned;
    if (state.tag === 'review' && 'c' in state.child && state.child.c.spec.kind === 'code' && !state.child.c.spec.governing?.walkthroughPath) owned.push(reportPathOf(runDir, state.run.slug));
    const walkthroughs: string[] = [];
    if (state.tag === 'implement') walkthroughs.push(walkthroughPathOf(session, state.run.slug));
    if (state.tag === 'design') for (const id of [...Object.keys(state.child.c.histories), ...(state.child.tag === 'increment' ? [state.child.increment] : [])]) walkthroughs.push(walkthroughPathOf(session, state.run.slug, id));
    for (const file of walkthroughs) owned.push(file, reviewLogPathOf(file));
    return owned;
  },
  executionDeferred: executionBindingDeferred,
  reconfigure(state, event) {
    if (!('run' in state) || !state.run.defaults) throw new Error('execution-config-unavailable: run defaults are unavailable');
    const run = refreshedRun(state.run.defaults, event);
    const next = reconfigureRoot(state, event, run);
    return 'run' in next ? { ...next, run: { ...next.run, defaults: run } } : next;
  },
};
