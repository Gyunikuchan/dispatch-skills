import crypto from 'node:crypto';
import { stableValue } from './domain/stable-value.ts';
import { ToolError } from './output.ts';

export const KINDS = ['bind', 'approval', 'level', 'waiver', 'manual-complete', 'escalation', 'ruling', 'note', 'edit', 'evidence', 'writer', 'integrate'] as const;
export type LedgerRecord = { seq: number; key: string; at: string; kind: string; by: string; quote?: string; data: Record<string, any> };
export type RecordInput = Omit<LedgerRecord, 'seq' | 'at' | 'key'> & { key?: string };
type Rule = (value: unknown, field: string) => void;

function invalid(field: string): never {
  throw new ToolError(1, 'invalid-record', field + ' is invalid');
}
const text: Rule = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) invalid(field);
};
const hash: Rule = (value, field) => {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid(field);
};
const git: Rule = (value, field) => {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) invalid(field);
};
const integer: Rule = (value, field) => {
  if (!Number.isSafeInteger(value)) invalid(field);
};
const seq: Rule = (value, field) => {
  integer(value, field);
  if ((value as number) < 0) invalid(field);
};
const launch: Rule = (value, field) => {
  seq(value, field);
  if (value === 0) invalid(field);
};
const choice = (...values: string[]): Rule => (value, field) => {
  if (!values.includes(value as string)) invalid(field);
};
const array: Rule = (value, field) => {
  if (!Array.isArray(value)) invalid(field);
  (value as unknown[]).forEach((item, index) => text(item, field + '.' + index));
};

function object(value: unknown, fields: Record<string, Rule>, optional: string[] = [], prefix = 'data'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(prefix);
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(fields, key)) invalid(prefix + '.' + key);
  }
  for (const [key, rule] of Object.entries(fields)) {
    if (Object.hasOwn(data, key)) rule(data[key], prefix + '.' + key);
    else if (!optional.includes(key)) invalid(prefix + '.' + key);
  }
}

const dest: Rule = (value, field) => object(value, { branch: text, path: text }, [], field);
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
    criterion: text, commandDigest: hash, tree: git,
    clean: (value, field) => { if (typeof value !== 'boolean') invalid(field); },
    before: git, after: git, exit: integer, path: text,
  },
};
const writers: Record<string, Record<string, Rule>> = {
  launched: {
    task: text, path: text,
    base: (value, field) => object(value, { commit: git, taskSection: hash, seq }, [], field),
  },
  finished: { task: text, launch, candidate: git },
  abandoned: { task: text, launch, reason: text },
};
const integrations: Record<string, Record<string, Rule>> = {
  opened: { path: text, branch: text, base: git, dest },
  started: { task: text, candidate: git },
  conflict: { task: text, paths: array },
  done: { task: text, commit: git },
  abandoned: { task: text, candidate: git, reason: text },
  fix: { commit: git, reason: text },
  'deliver-started': { dest, from: git, to: git },
  delivered: { dest, to: git },
  closed: { reason: text },
};

export function validateRecord(input: unknown, stored = false): RecordInput | LedgerRecord {
  const envelope: Record<string, Rule> = {
    kind: choice(...KINDS), by: choice('user', 'orchestrator', 'tool'),
    quote: (value, field) => { if (typeof value !== 'string') invalid(field); }, key: text, data: () => {},
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
    if (!value.data || !Object.hasOwn(phases, value.data['phase'])) invalid('data.phase');
    fields = { phase: choice(...Object.keys(phases)), ...phases[value.data['phase']] };
  }
  object(value.data, fields!, ['bind', 'approval'].includes(value.kind) ? ['design'] : []);
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
