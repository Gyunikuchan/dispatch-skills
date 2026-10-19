// `write-brief`: fill `write-brief.md` with the stage block, write the brief to `<run>/<effectId>/brief.md`, and name
// the envelope path the writer must produce (`<run>/<effectId>/outcome.json`, not created here).

import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler } from '../core/types.ts';
import { assembleTemplate, fillTemplate, qualityBar } from '../domain/prompt.ts';
import { writeRendered } from './artifacts.ts';
import { runPaths } from '../lib/session.ts';

type BriefEffect = Extract<Effect, { kind: 'write-brief' }>;

export type BriefDeps = { skillRoot: string; checkpointCommand?: (root: string, out: string, paths: readonly string[]) => string };

const quote = (value: string): string => `"${value}"`;
const defaultCheckpoint = (root: string, out: string, paths: readonly string[]): string => `dispatch checkpoint --root ${quote(root)} --out ${quote(out)} -- ${paths.map(quote).join(' ')}`;

// NOTE: plan headings would otherwise read as brief sections; the fence outgrows any backtick run inside the plan.
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return `${fence}markdown\n${text.trim()}\n${fence}`;
}

function siblingRow(value: unknown): string {
  if (typeof value !== 'object' || value === null) return `- ${String(value)}`;
  const row = value as { id?: unknown; outcome?: unknown; prerequisites?: unknown; criteria?: unknown; paths?: unknown; overlap?: unknown };
  const list = <T>(items: unknown, format: (item: T) => string) => Array.isArray(items) && items.length ? (items as T[]).map(format).join(', ') : 'none';
  const overlap = list(row.overlap, (item: { path: string; tasks: readonly string[] }) => `\`${item.path}\` (${item.tasks.join(', ')})`);
  return `- ${String(row.id)} | ${String(row.outcome)} | prerequisites: ${list(row.prerequisites, String)} | criteria: ${list(row.criteria, String)} | paths: ${list(row.paths, (path: string) => `\`${path}\``)} | overlap: ${overlap}`;
}

function render(value: unknown): string {
  if (typeof value === 'string') return value.trim() || '(none)';
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${typeof item === 'string' ? item.trim() : JSON.stringify(item)}`).join('\n') : '(none)';
  if (value === undefined || value === null) return '(none)';
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

const sections = (rows: readonly (readonly [string, string])[]): string => rows.map(([heading, body]) => `## ${heading}\n\n${body}`).join('\n\n');

/** Contract self-check and integration gate sections; empty or absent keys add none, so non-contract briefs keep their bytes. */
function contractSections(input: Readonly<Record<string, unknown>>): [string, string][] {
  const rows: [string, string][] = [];
  const checks = Array.isArray(input['contractChecks']) ? input['contractChecks'].filter((item): item is string => typeof item === 'string') : [];
  if (checks.length) rows.push(['Contract self-check', [
    'After your last edit and before you submit, run each command below in your worktree in addition to the mapped commands. Record one `CHECK <command> | exit <code>` evidence row per command.',
    ...checks.map((command) => `- \`${command}\``),
  ].join('\n')]);
  const failure = input['contractFailure'] as { rows?: unknown } | null | undefined;
  const failed = failure && Array.isArray(failure.rows) ? failure.rows as { command: string; exit: number; logPath: string; passedBefore: boolean }[] : [];
  if (failed.length) rows.push(['Integration contract failure', [
    ...failed.map((row) => `- \`${row.command}\` exit ${row.exit}; log ${row.logPath}${row.passedBefore ? '; passed before this task integrated and fails after it' : ''}`),
    '',
    'Fix the failure within the task scope and resubmit. When the fix needs other paths, send a writer request (`REQUEST`) or return `BLOCKED`.',
  ].join('\n')]);
  return rows;
}

type DeltaBase = { path: string; sha256: string; seq: number };

function deltaBaseOf(input: Readonly<Record<string, unknown>>): DeltaBase | null {
  const base = input['deltaBase'] as Partial<DeltaBase> | undefined;
  return base && typeof base.path === 'string' && typeof base.sha256 === 'string' && Number.isSafeInteger(base.seq) ? base as DeltaBase : null;
}

/** Amendment delta: the current task sections a live writer applies on top of the base brief it already holds. */
function deltaText(input: Readonly<Record<string, unknown>>, base: DeltaBase, values: Readonly<Record<string, string>>): string {
  // NOTE: the signature repeats every criterion definition; the Criteria section already carries them.
  const { signature: _signature, ...task } = (input['task'] ?? {}) as Readonly<Record<string, unknown>>;
  const header = [
    '# Amendment delta', '',
    `Base: ${base.path} · ${base.sha256}`,
    `Amendment: ${base.seq}`, '',
    'You hold the base brief. Each section below replaces the base brief section or value of the same name; every other base brief section still applies. Report this delta\'s hash as `briefHash` unless you read a newer brief or delta.',
  ].join('\n');
  return `${header}\n\n${sections([
    ['Plan revision notices', render(input['revisionNotice'])],
    ['Expected Envelope Path', values['Expected Envelope Path']!],
    ['Self Check Command', values['Self Check Command']!],
    ['Checkpoint Command', values['Checkpoint Command']!],
    ['Task, graph, and worktree', render(task)],
    ['Settled scope', render(input['settledScope'])],
    ['Criteria', render(input['criteria'])],
    ...contractSections(input),
  ])}\n`;
}

