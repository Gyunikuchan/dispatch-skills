// @ts-check
/**
 * Review-rounds policy for code reviews that apply fixes (`review code --fix`, `implement`): severity
 * thresholds, round scope, orchestrator adjudication, finding matching, and convergence. Side-effect
 * free; the driver maps resolution-log entries onto these shapes (ADR 0005).
 */

// SECTION: Thresholds and round decisions

const RANKS = { CONSIDER: 1, SHOULD: 2, MUST: 3 };

/** @param {string} severity */
export function rank(severity) {
  return RANKS[severity] ?? 0;
}

/**
 * The minimum severity that triggers another round and needs reviewer agreement to close.
 * @param {{ round: number, cap: number }} options round = the completed round's number
 */
export function threshold({ round, cap }) {
  return round >= cap ? 'MUST' : 'SHOULD';
}

/**
 * @typedef {{ severity: string, state: string, id?: string }} RoundFinding
 * state: `fixed` (applied this round), `pending-rejection`, `rejected`, or anything else (closed/open)
 */

/** @param {{ round: number, cap: number, findings: RoundFinding[] }} summary */
export function shouldReReview({ round, cap, findings }) {
  const floor = rank(threshold({ round, cap }));
  return findings.some((finding) => rank(finding.severity) >= floor &&
    (finding.state === 'fixed' || finding.state === 'pending-rejection'));
}

/**
 * Scope of the round after `round`: the cap round itself is full-diff; later rounds are delta.
 * @param {{ round: number, cap: number }} options
 * @returns {'full' | 'delta'}
 */
export function reviewScope({ round, cap }) {
  return round >= cap ? 'delta' : 'full';
}

/**
 * Finalizes below-threshold pending rejections on the orchestrator's authority.
 * @template {RoundFinding} T
 * @param {{ round: number, cap: number, findings: T[] }} summary
 * @returns {(T & { closer?: 'orchestrator' })[]}
 */
export function adjudicate({ round, cap, findings }) {
  const floor = rank(threshold({ round, cap }));
  return findings.map((finding) => finding.state === 'pending-rejection' && rank(finding.severity) < floor
    ? { ...finding, state: 'rejected', closer: 'orchestrator' }
    : finding);
}

// SECTION: Matching

export const MATCH_LINE_WINDOW = 5;
export const MATCH_JACCARD = 0.3;
export const MATCH_STOPWORDS = Object.freeze(new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'has', 'had', 'its', 'was', 'were', 'will',
  'with', 'this', 'that', 'from', 'into', 'when', 'then', 'than', 'them', 'they', 'which', 'while', 'where', 'there',
  'their', 'these', 'those', 'should', 'would', 'could', 'must', 'does', 'did', 'have', 'been', 'being', 'also', 'only',
  'each', 'other', 'such', 'what', 'who', 'how', 'why', 'our', 'out', 'use', 'uses', 'used',
]));

/** @param {string} text */
function tokens(text) {
  return new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !MATCH_STOPWORDS.has(token)));
}

/**
 * Token Jaccard; two empty sets score 0 so location and tag alone never match.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Parses a code locus `<relative-file>:L<line>[-L<end>]` into a normalized path and start line.
 * @param {string} locus
 * @param {string} [platform]
 */
export function parseLocus(locus, platform = process.platform) {
  const match = /^(.+?):L(\d+)/.exec(String(locus ?? '').trim());
  if (!match) return { path: null, line: null };
  const file = match[1].replace(/\\/g, '/');
  return { path: platform === 'win32' ? file.toLowerCase() : file, line: Number(match[2]) };
}

/**
 * @typedef {{ path: string | null, line: number | null, tag: string, text: string }} MatchKey
 */

/**
 * Same path, lines within ±MATCH_LINE_WINDOW, same tag, and token-Jaccard ≥ MATCH_JACCARD.
 * @param {MatchKey} a
 * @param {MatchKey} b
 */
export function matchFinding(a, b) {
  if (!a.path || a.path !== b.path || a.line === null || b.line === null) return false;
  if (Math.abs(a.line - b.line) > MATCH_LINE_WINDOW || a.tag !== b.tag) return false;
  return similarity(a.text, b.text) >= MATCH_JACCARD;
}

// SECTION: Convergence

/**
 * @typedef {MatchKey & { id: string, status: 'applied' | 'pendingConfirmation', reraise?: number }} HistoryEntry
 */

/**
 * Halts on a re-raised fix (regression) or a second re-raise of a pending rejection (deadlock);
 * otherwise lists the pending rejections whose first re-raise this wave carries.
 * @param {{ findings: MatchKey[], history: HistoryEntry[] }} options
 * @returns {{ halt: false, reraised: string[] } | { halt: true, kind: 'regression' | 'deadlock', ids: string[] }}
 */
export function convergence({ findings, history }) {
  const matched = history.filter((entry) => findings.some((finding) => matchFinding(finding, entry)));
  const regressed = matched.filter((entry) => entry.status === 'applied');
  if (regressed.length) return { halt: true, kind: 'regression', ids: regressed.map((entry) => entry.id) };
  const pending = matched.filter((entry) => entry.status === 'pendingConfirmation');
  const deadlocked = pending.filter((entry) => (entry.reraise ?? 0) >= 1);
  if (deadlocked.length) return { halt: true, kind: 'deadlock', ids: deadlocked.map((entry) => entry.id) };
  return { halt: false, reraised: pending.map((entry) => entry.id) };
}
