import crypto from 'node:crypto';

const SECTION_HEADING = /^##\s+Review Findings & Resolutions\b/i;
const H2 = /^##\s+/;
const ROUND = /^###\s+Round\s+(\d+)\b/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ENTRY = /^\s*[-*]\s+\*\*\[([^\]]+)\]\*\*(.*)$/;
const ENRICHED_PREFIX =
  /^\s+\[(R([1-9]\d*)-F([0-9]{3,}))\]\s+\[(MUST|SHOULD|CONSIDER|ACTIONABLE)\]\s+\[sources=([^\]]+)\]\s+(.+)$/;
const SOURCE_MAP = /^\s*[-*]\s+\*\*Sources:\*\*\s+(\{.*\})\s*$/;
const SOURCE_KEY = /^(plan-review|code-review):R[1-9]\d*:[a-z][a-z0-9-]*:[0-9]+$/;
const SOURCE_STATUSES = new Set(['target', 'reserve', 'fallback', 'replacement']);

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

function legacySourceKeys(round) {
  if (round.sourceMap && Object.keys(round.sourceMap).length > 0) {
    return Object.keys(round.sourceMap);
  }
  const suffix = round.heading.split(/\s+[—–-]\s+/, 2)[1];
  if (!suffix) return [`legacy:R${round.number}:round-wide`];
  const names = suffix
    .replace(/,\s*\d{4}-\d{2}-\d{2}.*$/, '')
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean);
  return names.length > 0
    ? names.map((name) => `legacy:R${round.number}:${name}`)
    : [`legacy:R${round.number}:round-wide`];
}

