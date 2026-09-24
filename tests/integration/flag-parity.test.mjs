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
} from '../../skills/dispatch/scripts/runners/shared.mjs';
import { CLI_FLAGS as claudeFlags } from '../../skills/dispatch/scripts/runners/claude.mjs';
import { CLI_FLAGS as agyFlags } from '../../skills/dispatch/scripts/runners/agy.mjs';
import { CLI_FLAGS as copilotFlags } from '../../skills/dispatch/scripts/runners/copilot.mjs';
import { CLI_FLAGS as opencodeFlags } from '../../skills/dispatch/scripts/runners/opencode.mjs';

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

/** Runs a shipped CLI's help once for all assertions in this cross-component contract. */
function cliHelp(script) {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  return result.stdout;
}

/** Alias groups from `--help`, e.g. `['-m', '--model']`. */
function helpFlagGroups(output) {
  const groups = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s{2}(-[\w-]+(?:, --[a-z][a-z-]*)*)(?:,? --[a-z][a-z-]*)?\s/.exec(line);
    if (!match) continue;
    const spellings = [...match[1].matchAll(/--?[a-z][a-z-]*/g)].map(([flag]) => flag);
    if (!spellings.includes('--help') && spellings.length) groups.push(spellings);
  }
  return groups;
}

const DISPATCH_HELP = cliHelp(DISPATCH_CLI);
const HELP_SPELLINGS = new Set(helpFlagGroups(DISPATCH_HELP).flat());
const SKILL_TEXT = readFileSync(path.join(REPO_ROOT, 'skills', 'dispatch', 'SKILL.md'), 'utf8');
const README_TEXT = readFileSync(path.join(REPO_ROOT, 'skills', 'dispatch', 'README.md'), 'utf8');

// SECTION: Dispatch documentation contract

describe('dispatch CLI help is the flag source of truth', () => {
  it('carries required routing flags and scopes provider-only flags', () => {
    for (const flag of ['--level', '--level-source', '--pins', '--run', '--kind', '--fix', '--phases', '--next', '--state', '--input']) {
      assert.ok(HELP_SPELLINGS.has(flag), `--help lacks ${flag}`);
    }
    for (const flag of ['--json', '-a']) {
      const line = DISPATCH_HELP.split('\n').find((value) => value.includes(flag) && /provider only/i.test(value));
      assert.ok(line, `--help does not scope ${flag}`);
      assert.match(line, /opencode provider only/i);
    }
  });

  it('agent and human docs point to --help without caching a flag table', () => {
    for (const [name, text] of [['SKILL.md', SKILL_TEXT], ['README.md', README_TEXT]]) {
      assert.match(text, /--help/);
      assert.equal(tableFlags(text).size, 0, `${name} duplicates the CLI flag table`);
    }
  });
});

// SKILL.md Troubleshooting points an agent at `runners/<provider>.mjs --help` as the diagnostic surface,
// so a spelling the runner accepts but never prints is a dead end mid-incident. Each runner exports
// its own CLI_FLAGS rather than having this test scrape source for `arg === '--x'` comparisons.

const RUNNERS = [
  ['runners/claude.mjs', claudeFlags],
  ['runners/agy.mjs', agyFlags],
  ['runners/copilot.mjs', copilotFlags],
  ['runners/opencode.mjs', opencodeFlags],
];

const RUNNER_HELP = new Map(RUNNERS.map(([script]) => [
  script,
  cliHelp(path.join(REPO_ROOT, 'skills', 'dispatch', 'scripts', script)),
]));

// SECTION: Runner help contract

describe('runner help matches accepted and shared flags', () => {
  for (const [script, flags] of RUNNERS) {
    it(`${script} names every accepted runner flag and documented common flag`, () => {
      const printed = new Set([...RUNNER_HELP.get(script).matchAll(/--?[a-z][a-z-]*/g)].map(([flag]) => flag));
      const required = [...flags.valueFlags, ...flags.booleanFlags, ...DOCUMENTED_COMMON_FLAGS];
      assert.deepEqual(required.filter((flag) => !printed.has(flag)), []);
    });
  }

  it('partitions real common flags into documented and explicitly excluded sets', () => {
    assert.deepEqual(DOCUMENTED_COMMON_FLAGS.filter((flag) => !COMMON_VALUE_FLAGS.has(flag)), []);
    const accounted = new Set([...DOCUMENTED_COMMON_FLAGS, ...RUNNER_IRRELEVANT_COMMON_FLAGS]);
    assert.deepEqual([...COMMON_VALUE_FLAGS].filter((flag) => !accounted.has(flag)), []);
  });
});
