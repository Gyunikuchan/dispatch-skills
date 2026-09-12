import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROJECT_ROOT } from '../../skills/dispatch/scripts/common.mjs';

describe('generate-hashes script', () => {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'generate-hashes.mjs');

  it('generates skill-hashes.json with valid SHA-256 hashes and prints summary', () => {
    // Tests never write the committed manifest; generate into a temp --out.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-hashes-'));
    const outPath = path.join(tmpDir, 'skill-hashes.json');
    try {
      const res = spawnSync(process.execPath, [scriptPath, '--out', outPath], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 10_000,
      });

      assert.equal(res.status, 0, `Expected 0 exit code, got ${res.status}: ${res.stderr}`);
      assert.match(res.stdout, /Generated .*skill-hashes\.json with \d+ entries\./);

      const manifest = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.ok(typeof manifest === 'object' && manifest !== null);
      assert.ok('SKILL.md' in manifest);
      assert.ok('scripts/dispatch.mjs' in manifest);
      assert.ok('references/alignment.md' in manifest);

      for (const [file, hash] of Object.entries(manifest)) {
        assert.match(hash, /^[a-f0-9]{64}$/, `Expected valid sha256 hex hash for ${file}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('committed skill-hashes.json matches the skill files (--check exits 0)', () => {
    const res = spawnSync(process.execPath, [scriptPath, '--check'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 0, `Manifest drift: ${res.stderr}`);
  });
});
