import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolingRoot } from './check-terms.ts';
import { checkIntegrity, generateSkillHashes, MANIFEST_NAME } from '../skills/dispatch/scripts/lib/integrity.ts';
export function hashes(root: string, check = false): string[] {
  const skill = path.resolve(root, 'skills/dispatch');
  if (check) { const result = checkIntegrity(skill); return result.status === 'ok' ? [] : result.status === 'drift' ? result.violations.map((file) => `${skill}/${file}: hash drift`) : [result.warning]; }
  fs.writeFileSync(path.join(skill, MANIFEST_NAME), `${JSON.stringify({ ...packageVersion(root), ...generateSkillHashes(skill) }, null, 2)}\n`); return [];
}
/** `$version` from the repository package.json; omitted when it is absent or unreadable. */
function packageVersion(root: string): { $version?: string } {
  try {
    const version: unknown = (JSON.parse(fs.readFileSync(path.resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>)['version'];
    return typeof version === 'string' ? { $version: version } : {};
  } catch { return {}; }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), errors = hashes(toolingRoot(args), args.includes('--check'));
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\n`); process.exitCode = 1; }
}
