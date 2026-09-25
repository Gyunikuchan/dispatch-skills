/**
 * Shared fixture for the ordinary implement-driver contract tests, split across files so node --test
 * runs them concurrently. Each test file registers `afterEach(cleanupOrdinaryDriverFixtures)`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { conformPlan, drive, implementationOutcome, makeGitRepo, PLAN_BODY, writePlan } from './driver-harness.mjs';
import { loadSchema, validateAgainstSchema } from '../../skills/dispatch/scripts/driver/actions.mjs';

const levels = { low: 1, medium: 1, high: 1, xhigh: 1, max: 1 };
const ORDINARY_DRIVER_CONFIG = {
  'read-delegates': { agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] } },
  'write-subagents': { claude: { low: { model: ['first-model', 'second-model'], effort: 'low' } } },
  phases: Object.fromEntries(['plan-review', 'code-review'].map(key => [key, { rounds: levels, targets: levels, consensus: Object.fromEntries(Object.keys(levels).map(level => [level, false])) }])),
};
const cleanup = [];

// SECTION: lifecycle

export function cleanupOrdinaryDriverFixtures() { for (const fn of cleanup.splice(0)) fn(); }

/** Plan criterion whose only command is marked `[FINAL]`: its verify evidence is deferred to the final gate. */
export const FINAL_COMMAND = 'node scripts/slow.mjs';
const FINAL_CRITERION = `- [SC2] Aggregate proof.\n  - Changes: \`src/app.js\`\n  - Verify: \`${FINAL_COMMAND}\` [FINAL]\n  - Evidence: verify\n  - Test rationale: The slow deterministic proof needs no dedicated pre-change failure.\n\n`;

/**
 * @param {{ finalCommand?: boolean, codeReview?: boolean }} [options] finalCommand adds SC2 mapped to a
 * `[FINAL]` command (with a passing scripts/slow.mjs); codeReview: false disables the code-review phase.
 */
export function createOrdinaryDriverFixture({ finalCommand = false, codeReview = true } = {}) {
  const config = codeReview ? ORDINARY_DRIVER_CONFIG : { ...ORDINARY_DRIVER_CONFIG, phases: { ...ORDINARY_DRIVER_CONFIG.phases,
    'code-review': { ...ORDINARY_DRIVER_CONFIG.phases['code-review'], rounds: Object.fromEntries(Object.keys(levels).map(level => [level, 0])) } } };
  const fixture = createStubDispatchFixture(config), repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  fs.mkdirSync(path.join(repo.dir, 'tests'));
  fs.writeFileSync(path.join(repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 1);\n");
  repo.git('add', 'tests'); repo.git('commit', '--no-gpg-sign', '-qm', 'baseline tests');
  let body = PLAN_BODY.replace('Changes: `src/app.js`', 'Changes: `src/app.js`, `tests/sample.test.mjs`').replace('#### [MODIFY] src/app.js', '#### [MODIFY] tests/sample.test.mjs\n\n- Add regression.\n\n#### [MODIFY] src/app.js');
  if (finalCommand) {
    fs.mkdirSync(path.join(repo.dir, 'scripts'));
    fs.writeFileSync(path.join(repo.dir, 'scripts/slow.mjs'), 'process.exit(0);\n');
    repo.git('add', 'scripts'); repo.git('commit', '--no-gpg-sign', '-qm', 'slow proof');
    body = body.replace('## Proposed Changes', `${FINAL_CRITERION}## Proposed Changes`);
  }
  const plan = writePlan(repo.dir, undefined, body);
  return { fixture, repo, plan };
}

/** Wraps a verify policy so its reply carries structured evidence for every judged (non-red) criterion of the gate. */
export function withCriterionEvidence(verify) {
  return (action, ctx) => {
    const reply = verify(action, ctx) ?? {};
    const criterionEvidence = (action.criteria ?? []).filter(item => item.evidenceClass !== 'red' && item.commands.length).map(item => {
      // Cite what the runner stored: a real run's summary, else the simulated reply's own scopeHash, else the per-command hash.
      const ran = ctx?.lastVerify?.results?.find(result => result.command === item.commands[0]);
      return { criterionId: item.id, evidenceClass: item.evidenceClass, reviewer: 'host', scenario: `ran ${item.commands[0]}`,
        inspectedRevision: ran?.scopeHash ?? reply.results?.find(result => result.command === item.commands[0])?.scopeHash ?? action.scopeHashes?.[item.commands[0]] ?? action.scopeHash,
        observableResult: 'passed', limitations: 'fixture scope only', mutationEpoch: ran?.mutationEpoch ?? action.mutationEpoch };
    });
    return criterionEvidence.length ? { ...reply, criterionEvidence } : reply;
  };
}

// SECTION: scripted host

export function ordinaryDriverPolicy(repo, overrides = {}) {
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
      return { raw: JSON.stringify(implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['CRITERION SC1 | src/app.js | delivered value=2'] })) };
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
export function driveOrdinaryImplementation({ fixture, repo, plan }, options = {}) {
  // Fixtures may edit criteria after writing; resync the summary table (idempotent on conforming plans).
  const planFile = path.resolve(repo.dir, plan);
  if (fs.existsSync(planFile)) fs.writeFileSync(planFile, conformPlan(fs.readFileSync(planFile, 'utf8')));
  return drive(fixture, { cwd: repo.dir, runArgs: ['implement', '--orchestrator', 'claude', '--', plan], policy: ordinaryDriverPolicy(repo, options.policy),
    onAction(action) { assert.deepEqual(validateAgainstSchema(loadSchema(action.action), action), [], JSON.stringify(action)); if (!options.allowErrors) assert.equal(action.error, undefined, JSON.stringify(action)); options.onAction?.(action); }, ...Object.fromEntries(Object.entries(options).filter(([key]) => !['policy', 'onAction', 'allowErrors'].includes(key))) });
}

