// `check-envelope`: parse the strict write receipt and compare the real Git diff with stage-approved paths.

import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler, WriteEnvelope, Ports } from '../core/types.ts';
import type { Git } from './git.ts';

type CheckEffect = Extract<Effect, { kind: 'check-envelope' }> & { since?: Readonly<Record<string, unknown>> };
export type CheckEnvelopeDeps = { cwd: string; git: Git };

/** Dirty-path contents and index entries distinguish caller dirt from subsequent writer edits. */
export async function pathHashes(deps: CheckEnvelopeDeps, ports: Ports): Promise<Record<string, string>> {
  const files = await deps.git.diffNames(deps.cwd, '');
  const entries = new Map<string, string[]>();
  for (const entry of (await deps.git.indexEntries(deps.cwd)).split(/\r?\n/)) {
    const file = entry.slice(entry.indexOf('\t') + 1);
    entries.set(file, [...(entries.get(file) ?? []), entry]);
  }
  const links = new Map<string, string>();
  const existing = files.filter((file) => {
    let current = deps.cwd;
    for (const part of file.split('/').slice(0, -1)) { current = path.join(current, part); if (ports.fs.inspectPath(current)?.kind === 'symlink') throw new Error(`Path snapshot ancestor escape: ${file}`); }
    const absolute = path.resolve(deps.cwd, file), info = ports.fs.inspectPath(absolute);
    if (info?.kind === 'symlink') { links.set(file, crypto.createHash('sha256').update(info.linkTarget ?? '').digest('hex')); return false; }
    return info?.kind === 'file';
  });
  const hashes: string[] = [];
  let batch: string[] = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    hashes.push(...(await ports.git.run(['hash-object', '--', ...batch], deps.cwd)).trim().split(/\r?\n/));
    batch = []; size = 0;
  };
  for (const file of existing) {
    const cost = file.length * 2 + 4;
    if (size + cost > 16000) await flush();
    batch.push(file); size += cost;
  }
  await flush();
  if (hashes.length !== existing.length || hashes.some((hash) => !/^[a-f0-9]{40,64}$/.test(hash))) throw new Error('Path snapshot lacks Git blob hashes.');
  const blobs = new Map(existing.map((file, index) => [file, hashes[index]]));
  return Object.fromEntries(files.map((file) => {
    const content = links.get(file) ?? blobs.get(file) ?? '<deleted>';
    const index = (entries.get(file) ?? []).join('\n');
    return [file, crypto.createHash('sha256').update(JSON.stringify([content, index])).digest('hex')];
  }));
}

export function changedPaths(since: unknown, current: Record<string, string>): string[] {
  if (!isRecord(since) || !isRecord(since['pathHashes'])) return Object.keys(current).sort();
  const previous = since['pathHashes'];
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter((file) => previous[file] !== current[file]).sort();
}

type ParsedEnvelope = {
  schemaVersion: 1;
  status: 'DONE' | 'DONE_WITH_CONCERNS' | 'NEEDS_CONTEXT' | 'BLOCKED';
  stage: 'RED_READY' | 'COMPLETE';
  summary: string;
  evidence: string[];
  concerns?: string[];
  missingContext?: string[];
  blockers?: string[];
  files?: { path: string; note: string }[];
};

const STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] as const;
const TOP_FIELDS = new Set(['schemaVersion', 'status', 'stage', 'summary', 'evidence', 'concerns', 'missingContext', 'blockers', 'files']);
const REPO_PATH = /^(?!\/)(?![A-Za-z]:)(?!\.\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\x00-\x1f\x7f\\]).+$/;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|[._-](?:test|spec)s?\.[^/]+$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const QUOTE = String.fromCharCode(34);

/** Called only after JSON.parse succeeds; detects duplicate decoded keys before schema validation. */
function duplicateKey(source: string): string | null {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(source[cursor] ?? '')) cursor++; };
  const readString = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === '\\') cursor++;
      else if (char === QUOTE) break;
    }
    return JSON.parse(source.slice(start, cursor)) as string;
  };
  const readValue = (): string | null => {
    whitespace();
    const char = source[cursor];
    if (char === QUOTE) { readString(); return null; }
    if (char === '{') {
      cursor++;
      const seen = new Set<string>();
      whitespace();
      while (source[cursor] !== '}') {
        whitespace();
        if (source[cursor] !== QUOTE) return null;
        const key = readString();
        if (seen.has(key)) return key;
        seen.add(key);
        whitespace(); cursor++;
        const nested = readValue();
        if (nested) return nested;
        whitespace();
        if (source[cursor] === ',') cursor++; else break;
      }
      cursor++;
      return null;
    }
    if (char === '[') {
      cursor++;
      whitespace();
      while (source[cursor] !== ']') {
        const nested = readValue();
        if (nested) return nested;
        whitespace();
        if (source[cursor] === ',') cursor++; else break;
      }
      cursor++;
      return null;
    }
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor] ?? '')) cursor++;
    return null;
  };
  return readValue();
}

function stringArray(value: unknown, field: string, required: boolean, defects: string[]): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !nonEmpty(entry))) { defects.push(`${field} must be an array of non-empty strings.`); return undefined; }
  if (required && !value.length) defects.push(`${field} must contain at least one item.`);
  return value as string[];
}

