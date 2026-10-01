import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler, RecoverySnapshot, Ports, FileEntry } from '../core/types.ts';
import { snapshotContent } from './snapshot.ts';

type RestoreEffect = Extract<Effect, { kind: 'restore' }>;
export type RestoreDeps = { cwd: string };
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const base64 = (value: unknown): value is string => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
function validEntry(entry: unknown, content: unknown): boolean {
  if (entry === null) return content === null;
  if (typeof entry !== 'object' || entry === null) return false;
  const value = entry as FileEntry;
  return Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777 && (value.kind === 'file' ? base64(content) && value.linkTarget === null : value.kind === 'symlink' && content === null && base64(value.linkTarget));
}
const safePath = (file: string) => !!file && !file.includes('\\') && !file.startsWith('/') && !/^[A-Za-z]:/.test(file)
  && !/[\x00-\x1f]/.test(file) && !file.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':') || part.endsWith('.') || part.endsWith(' ')) && !file.split('/').some((part) => part.toLowerCase() === '.git');
function checkAncestors(cwd: string, file: string, ports: Ports): void {
  const root = ports.fs.inspectPath(cwd)?.realPath ?? path.resolve(cwd);
  let current = path.resolve(cwd);
  for (const part of file.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const info = ports.fs.inspectPath(current);
    if (!info) continue;
    if (info.kind !== 'directory' || !info.realPath || path.relative(root, info.realPath).startsWith('..') || path.isAbsolute(path.relative(root, info.realPath))) throw new Error(`Restore ancestor escape: ${file}`);
  }
}

