// Shared driver for review-rounds*.test.mjs: a standalone `review code --fix` run whose waves are scripted per round.
import fs from 'node:fs';
import path from 'node:path';

import { allProviders, codeFinding, drive, logEntries, report } from './driver-harness.mjs';
import { config, setup, walkthroughIn } from './scripted-review-fixture.mjs';

export const REVIEW_CFG = (rounds) => config({ rounds }, { agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] } });

export const MUST_A = codeFinding({ locus: 'src/app.js:L1', defect: 'Exported value constant is wrong for the documented contract.' });
export const MUST_A_REWORDED = codeFinding({ locus: 'src/app.js:L2', defect: 'The exported value constant still breaks the documented contract.' });
export const MUST_B = codeFinding({ locus: 'src/app.js:L40', tag: 'security', defect: 'Unsanitized input reaches the shell command builder.' });
export const SHOULD_C = codeFinding({ severity: 'SHOULD', locus: 'src/app.js:L20', tag: 'reuse', defect: 'Duplicated formatting helper instead of shared utility.' });
export const CONSIDER_D = codeFinding({ severity: 'CONSIDER', locus: 'src/app.js:L30', tag: 'perf', defect: 'Allocation inside hot loop could be hoisted.' });

/**
 * Runs `review code --fix` with `rounds[n-1]` as round n's findings (clean afterwards).
 * `reject` lists defects the host rejects; every other finding is accepted with a bounded fix.
 */
export function runRounds({ rounds, cap, reject = [], askUser, capturePrompts = false }) {
  const { fixture, repo } = setup(REVIEW_CFG(cap), { dirty: true });
  const prompts = [];
  const run = drive(fixture, {
    cwd: repo.dir,
    runArgs: ['review', '--kind', 'code', '--fix', '--orchestrator', 'claude'],
    maxSteps: 120,
    onAction: (action) => {
      if (capturePrompts && action.action === 'launch' && action.wave.type === 'review') {
        const state = JSON.parse(fs.readFileSync(action.stateFile, 'utf8'));
        const sessionDir = action.stateFile.slice(0, action.stateFile.lastIndexOf(`${path.sep}.state${path.sep}`));
        prompts[action.wave.round] = fs.readFileSync(state.wave.promptPath.replace('@session', sessionDir), 'utf8');
      }
    },
    policy: {
      waveResults: (action) => allProviders(report(action.wave.type === 'review' ? rounds[action.wave.round - 1] ?? [] : [])),
      rule: (finding) => (reject.includes(finding.defect)
        ? { status: 'rejected', scope: 'in-scope', resolution: `Declined: ${finding.defect.slice(0, 20)} is intended.` }
        : { status: 'accepted', scope: 'in-scope' }),
      fix: (finding) => (reject.includes(finding.defect) ? undefined : { affectedPaths: ['src/app.js'], dependsOn: [], verification: [] }),
      applyFixes: (action) => {
        fs.appendFileSync(path.join(repo.dir, 'src', 'app.js'), `// fix ${action.clusters.map((c) => c.findingIds.join(',')).join(';')}\n`);
        return { clusters: action.clusters.map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) };
      },
      ...(askUser ? { askUser } : {}),
    },
  });
  const walkthrough = walkthroughIn(repo.dir);
  return { run, walkthrough, entries: logEntries(walkthrough), prompts, reviews: run.trace.filter((a) => a.action === 'launch' && a.wave.type === 'review') };
}

/** Default answers, plus `stop` for an escalation. */
export const stopOnEscalation = (action) => (action.question === 'escalation' ? { answer: 'stop' }
  : action.question === 'inputs' ? { answer: { summary: 'Update the exported value', verification: { command: 'node --version', result: 'Passed' } } }
    : { answer: Object.fromEntries((action.items ?? []).map((item) => [item.key, 'accepted'])) });
