import fs from 'node:fs';
import path from 'node:path';
import { dispatchMachine } from '../../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Handlers, RunStartedEvent } from '../../../../skills/dispatch/scripts/core/types.ts';
import { fakePorts, tempDir } from '../../../helpers/fake-ports.ts';
import { RUN_STARTED } from './machines.ts';
export const hash = `sha256:${'a'.repeat(64)}`;
const fingerprint = { head: 'a'.repeat(40), index: 'index', worktree: 'tree' };
export const parsedPlan = { title: 'Fixture', box: { 'TL;DR': 'Fixture behavior' }, keyDecisions: [], criteria: [], changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'Deliver', command: null, line: 1 }], verification: { automated: [], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: null, governedText: '# Fixture' };
export function phaseFixture(verb: 'implement' | 'plan' | 'review', rounds = 1, empty = false) {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state/runs/001-flow');
  // Durability is exercised by E2E; phase transcripts need only exclusive claims.
  ports.fs.publishExclusive = (file, text) => {
    try { fs.writeFileSync(file, text, { flag: 'wx' }); return true; }
    catch (error) { if ((error as { code?: string }).code === 'EEXIST') return false; throw error; }
  };
  const listFiles = ports.fs.listFiles;
  ports.fs.listFiles = (dir) => dir === path.join(session, '.state/runs') ? fs.existsSync(path.join(runDir, 'diagnostics/capture.json')) ? ['001-flow/diagnostics/capture.json'] : [] : listFiles(dir);
  const runStarted: RunStartedEvent = { ...RUN_STARTED, verb, argument: 'Fixture behavior', orchestrator: 'claude', overrides: { sessionDir: session }, config: { diagnostics: true, 'write-subagents': { claude: { low: { model: 'writer' } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'plan-review': { rounds: { low: rounds }, targets: { low: 1 } }, 'code-review': { rounds: { low: rounds }, targets: { low: 1 } } } } };
  const handlers: Handlers = {
    snapshot: async (effect) => [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint, diff: { paths: [] } }],
    'parse-artifact': async (effect) => fs.existsSync(effect.path) ? [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash, parsed: parsedPlan, defects: [] }] : [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: 'not found' }],
    verify: async (effect) => [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results: [], fingerprint }],
    'write-brief': async (effect) => [{ type: 'BRIEF_READY', effectId: effect.id, stage: effect.stage, path: 'brief', sha256: hash, envelopePath: 'envelope.json' }],
    'check-envelope': async (effect) => [{ type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered', evidence: [] }, defects: [], diff: { paths: ['src/a.ts'] } }],
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: empty ? [] : ['src/a.ts'], empty }, promptPaths: { 'codex[0]': 'prompt' } }],
    'wave-start': async (effect) => [{ type: 'WAVE_STARTED', effectId: effect.id, waveKey: effect.id, attempt: 1, roster: effect.roster, native: [], early: [], claimPath: null, inputPath: 'input' }],
    'wave-finish': async (effect) => [{ type: 'WAVE_DONE', effectId: effect.id, round: effect.round, findings: [], slots: [{ slot: 'codex[0]', state: 'success', claim: 'Clean' }] }],
    handoff: async (effect) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: session, warning: null }],
  };
  const options = { ports, runDir, machine: dispatchMachine, handlers, diagnosticToggle: () => true };
  const capture = () => JSON.parse(fs.readFileSync(path.join(runDir, 'diagnostics/capture.json'), 'utf8')) as { phases: Array<{ id: string; name: string; outcome: string; start: number; end: number }> };
  return { options, runStarted, capture, session };
}
