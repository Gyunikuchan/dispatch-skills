// Code-review R1 regressions: resume round counting, state-file trust, and code-span sanitization.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { sanitizeReplyText } from '../../../skills/dispatch/scripts/driver/actions.mjs';
import { createRunState, pruneFinishedStates, readRunState, rebuildFromArtifact, writeRunState } from '../../../skills/dispatch/scripts/driver/state.mjs';

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
  it('rejects a state file outside the OS-temp state dir even when its parent is named dispatch-driver', () => {
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
  it('removes stale states, their sidecars, and orphaned sidecars; keeps fresh ones', () => {
    const stale = createRunState({ probe: 'stale' });
    const fresh = createRunState({ probe: 'fresh' });
    writeRunState(stale);
    writeRunState(fresh);
    const staleSidecar = stale.stateFile.replace(/\.json$/, '.run.json');
    const orphan = path.join(path.dirname(stale.stateFile), `orphan-${stale.runId}.run.json`);
    fs.writeFileSync(staleSidecar, '{}');
    fs.writeFileSync(orphan, '{}');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const file of [stale.stateFile, staleSidecar, orphan]) fs.utimesSync(file, old, old);
    try {
      pruneFinishedStates();
      assert.equal(fs.existsSync(stale.stateFile), false);
      assert.equal(fs.existsSync(staleSidecar), false);
      assert.equal(fs.existsSync(orphan), false);
      assert.equal(fs.existsSync(fresh.stateFile), true);
    } finally {
      for (const file of [stale.stateFile, staleSidecar, orphan, fresh.stateFile]) fs.rmSync(file, { force: true });
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
    assert.equal(sanitizeReplyText('Move `safeRenameSync` into `common.mjs`.'), 'Move safeRenameSync into common.mjs.');
  });
});
