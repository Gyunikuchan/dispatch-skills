// `prepare-review`: resolve the review scope and write one prompt per roster slot to `<run>/<effectId>.<slot>.prompt.md`.
// Code scope comes from `effects/git.ts` (an empty diff → `{ empty: true }`, no prompts); plan/design prompts name
// the artifact. Later rounds list settled prior rulings; carried pending rejections are appended to their affinity
// slot's prompt (or every prompt when unassigned). Code scope excludes the dispatch workspace (session files).
// `ask` has no template, so its bounded prompt is built inline.

import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler, Ports, ResultEvent } from '../core/types.ts';
import { assembleTemplate, fillTemplate } from '../domain/prompt.ts';
import { structuralLines } from '../domain/plan.ts';
import { safeSlot } from './wave.ts';
import { writeRendered } from './artifacts.ts';
import { runPaths } from '../lib/session.ts';
import { isCommitHash, type Git, type ReviewSnapshot } from './git.ts';
import { reviewArtifactText } from './check-review-target.ts';
import type { IntegrationScope } from '../core/types.ts';
import { dispatchWorkspaceOf, runOwnedPaths } from './snapshot.ts';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

const scopedSnapshot = (snapshot: ReviewSnapshot, paths: readonly string[]): ReviewSnapshot => {
  const { fullIndex: _fullIndex, ...base } = snapshot;
  const allowed = new Set(paths);
  const selected = <T>(entries: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(entries).filter(([file]) => allowed.has(file)));
  return { ...base, governedPaths: [...allowed].sort(), index: selected(snapshot.index), working: selected(snapshot.working), untracked: selected(snapshot.untracked) };
};

export function parseArtifactSections(source: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = structuralLines(source);
  let currentHeading = 'Summary';
  let currentLines: string[] = [];
  for (const entry of lines) {
    const match = !entry.fenced ? /^##\s+(.+)$/.exec(entry.text) : null;
    if (match) {
      sections.set(currentHeading, currentLines.join('\n').trim());
      currentHeading = match[1]!.trim();
      currentLines = [];
    } else {
      currentLines.push(entry.original);
    }
  }
  sections.set(currentHeading, currentLines.join('\n').trim());
  return sections;
}

export function artifactSectionDelta(priorText: string, currentText: string): string[] {
  const prior = parseArtifactSections(priorText);
  const current = parseArtifactSections(currentText);
  const changed: string[] = [];
  const ignored = new Set(['Review Findings & Resolutions', 'Execution Status']);
  const seen = new Set<string>();
  for (const [heading, content] of current.entries()) {
    if (ignored.has(heading)) continue;
    seen.add(heading);
    if (!prior.has(heading) || prior.get(heading) !== content) {
      changed.push(heading);
    }
  }
  for (const [heading] of prior.entries()) {
    if (ignored.has(heading) || seen.has(heading)) continue;
    changed.push(heading);
  }
  return changed;
}

type PrepareEffect = Extract<Effect, { kind: 'prepare-review' }>;
type Row = Readonly<Record<string, unknown>>;

export type PrepareDeps = { skillRoot: string; cwd: string; git: Git };

type Carried = { id: string; slot: string | null; locus: string; defect: string; reason: string };

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
export function integrationScope(value: unknown): IntegrationScope {
  if (!isRecord(value) || !isCommitHash(value['baseline']) || typeof value['revision'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value['revision']) || !isRecord(value['ownership']) || !Object.keys(value['ownership']).length) throw new Error('Integration requires a recorded baseline, governed revision and journal-owned increment paths.');
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
  const rows = mine.map((entry) => `- ${entry.id} ${entry.locus}: ${entry.defect} — orchestrator rejection: ${entry.reason || 'no reason recorded'}; responsible source: ${entry.slot ?? 'unavailable'}`);
  return `\n\n### Pending rejections\nRe-raise a finding below only with new evidence; omitting it accepts the rejection.\n${rows.join('\n')}\n`;
}

type Settled = { id: string; locus: string; defect: string; ruling: string; reason: string };

