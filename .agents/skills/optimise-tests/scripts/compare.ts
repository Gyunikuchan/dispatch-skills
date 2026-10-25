import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Failure, Inventory } from './inventory.ts';

export type TestReference = { file: string; name: string; line?: number };
export type ActionKind = 'delete' | 'merge' | 'add' | 'rewrite' | 'move' | 'split';
export type DeletionCategory = 'redundant-behavior' | 'implementation-coupled-assertion' | 'self-derived-assertion' | 'synthetic/no-required-contract' | 'trivial-spec' | 'coverage-padding' | 'transient-leak';

export interface ActionEvidence {
  kind: 'action';
  id: string;
  action: ActionKind;
  before: TestReference[];
  after: TestReference[];
  reason: string;
  category?: DeletionCategory;
}

export interface RetainedScenarioEvidence {
  kind: 'retain';
  contract: string;
  plausibleDefect: string;
  observableOutcome: string;
  distinctContribution: string;
  before: TestReference[];
  after: TestReference[];
}

export interface SavingsEvidence {
  kind: 'savings';
  scenariosRemoved?: number;
  casesRemoved?: number;
  cosmeticTableMerges?: number;
  repeatedSetupCallsReduced?: number;
  evidence: string;
}

export type LedgerEntry = ActionEvidence | RetainedScenarioEvidence | SavingsEvidence;
export type LedgerInput = unknown;

export interface CoverageDrop {
  path: string;
  before: number;
  after: number;

}

export interface Comparison {
  ok: boolean;
  coverageDrops: CoverageDrop[];
  failures: Failure[];
  evidenceErrors: string[];
  markdown: string;
}

interface Tally { files: number; tests: number; durationMs: number }
interface ResolvedAction extends ActionEvidence { before: TestReference[]; after: TestReference[] }
interface ResolvedScenario extends RetainedScenarioEvidence { before: TestReference[]; after: TestReference[] }
interface SavingsValues {
  scenariosRemoved?: number;
  casesRemoved?: number;
  cosmeticTableMerges?: number;
  repeatedSetupCallsReduced?: number;
  evidence: string;
}

// SECTION: Inventory identities and evidence validation

const toPosix = (value: string) => value.replace(/\\/g, '/');
const normalizedInventoryPath = (value: string) => path.posix.normalize(toPosix(value)).replace(/^\.\//, '');
const lexicalCompare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const arrayOf = (value: unknown): value is unknown[] => Array.isArray(value);
const sameReportedIdentity = (left: TestReference, right: TestReference) => left.file === right.file && left.name === right.name;

function tallyByUnit(inventory: Inventory): Map<string, Tally> {
  const units = new Map<string, Tally>();
  for (const file of inventory.files) {
    const tally = units.get(file.unit) ?? { files: 0, tests: 0, durationMs: 0 };
    tally.files += 1;
    tally.tests += file.tests.length;
    tally.durationMs += file.durationMs;
    units.set(file.unit, tally);
  }
  return units;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, errors: string[]): boolean {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) errors.push(`${where}: unsupported field${extra.length === 1 ? '' : 's'} ${extra.join(', ')}`);
  return extra.length === 0;
}

function normalizedRepoPath(value: unknown, where: string, errors: string[]): string | undefined {
  if (!nonblank(value)) {
    errors.push(`${where}: file path must be a nonblank repo-relative path`);
    return undefined;
  }
  const posix = toPosix(value.trim());
  const normalized = path.posix.normalize(posix);
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix) || posix.split('/').includes('..') || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    errors.push(`${where}: file path must stay inside the repository`);
    return undefined;
  }
  return normalized.replace(/^\.\//, '');
}

