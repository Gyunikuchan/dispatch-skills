import type { Manifest } from '../lib/session.ts';
import { strictEvidence } from './evidence.ts';
import { candidate } from './writers.ts';
import { integrationRecord, pendingIntegration } from './integration-state.ts';
import { confirmGate, gate, latest, levelGate } from './ledger.ts';
import type { Fold, Hashes } from './ledger.ts';
import { clipBytes } from './output.ts';
import { checks, loadPlan, taskCriteria, taskSection } from './plan-view.ts';
import { isStale } from './writers.ts';
import { isRecord } from '../lib/config.ts';
import { present } from './narrow.ts';

export const HINT_MAX_BYTES = 240;

export type StepHintInput = {
  fold: Fold;
  current: Hashes;
  action: string;
  result: { ok: boolean; reason?: string | undefined; value: unknown };
  session?: string;
  manifest?: Manifest;
};

const EXCLUDED_ACTIONS = new Set(['ask run', 'diagnostics render', 'worktree cleanup', 'review run']);

export function isHintExcludedAction(action: string): boolean {
  return EXCLUDED_ACTIONS.has(action);
}

function formatHint(text: string): string {
  return clipBytes(text.replaceAll(/[\r\n]+/g, ' '), HINT_MAX_BYTES);
}

function verifiedLiveTree(value: unknown): string | undefined {
  const checked: unknown = isRecord(value) ? value['checks'] : undefined;
  if (!Array.isArray(checked) || checked.length === 0) {
    return undefined;
  }
  const rows: ReadonlyArray<unknown> = checked;
  const [head] = rows;
  const first = isRecord(head) ? head['tree'] : undefined;
  return typeof first === 'string' &&
    first &&
    rows.every(
      (row) =>
        isRecord(row) &&
        row['clean'] === true &&
        row['before'] === row['after'] &&
        row['exit'] === 0 &&
        row['tree'] === first,
    )
    ? first
    : undefined;
}

function hasOpenEscalation(fold: Fold): boolean {
  const states = new Map<string, unknown>();
  for (const record of fold.records) {
    if (record.kind === 'escalation') {
      states.set(String(record.data['id']), record.data['state']);
    }
  }
  for (const state of states.values()) {
    if (state === 'open') {
      return true;
    }
  }
  return false;
}

const renderReview = (targetArg: string) =>
  `Run review — help review run — review run ${targetArg} --session <session> --host <platform> [--pins <pins>]`;

