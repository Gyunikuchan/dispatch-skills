// `createHandlers(deps)` → core `Handlers` for every effect kind plus `wave` (single-shot handler with native
// marking, or `wave-native.ts` when every roster entry carries a host capture).

import type { Effect, Handler, Handlers } from '../core/types.ts';
import path from 'node:path';
import type { OsId } from '../lib/platform.ts';
import type { ProviderId } from '../providers/types.ts';
import type { Git } from './git.ts';
import { createCheckEnvelope, changedPaths, pathHashes } from './check-envelope.ts';
import { createHandoff } from './handoff.ts';
import { parseArtifact } from './parse-artifact.ts';
import { createPrepareReview } from './prepare-review.ts';
import { createSnapshot } from './snapshot.ts';
import { createRestore } from './restore.ts';
import { createVerify } from './verify.ts';
import { createWaveStartHandler, createWaveFinishHandler, createWaveHandler, type SlotPaths, type WaveContext, type WaveDeps } from './wave.ts';
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
};

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
  return {
    'parse-artifact': parseArtifact,
    'prepare-review': createPrepareReview(deps),
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
      const eventPath = path.join(ctx.runDir, `${effect.id}.self-check.event.json`);
      ports.fs.writeAtomic(eventPath, `${JSON.stringify({ type: 'WRITE_ENVELOPE', envelopePath: path.join(ctx.runDir, `${effect.id}.outcome.json`) })}\n`);
      return createWriteBrief(deps)({ ...effect, input: { ...effect.input, selfCheck: deps.selfCheckCommand(ctx.runDir, eventPath) } }, ports, ctx);
    },
    snapshot: async (effect, ports, ctx) => {
      const events = await createSnapshot(deps)(effect, ports, ctx);
      for (const event of events) if (event.type === 'SNAPSHOT') {
        try {
          const hashes = await pathHashes(deps, ports);
          const recovery = event.fingerprint['recovery'] as { changed?: { path: string }[] } | undefined;
          return [{ ...event, fingerprint: { ...event.fingerprint, pathHashes: hashes }, diff: { paths: [...new Set([...changedPaths(effect.since, hashes), ...(recovery?.changed?.map((row) => row.path) ?? [])])].sort() } }];
        } catch (error) {
          return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `path snapshot: ${error instanceof Error ? error.message : String(error)}` }];
        }
      }
      return events;
    },
    restore: createRestore(deps),
    handoff: createHandoff(deps),
  };
}
