#!/usr/bin/env node

/**
 * @file scenarios.ts
 * @description Deterministic scenario selection for the static audit: validates the catalog, picks one variant per
 * mandatory class for five verb scopes and the shared scope, and emits per-scope packets into the run work directory.
 *
 * Usage: node <skill>/scripts/scenarios.ts --run <yyyy-mm-dd-hhmm> [--scopes plan,review] [--scenarios <id,id>]
 *          [--risk <risk.json>] [--prior <coverage.json>]
 *   Either narrowing flag marks the run partial; named scenarios limit their scopes to the named classes.
 *   risk.json:     [{ "kind": "change" | "defect" | "diagnostic", "path"?: "<repo path>", "scenario"?: "<id>", "note": "..." }]
 *   coverage.json: { "<scenario id>": <times traced by earlier audits> }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRun, updateRun } from './run-state.ts';

// ============================================================================
// SECTION: Types
// ============================================================================

export type ScenarioEntry = {
  id: string; scope: string; class: string; trigger: string; expectedOutcome: string; startingState: string; entries: string[]; kind?: string;
};
export type Catalog = { version: number; scenarios: ScenarioEntry[] };
export type RiskLead = { kind: 'change' | 'defect' | 'diagnostic'; path?: string; scenario?: string; note?: string };
export type SelectOptions = {
  catalog: Catalog;
  scope?: { scopes?: string[] | undefined; scenarios?: string[] | undefined } | undefined;
  priorCoverage?: Record<string, number> | undefined;
  risk?: RiskLead[] | undefined;
  /** Resolves a repo-relative entry path; defaults to the current checkout. */
  exists?: (repoPath: string) => boolean;
};
export type SelectedScenario = Omit<ScenarioEntry, 'scope'> & { reason: string };
export type Selection = {
  partial: boolean;
  scopes: { scope: string; scenarios: SelectedScenario[] }[];
  selected: string[];
  gaps: string[];
};
export type Packet = {
  scope: string; runId: string; partial: boolean; reference: string; findingsPath: string; evidence: string[];
  scenarios: SelectedScenario[]; gaps: string[];
};

// ============================================================================
// SECTION: Configuration
// ============================================================================

export const VERB_SCOPES = ['ask', 'design', 'plan', 'review', 'implement'] as const;
export const SCOPE_CLASSES: Record<string, readonly string[]> = {
  ...Object.fromEntries(VERB_SCOPES.map((verb) => [verb, ['normal', 'decision', 'recovery']])),
  shared: ['design-to-plan', 'plan-to-implement', 'review-to-fix', 'interruption-to-resume'],
};
const SCOPES = Object.keys(SCOPE_CLASSES);
const REVIEW_KINDS = ['code', 'design', 'plan'];
const RISK_WEIGHT: Record<RiskLead['kind'], number> = { defect: 3, change: 2, diagnostic: 1 };
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
export const DEFAULT_CATALOG_PATH = path.join(SKILL_DIR, 'references', 'scenarios.json');
const LINE_POINTER = /:\d+(?:-\d+)?$|#L\d+/;

// ============================================================================
// SECTION: Selection
// ============================================================================

export function loadCatalog(file: string = DEFAULT_CATALOG_PATH): Catalog {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
}

