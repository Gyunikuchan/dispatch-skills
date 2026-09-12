import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

// `dispatch.mjs --help`, SKILL.md's flag table and README.md's flag table drifted apart once
// (`--json` scoped to "local" in one and "opencode" in another, `-a` scoped in neither). Parity
// is checked per alias group (`-m`/`--model`), so either spelling satisfies a doc table.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DISPATCH_CLI = path.join(REPO_ROOT, 'skills', 'dispatch', 'scripts', 'dispatch.mjs');

/** Every flag spelling named in a markdown flag table's leading `| \`-f ...\`` cells. */
function tableFlags(markdown) {
  const flags = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1] ?? '';
    for (const [, flag] of cell.matchAll(/`(--?[a-z][a-z-]*)/g)) flags.add(flag);
  }
  return flags;
}

/**
 * Alias groups from `--help`, e.g. `['-m', '--model']`. Docs may name either spelling, so
 * parity is checked per group rather than per spelling.
 */
function helpFlagGroups() {
  const res = spawnSync(process.execPath, [DISPATCH_CLI, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const groups = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^\s{2}(-[\w-]+(?:, --[a-z][a-z-]*)*)(?:,? --[a-z][a-z-]*)?\s/.exec(line);
    if (!m) continue;
    const spellings = [...m[1].matchAll(/--?[a-z][a-z-]*/g)].map(([f]) => f);
    // `--help` documents itself; the skill docs have no reason to.
    if (spellings.includes('--help')) continue;
    if (spellings.length) groups.push(spellings);
  }
  return groups;
}

const HELP_GROUPS = helpFlagGroups();
const HELP_SPELLINGS = new Set(HELP_GROUPS.flat());
const SKILL = tableFlags(readFileSync(path.join(REPO_ROOT, 'skills', 'dispatch', 'SKILL.md'), 'utf8'));
const README = tableFlags(readFileSync(path.join(REPO_ROOT, 'skills', 'dispatch', 'README.md'), 'utf8'));

const missingFrom = (documented) =>
  HELP_GROUPS.filter((group) => !group.some((flag) => documented.has(flag))).map((g) => g.join('/'));

describe('dispatch flag parity (--help vs SKILL.md vs README.md)', () => {
  it('documents every flag --help accepts in SKILL.md', () => {
    assert.deepEqual(missingFrom(SKILL), []);
  });

  it('documents every flag --help accepts in README.md', () => {
    assert.deepEqual(missingFrom(README), []);
  });

  it('names no flag in the docs that --help does not accept', () => {
    const documented = [...new Set([...SKILL, ...README])].sort();
    assert.deepEqual(documented.filter((f) => !HELP_SPELLINGS.has(f)), []);
  });

  it('scopes --json and -a to the opencode provider in every surface', () => {
    const res = spawnSync(process.execPath, [DISPATCH_CLI, '--help'], { encoding: 'utf8' });
    for (const [name, text] of [
      ['--help', res.stdout],
      ['SKILL.md', readFileSync(path.join(REPO_ROOT, 'skills', 'dispatch', 'SKILL.md'), 'utf8')],
      ['README.md', readFileSync(path.join(REPO_ROOT, 'skills', 'dispatch', 'README.md'), 'utf8')],
    ]) {
      for (const flag of ['--json', '-a']) {
        const line = text.split('\n').find((l) => l.includes(flag) && /provider only/i.test(l));
        assert.ok(line, `${name} does not scope ${flag} to a provider`);
        assert.match(line, /opencode provider only/i, `${name} scopes ${flag} to the wrong provider`);
      }
    }
  });
});