function parseEnvelope(value: unknown): { envelope: ParsedEnvelope | null; defects: string[] } {
  const defects: string[] = [];
  if (!isRecord(value)) return { envelope: null, defects: ['Envelope must be a JSON object.'] };
  const unknown = Object.keys(value).find((key) => !TOP_FIELDS.has(key));
  if (unknown) defects.push(`Envelope has unknown field ${unknown}.`);
  if (value['schemaVersion'] !== 1) defects.push('schemaVersion must be 1.');
  if (!STATUSES.includes(value['status'] as typeof STATUSES[number])) defects.push(`Unknown status ${String(value['status'])}.`);
  if (value['stage'] !== 'RED_READY' && value['stage'] !== 'COMPLETE') defects.push(`Unknown stage ${String(value['stage'])}.`);
  if (value['stage'] === 'RED_READY' && value['status'] !== 'DONE' && value['status'] !== 'DONE_WITH_CONCERNS') defects.push(`RED_READY is not valid with status ${String(value['status'])}.`);
  if (!nonEmpty(value['summary'])) defects.push('summary must be a non-empty string.');
  const terminal = value['status'] === 'DONE' || value['status'] === 'DONE_WITH_CONCERNS';
  const evidence = stringArray(value['evidence'], 'evidence', terminal, defects) ?? [];
  const concerns = stringArray(value['concerns'], 'concerns', value['status'] === 'DONE_WITH_CONCERNS', defects);
  const missingContext = stringArray(value['missingContext'], 'missingContext', value['status'] === 'NEEDS_CONTEXT', defects);
  const blockers = stringArray(value['blockers'], 'blockers', value['status'] === 'BLOCKED', defects);
  for (const [field, fieldValue] of [['concerns', concerns], ['missingContext', missingContext], ['blockers', blockers]] as const) {
    const applicable = (value['status'] === 'DONE_WITH_CONCERNS' && field === 'concerns') || (value['status'] === 'NEEDS_CONTEXT' && field === 'missingContext') || (value['status'] === 'BLOCKED' && field === 'blockers');
    if (!applicable && fieldValue?.length) defects.push(`${field} must be omitted or empty for status ${String(value['status'])}.`);
  }
  let files: ParsedEnvelope['files'];
  if (value['files'] !== undefined) {
    if (!Array.isArray(value['files'])) defects.push('files must be an array.');
    else {
      files = [];
      value['files'].forEach((item, index) => {
        if (!isRecord(item)) { defects.push(`files[${index}] must be an object.`); return; }
        const extra = Object.keys(item).find((key) => key !== 'path' && key !== 'note');
        if (extra) defects.push(`files[${index}] has unknown field ${extra}.`);
        if (!nonEmpty(item['path']) || !REPO_PATH.test(item['path'])) defects.push(`files[${index}].path must be repository-relative with slash separators.`);
        if (!nonEmpty(item['note'])) defects.push(`files[${index}].note must be a non-empty clause.`);
        if (nonEmpty(item['path']) && nonEmpty(item['note'])) files?.push({ path: item['path'], note: item['note'] });
      });
    }
  }
  if (defects.length) return { envelope: null, defects };
  const envelope: ParsedEnvelope = {
    schemaVersion: 1, status: value['status'] as ParsedEnvelope['status'], stage: value['stage'] as ParsedEnvelope['stage'],
    summary: value['summary'] as string, evidence,
    ...(concerns ? { concerns } : {}), ...(missingContext ? { missingContext } : {}), ...(blockers ? { blockers } : {}), ...(files ? { files } : {}),
  };
  return { envelope, defects };
}

function cleanRepoPath(value: string): string | null {
  if (!REPO_PATH.test(value)) return null;
  const normalized = value.split('/').filter((part) => part && part !== '.').join('/');
  return normalized || null;
}

export function createCheckEnvelope(base: CheckEnvelopeDeps): Handler<CheckEffect> {
  return async (effect, ports) => {
    const deps = effect.cwd ? { ...base, cwd: effect.cwd } : base;
    const defects: string[] = [];
    let envelope: ParsedEnvelope | null = null;
    let testsOnly = false;
    if (!ports.fs.exists(effect.envelopePath)) defects.push(`Expected envelope file is missing: ${effect.envelopePath}`);
    else {
      try {
        const source = ports.fs.readText(effect.envelopePath);
        const parsed = JSON.parse(source) as unknown;
        testsOnly = isRecord(parsed) && parsed['stage'] === 'RED_READY';
        const duplicate = duplicateKey(source);
        if (duplicate) defects.push(`Envelope has duplicate key ${duplicate}.`);
        const checked = parseEnvelope(parsed);
        envelope = checked.envelope;
        defects.push(...checked.defects);
      } catch (error) {
        defects.push(`Expected envelope file is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let paths: string[] = [];
    try { paths = changedPaths(effect.since, await pathHashes(deps, ports)); } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `diff: ${error instanceof Error ? error.message : String(error)}` }];
    }
    const allowed = new Set(effect.permitted.map((file) => cleanRepoPath(file)).filter((file): file is string => file !== null));
    if (allowed.size !== effect.permitted.length) defects.push('Permitted paths must be unique repository-relative slash paths.');
    const changed = [...new Set(paths.map((file) => cleanRepoPath(file) ?? file))].sort();
    const outside = changed.filter((file) => !allowed.has(file));
    if (outside.length && testsOnly) defects.push(`Tests-only writer changed paths outside the approved scope: ${outside.join(', ')}.`);
    if (testsOnly && effect.permitted.some((file) => !TEST_PATH.test(file))) defects.push('RED_READY envelopes require a tests-only permitted path set.');
    if (envelope?.files) for (const file of envelope.files) {
      const normalized = cleanRepoPath(file.path);
      if (normalized === null || envelope.stage === 'RED_READY' && !allowed.has(normalized)) defects.push(`Envelope files path is outside the approved scope: ${file.path}.`);
    }
    return [{ type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: envelope as WriteEnvelope | null, defects: [...new Set(defects)], diff: { paths: changed, ...(outside.length ? { outside } : {}) } }];
  };
}
