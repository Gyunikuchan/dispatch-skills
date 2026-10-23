import path from 'node:path';
import { artifactHash, artifactKind, readArtifact } from './artifacts.ts';
import { parsePlan } from './domain/plan.ts';
import { parseDesign } from './domain/design.ts';
import { parseSpec } from './domain/spec.ts';
import { ToolError } from './output.ts';

export function lintArtifact(file: string) {
  const kind = artifactKind(file);
  if (!kind) throw new ToolError(1, 'invalid-input', 'artifact must end in .spec.md, .plan.md or .design.md');
  const source = readArtifact(path.dirname(file), path.basename(file));
  if (source === null) throw new ToolError(1, 'invalid-input', 'artifact is missing or unreadable: ' + file);
  const result = kind === 'plan' ? parsePlan(source) : kind === 'design' ? parseDesign(source) : parseSpec(source, { level: 'medium' });
  const parsed = result.ok ? ('plan' in result ? result.plan : 'design' in result ? result.design : result.spec) : null;
  return { kind, hash: artifactHash(kind, source), errors: result.ok ? [] : result.defects, warnings: result.warnings, parsed };
}
