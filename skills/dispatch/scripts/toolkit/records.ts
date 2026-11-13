import crypto from 'node:crypto';
import { IMPACTS, TRIGGERS } from './domain/severity.ts';
import { stableValue } from './domain/stable-value.ts';
import { ToolError, clipBytes } from './output.ts';

export const KINDS = ['bind', 'approval', 'level', 'waiver', 'manual-complete', 'escalation', 'ruling', 'note', 'edit', 'evidence', 'writer', 'integrate', 'focus', 'confirm'] as const;
export type LedgerRecord = { seq: number; key: string; at: string; kind: string; by: string; quote?: string; batchEndSeq?: number; data: Record<string, any> };
export type RecordInput = Omit<LedgerRecord, 'seq' | 'at' | 'key'> & { key?: string };
export type ReviewFix = { review: string; round: number; generation: number; findings: string[]; from: string };
type Rule = (value: unknown, field: string) => void;

// Naming the expected shape lets the caller correct the record in one turn.
function invalid(field: string, expected: string): never {
  throw new ToolError(1, 'invalid-record', field + ' is invalid; expected ' + expected);
}
const SHAPES = new WeakMap<Rule, string>();
const shaped = (shape: string, rule: Rule): Rule => (SHAPES.set(rule, shape), rule);
const shapeOf = (rule: Rule) => SHAPES.get(rule) ?? 'a valid value';
const check = (shape: string, ok: (value: unknown) => boolean): Rule => shaped(shape, (value, field) => { if (!ok(value)) invalid(field, shape); });

const text = check('a non-blank string', (value) => typeof value === 'string' && !!value.trim());
const hash = check('sha256:<64 lowercase hex>', (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value));
const git = check('a full 40- or 64-hex Git object id', (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value));
const integer = check('an integer', (value) => Number.isSafeInteger(value));
const bool = check('a boolean', (value) => typeof value === 'boolean');
const string = check('a string', (value) => typeof value === 'string');
const seq = check('a non-negative integer', (value) => Number.isSafeInteger(value) && (value as number) >= 0);
const launch = check('a positive ledger seq', (value) => Number.isSafeInteger(value) && (value as number) > 0);
const positive = check('a positive integer', (value) => Number.isSafeInteger(value) && (value as number) > 0);
const choice = (...values: string[]): Rule => check('one of ' + values.join(', '), (value) => values.includes(value as string));
const array: Rule = shaped('an array of non-blank strings', (value, field) => {
  if (!Array.isArray(value)) invalid(field, shapeOf(array));
  (value as unknown[]).forEach((item, index) => text(item, field + '.' + index));
});
const reviewFindings: Rule = shaped('a non-empty array of unique finding IDs', (value, field) => {
  if (!Array.isArray(value) || value.length === 0) invalid(field, shapeOf(reviewFindings));
  (value as unknown[]).forEach((item, index) => text(item, field + '.' + index));
  if (new Set(value as string[]).size !== (value as unknown[]).length) invalid(field, shapeOf(reviewFindings));
});
const treeMap: Rule = shaped('an object mapping criterion IDs to 40- or 64-hex Git object ids', (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, shapeOf(treeMap));
  for (const [criterion, id] of Object.entries(value as Record<string, unknown>)) {
    text(criterion, field + '.' + criterion);
    git(id, field + '.' + criterion);
  }
});

const describe = (fields: Record<string, Rule>, optional: string[] = []) => 'an object with ' + Object.keys(fields).map((key) => optional.includes(key) ? key + '?' : key).join(', ');
function object(value: unknown, fields: Record<string, Rule>, optional: string[] = [], prefix = 'data'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(prefix, describe(fields, optional));
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(fields, key)) invalid(prefix + '.' + key, 'no such field; allowed: ' + Object.keys(fields).join(', '));
  }
  for (const [key, rule] of Object.entries(fields)) {
    if (Object.hasOwn(data, key)) rule(data[key], prefix + '.' + key);
    else if (!optional.includes(key)) invalid(prefix + '.' + key, 'required ' + shapeOf(rule));
  }
}
const nested = (fields: Record<string, Rule>, optional: string[] = []): Rule => shaped(describe(fields, optional), (value, field) => object(value, fields, optional, field));

