import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadConfig,
  validateConfig,
} from "../skills/dispatch/scripts/lib/config.ts";
import { toolingRoot } from "./check-terms.ts";

export const validateConfigs = (root: string) => {
  const skill = path.resolve(root, "skills/dispatch");
  const file = path.join(skill, "config.sample.jsonc");

  try {
    const loaded = loadConfig(skill, (candidate) =>
      candidate.endsWith("config.local.jsonc")
        ? fs.readFileSync(file, "utf-8")
        : null
    );

    return validateConfig(loaded.config).map((error) => `${file}: ${error}`);
  } catch (error) {
    return [`${file}: ${String(error)}`];
  }
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const errors = validateConfigs(toolingRoot(process.argv.slice(2)));

  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