function parseSourceMap(line, { strict, roundNumber }) {
  const match = SOURCE_MAP.exec(line);
  if (!match) return null;
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch (err) {
    if (strict) throw new Error(`Round ${roundNumber} source map is malformed JSON: ${err.message}`);
    return null;
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length === 0) {
    if (strict) throw new Error(`Round ${roundNumber} source map must be a non-empty object.`);
    return null;
  }
  for (const [key, source] of Object.entries(value)) {
    const keyMatch = /^(plan-review|code-review):R([1-9]\d*):([a-z][a-z0-9-]*):([0-9]+)$/.exec(key);
    const substituteMatch = source?.substitutesFor === null
      ? null
      : /^(plan-review|code-review):R([1-9]\d*):([a-z][a-z0-9-]*):([0-9]+)$/
          .exec(source?.substitutesFor ?? '');
    const valid =
      keyMatch &&
      Number(keyMatch[2]) === roundNumber &&
      source &&
      !Array.isArray(source) &&
      typeof source === 'object' &&
      Object.keys(source).sort().join('\0') ===
        ['candidateIndex', 'effort', 'model', 'provider', 'session', 'status', 'substitutesFor'].join('\0') &&
      typeof source.provider === 'string' &&
      /^[a-z][a-z0-9-]*$/.test(source.provider) &&
      source.provider === keyMatch[3] &&
      Number.isSafeInteger(source.candidateIndex) &&
      source.candidateIndex >= 0 &&
      source.candidateIndex === Number(keyMatch[4]) &&
      (source.model === null || typeof source.model === 'string') &&
      (source.effort === null || typeof source.effort === 'string') &&
      SOURCE_STATUSES.has(source.status) &&
      (source.session === null || typeof source.session === 'string') &&
      (source.substitutesFor === null ||
        substituteMatch &&
        substituteMatch[1] === keyMatch[1] &&
        Number(substituteMatch[2]) === roundNumber);
    if (!valid) {
      if (strict) throw new Error(`Round ${roundNumber} source map entry "${key}" is invalid.`);
      return null;
    }
  }
  return value;
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

function parseRounds(sectionLines, { strict, lineOffset = 0 }) {
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
        current = { number, heading: line, lines: [line], entries: [], sourceMap: null };
        rounds.push(current);
        continue;
      }
      const sourceMap = current && parseSourceMap(line, { strict, roundNumber: current.number });
      if (sourceMap) {
        if (current.sourceMap && strict) throw new Error(`Round ${current.number} contains duplicate source maps.`);
        current.sourceMap = sourceMap;
        current.lines.push(line);
        continue;
      }
      const entryMatch = ENTRY.exec(line);
      if (entryMatch) {
        if (!current) {
          if (strict) throw new Error('Resolution entry appears before the first round.');
          current = { number: 0, heading: '', lines: [], entries: [], sourceMap: null };
          rounds.push(current);
        }
        const status = statusKey(entryMatch[1]);
        const enriched = ENRICHED_PREFIX.exec(entryMatch[2]);
        let id = null;
        let severity = /\(CONSIDER\)/.test(entryMatch[2]) ? 'CONSIDER' : 'ACTIONABLE';
        let sourceKeys = [];
        let structured = false;
        if (enriched) {
          id = enriched[1];
          const idRound = Number(enriched[2]);
          severity = enriched[4];
          sourceKeys = enriched[5].split(',').map((key) => key.trim()).filter(Boolean);
          if (strict && idRound !== current.number) {
            throw new Error(`Finding ${id} does not belong to Round ${current.number}.`);
          }
          if (strict && new Set(sourceKeys).size !== sourceKeys.length) {
            throw new Error(`Finding ${id} contains duplicate source keys.`);
          }
          const canonicalSourceCount = sourceKeys.filter((key) => SOURCE_KEY.test(key)).length;
          if (strict && canonicalSourceCount > 0 && canonicalSourceCount !== sourceKeys.length) {
            throw new Error(`Finding ${id} mixes canonical and legacy source keys.`);
          }
          structured = canonicalSourceCount === sourceKeys.length;
        } else if (/^\s+\[R/i.test(entryMatch[2]) && strict) {
          throw new Error(`Round ${current.number} contains a malformed enriched finding prefix.`);
        }
        const entry = {
          id,
          key: id,
          structured,
          severity,
          sourceKeys,
          status,
          line: line.trim(),
          originalLine: line.trim(),
          lineNumber: lineOffset + index + 1,
        };
        current.entries.push(entry);
        current.lines.push(line);
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  if (strict && fence) throw new Error('Resolution log contains an unterminated fence.');
  for (const round of rounds) {
    const ids = round.entries.map((entry) => entry.id).filter(Boolean);
    if (strict && new Set(ids).size !== ids.length) {
      throw new Error(`Round ${round.number} contains duplicate finding IDs.`);
    }
    const enrichedEntries = round.entries.filter((entry) => entry.structured);
    if (strict && enrichedEntries.length > 0 && !round.sourceMap) {
      throw new Error(`Round ${round.number} has enriched findings without a structured source map.`);
    }
    if (strict && enrichedEntries.some((entry) =>
      entry.sourceKeys.some((key) => !Object.hasOwn(round.sourceMap, key)))) {
      throw new Error(`Round ${round.number} finding cites a source absent from its source map.`);
    }
    const coarseSources = legacySourceKeys(round);
    for (const entry of round.entries) {
      if (!entry.id) {
        entry.key = `legacy:R${round.number}:L${entry.lineNumber}`;
        entry.sourceKeys = coarseSources;
      }
    }
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
    parseRounds(lines.slice(section.start, section.end), {
      strict,
      lineOffset: section.start,
    }));
  const sectionText = selected.map((section) => lines.slice(section.start, section.end).join('\n')).join('\n');
  const unsettledItems = rounds.flatMap((round) =>
    round.entries
      .filter((entry) => entry.status === 'disputed' || entry.status === 'pendingConfirmation')
      .map((entry) => ({
        key: entry.key,
        id: entry.id,
        severity: entry.severity,
        sourceKeys: entry.sourceKeys,
        status: entry.status,
        lineNumber: entry.lineNumber,
        originalLine: entry.originalLine,
      })));
  const unsettled = unsettledItems.map((entry) => entry.originalLine);
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
    unsettledItems,
    sectionCount: sections.length,
  };
}

export function findUnsettledResolutionLines(markdown) {
  return scanResolutionLog(markdown, { strict: false }).unsettled;
}

export function nextFindingId(markdown, roundNumber) {
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1) {
    throw new Error('roundNumber must be a positive integer.');
  }
  const scan = scanResolutionLog(markdown, { strict: true });
  const round = scan.rounds.find((candidate) => candidate.number === roundNumber);
  const sequences = (round?.entries ?? [])
    .map((entry) => entry.id && /^R[1-9]\d*-F([0-9]{3,})$/.exec(entry.id))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const next = (sequences.length > 0 ? Math.max(...sequences) : 0) + 1;
  return `R${roundNumber}-F${String(next).padStart(3, '0')}`;
}
