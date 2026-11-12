import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {CATEGORIES, DIAGNOSTIC_LIMITS} from '../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
import {OVERLAY_ROOT} from './scan.ts';
const read = (name: string) => fs.readFileSync(path.join(OVERLAY_ROOT, 'skills/dispatch/', name), 'utf8');

test('phase prose records bounded retro observations as a JSON array', () => {
  const instruction = read('references/diagnostics.md');
  assert.ok(Buffer.byteLength(instruction.replace(/\r?\n/g, '\r\n')) <= DIAGNOSTIC_LIMITS.instructionBytes);
  assert.match(instruction, /merge your terse notes into the JSON array at `<session>\/\.state\/retro\.json` yourself/);
  assert.match(instruction, /Without notes, add nothing; if no file, write `\[\]`/);
  assert.match(instruction, /Then you run `diagnostics render`/);
  assert.match(instruction, /Collection or a failed merge is never a workflow gate/);
  assert.ok(instruction.includes('JSON array'));
  assert.ok(instruction.includes('<session>/.state/retro.json'));
  assert.ok(instruction.includes('{id,component,category,evidence,impact,proposedFix}'));
  assert.ok(instruction.includes('unique ids'));
  assert.ok(instruction.includes('1-48 A-Za-z0-9_- chars'));
  for (const key of Object.keys(CATEGORIES)) assert.ok(instruction.includes('`' + key + '`'), key);
  assert.ok(instruction.includes('at most ' + DIAGNOSTIC_LIMITS.fieldBytes + ' bytes'));
  assert.match(instruction, /Exclude repository, toolchain, and user-work issues/);
  assert.match(instruction, /Fixes must hold on any repository and machine/);
  assert.match(instruction, /no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets/);
  for (const term of ['valid empty', 'missing', 'unreadable', 'malformed', 'non-array', 'workflow gate']) assert.ok(instruction.includes(term), term);
  assert.ok(read('SKILL.md').includes('returned `instructions`'));
});

test('phase prose completes the report before cleaning owned worktrees', () => {
  for (const name of ['SKILL.md', 'references/worktree-cleanup.md']) assert.match(read(name), /report complete[\s\S]*worktree cleanup/);
  assert.match(read('references/worktree-cleanup.md'), /unrelated/);
});

test('diagnostics retain privacy and measurement guidance', () => {
  const human = read('references/readme/troubleshooting.md');
  const concepts = read('references/readme/concepts.md');
  assert.ok(concepts.includes('Captured CLI attempts retain reported provider usage'));
  assert.ok(concepts.includes('Native timing and usage'));
  for (const term of ['unavailable value, not zero', 'Measured totals exclude `~` figures', 'full conversation totals', 'work, pauses and scheduling', 'Review `diagnostics.md` before sharing it', 'Total storage loss', 'effective configuration', 'Native slots', 'No findings does not prove complete collection']) assert.ok(human.includes(term), term);
});

test('diagnostics instructions specify grounding retro items and yield format', () => {
  const instruction = read('references/diagnostics.md');
  assert.ok(instruction.includes('id: grounding-<phase>'));
  assert.ok(instruction.includes('component: references/grounding.md'));
  assert.ok(instruction.includes('category: information-access'));
  assert.ok(instruction.includes('evidence: map <n>, nested <n>, research <n>, not-covered <n>, yield <changed>/<launched>, tokens <per explorer|unavailable>'));
  assert.match(instruction, /`yield` counts nested and research explorers whose reply changed a REQ, DEC, scope or blast radius/);
  assert.doesNotMatch(instruction, /\b(?:gap|scout)\b/i);
  assert.doesNotMatch(read('SKILL.md'), /grounding-<phase>/);
});
