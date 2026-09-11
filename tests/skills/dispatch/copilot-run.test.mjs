import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCopilotArgs,
  getCopilotDesktopCandidates,
  getCopilotVscodeCandidates,
  getCopilotCliCandidates,
  getCopilotDesktopBinary,
  getCopilotVscodeBinary,
  getCopilotCliBinary,
  getCopilotBinary,
  resolveCopilotTarget,
  testCopilotReachability,
  probeCopilotModes,
  isCopilotAvailable,
  classifyCopilotFailure,
} from '../../../skills/dispatch/scripts/copilot-run.mjs';

describe('copilot-run: runner discovery, reachability & auth classification', () => {
  describe('constants & defaults', () => {
    it('omits -m/-e entirely when model/effort are null (no hardcoded default)', () => {
      const args = buildCopilotArgs('prompt', { model: null, effort: null });
      assert.ok(!args.includes('--model'));
      assert.ok(!args.includes('--effort'));
    });

    it('includes -m/-e when model/effort are provided (e.g. from dispatch config)', () => {
      const args = buildCopilotArgs('prompt', { model: 'gpt-5.6-luna', effort: 'max' });
      assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-luna');
      assert.equal(args[args.indexOf('--effort') + 1], 'max');
    });
  });

  describe('discovery across modes & platforms', () => {
    it('gathers candidate paths for current platform across all modes', () => {
      const desktopCandidates = getCopilotDesktopCandidates();
      const vscodeCandidates = getCopilotVscodeCandidates();
      const cliCandidates = getCopilotCliCandidates();

      assert.ok(Array.isArray(desktopCandidates));
      assert.ok(Array.isArray(vscodeCandidates));
      assert.ok(Array.isArray(cliCandidates));
      assert.ok(desktopCandidates.length > 0);
      assert.ok(vscodeCandidates.length > 0);
      assert.ok(cliCandidates.length > 0);
    });

    it('tests reachability of an executable binary up to --version without token consumption', () => {
      const result = testCopilotReachability(process.execPath);
      assert.equal(result.reachable, true);
      assert.ok(/^v\d+\./.test(result.version));
      assert.equal(result.error, null);
    });

    it('reports unreachable for non-existent binary without throwing', () => {
      const result = testCopilotReachability('/path/to/non-existent-copilot-binary');
      assert.equal(result.reachable, false);
      assert.equal(result.version, null);
      assert.ok(result.error !== null);
    });

    it('supports explicit mode override in resolution', () => {
      const targetDesktop = resolveCopilotTarget('desktop');
      if (targetDesktop) {
        assert.equal(targetDesktop.mode, 'desktop');
      }

      const targetVscode = resolveCopilotTarget('vscode');
      if (targetVscode) {
        assert.equal(targetVscode.mode, 'vscode');
      }

      const targetCli = resolveCopilotTarget('cli');
      if (targetCli) {
        assert.equal(targetCli.mode, 'cli');
      }
    });

    it('follows preference order: copilot desktop > copilot vscode > copilot cli', () => {
      const desktopBin = getCopilotDesktopBinary();
      const vscodeBin = getCopilotVscodeBinary();
      const cliBin = getCopilotCliBinary();
      const resolved = resolveCopilotTarget();

      if (desktopBin && testCopilotReachability(desktopBin).reachable) {
        assert.equal(resolved?.mode, 'desktop');
        assert.equal(getCopilotBinary(), desktopBin);
      } else if (vscodeBin && testCopilotReachability(vscodeBin).reachable) {
        assert.equal(resolved?.mode, 'vscode');
        assert.equal(getCopilotBinary(), vscodeBin);
      } else if (cliBin && testCopilotReachability(cliBin).reachable) {
        assert.equal(resolved?.mode, 'cli');
        assert.equal(getCopilotBinary(), cliBin);
      }
    });

    it('probes all copilot modes without consuming tokens', () => {
      const probe = probeCopilotModes();
      assert.ok('desktop' in probe);
      assert.ok('vscode' in probe);
      assert.ok('cli' in probe);
      assert.equal(typeof probe.desktop.reachable, 'boolean');
      assert.equal(typeof probe.vscode.reachable, 'boolean');
      assert.equal(typeof probe.cli.reachable, 'boolean');
    });

    it('checks Copilot availability without requiring subscription or tokens', async () => {
      const available = await isCopilotAvailable();
      assert.equal(typeof available, 'boolean');
    });
  });

  describe('auth error classification', () => {
    it('classifies Copilot-specific auth errors', () => {
      assert.equal(
        classifyCopilotFailure(
          'Error: No authentication information found.\nCopilot can be authenticated with GitHub using an OAuth Token.',
        ),
        'auth',
      );
      assert.equal(
        classifyCopilotFailure('You need an active GitHub Copilot subscription to use this feature.'),
        'auth',
      );
      assert.equal(
        classifyCopilotFailure('Please run `gh auth login` to authenticate'),
        'auth',
      );
    });
  });
});
