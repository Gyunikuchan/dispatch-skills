// Review roster (spec §6.5 step 1, §14): level → phase policy (`targets`, `only`) → pins → orchestrator
// demotion in config order → `-m`/`-e` collapse → native marking → reserves.

import type { RosterSlot } from "../toolkit/domain/types.ts";
import type { Level, SlotId } from "../toolkit/types.ts";

export const LEVELS: readonly Level[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

interface ProviderAliases {
  readonly [alias: string]: string | undefined;
}

const PROVIDER_ALIASES: ProviderAliases = {
  opencode: "opencode",
  agy: "agy",
  antigravity: "agy",
  claude: "claude",
  claudecode: "claude",
  "claude-code": "claude",
  copilot: "copilot",
  "github-copilot": "copilot",
  codex: "codex",
  "openai-codex": "codex",
};

const SANDBOX_PROVIDERS: ReadonlySet<string> = new Set([
  "claude",
  "copilot",
  "opencode",
  "codex",
]);

export const normalizeProvider = (key: string) =>
  PROVIDER_ALIASES[key.toLowerCase()] ?? key;

// SECTION: Sparse level maps

export type LevelMap<T> = Partial<Record<Level, T>>;

/** Exact level, else the nearest defined below, else the lowest defined above. */
const selectLevel = (defined: readonly Level[], level: Level) => {
  const requested = LEVELS.indexOf(level);

  const ordered = [...defined].toSorted(
    (a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b)
  );

  return (
    ordered.findLast((item) => LEVELS.indexOf(item) <= requested) ??
    ordered.find((item) => LEVELS.indexOf(item) > requested)
  );
};

export const resolveLevel = <T>(
  map: LevelMap<T> | undefined,
  level: Level
): T | undefined => {
  if (map === undefined) {
    return undefined;
  }

  const chosen = selectLevel(
    LEVELS.filter((item) => map[item] !== undefined),
    level
  );

  return chosen === undefined ? undefined : map[chosen];
};

// SECTION: Utility subagent

export interface SubagentEntry {
  model: string | string[];
  effort?: string;
}

export interface ResolvedSubagent {
  models: string[];
  effort: string | null;
}

export const resolveSubagent = (entry: SubagentEntry) => ({
  models: typeof entry.model === "string" ? [entry.model] : entry.model,
  effort: entry.effort ?? null,
});

export type UtilityEntry = SubagentEntry & { "context-limit": number };

export type ResolvedUtility = ResolvedSubagent & { contextLimit: number };

/** Per canonical platform: its utility-subagents entry; independent of run level. */
export const resolveUtility = (utility: Record<string, UtilityEntry>) =>
  Object.fromEntries(
    Object.entries(utility).flatMap(([key, entry]) =>
      typeof entry["context-limit"] === "number"
        ? [
            [
              normalizeProvider(key),
              {
                ...resolveSubagent(entry),
                contextLimit: entry["context-limit"],
              },
            ],
          ]
        : []
    )
  );

// SECTION: Pins

export type Pins =
  | { kind: "providers"; keys: readonly string[] }
  | { kind: "count"; count: number }
  | { kind: "all" };

/** Parses `(a,b)`, `(3)`, or `(all)`; a count or `all` must stand alone. */
export const parsePins: (text: string) => Pins = (text) => {
  const inner = /^\(\s*(?<rg1>.*?)\s*\)$/u.exec(text.trim())?.[1];

  if (inner === undefined || !inner) {
    throw new Error(`Pins must be (a,b), (<count>), or (all); got ${text}`);
  }

  const items = inner
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const special = items.some(
    (item) => /^-?\d+$/u.test(item) || item.toLowerCase() === "all"
  );

  if (special) {
    if (items.length > 1) {
      throw new Error(
        `A count or "all" pin must stand alone: ${items.join(", ")}`
      );
    }

    const only = items[0] ?? "";

    if (only.toLowerCase() === "all") {
      return { kind: "all" };
    }

    const count = Number(only);

    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("A count pin must be a positive integer");
    }

    return { kind: "count", count };
  }

  return {
    kind: "providers",
    keys: [...new Set(items.map(normalizeProvider))],
  };
};

// SECTION: Roster

interface TargetEntry {
  model?: string | readonly string[];
  effort?: string;
}