/** Derives a bounded one-line advisory next-step hint from the post-write fold and current hashes. */
export function stepHint({ fold, current, action, result, session, manifest }: StepHintInput): string | undefined {
  // Row 1: failed calls and native-pending pauses omit hints.
  if (!result.ok || result.reason === 'native-pending') {
    return undefined;
  }
  // Row 2: standalone, terminal, and review-adjudication actions omit hints.
  if (isHintExcludedAction(action)) {
    return undefined;
  }
  // Row 3: open escalations block downstream guidance until resolved.
  if (hasOpenEscalation(fold)) {
    return undefined;
  }
  // Row 4: unapproved extreme run level requires user selection.
  if (!levelGate(fold).allowed) {
    return undefined;
  }
  // Row 5: bind precedes review and implementation hints.
  const bind = latest(fold, 'bind');
  if (!bind) {
    return undefined;
  }
  // Row 6: intent confirmation gate precedes review and implementation hints.
  if (!confirmGate(fold, current.spec).allowed) {
    return undefined;
  }

  // Row 7: freshly appended non-deduped plan/design bind after level selection, with no subsequent approval or ruling.
  const last = fold.records.at(-1);
  const deduped = isRecord(result.value) && result.value['deduped'] === true;
  const boundTarget: unknown = last?.kind === 'bind' ? last.data?.['plan'] || last.data?.['design'] : undefined;
  if (
    action === 'ledger append' &&
    !deduped &&
    latest(fold, 'level') &&
    last?.kind === 'bind' &&
    typeof boundTarget === 'string' &&
    boundTarget.length > 0 &&
    !fold.records.some((record) => (record.kind === 'approval' || record.kind === 'ruling') && record.seq > last.seq)
  ) {
    const candidateHint = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(boundTarget) ? renderReview(boundTarget) : undefined;
    return candidateHint && Buffer.byteLength(candidateHint, 'utf8') <= HINT_MAX_BYTES
      ? candidateHint
      : formatHint(renderReview('<artifact>'));
  }

  // Row 8: full gate (approval + non-intent edit chain).
  if (!gate(fold, current).allowed) {
    return undefined;
  }
  // Row 9: bound plan and opened integration worktree precede implementation hints.
  const integration = integrationRecord(fold);
  if (!bind?.data?.['plan'] || !integration) {
    return undefined;
  }
  // Row 10: closed integration emits no hint.
  const integratePhase: unknown = latest(fold, 'integrate')?.data?.['phase'];
  if (integratePhase === 'closed') {
    return undefined;
  }
  // Row 11: pending integration conflict or in-progress pick requires orchestrator decision.
  if (pendingIntegration(fold)) {
    return undefined;
  }

  // Row 12: uncommitted delivery points to walkthrough completion (committed does not repeat it).
  if (action === 'worktree deliver' && integratePhase === 'delivered') {
    return formatHint('Complete walkthrough report — help report complete — report complete --session <session>');
  }
  // Row 13: report complete after delivery or commit points to worktree cleanup.
  if (action === 'report complete' && (integratePhase === 'delivered' || integratePhase === 'committed')) {
    return formatHint('Clean up worktrees — help worktree cleanup — worktree cleanup --session <session>');
  }

  // Row 14: non-stale finished candidate ready after the last integrated task's automated criteria have passing clean check evidence on the verified check run tree after its done record and any fix or test-cleanup.
  const tasks = [
    ...new Set(fold.records.filter((record) => record.kind === 'writer').map((record) => String(record.data['task']))),
  ];
  const candidates = tasks.flatMap((task) => {
    const launch = candidate(fold, task);
    return launch ? [{ task, launch }] : [];
  });
  if (candidates.length > 0) {
    if (!session || !manifest) {
      return undefined;
    }
    try {
      const plan = loadPlan(session, manifest);
      const lastDone = fold.records.findLast(
        (record) => record.kind === 'integrate' && record.seq > integration.seq && record.data['phase'] === 'done',
      );
      if (lastDone) {
        const taskCritIds = new Set(taskCriteria(plan, String(lastDone.data['task'] ?? '')));
        const autoChecks = checks(plan).filter(
          (check) => taskCritIds.has(check.criterion) && check.evidenceClass !== 'review',
        );
        if (autoChecks.length > 0) {
          if (action !== 'check run') {
            return undefined;
          }
          const liveTree = verifiedLiveTree(result.value);
          if (!liveTree) {
            return undefined;
          }
          const lastFix = fold.records.findLast(
            (record) =>
              record.kind === 'integrate' &&
              record.seq > lastDone.seq &&
              (record.data['phase'] === 'fix' || record.data['phase'] === 'test-cleanup'),
          );
          const minSeq = lastFix?.seq ?? lastDone.seq;
          const evs = autoChecks.map((check) => strictEvidence(fold, check));
          if (evs.some((ev) => !ev || ev.seq <= minSeq || ev.data['tree'] !== liveTree)) {
            return undefined;
          }
        }
      }
      const hasPlanOrTaskEdit = (baseSeq: number, task: string) =>
        fold.records.some(
          (record) =>
            record.kind === 'edit' &&
            record.seq > baseSeq &&
            (record.data['artifact'] === 'plan' ||
              (Array.isArray(record.data['affects']) && record.data['affects'].includes(task))),
        );
      const nonStale = candidates
        .filter(({ task, launch }) => {
          if (isStale(fold, launch.record, taskSection(plan, task))) {
            return false;
          }
          const base: unknown = launch.record.data['base'];
          return !hasPlanOrTaskEdit(Number(isRecord(base) ? base['seq'] : undefined), task);
        })
        .sort(
          (left, right) =>
            present(left.launch.finished, 'finished record').seq -
              present(right.launch.finished, 'finished record').seq || left.task.localeCompare(right.task),
        );
      const [first] = nonStale;
      if (first) {
        const chosen = first.task;
        return formatHint(
          `Integrate ${chosen} — help worktree integrate — worktree integrate ${chosen} --session <session>`,
        );
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  // Row 15: default omit for all remaining states.
  return undefined;
}
