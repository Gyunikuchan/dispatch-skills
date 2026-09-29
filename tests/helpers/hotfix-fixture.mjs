/**
 * Shared hot-fix scenario for the driver hot-fix tests, split across files so node --test runs them
 * concurrently. Each test file registers `afterEach(cleanupOrdinaryDriverFixtures)`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readLedger } from '../../skills/dispatch/scripts/ledger/ledger.mjs';
import { implementationOutcome, readFixtureState, writeOutcomeReply } from './driver-harness.mjs';
import { driveOrdinaryImplementation, ordinaryDriverPolicy } from './ordinary-driver-fixture.mjs';

export const HOTFIX = { decision: 'hotfix', mode: 'host', rootCause: 'value constant is off by one', reason: 'Scoped test names the locus.' };
export const write = (fixture, file, content) => { fs.mkdirSync(path.dirname(path.join(fixture.repo.dir, file)), { recursive: true }); fs.writeFileSync(path.join(fixture.repo.dir, file), content); };
export const events = done => readLedger(done.ledgerPath).events;

/** Production writes a wrong value, so the scoped gate fails and failure disposition opens. */
export function buggyRun(fixture, { onDisposition, onEdit, onAsk, delegateWrite, onAction } = {}) {
  const base = ordinaryDriverPolicy(fixture.repo);
  const asked = [];
  let focus = null;
  const result = driveOrdinaryImplementation(fixture, { allowErrors: true, onAction(action) {
    if (action.action === 'launch' && !focus) focus = readFixtureState(action.stateFile).ordinary?.finalFocus ?? null;
    onAction?.(action);
  }, policy: {
    delegateWrite(action) {
      if (delegateWrite) { const reply = delegateWrite(action); if (reply) return reply; }
      if (action.fields.stage === 'tests-only') return base.delegateWrite(action);
      write(fixture, 'src/app.js', 'export const value = 3;\n');
      return writeOutcomeReply(action, implementationOutcome({ evidence: ['CRITERION SC1 | src/app.js | delivered value'] }));
    },
    askUser(action) {
      asked.push(action);
      if (onAsk) { const reply = onAsk(action, asked); if (reply) return reply; }
      if (action.question === 'failure-disposition') return onDisposition?.(action, asked) ?? { answer: { decision: 'keep-for-repair', reason: 'Stop here.' } };
      if (action.question === 'hotfix-edit') return onEdit(action, asked);
      return base.askUser(action);
    },
  } });
  return { ...result, asked, focus: () => focus };
}
