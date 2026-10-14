import path from 'node:path';
import type { Ports } from '../core/types.ts';
const safe = (file: string) => !!file && !file.includes('\\') && !file.includes('\0') && !file.startsWith('/') && !/^[A-Za-z]:/.test(file) && !file.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'));
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
