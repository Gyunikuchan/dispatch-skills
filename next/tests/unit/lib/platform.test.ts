import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectOrchestrator, platformFacts } from '../../../skills/dispatch/scripts/lib/platform.ts';

const envOf = (values: Record<string, string>) => (name: string): string | undefined => values[name];

test('platform facts: os, WSL, bubblewrap, argv limit, PATH and PATHEXT', () => {
  const win = platformFacts({ platform: 'win32', arch: 'x64', release: '10', home: 'C:\\u', env: envOf({ Path: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' }), bubblewrap: true });
  assert.deepEqual(win, { os: 'win32', arch: 'x64', wsl: false, bubblewrap: false, argvLimit: 24000, home: 'C:\\u', path: ['C:\\a', 'C:\\b'], pathExt: ['.exe', '.cmd'] });
  const wsl = platformFacts({ platform: 'linux', arch: 'x64', release: '5.15.0-microsoft-standard-WSL2', home: '/h', env: envOf({ PATH: '/a:/b' }), bubblewrap: true });
  assert.deepEqual([wsl.os, wsl.wsl, wsl.bubblewrap, wsl.argvLimit, wsl.path, wsl.pathExt], ['linux', true, true, 100000, ['/a', '/b'], []]);
  assert.equal(platformFacts({ platform: 'darwin', arch: 'arm64', release: '', home: '/h', env: envOf({}), bubblewrap: true }).bubblewrap, false);
});

test('grammar-orchestrator-demotion: orchestrator detection from env markers, in legacy order, with override', () => {
  assert.equal(detectOrchestrator(envOf({})), null);
  assert.deepEqual(detectOrchestrator(envOf({ CLAUDECODE: '1', ANTHROPIC_MODEL: 'opus' })), { platform: 'claude', model: 'opus' });
  assert.deepEqual(detectOrchestrator(envOf({ CLAUDECODE: '1', GEMINI_CLI: '1' })), { platform: 'agy', model: null });
  assert.deepEqual(detectOrchestrator(envOf({ CODEX_THREAD_ID: 't', CODEX_MODEL: 'gpt-5' })), { platform: 'codex', model: 'gpt-5' });
  assert.deepEqual(detectOrchestrator(envOf({ VSCODE_PID: '1' })), null);
  // An explicit --orchestrator demotes the env-detected platform.
  assert.deepEqual(detectOrchestrator(envOf({ CLAUDECODE: '1' }), { platform: 'copilot', model: 'gpt-5' }), { platform: 'copilot', model: 'gpt-5' });
});
