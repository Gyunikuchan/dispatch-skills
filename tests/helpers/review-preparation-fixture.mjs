// @ts-check
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONVERSATION_ENV_KEYS = [
  'ANTIGRAVITY_AGENT', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'GEMINI_CLI',
];

/** Shared lifecycle for review preparation tests that mutate process environment and create repositories. */
export function createReviewPreparationFixture() {
  const directories = [];
  let originalEnv = {};

  return {
    beforeEach() {
      originalEnv = {};
      for (const key of CONVERSATION_ENV_KEYS) {
        if (key in process.env) {
          originalEnv[key] = process.env[key];
          delete process.env[key];
        }
      }
    },
    afterEach() {
      for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
      for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    },
    makeDirectory(prefix) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
  };
}

/** Removes invocation and subprocess artifacts returned in a preparation manifest. */
export function cleanupPreparationManifest(manifest) {
  const paths = [
    ...(manifest.cleanupPaths ?? []),
    manifest.invocationContext?.statePath && path.dirname(manifest.invocationContext.statePath),
  ].filter(Boolean);
  for (const cleanupPath of paths) fs.rmSync(cleanupPath, { recursive: true, force: true });
}

/** Initializes and commits the standard dirty repository used by code preparation tests. */
export function makeDirtyCodeRepository(makeDirectory) {
  const directory = makeDirectory('code-prepare-test-');
  execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: directory });
  fs.appendFileSync(path.join(directory, '.git', 'config'), '[user]\n\temail = test@example.com\n\tname = Test\n');
  fs.writeFileSync(path.join(directory, 'app.js'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'app.js'], { cwd: directory });
  execFileSync('git', ['commit', '--no-gpg-sign', '-qm', 'initial'], { cwd: directory });
  fs.writeFileSync(path.join(directory, 'app.js'), 'export const value = 2;\n');
  return directory;
}
