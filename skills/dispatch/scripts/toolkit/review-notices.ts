import {
  readStoredJson,
  reviewRoundDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewRoundEntries,
  reviewSlotFile,
} from './review-state.ts';
import fs from 'node:fs';
import type { UserDecision } from './domain/prompt.ts';
import type { RosterSlot } from './domain/types.ts';
import type { BlockedAttempt, SlotOutcome } from './fanout.ts';
import { clipBytes } from './output.ts';
import { present } from './narrow.ts';
import type { LedgerRecord } from './records.ts';

type BlockedEntry = { slot: string } & BlockedAttempt;
type BlockerEntry = { slot: string; reason: string; rounds: [number, number] };
export type BlockedState = { blocked: Array<BlockedEntry>; blockers: Array<BlockerEntry> };
const BLOCKED_NOTICE_BYTES = 400; // Leaves the summary room for counts and at least one finding.

/** Blocked attempts of one round, read from its current generation so a resumed pending run keeps them. */
function blockedEntries(directory: string, number: number): Array<BlockedEntry> {
  const root = reviewRoundDirectory(directory, number),
    metadata = readStoredJson<{ generation: number; roster: Array<RosterSlot> }>(reviewRoundFile(root));
  if (!metadata) {
    return [];
  }
  const generation = reviewGenerationDirectory(root, metadata.generation);
  return metadata.roster.flatMap((slot) =>
    (readStoredJson<SlotOutcome>(reviewSlotFile(generation, slot.slot))?.blocked ?? []).map((entry) => ({
      slot: slot.slot,
      ...entry,
    })),
  );
}

/** Same slot and reason identity in the nearest earlier round that has findings; a narrowed slot has no partner. */
function blockersFor(directory: string, number: number, blocked: ReadonlyArray<BlockedEntry>): Array<BlockerEntry> {
  const previous = reviewRoundEntries(fs.readdirSync(directory)).findLast(
    ({ number: candidate }) =>
      candidate < number && fs.existsSync(reviewFindingsFile(reviewRoundDirectory(directory, candidate))),
  )?.number;
  if (previous === undefined) {
    return [];
  }
  const prior = new Set(blockedEntries(directory, previous).map((entry) => entry.slot + '\0' + entry.reasonHash)),
    seen = new Set<string>(),
    blockers: Array<BlockerEntry> = [];
  for (const entry of blocked) {
    const key = entry.slot + '\0' + entry.reasonHash;
    if (!prior.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    blockers.push({ slot: entry.slot, reason: entry.reason, rounds: [previous, number] });
  }
  return blockers;
}

/** Blockers first, then blocked attempts, within the summary budget; the result keeps every entry. */
export function blockedNotice(blocked: ReadonlyArray<BlockedEntry>, blockers: ReadonlyArray<BlockerEntry>): string {
  const items = [
    ...blockers.map(
      (entry) => `orchestrator blocker ${entry.slot}: ${entry.reason} (rounds ${entry.rounds[0]}-${entry.rounds[1]})`,
    ),
    ...blocked.map((entry) => `blocked ${entry.slot}: ${entry.reason}`),
  ];
  const reserve = Buffer.byteLength(`; +${items.length} more blocked`, 'utf8'),
    shown: Array<string> = [];
  let bytes = 0;
  for (const item of items) {
    const text = clipBytes(item, 160),
      size = Buffer.byteLength(text, 'utf8') + 2;
    if (shown.length && bytes + size + reserve > BLOCKED_NOTICE_BYTES) {
      break;
    }
    shown.push(text);
    bytes += size;
  }
  const omitted = items.length - shown.length;
  return shown.join('; ') + (omitted ? `; +${omitted} more blocked` : '');
}
// NOTE: names take only the bytes the rest of the head leaves; the count and pointer stay even when the suffixes overflow, so the CLI cap cuts the suffixes first.
export function hotUnitsNotice(
  units: ReadonlyArray<{ unit: string; hot: boolean; hotStreak: number; delta?: number }>,
  restBytes: number,
): string {
  const hot = units.filter((unit) => unit.hot);
  if (!hot.length) {
    return '';
  }
  const names = hot.map(
    (unit) =>
      clipBytes(unit.unit, 40) +
      ' ×' +
      unit.hotStreak +
      (unit.delta === undefined ? '' : ' ' + (unit.delta < 0 ? '-' : '+') + Math.abs(unit.delta) + ' B'),
  );
  const text = (shown: number) =>
    `; ${hot.length} hot unit${hot.length === 1 ? '' : 's'}: ` +
    names.slice(0, shown).join(', ') +
    (shown === names.length ? '' : `${shown ? ', ' : ''}+${names.length - shown} more in findings.json units`);
  let shown = names.length;
  while (shown > 0 && Buffer.byteLength(text(shown), 'utf8') > 1024 - restBytes) {
    shown--;
  }
  return text(shown);
}
// Ids are `<kind>:<review>:<tail>`; only a later open record of the same id reopens a decision, so tool resolutions neither list nor remove one.
export function userDecisions(
  records: ReadonlyArray<LedgerRecord>,
  review: string,
  startSeq: number,
): Array<UserDecision> {
  const ofReview = records.filter(
    (row) => row.kind === 'escalation' && row.seq <= startSeq && String(row.data['id']).split(':')[1] === review,
  );
  return [...new Set(ofReview.map((row) => String(row.data['id'])))].flatMap((id) => {
    const rows = ofReview.filter((row) => String(row.data['id']) === id);
    const decision = rows.findLast(
      (row) => row.by === 'user' && row.data['state'] === 'resolved' && !!row.quote?.trim(),
    );
    if (!decision || rows.some((row) => row.seq > decision.seq && row.data['state'] === 'open')) {
      return [];
    }
    return [{ id, summary: String(decision.data['summary']), quote: present(decision.quote, 'the user quote') }];
  });
}

export function blockedStateFor(directory: string, number: number): BlockedState {
  const blocked = blockedEntries(directory, number);
  return { blocked, blockers: blockersFor(directory, number, blocked) };
}
