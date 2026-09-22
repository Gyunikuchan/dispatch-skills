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
describe("v0.5 ledger disclosure", () => {
  it("places ledger ownership and recovery in dispatch", () => {
    const c = read("skills/dispatch/references/verbs/implement.md");
    assert.match(c, /Resolve and fold the ledger/);
    assert.match(c, /run-start/);
    assert.match(c, /run-complete/);
    assert.match(c, /reconciliation/);
    assert.match(c, /never relocated/);
  });
  it("keeps implementation alias mapping-only", () =>
    assert.doesNotMatch(
      read("skills/implement-dispatch/SKILL.md"),
      /ledger-events|task-start|run-complete/,
    ));
});
