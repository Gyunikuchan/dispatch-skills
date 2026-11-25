import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolingRoot } from './check-terms.ts';
import {
  checkIntegrity,
  generateSkillHashes,
  hashSkillFile,
  MANIFEST_NAME,
} from '../skills/dispatch/scripts/lib/integrity.ts';
const DIAGNOSTIC_TYPES = 'scripts/toolkit/domain/diagnostics-types.ts';
const COMPONENT_REGION =
  /( {2}\/\/ BEGIN GENERATED: diagnostic components)(\r?\n)[\s\S]*?( {2}\/\/ END GENERATED: diagnostic components)/;

function refreshComponents(skill: string, entries: Record<string, string>): void {
  if (!Object.hasOwn(entries, DIAGNOSTIC_TYPES)) {
    return;
  }
  const file = path.join(skill, DIAGNOSTIC_TYPES);
  const source = fs.readFileSync(file, 'utf8');
  if (!COMPONENT_REGION.test(source)) {
    throw new Error(`Missing generated diagnostic component markers in ${file}`);
  }

  const groups = new Map<string, { directory: string; extension: string; names: Array<string> }>();
  const standalone: Array<string> = [];
  for (const relative of Object.keys(entries)) {
    const directory = path.posix.dirname(relative);
    const extension = path.posix.extname(relative);
    if (directory === '.') {
      standalone.push(relative);
      continue;
    }
    const key = `${directory}:${extension}`;
    const group = groups.get(key) ?? { directory, extension, names: [] };
    group.names.push(path.posix.basename(relative, extension));
    groups.set(key, group);
  }
  const lines = standalone.map((relative) => `  ${JSON.stringify(relative)},`);
  for (const { directory, extension, names } of groups.values()) {
    if (names.length === 1) {
      lines.push(`  ${JSON.stringify(`${directory}/${names[0]}${extension}`)},`);
    } else {
      lines.push(`  ...files(${JSON.stringify(directory)}, ${JSON.stringify(names)}, ${JSON.stringify(extension)}),`);
    }
  }
  const generated = source.replace(COMPONENT_REGION, (_match, start: string, eol: string, end: string) =>
    [start, ...lines, end].join(eol),
  );
  if (generated !== source) {
    fs.writeFileSync(file, generated);
    entries[DIAGNOSTIC_TYPES] = hashSkillFile(file);
  }
}

export function hashes(root: string, check = false): Array<string> {
  const skill = path.resolve(root, 'skills/dispatch');
  if (check) {
    const result = checkIntegrity(skill);
    return result.status === 'ok'
      ? []
      : result.status === 'drift'
        ? result.violations.map((file) => `${skill}/${file}: hash drift`)
        : [result.warning];
  }
  const entries = generateSkillHashes(skill);
  refreshComponents(skill, entries);
  fs.writeFileSync(
    path.join(skill, MANIFEST_NAME),
    `${JSON.stringify({ ...packageVersion(root), ...entries }, null, 2)}\n`,
  );
  return [];
}
interface PackageVersion {
  $version?: string;
}
/** `$version` from the repository package.json; omitted when it is absent or unreadable. */
function packageVersion(root: string): PackageVersion {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.resolve(root, 'package.json'), 'utf8'));
    const version =
      typeof manifest === 'object' && manifest !== null && 'version' in manifest ? manifest.version : null;
    return typeof version === 'string' ? { $version: version } : {};
  } catch {
    return {};
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2),
    errors = hashes(toolingRoot(args), args.includes('--check'));
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  }
}
