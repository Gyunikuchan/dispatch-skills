/**
 * Preloaded by `npm test` (`--import`): points the OS temp directory at one private directory per
 * test run, so fixtures, ledgers, and sessions never accumulate in the real temp directory. The
 * runner process creates and removes it; test files and their subprocesses inherit it via env.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = 'DISPATCH_TEST_TEMP';

// Test workers must never reuse the host chat's workspace session identity.
const testChatId = `test-${process.pid}`;
process.env.DISPATCH_CHAT_ID = testChatId;
process.on('exit', () => {
  const runtimeRoot = path.resolve(process.cwd(), '.scratch', 'dispatch-skills');
  try {
    for (const name of fs.readdirSync(runtimeRoot)) {
      const folder = path.resolve(runtimeRoot, name);
      if (path.dirname(folder) !== runtimeRoot) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
        if (manifest.sessionId === testChatId) fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch { /* Another worker owns this folder or has already removed it. */ }
    }
  } catch { /* No workspace runtime files were created. */ }
});

if (!process.env[MARKER]) {
  // NOTE: .native expands Windows 8.3 short names (e.g. RUNNER~1) so paths match git's long-form toplevel.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'dispatch-test-'));
  process.env[MARKER] = dir;
  // NOTE: os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows at call time.
  for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = dir;
  for (const key of [
    'DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID',
    'DISPATCH_SESSION_TERMINAL',
  ]) delete process.env[key];
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* NOTE: a held Windows handle leaves it for the OS. */ }
  });
}
