import { memoryRunFs } from '../../../helpers/memory-run-fs.ts';
import path from 'node:path';
import { fakePorts, tempDir } from '../../../helpers/fake-ports.ts';
import { RUN_STARTED } from './machines.ts';
import { start, send, loadExecution } from '../../../../skills/dispatch/scripts/core/interpreter.ts';
import { beginReview, reviewMachine, stepReview } from '../../../../skills/dispatch/scripts/machines/review.ts';
import { createPrepareReview } from '../../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { createCheckReviewTarget } from '../../../../skills/dispatch/scripts/effects/check-review-target.ts';
import type { Handlers, Machine, Event, Ports } from '../../../../skills/dispatch/scripts/core/types.ts';
import type { ReviewState } from '../../../../skills/dispatch/scripts/machines/review.ts';
import type { Git, ReviewSnapshot } from '../../../../skills/dispatch/scripts/effects/git.ts';
import { reviewManifestRef } from '../../../../skills/dispatch/scripts/effects/review-manifest.ts';
export const fixtureReference = (ports: Ports, runDir: string, file: string) => reviewManifestRef(ports, runDir, file);
function legacyState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyState);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['priorManifestRef', 'targetManifestRef', 'fixCandidateRef'].includes(key)).map(([key, child]) => [key, legacyState(child)]));
}
export async function pausedReview(legacy = false) {
  const ports = fakePorts(), cwd = tempDir(), runDir = path.join(cwd, 'run');
  memoryRunFs(ports, runDir);
  const original: ReviewSnapshot = { head: 'head', target: '', comparison: 'head', index: {}, working: { 'src/a.ts': 'a0', 'src/outside.ts': 'b0' }, untracked: {} };
  let current = structuredClone(original);
  const git = { toplevel: async () => cwd, diffNames: async () => Object.keys(current.working), reviewSnapshot: async (_cwd: string, _target: string, paths?: readonly string[]) => ({ ...structuredClone(current), ...(paths ? { governedPaths: [...paths] } : {}) }),
    reviewDelta: async (_cwd: string, prior: ReviewSnapshot, next: ReviewSnapshot = current) => ({ staged: [], unstaged: [], untracked: [], deleted: [], paths: Object.keys(next.working).filter(file => prior.working[file] !== next.working[file]) }) } as unknown as Git;
  const spec = { kind: 'code', mode: 'fix', target: '', cap: 3, breadth: 1, context: 'Probe', roster: [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }], timeoutMs: 1000 };
  const machine: Machine<ReviewState> = { ...reviewMachine, codec: { name: 'fixture-review', version: 1, runtime: () => 'fixture-review-v2', encode: value => structuredClone(value), decode: value => structuredClone(value) as ReviewState },
    step: (state,event) => event.type === 'RUN_STARTED' ? beginReview(spec as Parameters<typeof beginReview>[0], 'review', {}) : stepReview(state,event) };
  const handlers: Handlers = { 'prepare-review': createPrepareReview({ cwd, skillRoot: path.join(path.resolve('skills/dispatch')), git }),
    'check-review-target': createCheckReviewTarget({ cwd, git }),
    'wave-start': async effect => [{ type: 'WAVE_STARTED', effectId: effect.id, round: effect.round, waveKey: 'probe', attempt: 1, roster: effect.roster, claimPath: null, inputPath: 'probe', native: [], early: [],
      completed: { type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: [{slot: "codex[0]",state:"success"}], findings: [{ id: 'F1', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L1', defect: 'Guard', requiredChange: 'Fix', sources: ['codex[0]'], scope: 'in' }] } }],
    verify: async effect => [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results: effect.commands.map(command=>({command,exit:0})), fingerprint: {} }] };
  const first = await start({ ports, runDir, machine, handlers, runStarted: { ...RUN_STARTED, verb: 'review', fix: true } });
  if (first.frame?.await !== 'rule') throw Error(`not rule: ${JSON.stringify(first)}`);
  if (legacy) {
    const state = loadExecution(machine, ports, runDir).folder.state;
    if (!('c' in state)) throw Error('missing review context');
    machine.codec = { ...machine.codec!, encode: value => legacyState(value) };
    const accepted = await send({ ports, runDir, machine, handlers, rawEvent: { type: 'RULINGS', rulings: { [state.c.findings[0]!.id]: { ruling: 'accept', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['check'] } } } } });
    if (accepted.frame?.await !== 'fix') throw Error(`not fix: ${JSON.stringify(accepted)}`);
  }
  const options = { ports, runDir, machine, handlers };
  return { ...options, options, first, state: () => loadExecution(machine,ports,runDir).folder.state, edit: () => { current.working['src/outside.ts']='b1'; }, current:()=>current };
}
