import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  checkIntegrity,
  generateSkillHashes,
  hashSkillFile,
  MANIFEST_NAME,
} from "../skills/dispatch/scripts/lib/integrity.ts";
import { toolingRoot } from "./check-terms.ts";

const DIAGNOSTIC_TYPES = "scripts/toolkit/domain/diagnostics-types.ts";

const COMPONENT_REGION =
  /(?<start> {2}\/\/ BEGIN GENERATED: diagnostic components)(?<eol>\r?\n)[\s\S]*?(?<end> {2}\/\/ END GENERATED: diagnostic components)/u;

const refreshComponents = (skill: string, entries: Record<string, string>) => {
  if (!Object.hasOwn(entries, DIAGNOSTIC_TYPES)) {
    return;
  }

  const file = path.join(skill, DIAGNOSTIC_TYPES);
  const source = fs.readFileSync(file, "utf-8");

  if (!COMPONENT_REGION.test(source)) {
    throw new Error(
      `Missing generated diagnostic component markers in ${file}`
    );
  }

  const groups = new Map<
    string,
    { directory: string; extension: string; names: string[] }
  >();

  const standalone: string[] = [];

  for (const relative of Object.keys(entries)) {
    const directory = path.posix.dirname(relative);
    const extension = path.posix.extname(relative);

    if (directory === ".") {
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
      lines.push(
        `  ${JSON.stringify(`${directory}/${names[0]}${extension}`)},`
      );
    } else {
      lines.push(
        `  ...files(${JSON.stringify(directory)}, ${JSON.stringify(names)}, ${JSON.stringify(extension)}),`
      );
    }
  }

  const generated = source.replace(
    COMPONENT_REGION,
    (_match, start: string, eol: string, end: string) =>
      [start, ...lines, end].join(eol)
  );

  if (generated !== source) {
    fs.writeFileSync(file, generated);
    entries[DIAGNOSTIC_TYPES] = hashSkillFile(file);
  }
};

const packageVersion = (root: string) => {
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.resolve(root, "package.json"), "utf-8")
    );

    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : null;

    return typeof version === "string" ? { $version: version } : {};
  } catch {
    return {};
  }
};

export const hashes = (root: string, check = false) => {
  const skill = path.resolve(root, "skills/dispatch");

  if (check) {
    const result = checkIntegrity(skill);

    if (result.status === "ok") {
      return [];
    }

    if (result.status === "drift" && "violations" in result) {
      return result.violations.map((file) => `${skill}/${file}: hash drift`);
    }

    return [result.warning];
  }

  const entries = generateSkillHashes(skill);
  refreshComponents(skill, entries);
  fs.writeFileSync(
    path.join(skill, MANIFEST_NAME),
    `${JSON.stringify({ ...packageVersion(root), ...entries }, null, 2)}\n`
  );

  return [];
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  const errors = hashes(toolingRoot(args), args.includes("--check"));

  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