export function selectScenarios(options: SelectOptions): Selection {
  const exists = options.exists ?? ((p: string) => fs.existsSync(path.join(REPO_ROOT, ...p.split('/'))));
  validateCatalog(options.catalog, exists);
  const explicitIds = new Set(options.scope?.scenarios ?? []);
  for (const id of explicitIds) if (!options.catalog.scenarios.some((s) => s.id === id)) throw new Error(`unknown scenario ${id}`);
  const requested = options.scope?.scopes;
  for (const scope of requested ?? []) if (!SCOPES.includes(scope)) throw new Error(`unknown scope ${scope}`);
  const named = options.catalog.scenarios.filter((s) => explicitIds.has(s.id));
  // `--scenarios` alone narrows to the named scenarios' scopes; `--scopes` names the scopes explicitly.
  const narrowedScopes = requested ?? (named.length ? named.map((s) => s.scope) : undefined);
  const scopes = narrowedScopes ? SCOPES.filter((s) => narrowedScopes.includes(s)) : SCOPES;
  const gaps = SCOPES.filter((s) => !scopes.includes(s)).map((s) => `scope ${s} not selected (user-narrowed run)`);

  const result = scopes.map((scope) => {
    const usedKinds = new Set<string>();
    // A scope holding named scenarios traces only their classes; every other mandatory class is a recorded gap.
    const namedClasses = new Set(named.filter((s) => s.scope === scope).map((s) => s.class));
    const classes = (SCOPE_CLASSES[scope] ?? []).filter((cls) => namedClasses.size === 0 || namedClasses.has(cls));
    for (const cls of SCOPE_CLASSES[scope] ?? []) if (!classes.includes(cls)) gaps.push(`scope ${scope} class ${cls} not selected (user-narrowed run)`);
    const scenarios = classes.map((cls) => {
      const candidates = options.catalog.scenarios
        .filter((s) => s.scope === scope && s.class === cls)
        .map((s) => rank(s, explicitIds, usedKinds, options));
      candidates.sort(compareRanks);
      // validateCatalog guarantees at least one candidate per mandatory class.
      const pick = candidates[0] as Ranked;
      if (pick.entry.kind) usedKinds.add(pick.entry.kind);
      const { scope: _scope, ...fields } = pick.entry;
      return { ...fields, reason: pick.reason };
    });
    if (scope === 'review') {
      const missing = REVIEW_KINDS.filter((k) => !usedKinds.has(k));
      if (missing.length) gaps.push(`scope review leaves target kinds uncovered: ${missing.join(', ')}`);
    }
    return { scope, scenarios };
  });
  const selected = result.flatMap((s) => s.scenarios.map((x) => x.id));
  for (const s of named) if (!selected.includes(s.id)) gaps.push(`scenario ${s.id} not traced (${scopes.includes(s.scope) ? `class ${s.class} already covered` : `scope ${s.scope} not selected`})`);
  return { partial: narrowedScopes !== undefined, scopes: result, selected, gaps };
}

type Ranked = { entry: ScenarioEntry; explicit: boolean; newKind: boolean; risk: number; prior: number; reason: string };

function rank(entry: ScenarioEntry, explicitIds: Set<string>, usedKinds: Set<string>, options: SelectOptions): Ranked {
  const leads = (options.risk ?? []).filter((lead) =>
    lead.scenario === entry.id || (lead.path !== undefined && entry.entries.some((e) => e === lead.path || e.startsWith(`${lead.path}/`))));
  const risk = leads.reduce((sum, lead) => sum + RISK_WEIGHT[lead.kind], 0);
  const prior = options.priorCoverage?.[entry.id] ?? 0;
  const explicit = explicitIds.has(entry.id);
  const reason = explicit
    ? 'explicit: named by the user'
    : risk > 0
      ? `risk ${risk}: ${leads.map((l) => `${l.kind}${l.note ? ` (${l.note})` : ''}`).join(', ')}`
      : options.priorCoverage
        ? `rotation: traced ${prior} time(s) before`
        : 'stable order: no risk leads or prior coverage';
  return { entry, explicit, newKind: entry.kind !== undefined && !usedKinds.has(entry.kind), risk, prior, reason };
}

function compareRanks(a: Ranked, b: Ranked): number {
  return Number(b.explicit) - Number(a.explicit)
    || Number(b.newKind) - Number(a.newKind)
    || b.risk - a.risk
    || a.prior - b.prior
    || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);
}

function validateCatalog(catalog: Catalog, exists: (p: string) => boolean): void {
  if (catalog.version !== 1) throw new Error(`Scenario catalog: unsupported version ${String(catalog.version)} (expected 1)`);
  const seen = new Set<string>();
  for (const s of catalog.scenarios) {
    if (seen.has(s.id)) throw new Error(`Scenario catalog: duplicate id ${s.id}`);
    seen.add(s.id);
    const classes = SCOPE_CLASSES[s.scope];
    if (!classes) throw new Error(`Scenario catalog: ${s.id} has unknown scope ${s.scope}`);
    if (!classes.includes(s.class)) throw new Error(`Scenario catalog: ${s.id} has unknown class ${s.class} for scope ${s.scope}`);
    for (const field of ['trigger', 'expectedOutcome', 'startingState'] as const) {
      if (typeof s[field] !== 'string' || !s[field]) throw new Error(`Scenario catalog: ${s.id} lacks ${field}`);
    }
    if (s.kind !== undefined && !REVIEW_KINDS.includes(s.kind)) throw new Error(`Scenario catalog: ${s.id} has unknown review kind ${s.kind}`);
    if (!Array.isArray(s.entries) || s.entries.length === 0) throw new Error(`Scenario catalog: ${s.id} has no entry pointers`);
    for (const entry of s.entries) {
      // Line numbers drift with every edit; entries name files and auditors locate lines at trace time.
      if (LINE_POINTER.test(entry)) throw new Error(`Scenario catalog: ${s.id} entry ${entry} caches a line number`);
      if (!exists(entry)) throw new Error(`Scenario catalog: ${s.id} entry ${entry} does not exist`);
    }
  }
  for (const [scope, classes] of Object.entries(SCOPE_CLASSES)) {
    for (const cls of classes) {
      if (!catalog.scenarios.some((s) => s.scope === scope && s.class === cls)) throw new Error(`Scenario catalog: no ${scope} scenario for class ${cls}`);
    }
  }
}

