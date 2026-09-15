import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';

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
  runAgy,

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

    it('threads the runner timeout into the CLI as --print-timeout=<seconds>s', () => {
      const args = buildAgyArgs('prompt', null, { model: null, effort: null, timeout: 120 });
      assert.ok(args.includes('--print-timeout=120s'), `expected the print timeout on argv, got: ${args.join(' ')}`);
    });

    it('enforces preference order: Antigravity CLI > Antigravity 2.0 > VS Code Extension', () => {
      assert.deepEqual(AGY_MODE_PREFERENCE, [
        'antigravity-cli',
        'antigravity-2.0',
        'antigravity-vscode',
      ]);
      assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_CLI], 'antigravity-cli');
      assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_2_0], 'antigravity');
      assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_VSCODE], 'antigravity-ide');
      assert.equal(AGY_MODE_LABELS[AGY_MODES.ANTIGRAVITY_CLI], 'Antigravity CLI (agy)');
    });
  });

  describe('discovery across modes & platforms', () => {
    it('detects mode presence across platforms and environments', () => {
      assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_2_0), 'boolean');
      assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_VSCODE), 'boolean');
      assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_CLI), 'boolean');
    });

    it('resolves binary across modes and platforms', { skip: !getAgyBinary() && !getAgy20Binary() && !getAgyVSCodeBinary() && !getAgyCliBinary() ? 'no Antigravity binary installed' : false }, () => {
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
      assert.deepEqual(modes, ['antigravity-cli', 'antigravity-2.0', 'antigravity-vscode']);

      for (const probe of probes) {
        assert.ok('mode' in probe);
        assert.ok('name' in probe);
        assert.ok('present' in probe);
        assert.ok('bin' in probe);
        assert.ok('reachable' in probe);
      }
    });

    it('resolves target in preference order or explicit override', { skip: !resolveAgyTarget() ? 'no Antigravity target resolved' : false }, () => {
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

    it('scans the mode-scoped brain directory and returns the newest conversation', () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-brain-scan-'));
      const originalAppData = process.env.APPDATA;
      const originalLocalAppData = process.env.LOCALAPPDATA;
      try {
        process.env.APPDATA = fixture;
        process.env.LOCALAPPDATA = fixture;
        const brainDir = path.join(fixture, 'antigravity', 'brain');
        fs.mkdirSync(brainDir, { recursive: true });
        fs.mkdirSync(path.join(brainDir, 'older-conversation'));
        fs.mkdirSync(path.join(brainDir, 'newest-conversation'));
        fs.mkdirSync(path.join(brainDir, 'scratch'));
        // Explicit mtimes: two mkdirs inside the same clock tick would tie and make this flaky.
        const older = new Date(Date.now() - 600000);
        fs.utimesSync(path.join(brainDir, 'older-conversation'), older, older);
        const newer = new Date();
        fs.utimesSync(path.join(brainDir, 'newest-conversation'), newer, newer);

        const id = getNewestBrainConversationId(0, AGY_MODES.ANTIGRAVITY_2_0);
        assert.equal(id, 'newest-conversation', 'the newest mtime wins and the scratch dir is skipped');
      } finally {
        // Conditional restore: assigning `undefined` stringifies to the literal "undefined"
        // where the var was unset (POSIX), polluting the env for the rest of the file.
        if (originalAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = originalAppData;
        if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = originalLocalAppData;
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });

    it('modifiedAfterMs filters out conversations older than the threshold', () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-brain-filter-'));
      const originalAppData = process.env.APPDATA;
      const originalLocalAppData = process.env.LOCALAPPDATA;
      try {
        process.env.APPDATA = fixture;
        process.env.LOCALAPPDATA = fixture;
        const brainDir = path.join(fixture, 'antigravity', 'brain');
        fs.mkdirSync(brainDir, { recursive: true });
        fs.mkdirSync(path.join(brainDir, 'stale-conversation'));
        const stale = new Date(Date.now() - 600000);
        fs.utimesSync(path.join(brainDir, 'stale-conversation'), stale, stale);

        const id = getNewestBrainConversationId(Date.now() - 60000, AGY_MODES.ANTIGRAVITY_2_0);
        assert.equal(id, null, 'a conversation older than the threshold is not returned');
      } finally {
        if (originalAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = originalAppData;
        if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = originalLocalAppData;
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });

    it('checks mode availability and returns active modes in preference order', async () => {
      const activeModes = await getAvailableAgyModes();
      assert.ok(Array.isArray(activeModes));
      for (const m of activeModes) {
        assert.ok(AGY_MODE_PREFERENCE.includes(m));
      }

      const overall = await isAgyAvailable();
      // Consistency, not a hardcoded true/false: availability needs at least one reachable mode,
      // or the plain-binary fallback to reach.
      const bin = getAgyBinary();
      if (overall === false) {
        assert.equal(activeModes.length, 0);
        assert.ok(!bin || !testAgyBinaryReachability(bin).reachable, 'no fallback reach either');
      }
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

    it('falls back to the output field when response/result/text are absent', () => {
      assert.equal(parseAgyEnvelope('{"conversationId":"o1","output":"the body"}').text, 'the body');
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

// The cascade loop was uncovered because executeAgyInMode spawns a subprocess and opens a session
// log. runAgy takes those as seams, so these tests assert what the loop itself decides — nothing
// about subprocess plumbing.
describe('runAgy cascade loop', () => {
  const MODES = [AGY_MODES.ANTIGRAVITY_CLI, AGY_MODES.ANTIGRAVITY_2_0, AGY_MODES.ANTIGRAVITY_VSCODE];

  /** A result the loop reads as "reached the mode, but out of tokens" — the cascade trigger. */
  const quotaResult = (mode) => ({ exitCode: 1, failureKind: 'quota', stdout: '', stderr: 'usage limit reached', mode });
  const okResult = (mode) => ({ exitCode: 0, failureKind: null, stdout: 'done', stderr: '', mode });

  function harness({ results = [], modes = MODES } = {}) {
    const calls = [];
    let probed = 0;
    let opened = 0;
    let closed = 0;
    return {
      calls,
      probedCount: () => probed,
      openedCount: () => opened,
      closedCount: () => closed,
      options: {
        prompt: 'x',
        getBinary: () => '/fake/agy',
        getAvailableModes: async () => {
          probed += 1;
          return modes;
        },
        createLogger: () => {
          opened += 1;
          let isClosed = false;
          // Mirrors createSessionLogger's idempotent close, so a double call counts once.
          return { logFile: null, write() {}, close() { if (!isClosed) { isClosed = true; closed += 1; } } };
        },
        execute: async (mode) => {
          calls.push(mode);
          const next = results[calls.length - 1];
          if (next instanceof Error) throw next;
          return next ?? okResult(mode);
        },
      },
    };
  }

  // The bug this finding exists for: the guard read `!requestedMode` where `!pinnedMode` was meant.
  // 'auto' is truthy but pins nothing, so it — and only it — exposed the inversion. With no mode
  // given (`null`) or a real mode pinned, the buggy guard behaved correctly.
  for (const key of ['modeVariant', 'agyMode']) {
    it(`cascades when ${key} is 'auto' and mode 1 is out of tokens`, async () => {
      const h = harness({ results: [quotaResult(MODES[0]), okResult(MODES[1])] });
      const result = await runAgy({ ...h.options, [key]: 'auto' });
      assert.deepEqual(h.calls, [MODES[0], MODES[1]]);
      assert.equal(result.exitCode, 0);
    });
  }

  it('cascades past a quota result and returns the mode that succeeded', async () => {
    const h = harness({ results: [quotaResult(MODES[0]), okResult(MODES[1])] });
    const result = await runAgy(h.options);
    assert.deepEqual(h.calls, [MODES[0], MODES[1]]);
    assert.equal(result.mode, MODES[1]);
  });

  it('returns the first success without touching later modes', async () => {
    const h = harness({ results: [okResult(MODES[0])] });
    await runAgy(h.options);
    assert.deepEqual(h.calls, [MODES[0]]);
  });

  it('a pinned mode never advances, and the availability probe is never run', async () => {
    const h = harness({ results: [quotaResult(MODES[0])] });
    const result = await runAgy({ ...h.options, modeVariant: MODES[0] });
    assert.deepEqual(h.calls, [MODES[0]], 'pinned mode must not cascade');
    assert.equal(h.probedCount(), 0, 'pinning must skip the probe entirely');
    assert.equal(result.failureKind, 'quota', 'the pinned mode result is returned as-is');
  });

  it('a thrown error advances while modes remain and propagates on the last', async () => {
    const boom = new Error('spawn failed');
    const h = harness({ results: [boom, okResult(MODES[1])] });
    assert.equal((await runAgy(h.options)).exitCode, 0);

    const allFail = harness({ results: [boom, boom, boom] });
    await assert.rejects(() => runAgy(allFail.options), /spawn failed/);
    assert.deepEqual(allFail.calls, MODES, 'every mode is tried before giving up');
  });

  it('returns the last result when every mode was reached but none succeeded', async () => {
    const h = harness({ results: MODES.map(quotaResult) });
    const result = await runAgy(h.options);
    assert.deepEqual(h.calls, MODES);
    assert.equal(result.mode, MODES[2], 'the last attempt is what comes back');
  });

  // runAgy creates a logger per attempt and executeAgyInMode closes it on the child's
  // 'close'/'error' events. A throw before the child is spawned reaches neither, and the loop
  // then cascades and opens another - so the loop itself has to guarantee the close.
  it('closes every attempt logger it opened, including when the executor throws', async () => {
    const boom = new Error('spawn failed');

    const cascaded = harness({ results: [boom, quotaResult(MODES[1]), okResult(MODES[2])] });
    await runAgy(cascaded.options);
    assert.equal(cascaded.openedCount(), 3, 'one logger per attempt');
    assert.equal(cascaded.closedCount(), 3, 'no attempt leaks its logger');

    const allThrow = harness({ results: [boom, boom, boom] });
    await assert.rejects(() => runAgy(allThrow.options));
    assert.equal(allThrow.closedCount(), allThrow.openedCount(), 'the rethrowing path closes too');

    const success = harness({ results: [okResult(MODES[0])] });
    await runAgy(success.options);
    assert.equal(success.closedCount(), 1, 'the success path closes exactly once');
  });

  it('an array model tries each model in order, one string --model per attempt', async () => {
    const seen = [];
    const h = harness();
    const result = await runAgy({
      ...h.options,
      modeVariant: MODES[0],
      model: ['m-a', 'm-b'],
      execute: async (mode, { model }) => {
        assert.equal(typeof model, 'string');
        assert.ok(!model.includes(','), 'each attempt receives one model');
        seen.push(model);
        return model === 'm-a' ? { exitCode: 1, failureKind: 'other', stdout: '', stderr: '', mode } : okResult(mode);
      },
    });
    assert.deepEqual(seen, ['m-a', 'm-b']);
    assert.equal(result.exitCode, 0);
  });

  it('throws CLI_NOT_FOUND before the loop when no binary is present', async () => {
    const h = harness();
    await assert.rejects(() => runAgy({ ...h.options, getBinary: () => null }), (err) => err.code === 'CLI_NOT_FOUND');
    assert.deepEqual(h.calls, [], 'the executor is never reached');
  });
});
