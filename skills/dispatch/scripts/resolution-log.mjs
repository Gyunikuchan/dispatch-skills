import crypto from 'node:crypto';

const SECTION_HEADING = /^##\s+Review Findings & Resolutions\b/i;
const H2 = /^##\s+/;
const ROUND = /^###\s+Round\s+(\d+)\b/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ENTRY = /^\s*[-*]\s+\*\*\[([^\]]+)\]\*\*(.*)$/;
const ENRICHED_PREFIX =
  /^\s+\[(R([1-9]\d*)-F([0-9]{3,}))\]\s+\[(MUST|SHOULD|CONSIDER|ACTIONABLE)\]\s+\[sources=([^\]]+)\]\s+(.+)$/;
const SOURCE_MAP = /^\s*[-*]\s+\*\*Sources:\*\*\s+(\{.*\})\s*$/;
const APPLICATION_LINE = /^\s+[-*]\s+application:\s*(.*)$/;
const SOURCE_KEY = /^(plan-review|code-review|design-review):R[1-9]\d*:[a-z][a-z0-9-]*:[0-9]+$/;
const SOURCE_STATUSES = new Set(['target', 'reserve', 'fallback', 'replacement']);
const APPLICATION_STATES = new Set(['unapplied', 'materialized', 'applied', 'superseded']);
const APPLICATION_SCOPES = new Set(['in-scope', 'adjacent']);
const APPLICATION_FIELDS = ['affectedPaths', 'dependsOn', 'findingId', 'reason', 'scope', 'state', 'v', 'verification'];
const PATH_PATTERN = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\x00-\x1f\x7f\\]).+$/;

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

