import crypto from 'node:crypto';
import { stableValue } from './domain/stable-value.ts';
import { ToolError } from './output.ts';

export const KINDS = ['bind', 'approval', 'level', 'waiver', 'manual-complete', 'escalation', 'ruling', 'note', 'edit', 'evidence', 'writer', 'integrate'] as const;
export type LedgerRecord = { seq: number; key: string; at: string; kind: string; by: string; quote?: string; data: Record<string, any> };
export type RecordInput = Omit<LedgerRecord, 'seq' | 'at' | 'key'> & { key?: string };
type Rule = (value: unknown, field: string) => void;

// Naming the expected shape lets the caller correct the record in one turn.
function invalid(field: string, expected?: string): never {
  throw new ToolError(1, 'invalid-record', field + ' is invalid' + (expected ? '; expected ' + expected : ''));
}
const text: Rule = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) invalid(field, 'a non-blank string');
};
const hash: Rule = (value, field) => {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid(field, 'sha256:<64 lowercase hex>');
};
const git: Rule = (value, field) => {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) invalid(field, 'a full 40- or 64-hex Git object id');
};
const integer: Rule = (value, field) => {
  if (!Number.isSafeInteger(value)) invalid(field, 'an integer');
};
const seq: Rule = (value, field) => {
  integer(value, field);
  if ((value as number) < 0) invalid(field, 'a non-negative integer');
};
const launch: Rule = (value, field) => {
  seq(value, field);
  if (value === 0) invalid(field, 'a positive ledger seq');
};
const choice = (...values: string[]): Rule => (value, field) => {
  if (!values.includes(value as string)) invalid(field, 'one of ' + values.join(', '));
};
const array: Rule = (value, field) => {
  if (!Array.isArray(value)) invalid(field, 'an array of strings');
  (value as unknown[]).forEach((item, index) => text(item, field + '.' + index));
};

function object(value: unknown, fields: Record<string, Rule>, optional: string[] = [], prefix = 'data'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(prefix, 'an object with ' + Object.keys(fields).join(', '));
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(fields, key)) invalid(prefix + '.' + key, 'no such field; allowed: ' + Object.keys(fields).join(', '));
  }
  for (const [key, rule] of Object.entries(fields)) {
    if (Object.hasOwn(data, key)) rule(data[key], prefix + '.' + key);
    else if (!optional.includes(key)) invalid(prefix + '.' + key, 'a required field');
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
    before: git, after: git, exit: integer, path: text, artifacts: (value,field)=>object(value,{spec:hash,plan:hash,design:hash},['design'],field),
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
const checkRows: Rule = (value, field) => {
  if(!Array.isArray(value)) invalid(field);
  for(const row of value as unknown[]) object(row,{criterion:text,commands:array,commandDigest:hash},[],field);
};
const pruning = { operation: hash, artifacts: (value:unknown,field:string)=>object(value,{spec:hash,plan:hash,design:hash},['design'],field), from:git, sourceTree:git, targets:array, pre:checkRows, final:checkRows, review:hash };
const integrations: Record<string, Record<string, Rule>> = {
  opened: { path: text, branch: text, base: git, dest },
  'prune-started': pruning,
  pruned: {...pruning,to:git,tree:git},
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
    if(value.kind==='integrate'&&['deliver-started','delivered'].includes(value.data['phase'])&&value.data['mode']==='squash')fields={phase:choice('deliver-started','delivered'),mode:choice('squash'),dest,from:git,to:git,source:git};
  }
  object(value.data, fields!, ['bind', 'approval'].includes(value.kind) ? ['design'] : value.kind==='evidence' ? ['artifacts'] : []);
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
