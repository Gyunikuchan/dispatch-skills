// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  extractApprovedPathSet,
  normalizePlanPath,
  structuralLines,
} from '../plan/structure.mjs';

export { extractApprovedPathSet };

export function criterionMappings(source) {
  const lines = structuralLines(source);
  const mappings = [];
  let inCriteria = false;
  let current = null;
  for (const { text } of lines) {
    if (/^##\s+/.test(text)) { inCriteria = /^## Success Criteria\s*$/.test(text); current = null; continue; }
    if (!inCriteria) continue;
    const criterion = /^(?:[-*+]|\d+[.)])\s+\[(SC[1-9]\d*)\]\s*(.*)$/.exec(text);
    if (criterion) {
      current = { id: criterion[1], title: criterion[2], text: criterion[2], paths: [], commands: [], evidence: null, testRationale: null, review: null, enforcementRationale: null, preExisting: false };
      mappings.push(current);
      continue;
    }
    if (!current) continue;
    const changes = /^ {2,}[-*+] Changes:\s*(.+)$/.exec(text); if (changes) current.paths = changes[1].split(',').map(value => normalizePlanPath(value).path);
    const verify = /^ {2,}[-*+] Verify:\s*`([^`]+)`\s*$/.exec(text); if (verify) current.commands.push(verify[1].trim());
    const evidence = /^ {2,}[-*+] Evidence:\s*(\S+)\s*$/.exec(text); if (evidence) current.evidence = evidence[1].toLowerCase();
    const preExisting = /^ {2,}[-*+] Pre-existing:\s*(yes|no)\s*$/i.exec(text); if (preExisting) current.preExisting = preExisting[1].toLowerCase() === 'yes';
    const rationale = /^ {2,}[-*+] Test rationale:\s*(.+)$/.exec(text); if (rationale) current.testRationale = rationale[1].trim();
    const review = /^ {2,}[-*+] Review:\s*(.+)$/.exec(text); if (review) current.review = review[1].trim();
    const enforcement = /^ {2,}[-*+] Enforcement infeasibility:\s*(.+)$/.exec(text); if (enforcement) current.enforcementRationale = enforcement[1].trim();
  }
  return mappings;
}

// Plan-review findings are already folded into the plan; the writer needs only their headlines.
const DIGEST_ENTRY_CHARS = 240;
const DIGEST_TOTAL_CHARS = 4000;
export function findingDigest(log) {
  const entries = log.split('\n').filter(line => /^[-*]\s+\*\*\[/.test(line) && !/^[-*]\s+\*\*Sources:\*\*/.test(line))
    .map(line => (line.length > DIGEST_ENTRY_CHARS ? `${line.slice(0, DIGEST_ENTRY_CHARS - 1)}…` : line));
  if (!entries.length) return log.slice(0, DIGEST_TOTAL_CHARS);
  const kept = [];
  let size = 0;
  for (const entry of entries) {
    if (size + entry.length + 1 > DIGEST_TOTAL_CHARS) break;
    kept.push(entry);
    size += entry.length + 1;
  }
  const omitted = entries.length - kept.length;
  return [...kept, ...(omitted ? [`… ${omitted} more in the governing plan's Review Findings & Resolutions.`] : [])].join('\n');
}

