// Code-review R1 regressions: resume round counting, state-file trust, and code-span sanitization.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sanitizeReplyText } from '../../../../skills/dispatch/scripts/driver/actions.mjs';
import { createRunState, pruneFinishedStates, readRunState, rebuildFromArtifact, writeRunState } from '../../../../skills/dispatch/scripts/driver/state.mjs';
import { MANIFEST_NAME, RUN_ENV, SESSION_ENV, openSession, sessionsRoot } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

const DISPATCH = fileURLToPath(new URL('../../../../skills/dispatch/scripts/dispatch.mjs', import.meta.url));

const source = (round) => `- **Sources:** {"plan-review:R${round}:agy:0":{"provider":"agy","candidateIndex":0,"model":"m","effort":null,"status":"target","session":null,"substitutesFor":null}}`;
const entry = (round, status, severity = 'MUST') =>
  `- **[${status}]** [R${round}-F001] [${severity}] [sources=plan-review:R${round}:agy:0] § Proposed Changes — correctness: defect → resolution`;

function artifact(rounds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-state-'));
  const file = path.join(dir, 'plan.md');
  const body = rounds.map(([round, status]) => `### Round ${round} — 2026-09-22\n${source(round)}\n${entry(round, status)}`).join('\n\n');
  fs.writeFileSync(file, `# Plan\n\n## Review Findings & Resolutions\n\n${body}\n\n## Out of Scope\nNone.\n`);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('rebuildFromArtifact', () => {
  it('counts only the rounds after the latest settled prefix', () => {
    const fixture = artifact([[1, 'Accepted'], [2, 'Accepted'], [3, 'Accepted'], [4, 'Rejected — Pending Confirmation']]);
    try {
      const rebuilt = rebuildFromArtifact(fixture.file);
      assert.ok(rebuilt);
      assert.equal(rebuilt.rounds, 1);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns null for a settled log', () => {
    const fixture = artifact([[1, 'Accepted']]);
    try {
      assert.equal(rebuildFromArtifact(fixture.file), null);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('readRunState trust boundary', () => {
  it('rejects a state file outside the sessions root even when its parent is named dispatch-driver', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'driver-evil-')), 'nested', 'dispatch-driver');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, runId: 'x' }));
    try {
      assert.throws(() => readRunState(file), (err) => err.code === 'STATE_UNREADABLE');
    } finally {
      fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
    }
  });

  it('reads a state written by the driver', () => {
    const state = createRunState({ probe: true });
    writeRunState(state);
    try {
      assert.equal(readRunState(state.stateFile).runId, state.runId);
    } finally {
      fs.rmSync(state.stateFile, { force: true });
    }
  });
});