const dest = nested({ branch: text, path: text });
const artifacts = nested({ spec: hash, plan: hash, design: hash }, ['design']);
const reviewFix = nested({ review: text, round: positive, generation: positive, findings: reviewFindings, from: git });
const focusEvidence = check('an HTTPS URL or relative file path without whitespace or a root prefix', (value) => {
  if (typeof value !== 'string' || !value || /\s/.test(value)) return false;
  if (/^https:\/\//i.test(value)) {
    try { return new URL(value).protocol === 'https:'; }
    catch { return false; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || /^[\\/]/.test(value) || value.includes('\\')) return false;
  return value.includes('/') || /\.[^/.]+$/.test(value);
});
const focusBullet = nested({ text, evidence: focusEvidence });
const focusBullets: Rule = shaped('an array of zero to five review focus bullets', (value, field) => {
  if (!Array.isArray(value) || value.length > 5) invalid(field, shapeOf(focusBullets));
  (value as unknown[]).forEach((bullet, index) => focusBullet(bullet, `${field}.${index}`));
});
const shapes: Record<string, Record<string, Rule>> = {
  bind: { spec: text, plan: text, design: text },
  approval: { spec: hash, plan: hash, design: hash },
  confirm: { spec: hash },
  level: { level: choice('low', 'medium', 'high', 'xhigh', 'max') },
  waiver: { criterion: text, reason: text },
  'manual-complete': { criterion: text, evidence: text },
  escalation: { id: text, state: choice('open', 'resolved'), summary: text },
  ruling: { subject: text, ruling: text, rationale: text, impact: choice(...IMPACTS), trigger: choice(...TRIGGERS) },
  note: { text },
  edit: {
    artifact: choice('spec', 'plan', 'design'), before: hash, after: hash,
    class: choice('non-intent', 'intent', 'dependency', 'discard'), affects: array, rationale: text, diffRef: text,
  },
  evidence: {
    criterion: text, commandDigest: hash, tree: git, clean: bool,
    before: git, after: git, exit: integer, path: text, artifacts,
  },
  focus: { bullets: focusBullets, visual: text },
};
const writers: Record<string, Record<string, Rule>> = {
  launched: { task: text, path: text, base: nested({ commit: git, taskSection: hash, seq }) },
  finished: { task: text, launch, candidate: git },
  abandoned: { task: text, launch, reason: text },
};
const integrations: Record<string, Record<string, Rule>> = {
  opened: { path: text, branch: text, base: git, dest },
  verification: { cycle: positive, outcome: choice('proved', 'partial', 'no-op'), head: git, reason: text, open: array, report: focusEvidence, artifacts: shaped('an array of evidence paths', (value, field) => { if (!Array.isArray(value)) invalid(field, 'an array of evidence paths'); value.forEach((item, index) => focusEvidence(item, field + '.' + index)); }), dirty: bool },
  'test-cleanup': { from: git, fromTree: git, to: git, removed: array, deleted: seq, merged: seq, trees: treeMap },
  started: { task: text, candidate: git },
  conflict: { task: text, paths: array },
  done: { task: text, commit: git },
  abandoned: { task: text, candidate: git, reason: text },
  fix: { commit: git, reason: text, reviewFix },
  'deliver-started': { mode: choice('uncommitted'), dest, from: git, source: git },
  delivered: { mode: choice('uncommitted'), dest, from: git, source: git, noop: bool },
  committed: { commit: git, source: git, differing: array },
  closed: { reason: text },
};

// SECTION: Coverage decisions
const COVERAGE_SLOT = '[A-Za-z0-9_-]+\\[\\d+\\]';
/** The only summaries a `coverage:` escalation may carry: `accept: <slot>[, <slot>]*` or `grant: <reason>`. */
export function coverageDecision(summary: unknown): {accept: string[]} | {grant: string} | null {
  const text = String(summary), accept = new RegExp(`^accept: (${COVERAGE_SLOT}(?:, ${COVERAGE_SLOT})*)$`).exec(text)?.[1]?.split(', ');
  if (accept) return new Set(accept).size === accept.length ? {accept} : null;
  return /^grant: \S/.test(text) ? {grant: text.slice(7)} : null;
}

const phaseOptional = (kind: string, phase: unknown): string[] =>
  kind !== 'integrate' ? [] : phase === 'verification' ? ['report', 'artifacts', 'dirty'] : phase === 'delivered' ? ['noop'] : phase === 'committed' ? ['differing'] : phase === 'fix' ? ['reviewFix'] : [];

export function validateRecord(input: unknown, stored = false): RecordInput | LedgerRecord {
  const envelope: Record<string, Rule> = {
    kind: choice(...KINDS), by: choice('user', 'orchestrator', 'tool'),
    quote: string, key: text, data: shaped('an object', () => {}),
  };
  if (stored) {
    envelope['seq'] = launch;
    envelope['at'] = text;
    envelope['batchEndSeq'] = launch;
  }
  object(input, envelope, stored ? ['quote', 'batchEndSeq'] : ['quote', 'key'], 'record');
  const value = input as LedgerRecord;
  if (stored && value.batchEndSeq !== undefined && value.batchEndSeq < value.seq) invalid('batchEndSeq', 'a ledger seq at or after record.seq');
  let fields = shapes[value.kind];
  if (value.kind === 'writer' || value.kind === 'integrate') {
    const phases = value.kind === 'writer' ? writers : integrations;
    const phaseList = Object.keys(phases).join(', ');
    const phaseSummary = Object.entries(phases).map(([phase, pf]) => {
      const opt = phaseOptional(value.kind, phase);
      return `${phase}(${Object.keys(pf).map((k) => opt.includes(k) ? k + '?' : k).join(',')})`;
    }).join(', ');
    const phaseShape = `an object with phase: ${phaseSummary}`;
    if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) {
      invalid('data', `an object; allowed for ${value.kind}: ${phaseShape}`);
    }
    if (!Object.hasOwn(phases, value.data['phase'])) {
      invalid('data.phase', `one of ${phaseList}; allowed for ${value.kind}: ${phaseShape}`);
    }
    fields = { phase: choice(...Object.keys(phases)), ...phases[value.data['phase']] };
  }
  const optional = value.kind === 'bind' ? ['plan', 'design'] : value.kind === 'approval' ? ['design'] : value.kind==='evidence' ? ['artifacts'] : value.kind === 'focus' ? ['visual'] : value.kind === 'ruling' ? ['impact', 'trigger'] : phaseOptional(value.kind, value.data['phase']);
  const shape = describe(fields!, optional);
  try {
    object(value.data, fields!, optional);
    if (value.kind === 'bind' && !Object.hasOwn(value.data, 'plan') && !Object.hasOwn(value.data, 'design'))
      invalid('data', 'a spec and at least one plan or design');
    if (value.kind === 'integrate' && value.data['phase'] === 'verification') {
      const data = value.data;
      if (data['open'].some((item: string) => !new RegExp('^' + data['cycle'] + ':V[0-9]+$').test(item))) invalid('data.open', 'issue IDs for the verification cycle');
      if (data['outcome'] !== 'partial' && data['open'].length) invalid('data.open', 'empty for proved or no-op');
      if (data['outcome'] !== 'no-op' && !data['report']) invalid('data.report', 'required for proved or partial');
    }
    if (value.kind === 'integrate' && value.data['phase'] === 'test-cleanup') {
      const removed = value.data['removed'] as string[];
      const trees = value.data['trees'] as Record<string, string>;
      if (new Set(removed).size !== removed.length || Object.keys(trees).length !== removed.length || removed.some((id) => !Object.hasOwn(trees, id))) {
        invalid('data.trees', 'one entry per removed criterion ID');
      }
    }
    if (value.kind === 'ruling' && (value.data['subject'].startsWith('review:') || value.data['subject'].startsWith('verification:'))) {
      choice('accepted', 'rejected', 'duplicate', 'deferred')(value.data['ruling'], 'data.ruling');
    }
    if (value.kind === 'ruling' && ('impact' in value.data || 'trigger' in value.data)) {
      for (const dimension of ['impact', 'trigger']) if (!(dimension in value.data)) invalid('data.' + dimension, 'required with the other corrected dimension');
      if (!value.data['subject'].startsWith('review:') || value.data['ruling'] !== 'accepted') invalid('data.impact', 'absent unless an accepted ruling names a review finding');
    }
    if (value.kind === 'focus') choice('user', 'orchestrator')(value.by, 'record.by');
    const userOnly = ['approval', 'confirm', 'waiver', 'manual-complete'].includes(value.kind) ||
      (value.kind === 'level' && ['xhigh', 'max'].includes(value.data['level']));
    if (userOnly && (value.by !== 'user' || !value.quote?.trim())) {
      throw new ToolError(1, 'user-only', 'record requires by user and non-blank quote');
    }
    if (value.kind === 'escalation' && value.data['state'] === 'resolved' && typeof value.data['id'] === 'string' && value.data['id'].startsWith('ceiling:')) {
      const id = value.data['id'];
      if (value.by !== 'user' || !value.quote?.trim()) throw new ToolError(1, 'user-only', 'ceiling resolution requires by user and non-blank quote');
      const option = /^(re-author|model-effort|relax-split|defer):/.exec(value.data['summary']);
      if (!option) invalid('data.summary', 'one of re-author:, model-effort:, relax-split:, defer:');
      if (option[1] === 'defer') {
        const review = id.slice('ceiling:'.length, id.lastIndexOf(':'));
        if (!/^(plan|design)-/.test(review)) invalid('data.id', 'a plan or design review id for a defer resolution');
      }
    }
    if (value.kind === 'escalation' && typeof value.data['id'] === 'string' && value.data['id'].startsWith('coverage:')) {
      if (value.by !== 'user' || !value.quote?.trim()) throw new ToolError(1, 'user-only', 'coverage decision requires by user and non-blank quote');
      if (!/^coverage:[^:\s]+:[^:\s]+$/.test(value.data['id'])) invalid('data.id', 'coverage:<review>:<key>');
      if (value.data['state'] !== 'resolved') invalid('data.state', 'resolved');
      if (!coverageDecision(value.data['summary'])) invalid('data.summary', 'accept: <slot>[, <slot>]* with unique name[index] slots, or grant: <reason>');
    }
  } catch (err) {
    if (err instanceof ToolError && err.reason === 'invalid-record' && err.message.startsWith('data') && err.message !== 'data is invalid; expected ' + shape) {
      const suffix = `; allowed for ${value.kind}: ${shape}`;
      const maxHead = 1024 - Buffer.byteLength(suffix, 'utf8');
      const head = maxHead > 0 ? clipBytes(err.message, maxHead) : '';
      throw new ToolError(1, 'invalid-record', head + suffix);
    }
    throw err;
  }
  if (value.kind === 'note' && typeof value.key === 'string' && value.key.startsWith('repository-rerun:')) {
    if (value.by !== 'user' || !value.quote?.trim()) throw new ToolError(1, 'user-only', 'repository rerun requires by user and non-blank quote');
    if (!/^repository-rerun:[^:\s]+:\d+:\d+$/.test(value.key)) invalid('record.key', 'repository-rerun:<review>:<round>:<reportSeq>');
  }
  if (value.kind === 'note' && typeof value.key === 'string' && value.key.startsWith('repository-changes:')) {
    if (!/^repository-changes:[^:\s]+:\d+:\d+$/.test(value.key)) invalid('record.key', 'repository-changes:<review>:<round>:<reportSeq>');
  }
  if (!stored && ['approval', 'confirm', 'level', 'bind', 'escalation', 'edit', 'ruling', 'note', 'focus'].includes(value.kind) && value.key === undefined) {
    throw new ToolError(1, 'missing-key', 'record.key is required');
  }
  return value;
}

export function validateReviewFix(input: unknown): ReviewFix {
  reviewFix(input, 'reviewFix');
  return input as ReviewFix;
}

export function defaultKey(record: RecordInput): string {
  return 'sha256:' + crypto.createHash('sha256').update(stableValue({ kind: record.kind, data: record.data })).digest('hex');
}