export interface ReadDelegate {
  targets?: readonly LevelMap<TargetEntry>[];
  nativeSubagentsOnly?: boolean;
  sandbox?: boolean;
}

export interface PhasePolicy {
  targets?: LevelMap<number | "all">;
  rounds?: LevelMap<number>;
  only?: readonly string[];
}

interface Overrides {
  model?: string;
  effort?: string;
}

export interface Orchestrator {
  platform: string;
}

export interface RosterInput {
  level: Level;
  readDelegates: Readonly<Record<string, ReadDelegate>>;
  /** Absent → standalone default: one target, one round. */
  policy?: PhasePolicy;
  pins?: Pins | null;
  overrides?: Overrides;
  orchestrator: Orchestrator | null;
  /** Unpinned selection keeps only live providers; absent means every provider is live. */
  liveness?: Readonly<Record<string, boolean>>;
  /** Unpinned selection drops a sandboxed provider marked false; absent means every provider is supported. */
  sandboxSupported?: Readonly<Record<string, boolean>>;
}

export interface Underfill {
  host: string | null;
  configured: number | "all";
  resolved: number;
  excluded: string[];
  sandboxUnsupported?: string[];
}

/** `underfill` is present when native-only providers were excluded, sandbox-unsupported providers were dropped or breadth fell short of a numeric configuration. */
export interface Roster {
  rounds: number;
  targets: readonly RosterSlot[];
  reserves: readonly RosterSlot[];
  underfill?: Underfill;
}

type Candidate = Omit<RosterSlot, "slot" | "index" | "reserve">;

const candidates = (input: RosterInput) => {
  const only = input.policy?.only
    ? new Set(input.policy.only.map(normalizeProvider))
    : null;

  return Object.entries(input.readDelegates).flatMap(([key, delegate]) => {
    const provider = normalizeProvider(key);

    if (only && !only.has(provider)) {
      return [];
    }

    const sandbox = SANDBOX_PROVIDERS.has(provider)
      ? (delegate.sandbox ?? true)
      : undefined;

    return (delegate.targets ?? []).map((map) => {
      const entry = resolveLevel(map, input.level) ?? {};

      const candidate: Candidate = {
        provider,
        native: delegate.nativeSubagentsOnly === true,
      };

      if (entry.model !== undefined) {
        candidate.model = entry.model;
      }

      if (entry.effort !== undefined) {
        candidate.effort = entry.effort;
      }

      if (sandbox !== undefined) {
        candidate.sandbox = sandbox;
      }

      return candidate;
    });
  });
};

/** Alternatives first, then the orchestrator platform; config order preserved. */
const demote = (
  list: readonly Candidate[],
  orchestrator: Orchestrator | null
) => {
  if (!orchestrator) {
    return [...list];
  }

  const own = (item: Candidate) => item.provider === orchestrator.platform;

  return [...list.filter((item) => !own(item)), ...list.filter(own)];
};

/** `-m`/`-e` collapse each platform to its first candidate carrying the override. */
const collapse = (
  list: readonly Candidate[],
  overrides: Overrides | undefined
) => {
  if (overrides?.model === undefined && overrides?.effort === undefined) {
    return [...list];
  }

  const seen = new Set<string>();

  return list.flatMap((item) => {
    if (seen.has(item.provider)) {
      return [];
    }

    seen.add(item.provider);
    const next: Candidate = { ...item };

    if (overrides.model !== undefined) {
      next.model = overrides.model;
    }

    if (overrides.effort !== undefined) {
      next.effort = overrides.effort;
    }

    return [next];
  });
};

/** Positional identity `${provider}[${index}]`, counted per provider across targets then reserves. */
const identify = (
  targets: readonly Candidate[],
  reserves: readonly Candidate[]
) => {
  const counters = new Map<string, number>();

  const slot = (reserve: boolean) => (item: Candidate) => {
    const index = counters.get(item.provider) ?? 0;
    counters.set(item.provider, index + 1);
    const id: SlotId = `${item.provider}[${index}]`;

    return { ...item, slot: id, index, reserve };
  };

  return [targets.map(slot(false)), reserves.map(slot(true))];
};

export const nativeFirstRoute = (
  provider: string,
  readDelegates: Readonly<Record<string, ReadDelegate>>,
  orchestrator: Orchestrator | null
) => {
  if (!orchestrator) {
    return false;
  }

  const host = normalizeProvider(orchestrator.platform);

  if (normalizeProvider(provider) !== host) {
    return false;
  }

  const delegate = Object.entries(readDelegates).find(
    ([key]) => normalizeProvider(key) === host
  )?.[1];

  if (delegate?.nativeSubagentsOnly === true) {
    return false;
  }

  return true;
};

