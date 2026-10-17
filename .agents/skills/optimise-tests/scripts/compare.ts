import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Failure, Inventory } from './inventory.ts';

export interface LedgerEntry {
  action: string;
  file: string;
  test: string;
  reason?: string;
  coveredBy?: string;
  moveTo?: string;
  target?: string;
}

export interface CoverageDrop { path: string; before: number; after: number; justified?: boolean | undefined; reason?: string | undefined }
export interface Comparison {
  ok: boolean;
  coverageDrops: CoverageDrop[];
  approvedDrops?: CoverageDrop[] | undefined;
  failures: Failure[];
  markdown: string;
}

interface Tally { files: number; tests: number; durationMs: number }

// SECTION: Comparison

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

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
const cell = (before: number, after: number) => `${before} → ${after} (${signed(after - before)})`;
const ms = (value: number) => Math.round(value);
const row = (scope: string, before: Tally, after: Tally) =>
  `| ${scope} | ${cell(before.files, after.files)} | ${cell(before.tests, after.tests)} | ${cell(ms(before.durationMs), ms(after.durationMs))} |`;

const toPosix = (file: string) => file.replace(/\\/g, '/');
const LOW_SIGNAL_PREFIX_RE = /^(low-signal|covered-by)(:\s*|\s+)/i;
const LOW_SIGNAL_CATEGORY_RE = /^(micro-permutation|defensive-boilerplate|unreachable-fallback|synthetic-unit|tier-duplication|setup-weight|assertion-density|tautological-mock|constant|framework|config-literal)$/i;

function isJustifiedDrop(drop: { path: string; after: number }, ledger: readonly LedgerEntry[]): string | undefined {
  if (drop.after <= 0) return undefined;
  const dropPath = toPosix(drop.path);
  for (const entry of ledger) {
    if (entry.action !== 'delete' && entry.action !== 'merge') continue;
    const target = entry.target ? toPosix(entry.target) : undefined;
    if (target !== dropPath) continue;
    const reason = entry.reason?.trim() ?? '';
    const coveredBy = entry.coveredBy?.trim();
    const isLowSignal = LOW_SIGNAL_PREFIX_RE.test(reason)
      || LOW_SIGNAL_CATEGORY_RE.test(reason)
      || (coveredBy !== undefined && coveredBy.length > 0);
    if (!isLowSignal) continue;
    return reason || `covered-by: ${coveredBy}`;
  }
  return undefined;
}

export function compare(before: Inventory, after: Inventory, ledger: readonly LedgerEntry[] = []): Comparison {
  // NOTE: a production file missing from the after run counts as zero covered lines, so deleting its only tests fails the gate.
  const rawDrops = Object.entries(before.coverage)
    .map(([file, { covered }]) => {
      const afterCovered = after.coverage[file]?.covered ?? 0;
      const justification = isJustifiedDrop({ path: file, after: afterCovered }, ledger);
      return { path: file, before: covered, after: afterCovered, justified: justification !== undefined, reason: justification };
    })
    .filter((drop) => drop.after < drop.before)
    .sort((a, b) => a.path.localeCompare(b.path));

  const approvedDrops = rawDrops.filter((drop) => drop.justified);
  const coverageDrops = rawDrops.filter((drop) => !drop.justified);
  const failures = after.failures;
  const empty: Tally = { files: 0, tests: 0, durationMs: 0 };
  const beforeUnits = tallyByUnit(before);
  const afterUnits = tallyByUnit(after);
  const units = [...new Set([...beforeUnits.keys(), ...afterUnits.keys()])].sort();
  const lines = [
    '| Scope | Files | Tests | Duration (ms) |',
    '| --- | --- | --- | --- |',
    // NOTE: total duration is suite wall-clock (concurrent); unit rows sum per-file durations, so they need not add up to it.
    row('total (wall-clock)', before.totals, after.totals),
    ...units.map((unit) => row(unit, beforeUnits.get(unit) ?? empty, afterUnits.get(unit) ?? empty)),
  ];
  if (approvedDrops.length) {
    lines.push('', 'Approved coverage drops (ledger-backed):', ...approvedDrops.map((drop) => `- ${drop.path}: ${drop.before} → ${drop.after} [reason: ${drop.reason ?? 'justified'}]`));
  }
  if (coverageDrops.length) {
    lines.push('', 'Coverage drops (covered lines):', ...coverageDrops.map((drop) => `- ${drop.path}: ${drop.before} → ${drop.after}`));
  }
  if (failures.length) {
    lines.push('', 'After-run failures:', ...failures.map((failure) => `- ${failure.file}:${failure.line} ${failure.name}`));
  }
  return { ok: !coverageDrops.length && !failures.length, coverageDrops, approvedDrops, failures, markdown: `${lines.join('\n')}\n` };
}

// SECTION: CLI

export interface ReadLedgerFs {
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean };
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: BufferEncoding): string;
}

function isValidLedgerEntry(parsed: unknown): parsed is LedgerEntry {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const entry = parsed as Record<string, unknown>;
  if (typeof entry['action'] !== 'string' || typeof entry['file'] !== 'string' || typeof entry['test'] !== 'string') return false;
  if (entry['target'] !== undefined && typeof entry['target'] !== 'string') return false;
  if (entry['reason'] !== undefined && typeof entry['reason'] !== 'string') return false;
  if (entry['coveredBy'] !== undefined && typeof entry['coveredBy'] !== 'string') return false;
  if (entry['moveTo'] !== undefined && typeof entry['moveTo'] !== 'string') return false;
  return true;
}

export function readLedger(
  ledgerPath: string,
  stderr: { write(msg: string): unknown } = process.stderr,
  fsImpl: ReadLedgerFs = fs,
): LedgerEntry[] {
  if (!fsImpl.existsSync(ledgerPath)) return [];
  const entries: LedgerEntry[] = [];
  const stat = fsImpl.statSync(ledgerPath);
  const files = stat.isDirectory()
    ? fsImpl.readdirSync(ledgerPath).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(ledgerPath, f))
    : [ledgerPath];
  for (const file of files) {
    const text = fsImpl.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const trimmed = lines[index]!.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isValidLedgerEntry(parsed)) {
          entries.push(parsed);
        } else {
          stderr.write(`ledger warning: ${path.basename(file)}:${index + 1} invalid ledger entry\n`);
        }
      } catch {
        stderr.write(`ledger warning: ${path.basename(file)}:${index + 1} malformed JSON line\n`);
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
  const ledger = values.ledger ? readLedger(path.resolve(values.ledger), stderr, fsImpl) : [];
  const result = compare(read(beforePath), read(afterPath), ledger);
  stdout.write(result.markdown);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