// ============================================================================
// SECTION: Packets
// ============================================================================

export function buildPackets(selection: Selection, options: { runId: string }): Packet[] {
  const work = `.scratch/audits/${options.runId}-work`;
  return selection.scopes.map(({ scope, scenarios }) => ({
    scope,
    runId: options.runId,
    partial: selection.partial,
    // Relative to the skill directory, which differs per host.
    reference: scope === 'shared' ? 'references/shared.md' : 'references/walkthrough.md',
    findingsPath: `${work}/findings/${scope}.md`,
    evidence: [`${work}/manifest.json`, `${work}/tests.txt`, `${work}/metrics.md`],
    scenarios,
    gaps: selection.gaps,
  }));
}

/**
 * Writes every packet, then records the selection in the run manifest: a recorded selection always has its
 * packets, and an interrupted emit leaves no selection, so rerunning regenerates the same packets idempotently.
 */
export function emitPackets(
  workDir: string, selection: Selection, options: { runId: string; writeFile?: (file: string, text: string) => void },
): Packet[] {
  const packets = buildPackets(selection, options);
  const write = options.writeFile ?? writeAtomic;
  const dir = path.join(workDir, 'packets');
  fs.mkdirSync(dir, { recursive: true });
  for (const packet of packets) write(path.join(dir, `${packet.scope}.json`), `${JSON.stringify(packet, null, 2)}
`);
  updateRun(workDir, (m) => {
    Object.assign(m, { scenarios: { selected: selection.selected, partial: selection.partial, gaps: selection.gaps } });
    for (const packet of packets) {
      m.scopes[packet.scope] ??= { lifecycle: 'pending', handle: null, budgets: {}, resultPath: packet.findingsPath, gaps: [] };
    }
  });
  return packets;
}

function writeAtomic(file: string, text: string): void {
  // A same-directory rename never leaves a half-written packet behind.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

// ============================================================================
// SECTION: CLI
// ============================================================================

function main(argv: string[]): void {
  const flag = (name: string) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const list = (name: string) => flag(name)?.split(',').map((s) => s.trim()).filter(Boolean);
  const runId = flag('--run');
  if (!runId || !/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(runId)) throw new Error('Missing or malformed --run <yyyy-mm-dd-hhmm>');
  const workDir = path.join(REPO_ROOT, '.scratch', 'audits', `${runId}-work`);
  const manifest = readRun(workDir) as ReturnType<typeof readRun> & { scenarios?: unknown };
  if (manifest.scenarios) throw new Error(`Run ${runId} already has a scenario selection; reuse packets/ in its work directory.`);
  const scopes = list('--scopes');
  const scenarios = list('--scenarios');
  const readJson = (name: string) => { const file = flag(name); return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
  const selection = selectScenarios({
    catalog: loadCatalog(),
    scope: scopes || scenarios ? { scopes, scenarios } : undefined,
    risk: readJson('--risk') as RiskLead[] | undefined,
    priorCoverage: readJson('--prior') as Record<string, number> | undefined,
  });
  emitPackets(workDir, selection, { runId });
  const lines = selection.scopes.map((s) => `${s.scope}: ${s.scenarios.map((x) => `${x.id} (${x.reason})`).join('; ')}`);
  process.stdout.write(`${[...lines, `partial: ${selection.partial}`, ...selection.gaps.map((g) => `gap: ${g}`)].join('\n')}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