function settledOf(scope: Row): Settled[] {
  const list = Array.isArray(scope['settled']) ? scope['settled'] : [];
  return list.filter(isRecord).map((entry) => ({ id: text(entry['id']), locus: text(entry['locus']), defect: text(entry['defect']), ruling: text(entry['ruling']), reason: text(entry['reason']) }));
}

/** Prior-round rulings, so reviewers do not re-argue settled points without new evidence. */
export function settledSection(settled: readonly Settled[]): string {
  if (!settled.length) return '';
  const clip = (value: string) => value.length > 200 ? `${value.slice(0, 199)}…` : value;
  const rows = settled.map((entry) => `- ${entry.id} ${entry.locus}: ${clip(entry.defect)} — ${entry.ruling}: ${entry.reason || 'no reason recorded'}`);
  return `\n\n### Settled in earlier rounds\nRe-raise a settled point only with new evidence that the ruling missed.\n${rows.join('\n')}\n`;
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
  const what = changed.length ? `changed paths: ${changed.join(', ')}` : 'no recorded changes';
  return `Review round ${round} (${scope}): ${what}; comparison: ${target || 'working tree against HEAD'}`;
}

async function kindValues(kind: string, spec: Row, scopeText: string, deps: PrepareDeps, ports: Pick<Ports, 'fs'>): Promise<Record<string, string>> {
  const target = text(spec['target']);
  const requirement = text(spec['context'], target);
  switch (kind) {
    case 'plan': return { 'Plan Path': target, Requirement: requirement, 'Review Scope': scopeText };
    case 'design': return { 'Design Path': target, Requirement: requirement, 'Review Scope': scopeText };
    default: {
      let taskSummary: string;
      const explicitContext = typeof spec['context'] === 'string' && spec['context'].trim() ? spec['context'].trim() : null;
      if (explicitContext) {
        taskSummary = explicitContext;
      } else if (target.includes('..')) {
        let commitLog = '';
        try {
          commitLog = deps.git.log ? await deps.git.log(deps.cwd, target) : '';
        } catch {
          commitLog = '';
        }
        taskSummary = commitLog.trim() || 'Review the selected changes.';
      } else {
        taskSummary = 'Review the selected changes.';
      }

      const governing = isRecord(spec['governing']) ? spec['governing'] : {};
      let planPath = typeof governing['planPath'] === 'string' && governing['planPath'] ? governing['planPath'] : null;
      let walkthroughPath = typeof governing['walkthroughPath'] === 'string' && governing['walkthroughPath'] ? governing['walkthroughPath'] : null;

      const sessionDir = typeof spec['sessionDir'] === 'string' && spec['sessionDir'] ? spec['sessionDir'] : null;
      if (sessionDir && (!planPath || !walkthroughPath)) {
        let entries: string[] = [];
        try {
          entries = ports.fs.listFiles(sessionDir).filter((file) => !file.includes('/') && !file.includes('\\'));
        } catch {
          entries = [];
        }
        if (!planPath) {
          const plans = entries.filter((f) => f.endsWith('.plan.md'));
          if (plans.length === 1) {
            planPath = path.join(sessionDir, plans[0]!).replace(/\\/g, '/');
          }
        }
        if (!walkthroughPath) {
          const walkthroughs = entries.filter((f) => f.endsWith('.walkthrough.md'));
          if (walkthroughs.length === 1) {
            walkthroughPath = path.join(sessionDir, walkthroughs[0]!).replace(/\\/g, '/');
          }
        }
      }

      return {
        'Task Summary': taskSummary,
        'Walkthrough Path': text(walkthroughPath, 'None'),
        'Plan Path': text(planPath, 'None'),
        'Review Scope': scopeText,
      };
    }
  }
}

