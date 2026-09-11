import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PROJECT_ROOT } from '../../../skills/dispatch/scripts/common.mjs';

import {
  diffStatus,
  frontmatterDescription,
  relTo,
  resolveRunDirs,
  toPosix,
} from '../../../.agents/skills/audit-dispatch-skills/scripts/shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('audit-dispatch-skills shared helpers', () => {
  describe('resolveRunDirs', () => {
    it('throws when --run is missing', () => {
      assert.throws(() => resolveRunDirs(PROJECT_ROOT, []), /Missing --run/);
    });

    it('throws when the run path is outside .scratch/audit/', () => {
      assert.throws(
        () => resolveRunDirs(PROJECT_ROOT, ['--run', '.scratch/plan/2026-09-11-foo']),
        /--run must be under \.scratch\/audit\//,
      );
    });

    it('returns workDir and a forward-slash rel path for a valid run', () => {
      const { runDir, workDir, rel } = resolveRunDirs(PROJECT_ROOT, [
        '--run',
        '.scratch/audit/2026-09-11-1853',
      ]);
      assert.equal(toPosix(path.relative(PROJECT_ROOT, runDir)), '.scratch/audit/2026-09-11-1853');
      assert.equal(toPosix(path.relative(PROJECT_ROOT, workDir)), '.scratch/audit/2026-09-11-1853/work');
      assert.equal(rel(workDir), '.scratch/audit/2026-09-11-1853/work');
    });
  });

  describe('diffStatus', () => {
    it('prefixes added lines with +', () => {
      assert.deepEqual(diffStatus('a\nb', 'a\nb\nc'), ['+ c']);
    });

    it('prefixes removed lines with -', () => {
      assert.deepEqual(diffStatus('a\nb\nc', 'a\nb'), ['- c']);
    });

    it('returns an empty array for identical snapshots', () => {
      assert.deepEqual(diffStatus('a\nb', 'a\nb'), []);
    });
  });

  describe('toPosix', () => {
    it('converts platform separators to forward slashes', () => {
      assert.equal(toPosix(path.join('a', 'b', 'c')), 'a/b/c');
    });
  });

  describe('relTo', () => {
    it('binds a root and resolves a forward-slash relative path', () => {
      const rel = relTo(__dirname);
      assert.equal(rel(path.join(__dirname, 'nested', 'file.mjs')), 'nested/file.mjs');
    });
  });

  describe('frontmatterDescription', () => {
    it('reads a single-line scalar value', () => {
      const text = '---\nname: foo\ndescription: A short description.\n---\nbody';
      assert.equal(frontmatterDescription(text), 'A short description.');
    });

    it('strips surrounding quotes on a scalar value', () => {
      const text = '---\ndescription: "Quoted description."\n---\n';
      assert.equal(frontmatterDescription(text), 'Quoted description.');
      const text2 = "---\ndescription: 'Single quoted.'\n---\n";
      assert.equal(frontmatterDescription(text2), 'Single quoted.');
    });

    it('folds a ">" block into a single space-joined line', () => {
      const text = '---\ndescription: >\n  Line one\n  line two.\n---\n';
      assert.equal(frontmatterDescription(text), 'Line one line two.');
    });

    it('joins a "|" literal block with newlines', () => {
      const text = '---\ndescription: |\n  Line one\n  line two.\n---\n';
      assert.equal(frontmatterDescription(text), 'Line one\nline two.');
    });

    it('returns empty string when description is missing', () => {
      const text = '---\nname: foo\n---\nbody';
      assert.equal(frontmatterDescription(text), '');
    });
  });
});
