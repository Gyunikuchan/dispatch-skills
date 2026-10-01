import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDiscovery, expandCandidate, type DiscoveryFs } from '../../../skills/dispatch/scripts/providers/discovery.ts';
import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';
import type { PlatformEnv } from '../../../skills/dispatch/scripts/providers/types.ts';

const env: PlatformEnv = { os: 'linux', arch: 'x64', wsl: false, bubblewrap: false, argvLimit: 100000, home: '/h', path: ['/usr/bin', '/opt/bin'], pathExt: [] };

/** Fake fs table: path → 'exec' | 'file'; directories derive from the paths. */
function table(entries: Record<string, 'exec' | 'file'>): DiscoveryFs & { probes: string[] } {
  const probes: string[] = [];
  return {
    probes,
    list: (dir) => [...new Set(Object.keys(entries).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0] ?? ''))],
    exists: (file) => { probes.push(file); return file in entries; },
    executable: (file) => entries[file] === 'exec',
  };
}

test('discovery resolves provider × mode to path | missing | unlaunchable on a fake fs table', () => {
  const fs = table({
    '/opt/bin/claude': 'exec',
    '/h/.vscode/extensions/anthropic.claude-code-1.0.0/resources/native-binary/claude': 'file',
    '/h/.vscode/extensions/anthropic.claude-code-2.1.0/resources/native-binary/claude': 'exec',
    '/usr/bin/codex': 'file',
  });
  const discovery = createDiscovery(SPECS, env, fs);
  assert.deepEqual(discovery.resolve('claude', 'cli'), { status: 'path', path: '/opt/bin/claude' });
  assert.deepEqual(discovery.resolve('claude', 'vscode'), { status: 'path', path: '/h/.vscode/extensions/anthropic.claude-code-2.1.0/resources/native-binary/claude' });
  assert.deepEqual(discovery.resolve('claude', 'desktop'), { status: 'missing', path: null });
  assert.deepEqual(discovery.resolve('codex', 'cli'), { status: 'unlaunchable', path: '/usr/bin/codex' });
  const rows = discovery.doctor();
  assert.equal(rows.length, 15);
  assert.ok(rows.some((row) => row.provider === 'agy' && row.mode === 'cli' && row.status === 'missing'));
});

test('each candidate is probed once per invocation (in-memory cache)', () => {
  const fs = table({ '/usr/bin/copilot': 'exec' });
  const discovery = createDiscovery(SPECS, env, fs);
  discovery.resolve('copilot', 'cli');
  const first = fs.probes.length;
  discovery.resolve('copilot', 'cli');
  discovery.doctor();
  discovery.doctor();
  assert.equal(new Set(fs.probes).size, fs.probes.length);
  assert.ok(first > 0);
  assert.equal(discovery.probes, fs.probes.length);
});

test('glob segments expand newest-first; PATHEXT applies to bare names on Windows', () => {
  const fs = table({ '/a/v1/x': 'exec', '/a/v2/x': 'exec' });
  assert.deepEqual(expandCandidate('/a/v*/x', fs), ['/a/v2/x', '/a/v1/x']);
  const versions = table({ '/b/v1.9/x': 'exec', '/b/v1.10/x': 'exec' });
  assert.deepEqual(expandCandidate('/b/v*/x', versions), ['/b/v1.10/x', '/b/v1.9/x']);
  const win: PlatformEnv = { ...env, os: 'win32', path: ['C:\\bin'], pathExt: ['.exe', '.cmd'] };
  const probes = table({ 'C:\\bin\\codex.cmd': 'exec' });
  assert.deepEqual(createDiscovery(SPECS, win, probes).resolve('codex', 'cli'), { status: 'path', path: 'C:\\bin\\codex.cmd' });
});


test('rewrite SC4 Windows cmd-only Claude installation resolves', () => {
  const windows: PlatformEnv = { ...env, os: 'win32', path: ['/bin'], pathExt: ['.CMD', '.EXE'] };
  const discovery = createDiscovery(SPECS, windows, { list: () => [], exists: (file) => file.replaceAll('\\', '/') === '/bin/claude.cmd', executable: () => true });
  assert.equal(discovery.resolve('claude', 'cli').status, 'path');
});

test('resolves codex desktop candidate paths on Windows', () => {
  const win: PlatformEnv = { ...env, os: 'win32', home: 'C:\\Users\\test' };
  const candidate = 'C:\\Users\\test\\AppData\\Local\\Programs\\Codex\\resources\\bin\\codex.exe';
  const fs = table({ [candidate]: 'exec' });
  const discovery = createDiscovery(SPECS, win, fs);
  assert.deepEqual(discovery.resolve('codex', 'desktop'), { status: 'path', path: candidate });
});