function structuredContext(input: Readonly<Record<string, unknown>>): string {
  const rows: [string, string][] = [];
  const spec = input['governingSpec'];
  if (typeof spec === 'object' && spec !== null && 'path' in spec && 'hash' in spec) rows.push(['Governing spec', `Path: ${String(spec.path)}\nHash: ${String(spec.hash)}`]);
  if (typeof input['planPath'] === 'string' || typeof input['planHash'] === 'string') {
    rows.push(['Governing plan', `Path: ${String(input['planPath'] ?? '(unknown)')}\nHash: ${String(input['planHash'] ?? '(unknown)')}`]);
  }
  rows.push(['Governing outcome', render(input['governingOutcome'])]);
  if (typeof input['sharedContext'] === 'string' && input['sharedContext'].trim()) rows.push(['Shared plan context', fenced(input['sharedContext'])]);
  if (input['task']) rows.push(['Task, graph, and worktree', render(input['task'])]);
  if (Array.isArray(input['siblingTasks'])) rows.push(['Sibling tasks', input['siblingTasks'].length ? input['siblingTasks'].map(siblingRow).join('\n') : '(none)']);
  // NOTE: a regenerated brief names what changed and the brief it supersedes, so a live writer can reconcile its draft.
  if (input['revisionNotice']) rows.push(['Plan revision notices', render(input['revisionNotice'])]);
  if (input['previousBriefs']) rows.push(['Previous brief provenance', render(input['previousBriefs'])]);
  rows.push(['Settled scope', render(input['settledScope'])]);
  rows.push(['Criteria', render(input['criteria'])]);
  rows.push(...contractSections(input));
  if (input['designBinding']) rows.push(['Governing design and inherited contract', render(input['designBinding'])]);
  if (input['reopenedDefects']) rows.push(['Integration repair context', render(input['reopenedDefects'])]);
  rows.push(['Envelope schema', render(input['envelopeSchema'])]);
  if (input['existingRedMatrix'] !== undefined) rows.push(['Existing RED matrix', render(input['existingRedMatrix'])]);
  if (input['admissionDefects'] !== undefined) rows.push(['Admission defects', render(input['admissionDefects'])]);
  if (input['retryContext']) rows.push(['Retry root cause and failure evidence', render(input['retryContext'])]);
  if (input['rootCause']) rows.push(['Root cause', render(input['rootCause'])]);
  if (input['stalledCheck']) rows.push(['Stalled check evidence', render(input['stalledCheck'])]);
  if (input['hotfix']) rows.push(['Hotfix limits and single-shot writer', render(input['hotfix'])]);
  rows.push(['Repository rules', render(input['rules'])]);
  rows.push(['Prior review findings', render(input['priorFindings'])]);
  rows.push(['Verification evidence', `Evidence, not specification.\n${render(input['evidence'])}`]);
  return `\n${sections(rows)}\n`;
}

export function createWriteBrief(deps: BriefDeps): Handler<BriefEffect> {
  return async (effect, ports, ctx) => {
    const envelopePath = runPaths(ctx.runDir).envelope(effect.id);
    const briefPath = runPaths(ctx.runDir).brief(effect.id);
    const base = effect.stage === 'task' ? deltaBaseOf(effect.input) : null;
    let text: string, delta: string | null = null;
    try {
      const dir = path.join(deps.skillRoot, 'references', 'templates');
      const template = assembleTemplate(ports.fs.readText(path.join(dir, 'write-brief.md')), ports.fs.readText(path.join(dir, `write-brief-${effect.stage}.md`)), undefined, [qualityBar(ports.fs.readText(path.join(dir, 'quality-bar.md')), 'writer')]);
      const rawSelfCheck = typeof effect.input['selfCheck'] === 'string' ? effect.input['selfCheck'] : 'dispatch --check-envelope <Expected Envelope Path>';
      const selfCheck = rawSelfCheck.split('<Expected Envelope Path>').join(envelopePath);
      const task = typeof effect.input['task'] === 'object' && effect.input['task'] !== null ? effect.input['task'] as Readonly<Record<string, unknown>> : null;
      const checkpoint = task && typeof task['checkpoint'] === 'object' && task['checkpoint'] !== null ? task['checkpoint'] as { root?: unknown; paths?: unknown } : null;
      const checkpointCommand = checkpoint && typeof checkpoint.root === 'string' && Array.isArray(checkpoint.paths)
        ? (deps.checkpointCommand ?? defaultCheckpoint)(checkpoint.root, envelopePath.replace(/outcome\.json$/, 'red.json'), checkpoint.paths.filter((item): item is string => typeof item === 'string'))
        : 'No RED checkpoint: this task has no RED criteria.';
      const values: Record<string, string> = { 'Expected Envelope Path': envelopePath, 'Self Check Command': selfCheck, 'Checkpoint Command': checkpointCommand };
      const rendered = fillTemplate(template.template, template.variables, Object.fromEntries(template.variables.map((name) => [name, values[name] ?? ''])));
      text = `${rendered}${structuredContext(effect.input)}`;
      if (base) delta = deltaText(effect.input, base, values);
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: error instanceof Error ? error.message : String(error) }];
    }
    try { writeRendered(ports, briefPath, text); } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `brief: ${error instanceof Error ? error.message : String(error)}` }];
    }
    const deltaPath = runPaths(ctx.runDir).delta(effect.id);
    if (delta !== null) try { writeRendered(ports, deltaPath, delta); } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `delta: ${error instanceof Error ? error.message : String(error)}` }];
    }
    const hash = (value: string): string => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
    return [{ type: 'BRIEF_READY', effectId: effect.id, stage: effect.stage, path: briefPath, sha256: hash(text), envelopePath, ...(delta !== null ? { delta: { path: deltaPath, sha256: hash(delta) } } : {}) }];
  };
}
