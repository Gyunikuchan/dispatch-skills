// Shared governing-spec fixture: root-driven tests settle a spec before their child boots.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOURNAL_PROTOCOL_REVISION, type Event, type Ports, type RunStartedEvent, type SpecIdentity } from '../../skills/dispatch/scripts/core/types.ts';
import { parseSpec } from '../../skills/dispatch/scripts/domain/spec.ts';

/** A spec that lints clean at every level. */
export const SPEC_SOURCE = [
  '# Fixture spec', '', '> **Status:** approved', '> **Level:** medium', '',
  '## Intent & Problem', 'Exercise the governed flow.', '',
  '## Background', 'Fixture context.', '',
  '## Requirements', '### REQ-1 — Fixture behavior', '- Acceptance: the flow settles.', '',
  '## Non-goals', '- None.', '',
  '## Constraints', '- Portable.', '',
  '## Decisions', '### DEC-1 — Fixture choice', '- Choice: keep it small.', '',
  '## Discussion Record', '- Agreed.', '',
  '## Open Questions', '- None.', '',
].join('\n');

export const SPEC_PATH = 'fixture.spec.md';
export const SPEC_EFFECT = 'spec.parse-artifact.1';

export const specHash = (source: string = SPEC_SOURCE): string => `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`;

/** Adds the startup candidate and, when approved, a prior approval of its hash. */
export function withSpec(run: RunStartedEvent, specPath: string = SPEC_PATH, options: { approved?: boolean; source?: string } = {}): RunStartedEvent {
  const hash = specHash(options.source);
  return { ...run, specCandidate: specPath, ...(options.approved ? { specApprovals: [{ by: 'user', quote: 'approved', hash }] } : {}) };
}

/** The host answer to the spec stage's `parse-artifact` effect. */
export function specParsed(effectId: string = SPEC_EFFECT, _specPath: string = SPEC_PATH, source: string = SPEC_SOURCE): Event {
  const result = parseSpec(source, { level: 'high' });
  return { type: 'ARTIFACT_PARSED', effectId, kind: 'spec', hash: specHash(source), parsed: result.ok ? result.spec : {}, defects: result.ok ? [] : result.defects };
}

export const specApproval = (hash: string = specHash()): Event => ({ type: 'DECISION', kind: 'spec-approval', answer: { by: 'user', quote: 'approve', hash } });

/** Writes `<sessionDir>/fixture.spec.md` and returns its identity. */
export function seedSpec(ports: Ports, sessionDir: string, source: string = SPEC_SOURCE): SpecIdentity {
  const file = path.join(sessionDir, SPEC_PATH);
  ports.fs.writeAtomic(file, source);
  return { path: file, hash: specHash(source) };
}

/** Writes a minimal current-protocol prior run journal holding one user spec approval of `hash`. */
export function seedSpecApproval(ports: Ports, sessionDir: string, hash: string, runId = '20260101T000000Z-prior', protocolRevision: number = JOURNAL_PROTOCOL_REVISION): string {
  const runDir = path.join(sessionDir, '.state', 'runs', runId);
  const at = '2026-01-01T00:00:00.000Z';
  const lines = [
    { seq: 1, v: 1, at, type: 'RUN_STARTED', data: { verb: 'plan', argument: 'prior', level: 'medium', protocolRevision } },
    { seq: 2, v: 1, at, type: 'DECISION', data: { kind: 'spec-approval', answer: { by: 'user', quote: 'approve', hash } } },
  ];
  ports.fs.writeAtomic(path.join(runDir, 'events.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return runDir;
}

let shared: string | null = null;
/** A process-wide on-disk copy of `SPEC_SOURCE` for interpreter tests whose sessions hold no spec of their own. */
export function sharedSpecPath(): string {
  if (shared && fs.existsSync(shared)) return shared;
  shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-')), SPEC_PATH);
  fs.writeFileSync(shared, SPEC_SOURCE);
  return shared;
}

/** Adds the shared on-disk spec as the start candidate of a non-ask run. */
export const governed = <T extends RunStartedEvent>(run: T): T => (run.verb === 'ask' ? run : { ...run, specCandidate: sharedSpecPath() });