/** The published patch is an immutable target, never regenerated from a partially restored tree. */
export function createRestore(deps: RestoreDeps): Handler<RestoreEffect> {
  return async (effect, ports, ctx) => {
    try {
      if (!effect.paths.every(safePath) || new Set(effect.paths).size !== effect.paths.length) throw new Error('Invalid restore paths.');
      const raw = effect.to['recovery'];
      const snapshot = typeof raw === 'object' && raw !== null && 'contents' in raw ? raw as RecoverySnapshot : null;
      if (!snapshot) throw new Error('Missing immutable pre-attempt contents.');
      if (typeof snapshot.contents !== 'object' || snapshot.contents === null || Object.values(snapshot.contents).some((value) => value !== null && (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)))) throw new Error('Invalid immutable contents.');
      const paths = [...effect.paths].sort();
      if (paths.some((file) => !Object.hasOwn(snapshot.contents, file) || !Object.hasOwn(snapshot.entries, file))) throw new Error('Restore target lacks a path binding.');
      for (const file of paths) checkAncestors(deps.cwd, file, ports);
      const binding = digest(JSON.stringify({ paths, to: effect.to }));
      const patchPath = path.join(ctx.runDir, `${effect.id.replace(/[^A-Za-z0-9_-]/g, '_')}.restore.json`);
      const sidecar = `${patchPath}.sha256`;
      const target = Object.fromEntries(paths.map((file) => [file, { content: snapshotContent(snapshot, file, ports, ctx.runDir), entry: snapshot.entries[file] }]));
      if (!ports.fs.exists(patchPath)) {
        if (ports.fs.exists(sidecar)) throw new Error('Restore sidecar without patch.');
        const failed = Object.fromEntries(paths.map((file) => {
          const absolute = path.resolve(deps.cwd, file), info = ports.fs.inspectPath(absolute);
          if (info?.kind === 'directory') throw new Error(`Restore refuses directory replacement: ${file}`);
          return [file, { content: info?.kind === 'file' ? ports.fs.readBase64(absolute) : null, entry: info ? { kind: info.kind, mode: info.mode, linkTarget: info.linkTarget } : null }];
        }));
        const original = JSON.stringify({ version: 1, effectId: effect.id, binding, target, failed });
        ports.fs.writeAtomic(patchPath, original);
        ports.fs.writeAtomic(sidecar, digest(original));
      }
      const original = ports.fs.readText(patchPath);
      const parsed = JSON.parse(original) as Record<string, unknown>;
      if (parsed['version'] !== 1 || parsed['effectId'] !== effect.id || parsed['binding'] !== binding || JSON.stringify(parsed['target']) !== JSON.stringify(target)) throw new Error('Restore patch binding mismatch.');
      if (typeof parsed['failed'] !== 'object' || parsed['failed'] === null || Object.keys(parsed['failed']).sort().join('\0') !== paths.join('\0')) throw new Error('Restore patch lacks failed-attempt binding.');
      const failures = parsed['failed'] as Record<string, unknown>;
      for (const file of paths) {
        const raw = failures[file];
        if (typeof raw !== 'object' || raw === null || !('content' in raw) || !('entry' in raw)) throw new Error('Invalid failed-attempt payload.');
        const value = raw as { content: unknown; entry: unknown };
        if (value.content !== null && (typeof value.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content))) throw new Error('Invalid failed-attempt bytes.');
        if (!validEntry(value.entry, value.content)) throw new Error('Invalid failed-attempt file metadata.');
      }
      for (const file of paths) {
        const entry = target[file]?.entry;
        if (!validEntry(entry, target[file]?.content)) throw new Error('Invalid restore entry.');
      }
      if (!ports.fs.exists(sidecar)) {
        const failed = parsed['failed'] as Record<string, { content?: unknown; entry?: FileEntry | null }>;
        for (const file of paths) {
          const saved = failed[file], info = ports.fs.inspectPath(path.resolve(deps.cwd, file));
          const entry = info ? { kind: info.kind, mode: info.mode, linkTarget: info.linkTarget } : null;
          if (!saved || JSON.stringify(saved.entry) !== JSON.stringify(entry) || saved.content !== (info?.kind === 'file' ? ports.fs.readBase64(path.resolve(deps.cwd, file)) : null)) throw new Error('Unsealed patch failed-attempt contents do not match the untouched tree.');
        }
        ports.fs.writeAtomic(sidecar, digest(original));
      }
      if (ports.fs.readText(sidecar) !== digest(original)) throw new Error('Restore patch sidecar verification failed.');
      // Verify every binding before mutating any path; a crash then safely repeats the same target.
      for (const file of paths) {
        const content = target[file]?.content, entry = target[file]?.entry;
        const absolute = path.resolve(deps.cwd, file);
        checkAncestors(deps.cwd, file, ports);
        const current = ports.fs.inspectPath(absolute);
        if (current?.kind === 'directory') throw new Error(`Restore refuses directory replacement: ${file}`);
        if (entry === null) { if (current) ports.fs.remove(absolute); }
        else if (entry?.kind === 'symlink') {
          ports.fs.mkdir(path.dirname(absolute), { recursive: true });
          if (current?.kind !== 'symlink' || current.linkTarget !== entry.linkTarget) {
            if (current) ports.fs.remove(absolute);
            ports.fs.writeLinkAtomic(absolute, entry.linkTarget!);
          }
        } else if (typeof content === 'string') {
          ports.fs.mkdir(path.dirname(absolute), { recursive: true });
          if (current?.kind === 'symlink') ports.fs.remove(absolute);
          if (current?.kind !== 'file' || ports.fs.readBase64(absolute) !== content) ports.fs.writeBase64Atomic(absolute, content);
          ports.fs.setMode(absolute, entry!.mode);
        } else throw new Error('Invalid restore content.');
      }
      for (const file of paths) {
        const absolute = path.resolve(deps.cwd, file);
        const info = ports.fs.inspectPath(absolute), entry = target[file]?.entry;
        if (entry === null ? info !== null : info?.kind !== entry?.kind || (entry?.kind === 'file' ? ports.fs.readBase64(absolute) !== target[file]?.content || info?.mode !== entry.mode : info?.linkTarget !== entry?.linkTarget)) throw new Error(`Restore mismatch: ${file}`);
      }
      return [{ type: 'RESTORED', effectId: effect.id, paths, patchPath }];
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'integrity', detail: error instanceof Error ? error.message : String(error) }];
    }
  };
}
