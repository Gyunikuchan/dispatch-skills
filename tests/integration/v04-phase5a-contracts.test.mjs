import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildScratchPaths,
  isReservedOrdinarySlug,
} from "../../skills/dispatch/scripts/resolve-artifact-paths.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
describe("v0.5 design foundation", () => {
  it("keeps canonical design paths", () => {
    assert.equal(
      buildScratchPaths("2026-09-20", "root", "design"),
      ".scratch/plan/2026-09-20-root-design.md",
    );
    assert.equal(isReservedOrdinarySlug("root-design"), true);
  });
  it("places approval and durable stop in dispatch design reference", () => {
    const c = fs.readFileSync(
      path.join(root, "skills/dispatch/references/verbs/design.md"),
      "utf8",
    );
    assert.match(c, /design-approved-stop/);
    assert.match(c, /Approval records design revision/);
  });
});
