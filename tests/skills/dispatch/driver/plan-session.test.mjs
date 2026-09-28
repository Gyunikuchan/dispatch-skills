import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { authorPlan } from '../../../../skills/dispatch/scripts/driver/plan-phase.mjs';
import { bindWorkflowSession } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

describe('driver plan authoring', () => {
  let repositoryRoot;
  let session;
  let saved;
  const normalized = value => path.resolve(value).replaceAll('\\', '/');

  beforeEach(() => {
    const keys = ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_CHAT_ID'];
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-plan-session-'));
    process.env.DISPATCH_CHAT_ID = `plan-${process.pid}-${Date.now()}`;
    session = bindWorkflowSession({ repositoryRoot, artifactKind: 'plan', slug: 'plan-session' });
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('asks the author to write the canonical plan below the bound session root', () => {
    const state = {
      stateFile: path.join(session, 'runs', 'run-1', 'state.json'),
      runId: 'run-1',
      repoRoot: repositoryRoot,
      invocation: { argument: 'Implement the plan session behavior' },
      ordinary: {},
    };
    const action = authorPlan(state);
    assert.equal(action.action, 'author');
    assert.equal(normalized(path.dirname(action.path)), normalized(path.join(session, 'artifacts')));
    assert.match(path.basename(action.path), /^implement-the-plan-session-behavior\.md$/);
  });
});
