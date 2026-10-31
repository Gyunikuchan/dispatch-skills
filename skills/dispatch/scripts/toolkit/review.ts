import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { artifactHash, artifactKind } from './artifacts.ts';
import { confirmGate, foldLedger, latest, levelGate, withLedger, currentHashes, type Hashes } from './ledger.ts';
import { withLockFile } from './lock.ts';
import { fanOut, resolveSlots, underfillNote, type SlotOutcome, type Validation } from './fanout.ts';
import type { Underfill } from '../policy/roster.ts';
import { parseReport } from './domain/report.ts';
import { parsePlan, selectTaskBrief, structuralLines } from './domain/plan.ts';
import { parseIncrementGraph } from './domain/design.ts';
import type { Finding, ReviewKind, RosterSlot } from './domain/types.ts';
import { taskMarkdown } from './brief.ts';
import { artifactSections, changedHeadings, reviewPrompt, type Settled } from './prompts.ts';
import { finalizeRound, type Finalized, type FindingsValue, type ReviewTarget } from './findings.ts';
import { git, gitOk } from './git.ts';
import { launches } from './writers.ts';
import { integrationRecord } from './integration.ts';
import { loadPlan, ownedPaths } from './plan-view.ts';
import { LEVELS, type Level } from './types.ts';
import { summaryWithItems, ToolError } from './output.ts';
import { redGaps } from './red.ts';
import { loadRejections, reviewId, rejectionRequest, type RejectionRequest, type ConfirmationRound } from './confirmations.ts';
import { refreshFindingsSection } from './review-findings.ts';

// NOTE: shared by every target rejection so the host can correct its target in one turn.
const CODE_TARGETS = 'code targets are integration, a bound-plan task ID, worktree, <a>..<b> or <rev>';

type Capture = {artifactPath?:string; artifacts?:Hashes; spec: {path: string; hash: string}; target: ReviewTarget; source?: string; taskSummary: string; cwd: string; changed: string[]};
type Round = {artifactPath?:string; requests?:RejectionRequest[]; rulingSnapshot?:string; round: number; generation: number; cap: number; level: Level; roster: RosterSlot[]; scope: string; startSeq: number; spec: Capture['spec']; artifacts?:Hashes; target: ReviewTarget; underfill?: Underfill; turnTarget: number; contextMapPath?: string};
function read<T>(file: string): T | null {
  try {return JSON.parse(fs.readFileSync(file, 'utf8')) as T;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
}
function atomic(file: string, value: unknown) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600}); fs.renameSync(temp, file);}
  finally {fs.rmSync(temp, {force: true});}
}
const same = (round: Round, capture: Capture) => (!round.artifactPath || round.artifactPath===capture.artifactPath) && round.spec.hash === capture.spec.hash && round.spec.path === capture.spec.path && JSON.stringify(round.target) === JSON.stringify(capture.target) && JSON.stringify(round.artifacts) === JSON.stringify(capture.artifacts);
const label = (target: ReviewTarget) => typeof target === 'string' ? target : target.head;
const splitPaths = (text: string) => text.split('\0').filter(Boolean);
// NOTE: an unreadable spec reports the same invalid-input as capture, which keeps the refusal reason stable.
function specHashFor(root: string, input: string): string {
  const specPath = path.resolve(root, input);
  let text: string;
  try {text = fs.readFileSync(fs.realpathSync.native(specPath), 'utf8');}
  catch {throw new ToolError(1, 'invalid-input', 'Cannot read spec ' + specPath);}
  return artifactHash('spec', text);
}
// SECTION: Turn targets
// NOTE: a plan that fails lint has no parsed file entries, so its target counts zero paths; the review still reports its defects.
const planPaths = (source: string) => {const parsed = parsePlan(source); return parsed.ok ? parsed.plan.changes.map(change => change.path) : [];};
const designPaths = (source: string) => parseIncrementGraph(structuralLines(source)).increments.flatMap(increment => increment.paths);
const turnTarget = (paths: string[]) => 6 + 2 * new Set(paths).size;

