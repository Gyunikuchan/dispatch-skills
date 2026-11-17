import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// SECTION: Types

export type LinkClass = 'unconditional' | 'conditional' | 'owner';
/** `when` states the condition of a conditional link; the test requires it near every prose occurrence. */
export type LinkEntry = { class: LinkClass; when?: string };
/** A tool call on the normal path; `kind` names the record kind of a `ledger append`. Count 0 lists a conditional anchor. */
export type Call = { action: string; kind?: string; count: number };
/** Targets are `references/...` paths relative to skills/dispatch, with an optional `#anchor`. */
export type PathManifest = { guide: string; links: Record<string, LinkEntry>; calls: Call[] };
export type Figures = { distinct: number; workload: number; editableDistinct: number; editableWorkload: number };
export type Model = 'before' | 'after';
export type Read = (rel: string) => string;
export type PathName = 'ask' | 'design' | 'plan' | 'implement' | 'review' | 'verify';

// SECTION: Manifest (fixed normal-path model; counts are representative, not observed averages)

const unconditional: LinkEntry = { class: 'unconditional' };
const owner: LinkEntry = { class: 'owner' };
const conditional = (when: string): LinkEntry => ({ class: 'conditional', when });
const call = (action: string, count: number): Call => ({ action, count });
const record = (kind: string, count: number): Call => ({ action: 'ledger append', kind, count });

const TOOLKIT = 'references/toolkit.md';
const BAR = 'references/templates/quality-bar.md';

