// Preloaded by `test:next` (`--import`): one private temp root per run, plus one temp dir per test
// process inside it, so fixtures never accumulate in the real temp directory. Ported from the legacy helper.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEMP_ROOT_MARKER = 'DISPATCH_TEST_TEMP';

function useTemp(dir: string): void {
  // NOTE: os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows at call time.
  for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = dir;
}

function removeOnExit(dir: string): void {
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* NOTE: a held Windows handle leaves it for the OS. */ }
  });
}

let root = process.env[TEMP_ROOT_MARKER];
if (!root) {
  // NOTE: .native expands Windows 8.3 short names (e.g. RUNNER~1) so paths match long-form paths.
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'dispatch-test-'));
  process.env[TEMP_ROOT_MARKER] = root;
  for (const key of ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_SESSION_TERMINAL']) delete process.env[key];
  removeOnExit(root);
}
useTemp(root);
if (process.env['NODE_TEST_CONTEXT']) {
  const own = fs.mkdtempSync(path.join(root, `worker-${process.pid}-`));
  useTemp(own);
  removeOnExit(own);
}
