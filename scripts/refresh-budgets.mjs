#!/usr/bin/env node

/**
 * Refreshes the `recall` aggregate and `intentionalRecallDelta` sections of
 * tests/fixtures/instruction-budgets.json from the current instruction files. Earlier phase
 * baselines are historical and never rewritten. The test pins measured totals exactly, so any
 * edit to a normal-path file needs a refresh; review the fixture diff before committing, since
 * ceilings and per-file allowances rise with the measured growth.
 *
 * Usage: node scripts/refresh-budgets.mjs [--check]
 *   --check  print the refreshed values and exit 1 when the fixture is stale (no write)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { measureText } from '../skills/dispatch/scripts/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests', 'fixtures', 'instruction-budgets.json');
const check = process.argv.includes('--check');

const budgets = JSON.parse(fs.readFileSync(fixture, 'utf8'));
const measure = (file) => measureText(fs.readFileSync(path.join(root, file), 'utf8')).characters;
const sum = (files) => files.reduce((total, file) => total + measure(file), 0);
const roundUp = (value, step) => Math.ceil(value / step) * step;

// Keep these lists in step with tests/integration/instruction-budgets.test.mjs.
const entryPoints = [
  'skills/dispatch/SKILL.md',
  'skills/dispatch-plan-review/SKILL.md',
  'skills/dispatch-code-review/SKILL.md',
  'skills/implement-dispatch/SKILL.md',
];
const normalPath = Object.keys(budgets.phase5);
const shared = ['skills/dispatch/SKILL.md', 'skills/implement-dispatch/SKILL.md', 'skills/dispatch/references/alignment.md'];

const files = {};
for (const file of normalPath) {
  const growth = measure(file) - budgets.phase5[file];
  if (growth > 0) files[file] = roundUp(growth, 50);
}
const entry = sum(entryPoints);
const normal = sum(normalPath);
const plan = sum([...shared, 'skills/dispatch-plan-review/SKILL.md', 'skills/dispatch-plan-review/references/rebuttal-template.md']);
const code = sum([...shared, 'skills/dispatch-code-review/SKILL.md', 'skills/dispatch-code-review/references/rebuttal-template.md']);
const normalCeiling = roundUp(normal, 100);
const recall = {
  entryPointCeiling: roundUp(entry, 100),
  normalPathCeiling: normalCeiling,
  normalPathEstimateCeiling: Math.ceil(normalCeiling / 4),
  entryPointCharacters: entry,
  entryPointEstimate: Math.ceil(entry / 4),
  normalPathCharacters: normal,
  normalPathEstimate: Math.ceil(normal / 4),
  planRebuttalPathCharacters: plan,
  planRebuttalPathEstimate: Math.ceil(plan / 4),
  codeRebuttalPathCharacters: code,
  codeRebuttalPathEstimate: Math.ceil(code / 4),
};
const growth = normal - budgets.aggregateBaselines.phase5.normalPathCharacters;
const allowed = Object.values(files).reduce((total, value) => total + value, 0);
const delta = { files, normalPathCharacters: roundUp(Math.max(growth, allowed), 100) };

const before = JSON.stringify({ recall: budgets.aggregateBaselines.recall, ...budgets.intentionalRecallDelta });
budgets.aggregateBaselines.recall = recall;
Object.assign(budgets.intentionalRecallDelta, delta);
const stale = before !== JSON.stringify({ recall, ...budgets.intentionalRecallDelta });

console.log(JSON.stringify({ recall, ...delta }, null, 2));
if (check) {
  if (stale) console.error('instruction-budgets.json is stale; run `npm run budgets`.');
  process.exit(stale ? 1 : 0);
}
fs.writeFileSync(fixture, `${JSON.stringify(budgets, null, 2)}\n`);
console.log(stale ? 'Updated instruction-budgets.json; review the diff.' : 'instruction-budgets.json already current.');
