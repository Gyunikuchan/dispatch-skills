import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { nodeFs } from '../../../skills/dispatch/scripts/core/ports.ts';
import { milestone, PROGRESS_FILE, STALL_HINT_MS, writeProgress } from '../../../skills/dispatch/scripts/core/progress.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

test('progress.json is replaced atomically with no temp file left behind', () => {
  const ports = { ...fakePorts(), fs: nodeFs };
  const runDir = tempDir();
  const snapshot = (id: string) => ({ at: '2026-01-01T00:00:00.000Z', effect: { id, kind: 'verify' as const, startedAt: '2026-01-01T00:00:00.000Z' } });
  writeProgress(ports, runDir, snapshot('a.verify.1'));
  writeProgress(ports, runDir, snapshot('a.verify.2'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, PROGRESS_FILE), 'utf8')), snapshot('a.verify.2'));
  assert.deepEqual(fs.readdirSync(runDir), [PROGRESS_FILE]);
});

test('milestones are [dispatch]-prefixed stderr lines', () => {
  const ports = fakePorts();
  milestone(ports, 'wave R2 done');
  assert.deepEqual(ports.stderrLines, ['[dispatch] wave R2 done\n']);
  assert.equal(STALL_HINT_MS, 300_000);
});