export const MANIFEST: Record<PathName, PathManifest> = {
  ask: { guide: 'references/verbs/ask.md', links: {
    'SKILL.md#routing': unconditional, 'references/grounding.md#publish': conditional('only when'),
    'references/toolkit.md#ask-run': unconditional, 'references/grounding.md': conditional('when'),
    'references/decision-frame.md': conditional('When source checks'), 'references/providers.md#native-slots': unconditional,
    'references/providers.md': unconditional,
  }, calls: [call('ask run', 1)] },
  design: { guide: 'references/verbs/design.md', links: {
    'references/spec-authoring.md#resolve-and-author': conditional('No current spec'), 'references/grounding.md#scope-round': unconditional,
    [`${BAR}#shared`]: unconditional, [`${BAR}#spec`]: unconditional, [`${BAR}#design`]: unconditional,
    'references/spec-stage.md#readers-and-document-layers': unconditional, 'references/templates/design.md': unconditional,
    'references/grounding.md#check-and-recover': unconditional, [`${TOOLKIT}#lint-run`]: unconditional,
    [`${TOOLKIT}#bind`]: unconditional, 'references/spec-stage.md#run-level': unconditional,
    'references/review-rules.md': unconditional, 'references/verbs/review.md': unconditional,
    'references/spec-stage.md#revision-protocol': unconditional, [`${TOOLKIT}#edit`]: unconditional,
    'references/verbs/implement.md': unconditional, [`${TOOLKIT}#session-commands`]: conditional('For each ready increment'),
    'references/templates/increment-orchestrator-brief.md': conditional('On a verified host'),
    'references/providers.md#child-orchestrators': conditional('On a verified host'),
    'references/grounding.md#design-increments': unconditional, 'references/decision-frame.md#user-gate-boundaries': conditional('user gate'),
    'references/spec-stage.md#approval': conditional('otherwise'), [`${TOOLKIT}#worktree-deliver`]: conditional('With the opt-in'),
  }, calls: [call('doctor run', 1), call('lint run', 1), call('review run', 2), record('bind', 1), record('edit', 1), call('worktree deliver', 0)] },
  // Normal review assumes a code target; plan/design edit records are conditional.
  review: { guide: 'references/verbs/review.md', links: {
    'references/spec-stage.md#readers-and-document-layers': unconditional, [`${TOOLKIT}#review-run`]: unconditional,
    [`${BAR}#shared`]: unconditional, [`${BAR}#spec`]: unconditional, [`${BAR}#plan`]: unconditional,
    [`${BAR}#testing`]: unconditional, [`${BAR}#design`]: unconditional, [`${BAR}#code`]: unconditional,
    'references/review-rules.md': unconditional, [`${TOOLKIT}#ruling`]: unconditional,
    'references/review-rules.md#rulings-and-fix-scope': unconditional, [`${TOOLKIT}#edit`]: conditional('plan and design fixes'),
    'references/review-coverage.md#failed-slot-coverage': conditional('slot'), 'references/spec-stage.md': unconditional,
    'references/review-coverage.md#repository-changes-from-native-voices': conditional('repository change'),
  }, calls: [call('review run', 2), record('ruling', 8), record('edit', 0)] },
  // Step reads make the Decision Frame unconditional, including escalation without risky approval.
  verify: { guide: 'references/verbs/verify.md', links: {
    [`${TOOLKIT}#brief-verifier`]: unconditional, [`${TOOLKIT}#check-run`]: unconditional,
    'SKILL.md#routing': conditional('If `check run` fails'), 'references/decision-frame.md': unconditional,
    'references/spec-stage.md': unconditional, [`${TOOLKIT}#ledger-append`]: unconditional,
  }, calls: [call('brief verifier', 1), call('check run', 1), record('integrate', 1)] },
  plan: {
    guide: 'references/verbs/plan.md',
    links: {
      'references/spec-authoring.md#resolve-and-author': conditional('No current spec'),
      'references/grounding.md#scope-round': unconditional,
      'references/grounding.md#design-increments': conditional('increment plan'),
      [`${BAR}#shared`]: unconditional,
      [`${BAR}#spec`]: unconditional,
      [`${BAR}#plan`]: unconditional,
      [`${BAR}#testing`]: unconditional,
      'references/spec-stage.md#readers-and-document-layers': unconditional,
      'references/spec-stage.md#run-level': unconditional,
      'references/spec-stage.md#revision-protocol': unconditional,
      'references/templates/plan.md': unconditional,
      'references/templates/plan-field-notes.md': conditional('lint reports a code'),
      'references/grounding.md#check-and-recover': unconditional,
      [`${TOOLKIT}#lint-run`]: unconditional,
      [`${TOOLKIT}#bind`]: unconditional,
      [`${TOOLKIT}#edit`]: unconditional,
      'references/review-rules.md': unconditional,
      'references/decision-frame.md#review-escalation': conditional('recur'),
      'references/verbs/review.md': unconditional,
      'references/verbs/implement.md': conditional('Notify affected writers'),
    },
    calls: [
      call('doctor run', 1), call('brief explorer', 1), call('lint run', 3), call('review run', 2),
      record('bind', 1), record('level', 1), record('approval', 1), record('ruling', 8), record('edit', 2),
    ],
  },
  implement: {
    guide: 'references/verbs/implement.md',
    links: {
      'references/spec-stage.md': conditional('objective'),
      'references/spec-stage.md#readers-and-document-layers': unconditional,
      'references/verbs/plan.md': conditional('objective'),
      'references/verbs/design.md': conditional('authoring a design'),
      'references/verbs/design.md#implement-an-approved-design': conditional('supplied design'),
      [TOOLKIT]: owner,
      'references/grounding.md#scope-round': unconditional,
      'references/grounding.md#design-increments': conditional('design increment'),
      'references/spec-stage.md#run-level': conditional('authors the plan'),
      'references/review-coverage.md#failed-slot-coverage': conditional('slot'),
      'references/review-coverage.md#repository-changes-from-native-voices': conditional('repository change'),
      [`${TOOLKIT}#worktree-create`]: unconditional,
      [`${TOOLKIT}#brief-render`]: unconditional,
      [`${TOOLKIT}#worktree-submit`]: unconditional,
      [`${TOOLKIT}#worktree-integrate`]: unconditional,
      [`${TOOLKIT}#check-run`]: unconditional,
      [`${TOOLKIT}#brief-verifier`]: unconditional,
      'references/verbs/verify.md': unconditional,
      [`${BAR}#shared`]: unconditional,
      [`${BAR}#testing`]: unconditional,
      [`${BAR}#code`]: unconditional,
      [`${BAR}#spec`]: unconditional,
      'SKILL.md#routing': unconditional,
      'references/templates/test-cleanup-brief.md': unconditional,
      [`${TOOLKIT}#brief-test-cleanup`]: unconditional,
      [`${TOOLKIT}#worktree-commit`]: unconditional,
      'references/review-rules.md#review-provenance-and-applicability': unconditional,
      'references/review-rules.md#rulings-and-fix-scope': unconditional,
      'references/review-fixes.md': conditional('accepted fixes run'),
      'references/decision-frame.md#review-escalation': conditional('coverage-decision'),
      [`${TOOLKIT}#edit`]: conditional('accepted SHOULD'),
      [`${TOOLKIT}#manual-complete`]: unconditional,
      [`${TOOLKIT}#report-complete`]: unconditional,
      'references/worktree-cleanup.md': unconditional,
      [`${TOOLKIT}#worktree-deliver`]: unconditional,
      'references/spec-stage.md#revision-protocol': unconditional,
      'references/decision-frame.md#user-gate-boundaries': conditional('Discarding work'),
      [`${TOOLKIT}#worktree-continue`]: conditional('conflicts'),
      [`${TOOLKIT}#worktree-abort`]: conditional('conflicts'),
      [`${TOOLKIT}#worktree-abandon`]: conditional('stopped writer'),
      [`${TOOLKIT}#worktree-close`]: conditional('retained integration'),
      'references/templates/writer-brief.md': unconditional,
    },
    calls: [
      call('doctor run', 1), call('lint run', 1), call('check run', 4), call('worktree create', 2), call('brief render', 2),
      call('worktree submit', 2), call('worktree integrate', 2), call('brief verifier', 1), call('brief test-cleanup', 1),
      call('worktree commit', 2), call('review run', 2), call('worktree deliver', 1), call('report complete', 1),
      call('worktree cleanup', 1), call('worktree continue', 0), call('worktree abort', 0), call('worktree abandon', 0),
      call('worktree close', 0),
      record('bind', 1), record('approval', 1), record('ruling', 8), record('focus', 1), record('manual-complete', 1), record('integrate', 1), record('edit', 0),
    ],
  },
};