export function outcomeFirstPacket(source, criteria) {
  const lines = structuralLines(source);
  const titleIndex = lines.findIndex(({ text }) => /^#\s+/.test(text));
  const title = lines[titleIndex]?.text.replace(/^#\s+/, '').trim() ?? '';
  const sections = new Map();
  let heading = 'preamble';
  for (const { text } of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(text);
    if (match) { heading = match[1]; sections.set(heading, []); continue; }
    if (text.trim() && sections.has(heading)) sections.get(heading).push(text.trim());
  }
  const section = name => (sections.get(name) ?? []).join('\n').trim();
  const proposed = section('Proposed Changes');
  const invariants = proposed.split('\n').filter(line => /(?:^|[-*])\s*Invariants?:/i.test(line));
  const constraints = [section('Key Decisions & Context'), section('Open Questions & Assumptions')].filter(Boolean);
  const failures = section('Review Findings & Resolutions');
  return {
    governingOutcome: { title, context: section('Context & Intent') || lines.slice(titleIndex + 1).map(item => item.text.trim()).filter(Boolean).find(text => !/^##/.test(text)) || title },
    settledBoundary: { scope: proposed, nonScope: section('Out of Scope') || 'None.', invariants, rollback: section('Rollback & Blast Radius') || 'None.' },
    criteria: criteria.map(({ id, title: outcome, evidence, paths, commands, review }) => ({ id, outcome, evidenceClass: evidence, paths, commands, review: review ?? null })),
    repositoryContext: { constraints, priorFailures: failures && !/No reviews conducted yet/i.test(failures) ? findingDigest(failures) : 'None recorded.' },
    testsAsEvidence: { label: 'evidence, not specification', commands: [...new Set(criteria.flatMap(item => item.commands))] },
  };
}

export function mapVerificationCommandsToPaths(source, commands, approvedPaths = extractApprovedPathSet(source)) {
  const lines = structuralLines(source);
  const mappings = [];
  let inCriteria = false;
  let current = null;
  for (const { text } of lines) {
    if (/^##\s+/.test(text)) {
      inCriteria = /^## Success Criteria\s*$/.test(text);
      current = null;
      continue;
    }
    if (!inCriteria) continue;
    if (/^(?:[-*+]|\d+[.)])\s+\[SC[1-9]\d*\]/.test(text)) {
      current = { paths: null, commands: [] };
      mappings.push(current);
      continue;
    }
    if (!current) continue;
    const changes = /^ {2,}[-*+] Changes:\s*(.+)$/.exec(text);
    if (changes) {
      current.paths = changes[1].split(',').map(value => normalizePlanPath(value).path);
    }
    const verify = /^ {2,}[-*+] Verify:\s*`([^`]+)`\s*$/.exec(text);
    if (verify) current.commands.push(verify[1].trim());
  }
  return Object.fromEntries(commands.map((command) => {
    const references = mappings.filter(entry => entry.commands.includes(command));
    const approved = new Set(approvedPaths);
    const narrowed = references.length > 0 &&
      references.every(entry => entry.paths?.length && entry.paths.every(value => value && (approved.size === 0 || approved.has(value))))
      ? [...new Set(references.flatMap(entry => entry.paths))].sort()
      : approvedPaths;
    return [command, narrowed];
  }));
}

export function parsePorcelainZ(source) {
  const fields = source.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const records = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4 || field[2] !== ' ') {
      throw new Error('Invalid porcelain v1 -z record.');
    }
    const status = field.slice(0, 2);
    const paths = [field.slice(3)];
    if (status.includes('R') || status.includes('C')) {
      if (++index >= fields.length) throw new Error('Rename/copy porcelain record is missing its second path.');
      paths.push(fields[index]);
    }
    records.push({ status, paths });
  }
  return records;
}

/**
 * @param {any} repoRoot
 * @param {any} args
 * @param {{ encoding?: BufferEncoding, input?: any }} [options]
 */
function runGit(repoRoot, args, { encoding = 'utf8', input } = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding, input });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString().trim() || `git ${args[0]} exited ${result.status}.`);
  }
  return result.stdout;
}

export function captureRepositoryState(repoRoot) {
  const root = path.resolve(repoRoot);
  const inside = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { available: false, reason: 'side-effect capture unavailable', entries: {} };
  }
  const records = parsePorcelainZ(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const entries = {};
  const existingPaths = [...new Set(records.flatMap(({ paths }) => paths))]
    .filter((relativePath) => {
      const file = path.join(root, relativePath);
      return fs.existsSync(file) && fs.statSync(file).isFile();
    });
  const unsupportedPath = existingPaths.find((relativePath) => /[\r\n]/.test(relativePath));
  if (unsupportedPath) throw new Error('Unsupported Git path contains a newline; side-effect capture unavailable.');
  const hashes = existingPaths.length > 0
    ? runGit(root, ['hash-object', '--no-filters', '--stdin-paths'], { input: `${existingPaths.join('\n')}\n` })
      .trim().split('\n')
    : [];
  if (hashes.length !== existingPaths.length) {
    throw new Error('git hash-object returned an unexpected path count; side-effect capture unavailable.');
  }
  const hashByPath = new Map(existingPaths.map((relativePath, index) => [relativePath, hashes[index]]));
  for (const record of records) {
    for (const relativePath of record.paths) {
      const objectId = hashByPath.get(relativePath) ?? 'absent';
      entries[relativePath.replaceAll('\\', '/')] = { status: record.status, objectId };
    }
  }
  return { available: true, entries };
}

export function diffRepositoryState(before, after) {
  if (!before.available && before.available !== undefined) throw new Error(before.reason);
  if (!after.available && after.available !== undefined) throw new Error(after.reason);
  const beforeEntries = before.entries ?? {};
  const afterEntries = after.entries ?? {};
  const allPaths = [...new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])].sort();
  return {
    changed: allPaths.filter((file) => JSON.stringify(beforeEntries[file]) !== JSON.stringify(afterEntries[file])),
    added: allPaths.filter((file) => !(file in beforeEntries) && file in afterEntries),
    removed: allPaths.filter((file) => file in beforeEntries && !(file in afterEntries)),
  };
}

/**
 * @param {any} value
 * @param {{ maxLength?: number }} [options]
 */
export function normalizeDiagnostic(value, { maxLength = 4000 } = {}) {
  return String(value)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\b/gi, '<duration>')
    .replace(/(?:\/(?:private\/)?tmp|\/var\/folders\/\S+|[A-Za-z]:\\(?:Temp|Users\\[^\\]+\\AppData\\Local\\Temp))[/\\][^\s)'"]+/g, '<tmp-path>')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function failureIdentity({ exitStatus, identifiers = [], diagnostic = '' }) {
  return {
    exitStatus,
    identifiers: [...new Set(identifiers.map(String))].sort(),
    diagnostic: normalizeDiagnostic(diagnostic),
  };
}

export function compareFailureIdentity(left, right) {
  if (left.exitStatus !== right.exitStatus) return false;
  if (left.identifiers.length > 0 || right.identifiers.length > 0) {
    return JSON.stringify(left.identifiers) === JSON.stringify(right.identifiers);
  }
  return left.diagnostic === right.diagnostic;
}
