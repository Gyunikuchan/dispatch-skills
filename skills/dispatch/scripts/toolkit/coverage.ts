import fs from 'node:fs';
import path from 'node:path';
import type { ConfirmationRound } from './confirmations.ts';
import type { SlotOutcome } from './fanout.ts';
import { read } from './findings.ts';
import type { Fold } from './ledger.ts';
import { ToolError } from './output.ts';
import { coverageDecision } from './records.ts';

export type CoverageDecision = 'none' | 'rerun' | 'majority' | 'user';
export type CoverageState = {
  targets: string[];      // saved non-reserve logical slots across applicable rounds
  completed: string[];    // closed targets whose latest event in applicable rounds is a whole-target completion
  open: string[];         // failed targets with no later whole-target completion and no override
  overridden: {slot: string; quote: string; seq: number}[];
  coverageRounds: number[]; // round numbers that carry a `coverage` field
  freeUsed: boolean;      // a round before the current incomplete round has `coverageUse: 'free'`
  unusedGrant: boolean;   // grant records outnumber such rounds with `coverageUse: 'grant'`
  incomplete: number | null; // latest applicable round when it has no findings.json and not every slot failed
  decision: CoverageDecision;
};
export type CoverageApplies = (metadata: ConfirmationRound['metadata']) => boolean;
type Metadata = ConfirmationRound['metadata'] & {scope?: string; coverage?: 'open' | 'full'; coverageUse?: 'free' | 'grant'};
type Attempt = {slot: string; seq: number; wholeTarget: boolean};
type Tracked = {complete: boolean; failures: {seq: number; whole: boolean}[]; last: number};
const numbered = (names: string[], pattern: RegExp) => names.filter(name => pattern.test(name)).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));

/**
 * Folds saved round files and user records into per-slot coverage. Failures come from every generation's attempts.json;
 * completions come from the current generation of a finalized round. It writes nothing; unreadable files fail closed.
 */
export function coverageState(session: string, fold: Fold, review: string, applies: CoverageApplies = () => true): CoverageState {
  const root = path.join(session, '.state/reviews', review);
  const unreadable = (file: string): never => { throw new ToolError(4, 'coverage-required', 'Cannot establish coverage for ' + review + ': ' + path.relative(root, file)); };
  const load = <T>(file: string): T | null => { try { return read<T>(file); } catch { return unreadable(file); } };
  const rounds = numbered(fs.existsSync(root) ? fs.readdirSync(root) : [], /^round-\d+$/).flatMap(name => {
    const dir = path.join(root, name), metadata = load<Metadata>(path.join(dir, 'round.json'));
    if (!metadata) return []; // no round file: the round never started
    if (!metadata.spec?.path || !metadata.target || !Array.isArray(metadata.roster) || !Number.isSafeInteger(metadata.generation)) unreadable(path.join(dir, 'round.json'));
    if (!applies(metadata)) return [];
    const attempts = numbered(fs.readdirSync(dir), /^gen-\d+$/).flatMap(gen => {
      const list = load<Attempt[]>(path.join(dir, gen, 'attempts.json')) ?? [];
      if (!Array.isArray(list) || list.some(item => typeof item?.slot !== 'string' || !Number.isSafeInteger(item.seq) || typeof item.wholeTarget !== 'boolean')) unreadable(path.join(dir, gen, 'attempts.json'));
      return list.map(item => ({...item, gen}));
    });
    const slots = metadata.roster.filter(slot => !slot.reserve).map(slot => slot.slot);
    const saved = slots.map(slot => [slot, load<SlotOutcome>(path.join(dir, 'gen-' + metadata.generation, 'slots', slot + '.json'))] as const);
    for (const [slot, outcome] of saved) if (outcome?.state === 'failed' && !attempts.some(item => item.slot === slot && item.gen === 'gen-' + metadata.generation)) unreadable(path.join(dir, 'gen-' + metadata.generation, 'slots', slot + '.json'));
    return [{number: Number(name.slice(6)), metadata, slots, attempts, saved, finalized: fs.existsSync(path.join(dir, 'findings.json')),
      whole: !!metadata.scope?.startsWith('Full review') || metadata.coverage !== undefined, allFailed: saved.length > 0 && saved.every(([, outcome]) => outcome?.state === 'failed')}];
  });
  const targets = [...new Set(rounds.flatMap(round => round.slots))], tracked = new Map<string, Tracked>();
  const slotOf = (slot: string) => tracked.get(slot) ?? tracked.set(slot, {complete: false, failures: [], last: -1}).get(slot)!;
  for (const round of rounds) {
    for (const item of round.attempts) Object.assign(slotOf(item.slot), {complete: false, failures: [...slotOf(item.slot).failures, {seq: item.seq, whole: item.wholeTarget}], last: Math.max(slotOf(item.slot).last, item.seq)});
    if (round.finalized && round.whole) for (const [slot, outcome] of round.saved) if (outcome?.state === 'done') Object.assign(slotOf(slot), {complete: true, failures: []});
  }
  const decisions = fold.records.filter(row => row.kind === 'escalation' && row.by === 'user' && row.data['state'] === 'resolved' && !!row.quote?.trim() && String(row.data['id']).startsWith('coverage:' + review + ':'))
    .map(row => ({row, decision: coverageDecision(row.data['summary'])}));
  const open: string[] = [], overridden: CoverageState['overridden'] = [];
  for (const slot of targets) {
    const item = slotOf(slot);
    if (!item.failures.length) continue;
    const cover = decisions.findLast(({row, decision}) => row.seq > item.last && !!decision && 'accept' in decision && decision.accept.includes(slot));
    if (cover) overridden.push({slot, quote: cover.row.quote!, seq: cover.row.seq}); else open.push(slot);
  }
  const latest = rounds.at(-1), incomplete = latest && !latest.finalized && !latest.allFailed ? latest.number : null;
  const completed = targets.filter(slot => slotOf(slot).complete), rerun = (slot: string) => slotOf(slot).failures.slice(1).some(failure => failure.whole);
  const decision: CoverageDecision = incomplete !== null ? 'rerun' : !open.length ? 'none' : !open.every(rerun) ? 'rerun' : completed.length * 2 > targets.length ? 'majority' : 'user';
  return {targets, completed, open, overridden, coverageRounds: rounds.filter(round => round.metadata.coverage !== undefined).map(round => round.number), decision, incomplete,
    freeUsed: rounds.some(round => round.metadata.coverageUse === 'free' && round.number !== incomplete),
    unusedGrant: decisions.filter(({decision}) => !!decision && 'grant' in decision).length > rounds.filter(round => round.metadata.coverageUse === 'grant').length};
}
