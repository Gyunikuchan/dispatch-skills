import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { OVERLAY_ROOT, scanOverlay } from "./scan.ts";
import type { FileTable } from "./scan.ts";

// Count the real Git/subprocess suites and their shared test helpers.
// NOTE: 20 covers commit-phase refusals and hooks, toolkit-fix-review-lite, toolkit-input, plus shared helpers audit-modules.ts and json.ts.
export const E2E_CAP = 20;

const e2eFiles = () =>
  scanOverlay(path.join(OVERLAY_ROOT, "tests/e2e")).map((file) => ({
    ...file,
    path: `tests/e2e/${file.path}`,
  }));

export const checkE2eCap = (files: FileTable, cap = E2E_CAP) => {
  const e2e = files.filter((file) => file.path.startsWith("tests/e2e/"));

  return e2e.length > cap
    ? [
        `e2e cap rule: tests/e2e/ holds ${e2e.length} files (cap ${cap}); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit`,
      ]
    : [];
};

test("tests/e2e/ stays within the cap and exceeding it fails with the rule and the fix", () => {
  const files = e2eFiles();
  assert.equal(
    files.filter((file) => file.path.startsWith("tests/e2e/")).length,
    19
  );
  assert.deepEqual(checkE2eCap(files), []);

  const over = ["a", "b", "c", "d"].map((name) => ({
    path: `tests/e2e/${name}.test.ts`,
    text: "",
  }));

  assert.deepEqual(checkE2eCap(over, 3), [
    "e2e cap rule: tests/e2e/ holds 4 files (cap 3); cover the behaviour in tiers 1-5, or raise E2E_CAP in an explicit edit",
  ]);
});
