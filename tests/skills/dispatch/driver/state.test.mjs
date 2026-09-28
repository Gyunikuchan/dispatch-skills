import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { emitAction } from '../../../../skills/dispatch/scripts/driver/actions.mjs';
import { createInvocationState, readInvocationState } from '../../../../skills/dispatch/scripts/review/preparation.mjs';
import {
  bindStateSession, createRunState, finish, readRunState, resumeCommand, writeRunState,
} from '../../../../skills/dispatch/scripts/driver/state.mjs';
import { bindWorkflowSession, RUN_ENV, SESSION_ENV, sessionDir } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

describe('driver state in a movable chat folder', () => {
  let repositoryRoot;
  let saved;
  const fixtureRoots = [];
  const normalized = value => {
    const result = path.resolve(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };

  beforeEach(() => {
    const keys = [SESSION_ENV, RUN_ENV, 'DISPATCH_CHAT_ID', 'DISPATCH_SESSION_TERMINAL'];
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-state-repo-'));
    process.env.DISPATCH_CHAT_ID = `state-${process.pid}-${Date.now()}`;
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('stores session-owned paths relative to the root and resolves them after terminal movement and reactivation', () => {
    const invocation = { verb: 'implement', argument: 'move session state', orchestrator: 'codex', levelSource: 'default', terminalHandoff: true };
    const state = createRunState({ invocation, repoRoot: repositoryRoot, dispatchScript: 'dispatch.mjs', ordinary: {}, pending: null, cleanup: [] });
    state.planPath = path.join(sessionDir(), 'plan.plan.md');
    fs.mkdirSync(path.dirname(state.planPath), { recursive: true });
    fs.writeFileSync(state.planPath, '# plan');
    state.resumeCommand = resumeCommand(invocation);
    writeRunState(state);

    const scratchRoot = sessionDir();
    const action = finish(state, emitAction(state, 'done', {
      outcome: 'complete', summary: 'finished',
      handoff: { destinations: [], warning: 'terminal move' },
    }));
    const publishedRoot = action.handoff.destinations[0];
    assert.notEqual(publishedRoot, scratchRoot);
    assert.equal(action.handoff.destinations.length, 1);
    assert.match(action.handoff.warning, /Session folder move: rename; authoritative=destination/);
    assert.equal(fs.existsSync(scratchRoot), false);

    const persisted = JSON.parse(fs.readFileSync(action.stateFile, 'utf8'));
    assert.equal(persisted.planPath, '@session/plan.plan.md');
    assert.match(persisted.resumeCommand, /--session-dir @session/);

    const rebound = readRunState(action.stateFile);
    const workspaceRoot = sessionDir();
    assert.equal(path.dirname(path.dirname(path.dirname(path.dirname(rebound.stateFile)))), workspaceRoot);
    assert.equal(normalized(rebound.planPath), normalized(path.join(workspaceRoot, 'plan.plan.md')));
    assert.match(rebound.resumeCommand, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(normalized(rebound.pending.handoff.destinations[0]), normalized(workspaceRoot));
  });

  it('rejects state outside a validated session root', () => {
    const foreign = path.join(repositoryRoot, 'runs', 'bad-run', 'state.json');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, JSON.stringify({ v: 1, runId: 'bad-run' }));
    assert.equal(bindStateSession(foreign), null);
    assert.throws(() => readRunState(foreign), /missing or unreadable/);
  });

  it('rejects artifacts outside the bound chat session', () => {
    const artifact = path.join(repositoryRoot, '.scratch', 'other', 'new-chat.walkthrough.md');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, '# New chat walkthrough\n');
    process.env.DISPATCH_CHAT_ID = `new-chat-${process.pid}-${Date.now()}`;
    bindWorkflowSession({ repositoryRoot, slug: 'new-chat-review' });
    assert.throws(() => createInvocationState({ kind: 'code', artifactPath: artifact, snapshot: { contentHash: 'sha256:new-chat' } }), /outside its session folder/);
  });

  it('creates independent run directories beneath the chat folder', () => {
    const first = createRunState({ invocation: { verb: 'ask' }, repoRoot: repositoryRoot, ordinary: {}, pending: null, cleanup: [] });
    const firstRoot = sessionDir();
    const second = createRunState({ invocation: { verb: 'plan' }, repoRoot: repositoryRoot, ordinary: {}, pending: null, cleanup: [] });
    assert.equal(path.dirname(path.dirname(first.stateFile)), path.join(firstRoot, '.state', 'runs'));
    assert.equal(path.dirname(path.dirname(second.stateFile)), path.join(firstRoot, '.state', 'runs'));
    assert.notEqual(first.runId, second.runId);
  });

  it('rebinds standalone review invocation state after the parent folder moves and reactivates', () => {
    const invocation = { verb: 'review', argument: 'plan', orchestrator: 'codex', levelSource: 'default', terminalHandoff: true };
    const parent = createRunState({ invocation, repoRoot: repositoryRoot, dispatchScript: 'dispatch.mjs', ordinary: {}, pending: null, cleanup: [] });
    const originalRoot = sessionDir();
    const artifact = path.join(originalRoot, 'plan.md');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, '# Plan\n');
    const created = createInvocationState({ kind: 'plan', artifactPath: artifact, snapshot: { contentHash: 'sha256:abc' } });
    parent.invocationContext = created.context;
    writeRunState(parent);

    const action = finish(parent, emitAction(parent, 'done', {
      outcome: 'complete', summary: 'review complete', handoff: { destinations: [], warning: 'terminal' },
    }));
    const rebound = readRunState(action.stateFile);
    const reviewState = readInvocationState(rebound.invocationContext);
    const activeRoot = sessionDir();
    assert.equal(path.resolve(reviewState.artifactPath), path.resolve(path.join(activeRoot, 'plan.md')));
    assert.equal(path.resolve(reviewState.statePath), path.resolve(rebound.invocationContext.statePath));
    assert.match(JSON.parse(fs.readFileSync(reviewState.statePath, 'utf8')).statePath, /^@session\//);
  });
});
