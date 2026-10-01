// `prepare-review`: resolve the review scope and write one prompt per roster slot to `<run>/<effectId>.<slot>.prompt.md`.
// Code scope comes from `effects/git.ts` (an empty diff → `{ empty: true }`, no prompts); plan/design prompts name
// the artifact. Carried pending rejections are appended to their affinity slot's prompt (or every prompt when
// unassigned). `ask` has no template (I02 owns templates), so its bounded prompt is built inline.

import path from 'node:path';
import type { Effect, Handler, ResultEvent } from '../core/types.ts';
import { assembleTemplate, fillTemplate } from '../domain/prompt.ts';
import { safeSlot } from './wave.ts';
import { writeRendered } from './artifacts.ts';
import type { Git } from './git.ts';
import type { IntegrationScope } from '../core/types.ts';

type PrepareEffect = Extract<Effect, { kind: 'prepare-review' }>;
type Row = Readonly<Record<string, unknown>>;

export type PrepareDeps = { skillRoot: string; cwd: string; git: Git };

type Carried = { id: string; slot: string | null; locus: string; defect: string; reason: string };

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
export function integrationScope(value: unknown): IntegrationScope {
  if (!isRecord(value) || typeof value['baseline'] !== 'string' || !/^[a-f0-9]{40,64}$/.test(value['baseline']) || typeof value['revision'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value['revision']) || !isRecord(value['ownership']) || !Object.keys(value['ownership']).length) throw new Error('Integration requires a recorded baseline, governed revision and journal-owned increment paths.');
  for (const [id, paths] of Object.entries(value['ownership'])) if (!/^I\d{2}$/.test(id) || !Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && !!p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'))) throw new Error('Integration ownership is missing or unsafe.');
  return value as IntegrationScope;
}

function carriedOf(scope: Row): Carried[] {
  const list = Array.isArray(scope['carried']) ? scope['carried'] : [];
  return list.filter(isRecord).map((entry) => ({
    id: text(entry['id']), slot: typeof entry['slot'] === 'string' ? entry['slot'] : null, locus: text(entry['locus']),
    defect: text(entry['defect']), reason: text(entry['reason']),
  }));
}

export function carriedSection(carried: readonly Carried[], slot: string): string {
  const mine = carried.filter((entry) => entry.slot === null || entry.slot === slot);
  if (!mine.length) return '';
  const rows = mine.map((entry) => `- ${entry.id} ${entry.locus}: ${entry.defect} — orchestrator rejection: ${entry.reason || 'no reason recorded'}`);
  return `\n\n### Pending rejections\nRe-raise a finding below only with new evidence; omitting it accepts the rejection.\n${rows.join('\n')}\n`;
}

export function askPrompt(question: string, context: string): string {
  return [
    '# Ask', '', '### Objective', question.trim() || '(empty question)', '',
    ...(context.trim() ? ['### Context', context.trim(), ''] : []),
    '### Evidence', 'Read the workspace read-only. Cite each claim with `<file>:L<line>` or a command you ran.', '',
    '### Stop condition', 'Stop once the objective is answered or evidence is exhausted; say what remains unknown.', '',
    '### Output', 'Plain text: a short answer first, then the supporting claims, one per line.', '',
  ].join('\n');
}

function reviewScopeText(round: number, scope: string, changed: readonly string[], target: string): string {
  if (round <= 1 && scope === 'full') return 'Full review';
  const what = changed.length ? `changed paths: ${changed.join(', ')}` : 'no recorded changes';
  return `Re-review round ${round} (${scope}) — ${what}${target ? `; ${target}` : ''}`;
}

function kindValues(kind: string, spec: Row, scopeText: string): Record<string, string> {
  const target = text(spec['target']);
  const requirement = text(spec['context'], target);
  switch (kind) {
    case 'plan': return { 'Plan Path': target, Requirement: requirement, 'Review Scope': scopeText };
    case 'design': return { 'Design Path': target, Requirement: requirement, 'Review Scope': scopeText };
    default: return { 'Task Summary': requirement || 'Review the selected changes.', 'Walkthrough Path': 'None', 'Plan Path': 'None', 'Review Scope': scopeText };
  }
}

export function createPrepareReview(deps: PrepareDeps): Handler<PrepareEffect> {
  return async (effect, ports, ctx) => {
    const spec = effect.review;
    const kind = text(spec['kind'], 'code');
    const roster = (Array.isArray(spec['roster']) ? spec['roster'] : []).filter(isRecord).filter((slot) => typeof slot['slot'] === 'string');
    const scope = effect.scope;
    const carried = carriedOf(scope);
    const results: ResultEvent[] = [];
    let changed: string[] = [];
    let integrationBound: IntegrationScope | null = null;
    let body: (slot: string) => string;
    try {
      if (kind === 'ask') {
        const prompt = askPrompt(text(spec['target']), text(spec['context']));
        body = () => prompt;
      } else {
        if (kind === 'code') {
          let integration: unknown = scope['integration'];
          if (integration === undefined && text(spec['context']).startsWith('{')) {
            const context: unknown = JSON.parse(text(spec['context']));
            if (isRecord(context)) integration = context['integration'];
          }
          if (integration !== undefined) {
            const bound = integrationScope(integration);
            integrationBound = bound;
            if (!deps.git.ancestor || !deps.git.baselineDiff || !await deps.git.ancestor(deps.cwd, bound.baseline)) throw new Error('Integration baseline is not an ancestor of HEAD.');
            const owned = new Set(Object.values(bound.ownership).flat());
            changed = (await deps.git.baselineDiff(deps.cwd, bound.baseline)).filter((p) => owned.has(p));
            if (!changed.length) throw new Error('Integration has an empty intersection with journal-owned paths.');
          } else changed = await deps.git.diffNames(deps.cwd, text(spec['target']));
          if (!changed.length) return [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { empty: true, kind, paths: [] }, promptPaths: {} }];
        }
        const dir = path.join(deps.skillRoot, 'references', 'templates');
        const frame = ports.fs.readText(path.join(dir, 'review-prompt.md'));
        const block = ports.fs.readText(path.join(dir, `review-prompt-${kind}.md`));
        const template = assembleTemplate(frame, block);
        const values: Record<string, string> = {
          'User Focus Areas': text(spec['context'], 'General review') || 'General review', 'Tool Turn Budget': 'Unspecified',
          ...kindValues(kind, spec, reviewScopeText(effect.round, text(scope['scope'], 'full'), changed, text(spec['target']))),
        };
        const filled = fillTemplate(template.template, template.variables, Object.fromEntries(template.variables.map((name) => [name, values[name] ?? ''])));
        body = (slot) => `${filled}${integrationBound ? `\n\n### Integration scope\nReview only the diff from ancestor ${integrationBound.baseline} on these paths: ${changed.join(', ')}.\nGoverned design revision: ${integrationBound.revision}.\nIncrement ownership: ${JSON.stringify(integrationBound.ownership)}.\n` : ''}${carriedSection(carried, slot)}`;
      }
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: error instanceof Error ? error.message : String(error) }];
    }
    const promptPaths: Record<string, string> = {};
    for (const slot of roster) {
      const name = String(slot['slot']);
      const file = path.join(ctx.runDir, `${effect.id}.${safeSlot(name)}.prompt.md`);
      try { writeRendered(ports, file, body(name)); } catch (error) {
        return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `prompt: ${error instanceof Error ? error.message : String(error)}` }];
      }
      promptPaths[name] = file;
    }
    results.push({ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { empty: false, kind, paths: changed, scope: text(scope['scope'], 'full') }, promptPaths });
    return results;
  };
}
