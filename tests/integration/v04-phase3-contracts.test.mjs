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
describe("v0.5 plan and verification contract", () => {
  it("uses canonical plan template criteria", () => {
    const t = read("skills/dispatch/references/templates/plan.md");
    assert.ok(
      t.indexOf("## Success Criteria") < t.indexOf("## Proposed Changes"),
    );
    assert.match(t, /Changes:/);
    assert.match(t, /Verify:/);
  });
  it("discloses evidence mapping and baseline handling under implement", () => {
    const c = read("skills/dispatch/references/verbs/implement.md");
    assert.match(c, /Extract approved paths, commands, and criterion mappings/);
    assert.match(c, /baseline/);
    assert.match(c, /known red — unchanged/);
  });
});
