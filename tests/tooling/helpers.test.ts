import assert from "node:assert/strict";
import { spawnSync as namedSpawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BLOCKED_LAUNCHERS, SPAWN_RULE } from "../helpers/block-spawn.ts";
import { TEMP_ROOT_MARKER } from "../helpers/isolated-temp.ts";

const require = createRequire(import.meta.url);

const isLauncher = (
  value: unknown
): value is (command: string, args: string[]) => void =>
  typeof value === "function";

test("every child_process launcher throws a rule-naming error outside tests/e2e/", () => {
  const shared: unknown = require("node:child_process");
  assert.ok(typeof shared === "object" && shared !== null);
  const launchers = new Map<string, unknown>(Object.entries(shared));

  for (const name of BLOCKED_LAUNCHERS) {
    const launcher = launchers.get(name);
    assert.ok(isLauncher(launcher), name);
    assert.throws(
      () => {
        launcher("node", ["-v"]);
      },
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- callback-style mock is the contract under test.
      (error: unknown) =>
        error instanceof Error && error.message.startsWith(SPAWN_RULE)
    );
  }

  assert.throws(
    () => namedSpawnSync("node", ["-v"]),
    /tiers 1-5 spawn no processes/u
  );
});

test("each test process gets its own temp dir inside the run temp root", () => {
  const root = process.env[TEMP_ROOT_MARKER] ?? "";
  assert.notEqual(root, "");
  const own = os.tmpdir();
  assert.equal(fs.statSync(own).isDirectory(), true);
  assert.notEqual(path.resolve(own), path.resolve(root));
  const inward = path.relative(root, own);
  assert.ok(
    inward !== "" && !inward.startsWith("..") && !path.isAbsolute(inward)
  );
});
