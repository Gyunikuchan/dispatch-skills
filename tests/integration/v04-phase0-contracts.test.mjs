import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
describe("v0.5 contract boundaries", () => {
  it("single-sources review and implementation branches under dispatch", () => {
    assert.match(read("skills/dispatch/SKILL.md"), /references\/review\.md/);
    assert.match(read("skills/dispatch/SKILL.md"), /verbs\/implement\.md/);
    assert.match(read("skills/dispatch/SKILL.md"), /verbs\/design\.md/);
  });
  it("keeps aliases free of operational choreography", () => {
    for (const name of [
      "dispatch-plan-review",
      "dispatch-code-review",
      "dispatch-design-review",
      "implement-dispatch",
    ]) {
      const text = read(`skills/${name}/SKILL.md`);
      assert.doesNotMatch(
        text,
        /prepare-review\.mjs|parse-report\.mjs|check-consensus\.mjs|resolve-flow\.mjs/,
      );
    }
  });
  it("keeps walkthrough behavior in the shared review reference", () => {
    const text = read("skills/dispatch/references/review.md");
    for (const heading of [
      "Changes Made",
      "Verification & Validation",
      "Outcome Traceability",
      "Key Deviations",
      "Review Findings & Resolutions",
      "Follow-ups",
    ])
      assert.match(text, new RegExp(heading));
  });
});
