// @ts-check

import type { CriterionEvidence, DecisionAnswer, DesignApproval, Level, LevelClassificationAnswer, LevelRecommendationAnswer, LevelGateScope, LevelDesignScope, PlanAmendment, ScopeAdjustment, TreeFingerprint, VerifyCommand, WriteEnvelope, RecoveryRef } from '../core/types.ts';
import type { ParsedPlan, PlanChange, PlanCriterion, PlanCommand, PlanTask } from '../domain/types.ts';
import { selectLevel } from '../policy/roster.ts';
import { isRecord, type WriterConfig } from './types.ts';

export type { WriterConfig };

export type EvidenceClass = 'red' | 'verify' | 'review';
export type ImplementStage = 'task';
export type DesignBinding = {
  path: string; revision: string; revisionIndex?: number; increment: string; contract: Readonly<Record<string, string>>; paths: readonly string[];
  approval: DesignApproval; repair: readonly string[];
  remainingIncrements?: readonly { id: string; priority: number; outcome: string; dependencies: readonly string[]; paths: readonly string[]; acceptance: readonly string[] }[];
  governingDesign?: LevelDesignScope;
  levelGatePassed?: boolean; gateScope?: LevelGateScope | null; levelAssessment?: LevelClassificationAnswer | null;
  levelChoice?: LevelRecommendationAnswer | null; scopeAdjustments?: readonly ScopeAdjustment[];
  scopeNotice?: { requestId: string; approvedBy: 'orchestrator' | 'user'; rationale: string; quote?: string } | null;
};
export type ImplementOutcome = 'complete' | 'failed' | 'stopped';
export type VerificationStatus = 'pass' | 'known-red — unchanged' | 'regression' | 'red' | 'quality-error';

export type Criterion = PlanCriterion & { evidence: EvidenceClass };
export type CommandMapping = { command: string; criteria: readonly string[]; paths: readonly string[]; final: boolean };
export type VerifyRecord = {
  command: string;
  exit: number;
  logPath: string;
  failureId: string | null;
  failedTests: readonly string[];
  diagnostic: string;
  loadError: boolean;
  inputFingerprint: string;
  mutationEpoch: number;
  status: VerificationStatus;
};
export type EvidenceRecord = CriterionEvidence & { id: string; planHash: string; mutationEpoch: number; source: string };
export type RedMatrixRow = { id: string; path: string; leaf: string; exit: number; tests: readonly string[] };
export type WriterEnvelope = WriteEnvelope & {
  schemaVersion: 1;
  status: 'DONE' | 'DONE_WITH_CONCERNS' | 'NEEDS_CONTEXT' | 'BLOCKED';
  stage: 'RED_READY' | 'COMPLETE';
  summary: string;
  evidence: readonly string[];
  concerns?: readonly string[];
  missingContext?: readonly string[];
  blockers?: readonly string[];
  files?: readonly { path: string; note: string }[];
  amendment?: PlanAmendment;
};
export type SettledPlanInput = { path: string; hash: string; outcome: 'settled' | 'skipped' };
export type FailureAnswer = { action: 'stop' } | { action: 'retry'; rootCause: string } | { action: 'hotfix'; mode: 'inline' | 'writer'; rootCause: string; external: readonly { path: string; reason: string }[] }
  | { action: 'manual-complete'; by: 'user'; quote: string; criteria: Readonly<Record<string, CriterionEvidence>> };
export function failureAnswer(value: unknown): FailureAnswer | null {
  if (value === 'stop') return { action: 'stop' };
  if (!isRecord(value)) return null;
  if (value['action'] === 'stop') return { action: 'stop' };
  if (value['action'] === 'retry' && NON_EMPTY(value['rootCause'])) return { action: 'retry', rootCause: value['rootCause'] };
  if (value['action'] === 'hotfix' && NON_EMPTY(value['rootCause'])) {
    const hotfix = isRecord(value['hotfix']) ? value['hotfix'] : value;
    const mode = hotfix['mode'] ?? 'writer';
    if (mode !== 'inline' && mode !== 'writer') return null;
    const external = hotfix['external'] ?? value['external'] ?? [];
    if (!Array.isArray(external) || !external.every((v) => isRecord(v) && NON_EMPTY(v['path']) && NON_EMPTY(v['reason']))) return null;
    return { action: 'hotfix', mode, rootCause: value['rootCause'], external: external as { path: string; reason: string }[] };
  }
  if ((value['action'] === 'manual-complete' || value['action'] === 'manual-completion') && value['by'] === 'user' && NON_EMPTY(value['quote']) && isRecord(value['criteria'])) return { action: 'manual-complete', by: 'user', quote: value['quote'], criteria: value['criteria'] as Record<string, CriterionEvidence> };
  return null;
}
const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)s?\.[^/]+$/i;
const NON_EMPTY = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function isTestPath(value: string): boolean { return TEST_PATH.test(value); }