/** Every relative link in SKILL.md; true marks a read that the path makes on every normal run. */
export const SKILL_LINKS: Record<string, Record<PathName, boolean>> = {
  'references/decision-frame.md': { ask: false, design: true, plan: true, implement: false, review: false, verify: false },
  'references/decision-frame.md#user-gate-boundaries': { ask: false, design: false, plan: false, implement: true, review: false, verify: false },
  'references/providers.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/providers.md#child-orchestrators': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/providers.md#native-slots': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/review-rules.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/review-rules.md#review-provenance-and-applicability': { ask: false, design: false, plan: false, implement: true, review: false, verify: false },
  'references/self-build.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/spec-stage.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/spec-stage.md#approval': { ask: false, design: true, plan: true, implement: true, review: false, verify: false },
  'references/spec-stage.md#run-level': { ask: true, design: true, plan: true, implement: true, review: true, verify: true },
  'references/templates/quality-bar.md#shared': { ask: false, design: false, plan: false, implement: true, review: false, verify: false },
  [TOOLKIT]: { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  [`${TOOLKIT}#doctor-run`]: { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  [`${TOOLKIT}#native-slot-replies`]: { ask: true, design: true, plan: true, implement: true, review: true, verify: true },
  [`${TOOLKIT}#session-commands`]: { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  [`${TOOLKIT}#status-show`]: { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/verbs/ask.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/verbs/design.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/verbs/implement.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/verbs/plan.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/verbs/review.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/verbs/verify.md': { ask: false, design: false, plan: false, implement: false, review: false, verify: false },
  'references/worktree-cleanup.md': { ask: false, design: false, plan: false, implement: true, review: false, verify: false },
};

/** Figures at BASELINE_COMMIT; reproduce with --check-baseline. */
export const BASELINE_COMMIT = '7677a380';
export const BASELINE: Record<PathName, Figures> = {
  ask: { distinct: 30757, workload: 30757, editableDistinct: 29994, editableWorkload: 29994 },
  design: { distinct: 89058, workload: 89058, editableDistinct: 76438, editableWorkload: 76438 },
  review: { distinct: 60398, workload: 60398, editableDistinct: 42668, editableWorkload: 42668 },
  verify: { distinct: 33701, workload: 33701, editableDistinct: 30133, editableWorkload: 30133 },
  plan: { distinct: 85295, workload: 85295, editableDistinct: 69106, editableWorkload: 69106 },
  implement: { distinct: 100876, workload: 100876, editableDistinct: 86170, editableWorkload: 86170 },
};

// SECTION: Sections and bytes

export function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The heading line through the line before the next heading of the same or a higher level; null when absent. */
export function sectionOf(text: string, anchor: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fence = false;
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index++) {
    if (/^ {0,3}(```|~~~)/.test(lines[index]!)) { fence = !fence; continue; }
    if (fence) continue;
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[index]!);
    if (!match) continue;
    if (start < 0) {
      if (slug(match[2]!) === anchor) { start = index; level = match[1]!.length; }
    } else if (match[1]!.length <= level) {
      return lines.slice(start, index).join('\n').trimEnd();
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n').trimEnd();
}

// NOTE: CRLF is normalized so Windows checkouts and Git blobs give the same figures.
const bytes = (text: string) => Buffer.byteLength(text.replace(/\r\n/g, '\n'), 'utf8');
const isFrozen = (file: string) => /(^|\/)(quality-bar|spec-stage)\.md$/.test(file);

type ReadItem = { file: string; anchor?: string };

function pathReads(spec: PathManifest, name: string): ReadItem[] {
  const items: ReadItem[] = [{ file: 'SKILL.md' }, { file: spec.guide }];
  for (const [target, entry] of Object.entries(spec.links)) {
    if (entry.class !== 'unconditional') continue;
    const [file, anchor] = target.split('#') as [string, string | undefined];
    // A toolkit anchor reaches the orchestrator through the call sequence, never as a separate read.
    if (file !== TOOLKIT) items.push(anchor ? { file, anchor } : { file });
  }
  // A section that SKILL.md mandates has no call heading, so it is a direct read even in toolkit.md.
  for (const [target, paths] of Object.entries(SKILL_LINKS)) {
    if (!paths[name as PathName]) continue;
    const [file, anchor] = target.split('#') as [string, string | undefined];
    items.push(anchor ? { file, anchor } : { file });
  }
  const whole = new Set(items.filter(item => !item.anchor).map(item => item.file));
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.file}#${item.anchor ?? ''}`;
    if (seen.has(key) || (item.anchor && whole.has(item.file))) return false;
    seen.add(key);
    return true;
  });
}

// SECTION: Measure

export function measure<K extends string = PathName>(read: Read, model: Model, manifest = MANIFEST as Record<string, PathManifest> as Record<K, PathManifest>): Record<K, Figures> {
  const toolkit = read(TOOLKIT);
  const section = (heading: string) => {
    const text = sectionOf(toolkit, slug(heading));
    if (text === null) throw new Error(`toolkit.md has no section "${heading}"`);
    return bytes(text);
  };
  const result = {} as Record<K, Figures>;
  for (const [name, spec] of Object.entries<PathManifest>(manifest)) {
    const figures: Figures = { distinct: 0, workload: 0, editableDistinct: 0, editableWorkload: 0 };
    const add = (size: number, count: number, frozen: boolean) => {
      figures.workload += size * count;
      if (!frozen) figures.editableWorkload += size * count;
    };
    const addDistinct = (size: number, frozen: boolean) => {
      figures.distinct += size;
      if (!frozen) figures.editableDistinct += size;
    };
    for (const item of pathReads(spec, name)) {
      const text = read(item.file);
      const body = item.anchor ? sectionOf(text, item.anchor) : text;
      if (body === null) throw new Error(`${item.file} has no section "${item.anchor}"`);
      add(bytes(body), 1, isFrozen(item.file));
      addDistinct(bytes(body), isFrozen(item.file));
    }
    const headings = new Set<string>();
    for (const entry of spec.calls) {
      if (entry.count <= 0) continue;
      headings.add(entry.action);
      if (entry.kind) headings.add(entry.kind);
      if (model === 'before') {
        add(section(entry.action), entry.count, false);
        if (entry.kind) add(section(entry.kind), entry.count, false);
      }
    }
    for (const heading of model === 'after' ? ['call table', ...headings] : headings) {
      addDistinct(section(heading), false);
      if (model === 'after') add(section(heading), 1, false);
    }
    result[name as K] = figures;
  }
  return result;
}

// SECTION: Comparison and report

const LABELS: [keyof Figures, string][] = [
  ['distinct', 'distinct'], ['workload', 'workload'], ['editableDistinct', 'editable distinct'], ['editableWorkload', 'editable workload'],
];

// NOTE: only workload figures gate growth; distinct bytes rise by the call table, which replaces repeated reads, so they are reported only.
const GATED = new Set<keyof Figures>(['workload', 'editableWorkload']);

export function checkGrowth(result: Record<PathName, Figures>, baseline: Record<PathName, Figures> = BASELINE): string[] {
  const errors: string[] = [];
  for (const [name, figures] of Object.entries(result) as [PathName, Figures][]) {
    for (const [key, label] of LABELS) {
      if (GATED.has(key) && figures[key] > baseline[name]![key]) errors.push(`${name} ${label} grew to ${figures[key]} bytes above baseline ${baseline[name]![key]}`);
    }
  }
  return errors;
}

export function formatReport(result: Record<PathName, Figures>, baseline: Record<PathName, Figures> = BASELINE): string {
  const lines: string[] = [];
  for (const [name, figures] of Object.entries(result) as [PathName, Figures][]) {
    for (const [key, label] of LABELS) {
      const base = baseline[name]![key];
      const reduction = base ? ((base - figures[key]) / base) * 100 : 0;
      lines.push(`${name} ${label}: ${figures[key]} bytes (baseline ${base}, ${reduction.toFixed(1)}%)`);
    }
    const base = baseline[name]!.workload;
    const met = base > 0 && (base - figures.workload) / base >= 0.25;
    lines.push(`${name} workload 25% target: ${met ? 'met' : 'not met'} (reported only)`);
  }
  return lines.join('\n') + '\n';
}

/** Measures the checkout or a Git revision and checks the selected baseline. */
export function main(args: string[] = process.argv.slice(2), git: (args: string[]) => string = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), baseline: Record<PathName, Figures> = BASELINE): number {
  if (!(args.length === 0 || (args.length === 1 && args[0] === '--check-baseline') || (args.length === 2 && args[0] === '--at' && args[1]))) {
    process.stderr.write('Usage: path-bytes [--at <commit> | --check-baseline]\n'); return 2;
  }
  const commit = args[0] === '--check-baseline' ? BASELINE_COMMIT : args[1];
  const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/dispatch');
  let objectId: string | undefined;
  if (commit) {
    try {
      objectId = git(['rev-parse', '--verify', `${commit}^{commit}`]).trim();
    } catch (error) {
      const e = error as { stderr?: Buffer | string; message?: string };
      process.stderr.write(String(e.stderr || e.message) + '\n');
      return 2;
    }
  }
  const read: Read = commit
    ? rel => git(['show', `${objectId}:skills/dispatch/${rel}`])
    : rel => fs.readFileSync(path.join(skillDir, rel), 'utf8');
  const result = {} as Record<PathName, Figures>;
  let missing = false;
  for (const [name, spec] of Object.entries(MANIFEST) as [PathName, PathManifest][]) {
    try {
      result[name] = measure(read, 'after', { [name]: spec })[name]!;
    } catch (error) {
      if (!commit) throw error;
      missing = true;
      process.stdout.write(`${name}: missing ${(error as Error).message}\n`);
    }
  }
  process.stdout.write(formatReport(result, baseline));
  if (args[0] === '--check-baseline') {
    const unequal = missing || Object.entries(result).some(([name, figures]) => LABELS.some(([key]) => figures[key] !== baseline[name as PathName][key]));
    if (unequal) process.stderr.write('Baseline differs from commit measure\n');
    return unequal ? 1 : 0;
  }
  if (commit) return 0;
  const errors = checkGrowth(result, baseline);
  for (const error of errors) process.stderr.write(`${error}\n`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
