import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const paths = [
  "oxlint.config.ts",
  "oxfmt.config.ts",
  "skills/dispatch/scripts",
  "scripts",
  "tests",
  ".agents/skills/optimise-tests/scripts",
  ".agents/skills/link-reader/scripts",
];

const root = fileURLToPath(new URL("../", import.meta.url));

const resolveOxlint = () => {
  // Walk ancestors so git worktrees without a local node_modules resolve the main checkout binary.
  for (let dir = root; ;) {
    const candidate = path.join(dir, "node_modules", "oxlint", "bin", "oxlint");

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return path.join(root, "node_modules", "oxlint", "bin", "oxlint");
    }

    dir = parent;
  }
};

const result = spawnSync(process.execPath, [resolveOxlint(), ...paths], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
