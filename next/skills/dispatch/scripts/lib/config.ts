// Dispatch config load and strict validation (ports legacy lib/config.mjs and lib/platform.mjs loading; ADR 0001,
// spec §14). The first existing candidate loads wholly (no merge); `config.sample.jsonc` is the validation
// reference only. Every problem names the sample so users can diff against it.

import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE_NAME = 'config.sample.jsonc';
export const CONFIG_CANDIDATES = ['config.local.jsonc', 'config.jsonc'] as const;
const HINT = `diff against ${SAMPLE_NAME}`;

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TABLES = ['read-delegates', 'write-subagents', 'phases'];
const PHASES = ['plan-review', 'code-review'];
const KNOBS = ['targets', 'rounds'];
const KNOWN = ['claude', 'agy', 'copilot', 'opencode', 'codex'];
const SANDBOXED = ['claude', 'copilot', 'opencode', 'codex'];
const ALIASES: Readonly<Record<string, string>> = {
  antigravity: 'agy', claudecode: 'claude', 'claude-code': 'claude', 'github-copilot': 'copilot', 'openai-codex': 'codex',
};

export type DispatchConfig = Record<string, unknown>;

// SECTION: JSONC

/** Strips `//` and block comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = '';
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    const next = text[index + 1];
    if (quote) {
      out += char;
      if (char === '\\') { out += next ?? ''; index++; } else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; out += char; continue; }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new SyntaxError('Unterminated block comment in JSONC');
      index = end + 1;
      continue;
    }
    if (char === ',' && closesNext(text, index + 1)) continue;
    out += char;
  }
  return out;
}

/** Whether the next significant character (skipping whitespace and comments) closes a container. */
function closesNext(text: string, from: number): boolean {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') index++;
    else if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index++; }
    else if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); index = end === -1 ? text.length : end + 2; }
    else return char === '}' || char === ']';
  }
  return false;
}

export const parseJsonc = (text: string): unknown => JSON.parse(stripJsonc(text)) as unknown;

// SECTION: Load

export type ReadFile = (file: string) => string | null;
// Only ENOENT means absent: an unreadable higher-precedence file must not silently fall through.
const readReal: ReadFile = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
};

/** Loads the first existing candidate under `skillRoot` wholly; absent optional tables become empty maps. */
export function loadConfig(skillRoot: string, read: ReadFile = readReal): { config: DispatchConfig; path: string } {
  const candidates = CONFIG_CANDIDATES.map((name) => path.join(skillRoot, name));
  for (const file of candidates) {
    const text = read(file);
    if (text === null) continue;
    const parsed = parseJsonc(text);
    const config = isRecord(parsed) ? { ...parsed, 'write-subagents': parsed['write-subagents'] ?? {}, phases: parsed['phases'] ?? {} } : {};
    if (!isRecord(parsed)) throw new Error(`${file}: config must be a JSON object (${HINT}).`);
    return { config, path: file };
  }
  throw new Error(`Config file not found: tried ${candidates.join(', ')}. Copy ${SAMPLE_NAME} to config.local.jsonc or config.jsonc.`);
}

// SECTION: Validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const canonical = (key: string): string => ALIASES[key.toLowerCase()] ?? key.toLowerCase();
const nonNegativeInt = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const goodName = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '' && !value.trim().endsWith(':');

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function checkLevelConfig(where: string, value: unknown, problems: string[]): void {
  if (!isRecord(value)) { problems.push(`${where} must be an object with model and optional effort (${HINT}).`); return; }
  for (const key of Object.keys(value)) {
    if (key !== 'model' && key !== 'effort') problems.push(`${where} has unrecognized key "${key}". Valid keys: model, effort (${HINT}).`);
  }
  const model = value['model'];
  if (model === undefined) problems.push(`${where}.model is required (${HINT}).`);
  else if (!(goodName(model) || (Array.isArray(model) && model.length > 0 && model.every(goodName)))) {
    problems.push(`${where}.model must be a nonblank string or non-empty array of nonblank strings (${HINT}).`);
  } else if (Array.isArray(model)) {
    const dup = model.find((item, index) => model.indexOf(item) !== index);
    if (dup !== undefined) problems.push(`${where}.model has duplicate alias "${String(dup)}" (${HINT}).`);
  }
  if ('effort' in value && !goodName(value['effort'])) problems.push(`${where}.effort must be a string and not blank; omit it for the provider default (${HINT}).`);
}

function checkLevelMap(where: string, value: unknown, problems: string[]): void {
  if (!isRecord(value)) { problems.push(`${where} must be an object keyed by level (${HINT}).`); return; }
  if (!Object.keys(value).length) problems.push(`${where} must define at least one level (${HINT}).`);
  for (const [key, entry] of Object.entries(value)) {
    if (!LEVELS.includes(key)) problems.push(`${where} has unrecognized key "${key}". Valid keys: ${LEVELS.join(', ')} (${HINT}).`);
    else checkLevelConfig(`${where}.${key}`, entry, problems);
  }
}

