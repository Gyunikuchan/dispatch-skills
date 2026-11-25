import type { HandlerContext, HandlerResult } from './cli.ts';
import { withPostFold, gate, currentHashes, latest, type Fold, type LedgerTransaction } from './ledger.ts';
import { validateReviewFix, type ReviewFix } from './records.ts';
import { git, gitOk, gitPaths, changedPaths } from './git.ts';
import { ensureIntegration } from './integration.ts';
import { pendingIntegration } from './integration-state.ts';
import { candidate, isStale, abandonedRef } from './writers.ts';
import { checks, loadPlan, taskSection } from './plan-view.ts';
import { cleanupEvidence, matchesDeclared, strictEvidence } from './evidence.ts';
import { result, refuse, ToolError } from './output.ts';
import { stableValue } from './domain/stable-value.ts';
import { readJsonPayload, readRequiredReason } from './input.ts';

import { dataTrailers, reviewFixFromCommit, reviewFixTrailers } from './review-fix.ts';

function readReviewFix(ctx: HandlerContext): ReviewFix | undefined {
  const parsed = readJsonPayload(ctx, {
    fileFlag: 'review-fix',
    inlineFlag: 'review-fix-json',
    optional: true,
    label: 'review-fix',
  });
  if (parsed === undefined) return undefined;
  return validateReviewFix(parsed);
}
type TestCleanup = { removed: string[]; deleted: number; merged: number };
const TRAILER = 'Dispatch-Test-Cleanup-Data: ';
function readTestCleanup(ctx: HandlerContext): TestCleanup | undefined {
  const value = readJsonPayload(ctx, {
    fileFlag: 'test-cleanup',
    inlineFlag: 'test-cleanup-json',
    optional: true,
    label: 'test-cleanup',
  });
  if (value === undefined) return undefined;
  const invalid = () =>
    new ToolError(
      1,
      'invalid-input',
      'input requires a readable test-cleanup JSON object: {"removed": ["SC<n>"], "deleted": <count>, "merged": <count>}',
    );
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  const record = value as Record<string, unknown>;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(record).sort().join() !== 'deleted,merged,removed' ||
    !Array.isArray(record['removed']) ||
    record['removed'].some((id: unknown) => typeof id !== 'string' || !id.trim()) ||
    new Set(record['removed']).size !== record['removed'].length ||
    !count(record['deleted']) ||
    !count(record['merged'])
  )
    throw invalid();
  if (!record['removed'].length && !record['deleted'] && !record['merged']) refuse('test-cleanup-empty');
  return {
    removed: record['removed'] as string[],
    deleted: record['deleted'] as number,
    merged: record['merged'] as number,
  };
}
function task(ctx: HandlerContext): string {
  if (ctx.args.length !== 1) throw new ToolError(1, 'invalid-input', 'One task ID is required');
  taskSection(loadPlan(ctx.session, ctx.manifest), ctx.args[0]!);
  return ctx.args[0]!;
}
function checkGate(ctx: HandlerContext, fold: Fold) {
  const checked = gate(fold, currentHashes(ctx.manifest.repositoryRoot, latest(fold, 'bind')));
  if (!checked.allowed) refuse(checked.reason!, JSON.stringify(checked));
}
async function cherryHead(ctx: HandlerContext, cwd: string): Promise<string | undefined> {
  const picked = await git(ctx.deps, cwd, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD']);
  return picked.exit === 0 ? picked.stdout.trim() : undefined;
}
async function pickedCommit(ctx: HandlerContext, cwd: string, hash: string): Promise<string | undefined> {
  const head = await gitOk(ctx.deps, cwd, ['rev-parse', 'HEAD']);
  const message = await gitOk(ctx.deps, cwd, ['log', '-1', '--format=%B']);
  if (message.includes('(cherry picked from commit ' + hash + ')')) return head;
  const patchId = async (commit: string) => {
    const patch = await gitOk(ctx.deps, cwd, ['show', '--format=', '--no-ext-diff', commit]);
    const value = await ctx.deps.run(['git', 'patch-id', '--stable'], { cwd, stdin: patch + '\n' });
    if (value.exit) throw new ToolError(2, 'fault', value.stderr);
    return value.stdout.split(/\s/)[0];
  };
  const expected = await patchId(hash);
  return expected && expected === (await patchId(head)) ? head : undefined;
}
async function done(tx: LedgerTransaction, id: string, commit: string) {
  await tx.append({ kind: 'integrate', by: 'tool', data: { phase: 'done', task: id, commit } });
  return result({ task: id, commit });
}
async function conflicts(ctx: HandlerContext, tx: LedgerTransaction, cwd: string, id: string): Promise<HandlerResult> {
  const paths = await gitPaths(ctx.deps, cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
  await tx.append({ kind: 'integrate', by: 'tool', data: { phase: 'conflict', task: id, paths } });
  return {
    ok: false,
    exit: 0,
    reason: 'conflict',
    summary: JSON.stringify({ task: id, paths }),
    value: { task: id, paths, reason: 'conflict' },
  };
}
export async function integrate(ctx: HandlerContext): Promise<HandlerResult> {
  const id = task(ctx);
  return withPostFold(ctx.session, 'worktree integrate', ctx.deps, async (tx) => {
    checkGate(ctx, tx.fold);
    const active = pendingIntegration(tx.fold);
    if (active && active.data['task'] !== id) refuse('integration-pending', active.data['task']);
    const launch = candidate(tx.fold, id);
    if (!launch) refuse('no-candidate');
    const hash = launch.finished!.data['candidate'] as string;
    const integration = await ensureIntegration(tx, ctx),
      cwd = integration.path;
    const cherry = await cherryHead(ctx, cwd);
    if (active && cherry === hash) return conflicts(ctx, tx, cwd, id);
    if (cherry) refuse('integration-dirty');
    if (active) {
      const commit = await pickedCommit(ctx, cwd, hash);
      if (commit) return done(tx, id, commit);
    }
    if ((await changedPaths(ctx.deps, cwd, 'HEAD')).length) refuse('integration-dirty');
    if (isStale(tx.fold, launch.record, taskSection(loadPlan(ctx.session, ctx.manifest), id))) {
      const ack = ctx.values['ack-stale'];
      if (typeof ack !== 'string' || !ack.trim()) refuse('stale-candidate');
      await tx.append({
        kind: 'ruling',
        by: 'orchestrator',
        key: 'ack-stale:' + hash,
        data: { subject: 'stale-candidate ' + id + ' ' + hash, ruling: 'accept', rationale: ack },
      });
    }
    if (!active)
      await tx.append({
        kind: 'integrate',
        by: 'tool',
        key: 'integrate-started:' + id + ':' + launch.launch + ':' + hash,
        data: { phase: 'started', task: id, candidate: hash },
      });
    const picked = await git(ctx.deps, cwd, ['cherry-pick', '-x', hash]);
    if (picked.exit) {
      const paths = await gitOk(ctx.deps, cwd, ['diff', '--name-only', '--diff-filter=U']);
      if (paths) return conflicts(ctx, tx, cwd, id);
      throw new ToolError(2, 'fault', picked.stderr || picked.stdout);
    }
    await ctx.deps.hook?.('integrate:after-pick');
    return done(tx, id, await gitOk(ctx.deps, cwd, ['rev-parse', 'HEAD']));
  });
}
export async function continueIntegration(ctx: HandlerContext): Promise<HandlerResult> {
  const id = task(ctx);
  return withPostFold(ctx.session, 'worktree continue', ctx.deps, async (tx) => {
    checkGate(ctx, tx.fold);
    const active = pendingIntegration(tx.fold);
    const integration = await ensureIntegration(tx, ctx),
      cwd = integration.path;
    const cherry = await cherryHead(ctx, cwd);
    if (cherry && active?.data['task'] !== id) refuse('wrong-task');
    if (!active || active.data['task'] !== id) refuse('no-pending-integration');
    const hash = active.data['candidate'] as string;
    if (cherry) {
      if (cherry !== hash) refuse('wrong-task');
      if (await gitOk(ctx.deps, cwd, ['diff', '--name-only', '--diff-filter=U'])) refuse('unresolved-conflict');
      await gitOk(ctx.deps, cwd, ['add', '-A']);
      await gitOk(ctx.deps, cwd, ['-c', 'core.editor=true', 'cherry-pick', '--continue'], { GIT_EDITOR: 'true' });
      await ctx.deps.hook?.('continue:after-commit');
      return done(tx, id, await gitOk(ctx.deps, cwd, ['rev-parse', 'HEAD']));
    }
    const commit = await pickedCommit(ctx, cwd, hash);
    if (commit) return done(tx, id, commit);
    return refuse('no-pending-integration');
  });
}
export async function commit(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length) throw new ToolError(1, 'invalid-input', 'commit takes no task');
  const why = readRequiredReason(ctx);
  const hasReviewFix = ctx.values['review-fix'] !== undefined || ctx.values['review-fix-json'] !== undefined;
  const hasTestCleanup = ctx.values['test-cleanup'] !== undefined || ctx.values['test-cleanup-json'] !== undefined;
  if (hasReviewFix && hasTestCleanup)
    throw new ToolError(1, 'invalid-input', '--test-cleanup and --review-fix are mutually exclusive');
  let reviewFix = readReviewFix(ctx);
  const cleanup = readTestCleanup(ctx);
  return withPostFold(ctx.session, 'worktree commit', ctx.deps, async (tx) => {
    const active = pendingIntegration(tx.fold);
    if (active) refuse('integration-pending', active.data['task']);
    const integration = await ensureIntegration(tx, ctx),
      cwd = integration.path;
    let hash = await gitOk(ctx.deps, cwd, ['rev-parse', 'HEAD']);
    const dirty = (await changedPaths(ctx.deps, cwd, 'HEAD')).length > 0;
    const message = dirty ? '' : await gitOk(ctx.deps, cwd, ['log', '-1', '--format=%B']);
    const lines = message.split('\n');
    const cleanupTrailers = lines.filter((line) => line.startsWith(TRAILER));
    if (cleanup) {
      // SECTION: test cleanup commit; a clean tree recovers an interrupted commit from its trailer
      if (tx.fold.records.some((r) => r.kind === 'integrate' && r.data['phase'] === 'test-cleanup'))
        refuse('test-cleanup-recorded');
      const header =
        'fix(dispatch): ' +
        why
          .replace(/\s+/g, ' ')
          .slice(0, 85)
          .replace(/[\uD800-\uDBFF]$/u, '')
          .trimEnd();
      const canonical = stableValue(cleanup);
      if (!dirty) {
        const encoded = cleanupTrailers.map((line) => line.slice(TRAILER.length)).join('');
        if (
          lines[0] !== header ||
          !lines.includes('Dispatch-Fix: ' + ctx.manifest.safeSessionId) ||
          !/^[A-Za-z0-9_-]+$/.test(encoded) ||
          Buffer.from(encoded, 'base64url').toString('utf8') !== canonical
        )
          refuse('no-changes');
      }
      const from = dirty ? hash : await gitOk(ctx.deps, cwd, ['rev-parse', 'HEAD^']);
      const fromTree = await gitOk(ctx.deps, cwd, ['rev-parse', from + '^{tree}']);
      const plan = loadPlan(ctx.session, ctx.manifest);
      const planChecks = checks(plan);
      const checkById = new Map(planChecks.map((c) => [c.criterion, c]));
      const diffs = new Map<string, string[]>();
      for (const id of cleanup.removed) {
        if (!plan.criteria.some((c) => c.id === id)) continue;
        const check = checkById.get(id);
        if (!check) continue;
        const row = strictEvidence(tx.fold, check);
        if (!row) continue;
        const tree = String(row.data['tree']);
        if (tree === fromTree || diffs.has(tree)) continue;
        diffs.set(
          tree,
          await gitPaths(ctx.deps, cwd, ['diff', '--name-only', '--no-renames', '-z', tree, fromTree, '--']),
        );
      }
      const evidence = cleanupEvidence(tx.fold, planChecks, plan.criteria, cleanup.removed, fromTree, diffs);
      if (!evidence.ok)
        refuse(
          'test-cleanup-evidence-required',
          'Stale or missing evidence on pre-cleanup tree for: ' + evidence.stale.join(', '),
        );
      const changed = await gitPaths(
        ctx.deps,
        cwd,
        dirty
          ? ['diff', '-z', '--name-only', '--no-renames', 'HEAD', '--']
          : ['diff', '-z', '--name-only', '--no-renames', from, 'HEAD', '--'],
      );
      const untouched = cleanup.removed.filter(
        (id) => !changed.some((file) => matchesDeclared(file, plan.criteria.find((c) => c.id === id)!.tests)),
      );
      if (untouched.length)
        refuse('test-cleanup-paths-unchanged', 'No declared Tests path changed for ' + untouched.join(', '));
      if (dirty) {
        const trailer = dataTrailers(TRAILER, Buffer.from(canonical).toString('base64url')).join('\n');
        await gitOk(ctx.deps, cwd, ['add', '-A']);
        await gitOk(ctx.deps, cwd, [
          'commit',
          '-m',
          header,
          '-m',
          'Dispatch-Fix: ' + ctx.manifest.safeSessionId,
          '-m',
          trailer,
        ]);
        await ctx.deps.hook?.('commit:after-commit');
        hash = await gitOk(ctx.deps, cwd, ['rev-parse', 'HEAD']);
      }
      await tx.append({
        kind: 'integrate',
        by: 'tool',
        data: { phase: 'test-cleanup', from, fromTree, to: hash, ...cleanup, trees: evidence.trees },
      });
      return result({ commit: hash, reason: why, from, ...cleanup, trees: evidence.trees });
    }
    if (dirty) {
      const identity = reviewFix ? ['-m', reviewFixTrailers(reviewFix)] : [];
      await gitOk(ctx.deps, cwd, ['add', '-A']);
      await gitOk(ctx.deps, cwd, [
        'commit',
        '-m',
        'fix(dispatch): ' + why,
        '-m',
        'Dispatch-Fix: ' + ctx.manifest.safeSessionId,
        ...identity,
      ]);
      await ctx.deps.hook?.('commit:after-commit');
      hash = await gitOk(ctx.deps, cwd, ['rev-parse', 'HEAD']);
    } else {
      if (
        cleanupTrailers.length ||
        tx.fold.records.some(
          (r) => r.kind === 'integrate' && r.data['phase'] === 'test-cleanup' && r.data['to'] === hash,
        )
      )
        refuse('no-changes');
      if (
        lines[0] !== 'fix(dispatch): ' + why ||
        !lines.includes('Dispatch-Fix: ' + ctx.manifest.safeSessionId) ||
        tx.fold.records.some((r) => r.kind === 'integrate' && r.data['phase'] === 'fix' && r.data['commit'] === hash)
      )
        refuse('no-changes');
      const recorded = reviewFixFromCommit(message);
      if (recorded && reviewFix && stableValue(recorded) !== stableValue(reviewFix)) refuse('no-changes');
      if (recorded) reviewFix = recorded;
      else if (reviewFix) refuse('no-changes');
    }
    await tx.append({
      kind: 'integrate',
      by: 'tool',
      data: { phase: 'fix', commit: hash, reason: why, ...(reviewFix ? { reviewFix } : {}) },
    });
    return result({ commit: hash, reason: why });
  });
}
export async function abort(ctx: HandlerContext): Promise<HandlerResult> {
  const id = task(ctx),
    why = readRequiredReason(ctx);
  return withPostFold(ctx.session, 'worktree abort', ctx.deps, async (tx) => {
    const active = pendingIntegration(tx.fold),
      launch = candidate(tx.fold, id);
    const integration = await ensureIntegration(tx, ctx),
      cwd = integration.path;
    const cherry = await cherryHead(ctx, cwd);
    if (cherry && active?.data['task'] !== id) refuse('wrong-task');
    if (!launch) refuse('no-candidate');
    const hash = launch.finished!.data['candidate'] as string;
    if (cherry && cherry !== hash) refuse('wrong-task');
    if (!cherry && active?.data['task'] === id) {
      const picked = await pickedCommit(ctx, cwd, hash);
      if (picked) {
        await done(tx, id, picked);
        refuse('already-integrated');
      }
    }
    if (cherry) await gitOk(ctx.deps, cwd, ['cherry-pick', '--abort']);
    await gitOk(ctx.deps, cwd, ['update-ref', abandonedRef(ctx.manifest.safeSessionId, id, launch.launch), hash]);
    await tx.append({
      kind: 'integrate',
      by: 'tool',
      key: 'integrate-abandoned:' + id + ':' + launch.launch + ':' + hash,
      data: { phase: 'abandoned', task: id, candidate: hash, reason: why },
    });
    return result({ task: id, candidate: hash, abandoned: true });
  });
}
