import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildScratchPaths } from "../../skills/dispatch/scripts/resolve-artifact-paths.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
describe("v0.5 design execution", () => {
  it("keeps increment and integration artifact paths", () => {
    assert.equal(
      buildScratchPaths("2026-09-21", "root-i01-one", "increment-walkthrough"),
      ".scratch/plan/2026-09-21-root-i01-one-walkthrough.md",
    );
    assert.equal(
      buildScratchPaths("2026-09-21", "root", "integration-walkthrough"),
      ".scratch/plan/2026-09-21-root-integration-walkthrough.md",
    );
  });
  it("documents one-increment execution, amendments, and later integration", () => {
    const c = read("skills/dispatch/references/verbs/design.md");
    assert.match(c, /One invocation runs one ledger-selected increment/);
    assert.match(c, /Amendments/);
    assert.match(c, /Final integration/);
    assert.match(c, /later invocation/);
    assert.match(c, /never relocate the ledger/);
  });
});
