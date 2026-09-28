import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { emitAction } from '../../../../skills/dispatch/scripts/driver/actions.mjs';
import { finish } from '../../../../skills/dispatch/scripts/driver/state.mjs';
import { bindWorkflowSession, sessionDir, bindSession } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';
import { publishedSessionRoot } from '../../../../skills/dispatch/scripts/lib/session-lifecycle.mjs';
import { persistEvidence, restoreEvidence } from '../../../../skills/dispatch/scripts/driver/implement-state.mjs';

describe('terminal session handoff', () => {
  let repositoryRoot;
  let activeRoot;
  let saved;

  beforeEach(() => {
    const keys = ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_CHAT_ID', 'DISPATCH_SESSION_TERMINAL'];
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-handoff-repo-'));
    process.env.DISPATCH_CHAT_ID = `handoff-${process.pid}-${Date.now()}`;
    activeRoot = bindWorkflowSession({ repositoryRoot, artifactKind: 'plan', slug: 'handoff-test' });
    fs.mkdirSync(path.join(activeRoot, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(activeRoot, 'artifacts', 'plan.md'), 'plan');
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  function state(fields = {}) {
    const value = {
      stateFile: path.join(activeRoot, 'runs', 'run-handoff', 'state.json'),
      runId: 'run-handoff',
      repoRoot: repositoryRoot,
      invocation: { verb: 'implement', argument: 'handoff', orchestrator: 'codex', levelSource: 'default', terminalHandoff: true },
      cleanup: [],
      ordinary: {},
      ...fields,
    };
    fs.mkdirSync(path.dirname(value.stateFile), { recursive: true });
    return value;
  }

  it('moves one complete folder and names its authoritative root in the existing action contract', () => {
    const current = state();
    const action = finish(current, emitAction(current, 'done', {
      outcome: 'complete', summary: 'verified', handoff: { destinations: [], warning: 'terminal' },
    }));
    const destination = path.join(publishedSessionRoot(), path.basename(activeRoot));
    assert.deepEqual(action.handoff.destinations, [destination]);
    assert.match(action.handoff.warning, /Session folder move: rename; authoritative=destination/);
    assert.equal(fs.existsSync(activeRoot), false);
    assert.equal(fs.readFileSync(path.join(destination, 'artifacts', 'plan.md'), 'utf8'), 'plan');
  });

  it('keeps scratch authoritative when terminal publication fails', () => {
    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(source) === path.resolve(activeRoot) && path.dirname(path.resolve(destination)) === publishedSessionRoot()) {
        throw Object.assign(new Error('temp denied'), { code: 'EACCES' });
      }
      return originalRename(source, destination);
    };
    try {
      const current = state();
      const action = finish(current, emitAction(current, 'done', {
        outcome: 'stable-failure', summary: 'stable failure', handoff: { destinations: [], warning: 'terminal' },
      }));
      assert.deepEqual(action.handoff.destinations, [activeRoot]);
      assert.match(action.handoff.warning, /authoritative=source; reason=.*temp denied/);
      assert.equal(fs.existsSync(path.join(activeRoot, 'artifacts', 'plan.md')), true);
    } finally { fs.renameSync = originalRename; }
  });

  it('stores walkthrough execution paths relative to the chat and restores them after handoff', () => {
    const walkthroughPath = path.join(activeRoot, 'artifacts', 'walkthrough.md');
    const logPath = path.join(activeRoot, 'runs', 'run-handoff', 'result.log');
    const current = state({ planPath: path.join(activeRoot, 'artifacts', 'plan.md'), walkthroughPath,
      governingHash: 'hash', ledgerPath: path.join(activeRoot, 'ledger', 'missing.md'),
      ordinary: { redResults: [{ command: 'test', logPath, exitStatus: 1 }] } });
    fs.writeFileSync(walkthroughPath, '# Walkthrough\n');
    fs.writeFileSync(logPath, 'result\n');
    persistEvidence(current);
    const action = finish(current, emitAction(current, 'done', { outcome: 'complete', summary: 'verified' }));
    const published = action.handoff.destinations[0];
    const source = fs.readFileSync(path.join(published, 'artifacts', 'walkthrough.md'), 'utf8');
    const stored = JSON.parse(source.match(/```json\n(.+)\n```/)[1]);
    assert.equal(stored.planPath, '@session/artifacts/plan.md');
    assert.equal(stored.ordinary.redResults[0].logPath, '@session/runs/run-handoff/result.log');
    const restoredRoot = bindSession(published);
    const restored = { ...current, planPath: path.join(restoredRoot, 'artifacts', 'plan.md'),
      walkthroughPath: path.join(restoredRoot, 'artifacts', 'walkthrough.md'), ledgerPath: path.join(restoredRoot, 'ledger', 'missing.md') };
    assert.equal(restoreEvidence(restored), true);
    assert.equal(fs.readFileSync(restored.ordinary.redResults[0].logPath, 'utf8'), 'result\n');
  });

  it('keeps a paused action and an intermediate design increment in workspace scratch', () => {
    const paused = state();
    const pausedAction = finish(paused, emitAction(paused, 'ask-user', { question: 'approval', text: 'approve?', items: [] }));
    assert.equal(pausedAction.action, 'ask-user');
    assert.equal(fs.existsSync(activeRoot), true);

    const increment = state({ designPath: path.join(activeRoot, 'artifacts', 'design.md'), increment: { id: 'I01' } });
    const incrementAction = finish(increment, emitAction(increment, 'done', {
      outcome: 'complete', summary: 'increment complete', handoff: { destinations: [], warning: 'increment' },
    }));
    assert.deepEqual(incrementAction.handoff.destinations, []);
    assert.equal(fs.existsSync(activeRoot), true);
  });

  it('adds terminal handoff behavior to standalone review completion', () => {
    const review = state({ invocation: { verb: 'review', argument: 'review', terminalHandoff: true } });
    const action = finish(review, emitAction(review, 'done', { outcome: 'complete', summary: 'review settled' }));
    assert.equal(action.handoff.destinations.length, 1);
    assert.match(action.handoff.warning, /Session folder move:/);
    assert.notEqual(sessionDir(), activeRoot);
  });
});
