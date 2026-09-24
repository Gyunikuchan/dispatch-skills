import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { buildStubDispatchFixture, parseSlotLines, runStubDispatch } from '../../helpers/stub-dispatch.mjs';

// `code-review.only` names claude alone: an ask wave must ignore it (only never narrows ask).
const CONFIG = {
  'read-delegates': {
    claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'medium' }, high: { model: 'claude-fable-5.1', effort: 'medium' } }] },
    agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' }, high: { model: 'gemini-3.8-flash', effort: 'medium' } }] },
    copilot: { targets: [{ low: { model: 'gpt-6-astra', effort: 'low' } }] },
    opencode: { targets: [{ low: { model: 'opencode-go/glm-5.3-flash', effort: 'max' } }, { low: { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' } }] },
  },
  phases: {
    'code-review': { rounds: { low: 1 }, targets: { low: 1 }, consensus: { low: false }, only: ['claude'] },
  },
};

const R8_KEYS = ['exit', 'output', 'platform', 'session', 'slot', 'status'];
const slotKey = (target) => `ask:R1:${target.platform}:${target.candidateIndex}`;

let fixture;
before(() => { fixture = buildStubDispatchFixture(CONFIG); });
after(() => fixture?.cleanup());

const run = (args, opts) => runStubDispatch(fixture, args, opts);

/** The runner's own `--list-targets` order, which count/all pins must follow. */
function listTargets(extra = []) {
  const res = run(['--list-targets', ...extra]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function assertR8Line(line) {
  assert.deepEqual(Object.keys(line).sort(), R8_KEYS);
  assert.match(line.slot, /^ask:R1:(claude|agy|copilot|opencode):\d+$/);
  assert.ok(['ok', 'failed'].includes(line.status));
  assert.ok(line.exit === null || Number.isInteger(line.exit));
}

describe('dispatch --pins wave (R8)', () => {
  describe('count pins', () => {
    it('launches the first n level-resolved targets in one invocation and prints one R8 line per slot', () => {
      const expected = listTargets(['--orchestrator', 'claude']).slice(0, 3);
      const res = run(['--pins', '3', '--orchestrator', 'claude', 'Reply with OK.']);
      assert.equal(res.status, 0, res.stderr);
      const lines = parseSlotLines(res.stdout);
      assert.equal(lines.length, 3);
      assert.deepEqual(lines.map((l) => l.slot).sort(), expected.map(slotKey).sort());
      assert.equal(res.calls.length, 3, 'reserves are not launched when every target succeeds');
      for (const line of lines) {
        assertR8Line(line);
        assert.equal(line.status, 'ok');
        assert.equal(line.exit, 0);
        assert.equal(line.session, `${line.platform}-session`);
        assert.ok(line.output && fs.existsSync(line.output), 'report written to an OS-temp file');
        assert.match(fs.readFileSync(line.output, 'utf8'), new RegExp(`report from ${line.platform}`));
        if (process.platform !== 'win32') {
          assert.equal(fs.statSync(line.output).mode & 0o777, 0o600);
        }
      }
    });

    it('substitutes an ordered reserve for a failed non-orchestrator target', () => {
      const ordered = listTargets(['--orchestrator', 'claude']);
      const [first] = ordered;
      const firstReserve = ordered[2];
      const res = run(['--pins', '2', '--orchestrator', 'claude', 'Review'], {
        results: { [first.platform]: { exit: 1, failureKind: 'quota' } },
      });
      assert.equal(res.status, 0, res.stderr);
      const lines = parseSlotLines(res.stdout);
      lines.forEach(assertR8Line);
      assert.equal(lines.length, res.calls.length, 'one line per launched slot');
      const failed = lines.find((l) => l.slot === slotKey(first));
      assert.equal(failed.status, 'failed');
      assert.equal(failed.exit, 1);
      assert.equal(failed.output, null);
      const substitute = lines.find((l) => l.slot === slotKey(firstReserve));
      assert.ok(substitute, 'the first reserve ran');
      assert.equal(substitute.status, 'ok');
    });

    it('clamps a count above the candidate total with a stderr diagnostic', () => {
      const total = listTargets(['--orchestrator', 'claude']).length;
      const res = run(['--pins', '99', '--orchestrator', 'claude', 'Review']);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /clamp/i);
      assert.equal(parseSlotLines(res.stdout).length, total);
    });

    it('demotes the orchestrator (and its model) when selecting targets', () => {
      const expected = listTargets(['--orchestrator', 'agy', '--orchestrator-model', 'gemini-3.7-flash']).slice(0, 1);
      assert.notEqual(expected[0].platform, 'agy');
      const res = run(['--pins', '1', '--orchestrator', 'agy', '--orchestrator-model', 'gemini-3.7-flash', 'Review']);
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(parseSlotLines(res.stdout).map((l) => l.slot), expected.map(slotKey));
    });

    it('leaves an orchestrator-platform slot failure unresolved (exit 1)', () => {
      const res = run(['--pins', 'all', '--orchestrator', 'claude', 'Review'], {
        results: { claude: { exit: 1 } },
      });
      assert.equal(res.status, 1);
      const claudeLine = parseSlotLines(res.stdout).find((l) => l.platform === 'claude');
      assert.equal(claudeLine.status, 'failed');
    });
  });

  describe('all pins', () => {
    it('launches every target with no reserves', () => {
      const expected = listTargets(['--orchestrator', 'claude']);
      const res = run(['--pins', 'all', '--orchestrator', 'claude', 'Review']);
      assert.equal(res.status, 0, res.stderr);
      const lines = parseSlotLines(res.stdout);
      assert.deepEqual(lines.map((l) => l.slot).sort(), expected.map(slotKey).sort());
      assert.equal(res.calls.length, expected.length);
    });
  });

  describe('named pins', () => {
    it('runs one slot per distinct configured platform, in input order, with alias normalization', () => {
      const res = run(['--pins', 'antigravity,opencode,agy', '--orchestrator', 'claude', 'Review']);
      assert.equal(res.status, 0, res.stderr);
      const lines = parseSlotLines(res.stdout);
      lines.forEach(assertR8Line);
      assert.deepEqual(lines.map((l) => l.slot), ['ask:R1:agy:0', 'ask:R1:opencode:0']);
    });

    it('cascades within the pinned platform and reports the final attempt', () => {
      const res = run(['--pins', 'opencode', '--orchestrator', 'claude', 'Review'], {
        results: { 'opencode:opencode-go/glm-5.3-flash': { exit: 1, failureKind: 'quota' } },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(res.calls.map((c) => c.model), ['opencode-go/glm-5.3-flash', 'lmstudio/qwen3.8-27b-ridge']);
      const [line] = parseSlotLines(res.stdout);
      assert.equal(line.slot, 'ask:R1:opencode:0');
      assert.equal(line.status, 'ok');
      assert.equal(line.exit, 0);
    });

    it('has no reserves: a failed named slot is unresolved and the run exits 1', () => {
      const res = run(['--pins', 'agy', '--orchestrator', 'claude', 'Review'], { results: { agy: { exit: 1 } } });
      assert.equal(res.status, 1);
      const lines = parseSlotLines(res.stdout);
      assert.deepEqual(lines.map((l) => [l.slot, l.status, l.exit]), [['ask:R1:agy:0', 'failed', 1]]);
      assert.ok(res.calls.every((c) => c.provider === 'agy'), 'no other platform is launched');
    });

    it('rejects a named pin absent from read-delegates before launch, naming it', () => {
      const bogus = run(['--pins', 'bogus', 'Review']);
      assert.equal(bogus.status, 1);
      assert.match(bogus.stderr, /bogus/);
      assert.equal(bogus.calls.length, 0);
    });

    it('rejects a known provider missing from read-delegates', () => {
      const narrow = buildStubDispatchFixture({ 'read-delegates': { claude: { targets: [{ low: { model: 'claude-opus-5' } }] }, agy: { targets: [{ low: { model: 'gemini-3.8-flash' } }] } } });
      try {
        const res = runStubDispatch(narrow, ['--pins', 'agy,copilot', 'Review']);
        assert.equal(res.status, 1);
        assert.match(res.stderr, /copilot/);
        assert.equal(res.calls.length, 0);
      } finally {
        narrow.cleanup();
      }
    });

    it('ignores phases.<phase>.only for an ask wave', () => {
      const res = run(['--pins', 'agy', '--orchestrator', 'claude', 'Review']);
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(parseSlotLines(res.stdout).map((l) => l.platform), ['agy']);
    });
  });

  describe('level', () => {
    it('--level changes which candidates run', () => {
      const low = run(['--pins', 'agy', '--level', 'low', '--orchestrator', 'claude', 'Review']);
      assert.equal(low.status, 0, low.stderr);
      assert.deepEqual(low.calls.map((c) => c.model), ['gemini-3.7-flash']);
      const high = run(['--pins', 'agy', '--level', 'high', '--orchestrator', 'claude', 'Review']);
      assert.equal(high.status, 0, high.stderr);
      assert.deepEqual(high.calls.map((c) => c.model), ['gemini-3.8-flash']);
    });

    it('writes one [dispatch] level/source stderr line per run', () => {
      const cases = [
        [['--level', 'high'], 'level=high source=explicit'],
        [['--level', 'high', '--level-source', 'classified'], 'level=high source=classified'],
        [[], 'level=medium source=default'],
      ];
      for (const [flags, expected] of cases) {
        const res = run(['--pins', 'agy', '--orchestrator', 'claude', ...flags, 'Review']);
        assert.equal(res.status, 0, res.stderr);
        const bannerLines = res.stderr.split(/\r?\n/).filter((l) => /^\[dispatch\] level=/.test(l));
        assert.deepEqual(bannerLines, [`[dispatch] ${expected}`]);
      }
    });
  });

  describe('conflicts', () => {
    for (const [flags, name] of [
      [['--provider', 'claude'], '--provider'],
      [['--candidate-index', '0'], '--candidate-index'],
      [['--no-config'], '--no-config'],
      [['-m', 'x'], '--model'],
      [['-e', 'low'], '--effort'],
    ]) {
      it(`rejects --pins with ${name}`, () => {
        const res = run(['--pins', '2', ...flags, 'Review']);
        assert.equal(res.status, 1);
        assert.match(res.stderr, new RegExp(`--pins cannot be combined with: .*${name}`));
        assert.equal(res.calls.length, 0);
      });
    }

    for (const pins of [['--pins='], ['--pins', ','], ['--pins', '']]) {
      it(`rejects an empty pin list (${pins.join(' ')})`, () => {
        const res = run([...pins, 'Review']);
        assert.equal(res.status, 1);
        assert.match(res.stderr, /--pins requires provider keys, a count, or "all"/);
        assert.equal(res.calls.length, 0);
      });
    }

    it('rejects --pins with --batch-file', () => {
      const res = run(['--pins', '2', '--batch-file', fixture.dir, 'Review']);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--pins/);
      assert.match(res.stderr, /--batch-file/);
      assert.equal(res.calls.length, 0);
    });

    for (const mode of ['--validate-only', '--list-platforms', '--list-targets', '--doctor']) {
      it(`rejects --pins with ${mode}`, () => {
        const res = run([mode, '--pins', '2']);
        assert.equal(res.status, 1);
        assert.match(res.stderr, /cannot be combined with: .*--pins/);
      });
    }

    it('treats --pins after the -- separator as prompt text', () => {
      const res = run(['--', '--pins']);
      assert.equal(res.status, 0, res.stderr);
      assert.doesNotMatch(res.stderr, /--pins requires/);
      assert.match(res.stdout, /report from/, 'a plain cascade prints its report, not slot lines');
    });

    it('rejects an empty --pins value with an inspection mode', () => {
      const res = run(['--doctor', '--pins', '']);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /cannot be combined with: .*--pins/);
    });
  });
});
