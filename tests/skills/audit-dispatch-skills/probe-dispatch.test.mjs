import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildTargets,
  cell,
  classifyDenylistBehaviour,
  drainStaging,
  parseArgs,
  renderSummary,
  statusOf,
} from '../../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs';

const SCRIPTS_DIR = path.join('skills', 'dispatch', 'scripts');

/** One discovery row as `discover()` produces them. */
const row = (provider, mode, bin, reachable = true) => ({ provider, mode, bin, reachable });

describe('probe-dispatch: buildTargets', () => {
  it('emits one dispatch-level target per provider when --modes is off', () => {
    const targets = buildTargets(
      [row('claude', 'desktop', '/bin/claude'), row('claude', 'cli', '/usr/bin/claude')],
      { modes: false, config: { 'read-delegates': { claude: {} } }, scriptsDir: SCRIPTS_DIR },
    );
    assert.equal(targets.length, 1);
    assert.equal(targets[0].via, 'dispatch');
    assert.deepEqual(targets[0].aliases, ['desktop', 'cli']);
  });

  it('adds --no-config for a provider absent from the dispatch config', () => {
    // A provider the config omits cannot be pinned with --provider alone.
    const targets = buildTargets([row('agy', 'antigravity-cli', '/bin/agy')], {
      modes: false,
      config: { 'read-delegates': { claude: {} } },
      scriptsDir: SCRIPTS_DIR,
    });
    assert.ok(targets[0].baseArgs.includes('--no-config'));
  });

  it('omits --no-config for a configured provider', () => {
    const targets = buildTargets([row('agy', 'antigravity-cli', '/bin/agy')], {
      modes: false,
      config: { 'read-delegates': { agy: {} } },
      scriptsDir: SCRIPTS_DIR,
    });
    assert.ok(!targets[0].baseArgs.includes('--no-config'));
  });

  it('dedupes modes sharing a binary under --modes, collecting them as aliases', () => {
    // Three copilot modes routinely resolve to one executable; probing it thrice measures nothing.
    const targets = buildTargets(
      [
        row('copilot', 'desktop', '/opt/copilot'),
        row('copilot', 'vscode', '/opt/copilot'),
        row('copilot', 'cli', '/usr/local/bin/copilot'),
      ],
      { modes: true, config: { 'read-delegates': { copilot: {} } }, scriptsDir: SCRIPTS_DIR },
    );
    assert.equal(targets.length, 2);
    assert.deepEqual(targets[0].aliases, ['desktop', 'vscode']);
    assert.deepEqual(targets[1].aliases, ['cli']);
  });

  it('skips a provider with no reachable rows', () => {
    const targets = buildTargets([row('claude', 'cli', '/bin/claude', false)], {
      modes: false,
      config: null,
      scriptsDir: SCRIPTS_DIR,
    });
    assert.deepEqual(targets, []);
  });

  it('passes the first model of an array entry, plus effort, under --modes', () => {
    const targets = buildTargets([row('claude', 'cli', '/bin/claude')], {
      modes: true,
      config: { 'read-delegates': { claude: { targets: [{ low: { model: ['m1', 'm2'], effort: 'high' } }] } } },
      scriptsDir: SCRIPTS_DIR,
    });
    assert.deepEqual(targets[0].baseArgs.slice(-4), ['-m', 'm1', '-e', 'high']);
  });
});

