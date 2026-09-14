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

  it('the committed manifests cover dispatch, both review skills, and implement-dispatch, including their templates', () => {
    for (const skill of ['dispatch', 'dispatch-code-review', 'dispatch-plan-review', 'implement-dispatch']) {
      const manifestPath = path.join(PROJECT_ROOT, 'skills', skill, 'skill-hashes.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok('SKILL.md' in manifest, `${skill} manifest omits SKILL.md`);
      if (skill !== 'dispatch' && skill !== 'implement-dispatch') {
        assert.ok(
          'references/prompt-template.md' in manifest,
          `${skill} manifest omits its prompt template`,
        );
      }
      // Every references/*.md is hashed, not just the prompt template. implement-dispatch ships
      // no references/ dir at all.
      const referencesDir = path.join(PROJECT_ROOT, 'skills', skill, 'references');
      if (fs.existsSync(referencesDir)) {
        for (const file of fs.readdirSync(referencesDir)) {
          if (file.endsWith('.md')) {
            assert.ok(`references/${file}` in manifest, `${skill} manifest omits references/${file}`);
          }
        }
      }
    }
  });

  it('--skill writes just that skill, matching its committed manifest', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-hashes-skill-'));
    const outPath = path.join(tmpDir, 'skill-hashes.json');
    try {
      const res = spawnSync(
        process.execPath,
        [scriptPath, '--skill', 'dispatch-code-review', '--out', outPath],
        { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(res.status, 0, res.stderr);

      const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      const committed = JSON.parse(
        fs.readFileSync(path.join(PROJECT_ROOT, 'skills', 'dispatch-code-review', 'skill-hashes.json'), 'utf8'),
      );
      assert.deepEqual(written, committed);
      assert.ok(!('scripts/dispatch.mjs' in written), 'wrote another skill\'s files');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects --out combined with --check, which would narrow the drift check', () => {
    const res = spawnSync(process.execPath, [scriptPath, '--check', '--out', 'x.json'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--out cannot combine with --check/);
  });

  it('rejects a repeated --skill', () => {
    const res = spawnSync(process.execPath, [scriptPath, '--skill', 'dispatch', '--skill', 'dispatch-plan-review'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /only once/);
  });

  it('rejects an unknown --skill', () => {
    const res = spawnSync(process.execPath, [scriptPath, '--skill', 'bogus-skill'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Unknown skill/);
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
