// Review roster (spec §6.5 step 1, §14): level → phase policy (`targets`, `only`) → pins → diversity sort with
// orchestrator demotion → `-m`/`-e` collapse → native marking → reserves.

import type { Level, SlotId } from '../core/types.ts';
import type { RosterSlot } from '../domain/types.ts';

export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  opencode: 'opencode', agy: 'agy', antigravity: 'agy', claude: 'claude', claudecode: 'claude', 'claude-code': 'claude',
  copilot: 'copilot', 'github-copilot': 'copilot', codex: 'codex', 'openai-codex': 'codex',
};
const SANDBOX_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'copilot', 'opencode', 'codex']);

export const normalizeProvider = (key: string): string => PROVIDER_ALIASES[key.toLowerCase()] ?? key;

// SECTION: Sparse level maps

export type LevelMap<T> = Partial<Record<Level, T>>;

/** Exact level, else the nearest defined below, else the lowest defined above. */
export function selectLevel(defined: readonly Level[], level: Level): Level | undefined {
  const requested = LEVELS.indexOf(level);
  const ordered = [...defined].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
  return ordered.findLast((item) => LEVELS.indexOf(item) <= requested) ?? ordered.find((item) => LEVELS.indexOf(item) > requested);
}

export function resolveLevel<T>(map: LevelMap<T> | undefined, level: Level): T | undefined {
  if (!map) return undefined;
  const chosen = selectLevel(LEVELS.filter((item) => map[item] !== undefined), level);
  return chosen === undefined ? undefined : map[chosen];
}

// SECTION: Pins

export type Pins = { kind: 'providers'; keys: readonly string[] } | { kind: 'count'; count: number } | { kind: 'all' };

/** Parses `(a,b)`, `(3)`, or `(all)`; a count or `all` must stand alone. */
export function parsePins(text: string): Pins {
  const inner = /^\(\s*(.*?)\s*\)$/.exec(text.trim())?.[1];
  if (inner === undefined || !inner) throw new Error(`Pins must be (a,b), (<count>), or (all); got ${text}`);
  const items = inner.split(',').map((item) => item.trim()).filter(Boolean);
  const special = items.some((item) => /^-?\d+$/.test(item) || item.toLowerCase() === 'all');
  if (special) {
    if (items.length > 1) throw new Error(`A count or "all" pin must stand alone: ${items.join(', ')}`);
    const only = items[0] ?? '';
    if (only.toLowerCase() === 'all') return { kind: 'all' };
    const count = Number(only);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('A count pin must be a positive integer');
    return { kind: 'count', count };
  }
  return { kind: 'providers', keys: [...new Set(items.map(normalizeProvider))] };
}

// SECTION: Ordering

/** Every key's first candidate before any repeat, preserving input order. */
export function diversitySort<T>(candidates: readonly T[], key: (candidate: T) => unknown): T[] {
  const seen = new Set<unknown>();
  const firsts: T[] = [];
  const repeats: T[] = [];
  for (const candidate of candidates) {
    const value = key(candidate);
    if (seen.has(value)) repeats.push(candidate);
    else { seen.add(value); firsts.push(candidate); }
  }
  return [...firsts, ...repeats];
}

