// Hot-fix hard limits (SC3): each limit is judged from repository effects captured when the hot fix starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { captureLimits, limitViolations } from '../../../../skills/dispatch/scripts/driver/hotfix-limits.mjs';
import { snapshot } from '../../../../skills/dispatch/scripts/driver/verification.mjs';
import { diffRepositoryState } from '../../../../skills/dispatch/scripts/verification/evidence.mjs';
import { makeGitRepo } from '../../../helpers/driver-harness.mjs';

const repos = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.cleanup(); });

/** Starts a hot fix on a fresh repository after `setup`, applies `edit`, and returns the violations. */
function judge({ setup, edit, ordinary = {} }) {
  const repo = makeGitRepo();
  repos.push(repo);
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true }); fs.writeFileSync(path.join(repo.dir, file), content); };
  setup?.({ repo, write });
  const state = { repoRoot: repo.dir, ordinary: { phase: 'implementation', ...ordinary } };
  const start = snapshot(state);
  state.ordinary.hotfix = { start: captureLimits(repo.dir, start) };
  edit({ repo, write });
  return limitViolations(state, diffRepositoryState(start, snapshot(state)).changed);
}

describe('hot-fix hard limits', () => {
  it('hotfix limit: an in-scope edit passes', () => {
    assert.deepEqual(judge({ edit: ({ write }) => write('src/app.js', 'export const value = 2;\n') }), []);
  });

  it('hotfix limit: refuses secrets paths and deleting a file that existed at task start', () => {
    const violations = judge({ edit: ({ repo, write }) => { write('.env', 'SECRET=1\n'); fs.rmSync(path.join(repo.dir, 'src/app.js')); } });
    assert.deepEqual(violations.sort(), ['.env: secrets path', 'src/app.js: deleted a file that existed at task start']);
  });

  for (const [label, edit, pattern] of [
    ['a history write', ({ repo, write }) => { write('src/app.js', 'x\n'); repo.git('commit', '--no-gpg-sign', '-qam', 'x'); }, /HEAD moved/],
    ['git add', ({ repo, write }) => { write('src/app.js', 'x\n'); repo.git('add', 'src/app.js'); }, /index changed/],
    ['a stash', ({ repo, write }) => { write('src/app.js', 'x\n'); repo.git('stash', '-q'); }, /stash list changed/],
    ['a .git/ config change that leaves HEAD, index, and stash alone', ({ repo }) => repo.git('config', 'hotfix.probe', '1'), /\.git\/ config, hooks, or info changed/],
  ]) {
    it(`hotfix limit: refuses ${label}`, () => {
      assert.ok(judge({ edit }).some(item => pattern.test(item)));
    });
  }

  it('hotfix limit: refuses an edit to an ignored secrets path that git status omits', () => {
    const violations = judge({
      setup: ({ repo, write }) => { fs.appendFileSync(path.join(repo.dir, '.git/info/exclude'), '.env\n'); write('.env', 'SECRET=1\n'); },
      edit: ({ write }) => write('.env', 'SECRET=22\n'),
    });
    assert.deepEqual(violations, ['.env: secrets path (ignored)']);
  });

  it('hotfix limit: refuses creating a secrets file inside an ignored directory and deleting an ignored path', () => {
    const violations = judge({
      setup: ({ repo, write }) => { fs.appendFileSync(path.join(repo.dir, '.git/info/exclude'), 'tmp/\ncache/\n'); write('tmp/notes.txt', 'scratch\n'); write('cache/data.bin', 'x'); },
      edit: ({ repo, write }) => { write('tmp/.env', 'SECRET=1\n'); fs.rmSync(path.join(repo.dir, 'cache'), { recursive: true }); },
    });
    assert.deepEqual(violations.sort(), ['cache/: deleted an ignored path', 'tmp/.env: created an ignored secrets path']);
  });

  it('hotfix limit: refuses production paths before RED validates', () => {
    const violations = judge({
      ordinary: { redCriteria: ['SC1'], testsOnlyPaths: ['tests/sample.test.mjs'] },
      edit: ({ write }) => { write('src/app.js', 'x\n'); write('tests/sample.test.mjs', 'x\n'); },
    });
    assert.deepEqual(violations, ['src/app.js: production path before RED validates']);
  });
});