const resolveRounds = (policy: PhasePolicy | undefined, level: Level) =>
  policy === undefined ? 1 : (resolveLevel(policy.rounds, level) ?? 0);

const resolveWanted = (input: RosterInput, pins: Pins | null) => {
  if (pins?.kind === "all") {
    return "all";
  }

  if (pins?.kind === "count") {
    return pins.count;
  }

  if (input.policy) {
    return resolveLevel(input.policy.targets, input.level) ?? 0;
  }

  return 1;
};

const isLive = (
  item: Candidate,
  explicit: boolean,
  liveness: RosterInput["liveness"],
  hostProvider: string | null
) =>
  explicit ||
  liveness === undefined ||
  liveness[item.provider] === true ||
  item.native ||
  item.provider === hostProvider;

const isBlocked = (
  item: Candidate,
  explicit: boolean,
  hostProvider: string | null,
  sandboxSupported: RosterInput["sandboxSupported"]
) =>
  !explicit &&
  !item.native &&
  item.provider !== hostProvider &&
  item.sandbox === true &&
  sandboxSupported?.[item.provider] === false;

const underfillFor = (
  host: string | null,
  configured: number | "all",
  resolved: number,
  excluded: string[],
  sandboxUnsupported: string[],
  short: boolean
) =>
  excluded.length > 0 || short || sandboxUnsupported.length > 0
    ? {
        host,
        configured,
        resolved,
        excluded,
        ...(sandboxUnsupported.length > 0 && { sandboxUnsupported }),
      }
    : undefined;

export const resolveRoster = (input: RosterInput) => {
  const { policy } = input;
  const rounds = resolveRounds(policy, input.level);
  const pins = input.pins ?? null;
  const wanted = resolveWanted(input, pins);

  // `targets: 0` disables the phase like `rounds: 0`, unless a pin overrides breadth.
  if (rounds <= 0 || (!pins && wanted === 0)) {
    return { rounds: 0, targets: [], reserves: [] };
  }

  const orchestrator = input.orchestrator
    ? {
        ...input.orchestrator,
        platform: normalizeProvider(input.orchestrator.platform),
      }
    : null;

  // A native-subagents-only platform serves only as the orchestrator's own native subagents.
  const all = candidates(input);

  const usable = all.filter(
    (item) => !item.native || item.provider === orchestrator?.platform
  );

  if (pins?.kind === "providers") {
    const unknown = pins.keys.filter(
      (key) => !usable.some((item) => item.provider === key)
    );

    if (unknown.length > 0) {
      throw new Error(`Pinned platform not available: ${unknown.join(", ")}`);
    }

    const pinned = pins.keys.flatMap((key) =>
      usable.filter((item) => item.provider === key)
    );

    const [targets = []] = identify(collapse(pinned, input.overrides), []);

    return { rounds, targets, reserves: [] };
  }

  const explicit = pins !== null;
  const hostProvider = orchestrator?.platform ?? null;

  const live = usable.filter((item) =>
    isLive(item, explicit, input.liveness, hostProvider)
  );

  const blocked = (item: Candidate) =>
    isBlocked(item, explicit, hostProvider, input.sandboxSupported);

  const ordered = collapse(
    demote(
      live.filter((item) => !blocked(item)),
      orchestrator
    ),
    input.overrides
  );

  const count =
    wanted === "all" ? ordered.length : Math.min(wanted, ordered.length);

  const [targets = [], reserves = []] = identify(
    ordered.slice(0, count),
    ordered.slice(count)
  );

  const excluded = [
    ...new Set(
      all
        .filter(
          (item) => item.native && item.provider !== orchestrator?.platform
        )
        .map((item) => item.provider)
    ),
  ];

  const short = wanted !== "all" && count < wanted;

  const sandboxUnsupported = [
    ...new Set(live.filter(blocked).map((item) => item.provider)),
  ];

  const underfill = underfillFor(
    orchestrator?.platform ?? null,
    wanted,
    count,
    excluded,
    sandboxUnsupported,
    short
  );

  return { rounds, targets, reserves, ...(underfill && { underfill }) };
};
