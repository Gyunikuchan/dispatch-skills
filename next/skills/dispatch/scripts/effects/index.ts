// `createHandlers(deps)` → core `Handlers` for every I04 effect kind plus `wave` (I03 single-shot handler with native
// marking, or `wave-native.ts` when every roster entry carries a host capture).

import type { Effect, Handler, Handlers } from '../core/types.ts';
import type { OsId } from '../lib/platform.ts';
import type { ProviderId } from '../providers/types.ts';
import type { Git } from './git.ts';
import { createCheckEnvelope, changedPaths, pathHashes } from './check-envelope.ts';
import { createHandoff } from './handoff.ts';
import { parseArtifact } from './parse-artifact.ts';
import { createPrepareReview } from './prepare-review.ts';
import { createSnapshot } from './snapshot.ts';
import { createVerify } from './verify.ts';
import { createWaveHandler, type SlotPaths, type WaveContext, type WaveDeps } from './wave.ts';
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
};

const reviewOf = (roster: readonly Row[]): WaveContext['review'] => {
  const value = roster[0]?.['review'];
  return value === 'plan' || value === 'design' || value === 'ask' ? value : 'code';
};

/** Wave context from the roster: each slot's `promptPath` (copied from `REVIEW_PREPARED`) and a log beside it. */
export function waveContext(effect: WaveEffect, deps: Pick<HandlerDeps, 'cwd' | 'orchestratorPlatform'>): WaveContext {
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
  return {
    'parse-artifact': parseArtifact,
    'prepare-review': createPrepareReview(deps),
    wave,
    verify: createVerify(deps),
    'check-envelope': createCheckEnvelope(deps),
    'write-brief': createWriteBrief(deps),
    snapshot: async (effect, ports, ctx) => {
      const events = await createSnapshot(deps)(effect, ports, ctx);
      for (const event of events) if (event.type === 'SNAPSHOT') {
        try {
          const hashes = await pathHashes(deps, ports);
          return [{ ...event, fingerprint: { ...event.fingerprint, pathHashes: hashes }, diff: { paths: changedPaths(effect.since, hashes) } }];
        } catch (error) {
          return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `path snapshot: ${error instanceof Error ? error.message : String(error)}` }];
        }
      }
      return events;
    },
    handoff: createHandoff(deps),
  };
}