export function createPrepareReview(deps: PrepareDeps): Handler<PrepareEffect> {
  return async (effect, ports, ctx) => {
    const spec = effect.review;
    const kind = text(spec['kind'], 'code');
    const roster = (Array.isArray(spec['roster']) ? spec['roster'] : []).filter(isRecord).filter((slot) => typeof slot['slot'] === 'string');
    const scope = effect.scope;
    const carried = carriedOf(scope);
    // Round 1 has no prior rulings; skipping it keeps first-round prompts byte-identical.
    const settled = effect.round > 1 ? settledSection(settledOf(scope)) : '';
    const results: ResultEvent[] = [];
    let changed: string[] = [];
    let manifestPath: string | undefined;
    let snapshot: ReviewSnapshot | undefined;
    let governedPaths: string[] | undefined;
    let bindingSnapshot: ReviewSnapshot | undefined;
    let bindingChanges: string[] | undefined;
    let integrationBound: IntegrationScope | null = null;
    let body: (slot: string) => string;
    try {
      if (kind === 'ask') {
        const prompt = askPrompt(text(spec['target']), text(spec['context']));
        body = () => prompt;
      } else {
        let scopeText: string;
        if (kind === 'code') {
          const root = await deps.git.toplevel(deps.cwd);
          const driverOwned = new Set(runOwnedPaths(ports, root, ctx.runDir, ctx.ownedArtifacts));
          // Session deliverables are reviewed through plan/design kinds, never as code changes.
          const workspace = dispatchWorkspaceOf(root, spec['sessionDir']);
          const inScope = (file: string) => !driverOwned.has(file) && !(workspace && file.startsWith(workspace));
          let integration: unknown = scope['integration'];
          if (integration === undefined && text(spec['context']).startsWith('{')) {
            let context: unknown;
            try { context = JSON.parse(text(spec['context'])); } catch { context = undefined; }
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
          changed = changed.filter(inScope);
          bindingChanges = (integrationBound ? await deps.git.baselineDiff!(deps.cwd, integrationBound.baseline) : [...changed]).filter(inScope);
          let prior: ReviewSnapshot | undefined;
          if (typeof scope['priorManifest'] === 'string') {
            const raw = ports.fs.readText(scope['priorManifest']);
            if (!raw || !deps.git.reviewDelta) throw new Error('review-round-binding-unavailable');
            prior = JSON.parse(raw) as ReviewSnapshot;
            governedPaths = [...new Set([...(prior.governedPaths ?? changed), ...(Array.isArray(scope['affectedPaths']) ? scope['affectedPaths'].filter((p): p is string => typeof p === 'string') : [])])];
          }
          bindingSnapshot = await deps.git.reviewSnapshot?.(deps.cwd, text(spec['target']), [...new Set([...bindingChanges, ...(governedPaths ?? changed)])], { fullIndex: true });
          if (prior) {
            snapshot = bindingSnapshot ? scopedSnapshot(bindingSnapshot, governedPaths!) : undefined;
            const delta = await deps.git.reviewDelta!(deps.cwd, prior, snapshot);
            if (scope['scope'] === 'delta') { const owned = integrationBound ? new Set(Object.values(integrationBound.ownership).flat()) : null; changed = owned ? delta.paths.filter((p) => owned.has(p)) : delta.paths.filter((p) => governedPaths!.includes(p)); }
          }
          if (scope['scope'] === 'disputes-only') changed = [...new Set(carried.map((row) => row.locus.replace(/:L\d+.*$/, '')))];
          if (deps.git.reviewSnapshot) {
            manifestPath = runPaths(ctx.runDir).scope(effect.id);
            snapshot ??= scopedSnapshot(bindingSnapshot!, governedPaths ?? changed);
            ports.fs.writeAtomic(manifestPath, JSON.stringify({ ...bindingSnapshot, governedPaths: snapshot.governedPaths ?? governedPaths ?? changed }));
          }
          if (!changed.length) return [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { empty: true, kind, paths: [] }, promptPaths: {} }];
          scopeText = reviewScopeText(effect.round, text(scope['scope'], 'full'), changed, text(spec['target']));
        } else {
          const target = text(spec['target']);
          const targetFile = ports.fs.readText(target) !== null ? target : path.resolve(deps.cwd, target);
          const currentText = ports.fs.readText(targetFile);
          if (currentText === null || currentText === undefined) throw new Error(`Artifact target unavailable: ${target}`);
          if (effect.round > 1 || typeof scope['priorManifest'] === 'string' || typeof scope['priorTarget'] === 'string') {
            let priorText: string | null = null;
            if (typeof scope['priorManifest'] === 'string') {
              const raw = ports.fs.readText(scope['priorManifest']);
              if (!raw) throw new Error('review-round-binding-unavailable');
              let prior: { text?: string };
              try { prior = JSON.parse(raw); } catch { throw new Error('review-round-binding-unavailable'); }
              if (typeof prior.text !== 'string') throw new Error('review-round-binding-unavailable');
              priorText = prior.text;
            } else if (typeof scope['priorTarget'] === 'string') {
              const pTarget = scope['priorTarget'];
              priorText = ports.fs.readText(pTarget) ?? ports.fs.readText(path.resolve(deps.cwd, pTarget));
            }
            if (priorText !== null) {
              changed = artifactSectionDelta(priorText, currentText);
            } else if (scope['fresh'] !== true) {
              throw new Error('review-round-binding-unavailable');
            }
          }
          manifestPath = runPaths(ctx.runDir).scope(effect.id);
          ports.fs.writeAtomic(manifestPath, JSON.stringify({ kind, target, text: currentText, hash: sha256(currentText), identityHash: sha256(reviewArtifactText(currentText)) }));
          const scopeKind = text(scope['scope'], 'full');
          if (effect.round === 1 && !changed.length) {
            scopeText = 'Full review';
          } else if (scopeKind === 'full') {
            scopeText = `Re-review round ${effect.round} (full artifact) — review the whole artifact; changed sections for context: ${changed.length ? changed.join(', ') : 'none'}`;
          } else {
            scopeText = `Re-review round ${effect.round} (delta) — changed sections: ${changed.length ? changed.join(', ') : 'none'}`;
          }
        }
        const dir = path.join(deps.skillRoot, 'references', 'templates');
        const frame = ports.fs.readText(path.join(dir, 'review-prompt.md'));
        const block = ports.fs.readText(path.join(dir, `review-prompt-${kind}.md`));
        const template = assembleTemplate(frame, block);
        const values: Record<string, string> = {
          'User Focus Areas': text(spec['context'], 'General review') || 'General review', 'Tool Turn Budget': 'Unspecified',
          ...(await kindValues(kind, spec, scopeText, deps, ports)),
        };
        const filled = fillTemplate(template.template, template.variables, Object.fromEntries(template.variables.map((name) => [name, values[name] ?? ''])));
        body = (slot) => `${filled}${isRecord(spec['governing']) ? `\n\n### Governing artifacts and criteria\n${JSON.stringify(spec['governing'])}\n` : ''}${integrationBound ? `\n\n### Integration scope\nReview only the diff from ancestor ${integrationBound.baseline} on these paths: ${changed.join(', ')}.\nGoverned design revision: ${integrationBound.revision}.\nIncrement ownership: ${JSON.stringify(integrationBound.ownership)}.\n` : ''}${settled}${carriedSection(carried, slot)}`;
      }
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: error instanceof Error ? error.message : String(error) }];
    }
    const promptPaths: Record<string, string> = {};
    for (const slot of roster) {
      const name = String(slot['slot']);
      const file = runPaths(ctx.runDir).prompt(effect.id, safeSlot(name));
      try { writeRendered(ports, file, body(name)); } catch (error) {
        return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `prompt: ${error instanceof Error ? error.message : String(error)}` }];
      }
      promptPaths[name] = file;
    }
    let bindingPath: string | undefined;
    if (kind === 'code' && bindingSnapshot) {
      bindingPath = `${runPaths(ctx.runDir).scope(effect.id)}.binding.json`;
      ports.fs.writeAtomic(bindingPath, JSON.stringify({ ...bindingSnapshot, changeSet: bindingChanges, ...(integrationBound ? { changeBaseline: integrationBound.baseline } : {}) }));
    }
    results.push({ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { empty: false, kind, paths: changed, scope: text(scope['scope'], 'full'), ...(manifestPath ? { manifestPath } : {}), ...(bindingPath ? { bindingPath } : {}) }, promptPaths });
    return results;
  };
}
