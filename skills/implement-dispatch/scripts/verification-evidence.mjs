#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHANGE_HEADING = /^####\s+\[(NEW|MODIFY|DELETE)\]\s+(.+?)\s*$/;

function normalizePlanPath(raw) {
  const trimmed = raw.trim();
  const quoted = /^`([^`]+)`(?:\s+.*)?$/.exec(trimmed);
  const value = (quoted?.[1] ?? trimmed.split(/\s+/)[0]).replace(/^\.\/+/, '');
  if (value.includes('\\') || value.split('/').includes('..') || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  return normalized === '.' ? null : normalized;
}

function structuralLines(source) {
  const lines = source.split(/\r?\n/);
  let fence = null;
  let inComment = false;
  return lines.map((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return '';
    }
    if (fence) return '';
    let visible = '';
    let cursor = 0;
    while (cursor < line.length) {
      if (inComment) {
        const close = line.indexOf('-->', cursor);
        if (close === -1) return visible;
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = line.indexOf('<!--', cursor);
      if (open === -1) {
        visible += line.slice(cursor);
        break;
      }
      visible += line.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }
    return /^\s*>/.test(visible) ? '' : visible;
  });
}

export function extractApprovedPathSet(source) {
  const lines = structuralLines(source);
  const start = lines.findIndex((line) => /^## Proposed Changes\s*$/.test(line));
  if (start === -1) return [];
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    const match = CHANGE_HEADING.exec(line);
    if (!match) continue;
    const normalized = normalizePlanPath(match[2]);
    if (normalized) paths.push(normalized);
  }
  return [...new Set(paths)].sort();
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

function main(argv) {
  if (argv[0] === '--approved-paths' && argv.length === 2) {
    process.stdout.write(`${JSON.stringify(extractApprovedPathSet(fs.readFileSync(argv[1], 'utf8')))}\n`);
    return;
  }
  if (argv[0] === '--capture' && argv.length === 2) {
    process.stdout.write(`${JSON.stringify(captureRepositoryState(argv[1]))}\n`);
    return;
  }
  throw new Error('Usage: verification-evidence.mjs --approved-paths <plan> | --capture <repo-root>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[verification-evidence] ${error.message}\n`);
    process.exitCode = 1;
  }
}