function resolveReference(value: unknown, snapshot: Inventory, where: string, errors: string[]): TestReference | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: test reference must be an object`);
    return undefined;
  }
  hasOnlyKeys(value, ['file', 'name', 'line'], where, errors);
  const file = normalizedRepoPath(value['file'], where, errors);
  const name = value['name'];
  if (!nonblank(name)) errors.push(`${where}: test name must be a nonblank exact reported name`);
  const line = value['line'];
  if (line !== undefined && (!Number.isInteger(line) || (line as number) < 1)) errors.push(`${where}: line must be a positive integer`);
  if (!file || !nonblank(name) || (line !== undefined && (!Number.isInteger(line) || (line as number) < 1))) return undefined;

  const sameFile = snapshot.files.filter((entry) => normalizedInventoryPath(entry.path) === file);
  const matches = sameFile.flatMap((entry) => entry.tests.filter((test) => test.name === name).map((test) => ({ line: test.line })));
  if (!matches.length) {
    errors.push(`${where}: ${file}:${name} does not exist in this inventory`);
    return undefined;
  }
  if (matches.length > 1 && line === undefined) {
    errors.push(`${where}: ${file}:${name} is ambiguous; include its inventory line`);
    return undefined;
  }
  const matchingLines = line === undefined ? matches : matches.filter((test) => test.line === line);
  if (matchingLines.length !== 1) {
    errors.push(`${where}: ${file}:${name}${line === undefined ? '' : `:${line}`} is absent or ambiguous in this inventory`);
    return undefined;
  }
  return { file, name, ...(matches.length > 1 ? { line: line as number } : {}) };
}

function resolveMembers(value: unknown, snapshot: Inventory, where: string, errors: string[]): TestReference[] | undefined {
  if (!arrayOf(value)) {
    errors.push(`${where}: expected an array of test references`);
    return undefined;
  }
  const resolved = value.map((member, index) => resolveReference(member, snapshot, `${where}[${index + 1}]`, errors));
  if (resolved.some((member) => member === undefined)) return undefined;
  const members = resolved as TestReference[];
  if (new Set(members.map(referenceKey)).size !== members.length) errors.push(`${where}: duplicate test reference`);
  return members;
}

function referenceKey(reference: TestReference): string {
  return `${reference.file}\u0000${reference.name}\u0000${reference.line ?? ''}`;
}

function allReferences(snapshot: Inventory): TestReference[] {
  const references: TestReference[] = [];
  for (const entry of snapshot.files) {
    const normalized = normalizedInventoryPath(entry.path);
    for (const test of entry.tests) {
      const matches = entry.tests.filter((candidate) => candidate.name === test.name);
      references.push({ file: normalized, name: test.name, ...(matches.length > 1 ? { line: test.line } : {}) });
    }
  }
  return references;
}

function validateAction(value: Record<string, unknown>, index: number, before: Inventory, after: Inventory, errors: string[]): ResolvedAction | undefined {
  const where = `ledger action ${index + 1}`;
  const errorStart = errors.length;
  hasOnlyKeys(value, ['kind', 'id', 'action', 'before', 'after', 'reason', 'category'], where, errors);
  const id = value['id'];
  const action = value['action'];
  const reason = value['reason'];
  if (!nonblank(id)) errors.push(`${where}: id must be nonblank`);
  if (!['delete', 'merge', 'add', 'rewrite', 'move', 'split'].includes(String(action))) errors.push(`${where}: unsupported action ${String(action)}`);
  if (!nonblank(reason)) errors.push(`${where}: reason must be nonblank`);
  const beforeMembers = resolveMembers(value['before'], before, `${where}.before`, errors);
  const afterMembers = resolveMembers(value['after'], after, `${where}.after`, errors);
  const category = value['category'];
  const needsCategory = action === 'delete' || action === 'merge';
  const categories: readonly string[] = ['redundant-behavior', 'implementation-coupled-assertion', 'self-derived-assertion', 'synthetic/no-required-contract', 'trivial-spec', 'coverage-padding', 'transient-leak'];
  if (needsCategory && !categories.includes(String(category))) errors.push(`${where}: deletion category is missing or unsupported`);
  if (!needsCategory && category !== undefined) errors.push(`${where}: category applies only to delete and merge actions`);
  if (beforeMembers && afterMembers) {
    if (action === 'delete' && beforeMembers.length === 0) errors.push(`${where}: delete requires before members`);
    if (action === 'merge' && (beforeMembers.length === 0 || afterMembers.length === 0)) errors.push(`${where}: merge requires before and surviving after members`);
    if (action === 'delete' && category === 'redundant-behavior' && afterMembers.length === 0) errors.push(`${where}: redundant deletion requires surviving after references`);
    if (action === 'add' && (beforeMembers.length !== 0 || afterMembers.length === 0)) errors.push(`${where}: add requires no before members and at least one after member`);
    if (['rewrite', 'move', 'split'].includes(String(action)) && (!beforeMembers.length || !afterMembers.length)) errors.push(`${where}: ${String(action)} requires before and after members`);
    if (nonblank(id) && nonblank(reason) && ['delete', 'merge', 'add', 'rewrite', 'move', 'split'].includes(String(action))
      && (!needsCategory || categories.includes(String(category)))
      && (needsCategory || category === undefined)
      && !errors.slice(errorStart).some((message) => message.startsWith(`${where}:`))) {
      return { kind: 'action', id, action: action as ActionKind, before: beforeMembers, after: afterMembers, reason, ...(needsCategory ? { category: category as DeletionCategory } : {}) };
    }
  }
  return undefined;
}

function validateScenario(value: Record<string, unknown>, index: number, before: Inventory, after: Inventory, errors: string[]): ResolvedScenario | undefined {
  const where = `ledger retained scenario ${index + 1}`;
  hasOnlyKeys(value, ['kind', 'contract', 'plausibleDefect', 'observableOutcome', 'distinctContribution', 'before', 'after'], where, errors);
  for (const key of ['contract', 'plausibleDefect', 'observableOutcome', 'distinctContribution']) {
    if (!nonblank(value[key])) errors.push(`${where}: ${key} must be nonblank`);
  }
  const beforeMembers = resolveMembers(value['before'], before, `${where}.before`, errors);
  const afterMembers = resolveMembers(value['after'], after, `${where}.after`, errors);
  if (afterMembers && afterMembers.length === 0) errors.push(`${where}: at least one surviving after member is required`);
  if (beforeMembers && afterMembers && ['contract', 'plausibleDefect', 'observableOutcome', 'distinctContribution'].every((key) => nonblank(value[key]))
    && !errors.some((message) => message.startsWith(`${where}:`))) {
    return {
      kind: 'retain', contract: value['contract'] as string, plausibleDefect: value['plausibleDefect'] as string,
      observableOutcome: value['observableOutcome'] as string, distinctContribution: value['distinctContribution'] as string,
      before: beforeMembers, after: afterMembers,
    };
  }
  return undefined;
}

function validateSavings(value: Record<string, unknown>, errors: string[]): SavingsValues | undefined {
  const where = 'ledger savings report';
  hasOnlyKeys(value, ['kind', 'scenariosRemoved', 'casesRemoved', 'cosmeticTableMerges', 'repeatedSetupCallsReduced', 'evidence'], where, errors);
  const keys = ['scenariosRemoved', 'casesRemoved', 'cosmeticTableMerges', 'repeatedSetupCallsReduced'];
  for (const key of keys) {
    const count = value[key];
    if (count !== undefined && (!Number.isInteger(count) || (count as number) < 0)) errors.push(`${where}: ${key} must be a nonnegative integer when reported`);
  }
  if (!nonblank(value['evidence'])) errors.push(`${where}: evidence must support the ledger-derived claims`);
  if (keys.some((key) => value[key] !== undefined && (!Number.isInteger(value[key]) || (value[key] as number) < 0)) || !nonblank(value['evidence'])) return undefined;
  return {
    ...(value['scenariosRemoved'] === undefined ? {} : { scenariosRemoved: value['scenariosRemoved'] as number }),
    ...(value['casesRemoved'] === undefined ? {} : { casesRemoved: value['casesRemoved'] as number }),
    ...(value['cosmeticTableMerges'] === undefined ? {} : { cosmeticTableMerges: value['cosmeticTableMerges'] as number }),
    ...(value['repeatedSetupCallsReduced'] === undefined ? {} : { repeatedSetupCallsReduced: value['repeatedSetupCallsReduced'] as number }),
    evidence: value['evidence'],
  };
}

function validateLedger(ledger: readonly LedgerInput[], before: Inventory, after: Inventory) {
  const errors: string[] = [];
  const actions: ResolvedAction[] = [];
  const scenarios: ResolvedScenario[] = [];
  let savings: SavingsValues | undefined;
  let savingsCount = 0;
  let actionCount = 0;
  let scenarioCount = 0;

  ledger.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`ledger record ${index + 1}: expected an evidence object`);
      return;
    }
    if (entry['kind'] === 'invalid-ledger-line') {
      errors.push(typeof entry['message'] === 'string' ? entry['message'] : `ledger record ${index + 1}: malformed JSON line`);
      return;
    }
    switch (entry['kind']) {
      case 'action': {
        actionCount++;
        const action = validateAction(entry, actionCount, before, after, errors);
        if (action) actions.push(action);
        break;
      }
      case 'retain': {
        scenarioCount++;
        const scenario = validateScenario(entry, scenarioCount, before, after, errors);
        if (scenario) scenarios.push(scenario);
        break;
      }
      case 'savings': {
        savingsCount++;
        const value = validateSavings(entry, errors);
        if (value && !savings) savings = value;
        break;
      }
      default:
        errors.push(`ledger record ${index + 1}: unsupported record kind ${String(entry['kind'])}`);
    }
  });
  if (savingsCount > 1) errors.push('ledger: only one savings report is allowed');

  const actionById = new Map<string, ResolvedAction>();
  for (const action of actions) {
    if (actionById.has(action.id)) errors.push(`ledger action: duplicate id ${action.id}`);
    else actionById.set(action.id, action);
  }
  for (const action of actions) {
    for (const id of action.before.map(referenceKey)) {
      const terminal = action.action === 'delete' || action.action === 'merge';
      if (!terminal) continue;
      if (actions.some((other) => other !== action && (other.action === 'delete' || other.action === 'merge') && other.before.some((member) => referenceKey(member) === id))) {
        errors.push(`ledger action ${action.id}: before member has conflicting deletion actions`);
      }
      if (actions.some((other) => other !== action && ['rewrite', 'move', 'split'].includes(other.action)
        && other.before.some((member) => referenceKey(member) === id))) {
        errors.push(`ledger action ${action.id}: before member also maps through a rewrite, move, or split action`);
      }
    }
  }

  const beforeRetained = new Set(scenarios.flatMap((scenario) => scenario.before.map(referenceKey)));
  const afterRetained = new Set(scenarios.flatMap((scenario) => scenario.after.map(referenceKey)));
  const beforeAction = new Set(actions.flatMap((action) => action.before.map(referenceKey)));
  const beforeReferences = allReferences(before);
  const afterReferences = allReferences(after);
  for (const action of actions) {
    if ((action.action === 'delete' || action.action === 'merge') && action.before.some((member) => afterReferences.some((candidate) => {
      if (!sameReportedIdentity(member, candidate)) return false;
      // A repeated title can survive through a different, explicitly mapped baseline member.
      return member.line === undefined || !scenarios.some((scenario) =>
        scenario.before.some((source) => sameReportedIdentity(source, member) && referenceKey(source) !== referenceKey(member))
        && scenario.after.some((survivor) => referenceKey(survivor) === referenceKey(candidate)));
    }))) {
      errors.push(`ledger action ${action.id}: deleted or absorbed before member still has the same reported identity after`);
    }
    if ((action.action === 'delete' || action.action === 'merge') && action.before.some((member) => beforeRetained.has(referenceKey(member)))) {
      errors.push(`ledger action ${action.id}: deleted before member cannot also be retained`);
    }
    for (const member of action.after) {
      if (!afterRetained.has(referenceKey(member))) errors.push(`ledger action ${action.id}: surviving after member lacks a retained scenario`);
    }
  }
  for (const reference of beforeReferences) {
    if (!beforeRetained.has(referenceKey(reference)) && !beforeAction.has(referenceKey(reference))) errors.push(`ledger: baseline test ${reference.file}:${reference.name}${reference.line ? `:${reference.line}` : ''} has no classification`);
  }
  for (const reference of afterReferences) {
    if (!afterRetained.has(referenceKey(reference))) errors.push(`ledger: after test ${reference.file}:${reference.name}${reference.line ? `:${reference.line}` : ''} has no retained scenario`);
  }
  for (const reference of afterReferences) {
    const mapped = actions.some((action) => action.action !== 'delete'
      && action.after.some((member) => referenceKey(member) === referenceKey(reference)));
    if (!beforeReferences.some((candidate) => sameReportedIdentity(candidate, reference)) && !mapped) {
      errors.push(`ledger: new after test ${reference.file}:${reference.name} needs an explicit add or mapping action`);
    }
  }
  for (const scenario of scenarios) {
    for (const reference of scenario.before) {
      if (afterReferences.some((candidate) => sameReportedIdentity(candidate, reference))) continue;
      const mapped = actions.some((action) => action.action !== 'delete' && action.action !== 'merge'
        && action.before.some((member) => referenceKey(member) === referenceKey(reference))
        && action.after.some((member) => scenario.after.some((retained) => referenceKey(retained) === referenceKey(member))));
      if (!mapped) errors.push(`ledger: renamed or moved retained test ${reference.file}:${reference.name} needs an explicit mapping action`);
    }
  }
  if (beforeReferences.length + afterReferences.length > 0 && ledger.length === 0) errors.push('ledger: evidence is required when an inventory contains tests');

  return { errors, actions, scenarios, savings };
}

// SECTION: Comparison

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
const cell = (before: number, after: number) => `${before} → ${after} (${signed(after - before)})`;
const ms = (value: number) => Math.round(value);
const row = (scope: string, before: Tally, after: Tally) =>
  `| ${scope} | ${cell(before.files, after.files)} | ${cell(before.tests, after.tests)} | ${cell(ms(before.durationMs), ms(after.durationMs))} |`;

function coverageTargets(before: Inventory, after: Inventory): CoverageDrop[] {
  const targets = [...new Set([...Object.keys(before.coverage), ...Object.keys(after.coverage)].map(normalizedInventoryPath))];
  return targets.sort(lexicalCompare).flatMap(target => {
    const beforeCovered = Object.entries(before.coverage).find(([candidate]) => normalizedInventoryPath(candidate) === target)?.[1].covered ?? 0;
    const afterCovered = Object.entries(after.coverage).find(([candidate]) => normalizedInventoryPath(candidate) === target)?.[1].covered ?? 0;
    return beforeCovered === afterCovered ? [] : [{ path: target, before: beforeCovered, after: afterCovered }];
  });
}

function reportSavings(lines: string[], savings: SavingsValues | undefined): void {
  const number = (value: number | undefined) => value === undefined ? 'unmeasured' : String(value);
  lines.push('', 'Ledger-reported savings (not measured by inventory):');
  lines.push(`- Scenarios removed: ${number(savings?.scenariosRemoved)}`);
  lines.push(`- Cases removed: ${number(savings?.casesRemoved)}`);
  lines.push(`- Cosmetic table merges: ${number(savings?.cosmeticTableMerges)}`);
  lines.push(`- Repeated setup calls reduced: ${number(savings?.repeatedSetupCallsReduced)}`);
  if (savings) lines.push(`- Evidence: ${savings.evidence}`);
}

export function compare(before: Inventory, after: Inventory, ledger: readonly LedgerInput[] = []): Comparison {
  const evidence = validateLedger(ledger, before, after);
  const evidenceErrors = [...evidence.errors];
  const coverageDrops = coverageTargets(before, after);
  const failures = after.failures;
  const empty: Tally = { files: 0, tests: 0, durationMs: 0 };
  const beforeUnits = tallyByUnit(before);
  const afterUnits = tallyByUnit(after);
  const units = [...new Set([...beforeUnits.keys(), ...afterUnits.keys()])].sort(lexicalCompare);
  const lines = [
    '| Scope | Files | Tests | Duration (ms) |',
    '| --- | --- | --- | --- |',
    // NOTE: total duration is suite wall-clock (concurrent); unit rows sum per-file durations, so they need not add up to it.
    row('total (wall-clock)', before.totals, after.totals),
    ...units.map((unit) => row(unit, beforeUnits.get(unit) ?? empty, afterUnits.get(unit) ?? empty)),
  ];
  if (coverageDrops.length) {
    lines.push('', 'Coverage changes (informational):', ...coverageDrops.map(drop => `- ${drop.path}: ${drop.before} → ${drop.after}`));
  }
  if (evidenceErrors.length) lines.push('', 'Evidence errors:', ...evidenceErrors.map((error) => `- ${error}`));
  if (failures.length) lines.push('', 'After-run failures:', ...failures.map((failure) => `- ${failure.file}:${failure.line} ${failure.name}`));
  reportSavings(lines, evidence.savings);
  return {
    ok: !failures.length && !evidenceErrors.length,
    coverageDrops,
    failures,
    evidenceErrors,
    markdown: `${lines.join('\n')}\n`,
  };
}

// SECTION: CLI

export interface ReadLedgerFs {
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean };
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: BufferEncoding): string;
}

export function readLedger(ledgerPath: string, fsImpl: ReadLedgerFs = fs): unknown[] {
  if (!fsImpl.existsSync(ledgerPath)) return [];
  const stat = fsImpl.statSync(ledgerPath);
  const files = stat.isDirectory()
    ? fsImpl.readdirSync(ledgerPath).filter((file) => file.endsWith('.jsonl')).sort(lexicalCompare).map((file) => path.join(ledgerPath, file))
    : [ledgerPath];
  const entries: unknown[] = [];
  for (const file of files) {
    const lines = fsImpl.readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      const trimmed = lines[index]!.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as unknown);
      } catch {
        entries.push({ kind: 'invalid-ledger-line', message: `ledger ${path.basename(file)}:${index + 1}: malformed JSON line` });
      }
    }
  }
  return entries;
}

const USAGE = 'usage: node <skill>/scripts/compare.ts <before.json> <after.json> [--ledger <dir|file>]';

export function main(
  argv: string[],
  stdout: { write(msg: string): unknown } = process.stdout,
  stderr: { write(msg: string): unknown } = process.stderr,
  fsImpl: ReadLedgerFs = fs,
): number {
  let values: { ledger?: string | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { ledger: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  if (positionals.length !== 2) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  const [beforePath, afterPath] = positionals as [string, string];
  const read = (file: string) => JSON.parse(fsImpl.readFileSync(file, 'utf8')) as Inventory;
  const ledger = values.ledger ? readLedger(path.resolve(values.ledger), fsImpl) : [];
  const result = compare(read(beforePath), read(afterPath), ledger);
  stdout.write(result.markdown);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