/** Strips a provider prefix and a `-YYYYMMDD` suffix, lowercased. */
export function normalizeModelId(model: string): string {
  const id = model.trim();
  return id.slice(id.lastIndexOf('/') + 1).replace(/-(?:20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/, '').toLowerCase();
}

export function isSameModel(candidate: string | readonly string[] | undefined, orchestratorModel: string | null): boolean {
  if (!orchestratorModel || !candidate) return false;
  const target = normalizeModelId(orchestratorModel);
  if (!target) return false;
  const models = typeof candidate === 'string' ? [candidate] : candidate;
  return models.some((model) => normalizeModelId(model) === target);
}

// SECTION: Roster

export type TargetEntry = { model?: string | readonly string[]; effort?: string };
export type ReadDelegate = { targets?: readonly LevelMap<TargetEntry>[]; nativeSubagentsOnly?: boolean; sandbox?: boolean };
export type PhasePolicy = { targets?: LevelMap<number | 'all'>; rounds?: LevelMap<number>; only?: readonly string[] };
export type Overrides = { model?: string; effort?: string };
export type Orchestrator = { platform: string; model: string | null };

export type RosterInput = {
  level: Level;
  readDelegates: Readonly<Record<string, ReadDelegate>>;
  /** Absent → standalone default: one target, one round. */
  policy?: PhasePolicy;
  pins?: Pins | null;
  overrides?: Overrides;
  orchestrator: Orchestrator | null;
  /** Unpinned selection keeps only live providers; absent means every provider is live. */
  liveness?: Readonly<Record<string, boolean>>;
};

export type Roster = { rounds: number; targets: readonly RosterSlot[]; reserves: readonly RosterSlot[] };

type Candidate = Omit<RosterSlot, 'slot' | 'index' | 'reserve'>;

function candidates(input: RosterInput): Candidate[] {
  const only = input.policy?.only ? new Set(input.policy.only.map(normalizeProvider)) : null;
  return Object.entries(input.readDelegates).flatMap(([key, delegate]) => {
    const provider = normalizeProvider(key);
    if (only && !only.has(provider)) return [];
    const sandbox = SANDBOX_PROVIDERS.has(provider) ? delegate.sandbox ?? true : undefined;
    return (delegate.targets ?? []).map((map): Candidate => {
      const entry = resolveLevel(map, input.level) ?? {};
      const candidate: Candidate = { provider, native: delegate.nativeSubagentsOnly === true };
      if (entry.model !== undefined) candidate.model = entry.model;
      if (entry.effort !== undefined) candidate.effort = entry.effort;
      if (sandbox !== undefined) candidate.sandbox = sandbox;
      return candidate;
    });
  });
}

/** Alternatives first, then the orchestrator platform's other models, then its own model; each group diversity-sorted. */
function demote(list: readonly Candidate[], orchestrator: Orchestrator | null, sort: boolean): Candidate[] {
  const group = (items: readonly Candidate[]) => (sort ? diversitySort(items, (item) => item.provider) : [...items]);
  if (!orchestrator) return group(list);
  const own = (item: Candidate) => item.provider === orchestrator.platform;
  const same = (item: Candidate) => own(item) && isSameModel(item.model, orchestrator.model);
  return [...group(list.filter((item) => !own(item))), ...group(list.filter((item) => own(item) && !same(item))), ...group(list.filter(same))];
}

/** `-m`/`-e` collapse each platform to its first candidate carrying the override. */
function collapse(list: readonly Candidate[], overrides: Overrides | undefined): Candidate[] {
  if (overrides?.model === undefined && overrides?.effort === undefined) return [...list];
  const seen = new Set<string>();
  return list.flatMap((item) => {
    if (seen.has(item.provider)) return [];
    seen.add(item.provider);
    const next: Candidate = { ...item };
    if (overrides.model !== undefined) next.model = overrides.model;
    if (overrides.effort !== undefined) next.effort = overrides.effort;
    return [next];
  });
}

/** Positional identity `${provider}[${index}]`, counted per provider across targets then reserves. */
function identify(targets: readonly Candidate[], reserves: readonly Candidate[]): Roster['targets'][] {
  const counters = new Map<string, number>();
  const slot = (reserve: boolean) => (item: Candidate): RosterSlot => {
    const index = counters.get(item.provider) ?? 0;
    counters.set(item.provider, index + 1);
    const id: SlotId = `${item.provider}[${index}]`;
    return { ...item, slot: id, index, reserve };
  };
  return [targets.map(slot(false)), reserves.map(slot(true))];
}

export function resolveRoster(input: RosterInput): Roster {
  const policy = input.policy;
  const rounds = policy ? resolveLevel(policy.rounds, input.level) ?? 0 : 1;
  const pins = input.pins ?? null;
  const wanted = pins?.kind === 'all' ? 'all' : pins?.kind === 'count' ? pins.count : policy ? resolveLevel(policy.targets, input.level) ?? 0 : 1;
  // `targets: 0` disables the phase like `rounds: 0`, unless a pin overrides breadth.
  if (rounds <= 0 || (!pins && wanted === 0)) return { rounds: 0, targets: [], reserves: [] };

  const orchestrator = input.orchestrator ? { ...input.orchestrator, platform: normalizeProvider(input.orchestrator.platform) } : null;
  // A native-subagents-only platform serves only as the orchestrator's own native subagents.
  const usable = candidates(input).filter((item) => !item.native || item.provider === orchestrator?.platform);

  if (pins?.kind === 'providers') {
    const unknown = pins.keys.filter((key) => !usable.some((item) => item.provider === key));
    if (unknown.length) throw new Error(`Pinned platform not available: ${unknown.join(', ')}`);
    const pinned = pins.keys.flatMap((key) => usable.filter((item) => item.provider === key));
    const [targets = []] = identify(collapse(pinned, input.overrides), []);
    return { rounds, targets, reserves: [] };
  }
  const explicit = pins !== null;
  const live = usable.filter((item) => explicit || input.liveness === undefined || input.liveness[item.provider] === true || item.native);
  const ordered = collapse(demote(live, orchestrator, !explicit), input.overrides);
  const count = wanted === 'all' ? ordered.length : Math.min(wanted, ordered.length);
  const [targets = [], reserves = []] = identify(ordered.slice(0, count), ordered.slice(count));
  return { rounds, targets, reserves };
}
