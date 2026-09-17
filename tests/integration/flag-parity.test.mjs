import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  COMMON_VALUE_FLAGS,
  DOCUMENTED_COMMON_FLAGS,
  RUNNER_IRRELEVANT_COMMON_FLAGS,
} from '../../skills/dispatch/scripts/common.mjs';
import { CLI_FLAGS as claudeFlags } from '../../skills/dispatch/scripts/claude-run.mjs';
import { CLI_FLAGS as agyFlags } from '../../skills/dispatch/scripts/agy-run.mjs';
import { CLI_FLAGS as copilotFlags } from '../../skills/dispatch/scripts/copilot-run.mjs';
import { CLI_FLAGS as opencodeFlags } from '../../skills/dispatch/scripts/opencode-run.mjs';

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

// SKILL.md Troubleshooting points an agent at `<runner>-run.mjs --help` as the diagnostic surface,
// so a spelling the runner accepts but never prints is a dead end mid-incident. Each runner exports
// its own CLI_FLAGS rather than having this test scrape source for `arg === '--x'` comparisons.
const RUNNERS = [
  ['claude-run.mjs', claudeFlags],
  ['agy-run.mjs', agyFlags],
  ['copilot-run.mjs', copilotFlags],
  ['opencode-run.mjs', opencodeFlags],
];

/** Every flag spelling a runner's `--help` prints. */
function runnerHelpSpellings(script) {
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'skills', 'dispatch', 'scripts', script), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return new Set([...res.stdout.matchAll(/--?[a-z][a-z-]*/g)].map(([f]) => f));
}

describe('runner flag parity (--help vs the flags each runner accepts)', () => {
  for (const [script, flags] of RUNNERS) {
    it(`${script} --help names every runner-specific flag it accepts`, () => {
      const printed = runnerHelpSpellings(script);
      const accepted = [...flags.valueFlags, ...flags.booleanFlags];
      assert.deepEqual(accepted.filter((f) => !printed.has(f)), []);
    });

    it(`${script} --help names every documented common flag`, () => {
      const printed = runnerHelpSpellings(script);
      assert.deepEqual(DOCUMENTED_COMMON_FLAGS.filter((f) => !printed.has(f)), []);
    });
  }

  // Without this pair, a flag added to COMMON_VALUE_FLAGS later is silently undocumented —
  // A-40's own defect, one level up.
  it('DOCUMENTED_COMMON_FLAGS names only real common flags', () => {
    assert.deepEqual(DOCUMENTED_COMMON_FLAGS.filter((f) => !COMMON_VALUE_FLAGS.has(f)), []);
  });

  it('every common flag is either documented or explicitly excluded', () => {
    const accounted = new Set([...DOCUMENTED_COMMON_FLAGS, ...RUNNER_IRRELEVANT_COMMON_FLAGS]);
    assert.deepEqual([...COMMON_VALUE_FLAGS].filter((f) => !accounted.has(f)), []);
  });
});

// dispatch/SKILL.md Troubleshooting teaches `--help` as the diagnostic move for a misbehaving
// script. Two of the four authored CLIs used to exit 1 with `Unrecognized argument "--help"` —
// and they were the two whose flag surface lives only in a header comment.
describe('every authored CLI answers --help', () => {
  for (const script of [
    ['skills', 'dispatch', 'scripts', 'dispatch.mjs'],
    ['skills', 'dispatch', 'scripts', 'claude-run.mjs'],
    ['skills', 'dispatch', 'scripts', 'agy-run.mjs'],
    ['skills', 'dispatch', 'scripts', 'copilot-run.mjs'],
    ['skills', 'dispatch', 'scripts', 'opencode-run.mjs'],
    ['skills', 'dispatch', 'scripts', 'resolve-artifact-paths.mjs'],
    ['skills', 'dispatch', 'scripts', 'fill-template.mjs'],
    ['skills', 'implement-dispatch', 'scripts', 'resolve-flow.mjs'],
    ['skills', 'implement-dispatch', 'scripts', 'check-consensus.mjs'],
    ['skills', 'implement-dispatch', 'scripts', 'run-record.mjs'],
    ['skills', 'dispatch-code-review', 'scripts', 'resolve-review-range.mjs'],
    ['skills', 'dispatch-plan-review', 'scripts', 'prepare-review.mjs'],
    ['skills', 'dispatch-code-review', 'scripts', 'prepare-review.mjs'],
  ]) {
    const name = script[script.length - 1];
    it(`${name} --help exits 0 and prints usage`, () => {
      const res = spawnSync(process.execPath, [path.join(REPO_ROOT, ...script), '--help'], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Usage:/);
    });
  }
});
