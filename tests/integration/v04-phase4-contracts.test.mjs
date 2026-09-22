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
describe("v0.5 settlement and fixes", () => {
  it("keeps finality and application records in shared review", () => {
    const c = read("skills/dispatch/references/review.md");
    assert.match(c, /consensus: true/);
    assert.match(c, /CONFIRM/);
    assert.match(c, /application:/);
    assert.match(c, /adjacent/);
  });
  it("makes review fixes opt-in at the model-visible boundary", () => {
    const c = read("skills/dispatch/SKILL.md");
    assert.match(c, /report-only unless the user explicitly supplied `--fix`/);
    assert.match(c, /apply-fixes/);
  });
});
