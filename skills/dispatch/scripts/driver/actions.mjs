// @ts-check
/**
 * Driver action set (R3): the closed, versioned actions the driver emits, their reply schemas,
 * a small JSON-schema subset validator, and the sanitizer applied to reply text before any
 * artifact write.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SECTION: Action contracts

const SCHEMA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'references', 'templates', 'schemas', 'driver',
);

/** Read-only native agent type per platform for `native-fallback` descriptors. */
export const NATIVE_AGENT_TYPES = Object.freeze({ claude: 'explore', agy: 'research', copilot: 'explore', opencode: 'explore' });

export const ACTIONS = Object.freeze([
  'ask-user', 'author', 'launch', 'native-fallback', 'adjudicate', 'apply-fixes', 'delegate-write', 'verify', 'done',
]);

const schemaCache = new Map();

/** Loads `<name>.json` from the driver schema directory (`<action>` or `<action>.reply`). */
export function loadSchema(name) {
  if (!/^[a-z-]+(?:\.reply)?$/.test(name) || !ACTIONS.includes(name.replace(/\.reply$/, ''))) {
    throw new Error(`Unknown driver schema "${name}".`);
  }
  if (!schemaCache.has(name)) {
    schemaCache.set(name, JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.json`), 'utf8')));
  }
  return structuredClone(schemaCache.get(name));
}

// SECTION: subset validator (type, required, properties, additionalProperties, enum, items, const,
// minLength, minItems, uniqueItems, pattern, anyOf, oneOf, allOf, if/then).

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  return typeOf(value) === type;
}

/** Returns a list of readable violations; empty when `value` satisfies `schema`. */
export function validateAgainstSchema(schema, value, where = '$') {
  const errors = [];
  if (schema.allOf) for (const sub of schema.allOf) errors.push(...validateAgainstSchema(sub, value, where));
  if (schema.if && validateAgainstSchema(schema.if, value, where).length === 0 && schema.then) errors.push(...validateAgainstSchema(schema.then, value, where));
  if (schema.oneOf && schema.oneOf.filter((sub) => validateAgainstSchema(sub, value, where).length === 0).length !== 1) errors.push(`${where} must match exactly one allowed shape`);
  if (schema.anyOf) {
    if (!schema.anyOf.some((sub) => validateAgainstSchema(sub, value, where).length === 0)) {
      errors.push(`${where} matches none of the allowed shapes`);
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${where} must be ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} must be at least ${schema.minimum}`);
  if (typeof value === 'string' && schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${where} must match ${schema.pattern}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where} must be one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${where} must be ${types.join(' or ')}`);
      return errors;
    }
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.trim().length < schema.minLength) {
    errors.push(`${where} must be a non-empty string`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where} needs at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${where} items must be unique`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateAgainstSchema(schema.items, item, `${where}[${index}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${where}.${key} is required`);
    }
    for (const [key, sub] of Object.entries(value)) {
      const known = schema.properties?.[key];
      if (known) errors.push(...validateAgainstSchema(known, sub, `${where}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${where}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(schema.additionalProperties, sub, `${where}.${key}`));
      }
    }
  }
  return errors;
}

/** Validates an agent reply for `action`; `done` is terminal and takes none. */
export function validateReply(action, reply) {
  if (!ACTIONS.includes(action) || action === 'done') throw new Error(`Action "${action}" takes no reply.`);
  const errors = validateAgainstSchema(loadSchema(`${action}.reply`), reply === undefined ? null : reply);
  if (action === 'delegate-write' && reply && typeof reply === 'object') {
    const forms = ['envelopePath', 'rejected', 'failed'].filter(key => Object.hasOwn(reply, key));
    if (forms.length !== 1) errors.push('delegate-write reply must contain exactly one outcome form');
    if (reply.reason !== undefined && reply.rejected !== true) errors.push('reason belongs only to launch rejection');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: reply ?? null };
}

/** Builds one action object; payload keys follow the fixed envelope keys. */
export function emitAction(state, action, payload = {}, guidance = []) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown driver action "${action}".`);
  const envelope = { ...payload, v: 1, action, stateFile: state.stateFile, guidance: [...guidance] };
  const errors = validateAgainstSchema(loadSchema(action), envelope);
  if (errors.length) throw new Error(`Invalid ${action} action: ${errors.join('; ')}`);
  return envelope;
}

// SECTION: sanitization

const TOOL_CALL_LINE = /^\s*(?:<\/?(?:invoke|parameter|function_calls|tool_use)\b|(?:invoke|parameter|function_calls|tool_use)\s*\(|[A-Z][A-Za-z]*\(.*\)\s*$|\$\s|>\s*\$)/;

/**
 * Defense in depth for agent-restated text: drops fenced blocks and tool-invocation lines, strips
 * inline-code delimiters (keeping their contents), and collapses the rest to one line for the resolution log.
 */
export function sanitizeReplyText(text) {
  const kept = [];
  let fence = null;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence || TOOL_CALL_LINE.test(line)) continue;
    // Tool markup embedded mid-line is cut from its opening tag onward.
    kept.push(line.replace(/<\/?(?:invoke|parameter|function_calls|tool_use)\b.*$/, ''));
  }
  // Keep code-span contents (identifiers, paths); drop only the delimiters.
  return kept.join(' ').replace(/`/g, '').replace(/→/g, '->').replace(/\s+/g, ' ').trim();
}
