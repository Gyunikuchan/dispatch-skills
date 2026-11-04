import assert from 'node:assert/strict';
import { test } from 'node:test';

import { orchestratorFor, platformFacts } from '../../../skills/dispatch/scripts/lib/platform.ts';

const envOf = (values: Record<string, string>) => (name: string): string | undefined => values[name];

test('platform facts: os, WSL, bubblewrap, argv limit, PATH and PATHEXT', () => {
  const win = platformFacts({ platform: 'win32', arch: 'x64', release: '10', home: 'C:\\u', env: envOf({ Path: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' }), bubblewrap: true });
  assert.deepEqual(win, { os: 'win32', arch: 'x64', wsl: false, bubblewrap: false, argvLimit: 24000, home: 'C:\\u', path: ['C:\\a', 'C:\\b'], pathExt: ['.exe', '.cmd'] });
  const wsl = platformFacts({ platform: 'linux', arch: 'x64', release: '5.15.0-microsoft-standard-WSL2', home: '/h', env: envOf({ PATH: '/a:/b' }), bubblewrap: true });
  assert.deepEqual([wsl.os, wsl.wsl, wsl.bubblewrap, wsl.argvLimit, wsl.path, wsl.pathExt], ['linux', true, true, 100000, ['/a', '/b'], []]);
  assert.equal(platformFacts({ platform: 'darwin', arch: 'arm64', release: '', home: '/h', env: envOf({}), bubblewrap: true }).bubblewrap, false);
});

test('orchestrator comes from the recorded host and that platform\'s model markers only', () => {
  assert.equal(orchestratorFor(undefined, envOf({ CLAUDECODE: '1' })), null);
  assert.deepEqual(orchestratorFor('copilot', envOf({ CLAUDECODE: '1', COPILOT_MODEL: 'gpt-5', ANTHROPIC_MODEL: 'opus' })), { platform: 'copilot', model: 'gpt-5' });
  assert.deepEqual(orchestratorFor('claude', envOf({ ANTHROPIC_MODEL: 'opus' })), { platform: 'claude', model: 'opus' });
  assert.deepEqual(orchestratorFor('codex', envOf({})), { platform: 'codex', model: null });
  // A hand-edited manifest never yields a platform outside ProviderKey, including inherited object keys.
  for (const host of ['unknown-x', 'github-copilot', '', 7, null, 'toString']) assert.equal(orchestratorFor(host, envOf({ CODEX_MODEL: 'x' })), null, String(host));
});
