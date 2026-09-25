// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { safeRenameSync } from '../lib/platform.mjs';
import { sanitizeReplyText } from './actions.mjs';

// SECTION: Artifact log policy

export const REPO_RELATIVE = /^(?!\/)(?![A-Za-z]:)(?!\.\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\x00-\x1f\x7f\\]).+$/;
export const LOG_HEADING = /^##\s+Review Findings & Resolutions\b/;
export const FOLLOW_UPS = /^##\s+Follow-ups\s*$/;

/** Reads the canonical review artifact without normalizing its line endings. */
export function readArtifactText(state) {
  return fs.readFileSync(state.artifactPath, 'utf8');
}

/** Atomically replaces the canonical artifact so interruption cannot truncate its log. */
export function writeArtifactText(state, text) {
  const temp = `${state.artifactPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text);
  try {
    safeRenameSync(temp, state.artifactPath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Appends lines to an H2 section, preserving line endings and creating the section when absent. */
export function appendToSection(markdown, heading, title, block, placeholder) {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let range = sectionRange(lines, heading);
  if (!range) {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push('', title, '');
    range = { start: lines.length - 2, end: lines.length };
  }
  const body = lines.slice(range.start + 1, range.end).filter((line) => !placeholder.test(line));
  while (body.length && body.at(-1).trim() === '') body.pop();
  const next = [...lines.slice(0, range.start + 1), ...body, ...(body.length ? [''] : []), ...block, ...(range.end < lines.length ? [''] : []), ...lines.slice(range.end)];
  let text = next.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/** Replaces a resolution-log entry's status label without touching its evidence. */
export function setEntryStatus(markdown, id, label) {
  const escaped = id.replace(/[-]/g, '\\-');
  return markdown.replace(new RegExp(`^(\\s*[-*]\\s+\\*\\*\\[)[^\\]]+(\\]\\*\\*\\s+\\[${escaped}\\])`, 'm'), `$1${label}$2`);
}

/** Replaces the text after the first ` → ` on a resolution-log entry line; other lines stay untouched. */
export function setEntryResolution(markdown, id, text) {
  const escaped = id.replace(/[-]/g, '\\-');
  const entry = new RegExp(`^(\\s*[-*]\\s+\\*\\*\\[[^\\]]+\\]\\*\\*\\s+\\[${escaped}\\].*? → )([^\\r\\n]*)`, 'm');
  return markdown.replace(entry, (_, head, existing) => `${head}${cleanText(text, existing)}`);
}

/** Sanitizes host-provided prose and supplies a stable fallback when nothing remains. */
export function cleanText(text, fallback) {
  return sanitizeReplyText(text) || fallback;
}

// SECTION: Markdown structure

function sectionRange(lines, heading) {
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  if (end === -1) end = lines.length;
  return { start, end };
}
