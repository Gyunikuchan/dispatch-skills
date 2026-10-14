import path from 'node:path';
import crypto from 'node:crypto';
import { EngineFault } from './journal.ts';
import type { Effect, Handler, Handlers, Ports, RecoveryProbe, ResultEvent } from './types.ts';
import { effectDigest } from '../domain/effect-digest.ts';
import { portableEffect, effectSessionRoot as sessionRoot } from '../lib/portable-effect.ts';
import { artifactPath } from '../lib/immutable-artifact.ts';
import { storeSessionPaths, restoreSessionPaths } from '../lib/session.ts';

export const descriptorHash = (effect: Effect, runDir?: string): string => effectDigest(portableEffect(effect, runDir));
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const receiptPath = (effect: Effect, attempt: number, runDir: string) => `effect-results/${descriptorHash(effect, runDir)}.a${attempt}.json`;

/** Seal actual handler output before its journal publication, so a later engine fault needs no relaunch. */
export function publishEffectResult(effect: Effect, attempt: number, results: readonly ResultEvent[], ports: Ports, runDir: string): void {
  const root = sessionRoot(runDir);
  const text = JSON.stringify({ effectId: effect.id, attempt, descriptorHash: descriptorHash(effect, runDir), results: root ? storeSessionPaths(results, root) : results });
  const file = artifactPath(ports, runDir, receiptPath(effect, attempt, runDir));
  const sidecar = artifactPath(ports, runDir, `${receiptPath(effect, attempt, runDir)}.sha256`);
  ports.fs.mkdir(path.dirname(file), { recursive: true });
  if (!ports.fs.publishExclusive(file, text) && ports.fs.readText(file) !== text) throw new EngineFault('effect-recovery: immutable result collision');
  if (!ports.fs.publishExclusive(sidecar, digest(text)) && ports.fs.readText(sidecar) !== digest(text)) throw new EngineFault('effect-recovery: immutable result digest collision');
}

export function assertRecoveredResults(effect: Effect, results: readonly ResultEvent[], terminal: string): void {
  const last = results.at(-1);
  if (!last || results.some((result) => result.effectId !== effect.id) || results.filter((result) => result.type === terminal || result.type === 'EFFECT_FAILED').length !== 1 || last.type !== terminal && last.type !== 'EFFECT_FAILED') throw new EngineFault('effect-recovery: result identity or terminal mismatch');
}

export async function probeEffect(effect: Effect, attempt: number, handlers: Handlers, ports: Ports, runDir: string): Promise<RecoveryProbe | { status: 'repeat' }> {
  const file = artifactPath(ports, runDir, receiptPath(effect, attempt, runDir));
  if (ports.fs.exists(file)) {
    const sidecar = artifactPath(ports, runDir, `${receiptPath(effect, attempt, runDir)}.sha256`);
    const text = ports.fs.readText(file);
    if (ports.fs.inspectPath(file)?.kind !== 'file' || ports.fs.inspectPath(sidecar)?.kind !== 'file' || ports.fs.readText(sidecar) !== digest(text)) throw new EngineFault('effect-recovery: corrupt completion evidence');
    const proof = JSON.parse(text) as Extract<RecoveryProbe, { status: 'complete' }>;
    if (proof.effectId !== effect.id || proof.attempt !== attempt || proof.descriptorHash !== descriptorHash(effect, runDir) || !Array.isArray(proof.results)) throw new EngineFault('effect-recovery: completion identity mismatch');
    const root = sessionRoot(runDir);
    return { ...proof, ...(root ? { results: restoreSessionPaths(proof.results, root) } : {}), status: 'complete', evidence: receiptPath(effect, attempt, runDir) };
  }
  const handler = handlers[effect.kind] as Handler | undefined;
  const proof = await handler?.recovery?.probe?.(effect, ports, { runDir, attempt });
  if (proof && proof.status !== 'unresolved') {
    if (proof.effectId !== effect.id || proof.attempt !== attempt || proof.descriptorHash !== descriptorHash(effect, runDir) || (proof.status === 'complete' ? !proof.evidence : !proof.handle || typeof proof.resume !== 'function')) throw new EngineFault('effect-recovery: probe identity mismatch');
    return proof;
  }
  if (handler?.recovery?.repeat === 'deterministic-read') return { status: 'repeat' };
  return proof ?? { status: 'unresolved', evidence: 'No matching terminal record, stable completion proof, or live handle' };
}
