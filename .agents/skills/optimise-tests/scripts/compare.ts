// Compares two inventory.json snapshots for the optimise-tests gate.
// Usage: node <skill>/scripts/compare.ts <before.json> <after.json>
// Prints a Markdown delta table; exits 1 when any production file loses covered lines or the after run has failures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Failure, Inventory } from './inventory.ts';

export interface CoverageDrop { path: string; before: number; after: number }
export interface Comparison { ok: boolean; coverageDrops: CoverageDrop[]; failures: Failure[]; markdown: string }

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

export function compare(before: Inventory, after: Inventory): Comparison {
  // NOTE: a production file missing from the after run counts as zero covered lines, so deleting its only tests fails the gate.
  const coverageDrops = Object.entries(before.coverage)
    .map(([file, { covered }]) => ({ path: file, before: covered, after: after.coverage[file]?.covered ?? 0 }))
    .filter((drop) => drop.after < drop.before)
    .sort((a, b) => a.path.localeCompare(b.path));
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
  if (coverageDrops.length) {
    lines.push('', 'Coverage drops (covered lines):', ...coverageDrops.map((drop) => `- ${drop.path}: ${drop.before} → ${drop.after}`));
  }
  if (failures.length) {
    lines.push('', 'After-run failures:', ...failures.map((failure) => `- ${failure.file}:${failure.line} ${failure.name}`));
  }
  return { ok: !coverageDrops.length && !failures.length, coverageDrops, failures, markdown: `${lines.join('\n')}\n` };
}

// SECTION: CLI

function main(argv: string[]): number {
  const [beforePath, afterPath] = argv;
  if (argv.length !== 2 || !beforePath || !afterPath) {
    process.stderr.write('usage: node <skill>/scripts/compare.ts <before.json> <after.json>\n');
    return 1;
  }
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Inventory;
  const result = compare(read(beforePath), read(afterPath));
  process.stdout.write(result.markdown);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
