import crypto from 'node:crypto';

const SECTION_HEADING = /^##\s+Review Findings & Resolutions\b/i;
const H2 = /^##\s+/;
const ROUND = /^###\s+Round\s+(\d+)\b/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ENTRY = /^\s*[-*]\s+\*\*\[([^\]]+)\]\*\*/;

function normalize(markdown) {
  return String(markdown ?? '').normalize('NFC').replace(/\r\n?/g, '\n');
}

function statusKey(raw) {
  const status = raw.trim().toLowerCase().replace(/[—–]/g, '-').replace(/\s+/g, ' ');
  if (status === 'accepted') return 'accepted';
  if (status === 'resolved dispute') return 'resolvedDispute';
  if (status === 'rejected / downgraded') return 'rejected';
  if (status === 'disputed') return 'disputed';
  if (/^rejected\s*-+\s*pending confirmation$/.test(status)) return 'pendingConfirmation';
  return 'unknown';
}

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function fenceTransition(line, fence) {
  const match = FENCE.exec(line);
  if (!match) return fence;
  const [, marker, rest] = match;
  if (!fence) {
    if (marker[0] === '`' && rest.includes('`')) return null;
    return marker;
  }
  if (marker[0] === fence[0] && marker.length >= fence.length && !rest.trim()) return null;
  return fence;
}

function findSections(lines, honorFences) {
  const sections = [];
  let fence = null;
  let start = null;
  for (let index = 0; index < lines.length; index++) {
    if (honorFences) {
      const nextFence = fenceTransition(lines[index], fence);
      if (nextFence !== fence) {
        fence = nextFence;
        continue;
      }
      if (fence) continue;
    }
    if (!H2.test(lines[index])) continue;
    if (start !== null) {
      sections.push({ start, end: index });
      start = null;
    }
    if (SECTION_HEADING.test(lines[index])) start = index;
  }
  if (start !== null) sections.push({ start, end: lines.length });
  return { sections, unterminated: Boolean(fence) };
}

function parseRounds(sectionLines, { strict }) {
  const rounds = [];
  let current = null;
  let fence = null;
  let previous = 0;
  for (let index = 1; index < sectionLines.length; index++) {
    const line = sectionLines[index];
    const nextFence = fenceTransition(line, fence);
    if (nextFence !== fence) {
      fence = nextFence;
      if (current) current.lines.push(line);
      continue;
    }
    if (!fence) {
      const roundMatch = ROUND.exec(line);
      if (roundMatch) {
        const number = Number(roundMatch[1]);
        if (strict && number <= previous) throw new Error(`Round ${number} is duplicate or out of order.`);
        previous = number;
        current = { number, heading: line, lines: [line], entries: [] };
        rounds.push(current);
        continue;
      }
      const entryMatch = ENTRY.exec(line);
      if (entryMatch) {
        if (!current) {
          if (strict) throw new Error('Resolution entry appears before the first round.');
          current = { number: 0, heading: '', lines: [], entries: [] };
          rounds.push(current);
        }
        const status = statusKey(entryMatch[1]);
        const entry = { status, line: line.trim() };
        current.entries.push(entry);
        current.lines.push(line);
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  if (strict && fence) throw new Error('Resolution log contains an unterminated fence.');
  for (const round of rounds) {
    round.text = round.lines.join('\n').replace(/\n+$/, '');
    round.hash = digest(round.text);
    round.counts = {
      accepted: round.entries.filter((entry) => entry.status === 'accepted').length,
      rejected: round.entries.filter((entry) => entry.status === 'rejected').length,
      resolvedDispute: round.entries.filter((entry) => entry.status === 'resolvedDispute').length,
      disputed: round.entries.filter((entry) => entry.status === 'disputed').length,
      pendingConfirmation: round.entries.filter((entry) => entry.status === 'pendingConfirmation').length,
      unknown: round.entries.filter((entry) => entry.status === 'unknown').length,
    };
  }
  return rounds;
}

export function scanResolutionLog(markdown, { strict = true } = {}) {
  const normalized = normalize(markdown);
  const lines = normalized.split('\n');
  let { sections, unterminated } = findSections(lines, true);
  if (unterminated) {
    if (strict) throw new Error('Artifact contains an unterminated fence.');
    sections = findSections(lines, false).sections;
  }
  if (strict && sections.length > 1) throw new Error('Artifact contains duplicate resolution-log sections.');
  const selected = strict ? sections.slice(0, 1) : sections;
  const rounds = selected.flatMap((section) =>
    parseRounds(lines.slice(section.start, section.end), { strict }));
  const sectionText = selected.map((section) => lines.slice(section.start, section.end).join('\n')).join('\n');
  const unsettled = rounds.flatMap((round) =>
    round.entries
      .filter((entry) => entry.status === 'disputed' || entry.status === 'pendingConfirmation')
      .map((entry) => entry.line));
  let semanticBody = normalized;
  if (sections[0]) {
    semanticBody = [...lines.slice(0, sections[0].start), ...lines.slice(sections[0].end)]
      .join('\n')
      .replace(/\s+$/, '');
  }
  return {
    normalized,
    semanticBody,
    sectionText,
    canonicalLogHash: digest(sectionText),
    rounds,
    unsettled,
    sectionCount: sections.length,
  };
}

export function findUnsettledResolutionLines(markdown) {
  return scanResolutionLog(markdown, { strict: false }).unsettled;
}
