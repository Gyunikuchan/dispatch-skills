import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runCli } from '../../scripts/generate-hashes.mjs';
import { PROJECT_ROOT } from '../../skills/dispatch/scripts/lib/platform.mjs';

const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'generate-hashes.mjs');

const captureCli = (args) => {
  const stdout = [];
  const stderr = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values) => stdout.push(values.join(' '));
  console.error = (...values) => stderr.push(values.join(' '));
  try {
    return { status: runCli(args), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
};

describe('generate-hashes script', () => {
  // SECTION: Manifest generation

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
      assert.ok('references/review.md' in manifest);
      assert.ok('references/templates/review-prompt.md' in manifest, 'nested references are hashed');

      for (const [file, hash] of Object.entries(manifest)) {
        assert.match(hash, /^[a-f0-9]{64}$/, `Expected valid sha256 hex hash for ${file}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('the committed dispatch manifest covers every nested reference; no other skill ships one', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'skills', 'dispatch', 'skill-hashes.json'), 'utf8'));
    assert.ok('SKILL.md' in manifest, 'dispatch manifest omits SKILL.md');
    const referencesDir = path.join(PROJECT_ROOT, 'skills', 'dispatch', 'references');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    const nested = walk(referencesDir)
      .filter((file) => /\.(md|json)$/.test(file))
      .map((file) => path.relative(path.join(PROJECT_ROOT, 'skills', 'dispatch'), file).split(path.sep).join('/'));
    assert.ok(nested.some((key) => key.startsWith('references/templates/')), 'expected nested templates');
    for (const key of nested) assert.ok(key in manifest, `dispatch manifest omits ${key}`);
    for (const skill of ['implement-dispatch', 'dispatch-code-review', 'dispatch-plan-review', 'dispatch-design-review']) {
      assert.equal(
        fs.existsSync(path.join(PROJECT_ROOT, 'skills', skill, 'skill-hashes.json')),
        false,
        `${skill} no longer ships an integrity manifest`,
      );
    }
  });

  // SECTION: CLI validation

  it('names dispatch as the only hashed skill', () => {
    const res = captureCli(['--skill', 'dispatch-plan-review']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /hashed skills: dispatch\s*$/);
  });

  it('--skill writes just that skill, matching its committed manifest', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-hashes-skill-'));
    const outPath = path.join(tmpDir, 'skill-hashes.json');
    try {
      const res = spawnSync(
        process.execPath,
        [scriptPath, '--skill', 'dispatch', '--out', outPath],
        { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(res.status, 0, res.stderr);

      const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      const committed = JSON.parse(
        fs.readFileSync(path.join(PROJECT_ROOT, 'skills', 'dispatch', 'skill-hashes.json'), 'utf8'),
      );
      assert.deepEqual(written, committed);
      assert.ok('scripts/dispatch.mjs' in written);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects conflicting, repeated, and unknown arguments', () => {
    const invalidCases = [
      [['--check', '--out', 'x.json'], /--out cannot combine with --check/],
      [['--skill', 'dispatch', '--skill', 'dispatch'], /only once/],
      [['--skill', 'bogus-skill'], /Unknown skill/],
    ];
    for (const [args, expected] of invalidCases) {
      const res = captureCli(args);
      assert.equal(res.status, 2, args.join(' '));
      assert.match(res.stderr, expected);
    }
  });

  it('committed skill-hashes.json matches the skill files (--check exits 0)', () => {
    const res = captureCli(['--check']);
    assert.equal(res.status, 0, `Manifest drift: ${res.stderr}`);
  });
});
