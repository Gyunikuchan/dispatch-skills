import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PROJECT_ROOT } from '../../../skills/dispatch/scripts/common.mjs';

import {
  diffStatus,
  filterAuditStatus,
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

    it('throws when --run is not a run id', () => {
      assert.throws(
        () => resolveRunDirs(PROJECT_ROOT, ['--run', '.scratch/plan/foo']),
        /--run must be a run id/,
      );
    });

    it('derives the report and work paths from a run id', () => {
      const { runId, reportPath, workDir, rel } = resolveRunDirs(PROJECT_ROOT, ['--run', '2026-09-11-1853']);
      assert.equal(runId, '2026-09-11-1853');
      assert.equal(rel(reportPath), '.scratch/audits/2026-09-11-1853-audit.md');
      assert.equal(toPosix(path.relative(PROJECT_ROOT, workDir)), '.scratch/audits/2026-09-11-1853-work');
    });

    it('accepts a report path in place of a run id', () => {
      const { reportPath } = resolveRunDirs(PROJECT_ROOT, ['--run', '.scratch/audits/2026-09-11-1853-audit.md']);
      assert.equal(relTo(PROJECT_ROOT)(reportPath), '.scratch/audits/2026-09-11-1853-audit.md');
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

  describe('filterAuditStatus', () => {
    it('filters a modified audit path whose status starts with a space', () => {
      assert.equal(filterAuditStatus(' M .scratch/audits/x/report.md\n'), '');
    });

    it('keeps a modified non-audit path intact', () => {
      assert.equal(filterAuditStatus(' M src/a.mjs\n'), ' M src/a.mjs');
    });

    it('filters a rename into audit output and strips both quotes', () => {
      assert.equal(filterAuditStatus('R  notes.md -> .scratch/audits/x/notes.md\n'), '');
      assert.equal(filterAuditStatus('?? ".scratch/audits/x/has space.md"\n'), '');
      assert.equal(filterAuditStatus('?? "src/has space.md"\n'), '?? "src/has space.md"');
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
