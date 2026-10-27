import crypto from 'node:crypto';
import { stableValue } from './domain/stable-value.ts';
import { ToolError } from './output.ts';

export const KINDS = ['bind', 'approval', 'level', 'waiver', 'manual-complete', 'escalation', 'ruling', 'note', 'edit', 'evidence', 'writer', 'integrate'] as const;
export type LedgerRecord = { seq: number; key: string; at: string; kind: string; by: string; quote?: string; data: Record<string, any> };
export type RecordInput = Omit<LedgerRecord, 'seq' | 'at' | 'key'> & { key?: string };
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
const choice = (...values: string[]): Rule => check('one of ' + values.join(', '), (value) => values.includes(value as string));
const array: Rule = shaped('an array of non-blank strings', (value, field) => {
  if (!Array.isArray(value)) invalid(field, shapeOf(array));
  (value as unknown[]).forEach((item, index) => text(item, field + '.' + index));
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
const shapes: Record<string, Record<string, Rule>> = {
  bind: { spec: text, plan: text, design: text },
  approval: { spec: hash, plan: hash, design: hash },
  level: { level: choice('low', 'medium', 'high', 'xhigh', 'max') },
  waiver: { criterion: text, reason: text },
  'manual-complete': { criterion: text, evidence: text },
  escalation: { id: text, state: choice('open', 'resolved'), summary: text },
  ruling: { subject: text, ruling: text, rationale: text },
  note: { text },
  edit: {
    artifact: choice('spec', 'plan', 'design'), before: hash, after: hash,
    class: choice('non-intent', 'intent', 'dependency', 'discard'), affects: array, rationale: text, diffRef: text,
  },
  evidence: {
    criterion: text, commandDigest: hash, tree: git, clean: bool,
    before: git, after: git, exit: integer, path: text, artifacts,
  },
};
const writers: Record<string, Record<string, Rule>> = {
  launched: { task: text, path: text, base: nested({ commit: git, taskSection: hash, seq }) },
  finished: { task: text, launch, candidate: git },
  abandoned: { task: text, launch, reason: text },
};
const checkRow = { criterion: text, commands: array, commandDigest: hash };
const checkRows: Rule = shaped('an array of ' + describe(checkRow), (value, field) => {
  if (!Array.isArray(value)) invalid(field, shapeOf(checkRows));
  for (const row of value as unknown[]) object(row, checkRow, [], field);
});
const pruning = { operation: hash, artifacts, from:git, sourceTree:git, targets:array, pre:checkRows, final:checkRows, review:hash };
const integrations: Record<string, Record<string, Rule>> = {
  opened: { path: text, branch: text, base: git, dest },
  'prune-started': pruning,
  pruned: {...pruning,to:git,tree:git},
  started: { task: text, candidate: git },
  conflict: { task: text, paths: array },
  done: { task: text, commit: git },
  abandoned: { task: text, candidate: git, reason: text },
  fix: { commit: git, reason: text },
  'deliver-started': { mode: choice('uncommitted'), dest, from: git, source: git },
  delivered: { mode: choice('uncommitted'), dest, from: git, source: git, noop: bool },
  closed: { reason: text },
};

export function validateRecord(input: unknown, stored = false): RecordInput | LedgerRecord {
  const envelope: Record<string, Rule> = {
    kind: choice(...KINDS), by: choice('user', 'orchestrator', 'tool'),
    quote: string, key: text, data: shaped('an object', () => {}),
  };
  if (stored) {
    envelope['seq'] = launch;
    envelope['at'] = text;
  }
  object(input, envelope, stored ? ['quote'] : ['quote', 'key'], 'record');
  const value = input as LedgerRecord;
  let fields = shapes[value.kind];
  if (value.kind === 'writer' || value.kind === 'integrate') {
    const phases = value.kind === 'writer' ? writers : integrations;
    if (!value.data || !Object.hasOwn(phases, value.data['phase'])) invalid('data.phase', 'one of ' + Object.keys(phases).join(', '));
    fields = { phase: choice(...Object.keys(phases)), ...phases[value.data['phase']] };
  }
  const optional = ['bind', 'approval'].includes(value.kind) ? ['design'] : value.kind==='evidence' ? ['artifacts'] : value.kind==='integrate' && value.data['phase']==='delivered' ? ['noop'] : [];
  object(value.data, fields!, optional);
  if (value.kind === 'ruling' && value.data['subject'].startsWith('review:')) {
    choice('accepted', 'rejected', 'duplicate', 'deferred')(value.data['ruling'], 'data.ruling');
  }
  const userOnly = ['approval', 'waiver', 'manual-complete'].includes(value.kind) ||
    (value.kind === 'level' && ['xhigh', 'max'].includes(value.data['level']));
  if (userOnly && (value.by !== 'user' || !value.quote?.trim())) {
    throw new ToolError(1, 'user-only', 'record requires by user and non-blank quote');
  }
  if (!stored && ['approval', 'level', 'bind', 'escalation', 'edit', 'ruling', 'note'].includes(value.kind) && value.key === undefined) {
    throw new ToolError(1, 'missing-key', 'record.key is required');
  }
  return value;
}

export function defaultKey(record: RecordInput): string {
  return 'sha256:' + crypto.createHash('sha256').update(stableValue({ kind: record.kind, data: record.data })).digest('hex');
}
