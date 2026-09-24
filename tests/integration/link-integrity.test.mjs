import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Single source of truth: the audit's baseline scanner. Keeping a second copy here is how the
// two quietly diverged (the audit's missed directory targets and same-file anchors).
import { authoredSkillDirs, brokenLinks } from "../../.agents/skills/audit-dispatch-skills/scripts/baseline.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Scans this repo's authored markdown for relative links that resolve to nothing —
 * a missing file/directory, or an `#anchor` that names no heading in the target
 * (or current) file. `http(s):`/`mailto:` links and anything inside fenced code
 * blocks are skipped (code fences routinely show example/placeholder link syntax
 * that isn't meant to resolve).
 */

const SCAN_FILES = [
  path.join(REPO_ROOT, "README.md"),
  path.join(REPO_ROOT, "AGENTS.md"),
];

// `skills/**/*.md` and every repo-authored `.agents/skills/*/**/*.md`
function walkMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdown(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

SCAN_FILES.push(...walkMarkdown(path.join(REPO_ROOT, "skills")));
// Derived, not hardcoded: naming one skill here is what let a second `.agents` skill escape the
// guard entirely while this file still claimed the baseline scanner as its single source of truth.
SCAN_FILES.push(...authoredSkillDirs(REPO_ROOT).flatMap(walkMarkdown));

describe("link integrity guard (authored markdown)", () => {
  it("resolves every relative link and anchor in authored markdown", () => {
    const offenders = SCAN_FILES.filter((f) => existsSync(f)).flatMap((file) =>
      brokenLinks(file).map(
        (p) =>
          `${path.relative(REPO_ROOT, file).split(path.sep).join("/")}:L${p.line} → ${p.target} (${p.reason})`,
      ),
    );
    assert.deepEqual(offenders, []);
  });
});

describe("alias documentation links", () => {
  it("routes every alias catalog entry to the central dispatch manual", () => {
    const rootReadme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    for (const name of [
      "dispatch-plan-review",
      "dispatch-code-review",
      "dispatch-design-review",
      "dispatch-implement",
    ]) {
      assert.ok(rootReadme.includes("[`" + name + "`](skills/dispatch/README.md)"));
      assert.equal(existsSync(path.join(REPO_ROOT, "skills", name, "README.md")), false);
    }
  });
});
