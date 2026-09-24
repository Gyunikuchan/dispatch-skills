// @ts-check
import path from 'node:path';

const ACTION_HEADING = /^####\s+\[(NEW|MODIFY|DELETE|GENERATED)\]\s+(.+?)\s*$/;

export function structuralLines(source) {
  const input = source.split(/\r?\n/);
  let fence = null;
  let inComment = false;
  return input.map((original, index) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(original);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return { line: index + 1, text: '', original, fenced: true };
    }
    if (fence) return { line: index + 1, text: '', original, fenced: true };
    let text = '';
    let cursor = 0;
    while (cursor < original.length) {
      if (inComment) {
        const close = original.indexOf('-->', cursor);
        if (close === -1) return { line: index + 1, text, original, commented: true };
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = original.indexOf('<!--', cursor);
      if (open === -1) {
        text += original.slice(cursor);
        break;
      }
      text += original.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }
    if (/^\s*>/.test(text)) text = '';
    return { line: index + 1, text, original };
  });
}

export function normalizePlanPath(raw) {
  const trimmed = raw.trim();
  const quoted = /^`([^`]+)`.*$/.exec(trimmed);
  const rawPath = quoted?.[1] ?? /^\S+/.exec(trimmed)?.[0];
  if (!rawPath) return { rawPath, path: null, rejectionReason: 'empty' };
  if (rawPath.includes('\\')) return { rawPath, path: null, rejectionReason: 'backslash' };
  if (path.posix.isAbsolute(rawPath)) return { rawPath, path: null, rejectionReason: 'absolute' };
  if (rawPath.split('/').includes('..')) return { rawPath, path: null, rejectionReason: 'parent-segment' };
  const normalized = path.posix.normalize(rawPath.replace(/^\.\/+/, ''));
  if (normalized === '.' || normalized === '') return { rawPath, path: null, rejectionReason: 'empty' };
  return { rawPath, path: normalized, rejectionReason: null };
}

export function extractActionHeadingRecords(source) {
  const lines = structuralLines(source);
  const owners = lines.filter(({ text }) => /^## Proposed Changes\s*$/.test(text));
  if (owners.length !== 1) return [];
  const start = lines.indexOf(owners[0]);
  const records = [];
  for (const entry of lines.slice(start + 1)) {
    if (/^##\s+/.test(entry.text)) break;
    const match = ACTION_HEADING.exec(entry.text);
    if (!match) continue;
    const normalized = normalizePlanPath(match[2]);
    records.push({ action: match[1], ...normalized, line: entry.line });
  }
  return records;
}

export function extractApprovedPathSet(source) {
  return [...new Set(extractActionHeadingRecords(source)
    .filter(({ path }) => path)
    .map(({ path: value }) => value))].sort();
}

/**
 * `[GENERATED]` paths and their generator commands: `- Command: \`<command>\`` under the heading.
 * A generated path is approved scope; completion verification reruns its generator first.
 */
export function extractGeneratedPaths(source) {
  const lines = structuralLines(source);
  const records = extractActionHeadingRecords(source).filter(record => record.action === 'GENERATED');
  return records.map((record) => {
    const start = lines.findIndex(entry => entry.line === record.line);
    let command = null;
    for (const entry of lines.slice(start + 1)) {
      if (/^#{2,4}\s+/.test(entry.text)) break;
      const match = /^[-*+]\s+Command:\s*`([^`]+)`\s*$/.exec(entry.text.trim());
      if (match) { command = match[1].trim(); break; }
    }
    return { path: record.path, command, line: record.line };
  });
}
