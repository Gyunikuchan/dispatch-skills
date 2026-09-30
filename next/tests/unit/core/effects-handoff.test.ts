import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createHandoff, finalizeHandoff, sessionDirOf } from '../../../skills/dispatch/scripts/effects/handoff.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

test('handoff computes the destination without moving anything', async () => {
  const root = tempDir();
  const session = path.join(root, 'ws', '20260101T0000Z-s-topic');
  const runDir = path.join(session, '.state', 'runs', '001-review');
  fs.mkdirSync(runDir, { recursive: true });
  const deps = { tempRoot: path.join(root, 'tmp'), workspaceRoot: path.join(root, 'ws') };
  assert.equal(sessionDirOf(runDir), session);
  const [terminal] = await createHandoff(deps)({ kind: 'handoff', id: 'root.handoff.1', terminal: true }, fakePorts(), { runDir, attempt: 1 });
  assert.deepEqual(terminal, { type: 'HANDOFF_DONE', effectId: 'root.handoff.1', destination: path.join(root, 'tmp', 'dispatch-skills', '20260101T0000Z-s-topic'), warning: null });
  const [back] = await createHandoff(deps)({ kind: 'handoff', id: 'root.handoff.2', terminal: false }, fakePorts(), { runDir, attempt: 1 });
  assert.equal(back?.type === 'HANDOFF_DONE' && back.destination, session);
  assert.ok(fs.existsSync(runDir));
});

test('finalizeHandoff moves after unlock; a failed move warns and leaves the session in the workspace', () => {
  const root = tempDir();
  const session = path.join(root, 'ws', 's');
  fs.mkdirSync(session, { recursive: true });
  const destination = path.join(root, 'tmp', 's');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const failed = finalizeHandoff(session, destination, { rename: () => { throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' }); }, exists: fs.existsSync });
  assert.equal(failed.location, session);
  assert.match(failed.warning ?? '', /EBUSY[\s\S]*session stays at/);
  assert.ok(fs.existsSync(session));
  const moved = finalizeHandoff(session, destination, { rename: fs.renameSync, exists: fs.existsSync });
  assert.deepEqual(moved, { location: destination, warning: null });
  assert.ok(fs.existsSync(destination) && !fs.existsSync(session));
});
