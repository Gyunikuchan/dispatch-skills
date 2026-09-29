// Preloaded by `test:next` (`--import`): tiers 1–5 spawn nothing (spec §15.2). Test workers outside
// tests/e2e/ get child_process launchers that throw; the runner process stays unpatched so it can fork workers.

import { createRequire, syncBuiltinESMExports } from 'node:module';

export const BLOCKED_LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

export const SPAWN_RULE =
  'test rule: tiers 1-5 spawn no processes (incl. git); inject a fake Ports.spawn/Ports.git, or move the test under tests/e2e/';

function isE2eWorker(): boolean {
  return process.argv.some((arg) => arg.replace(/\\/g, '/').includes('/tests/e2e/'));
}

if (process.env['NODE_TEST_CONTEXT'] && !isE2eWorker()) {
  // NOTE: `node:child_process` and `child_process` resolve to this one module object; patch it, then
  // sync the ESM named-export bindings so `import { spawn }` sees the throwers too.
  const shared = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
  for (const name of BLOCKED_LAUNCHERS) {
    shared[name] = () => { throw new Error(`${SPAWN_RULE} (blocked child_process.${name})`); };
  }
  syncBuiltinESMExports();
}