describe('probe-dispatch: parseArgs', () => {
  it('defaults to all providers, no modes, discovery off', () => {
    const opts = parseArgs([]);
    assert.equal(opts.only, null);
    assert.equal(opts.modes, false);
    assert.equal(opts.discoverOnly, false);
    assert.ok(opts.timeout > 0);
  });

  it('parses --only into a provider list', () => {
    assert.deepEqual(parseArgs(['--only', 'claude,agy']).only, ['claude', 'agy']);
  });

  it('rejects an unknown provider in --only instead of probing nothing', () => {
    assert.throws(() => parseArgs(['--only', 'claude,bogus']), /unknown provider\(s\) bogus/);
  });

  it('rejects a bare --only rather than crashing on undefined', () => {
    assert.throws(() => parseArgs(['--only']), /--only requires/);
  });

  it('rejects an empty --only list', () => {
    assert.throws(() => parseArgs(['--only', ' , ']), /at least one provider/);
  });

  it('rejects a non-numeric --timeout instead of silently using the default', () => {
    assert.throws(() => parseArgs(['--timeout', 'soon']), /--timeout requires a positive number/);
    assert.throws(() => parseArgs(['--timeout', '0']), /--timeout requires a positive number/);
  });

  it('accepts a valid --timeout', () => {
    assert.equal(parseArgs(['--timeout', '45']).timeout, 45);
  });

  it('rejects an unknown argument', () => {
    assert.throws(() => parseArgs(['--nope']), /Unknown argument: --nope/);
  });

  it('skips the --run value, which resolveRunDirs consumes', () => {
    assert.doesNotThrow(() => parseArgs(['--run', '2026-09-12-0001', '--modes']));
    assert.equal(parseArgs(['--run', '2026-09-12-0001', '--modes']).modes, true);
  });
});

describe('probe-dispatch: statusOf', () => {
  it('classifies a reachable row as reachable', () => {
    assert.match(statusOf(row('claude', 'cli', '/bin/claude')).toLowerCase(), /reachable/);
  });

  it('classifies an unreachable row differently', () => {
    const present = statusOf(row('claude', 'cli', '/bin/claude', false));
    assert.notEqual(present, statusOf(row('claude', 'cli', '/bin/claude')));
  });
});

describe('probe-dispatch: cell', () => {
  it('flattens newlines so a cell cannot break the table row', () => {
    assert.equal(cell('a\r\nb\nc'), 'a b c');
  });

  it('escapes pipes so a value cannot forge a column', () => {
    assert.equal(cell('a|b'), 'a\\|b');
  });

  it('truncates to 160 characters', () => {
    assert.equal(cell('x'.repeat(400)).length, 160);
  });

  it('stringifies non-strings', () => {
    assert.equal(cell(7), '7');
  });
});

describe('probe-dispatch: classifyDenylistBehaviour', () => {
  it('reports a skipped file for a clean rejection that exited 0', () => {
    assert.equal(
      classifyDenylistBehaviour({
        rejected: true,
        stderr: "[dispatch] Attachment rejected: 'probe-token.txt' matches sensitive file denylist.\nunreadable probe-token.txt\n",
        code: 0,
        failureKind: null,
      }),
      'skipped file',
    );
  });

  it('does not blame the denylist for an unrelated failure alongside a rejection', () => {
    assert.equal(
      classifyDenylistBehaviour({
        rejected: true,
        stderr: "[dispatch] Attachment rejected: 'probe-token.txt' matches sensitive file denylist.\nunreadable probe-token.txt\n[dispatch] 401 unauthorized\n",
        code: 1,
        failureKind: 'auth',
      }),
      'rejected; run failed for another reason',
    );
  });

  it('trusts the runner wording over a non-zero exit when no failure was classified', () => {
    assert.equal(
      classifyDenylistBehaviour({ rejected: true, stderr: 'unreadable probe-token.txt\n', code: 2, failureKind: null }),
      'skipped file',
    );
  });

  it('falls back to the exit code when the runner said nothing about what it did', () => {
    assert.equal(
      classifyDenylistBehaviour({ rejected: true, stderr: 'rejected\n', code: 3, failureKind: null }),
      'aborted run',
    );
    assert.equal(
      classifyDenylistBehaviour({ rejected: true, stderr: 'rejected\n', code: 0, failureKind: null }),
      'skipped file',
    );
  });

  it('reports an unrejected denylisted file regardless of wording or failure', () => {
    assert.equal(
      classifyDenylistBehaviour({ rejected: false, stderr: 'unreadable x\n', code: 0, failureKind: 'auth' }),
      'not rejected',
    );
  });
});

