/**
 * Shared fixture for the ordinary implement-driver contract tests, split across files so node --test
 * runs them concurrently. Each test file registers `afterEach(runCleanup)`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildStubDispatchFixture } from './stub-dispatch.mjs';
import { drive, implementationOutcome, makeGitRepo, PLAN_BODY, writePlan } from './driver-harness.mjs';
import { loadSchema, validateAgainstSchema } from '../../skills/dispatch/scripts/driver/actions.mjs';

const levels = { low: 1, medium: 1, high: 1, xhigh: 1, max: 1 };
export const config = {
  'read-delegates': { agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] } },
  'write-subagents': { claude: { low: { model: ['first-model', 'second-model'], effort: 'low' } } },
  phases: Object.fromEntries(['plan-review', 'code-review'].map(key => [key, { rounds: levels, targets: levels, consensus: Object.fromEntries(Object.keys(levels).map(level => [level, false])) }])),
};
const cleanup = [];
export function runCleanup() { for (const fn of cleanup.splice(0)) fn(); }
export function setup() {
  const fixture = buildStubDispatchFixture(config), repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  fs.mkdirSync(path.join(repo.dir, 'tests'));
  fs.writeFileSync(path.join(repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 1);\n");
  repo.git('add', 'tests'); repo.git('commit', '--no-gpg-sign', '-qm', 'baseline tests');
  const plan = writePlan(repo.dir, undefined, PLAN_BODY.replace('Changes: `src/app.js`', 'Changes: `src/app.js`, `tests/sample.test.mjs`').replace('#### [MODIFY] src/app.js', '#### [MODIFY] tests/sample.test.mjs\n\n- Add regression.\n\n#### [MODIFY] src/app.js'));
  return { fixture, repo, plan };
}
export function policies(repo, overrides = {}) {
  return {
    askUser(action) {
      if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: ['tests/sample.test.mjs'], reason: 'Approved fixture plan.' } };
      if (action.question === 'failure-disposition') return { answer: { decision: 'keep-for-repair', reason: 'Preserve fixture evidence.' } };
      if (action.question === 'opt-in') return { answer: 'none' };
      throw new Error(`Unexpected question ${action.question}`);
    },
    delegateWrite(action) {
      const testsOnly = action.fields.stage === 'tests-only';
      fs.writeFileSync(path.join(repo.dir, testsOnly ? 'tests/sample.test.mjs' : 'src/app.js'), testsOnly
        ? "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n" : 'export const value = 2;\n');
      return { raw: JSON.stringify(implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
    },
    verify(action) {
      return { results: action.commands.map(command => {
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', 'tests/sample.test.mjs'], { cwd: repo.dir, encoding: 'utf8', env });
        return { command, exit: result.status, evidence: result.stdout, identifiers: result.status ? ['test:sample'] : [], diagnostic: result.stderr, scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch };
      }) };
    }, ...overrides,
  };
}
export function run({ fixture, repo, plan }, options = {}) {
  return drive(fixture, { cwd: repo.dir, runArgs: ['implement', '--orchestrator', 'claude', '--', plan], policy: policies(repo, options.policy),
    onAction(action) { assert.deepEqual(validateAgainstSchema(loadSchema(action.action), action), [], JSON.stringify(action)); if (!options.allowErrors) assert.equal(action.error, undefined, JSON.stringify(action)); options.onAction?.(action); }, ...Object.fromEntries(Object.entries(options).filter(([key]) => !['policy', 'onAction', 'allowErrors'].includes(key))) });
}
