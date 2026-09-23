/**
 * Preloaded by `npm test` (`--import`): points the OS temp directory at one private directory per
 * test run, so fixtures, ledgers, and sessions never accumulate in the real temp directory. The
 * runner process creates and removes it; test files and their subprocesses inherit it via env.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = 'DISPATCH_TEST_TEMP';

if (!process.env[MARKER]) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-test-'));
  process.env[MARKER] = dir;
  // NOTE: os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows at call time.
  for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = dir;
  delete process.env.DISPATCH_SESSION_DIR;
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* NOTE: a held Windows handle leaves it for the OS. */ }
  });
}