export function splitDispatchFrontmatter(markdown) {
  const rawSource = String(markdown ?? '');
  const opener = /^(---)\r?\n/.exec(rawSource);
  if (!opener) {
    return { metadata: null, body: rawSource, frontmatter: null };
  }
  const close = /\r?\n---\r?\n/g;
  close.lastIndex = opener[0].length;
  const match = close.exec(rawSource);
  if (!match) {
    throw new Error('Artifact contains unterminated frontmatter.');
  }
  const raw = rawSource.slice(opener[0].length, match.index).trim();
  if (!raw.startsWith('{')) {
    return { metadata: null, body: rawSource, frontmatter: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Artifact dispatch frontmatter is malformed JSON: ${err.message}`);
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    !parsed.dispatch ||
    Array.isArray(parsed.dispatch) ||
    typeof parsed.dispatch !== 'object'
  ) {
    throw new Error('Artifact JSON frontmatter must contain one dispatch object.');
  }
  return {
    metadata: parsed.dispatch,
    body: rawSource.slice(match.index + match[0].length),
    frontmatter: rawSource.slice(0, match.index + match[0].length),
  };
}

export function withDispatchFrontmatter(markdown, metadata) {
  const { body } = splitDispatchFrontmatter(markdown);
  return `---\n${JSON.stringify({ dispatch: metadata }, null, 2)}\n---\n${body}`;
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
  try {
    return validateSourceMap(value, roundNumber);
  } catch (err) {
    if (strict) throw err;
    return null;
  }
}

const SOURCE_RECORD_FIELDS = ['candidateIndex', 'effort', 'model', 'provider', 'session', 'status', 'substitutesFor'];
const SOURCE_KEY_PARTS = /^(plan-review|code-review|design-review):R([1-9]\d*):([a-z][a-z0-9-]*):([0-9]+)$/;

// Names the first failing field so a hand-edited or generated record is fixable in one pass.
function sourceRecordProblem(key, source, roundNumber) {
  const keyMatch = SOURCE_KEY_PARTS.exec(key);
  if (!keyMatch) return 'key must be <plan-review|code-review>:R<n>:<provider>:<candidate-index>';
  if (Number(keyMatch[2]) !== roundNumber) return `key round must be R${roundNumber}`;
  if (!source || Array.isArray(source) || typeof source !== 'object') return 'record must be an object';
  if (Object.keys(source).sort().join('\0') !== SOURCE_RECORD_FIELDS.join('\0')) {
    return `record fields must be exactly: ${SOURCE_RECORD_FIELDS.join(', ')}`;
  }
  if (source.provider !== keyMatch[3]) return `provider must be "${keyMatch[3]}"`;
  if (source.candidateIndex !== Number(keyMatch[4])) return `candidateIndex must be ${Number(keyMatch[4])}`;
  if (source.model !== null && typeof source.model !== 'string') return 'model must be a string or null';
  if (source.effort !== null && typeof source.effort !== 'string') return 'effort must be a string or null';
  if (!SOURCE_STATUSES.has(source.status)) return `status must be one of: ${[...SOURCE_STATUSES].join(', ')}`;
  if (source.session !== null && typeof source.session !== 'string') return 'session must be a string or null';
  if (source.substitutesFor !== null) {
    const substitute = SOURCE_KEY_PARTS.exec(source.substitutesFor ?? '');
    if (!substitute || substitute[1] !== keyMatch[1] || Number(substitute[2]) !== roundNumber) {
      return `substitutesFor must be null or a ${keyMatch[1]}:R${roundNumber} source key`;
    }
  }
  return null;
}

export function validateSourceMap(value, roundNumber) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length === 0) {
    throw new Error(`Round ${roundNumber} source map must be a non-empty object.`);
  }
  for (const [key, source] of Object.entries(value)) {
    const problem = sourceRecordProblem(key, source, roundNumber);
    if (problem) throw new Error(`Round ${roundNumber} source map entry "${key}" is invalid: ${problem}.`);
  }
  return value;
}

function isSortedUnique(arr) {
  return arr.every((item, i) => i === 0 || item > arr[i - 1]);
}

function applicationRecordProblem(record, entry, roundNumber) {
  if (!record || Array.isArray(record) || typeof record !== 'object') return 'record must be an object';
  if (Object.keys(record).sort().join('\0') !== APPLICATION_FIELDS.join('\0')) {
    return `record fields must be exactly: ${APPLICATION_FIELDS.join(', ')}`;
  }
  if (record.v !== 1) return 'v must be 1';
  if (typeof record.findingId !== 'string' || record.findingId.length === 0) return 'findingId must be a non-empty string';
  if (entry && entry.id && record.findingId !== entry.id) {
    return `findingId "${record.findingId}" does not match entry ID "${entry.id}"`;
  }
  if (!APPLICATION_STATES.has(record.state)) {
    return `state must be one of: ${[...APPLICATION_STATES].join(', ')}`;
  }
  if (!APPLICATION_SCOPES.has(record.scope)) {
    return `scope must be one of: ${[...APPLICATION_SCOPES].join(', ')}`;
  }
  if (!Array.isArray(record.affectedPaths) || record.affectedPaths.length === 0) {
    return 'affectedPaths must be a non-empty array of strings';
  }
  for (let i = 0; i < record.affectedPaths.length; i++) {
    const p = record.affectedPaths[i];
    if (typeof p !== 'string' || !PATH_PATTERN.test(p) || p.startsWith('./') || p.includes('//')) {
      return `affectedPaths[${i}] must be a normalized repository-relative slash path`;
    }
  }
  if (!isSortedUnique(record.affectedPaths)) {
    return 'affectedPaths must be sorted and contain unique paths';
  }
  if (!Array.isArray(record.dependsOn) || record.dependsOn.some((dep) => typeof dep !== 'string')) {
    return 'dependsOn must be an array of strings';
  }
  if (!isSortedUnique(record.dependsOn)) {
    return 'dependsOn must be sorted and contain unique finding IDs';
  }
  if (!Array.isArray(record.verification) || record.verification.some((v) => typeof v !== 'string' || v.length === 0)) {
    return 'verification must be an array of non-empty command strings';
  }
  if (new Set(record.verification).size !== record.verification.length) {
    return 'verification commands must be unique';
  }
  if (typeof record.reason !== 'string' || record.reason.trim().length === 0) {
    return 'reason must be a non-empty string';
  }
  if (entry && entry.status !== 'accepted' && entry.status !== 'resolvedDispute') {
    return `application record cannot be attached to finding with status "${entry.status}"`;
  }
  return null;
}

export function validateApplicationRecord(value, entry, roundNumber) {
  const problem = applicationRecordProblem(value, entry, roundNumber);
  if (problem) {
    const locus = entry?.id ? ` for finding ${entry.id}` : '';
    throw new Error(`Round ${roundNumber} application record${locus} is invalid: ${problem}.`);
  }
  return value;
}

export function formatApplicationRecord(record) {
  const problem = applicationRecordProblem(record, { id: record?.findingId, status: 'accepted' }, 1);
  if (problem) {
    throw new Error(`Application record is invalid: ${problem}.`);
  }
  const canonical = {
    v: 1,
    findingId: record.findingId,
    state: record.state,
    scope: record.scope,
    affectedPaths: [...record.affectedPaths],
    dependsOn: [...record.dependsOn],
    verification: [...record.verification],
    reason: record.reason,
  };
  return `  - application: ${JSON.stringify(canonical)}`;
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
  let lastLineWasEntry = false;
  for (let index = 1; index < sectionLines.length; index++) {
    const line = sectionLines[index];
    const nextFence = fenceTransition(line, fence);
    if (nextFence !== fence) {
      fence = nextFence;
      if (current) current.lines.push(line);
      lastLineWasEntry = false;
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
        lastLineWasEntry = false;
        continue;
      }
      const sourceMap = current && parseSourceMap(line, { strict, roundNumber: current.number });
      if (sourceMap) {
        if (current.sourceMap && strict) throw new Error(`Round ${current.number} contains duplicate source maps.`);
        current.sourceMap = sourceMap;
        current.lines.push(line);
        lastLineWasEntry = false;
        continue;
      }
      const appMatch = APPLICATION_LINE.exec(line);
      if (appMatch) {
        const lastEntry = current?.entries[current.entries.length - 1];
        if (!lastEntry) {
          if (strict) throw new Error('Application record appears before any resolution entry.');
        } else if (lastEntry.application && strict) {
          throw new Error(`Round ${current.number} finding ${lastEntry.id || lastEntry.key} contains duplicate application records.`);
        } else if (strict && !lastLineWasEntry) {
          throw new Error(`Round ${current.number} application record must immediately follow its resolution entry.`);
        } else {
          let value;
          try {
            value = JSON.parse(appMatch[1].trim());
          } catch (err) {
            if (strict) throw new Error(`Round ${current.number} application record is malformed JSON: ${err.message}`);
          }
          if (value) {
            if (strict) validateApplicationRecord(value, lastEntry, current.number);
            lastEntry.application = value;
          }
        }
        if (current) current.lines.push(line);
        lastLineWasEntry = false;
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
        let severity = /(?:—\s*[^:]*|^[^:]*)\(CONSIDER\)\s*:/.test(entryMatch[2]) ? 'CONSIDER' : 'ACTIONABLE';
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
          application: null,
          line: line.trim(),
          originalLine: line.trim(),
          lineNumber: lineOffset + index + 1,
        };
        current.entries.push(entry);
        current.lines.push(line);
        lastLineWasEntry = true;
        continue;
      }
    }
    lastLineWasEntry = false;
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
  const document = splitDispatchFrontmatter(markdown);
  const normalized = normalize(document.body);
  const lines = normalized.split('\n');
  let { sections, unterminated } = findSections(lines, true);
  if (unterminated) {
    if (strict) throw new Error('Artifact contains an unterminated fence.');
    sections = findSections(lines, false).sections;
  }
  if (strict && sections.length > 1) throw new Error('Artifact contains duplicate resolution-log sections.');
  const selected = strict ? sections.slice(0, 1) : sections;
  // NOTE: lineOffset is body-relative so that round hashes, entries, and legacy keys
  // remain invariant across metadata frontmatter adoption, as asserted by test contracts.
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
    metadata: document.metadata,
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
