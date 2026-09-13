import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';

import {
  getArgvByteLimit,
  preparePromptForArgv,
  resolveRunnerExitCode,
} from '../../../skills/dispatch/scripts/common.mjs';

import {
  AGY_MODES,
  AGY_MODE_PREFERENCE,
  AGY_MODE_DATA_DIRS,
  AGY_MODE_LABELS,
  getAgyBinary,
  getAgy20Binary,
  getAgyVSCodeBinary,
  getAgyCliBinary,
  detectAgyModePresence,
  isAgyModeAvailable,
  getAvailableAgyModes,
  isAgyAvailable,
  resolveAgyTarget,
  testAgyBinaryReachability,
  probeAllAgyModes,
  getNewestBrainConversationId,

  buildAgyArgs,
  parseAgyEnvelope,
  isSubscriptionOrTokenIssue,
  nextAgyStep,
  resolveModePlan,
} from '../../../skills/dispatch/scripts/agy-run.mjs';

describe('agy-run: multi-mode discovery, reachability & argument construction', () => {
  describe('constants & preference order', () => {
    it('omits -m/-e entirely when model/effort are null (no hardcoded default)', () => {
      const args = buildAgyArgs('prompt', null, { model: null, effort: null, timeout: 60 });
      assert.ok(!args.includes('--model'));
      assert.ok(!args.includes('--effort'));
    });

    it('includes -m/-e when model/effort are provided (e.g. from dispatch config)', () => {
      const args = buildAgyArgs('prompt', null, { model: 'gemini-3.8-flash', effort: 'medium', timeout: 60 });
      assert.ok(args.includes('--model'));
      assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash');
      assert.ok(args.includes('--effort'));
      assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    });

    it('requests a JSON envelope so the conversation id is reported, not guessed', () => {
      const args = buildAgyArgs('prompt', null, { model: null, effort: null, timeout: 60 });
      assert.ok(args.includes('--output-format'));
      assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    });

    it('enforces preference order: Antigravity 2.0 > VS Code Extension > CLI', () => {
      assert.deepEqual(AGY_MODE_PREFERENCE, [
        'antigravity-2.0',
        'antigravity-vscode',
        'antigravity-cli',
      ]);
      assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_2_0], 'antigravity');
      assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_VSCODE], 'antigravity-ide');
      assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_CLI], 'antigravity-cli');
      assert.equal(AGY_MODE_LABELS[AGY_MODES.ANTIGRAVITY_2_0], 'Antigravity 2.0 (agy)');
    });
  });

  describe('discovery across modes & platforms', () => {
    it('detects mode presence across platforms and environments', () => {
      assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_2_0), 'boolean');
      assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_VSCODE), 'boolean');
      assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_CLI), 'boolean');
    });

    it('resolves binary across modes and platforms', () => {
      const general = getAgyBinary();
      const agy20 = getAgy20Binary();
      const agyVscode = getAgyVSCodeBinary();
      const agyCli = getAgyCliBinary();

      if (general) {
        assert.equal(typeof general, 'string');
        assert.ok(fs.existsSync(general));
      }
      if (agy20) assert.ok(fs.existsSync(agy20));
      if (agyVscode) assert.ok(fs.existsSync(agyVscode));
      if (agyCli) assert.ok(fs.existsSync(agyCli));
    });

    it('tests reachability up to reaching the binary without requiring tokens', () => {
      const bin = getAgyBinary();
      if (bin) {
        const result = testAgyBinaryReachability(bin, AGY_MODES.ANTIGRAVITY_CLI);
        assert.ok('reachable' in result);
        assert.ok('error' in result);
      }

      const invalid = testAgyBinaryReachability('/nonexistent/path/agy');
      assert.equal(invalid.reachable, false);
      assert.ok(invalid.error.includes('does not exist'));
    });

    it('probes all modes and returns diagnostic presence and reachability', async () => {
      const probes = await probeAllAgyModes();
      assert.ok(Array.isArray(probes));
      assert.equal(probes.length, 3);

      const modes = probes.map((p) => p.mode);
      assert.deepEqual(modes, ['antigravity-2.0', 'antigravity-vscode', 'antigravity-cli']);

      for (const probe of probes) {
        assert.ok('mode' in probe);
        assert.ok('name' in probe);
        assert.ok('present' in probe);
        assert.ok('bin' in probe);
        assert.ok('reachable' in probe);
      }
    });

    it('resolves target in preference order or explicit override', () => {
      const target = resolveAgyTarget();
      if (target) {
        assert.ok(AGY_MODE_PREFERENCE.includes(target.mode));
        assert.ok(target.bin !== undefined);
        assert.ok(target.dataDir !== undefined);
      }

      const pinnedCli = resolveAgyTarget(AGY_MODES.ANTIGRAVITY_CLI);
      if (pinnedCli) {
        assert.equal(pinnedCli.mode, AGY_MODES.ANTIGRAVITY_CLI);
        assert.equal(pinnedCli.dataDir, 'antigravity-cli');
      }
    });

    it('returns newest brain conversation id from mode directory', () => {
      const id = getNewestBrainConversationId(0, AGY_MODES.ANTIGRAVITY_2_0);
      assert.ok(id === null || typeof id === 'string');
    });

    it('checks mode availability and returns active modes in preference order', async () => {
      const isCliAvail = await isAgyModeAvailable(AGY_MODES.ANTIGRAVITY_CLI);
      assert.equal(typeof isCliAvail, 'boolean');

      const activeModes = await getAvailableAgyModes();
      assert.ok(Array.isArray(activeModes));
      for (const m of activeModes) {
        assert.ok(AGY_MODE_PREFERENCE.includes(m));
      }

      const overall = await isAgyAvailable();
      assert.equal(typeof overall, 'boolean');
    });

  });

  describe('argument construction: brief file and safety flags', () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-args-test-'));
    const created = [scratchDir];

    const scratchFile = (dir, name, contents) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, contents, 'utf8');
      return p;
    };

    after(() => {
      for (const target of created) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      }
    });

    it('includes --add-dir <briefFile dir> when prompt overflowed to a brief file', () => {
      const briefFile = scratchFile(scratchDir, 'brief.md', 'task content');
      const args = buildAgyArgs('read this brief file', briefFile, {
        model: 'gemini-3.8-flash',
        effort: 'medium',
        timeout: 1800,
      });

      const idx = args.indexOf('--add-dir');
      assert.ok(idx !== -1, 'expected --add-dir flag in agyArgs when briefFile is set');
      assert.equal(args[idx + 1], path.dirname(briefFile));
      // agy has no -f/--file flag; passing one is a hard CLI parse error.
      assert.ok(!args.includes('-f'), 'agy CLI does not support -f');
      assert.ok(args.includes('--mode'));
      assert.ok(args.includes('plan'));
      assert.ok(args.includes('--dangerously-skip-permissions'));
    });

    it('omits --add-dir when no brief file was created (prompt fit on argv)', () => {
      const args = buildAgyArgs('short prompt', null, {
        model: 'gemini-3.8-flash',
        effort: 'medium',
        timeout: 1800,
      });

      assert.ok(!args.includes('--add-dir'), 'expected no --add-dir flag when briefFile is null');
      assert.ok(args.includes('--dangerously-skip-permissions'), 'expected --dangerously-skip-permissions flag');
    });

    it('places --add-dir before --model and --mode so agy grants directory access before task flags', () => {
      const briefFile = scratchFile(scratchDir, 'order-brief.md', 'order test');
      const args = buildAgyArgs('pointer', briefFile, {
        model: 'gemini-3.8-flash',
        effort: 'medium',
        timeout: 1800,
      });

      const addDirIdx = args.indexOf('--add-dir');
      const modelIdx = args.indexOf('--model');
      const modeIdx = args.indexOf('--mode');
      assert.ok(addDirIdx < modelIdx, '--add-dir should appear before --model');
      assert.ok(addDirIdx < modeIdx, '--add-dir should appear before --mode');
    });
  });

  describe('exit code & output resolution', () => {
    it('preserves exit code 0 when stdout contains keywords like timeout or rate limit', () => {
      const stdout = 'Review: observed timeout issue in network handler';
      const clean = stdout;
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: clean }), 0);
    });

    it('forces exit code 1 when agy exits 0 with empty stdout', () => {
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: '' }), 1);
    });
  });

  describe('isSubscriptionOrTokenIssue', () => {
    it('detects quota / rate-limit / 429 text', () => {
      assert.equal(isSubscriptionOrTokenIssue('Error: usage limit exceeded'), true);
      assert.equal(isSubscriptionOrTokenIssue('HTTP 429 too many requests'), true);
    });

    it('detects unauthorized / 401 text', () => {
      assert.equal(isSubscriptionOrTokenIssue('401 Unauthorized: invalid api key'), true);
    });

    it('detects "not signed in" text', () => {
      assert.equal(isSubscriptionOrTokenIssue('Error: not signed in to antigravity'), true);
    });

    it('returns false for neutral text or non-string input', () => {
      assert.equal(isSubscriptionOrTokenIssue('All good, task complete.'), false);
      assert.equal(isSubscriptionOrTokenIssue(''), false);
      assert.equal(isSubscriptionOrTokenIssue(null), false);
      assert.equal(isSubscriptionOrTokenIssue(undefined), false);
      assert.equal(isSubscriptionOrTokenIssue(42), false);
    });
  });

  describe('resolveModePlan (pure mode-cascade decision)', () => {
    const twoModes = [AGY_MODES.ANTIGRAVITY_2_0, AGY_MODES.ANTIGRAVITY_VSCODE];

    it("'auto' does not pin, so the cascade stays open", () => {
      const plan = resolveModePlan({ requestedMode: 'auto', availableModes: twoModes });
      assert.equal(plan.pinnedMode, null);
      assert.deepEqual(plan.modesToTry, twoModes);
    });

    it('an explicit mode pins to exactly that mode', () => {
      const plan = resolveModePlan({ requestedMode: AGY_MODES.ANTIGRAVITY_VSCODE, availableModes: twoModes });
      assert.equal(plan.pinnedMode, AGY_MODES.ANTIGRAVITY_VSCODE);
      assert.deepEqual(plan.modesToTry, [AGY_MODES.ANTIGRAVITY_VSCODE]);
    });

    it('no requested mode cascades over the available modes', () => {
      const plan = resolveModePlan({ requestedMode: null, availableModes: twoModes });
      assert.equal(plan.pinnedMode, null);
      assert.deepEqual(plan.modesToTry, twoModes);
    });

    it('falls back to the preference order when nothing is available', () => {
      const plan = resolveModePlan({ requestedMode: null, availableModes: [] });
      assert.deepEqual(plan.modesToTry, AGY_MODE_PREFERENCE);
      assert.notEqual(plan.modesToTry, AGY_MODE_PREFERENCE, 'must be a copy, not the shared array');
    });

    it('tolerates omitted arguments', () => {
      assert.deepEqual(resolveModePlan().modesToTry, AGY_MODE_PREFERENCE);
      assert.equal(resolveModePlan({ requestedMode: 'auto' }).pinnedMode, null);
    });

    it("composes with nextAgyStep so '--agy-mode auto' cascades on a token issue", () => {
      // The regression: the cascade guard read `!requestedMode`, which is false for the string
      // 'auto', so an auto run built the full list and then returned on the first mode's quota
      // failure instead of falling through.
      const { modesToTry, pinnedMode } = resolveModePlan({ requestedMode: 'auto', availableModes: twoModes });
      const hasNextMode = 0 < modesToTry.length - 1 && !pinnedMode;
      assert.equal(hasNextMode, true);
      assert.equal(
        nextAgyStep({
          result: { exitCode: 1, stdout: '', stderr: 'insufficient tokens', failureKind: 'quota' },
          hasNextMode,
        }),
        'next-mode',
      );
    });

    it('an explicitly pinned mode still refuses to cascade on a token issue', () => {
      const { modesToTry, pinnedMode } = resolveModePlan({
        requestedMode: AGY_MODES.ANTIGRAVITY_2_0,
        availableModes: twoModes,
      });
      const hasNextMode = 0 < modesToTry.length - 1 && !pinnedMode;
      assert.equal(hasNextMode, false);
      assert.notEqual(
        nextAgyStep({
          result: { exitCode: 1, stdout: '', stderr: 'insufficient tokens', failureKind: 'quota' },
          hasNextMode,
        }),
        'next-mode',
      );
    });
  });

  describe('nextAgyStep (pure cascade decision)', () => {
    it('exit 0 with non-empty stdout -> return', () => {
      const step = nextAgyStep({
        result: { exitCode: 0, stdout: 'done', stderr: '', failureKind: null },
        hasNextMode: true,
      });
      assert.equal(step, 'return');
    });

    it('exit 0 with empty stdout, no token issue -> return', () => {
      const step = nextAgyStep({
        result: { exitCode: 0, stdout: '', stderr: '', failureKind: null },
        hasNextMode: true,
      });
      assert.equal(step, 'return');
    });

    it('non-zero exit, no token issue, next mode available -> return', () => {
      const step = nextAgyStep({
        result: { exitCode: 1, stdout: '', stderr: 'generic failure', failureKind: 'other' },
        hasNextMode: true,
      });
      assert.equal(step, 'return');
    });

    it('token issue + next mode available -> next-mode', () => {
      const step = nextAgyStep({
        result: { exitCode: 1, stdout: '', stderr: '', failureKind: 'quota' },
        hasNextMode: true,
      });
      assert.equal(step, 'next-mode');
    });

    it('token issue detected via output text (not failureKind) + next mode -> next-mode', () => {
      const step = nextAgyStep({
        result: { exitCode: 1, stdout: '', stderr: 'not signed in', failureKind: null },
        hasNextMode: true,
      });
      assert.equal(step, 'next-mode');
    });

    it('token issue, pinned (no next mode) -> return', () => {
      const step = nextAgyStep({
        result: { exitCode: 1, stdout: '', stderr: '', failureKind: 'auth' },
        hasNextMode: false,
      });
      assert.equal(step, 'return');
    });

    it('token issue, last mode (no next mode) -> return', () => {
      const step = nextAgyStep({
        result: { exitCode: 1, stdout: '', stderr: '', failureKind: 'quota' },
        hasNextMode: false,
      });
      assert.equal(step, 'return');
    });
  });

  describe('parseAgyEnvelope', () => {
    it('extracts the conversation id and response text from the envelope', () => {
      const parsed = parseAgyEnvelope(
        JSON.stringify({ conversationId: 'abc-123', response: 'The review body.' }),
      );
      assert.equal(parsed.conversationId, 'abc-123');
      assert.equal(parsed.text, 'The review body.');
    });

    it('accepts snake_case and nested conversation shapes', () => {
      assert.equal(parseAgyEnvelope('{"conversation_id":"s1","result":"x"}').conversationId, 's1');
      assert.equal(parseAgyEnvelope('{"conversation":{"id":"n1"},"text":"x"}').conversationId, 'n1');
    });

    it('skips a banner line preceding the envelope', () => {
      const parsed = parseAgyEnvelope('Starting agy...\n{"conversationId":"b1","response":"body"}');
      assert.equal(parsed.conversationId, 'b1');
      assert.equal(parsed.text, 'body');
    });

    it('returns nulls for non-JSON output so the caller can fall back', () => {
      // An older agy ignores --output-format; losing the run would be worse than losing the id.
      for (const raw of ['', '   ', 'plain text answer', '{not json']) {
        const parsed = parseAgyEnvelope(raw);
        assert.equal(parsed.conversationId, null);
        assert.equal(parsed.text, null);
      }
    });

    it('returns a null id when the envelope omits one', () => {
      const parsed = parseAgyEnvelope('{"response":"body"}');
      assert.equal(parsed.conversationId, null);
      assert.equal(parsed.text, 'body');
    });
  });
});