function checkReadProvider(where: string, value: unknown, provider: string, problems: string[]): void {
  const sandboxed = SANDBOXED.includes(provider);
  const valid = sandboxed ? 'sandbox, nativeSubagentsOnly, targets' : 'nativeSubagentsOnly, targets';
  if (!isRecord(value)) { problems.push(`${where} must be an object with keys ${valid} (${HINT}).`); return; }
  for (const [key, field] of Object.entries(value)) {
    if (key === 'targets') continue;
    if (key === 'nativeSubagentsOnly' || (key === 'sandbox' && sandboxed)) {
      if (typeof field !== 'boolean') problems.push(`${where}.${key} must be a boolean (${HINT}).`);
    } else if (key === 'sandbox') problems.push(`${where}.sandbox is not supported for ${provider}; remove it (${HINT}).`);
    else problems.push(`${where} has unrecognized key "${key}". Valid keys: ${valid} (${HINT}).`);
  }
  const targets = value['targets'];
  if (!Array.isArray(targets) || !targets.length) { problems.push(`${where}.targets must be a non-empty array of level maps (${HINT}).`); return; }
  const seen = new Map<string, number>();
  targets.forEach((target: unknown, index) => {
    checkLevelMap(`${where}.targets[${index}]`, target, problems);
    if (!isRecord(target)) return;
    const key = sortedJson(target);
    const first = seen.get(key);
    if (first !== undefined) problems.push(`${where}.targets[${index}] duplicates targets[${first}] (${HINT}).`);
    else seen.set(key, index);
    // A native subagent launch has no CLI default effort to fall back on.
    if (value['nativeSubagentsOnly'] !== true) return;
    for (const [level, entry] of Object.entries(target)) {
      if (LEVELS.includes(level) && isRecord(entry) && entry['effort'] === undefined) {
        problems.push(`${where}.targets[${index}].${level}.effort is required when nativeSubagentsOnly is true (${HINT}).`);
      }
    }
  });
}

function checkPlatformTable(table: string, value: unknown, problems: string[], one: (where: string, entry: unknown, provider: string) => void): string[] {
  if (!isRecord(value)) { problems.push(`"${table}" must be an object mapping platform key to settings (${HINT}).`); return []; }
  const seen = new Map<string, string>();
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'all') { problems.push(`${table} cannot use reserved pin keyword "all" as a platform key (${HINT}).`); continue; }
    const provider = canonical(key);
    if (!KNOWN.includes(provider)) { problems.push(`${table}: unknown platform "${key}" (expected ${KNOWN.join(', ')}).`); continue; }
    const prior = seen.get(provider);
    if (prior !== undefined) { problems.push(`${table}: duplicate platform "${provider}" (keys "${prior}" and "${key}" normalize to the same provider).`); continue; }
    seen.set(provider, key);
    one(`${table}.${key}`, entry, provider);
  }
  return [...seen.keys()];
}

function checkPhases(value: unknown, readKeys: readonly string[], problems: string[]): void {
  if (!isRecord(value)) { problems.push(`"phases" must be an object keyed by review phase (${HINT}).`); return; }
  for (const [phase, policy] of Object.entries(value)) {
    const where = `phases.${phase}`;
    if (!PHASES.includes(phase)) { problems.push(`phases has unrecognized phase "${phase}". Valid phases: ${PHASES.join(', ')} (${HINT}).`); continue; }
    if (!isRecord(policy)) { problems.push(`${where} must be an object (${HINT}).`); continue; }
    for (const key of Object.keys(policy)) {
      if (![...KNOBS, 'only'].includes(key)) problems.push(`${where} has unrecognized key "${key}". Valid keys: ${[...KNOBS, 'only'].join(', ')} (${HINT}).`);
    }
    for (const knob of KNOBS) {
      const map = policy[knob];
      if (map === undefined) { problems.push(`${where} is missing required knob "${knob}" (${HINT}).`); continue; }
      if (!isRecord(map) || !Object.keys(map).length) { problems.push(`${where}.${knob} must be a non-empty object keyed by level (${HINT}).`); continue; }
      for (const [level, entry] of Object.entries(map)) {
        if (!LEVELS.includes(level)) problems.push(`${where}.${knob} has unrecognized level "${level}". Valid levels: ${LEVELS.join(', ')} (${HINT}).`);
        else if (knob === 'rounds' ? !nonNegativeInt(entry) : entry !== 'all' && !nonNegativeInt(entry)) {
          problems.push(`${where}.${knob}.${level} must be a non-negative integer${knob === 'targets' ? ' or "all"' : ''} (${HINT}).`);
        }
      }
    }
    const only = policy['only'];
    if (only === undefined) continue;
    if (!Array.isArray(only) || !only.length || only.some((key) => typeof key !== 'string')) {
      problems.push(`${where}.only must be a non-empty array of read-delegates platform keys (${HINT}).`);
      continue;
    }
    const missing = (only as string[]).filter((key) => !readKeys.includes(canonical(key)));
    if (missing.length) problems.push(`${where}.only names platform(s) not in read-delegates: ${missing.join(', ')} (configured: ${readKeys.join(', ') || 'none'}).`);
  }
}

/** Every schema problem in one pass; empty when valid. */
export function validateConfig(config: unknown): string[] {
  if (!isRecord(config)) return [`Config must be a JSON object with tables: ${TABLES.join(', ')} (${HINT}).`];
  const problems: string[] = [];
  for (const key of Object.keys(config)) {
    if (!TABLES.includes(key)) problems.push(`Unrecognized top-level key "${key}". Valid tables: ${TABLES.join(', ')} (${HINT}).`);
  }
  let readKeys: string[] = [];
  const read = config['read-delegates'];
  if (read === undefined) problems.push(`Missing required table "read-delegates" (${HINT}).`);
  else {
    readKeys = checkPlatformTable('read-delegates', read, problems, (where, entry, provider) => checkReadProvider(where, entry, provider, problems));
    if (isRecord(read) && !Object.keys(read).length) problems.push(`read-delegates must define at least one platform (${HINT}).`);
  }
  const write = config['write-subagents'];
  if (write !== undefined) checkPlatformTable('write-subagents', write, problems, (where, entry) => checkLevelMap(where, entry, problems));
  if (config['phases'] !== undefined) checkPhases(config['phases'], readKeys, problems);
  return problems;
}
