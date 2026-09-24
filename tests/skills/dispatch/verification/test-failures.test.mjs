import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { extractFailureIdentifiers, testCounts } from '../../../../skills/dispatch/scripts/verification/test-failures.mjs';

// NOTE: --test-reporter needs a file URL; a win32 drive path parses as a URL scheme.
const QUIET_REPORTER = new URL('../../../../scripts/test-reporter.mjs', import.meta.url).href;

// SECTION: Reporter parsing

describe('failure identities from real node --test output', () => {
  let dir;
  const runSuite = (reporter) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, 'tests/**/*.test.mjs'], { cwd: dir, encoding: 'utf8', env });
    return `${result.stdout}\n${result.stderr}`;
  };
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-failures-'));
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests/a.test.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { describe, it } from 'node:test';",
      "describe('suite', () => {",
      "  it('passes', () => {});",
      "  it('fails # hash', () => assert.equal(1, 2));",
      '});',
      "it('top fails', () => assert.ok(false));",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'tests/broken.test.mjs'), "import './missing.mjs';\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const reporter of ['spec', 'tap']) {
    it(`extracts leaf and load failures from the ${path.basename(reporter)} reporter`, () => {
      const output = runSuite(reporter);
      assert.deepEqual(extractFailureIdentifiers(output, { repoRoot: dir }), ['error:load tests/broken.test.mjs', 'test:fails # hash', 'test:top fails']);
      assert.deepEqual(testCounts(output), { pass: 1, fail: 3 });
    });
  }

  it('extracts the exact failure from the fail-fast reporter', () => {
    const file = path.join(dir, 'single-failure.test.mjs');
    fs.writeFileSync(file, "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('only failure', () => assert.fail('boom'));\n");
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', `--test-reporter=${QUIET_REPORTER}`, file], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.deepEqual(extractFailureIdentifiers(output, { repoRoot: dir }), ['test:only failure']);
    assert.equal(testCounts(output), null);
  });

  it('returns no identifiers or counts for unrecognized output', () => {
    assert.deepEqual(extractFailureIdentifiers('make: *** [all] Error 1'), []);
    assert.equal(testCounts('ok'), null);
  });
});