describe('probe-dispatch: renderSummary', () => {
  const rows = [row('claude', 'cli', '/bin/claude'), row('agy', 'antigravity-cli', null, false)];
  const config = { 'read-delegates': { claude: {} } };
  const fixture = { dir: '/home/u/.dispatch-audit-probe-x' };

  /** One `runTarget` result, overridable per assertion. */
  const result = (over = {}) => ({
    id: 'claude',
    via: 'dispatch',
    aliases: ['cli'],
    exitCode: 0,
    seconds: 12,
    checks: { exit: true, attached: true, sibling: true, denylist: true },
    denylistBehaviour: 'skipped file',
    failure: null,
    pass: true,
    log: '/tmp/read.log',
    logs: { read: '/tmp/read.log', denylist: '/tmp/deny.log' },
    captures: 'claude.{read,denylist}.{stdout,stderr}.txt',
    ...over,
  });

  it('returns after discovery under --discover-only, with no live section', () => {
    const out = renderSummary({
      rows,
      live: [],
      fixture: null,
      config,
      opts: { discoverOnly: true, modes: false },
    });
    assert.match(out, /## Discovery \(token-free\)/);
    assert.match(out, /## Not found \/ unreachable/);
    assert.ok(!out.includes('## Live probe'), 'discover-only must not render the live section');
  });

  it('renders the live checks without a workspace-mutation column', () => {
    const out = renderSummary({
      rows,
      live: [
        result({
          checks: { exit: true, attached: true, sibling: true, denylist: false },
          pass: false,
          failure: 'denylist failure',
        }),
      ],
      fixture,
      config,
      opts: { discoverOnly: false, modes: false },
    });
    assert.ok(!out.includes('| Read-only |'));
    assert.match(out, /FAIL \(denylist failure\)/);
  });

  it('lists both session logs, and a shared log path only once', () => {
    const both = renderSummary({
      rows,
      live: [result()],
      fixture,
      config,
      opts: { discoverOnly: false, modes: false },
    });
    assert.match(both, /\/tmp\/read\.log/);
    assert.match(both, /\/tmp\/deny\.log/);

    const shared = renderSummary({
      rows,
      live: [result({ logs: { read: '/tmp/same.log', denylist: '/tmp/same.log' } })],
      fixture,
      config,
      opts: { discoverOnly: false, modes: false },
    });
    assert.equal(shared.match(/\/tmp\/same\.log/g).length, 1);
  });
});

describe('probe-dispatch: drainStaging', () => {
  it('moves every staged capture into the output dir and removes the staging dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-drain-'));
    const stageDir = path.join(base, 'stage');
    const outDir = path.join(base, 'out');
    fs.mkdirSync(stageDir);
    fs.mkdirSync(outDir);
    try {
      fs.writeFileSync(path.join(stageDir, 'claude.read.stdout.txt'), 'one', 'utf8');
      fs.writeFileSync(path.join(stageDir, 'claude.denylist.stderr.txt'), 'two', 'utf8');

      drainStaging(stageDir, outDir);

      assert.deepEqual(fs.readdirSync(outDir).sort(), ['claude.denylist.stderr.txt', 'claude.read.stdout.txt']);
      assert.equal(fs.readFileSync(path.join(outDir, 'claude.read.stdout.txt'), 'utf8'), 'one');
      assert.equal(fs.existsSync(stageDir), false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('is a no-op when nothing was staged', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-drain-'));
    try {
      assert.doesNotThrow(() => drainStaging(path.join(base, 'absent'), base));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps the staging dir and its captures when a move fails', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-drain-'));
    const stageDir = path.join(base, 'stage');
    fs.mkdirSync(stageDir);
    try {
      fs.writeFileSync(path.join(stageDir, 'claude.read.stdout.txt'), 'one', 'utf8');
      assert.throws(() => drainStaging(stageDir, path.join(base, 'missing-out')), /Captures left in/);
      assert.equal(fs.readFileSync(path.join(stageDir, 'claude.read.stdout.txt'), 'utf8'), 'one');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
