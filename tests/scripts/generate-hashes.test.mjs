import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROJECT_ROOT } from '../../skills/dispatch/scripts/common.mjs';

describe('generate-hashes script', () => {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'generate-hashes.mjs');
  const manifestPath = path.join(PROJECT_ROOT, 'skills', 'dispatch', 'skill-hashes.json');

  it('generates skill-hashes.json with valid SHA-256 hashes and prints summary', () => {
    const res = spawnSync(process.execPath, [scriptPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(res.status, 0, `Expected 0 exit code, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /Generated .*skill-hashes\.json with \d+ entries\./);

    assert.ok(fs.existsSync(manifestPath), 'Expected skill-hashes.json to exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.ok(typeof manifest === 'object' && manifest !== null);
    assert.ok('SKILL.md' in manifest);
    assert.ok('scripts/dispatch.mjs' in manifest);
    assert.ok('references/alignment.md' in manifest);

    // Verify sha256 hex format
    for (const [file, hash] of Object.entries(manifest)) {
      assert.match(hash, /^[a-f0-9]{64}$/, `Expected valid sha256 hex hash for ${file}`);
    }
  });
});
