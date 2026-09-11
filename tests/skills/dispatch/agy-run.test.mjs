import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';

import {
  getArgvByteLimit,
  preparePromptForArgv,
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
  runAgy,
  buildAgyArgs,
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

    it('runAgy is a function', () => {
      assert.equal(typeof runAgy, 'function');
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
});
