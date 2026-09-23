import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
describe("v0.5 RED and failure disposition", () => {
  it("keeps RED admission and evidence under the implement reference", () => {
    const c = read("skills/dispatch/references/verbs/implement.md");
    assert.match(c, /tests-only write subagent/);
    assert.match(c, /matrix row per red criterion/);
    assert.match(c, /driver observes the expected failure/);
    assert.match(c, /At `high` and above, RED receives one bounded independent read-delegate check/);
  });
  it("keeps failure preservation and explicit rulings", () => {
    const c = read("skills/dispatch/references/verbs/implement.md");
    assert.match(c, /preserves and fingerprints the tree/);
    assert.match(
      c,
      /keep for repair, revert attributable paths, inspect first/,
    );
    assert.match(c, /stable-failure/);
  });
  it("keeps alias contract lean", () =>
    assert.ok(
      read("skills/implement-dispatch/SKILL.md").trim().split(/\s+/).length <
        100,
    ));
});