/** Boundary guard for the domain parser's payload, which crosses the event journal as a generic payload. */
export function asParsedPlan(value: unknown): ParsedPlan | null {
  if (!isRecord(value) || !Array.isArray(value['criteria']) || !Array.isArray(value['changes']) || !isRecord(value['verification'])) return null;
  if (!Array.isArray(value['verification']['automated']) || !Array.isArray(value['finalCommands'])) return null;
  const criteria: PlanCriterion[] = [];
  for (const [index, item] of value['criteria'].entries()) {
    if (!isRecord(item) || !NON_EMPTY(item['id']) || !Array.isArray(item['changes']) || !item['changes'].every(NON_EMPTY)
      || !Array.isArray(item['verify']) || !['red', 'verify', 'review'].includes(String(item['evidence']))) return null;
    const verify: PlanCommand[] = [];
    for (const command of item['verify']) {
      if (!isRecord(command) || !NON_EMPTY(command['command']) || typeof command['final'] !== 'boolean') return null;
      verify.push({ command: command['command'], final: command['final'] });
    }
    criteria.push({
      id: item['id'], title: typeof item['title'] === 'string' ? item['title'] : item['id'], line: typeof item['line'] === 'number' ? item['line'] : index + 1,
      changes: item['changes'] as string[], verify, evidence: item['evidence'] as PlanCriterion['evidence'],
      preExisting: typeof item['preExisting'] === 'boolean' ? item['preExisting'] : null,
      redException: typeof item['redException'] === 'string' ? item['redException'] : null,
      testRationale: typeof item['testRationale'] === 'string' ? item['testRationale'] : null,
      review: typeof item['review'] === 'string' ? item['review'] : null,
      enforcementInfeasibility: typeof item['enforcementInfeasibility'] === 'string' ? item['enforcementInfeasibility'] : null,
    });
  }
  const changes: PlanChange[] = [];
  for (const [index, item] of value['changes'].entries()) {
    if (!isRecord(item) || !['NEW', 'MODIFY', 'DELETE', 'GENERATED'].includes(String(item['action'])) || !NON_EMPTY(item['path'])) return null;
    changes.push({ action: item['action'] as PlanChange['action'], path: item['path'], note: typeof item['note'] === 'string' ? item['note'] : '', command: typeof item['command'] === 'string' ? item['command'] : null, line: typeof item['line'] === 'number' ? item['line'] : index + 1 });
  }
  if (!value['verification']['automated'].every(NON_EMPTY) || !value['finalCommands'].every(NON_EMPTY)) return null;
  // NOTE: pre-task journals lack `tasks`; rejecting them forces an explicit restart instead of a silent migration.
  if (!Array.isArray(value['tasks'])) return null;
  const strings = (raw: unknown): string[] | null => Array.isArray(raw) && raw.every(NON_EMPTY) ? raw : null;
  const tasks: PlanTask[] = [];
  for (const item of value['tasks']) {
    if (!isRecord(item) || !NON_EMPTY(item['id']) || !Array.isArray(item['generated'])) return null;
    const prerequisites = strings(item['prerequisites']), taskCriteria = strings(item['criteria']), paths = strings(item['paths']);
    if (!prerequisites || !taskCriteria || !paths) return null;
    const generated: { path: string; inputs: string[] }[] = [];
    for (const entry of item['generated']) {
      const inputs = isRecord(entry) ? strings(entry['inputs']) : null;
      if (!isRecord(entry) || !NON_EMPTY(entry['path']) || !inputs) return null;
      generated.push({ path: entry['path'], inputs });
    }
    tasks.push({
      id: item['id'], title: typeof item['title'] === 'string' ? item['title'] : item['id'], summary: typeof item['summary'] === 'string' ? item['summary'] : '',
      line: typeof item['line'] === 'number' ? item['line'] : tasks.length + 1, prerequisites, criteria: taskCriteria, paths, generated,
    });
  }
  return {
    title: typeof value['title'] === 'string' ? value['title'] : null,
    box: isRecord(value['box']) ? Object.fromEntries(Object.entries(value['box']).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
    keyDecisions: Array.isArray(value['keyDecisions']) ? value['keyDecisions'].filter((item): item is string => typeof item === 'string') : [],
    criteria, tasks, changes,
    verification: {
      automated: value['verification']['automated'] as string[],
      none: typeof value['verification']['none'] === 'string' ? value['verification']['none'] : null,
      manual: Array.isArray(value['verification']['manual']) ? value['verification']['manual'].filter((item): item is string => typeof item === 'string') : [],
    },
    finalCommands: value['finalCommands'] as string[],
    traceability: isRecord(value['traceability']) ? Object.fromEntries(Object.entries(value['traceability']).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : null,
    governedText: typeof value['governedText'] === 'string' ? value['governedText'] : '',
  };
}

export function approvedPaths(plan: ParsedPlan): string[] { return [...new Set(plan.changes.map((change) => change.path))].sort(); }

export function commandMappings(plan: ParsedPlan): CommandMapping[] {
  const byCommand = new Map<string, { criteria: Set<string>; paths: Set<string>; final: boolean }>();
  for (const criterion of plan.criteria) for (const entry of criterion.verify) {
    const record = byCommand.get(entry.command) ?? { criteria: new Set<string>(), paths: new Set<string>(), final: true };
    record.criteria.add(criterion.id);
    criterion.changes.forEach((file) => record.paths.add(file));
    record.final &&= entry.final;
    byCommand.set(entry.command, record);
  }
  for (const command of plan.verification.automated) {
    const record = byCommand.get(command) ?? { criteria: new Set<string>(), paths: new Set<string>(), final: false };
    for (const criterion of plan.criteria) if (criterion.verify.some((entry) => entry.command === command)) {
      record.criteria.add(criterion.id);
      criterion.changes.forEach((file) => record.paths.add(file));
    }
    byCommand.set(command, record);
  }
  for (const command of plan.finalCommands) {
    const record = byCommand.get(command) ?? { criteria: new Set<string>(), paths: new Set<string>(), final: true };
    record.final = true;
    byCommand.set(command, record);
  }
  return [...byCommand].map(([command, record]) => ({ command, criteria: [...record.criteria].sort(), paths: [...record.paths].sort(), final: record.final })).sort((a, b) => a.command.localeCompare(b.command));
}

export function generatedCommands(plan: ParsedPlan): { command: string; path: string }[] {
  return plan.changes.flatMap((change) => change.action === 'GENERATED' && change.command ? [{ command: change.command, path: change.path }] : []);
}

/** Write models are one ordered alias cascade under the current orchestrator and selected level. */
export function writerConfig(config: Readonly<Record<string, unknown>>, platform: string, level: Level): { ok: true; value: WriterConfig } | { ok: false; error: string } {
  const table = config['write-subagents'];
  const provider = isRecord(table) ? table[platform] : undefined;
  if (!isRecord(provider)) return { ok: false, error: `write-subagents.${platform} is not configured for implementation.` };
  const selected = selectLevel(LEVELS.filter((candidate) => provider[candidate] !== undefined), level);
  const entry = selected ? provider[selected] : undefined;
  if (!isRecord(entry)) return { ok: false, error: `write-subagents.${platform} has no model for level ${level}.` };
  const raw = entry['model'];
  const models = typeof raw === 'string' ? [raw] : Array.isArray(raw) && raw.every((item) => typeof item === 'string') ? raw as string[] : [];
  if (!models.length || models.some((model) => !model.trim())) return { ok: false, error: `write-subagents.${platform}.${selected}.model must be a non-empty model or cascade.` };
  if (new Set(models).size !== models.length) return { ok: false, error: `write-subagents.${platform}.${selected}.model contains a duplicate alias.` };
  const effort = typeof entry['effort'] === 'string' && entry['effort'].trim() ? entry['effort'] : null;
  return { ok: true, value: { models, effort } };
}

export function settledPlanInput(value: unknown): SettledPlanInput | null {
  if (!isRecord(value) || !NON_EMPTY(value['path']) || !/^sha256:[a-f0-9]{64}$/.test(String(value['hash'])) || !['settled', 'skipped'].includes(String(value['outcome']))) return null;
  return { path: value['path'], hash: value['hash'] as string, outcome: value['outcome'] as SettledPlanInput['outcome'] };
}

export function isFingerprint(value: unknown): value is TreeFingerprint {
  return isRecord(value) && (value['head'] === null || typeof value['head'] === 'string') && typeof value['index'] === 'string' && typeof value['worktree'] === 'string';
}

export function recoveryRef(value: unknown): RecoveryRef | null {
  if (!isRecord(value) || !isRecord(value['recovery'])) return null;
  const ref = value['recovery'];
  return ref['version'] === 1 && typeof ref['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(ref['sha256']) && Number.isSafeInteger(ref['bytes']) && Number(ref['bytes']) > 0 && ref['path'] === `recovery-manifests/${ref['sha256']}.json` ? ref as RecoveryRef : null;
}

export function artifactRelative(fingerprint: unknown, file: string): string {
  const root = isRecord(fingerprint) && typeof fingerprint['repoRoot'] === 'string' ? fingerprint['repoRoot'].replace(/\\/g, '/').replace(/\/$/, '') : null;
  const normalized = file.replace(/\\/g, '/');
  if (!root) return normalized;
  const win = /^[a-zA-Z]:/.test(root);
  const match = win
    ? normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : normalized.startsWith(`${root}/`);
  return match ? normalized.slice(root.length + 1) : normalized;
}
export function sameFingerprint(left: TreeFingerprint, right: TreeFingerprint): boolean {
  return left['head'] === right['head'] && left['index'] === right['index'] && left['worktree'] === right['worktree']
    && (left['observation'] === undefined || right['observation'] === undefined || left['observation'] === right['observation']);
}

export function approvalAnswer(value: DecisionAnswer): { by: string; quote: string } | null {
  if (!isRecord(value) || !NON_EMPTY(value['by']) || !NON_EMPTY(value['quote'])) return null;
  return { by: value['by'].trim(), quote: value['quote'].trim() };
}

export function isWriterEnvelope(value: unknown): value is WriterEnvelope {
  return isRecord(value) && value['schemaVersion'] === 1
    && ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'].includes(String(value['status']))
    && ['RED_READY', 'COMPLETE'].includes(String(value['stage']))
    && NON_EMPTY(value['summary']) && Array.isArray(value['evidence']) && value['evidence'].every((item) => typeof item === 'string');
}

export function criterionEvidenceRows(evidence: readonly string[], criteria: readonly PlanCriterion[]): string[] {
  const rows = evidence.flatMap((row) => {
    const match = /^CRITERION\s+(SC[1-9]\d*)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(row);
    return match ? [{ id: match[1] as string, path: match[2]?.trim() ?? '', behavior: match[3]?.trim() ?? '' }] : [];
  });
  return criteria.flatMap((criterion) => rows.some((row) => row.id === criterion.id && criterion.changes.includes(row.path) && row.behavior.length > 0) ? [] : [criterion.id]);
}

export function parseRedMatrix(evidence: readonly string[], criteria: readonly PlanCriterion[]): { rows: RedMatrixRow[]; defects: string[] } {
  const source = evidence.filter((row) => row.startsWith('RED-MATRIX '));
  const rows: RedMatrixRow[] = [];
  const defects: string[] = [];
  for (const line of source) {
    // NOTE: a Windows path written into JSON as `tests\tooling` decodes `\t` to a tab; name the cause instead of a vague mismatch.
    if (/[\u0000-\u001f]/.test(line)) { defects.push(`RED-MATRIX row contains a control character (a JSON-escaped backslash such as \\t?); use forward-slash paths: ${redactOneLine(line)}`); continue; }
    const match = /^RED-MATRIX\s+(SC[1-9]\d*)\s*\|\s*([^|]+?)\s*\|\s*exit\s+([1-9]\d*)\s+((?:test|error):.+)$/i.exec(line);
    if (!match) { defects.push(`Malformed RED-MATRIX row: ${line}`); continue; }
    const target = match[2]?.trim() ?? '';
    const split = target.lastIndexOf(':');
    const file = split === -1 ? target : target.slice(0, split);
    const leaf = split === -1 ? '' : target.slice(split + 1).trim();
    const failureTests = (match[4] ?? '').split(';').map((part) => part.trim()).filter(Boolean);
    if (!isTestPath(file) || !leaf || !failureTests.length || failureTests.some((test) => !/^(?:test|error):\S/.test(test))) {
      defects.push(`RED-MATRIX ${match[1]} must name an approved test file, one leaf test, and test:<exact failing test name> entries joined by '; '.`);
      continue;
    }
    rows.push({ id: match[1] as string, path: file, leaf, exit: Number(match[3]), tests: failureTests });
  }
  for (const criterion of criteria) {
    const matches = rows.filter((row) => row.id === criterion.id);
    if (matches.length !== 1) defects.push(`Exactly one RED-MATRIX row required for ${criterion.id}; list every failure in that row.`);
    else if (!criterion.changes.includes(matches[0]?.path ?? '')) defects.push(`${criterion.id} RED-MATRIX path is outside its declared Changes paths.`);
    else if (criterion.redException) defects.push(`${criterion.id} has a RED exception and cannot claim a failing-state matrix row.`);
  }
  for (const row of rows) if (!criteria.some((criterion) => criterion.id === row.id)) defects.push(`RED-MATRIX names unknown criterion ${row.id}.`);
  return { rows, defects: [...new Set(defects)] };
}

export function redactOneLine(value: string): string { return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(); }

export function commandEffect(command: string, mapping: CommandMapping | null, inputPaths: readonly string[], environment: string): VerifyCommand {
  return { command, criteria: mapping?.criteria ?? [], paths: mapping?.paths ?? [], inputPaths, environment };
}
