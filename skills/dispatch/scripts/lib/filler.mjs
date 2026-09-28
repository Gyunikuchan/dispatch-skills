// @ts-check

/** Whole-note phrases that carry no information; compared after normalization, never as substrings. */
const FILLER = new Set(['same', 'see above', 'unchanged', 'n/a', 'approved implementation scope', 'included in the selected review scope']);
// Generated line deltas legitimately repeat across files.
const DELTA = /^\+\d+ −\d+$/;
/** Review-fix attribution appended to a Changes Made note; IDs follow the resolution-log grammar. */
export const FIXES_SUFFIX = /(?:^|; )fixes (R\d+-F\d{3,}(?:, R\d+-F\d{3,})*)$/;

/** @param {string} note */
export function normalizeNote(note) {
  return String(note ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\.$/, '');
}

/** @param {string} note @returns {string} the note without its `fixes <IDs>` suffix */
const baseNote = note => { const match = FIXES_SUFFIX.exec(String(note ?? '').trim()); return match ? String(note).trim().slice(0, match.index) : String(note ?? ''); };

/**
 * Merges finding IDs into a note's `fixes <IDs>` suffix, sorted and deduplicated.
 * @param {string} note @param {string[]} ids
 */
export function withFixes(note, ids) {
  const prior = FIXES_SUFFIX.exec(String(note ?? '').trim());
  const all = [...new Set([...(prior?.[1].split(', ') ?? []), ...ids])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const base = baseNote(note).trim();
  return all.length ? `${base ? `${base}; ` : ''}fixes ${all.join(', ')}` : base;
}

/**
 * Reports whether a per-file note is filler: empty, a stock phrase, or a copy of a sibling note.
 * @param {string} note
 * @param {string[]} [siblings] the other notes in the same list, excluding this one
 */
export function isFillerNote(note, siblings = []) {
  const value = normalizeNote(note);
  if (!value || FILLER.has(value)) return true;
  // A fixes suffix attributes, it does not describe: siblings compare on the base note.
  const base = normalizeNote(baseNote(note));
  if (!base || DELTA.test(base)) return false;
  return siblings.some(sibling => normalizeNote(baseNote(sibling)) === base);
}
