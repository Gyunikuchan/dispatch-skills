import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { governedPlanText } from './domain/plan.ts';
import { governedDesignText } from './domain/design.ts';
import { governedSpecText } from './domain/spec.ts';

export type ArtifactKind = 'spec' | 'plan' | 'design';
export function artifactKind(file: string): ArtifactKind | null {
  for (const kind of ['spec', 'plan', 'design'] as const) if (file.endsWith('.' + kind + '.md')) return kind;
  return null;
}
export function artifactHash(kind: ArtifactKind, source: string): string {
  const governed = { spec: governedSpecText, plan: governedPlanText, design: governedDesignText }[kind](source);
  return 'sha256:' + crypto.createHash('sha256').update(governed).digest('hex');
}
export function readArtifact(root: string, relative: string): string | null {
  try {
    const file = path.resolve(root, relative);
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}
