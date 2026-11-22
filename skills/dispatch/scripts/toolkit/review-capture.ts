import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameRetrying } from '../lib/node-fs-ext.ts';
import { artifactHash } from './artifacts.ts';
import { taskMarkdown } from './brief.ts';
import type { HandlerContext } from './cli.ts';
import { governedDesignText } from './domain/design.ts';
import { governedPlanText, parsePlan, selectTaskBrief } from './domain/plan.ts';
import type { ReviewKind } from './domain/types.ts';
import type { ReviewTarget } from './findings.ts';
import { git, gitOk, gitPaths } from './git.ts';
import { integrationRecord } from './integration.ts';
import { currentHashes, foldLedger, latest, type Hashes } from './ledger.ts';
import { ToolError } from './output.ts';
import { artifactSections } from './prompts.ts';
import { launches } from './writers.ts';

// NOTE: shared by every target rejection so the host can correct its target in one turn.
export const CODE_TARGETS = 'code targets are integration, a bound-plan task ID, worktree, <a>..<b> or <rev>';

export type Capture = {artifactPath?:string; artifacts?:Hashes; spec: {path: string; hash: string}; specSource?: string; target: ReviewTarget; source?: string; taskSummary: string; cwd: string; changed: string[]};

// NOTE: fix-review-lite reads the reviewed spec text from this snapshot; a failed write only leaves that text unavailable, so it never refuses the round.
function writeSpecSnapshot(file: string, text: string): void {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {fs.writeFileSync(temp, text); renameRetrying(temp, file);}
  catch {/* advisory evidence only */}
  finally {try {fs.rmSync(temp, {force: true});} catch {/* advisory evidence only */}}
}

// Reviewer input holds governed plan/design text; code reviews read the working tree directly.
export const reviewerInputPath = (reviewDir: string, roundNumber: number): string => path.join(reviewDir, 'round-' + roundNumber + '.input.md');
const governedInputFor = (reviewKind: ReviewKind, source: string): string => reviewKind === 'plan' ? governedPlanText(source) : governedDesignText(source);
export function writeReviewerInput(reviewDir: string, roundNumber: number, reviewKind: ReviewKind, source: string): void {
  // A write failure refuses the round before any launch.
  const file = reviewerInputPath(reviewDir, roundNumber);
  try { fs.writeFileSync(file, governedInputFor(reviewKind, source)); }
  catch (error) { throw new ToolError(2, 'review-failed', 'Cannot write reviewer input ' + file + ': ' + (error instanceof Error ? error.message : String(error))); }
}

export function writeRoundSnapshots(dir: string, kind: ReviewKind, captured: Capture): void {
  if (captured.source !== undefined) fs.writeFileSync(path.join(dir, 'target.snapshot.md'), captured.source);
  if ((kind === 'plan' || kind === 'design') && captured.specSource !== undefined) writeSpecSnapshot(path.join(dir, 'spec.snapshot.md'), captured.specSource);
}

// NOTE: an unreadable spec reports the same invalid-input as capture, which keeps the refusal reason stable.
export function specHashFor(root: string, input: string): string {
  const specPath = path.resolve(root, input);
  let text: string;
  try {text = fs.readFileSync(fs.realpathSync.native(specPath), 'utf8');}
  catch {throw new ToolError(1, 'invalid-input', 'Cannot read spec ' + specPath);}
  return artifactHash('spec', text);
}

export async function captureReviewTarget(
  {session, manifest, deps, values}: HandlerContext,
  kind: ReviewKind,
  artifact: string,
  requested: string,
  taskTarget: boolean,
  gitTarget: boolean,
): Promise<Capture> {
  const current = foldLedger(session), bind = latest(current, 'bind');
  const specInput = values['spec'] ?? bind?.data['spec'];
  if (typeof specInput !== 'string') throw new ToolError(4, 'lint-errors', 'Review needs --spec or a bound spec');
  let specPath = path.resolve(manifest.repositoryRoot, specInput);
  let specText: string;
  try {specPath = fs.realpathSync.native(specPath); specText = fs.readFileSync(specPath, 'utf8');}
  catch {throw new ToolError(1, 'invalid-input', 'Cannot read spec ' + specPath);}
  const spec = {path: specPath, hash: artifactHash('spec', specText)};
  const intent = artifactSections(specText).get('Intent & Problem') || 'Review the selected changes.';
  if (kind !== 'code') {
    const source = fs.readFileSync(artifact, 'utf8');
    return {artifactPath:fs.realpathSync.native(artifact),spec, specSource: specText, target: artifactHash(kind, source), source, taskSummary: intent, cwd: manifest.repositoryRoot, changed: []};
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
  const changed = await gitPaths(deps, manifest.repositoryRoot, ['diff', '--name-only', '-z', base, head]);
  if (!changed.length) throw new ToolError(4, 'nothing-to-review', `No changes between ${base.slice(0, 12)}..${head.slice(0, 12)}`);
  return {...(!gitTarget && bind ? {artifacts:{...currentHashes(manifest.repositoryRoot,bind),spec:spec.hash}} : {}),spec, target: {base, head}, taskSummary: intent + '\n\n' + summary, cwd, changed};
}