describe('pruneFinishedStates', () => {
  it('prunes only aged transient files and retains session evidence', () => {
    const bound = createRunState({ probe: 'bound' });
    writeRunState(bound);
    const stale = openSession(`stale-${process.pid}`);
    for (const area of ['runs', 'cache', 'artifacts', 'ledger', 'telemetry']) fs.mkdirSync(path.join(stale, area), { recursive: true });
    fs.writeFileSync(path.join(stale, 'ledger', 'kept-ledger.md'), 'evidence');
    const manifestFile = path.join(stale, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.lastUsedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const fresh = openSession(`fresh-${process.pid}`);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(path.dirname(bound.stateFile), old, old);
    fs.utimesSync(bound.stateFile, old, old);
    try {
      pruneFinishedStates();
      assert.equal(fs.existsSync(stale), true);
      assert.equal(fs.existsSync(manifestFile), true);
      assert.equal(fs.existsSync(path.join(stale, 'ledger', 'kept-ledger.md')), true);
      assert.equal(fs.existsSync(path.join(stale, 'runs')), false);
      assert.equal(fs.existsSync(path.join(stale, 'cache')), false);
      assert.equal(fs.existsSync(fresh), true);
      assert.equal(fs.existsSync(bound.stateFile), true);
    } finally {
      for (const dir of [stale, fresh]) fs.rmSync(dir, { recursive: true, force: true });
      process.env[SESSION_ENV] = path.dirname(path.dirname(path.dirname(bound.stateFile)));
    }
  });
});

describe('session directories', () => {
  it('stores driver runs below one workflow session with a separate run directory each', () => {
    const first = createRunState({ probe: 1 }), nested = createRunState({ probe: 2 });
    assert.notEqual(path.dirname(first.stateFile), path.dirname(nested.stateFile));
    const firstSession = path.dirname(path.dirname(path.dirname(first.stateFile)));
    const nestedSession = path.dirname(path.dirname(path.dirname(nested.stateFile)));
    assert.equal(firstSession, nestedSession);
    assert.equal(path.dirname(firstSession), sessionsRoot());
    assert.equal(path.basename(path.dirname(first.stateFile)), first.runId);
  });

  it('rebinds a pre-change state fixture for both --next and --drive', () => {
    const legacy = path.join(sessionsRoot(), 'sessions', `legacy-${process.pid}`);
    fs.mkdirSync(legacy, { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111';
    const stateFile = path.join(legacy, `${id}.json`);
    fs.writeFileSync(stateFile, JSON.stringify({ v: 1, runId: id, pending: { action: 'ask-user', question: 'approval', text: 'Continue?', items: [] } }));
    const env = { ...process.env };
    for (const key of ['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_LEGACY_SESSION', 'DISPATCH_LEGACY_STATE_FILE']) delete env[key];
    try {
      for (const mode of ['--next', '--drive']) {
        const result = spawnSync(process.execPath, [DISPATCH, mode, '--state', stateFile], { encoding: 'utf8', env, timeout: 30000, windowsHide: true });
        assert.equal(result.status, 0, `${mode} could not rebind the live legacy state: ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).action, 'ask-user');
        assert.doesNotMatch(result.stderr, /missing or unreadable/);
      }
    } finally {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
  });

  it('reads a nested in-flight legacy run without relaxing direct-session manifest checks', () => {
    const legacy = path.join(sessionsRoot(), 'sessions', `legacy-nested-${process.pid}-${Date.now()}`);
    const runId = '33333333-3333-4333-8333-333333333333';
    const legacyState = path.join(legacy, 'runs', runId, 'state.json');
    const arbitraryState = path.join(legacy, 'other', runId, 'state.json');
    const directSession = path.join(sessionsRoot(), `missing-manifest-${process.pid}-${Date.now()}`);
    const directState = path.join(directSession, 'runs', runId, 'state.json');
    const keys = [SESSION_ENV, RUN_ENV, 'DISPATCH_LEGACY_SESSION', 'DISPATCH_LEGACY_STATE_FILE'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    fs.mkdirSync(path.dirname(legacyState), { recursive: true });
    fs.mkdirSync(path.dirname(arbitraryState), { recursive: true });
    fs.mkdirSync(path.dirname(directState), { recursive: true });
    const stateText = JSON.stringify({ v: 1, runId, pending: { action: 'ask-user', question: 'approval', text: 'Continue?', items: [] } });
    fs.writeFileSync(legacyState, stateText);
    fs.writeFileSync(arbitraryState, stateText);
    fs.writeFileSync(directState, stateText);
    for (const key of keys) delete process.env[key];
    try {
      assert.equal(readRunState(legacyState).runId, runId);
      assert.equal(process.env[SESSION_ENV], legacy);
      assert.equal(process.env[RUN_ENV], runId);
      assert.throws(() => readRunState(arbitraryState), err => err.code === 'STATE_UNREADABLE');
      assert.throws(() => readRunState(directState), /manifest/);
    } finally {
      for (const dir of [legacy, directSession]) fs.rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

describe('sanitizeReplyText', () => {
  it('drops bare lowercase tool-call lines', () => {
    assert.equal(sanitizeReplyText('Keep this.\ninvoke(name="rm", cmd="y")'), 'Keep this.');
  });

  it('cuts mid-line tool_use markup', () => {
    assert.equal(sanitizeReplyText('Fix the bug. <tool_use name="x">rm -rf</tool_use>'), 'Fix the bug.');
  });

  it('keeps code-span contents and drops only the backticks', () => {
    assert.equal(sanitizeReplyText('Move `safeRenameSync` into `lib/common.mjs`.'), 'Move safeRenameSync into lib/common.mjs.');
  });
});