// SECTION: gate-tier fixtures (split across ordinary-gate-tiers*.test.mjs)

const LINT_CRITERION = '- [SC3] Test file stays lint-clean.\n  - Changes: `tests/sample.test.mjs`\n  - Verify: `node scripts/lint.mjs`\n  - Evidence: verify\n  - Test rationale: A deterministic lint check needs no dedicated pre-change failure.\n\n';

/**
 * Tier fixture: SC1 red (sample), SC2 all-[FINAL] verify, optionally SC3 verify (lint) scoped to the test file only.
 * @param {{ lint?: boolean, finalCommand?: boolean, codeReview?: boolean }} [options]
 */
export function tierFixture({ lint = false, ...options } = {}) {
  const fixture = createOrdinaryDriverFixture({ finalCommand: true, ...options });
  if (lint) fs.writeFileSync(fixture.plan, conformPlan(fs.readFileSync(fixture.plan, 'utf8').replace('## Proposed Changes', `${LINT_CRITERION}## Proposed Changes`)));
  return fixture;
}

/** Base policy whose production outcome cites every plan criterion and whose verify replies carry judged evidence. */
export function tierPolicy(fixture, overrides = {}) {
  const base = ordinaryDriverPolicy(fixture.repo);
  const ids = [...fs.readFileSync(fixture.plan, 'utf8').matchAll(/^- \[(SC\d+)\]/gm)].map(match => match[1]);
  return {
    ...base,
    delegateWrite(action) {
      if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
      fs.writeFileSync(path.join(fixture.repo.dir, 'src/app.js'), 'export const value = 2;\n');
      return { raw: JSON.stringify(implementationOutcome({ evidence: ids.map(id => `CRITERION ${id} | ${id === 'SC3' ? 'tests/sample.test.mjs' : 'src/app.js'} | delivered value=2`) })) };
    },
    // Drop the base reply's single scopeHash so each simulated record carries its own command's scope hash.
    verify: withCriterionEvidence(action => ({ results: base.verify(action).results.map(({ scopeHash, ...result }) => result) })),
    ...overrides,
  };
}
