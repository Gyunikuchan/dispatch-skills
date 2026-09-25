import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { requireToplevel, showToplevel } from '../../../../skills/dispatch/scripts/lib/git-root.mjs';

const SCRIPTS = fileURLToPath(new URL('../../../../skills/dispatch/scripts/', import.meta.url));

describe('git work-tree root lookup', () => {
  let dir;
  beforeEach(() => { dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'git-root-'))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves the root from a subdirectory and reuses the answer', () => {
    spawnSync('git', ['init', '--quiet'], { cwd: dir });
    mkdirSync(path.join(dir, 'sub'));
    const root = showToplevel(path.join(dir, 'sub'));
    assert.equal(path.resolve(root), dir);
    rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    assert.equal(showToplevel(path.join(dir, 'sub')), root, 'a resolved root is cached for the process');
  });

  it('does not cache a miss, so a later git init is observed', () => {
    assert.equal(showToplevel(dir), null);
    assert.throws(() => requireToplevel(dir), /Not inside a git work tree/);
    spawnSync('git', ['init', '--quiet'], { cwd: dir });
    assert.equal(path.resolve(requireToplevel(dir)), dir);
  });

  it('is the only show-toplevel spawn in shipped scripts', () => {
    const offenders = spawnSync('git', ['grep', '-l', '--', 'show-toplevel', '.'], { cwd: SCRIPTS, encoding: 'utf8' })
      .stdout.split('\n').filter(Boolean).filter(file => file !== 'lib/git-root.mjs');
    assert.deepEqual(offenders, [], 'resolve roots through lib/git-root.mjs');
    assert.match(readFileSync(path.join(SCRIPTS, 'lib', 'git-root.mjs'), 'utf8'), /show-toplevel/);
  });
});
