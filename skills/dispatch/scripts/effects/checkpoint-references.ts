import crypto from 'node:crypto';
import { EngineFault } from '../domain/engine-fault.ts';
import type { Ports } from '../core/types.ts';
import { artifactPath } from '../lib/immutable-artifact.ts';
import { isRecoveryRef, loadRecovery } from './recovery-manifest.ts';
import { readReviewManifest } from './review-manifest.ts';
const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(detail: string): never { throw new EngineFault(`checkpoint-invalid: ${detail}`); }

export function validateReferences(value: unknown, ports: Ports, runDir: string): void {
  if (value instanceof Map || value instanceof Set) { for (const item of value.values()) validateReferences(item, ports, runDir); return; }
  if (Array.isArray(value)) { for (const item of value) validateReferences(item, ports, runDir); return; }
  if (!record(value)) return;
  for (const key of ['priorManifest', 'targetManifest', 'fixCandidate'] as const) if (typeof value[key] === 'string') readReviewManifest(ports, runDir, value[key], value[`${key}Ref`]);
  if (value['kind'] === 'check-review-target' && typeof value['manifestPath'] === 'string') readReviewManifest(ports, runDir, value['manifestPath'], value['manifestRef']);
  if (value['kind'] === 'prepare-review' && record(value['scope']) && typeof value['scope']['priorManifest'] === 'string') readReviewManifest(ports, runDir, value['scope']['priorManifest'], value['scope']['priorManifestRef']);
  if (value['kind'] === 'review-manifest' && typeof value['path'] === 'string') { readReviewManifest(ports, runDir, value['path'], value); return; }
  for (const [artifact, hashKey] of [['plan', 'planHash'], ['design', 'hash']] as const) {
    const parsed = value[artifact], hash = value[hashKey];
    if (record(parsed) && typeof parsed['governedText'] === 'string' && typeof hash === 'string' && hash !== `sha256:${sha256(parsed['governedText'])}`) fail(`immutable ${artifact} revision`);
  }
  if (typeof value['path'] === 'string' && value['path'].startsWith('recovery-manifests/')) {
    if (!isRecoveryRef(value)) fail('immutable recovery reference');
    const manifest = loadRecovery(ports, runDir, value);
    for (const hash of Object.values(manifest.contents)) if (hash !== null) {
      const blob = artifactPath(ports, runDir, `recovery-contents/${hash}`);
      if (ports.fs.inspectPath(blob)?.kind !== 'file' || ports.fs.hashFile(blob) !== hash) fail('immutable recovery content');
    }
    return;
  }
  if (typeof value['path'] === 'string' && /^(?:recovery-deltas|checkpoints)\//.test(value['path'])) {
    if (typeof value['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['sha256']) || !Number.isSafeInteger(value['bytes'])) fail('immutable evidence reference');
    const file = artifactPath(ports, runDir, value['path']);
    if (ports.fs.inspectPath(file)?.kind !== 'file' || ports.fs.size(file) !== value['bytes'] || ports.fs.hashFile(file) !== value['sha256']) fail('immutable evidence bytes');
    return;
  }
  for (const item of Object.values(value)) validateReferences(item, ports, runDir);
}
