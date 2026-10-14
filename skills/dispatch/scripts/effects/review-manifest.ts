import crypto from 'node:crypto';
import path from 'node:path';
import type { JournalLine, Ports, ReviewManifestRef } from '../core/types.ts';
import { EngineFault } from '../domain/engine-fault.ts';
import { stableValue } from '../domain/stable-value.ts';
import { artifactPath } from '../lib/immutable-artifact.ts';
import { effectSessionRoot } from '../lib/portable-effect.ts';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new EngineFault('checkpoint-invalid: immutable review manifest binding'); }
const resolve = (file: string, runDir: string) => path.resolve(file.replace('@session', effectSessionRoot(runDir) ?? '@session'));
function destination(ports: Ports, runDir: string, file: string): string {
  return artifactPath(ports, runDir, path.relative(runDir, resolve(file, runDir)).split(path.sep).join('/'));
}
export function reviewManifestRef(ports: Ports, runDir: string, file: string): ReviewManifestRef {
  const target = destination(ports, runDir, file);
  if (ports.fs.inspectPath(target)?.kind !== 'file') invalid();
  return { kind: 'review-manifest', version: 1, path: file, sha256: ports.fs.hashFile(target), bytes: ports.fs.size(target) };
}
export function readReviewManifest(ports: Ports, runDir: string, file: string, reference: unknown): string {
  if (!record(reference) || reference['kind'] !== 'review-manifest' || reference['version'] !== 1 || typeof reference['path'] !== 'string'
    || resolve(reference['path'], runDir) !== resolve(file, runDir) || typeof reference['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(reference['sha256'])
    || !Number.isSafeInteger(reference['bytes']) || Number(reference['bytes']) < 1) invalid();
  const target = destination(ports, runDir, file);
  if (ports.fs.inspectPath(target)?.kind !== 'file' || ports.fs.size(target) !== reference['bytes'] || ports.fs.hashFile(target) !== reference['sha256']) invalid();
  return ports.fs.readText(target);
}
export function publishReviewManifest(ports: Ports, runDir: string, file: string, value: unknown): ReviewManifestRef {
  ports.fs.mkdir(runDir, { recursive: true });
  const target = destination(ports, runDir, file), text = JSON.stringify(value);
  if (!ports.fs.publishExclusive(target, text) && ports.fs.readText(target) !== text) invalid();
  return reviewManifestRef(ports, runDir, file);
}

/** Explicit rebind authenticates legacy semantic identities before adding byte metadata. */
export function migrateReviewReferences<T>(value: T, ports: Ports, runDir: string, records: readonly JournalLine[]): T {
  const identities = new Map<string, string>();
  for (const line of records) if (line.type === 'REVIEW_TARGET_CHECKED' && record(line.data['notice'])) {
    const notice = line.data['notice'];
    if (typeof line.data['manifestPath'] === 'string' && typeof notice['afterHash'] === 'string') identities.set(resolve(line.data['manifestPath'], runDir), notice['afterHash']);
    const started = records.findLast(row => row.seq < line.seq && row.type === 'EFFECT_STARTED' && row.data['effectId'] === line.data['effectId'] && row.checkpoint);
    if (started?.checkpoint && typeof notice['beforeHash'] === 'string') {
      const blob = ports.fs.readText(artifactPath(ports, runDir, started.checkpoint.path));
      if (hash(blob) !== started.checkpoint.sha256 || Buffer.byteLength(blob) !== started.checkpoint.bytes) invalid();
      const saved = JSON.parse(blob);
      const effect = Array.isArray(saved.queue) ? saved.queue.find((item: unknown) => record(item) && item['id'] === line.data['effectId']) : undefined;
      if (record(effect) && typeof effect['manifestPath'] === 'string') identities.set(resolve(effect['manifestPath'], runDir), notice['beforeHash']);
    }
  }
  const authenticating = new Set<string>();
  const authenticate = (file: string): unknown => {
    const identityPath = resolve(file, runDir);
    if (authenticating.has(identityPath)) invalid();
    authenticating.add(identityPath);
    const target = destination(ports, runDir, file);
    if (ports.fs.inspectPath(target)?.kind !== 'file') invalid();
    const parsed: unknown = JSON.parse(ports.fs.readText(target));
    const identity = identities.get(resolve(file, runDir));
    if (identity && hash(stableValue(parsed)) === identity) { authenticating.delete(identityPath); return parsed; }
    const prepared = records.find(row => row.type === 'REVIEW_PREPARED' && record(row.data['scope']) && typeof row.data['scope']['manifestPath'] === 'string'
      && resolve(row.data['scope']['manifestPath'], runDir) === resolve(file, runDir));
    const binding = prepared && record(prepared.data['scope']) ? prepared.data['scope']['bindingPath'] : undefined;
    if (typeof binding !== 'string' || !identities.has(resolve(binding, runDir))) invalid();
    const source = authenticate(binding);
    if (!record(source) || stableValue(parsed) !== stableValue(Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'changeSet' && key !== 'changeBaseline')))) invalid();
    authenticating.delete(identityPath);
    return parsed;
  };
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (!record(item)) return item;
    const next = Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
    for (const key of ['priorManifest', 'targetManifest', 'fixCandidate', 'manifestPath'] as const) if (typeof item[key] === 'string' && (key !== 'manifestPath' || item['kind'] === 'check-review-target')) {
      const refKey = key === 'manifestPath' ? 'manifestRef' : `${key}Ref`;
      if (item[refKey] !== undefined) { readReviewManifest(ports, runDir, item[key], item[refKey]); continue; }
      authenticate(item[key]);
      next[refKey] = reviewManifestRef(ports, runDir, item[key]);
    }
    return next;
  };
  return walk(value) as T;
}
