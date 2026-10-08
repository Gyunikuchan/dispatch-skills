import crypto from 'node:crypto';
import path from 'node:path';
import type { Ports, RecoveryRef, RecoveryManifest } from '../core/types.ts';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const safe = (file: string) => !!file && !file.includes('\\') && !file.includes('\0') && !file.startsWith('/') && !/^[A-Za-z]:/.test(file) && !file.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'));
export function isRecoveryRef(value: unknown): value is RecoveryRef {
  return record(value) && value['version'] === 1 && typeof value['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(value['sha256'])
    && Number.isSafeInteger(value['bytes']) && Number(value['bytes']) > 0 && value['path'] === `recovery-manifests/${value['sha256']}.json`;
}
export function artifactPath(ports: Ports, runDir: string, relative: string): string {
  if (!safe(relative)) throw new Error('Invalid recovery artifact path.');
  const root = ports.fs.inspectPath(runDir);
  if (root?.kind !== 'directory' || !root.realPath) throw new Error('Invalid recovery run directory.');
  let current = runDir;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = ports.fs.inspectPath(current);
    if (info?.kind === 'symlink' || info?.realPath && (path.relative(root.realPath, info.realPath).startsWith('..') || path.isAbsolute(path.relative(root.realPath, info.realPath)))) throw new Error('Recovery artifact path escape.');
  }
  return current;
}
export function publishEvidence(ports: Ports, runDir: string, value: unknown, directory = 'recovery-deltas'): RecoveryRef {
  const text = JSON.stringify(canonical(value)), sha256 = digest(text), relative = `${directory}/${sha256}.json`;
  const file = artifactPath(ports, runDir, relative);
  ports.fs.mkdir(path.dirname(file), { recursive: true });
  artifactPath(ports, runDir, relative);
  ports.fs.publishExclusive(file, text);
  if (ports.fs.inspectPath(file)?.kind !== 'file' || ports.fs.readText(file) !== text) throw new Error('Immutable recovery artifact mismatch.');
  return { version: 1, sha256, bytes: Buffer.byteLength(text), path: relative };
}
export function publishRecovery(ports: Ports, runDir: string, snapshot: RecoveryManifest): RecoveryRef {
  for (const hash of new Set(Object.values(snapshot.contents).filter((value): value is string => value !== null))) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid recovery blob digest.');
    const blob = artifactPath(ports, runDir, `recovery-contents/${hash}`);
    if (ports.fs.inspectPath(blob)?.kind !== 'file' || ports.fs.hashFile(blob) !== hash) throw new Error('Recovery blob is not durably published.');
  }
  const ref = publishEvidence(ports, runDir, { version: 1, ...snapshot }, 'recovery-manifests');
  loadRecovery(ports, runDir, ref);
  return ref;
}
export function loadRecovery(ports: Ports, runDir: string, ref: unknown): RecoveryManifest {
  if (!isRecoveryRef(ref)) throw new Error('Invalid recovery reference.');
  const file = artifactPath(ports, runDir, ref.path);
  if (ports.fs.inspectPath(file)?.kind !== 'file' || ports.fs.size(file) !== ref.bytes) throw new Error('Missing or invalid recovery manifest.');
  const text = ports.fs.readText(file);
  if (digest(text) !== ref.sha256) throw new Error('Corrupt recovery manifest.');
  const value: unknown = JSON.parse(text);
  if (!record(value) || value['version'] !== 1 || typeof value['repoRoot'] !== 'string' || value['contentStore'] !== 'recovery-contents'
    || 'ignored' in value || !record(value['contents']) || !record(value['entries']) || !record(value['git'])
    || !['taskStartFiles', 'callerDirty', 'verifiedManifestDirs', 'hashManifestDirs', 'changed'].every((key) => Array.isArray(value[key]))
    || !Object.values(value['contents']).every((v) => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) throw new Error('Invalid recovery manifest schema.');
  const contents = value['contents'], entries = value['entries'];
  if (Object.keys(contents).length !== Object.keys(entries).length || Object.keys(contents).some((file) => !safe(file) || !Object.hasOwn(entries, file))) throw new Error('Invalid recovery manifest path bindings.');
  for (const [file, entry] of Object.entries(entries)) {
    if (entry === null) { if (contents[file] !== null) throw new Error('Invalid missing recovery entry.'); continue; }
    if (!record(entry) || !Number.isInteger(entry['mode']) || Number(entry['mode']) < 0 || Number(entry['mode']) > 0o7777
      || !['file', 'symlink'].includes(String(entry['kind'])) || (entry['kind'] === 'file' ? entry['linkTarget'] !== null || typeof contents[file] !== 'string'
        : contents[file] !== null || typeof entry['linkTarget'] !== 'string' || Buffer.from(entry['linkTarget'], 'base64').toString('base64') !== entry['linkTarget'])) throw new Error('Invalid recovery entry metadata.');
  }
  if (!['head', 'index', 'stash', 'gitDir'].every((key) => typeof (value['git'] as Record<string, unknown>)[key] === 'string')
    || !['taskStartFiles', 'callerDirty', 'verifiedManifestDirs', 'hashManifestDirs'].every((key) => (value[key] as unknown[]).every((item) => typeof item === 'string'))
    || !(value['changed'] as unknown[]).every((item) => record(item) && typeof item['path'] === 'string' && safe(item['path']) && typeof item['deleted'] === 'boolean' && typeof item['outsideRepo'] === 'boolean'
      && Number.isSafeInteger(item['added']) && Number(item['added']) >= 0 && Number.isSafeInteger(item['removed']) && Number(item['removed']) >= 0)) throw new Error('Invalid recovery manifest summaries.');
  if (['membership', 'tracked'].some((key) => value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((file) => typeof file === 'string' && safe(file))))
    || value['ignoreRules'] !== undefined && typeof value['ignoreRules'] !== 'string'
    || value['pathHashes'] !== undefined && (!record(value['pathHashes']) || !Object.entries(value['pathHashes']).every(([file, hash]) => safe(file) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))) throw new Error('Invalid recovery observation metadata.');
  return value as RecoveryManifest;
}
