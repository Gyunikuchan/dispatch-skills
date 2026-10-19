// `createHandlers(deps)` → core `Handlers` for every effect kind plus `wave` (single-shot handler with native
// marking, or `wave-native.ts` when every roster entry carries a host capture).

import type { Effect, Handler, Handlers } from '../core/types.ts';
import path from 'node:path';
import type { OsId } from '../lib/platform.ts';
import type { ProviderId } from '../providers/types.ts';
import type { Git } from './git.ts';
import fs from 'node:fs';
import { createCheckout, checkoutRecovery, type CheckoutDeps } from './checkout.ts';
import { createCheckEnvelope, changedPaths, pathHashes } from './check-envelope.ts';
import { createHandoff } from './handoff.ts';
import { createParseArtifact } from './parse-artifact.ts';
import { runPaths } from '../lib/session.ts';
import { createPrepareReview } from './prepare-review.ts';
import { createCheckReviewTarget } from './check-review-target.ts';
import { createSnapshot } from './snapshot.ts';
import { createRestore, restoreRecovery } from './restore.ts';
import { createAssessRecovery } from './assess-recovery.ts';
import { loadRecovery } from './recovery-manifest.ts';
import { createVerify } from './verify.ts';
import { createWaveStartHandler, createWaveFinishHandler, createWaveHandler, waveRecovery, type SlotPaths, type WaveContext, type WaveDeps } from './wave.ts';
import { isNativeRoster, nativeWave } from './wave-native.ts';
import { createWriteBrief } from './write-brief.ts';

type WaveEffect = Extract<Effect, { kind: 'wave' }>;
type Row = Readonly<Record<string, unknown>>;

export type HandlerDeps = {
  skillRoot: string;
  cwd: string;
  os: OsId;
  git: Git;
  tempRoot: string;
  workspaceRoot: string;
  orchestratorPlatform: ProviderId | null;
  /** Worker plumbing for the real wave, or a replacement CLI wave handler (tests). */
  wave: Omit<WaveDeps, 'context'> | Handler<WaveEffect>;
  selfCheckCommand?: (runDir: string, eventPath: string) => string;
  checkpointCommand?: (root: string, out: string, paths: readonly string[]) => string;
  /** Directory-link plumbing for private worktrees; defaults to Node junction/symlink calls. */
  links?: CheckoutDeps['links'];
};

// NOTE: 'junction' needs no elevation on Windows and is ignored elsewhere; unlink removes only the link.
const nodeLinks: CheckoutDeps['links'] = { create: (target, link) => fs.symlinkSync(target, link, 'junction'), remove: (link) => fs.unlinkSync(link) };

const reviewOf = (roster: readonly Row[]): WaveContext['review'] => {
  const value = roster[0]?.['review'];
  return value === 'plan' || value === 'design' || value === 'ask' ? value : 'code';
};

