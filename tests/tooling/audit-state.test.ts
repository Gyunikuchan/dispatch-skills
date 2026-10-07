import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';
import {
  consumeBudget,
  DEFAULT_CONFIG_PATH,
  loadAuditConfig,
  readRun,
  reserveRun,
  resolveAuthority,
  updateRun,
  type RunIo,
  type ScopeRecord,
} from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';

const clock = { now: () => new Date('2026-10-07T00:00:00Z') };
const config = () => loadAuditConfig(DEFAULT_CONFIG_PATH);
function reserved(overrides: { revision?: string } = {}) {
  const workDir = path.join(tempDir(), '.scratch/audits/2026-10-07-0000-work');
  reserveRun(workDir, { runId: '2026-10-07-0000', revision: overrides.revision ?? 'abc123', config: config(), clock });
  return workDir;
}
const manifestText = (workDir: string) => fs.readFileSync(path.join(workDir, 'manifest.json'), 'utf8');

test('audit lifecycle config loads versioned defaults and rejects unknown keys and non-positive limits', () => {
  const loaded = config();
  assert.equal(loaded.version, 1);
  assert.equal(loaded.limits.scopes, 6); assert.equal(loaded.limits.baselineTestRuns, 1); assert.equal(loaded.limits.focusedReproductions, 3);
  const dir = tempDir(), write = (value: unknown) => { const file = path.join(dir, `${Math.random()}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const valid = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as { version: number; limits: Record<string, number> };
  assert.throws(() => loadAuditConfig(write({ ...valid, extra: true })), /unknown key.*extra/i);
  assert.throws(() => loadAuditConfig(write({ ...valid, limits: { ...valid.limits, madeUp: 1 } })), /unknown limit.*madeUp/i);
  assert.throws(() => loadAuditConfig(write({ ...valid, limits: { ...valid.limits, scopes: 0 } })), /scopes.*positive safe integer/i);
  assert.throws(() => loadAuditConfig(write({ ...valid, limits: { ...valid.limits, scopes: 1.5 } })), /scopes.*positive safe integer/i);
  assert.throws(() => loadAuditConfig(write({ ...valid, version: 2 })), /version/i);
  const { scopes: _omit, ...missing } = valid.limits;
  assert.throws(() => loadAuditConfig(write({ ...valid, limits: missing })), /missing limit.*scopes/i);
});

test('audit lifecycle reserve persists effective settings and rejects a colliding run id without overwriting', () => {
  const workDir = reserved();
  const manifest = readRun(workDir);
  assert.equal(manifest.version, 1); assert.equal(manifest.revision, 'abc123'); assert.equal(manifest.createdAt, '2026-10-07T00:00:00.000Z');
  assert.deepEqual(manifest.settings, config()); assert.equal(manifest.baseline.status, 'pending');
  const before = manifestText(workDir);
  assert.throws(() => reserveRun(workDir, { runId: '2026-10-07-0000', revision: 'other', config: config(), clock }), /already reserved.*new --run id|--resume/i);
  assert.equal(manifestText(workDir), before);
});

test('audit lifecycle legacy work directory requires a fresh run and keeps its evidence', () => {
  const workDir = path.join(tempDir(), 'legacy-work'); fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'git-status.txt'), 'old');
  assert.throws(() => readRun(workDir), /legacy.*fresh run/i);
  assert.equal(fs.readFileSync(path.join(workDir, 'git-status.txt'), 'utf8'), 'old');
});

test('audit lifecycle budget blocks new work at the configured limit while terminal updates persist', () => {
  const workDir = reserved();
  for (let i = 1; i <= 3; i++) assert.deepEqual(consumeBudget(workDir, 'lead', 'focusedReproductions'), { allowed: true, used: i, limit: 3 });
  assert.deepEqual(consumeBudget(workDir, 'lead', 'focusedReproductions'), { allowed: false, used: 3, limit: 3 });
  assert.equal(readRun(workDir).budgets['lead']?.['focusedReproductions'], 3);
  assert.throws(() => consumeBudget(workDir, 'lead', 'notALimit'), /unknown limit/i);
  updateRun(workDir, (m) => { m.scopes['ask'] = { lifecycle: 'partial', handle: null, budgets: { scopeToolCalls: 40 }, resultPath: 'scopes/ask.md', gaps: ['budget exhausted'] }; });
  assert.deepEqual(readRun(workDir).scopes['ask']?.gaps, ['budget exhausted']);
});

test('audit lifecycle persists terminal probe state with unknown liveness and rejects invalid states', () => {
  const workDir = reserved();
  const probe = { lifecycle: 'interrupted', host: 'codex', handle: null, liveness: 'unknown', startedAt: '2026-10-07T00:00:00.000Z', deadlineAt: '2026-10-07T00:01:00.000Z', attempts: 1, exitConfirmed: false, capturePath: 'dispatch/codex.read.out', fixturePath: 'dispatch/fixture', outcome: null, cause: 'interrupted', cleanup: 'blocked' } as const;
  updateRun(workDir, (m) => { m.probes['codex/read'] = { ...probe }; });
  assert.deepEqual(readRun(workDir).probes['codex/read'], probe);
  const before = manifestText(workDir);
  assert.throws(() => updateRun(workDir, (m) => { m.probes['codex/read'] = { ...probe, lifecycle: 'exploded' as never }; }), /lifecycle/);
  assert.throws(() => updateRun(workDir, (m) => { m.scopes['ask'] = { lifecycle: 'done' as never, handle: null, budgets: {}, resultPath: null, gaps: [] }; }), /lifecycle/);
  assert.equal(manifestText(workDir), before);
});

test('audit lifecycle atomic write failure leaves the previous manifest intact and no temp files', () => {
  const workDir = reserved();
  const before = manifestText(workDir);
  const io: RunIo = { ...fs, renameSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  assert.throws(() => updateRun(workDir, (m) => { m.hostHandles['lead'] = 'h1'; }, io), /disk full/);
  assert.equal(manifestText(workDir), before);
  assert.deepEqual(fs.readdirSync(workDir), ['manifest.json']);
});

test('audit lifecycle stale baseline rejection protects a completed baseline and a changed revision', () => {
  const workDir = reserved();
  updateRun(workDir, (m) => { m.baseline = { status: 'complete', fingerprints: { 'git-status.txt': 'sha256:1' }, tests: { status: 0, signal: null, error: null, totals: 'ok', capture: 'tests.txt' }, gaps: [] }; });
  assert.throws(() => updateRun(workDir, (m) => { m.baseline.fingerprints['git-status.txt'] = 'sha256:2'; }), /baseline.*immutable/i);
  assert.throws(() => readRun(workDir, { revision: 'def456' }), /stale.*abc123.*def456/i);
  assert.equal(readRun(workDir, { revision: 'abc123' }).baseline.fingerprints['git-status.txt'], 'sha256:1');
});

test('audit lifecycle authority reconciliation keeps the source authoritative until publication', () => {
  const source = '/repo/work', destination = '/tmp/dest';
  const exists = (present: string[]) => (p: string) => present.includes(p);
  assert.deepEqual(resolveAuthority(source, null, exists([source])), { authoritative: source, uncertain: [], removeSource: false });
  assert.deepEqual(resolveAuthority(source, { phase: 'staging', destination }, exists([source, destination])), { authoritative: source, uncertain: [destination], removeSource: false });
  assert.deepEqual(resolveAuthority(source, { phase: 'failed', destination }, exists([source, destination])), { authoritative: source, uncertain: [destination], removeSource: false });
  assert.deepEqual(resolveAuthority(source, { phase: 'published', destination }, exists([source, destination])), { authoritative: destination, uncertain: [], removeSource: true });
  assert.deepEqual(resolveAuthority(source, { phase: 'published', destination }, exists([source])), { authoritative: source, uncertain: [], removeSource: false });
});

test('audit lifecycle manifest lock serializes a concurrent scope update so probe and lead updates both survive', () => {
  const workDir = reserved();
  const scope: ScopeRecord = { lifecycle: 'running', handle: 'agent-1', budgets: {}, resultPath: null, gaps: [] };
  const sleeps: number[] = [];
  let blocked: unknown = null;
  // The lead's write lands while the probe holds the lock, between its read and its write.
  updateRun(workDir, (m) => {
    try { updateRun(workDir, (n) => { n.scopes['ask'] = { ...scope }; }, fs, { retries: 2, sleep: (ms) => sleeps.push(ms) }); } catch (err) { blocked = err; }
    m.hostHandles['probe'] = 'h-probe';
  });
  assert.match(String(blocked), /locked by another writer/);
  assert.equal(sleeps.length, 2);
  updateRun(workDir, (m) => { m.scopes['ask'] = { ...scope }; });
  const final = readRun(workDir);
  assert.equal(final.hostHandles['probe'], 'h-probe');
  assert.deepEqual(final.scopes['ask'], scope);
  assert.deepEqual(fs.readdirSync(workDir), ['manifest.json']);
});

test('audit lifecycle manifest lock reclaims a stale lock and keeps waiting on a fresh one', () => {
  const workDir = reserved();
  const lock = path.join(workDir, 'manifest.json.lock');
  const now = new Date('2026-10-07T01:00:00Z');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: now.getTime() - 60_000 }));
  updateRun(workDir, (m) => { m.hostHandles['lead'] = 'h1'; }, fs, { clock: { now: () => now }, sleep: () => assert.fail('stale lock must not be waited on') });
  assert.equal(readRun(workDir).hostHandles['lead'], 'h1');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: now.getTime() - 1_000 }));
  let waits = 0;
  assert.throws(() => updateRun(workDir, (m) => { m.hostHandles['lead'] = 'h2'; }, fs, { clock: { now: () => now }, retries: 3, sleep: () => { waits++; } }), /locked/);
  assert.equal(waits, 3);
  assert.equal(readRun(workDir).hostHandles['lead'], 'h1');
});