export async function reviewRun(ctx: HandlerContext): Promise<HandlerResult> {
  const {session, manifest, deps} = ctx;
  if (ctx.args.length !== 1) throw new ToolError(1, 'invalid-input', 'One review target is required: ' + CODE_TARGETS + '; plan and design targets are artifact paths');
  const requested = ctx.args[0]!;
  const inferred = artifactKind(requested);
  const kind = (ctx.values['kind'] ?? (inferred === 'plan' || inferred === 'design' ? inferred : 'code')) as ReviewKind;
  if (!['code', 'plan', 'design'].includes(kind)) throw new ToolError(1, 'invalid-input', 'Review kind must be code, plan or design');
  const fold = foldLedger(session);
  const level = (ctx.values['level'] ?? latest(fold, 'level')?.data['level'] ?? 'medium') as Level;
  if (!LEVELS.includes(level)) throw new ToolError(1, 'invalid-input', 'Unknown level');
  const gate = levelGate(fold, level);
  if (!gate.allowed) throw new ToolError(4, gate.reason!, gate.reason!);
  const confirmInput = ctx.values['spec'] ?? latest(fold, 'bind')?.data['spec'];
  if (kind !== 'code') {
    // Refuse before the zero-round skip so plan/design review never bypasses confirmation.
    if (typeof confirmInput !== 'string') throw new ToolError(4, 'lint-errors', 'Review needs --spec or a bound spec');
    const confirmation = confirmGate(fold, specHashFor(manifest.repositoryRoot, confirmInput));
    if (!confirmation.allowed) throw new ToolError(4, confirmation.reason!, confirmation.reason!);
  }
  const roster = resolveSlots(kind, level, deps), cap = roster.rounds;
  const artifact = kind === 'code' ? requested : path.resolve(manifest.repositoryRoot, requested);
  const bound = latest(fold, 'bind');
  let taskTarget = false;
  if (kind === 'code' && bound && requested !== 'integration' && requested !== 'worktree' && !requested.includes('..')) {
    try {taskTarget = loadPlan(session, manifest).tasks.some(task => task.id === requested);}
    catch (error) {
      // An unusable plan cannot classify tasks, but standalone revision review still works.
      if (!(error instanceof ToolError && error.reason === 'lint-errors') &&
          !['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  const gitTarget = kind === 'code' && requested !== 'integration' && !taskTarget;
  // Worktree rounds count per HEAD, so a commit starts a new series instead of inheriting an older change's cap.
  let series = '';
  if (requested === 'worktree') {
    const head = await git(deps, manifest.repositoryRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    if (head.exit) throw new ToolError(1, 'invalid-input', 'Cannot resolve revision HEAD; ' + CODE_TARGETS);
    series = '@' + head.stdout.trim();
  }
  const review = reviewId(kind,artifact,gitTarget?series:undefined);
  const rejectionStates=()=>loadRejections(session,foldLedger(session),[review]);
  const initialRejections=rejectionStates();
  if(initialRejections.some(state=>state.state==='escalated'))throw new ToolError(4,'escalation-open','Resolve the disputed MUST rejection before another confirmation round');
  if (!cap && !initialRejections.some(state=>state.state==='pending')) return {ok: true, exit: 0, value: {skipped: true}, summary: 'review skipped at ' + level};
  const directory = path.join(session, '.state/reviews', review);
  fs.mkdirSync(directory, {recursive: true});

  async function capture(): Promise<Capture> {
    const current = foldLedger(session), bind = latest(current, 'bind');
    const specInput = ctx.values['spec'] ?? bind?.data['spec'];
    if (typeof specInput !== 'string') throw new ToolError(4, 'lint-errors', 'Review needs --spec or a bound spec');
    let specPath = path.resolve(manifest.repositoryRoot, specInput);
    let specText: string;
    try {specPath = fs.realpathSync.native(specPath); specText = fs.readFileSync(specPath, 'utf8');}
    catch {throw new ToolError(1, 'invalid-input', 'Cannot read spec ' + specPath);}
    const spec = {path: specPath, hash: artifactHash('spec', specText)};
    const intent = artifactSections(specText).get('Intent & Problem') || 'Review the selected changes.';
    if (kind !== 'code') {
      const source = fs.readFileSync(artifact, 'utf8');
      return {artifactPath:fs.realpathSync.native(artifact),spec, target: artifactHash(kind, source), source, taskSummary: intent, cwd: manifest.repositoryRoot, changed: []};
    }
    let base: string, head: string, cwd = manifest.repositoryRoot, summary: string;
    const revision = async (ref: string) => {
      const result = await git(deps, cwd, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
      if (result.exit) throw new ToolError(1, 'invalid-input', 'Cannot resolve revision ' + ref + '; ' + CODE_TARGETS);
      return result.stdout.trim();
    };
    if (requested === 'integration') {
      if (!bind?.data['plan']) throw new ToolError(4, 'lint-errors', 'Review of integration needs a bound plan');
      const integration = integrationRecord(current);
      if (!integration || !current.records.some(row=>row.kind==='integrate'&&row.data['phase']==='done')) throw new ToolError(4, 'nothing-to-review', 'No task has been integrated');
      cwd = path.resolve(session, integration.data['path']);
      base = integration.data['base']; head = await gitOk(deps, cwd, ['rev-parse', 'HEAD']);
      const tasks = [...new Set(current.records.filter(row => row.kind === 'integrate' && row.data['phase'] === 'done').map(row => row.data['task']))];
      summary = 'Integrated tasks: ' + tasks.join(', ');
    } else if (taskTarget) {
      if (!bind?.data['plan']) throw new ToolError(4, 'lint-errors', 'Review of a task needs a bound plan');
      const launch = launches(current, requested).findLast(launch => launch.finished);
      if (!launch?.finished) throw new ToolError(1, 'invalid-input', 'No finished launch for ' + requested);
      base = launch.record.data['base'].commit; head = launch.finished.data['candidate'];
      const planText = fs.readFileSync(path.resolve(manifest.repositoryRoot, bind!.data['plan']), 'utf8');
      const plan = parsePlan(planText);
      if (!plan.ok) throw new ToolError(4, 'lint-errors', JSON.stringify(plan.defects));
      const brief = selectTaskBrief(plan.plan, requested);
      if (!brief) throw new ToolError(1, 'invalid-input', 'Unknown task ' + requested);
      summary = taskMarkdown(planText, brief);
    } else {
      if (requested === 'worktree') {
        base = await revision('HEAD');
        const relative = path.relative(fs.realpathSync(cwd), fs.realpathSync(session)).split(path.sep).join('/');
        const inside = relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
        const directory = path.join(session, '.state/tmp');
        fs.mkdirSync(directory, {recursive: true});
        const index = path.join(directory, crypto.randomUUID() + '.index');
        const env = {GIT_INDEX_FILE: index};
        try {
          await gitOk(deps, cwd, ['read-tree', base], env);
          if (!inside || relative) await gitOk(deps, cwd, ['add', '-A', '--', '.'], env);
          // NOTE: an exclude pathspec makes git add exit 1 when it names an ignored path, so reset the session to HEAD after add.
          if (inside && relative) await gitOk(deps, cwd, ['reset', '-q', base, '--', ':(top,literal)' + relative], env);
          const tree = await gitOk(deps, cwd, ['write-tree'], env);
          head = await gitOk(deps, cwd, ['commit-tree', tree, '-p', base, '-m', 'dispatch review snapshot'], {
            GIT_AUTHOR_NAME: 'Dispatch Review', GIT_COMMITTER_NAME: 'Dispatch Review',
            GIT_AUTHOR_EMAIL: 'dispatch-review@localhost', GIT_COMMITTER_EMAIL: 'dispatch-review@localhost',
            GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
          });
        } finally {fs.rmSync(index, {force: true}); fs.rmSync(index + '.lock', {force: true});}
      } else if (requested.includes('..')) {
        if (requested.includes('...')) throw new ToolError(1, 'invalid-input', 'Three-dot revision ranges are not supported; use a..b');
        const parts = requested.split('..');
        if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ToolError(1, 'invalid-input', 'Expected a..b revision range');
        base = await revision(parts[0]); head = await revision(parts[1]);
      } else {
        const ref = await revision(requested); head = await revision('HEAD');
        const result = await git(deps, cwd, ['merge-base', ref, head]);
        if (result.exit) throw new ToolError(1, 'invalid-input', 'Revision ' + requested + ' has no common ancestor with HEAD');
        base = result.stdout.trim();
      }
      summary = 'Changes ' + base.slice(0, 12) + '..' + head.slice(0, 12);
    }
    const changed = splitPaths(await gitOk(deps, manifest.repositoryRoot, ['diff', '--name-only', '-z', base, head]));
    if (!changed.length) throw new ToolError(4, 'nothing-to-review', `No changes between ${base.slice(0, 12)}..${head.slice(0, 12)}`);
    return {...(!gitTarget && bind ? {artifacts:{...currentHashes(manifest.repositoryRoot,bind),spec:spec.hash}} : {}),spec, target: {base, head}, taskSummary: intent + '\n\n' + summary, cwd, changed};
  }

  return withLockFile(path.join(directory, 'claim'), 'review', deps, 0, async () => {
    const numbers = fs.readdirSync(directory).flatMap(name => /^round-(\d+)$/.test(name) ? [Number(name.slice(6))] : []).sort((a, b) => a - b);
    const last = numbers.at(-1) ?? 0;
    const completed = last > 0 && fs.existsSync(path.join(directory, 'round-' + last, 'findings.json'));
    const n = completed ? last + 1 : last || 1;
    if (n > cap) {
      // MUST has no cap (ADR 0005 D4): an accepted MUST fix earns a round; recurrence escalations bound the loop.
      const rulings = foldLedger(session).records.filter(row => row.kind === 'ruling');
      const previousMetadata=read<Round>(path.join(directory,'round-'+(n-1),'round.json'));
      const fixed = numbers.some(number=>read<FindingsValue>(path.join(directory,'round-'+number,'findings.json'))?.findings.some(finding=>{
        const ruling=rulings.findLast(row=>row.data['subject']==='review:'+review+':'+finding.id);
        return finding.severity==='MUST' && ruling?.data['ruling']==='accepted' && (number===n-1 || ruling.seq>(previousMetadata?.startSeq ?? 0));
      }));
      if (!fixed && !rejectionStates().some(state=>state.state==='pending')) throw new ToolError(4, 'round-cap', 'Review reached round cap ' + cap);
    }
    const dir = path.join(directory, 'round-' + n);
    const current = await capture();
    fs.mkdirSync(dir, {recursive: true});
    const roundFile = path.join(dir, 'round.json'), pendingFile = path.join(dir, 'pending.json');
    let round = read<Round>(roundFile);
    if (series && '@' + (current.target as {base: string}).base !== series) throw new ToolError(4, 'target-moved', 'HEAD moved before worktree capture');
    const prior: FindingsValue[] = [], priorTargets: Record<number, ReviewTarget> = {}, confirmationRounds:ConfirmationRound[]=[];
    for (let i = 1; i < n; i++) {
      const value = read<FindingsValue>(path.join(directory, 'round-' + i, 'findings.json'));
      const metadata = read<Round>(path.join(directory, 'round-' + i, 'round.json'));
      if (value && metadata) {prior.push(value); priorTargets[i] = metadata.target;confirmationRounds.push({review,metadata,findings:value});}
    }
    const rulingRows = () => foldLedger(session).records.filter(row => row.kind === 'ruling' && row.data['subject'].startsWith('review:' + review + ':'));
    const rulingSnapshot=()=>{
      const rows=rulingRows();
      return JSON.stringify(prior.flatMap(value=>value.findings.filter(finding=>finding.severity==='MUST').map(finding=>[finding.id,rows.findLast(row=>row.data['subject']==='review:'+review+':'+finding.id)?.seq ?? 0])));
    };
    const settledRulings=rulingRows(),settledRejections=rejectionStates();
    const settled: Settled[] = prior.flatMap(value => value.findings.flatMap(finding => {
      const ruling = settledRulings.findLast(row => row.data['subject'] === 'review:' + review + ':' + finding.id);
      const state=settledRejections.find(state=>state.request.finding===finding.id);
      return ruling ? [{id: finding.id, locus: finding.locus, defect: finding.defect, severity:finding.severity,...(state?{rejectionConfirmed:state.state==='confirmed'}:{}),ruling: ruling.data['ruling'], reason: ruling.data['rationale']}] : [];
    }));

    // Maps are per-session, keyed by the plan or design slug; code reviews never receive one because the pre-change map is stale for code.
    const contextMapFile = kind === 'code' ? undefined : path.join(session, path.basename(artifact).replace(/\.(plan|design)\.md$/, '') + '.context.md');
    async function start(generation: number, captured: Capture): Promise<Round> {
      let scope = 'Full review', changedPaths = captured.changed;
      if (n > 1) {
        const previous = priorTargets[n - 1]!;
        changedPaths = kind === 'code' ? splitPaths(await gitOk(deps, manifest.repositoryRoot, ['diff', '--name-only', '-z', label(previous), label(captured.target)])) : [];
        const changed = kind === 'code' ? 'changed paths: ' + changedPaths.join(', ') : changedHeadings(fs.readFileSync(path.join(directory, 'round-' + (n - 1), 'target.snapshot.md'), 'utf8'), captured.source!).join(', ');
        scope = `Re-review round ${n} (full) — changed: ${changed}; comparison: ${label(previous)}..${label(captured.target)}`;
      } else if (kind === 'code') {
        const target = captured.target as {base: string; head: string};
        scope += ' — changed paths: ' + captured.changed.join(', ') + '; comparison: ' + target.base + '..' + target.head;
      }
      // Narrowing reads the previous round's own findings: a MUST accepted there, or a SHOULD accepted before the cap, keeps the full roster.
      const previous = n > 1 ? confirmationRounds.find(value => value.metadata.round === n - 1) : undefined;
      const previousTarget = previous?.metadata.roster.find(slot => !slot.reserve);
      const rulings = rulingRows();
      const decisive = previous?.findings.findings.some(finding => rulings.findLast(row => row.data['subject'] === 'review:' + review + ':' + finding.id)?.data['ruling'] === 'accepted'
        && (finding.severity === 'MUST' || (finding.severity === 'SHOULD' && n - 1 < cap)));
      const targets = previousTarget && !decisive ? [previousTarget] : roster.targets;
      const turnPaths = kind === 'code' ? changedPaths : kind === 'plan' ? planPaths(captured.source!) : designPaths(captured.source!);
      const requests=rejectionStates().filter(state=>state.state==='pending').map(state=>rejectionRequest({...state.request,target:captured.target,spec:captured.spec}));
      const slots=[...targets,...roster.reserves];
      for(const request of requests)for(const source of request.sourceSlots)if(!slots.some(slot=>slot.slot===source && !slot.reserve)) {
        const saved=confirmationRounds.flatMap(round=>round.metadata.roster).find(slot=>slot.slot===source);
        if(!saved)throw new ToolError(4,'review-confirmation-required','Missing original reviewer slot '+source);
        const existing=slots.findIndex(slot=>slot.slot===source);if(existing>=0)slots.splice(existing,1);
        slots.push({...saved,reserve:false});
      }
      const contextMapPath = contextMapFile && fs.existsSync(contextMapFile) ? contextMapFile : undefined;
      const value: Round = {round: n, generation, cap, level, roster: slots, requests,rulingSnapshot:rulingSnapshot(),scope, startSeq: foldLedger(session).lastSeq, spec: captured.spec, target: captured.target, turnTarget: turnTarget(turnPaths), ...(contextMapPath?{contextMapPath}:{}), ...(captured.artifactPath?{artifactPath:captured.artifactPath}:{}),...(captured.artifacts?{artifacts:captured.artifacts}:{}),...(roster.underfill?{underfill:roster.underfill}:{})};
      fs.mkdirSync(path.join(dir, 'gen-' + generation), {recursive: true});
      if (captured.source !== undefined) fs.writeFileSync(path.join(dir, 'target.snapshot.md'), captured.source);
      atomic(roundFile, value);
      return value;
    }

    async function supersede(captured: Capture) {
      const pending = read<Finalized>(pendingFile);
      if (pending) {
        await withLedger(session, 'review supersede', deps, async tx => {
          for (const escalation of pending.escalations) {
            if(String(escalation.data['id']).startsWith('rejection:'))continue;
            if (!tx.fold.records.some(row => row.key === escalation.key)) continue;
            await tx.append({kind: 'escalation', by: 'tool', key: escalation.key + ':superseded', data: {id: escalation.data['id'], state: 'resolved', summary: 'superseded: target moved'}});
          }
        });
        fs.rmSync(pendingFile, {force: true});
      }
      round = await start(round!.generation + 1, captured);
    }
    const hadPending = fs.existsSync(pendingFile);
    if (!round) round = await start(1, current);
    else if (!same(round, current) || (round.rulingSnapshot!==undefined && round.rulingSnapshot!==rulingSnapshot())) {
      await supersede(current);
      if (hadPending) throw new ToolError(4, 'target-moved', 'Review target moved during finalization');
    }
    let pending = read<Finalized>(pendingFile);
    if (!pending) {
      const bind = latest(foldLedger(session), 'bind');
      const requestsBySlot=new Map<string,RejectionRequest[]>();
      for(const request of round.requests ?? [])for(const slot of request.sourceSlots)requestsBySlot.set(slot,[...(requestsBySlot.get(slot) ?? []),request]);
      const targets = round!.roster.filter(entry => !entry.reserve);
      const prompt = (slot:RosterSlot)=>{
        const position=targets.findIndex(entry=>entry.slot===slot.slot);
        return reviewPrompt(kind, {skillRoot: deps.skillRoot, spec: round!.spec, artifact, scope: round!.scope, taskSummary: current.taskSummary, turnTarget: round!.turnTarget,
          ...(round!.contextMapPath ? {contextMapPath: round!.contextMapPath} : {}),
          ...(bind?.data['plan'] ? {planPath: path.resolve(manifest.repositoryRoot, bind.data['plan'])} : {}), settled,requests:requestsBySlot.get(slot.slot) ?? [], rotation:position<0?0:position});
      };
      const validate = (text: string,logicalSlot:string): Validation => {
        const parsed = parseReport({kind, source: logicalSlot, text,expectedRequestIds:(requestsBySlot.get(logicalSlot) ?? []).map(request=>request.requestId)});
        if (parsed.ok) return {ok: true};
        const cls = parsed.failure.kind === 'uncovered-scope' || parsed.failure.kind === 'loose-locus' ? 'refusal' : parsed.failure.kind;
        return {ok: false, cls, reason: parsed.failure.kind + ': ' + parsed.failure.detail};
      };
      const replies = await fanOut({dir: path.join(dir, 'gen-' + round.generation), slots: round.roster, prompt, validate, cwd: current.cwd}, deps);
      const captured = await capture();
      if (!same(round, captured) || round.rulingSnapshot!==rulingSnapshot()) {await supersede(captured); throw new ToolError(4, 'target-moved', 'Review target or ruling moved during fan-out');}
      const native = replies.filter((reply): reply is Extract<SlotOutcome, {state: 'native'}> => reply.state === 'native');
      if (native.length) return {ok: false, exit: 4, reason: 'native-pending', value: {review, round: n, pending: native, ...(round.underfill ? {underfill: round.underfill} : {})}, summary: 'review ' + review + ': ' + native.length + ' native slots pending' + underfillNote(round)};
      if (!replies.some(reply => reply.state === 'done')) throw new ToolError(2, 'review-failed', 'Every review slot failed' + underfillNote(round));
      const changedSince: Record<number, string[]> = {}, owners: Record<string, string[]> = {};
      if (kind === 'code' && requested === 'integration') {
        for (const [number, target] of Object.entries(priorTargets)) changedSince[Number(number)] = splitPaths(await gitOk(deps, manifest.repositoryRoot, ['diff', '--name-only', '-z', label(target), label(round.target)]));
        const plan = loadPlan(session, manifest);
        for (const task of plan.tasks) owners[task.id] = ownedPaths(plan, task.id);
      }
      pending = finalizeRound({review, round: n, generation: round.generation, cap: round.cap, level: round.level, startSeq: round.startSeq, replies,
        prior, priorTargets, changedSince, owners, escalationRecords:foldLedger(session).records.filter(row=>row.kind==='escalation'),rulings: rulingRows(), kind, artifact, target: round.target,requests:round.requests ?? [],confirmationRounds,spec:round.spec,roster:round.roster});
      if (kind === 'code' && !gitTarget) {
        const plan = loadPlan(session, manifest), currentFold = foldLedger(session);
        const bind = latest(currentFold, 'bind')!;
        const tasks = requested === 'integration' ? [...new Set(currentFold.records.filter(row => row.kind === 'integrate' && row.data['phase'] === 'done').map(row => row.data['task'] as string))] : [requested];
        let redCount = 0;
        for (const task of tasks) {
          const integrated = currentFold.records.findLast(row => row.kind === 'integrate' && row.data['phase'] === 'done' && row.data['task'] === task);
          const launch = launches(currentFold, task).findLast(launch => launch.finished && (requested !== 'integration' || launch.finished.seq < (integrated?.seq ?? 0)));
          const reportFile = path.join(session, '.state/briefs', task + '-' + launch?.launch + '.report.md');
          const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : undefined;
          const taskCriteria = plan.tasks.find(candidate => candidate.id === task)?.criteria;
          const redCriteria = plan.criteria.filter(criterion => taskCriteria?.includes(criterion.id) && criterion.evidence === 'red' && criterion.red && !criterion.redException);
          const redExits = new Map<string, number | null>();
          for (const criterion of redCriteria) {
            let wrapper: {status?: unknown} | null;
            try { wrapper = read(path.join(session, '.state/briefs', task + '-' + launch?.launch + '.red', criterion.id + '.exit')); }
            catch (error) { if (error instanceof SyntaxError) continue; throw error; }
            if (wrapper && (typeof wrapper.status === 'number' || wrapper.status === null)) redExits.set(criterion.id, wrapper.status);
          }
          for (const gap of redGaps({plan, task, changed: captured.changed, report, redExits})) {
            const defect = 'missing-red: ' + task + ' ' + gap.criterion;
            const priorGaps = [...prior].reverse().flatMap(value => value.findings.map(finding => ({round: value.round, finding})))
              .filter(value => value.finding.defect.startsWith(defect + ';'));
            if (priorGaps.some(({finding}) => settledRulings.some(row => row.data['subject'] === 'review:' + review + ':' + finding.id && row.data['ruling'] === 'rejected'))) continue;
            const file = path.resolve(manifest.repositoryRoot, bind.data['plan']);
            const finding: Finding & {unresolved?: {of: string}} = {
              id: 'R' + n + '-RED' + String(++redCount).padStart(2, '0'), severity: 'SHOULD', category: 'testing',
              locus: file + ':L' + gap.line, defect: defect + '; Tests touched: ' + (gap.testsTouched ? 'yes' : 'no'),
              requiredChange: "Show the criterion's test failing before the fix in the writer report", sources: ['tool'], scope: 'in',
            };
            const previous = priorGaps[0];
            if (previous) {
              const previousTarget = priorTargets[previous.round];
              const changed = requested === 'integration'
                ? (changedSince[previous.round] ?? []).some(file => ownedPaths(plan, task).includes(file))
                : typeof previousTarget !== 'string' && previousTarget?.head !== (round.target as {head: string}).head;
              if (changed) {
                const id = 'missing-red:' + review + ':' + task + ':' + gap.criterion + ':R' + n + ':g' + round.generation;
                pending.escalations.push({kind: 'escalation', by: 'tool', key: id, data: {id, state: 'open', summary: finding.defect}});
              } else finding.unresolved = {of: previous.finding.id};
            }
            pending.findings.push(finding);
            const cluster = pending.clusters.find(cluster => cluster.file === file);
            if (cluster) cluster.findings.push(finding.id);
            else pending.clusters.push({file, findings: [finding.id]});
          }
        }
      }
      atomic(pendingFile, pending);
      await deps.hook?.('review:after-pending');
    }
    if(round.rulingSnapshot!==rulingSnapshot()){await supersede(await capture());throw new ToolError(4,'target-moved','Review ruling moved during finalization');}
    await withLedger(session, 'review finalize', deps, async tx => {for (const escalation of pending!.escalations) await tx.append(escalation);});
    await deps.hook?.('review:after-append');
    const finalCapture = await capture();
    if (!same(round, finalCapture) || round.rulingSnapshot!==rulingSnapshot()) {await supersede(finalCapture); throw new ToolError(4, 'target-moved', 'Review target or ruling moved during finalization');}
    fs.renameSync(pendingFile, path.join(dir, 'findings.json'));
    const counts = (severity: string) => pending!.findings.filter(finding => finding.severity === severity).length;
    const recurrences = pending.findings.filter(finding => finding.recurrence).length;
    const file = path.join(dir, 'findings.json');
    let findingsSectionReason: string | undefined;
    const findings = kind === 'plan' || kind === 'design'
      ? refreshFindingsSection(session, manifest, review, reason => { findingsSectionReason = reason; })
      : null;
    return {
      ok: true, exit: 0,
      value: {
        path: file, review, round: n,
        ...(findings ? { findingsSection: findings, ...(findingsSectionReason ? { findingsSectionReason } : {}) } : {}),
        ...(round.underfill ? { underfill: round.underfill } : {}),
      },
      summary: summaryWithItems(`review ${review} round ${n}/${round.cap}: ${counts('MUST')} MUST, ${counts('SHOULD')} SHOULD, ${counts('CONSIDER')} CONSIDER, ${recurrences} recurrences, ${pending.failed.length} failed slots${underfillNote(round)}`,
        ['MUST', 'SHOULD', 'CONSIDER'].flatMap(severity => pending!.findings.filter(finding => finding.severity === severity)
          .map(finding => `${finding.id} ${finding.severity}: ${finding.defect}`))),
    };
  });
}