/** Wave context from the roster: each slot's `promptPath` (copied from `REVIEW_PREPARED`) and a log beside it. */
export function waveContext(effect: { roster: readonly Row[] }, deps: Pick<HandlerDeps, 'cwd' | 'orchestratorPlatform'>): WaveContext {
  const paths: Record<string, SlotPaths> = {};
  for (const slot of effect.roster) {
    const name = slot['slot'];
    const promptPath = slot['promptPath'];
    if (typeof name === 'string' && typeof promptPath === 'string' && promptPath) paths[name] = { promptPath, logPath: promptPath.replace(/\.prompt\.md$/, '.log'), attachments: [] };
  }
  return { review: reviewOf(effect.roster), orchestratorPlatform: deps.orchestratorPlatform, cwd: deps.cwd, paths, nativeHost: true };
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const cli: Handler<WaveEffect> = typeof deps.wave === 'function'
    ? deps.wave
    : createWaveHandler({ ...deps.wave, context: (effect) => waveContext(effect as WaveEffect, deps) });
  const wave: Handler<WaveEffect> = (effect, ports, ctx) => (isNativeRoster(effect.roster) ? nativeWave(effect, ports) : cli(effect, ports, ctx));
  const handlers: Handlers = {
    'parse-artifact': createParseArtifact({ cwd: deps.cwd }),
    'prepare-review': createPrepareReview(deps),
    'check-review-target': createCheckReviewTarget(deps),
    wave,
    'wave-start': typeof deps.wave === 'function'
      ? (effect, ports, ctx) => cli({ ...effect, kind: 'wave' }, ports, ctx).then((events) => events.map((event) => event.type === 'WAVE_DONE' ? { type: 'WAVE_STARTED' as const, effectId: effect.id, waveKey: effect.id, attempt: 0, roster: effect.roster, native: [], early: [], claimPath: null, inputPath: '', completed: event } : event))
      : createWaveStartHandler({ ...deps.wave, context: (effect) => waveContext(effect, deps) }),
    'wave-finish': typeof deps.wave === 'function'
      ? (effect, ports, ctx) => cli({ ...effect, kind: 'wave' }, ports, ctx)
      : createWaveFinishHandler({ ...deps.wave, context: (effect) => waveContext(effect, deps) }),
    verify: createVerify(deps),
    'check-envelope': createCheckEnvelope(deps),
    'write-brief': async (effect, ports, ctx) => {
      if (!deps.selfCheckCommand) return createWriteBrief(deps)(effect, ports, ctx);
      const eventPath = runPaths(ctx.runDir).selfCheckEvent(effect.id);
      const task = effect.input['task'] as { id?: unknown; attempt?: unknown; signature?: unknown } | undefined;
      const identity = typeof task?.id === 'string' && Number.isSafeInteger(task.attempt) && Number(task.attempt) > 0 && typeof task.signature === 'string'
        ? { task: task.id, attempt: Number(task.attempt), signature: task.signature, handle: '<host-assigned handle>' }
        : null;
      const events = await createWriteBrief(deps)({ ...effect, input: { ...effect.input, selfCheck: deps.selfCheckCommand(ctx.runDir, eventPath) } }, ports, ctx);
      const ready = events.find((event) => event.type === 'BRIEF_READY');
      if (!ready || ready.type !== 'BRIEF_READY') return events;
      // NOTE: the brief embeds only the event path, so the preview receipt is written after rendering to echo the brief hash;
      // an amended live writer holds the delta, so its hash binds instead.
      const receipt = identity
        ? { type: 'WRITE_RECEIPT', status: 'submitted', ...identity, envelopePath: ready.envelopePath, briefHash: ready.delta?.sha256 ?? ready.sha256, model: '<host-attested model>' }
        : { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: ready.envelopePath };
      try { ports.fs.writeAtomic(eventPath, `${JSON.stringify(receipt)}\n`); } catch (error) {
        return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `self-check event: ${error instanceof Error ? error.message : String(error)}` }];
      }
      return events;
    },
    snapshot: async (effect, ports, ctx) => {
      const events = await createSnapshot({ ...deps, pathHashes: (cwd, ports, runDir) => pathHashes({ ...deps, cwd }, ports, runDir, ctx.ownedArtifacts) })(effect, ports, ctx);
      for (const event of events) if (event.type === 'SNAPSHOT') {
        try {
          const recovery = event.fingerprint['recovery'] ? loadRecovery(ports, ctx.runDir, event.fingerprint['recovery']) : undefined;
          const prior = effect.since?.['recovery'] ? loadRecovery(ports, ctx.runDir, effect.since['recovery']) : undefined;
          const hashes = recovery?.pathHashes ?? await pathHashes(effect.cwd ? { ...deps, cwd: effect.cwd } : deps, ports, ctx.runDir, ctx.ownedArtifacts);
          const omitted = new Set(recovery?.membership ?? []);
          return [{ ...event, diff: { paths: [...new Set([...changedPaths(prior ? { pathHashes: prior.pathHashes } : null, hashes).filter((file) => !omitted.has(file)), ...(recovery?.changed?.map((row) => row.path) ?? [])])].sort() } }];
        } catch (error) {
          return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `path snapshot: ${error instanceof Error ? error.message : String(error)}` }];
        }
      }
      return events;
    },
    restore: createRestore(deps),
    'assess-recovery': createAssessRecovery(),
    handoff: createHandoff(deps),
    checkout: createCheckout({ cwd: deps.cwd, links: deps.links ?? nodeLinks }),
  };
  for (const kind of ['parse-artifact', 'check-review-target', 'check-envelope', 'assess-recovery', 'snapshot'] as const) handlers[kind]!.recovery = { repeat: 'deterministic-read' };
  handlers.checkout!.recovery = checkoutRecovery({ cwd: deps.cwd, links: deps.links ?? nodeLinks });
  handlers.restore!.recovery = restoreRecovery(deps);
  if (typeof deps.wave !== 'function') {
    const worker = { ...deps.wave, context: (effect: Parameters<WaveDeps['context']>[0]) => waveContext(effect, deps) };
    handlers.wave!.recovery = waveRecovery(worker);
    handlers['wave-start']!.recovery = waveRecovery(worker);
    handlers['wave-finish']!.recovery = waveRecovery(worker);
  }
  return handlers;
}
