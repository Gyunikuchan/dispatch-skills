import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "./scan.ts";

// The cutover adds no dependency; native stripping defines the approved engine range.
// Escalation approved: commitlint tooling for conventional commits.
// Approved Oxc rollout adds formatting, type-aware linting and Ultracite presets.
export const EXPECTED = {
  // SAFETY: test fixture pins the concrete shape asserted below.
  dependencies: [] as string[],
  devDependencies: [
    "@commitlint/cli",
    "@commitlint/config-conventional",
    "@interfere/landmines",
    "@types/node",
    "husky",
    "oxfmt",
    "oxlint",
    "oxlint-tsgolint",
    "typescript",
    "ultracite",
  ],
  engines: { node: "^22.18 || >=23.6" },
};

const keys = (value: unknown) =>
  Object.keys(
    typeof value === "object" && value !== null ? value : {}
  ).toSorted();

interface Manifest {
  dependencies?: unknown;
  devDependencies?: unknown;
  engines?: unknown;
}

export const checkPackage = (pkg: Manifest) => {
  const errors: string[] = [];

  const fix =
    "remove it, or record the escalation and update EXPECTED in the same change";

  for (const field of ["dependencies", "devDependencies"] as const) {
    const extra = keys(pkg[field]).filter(
      (name) => !EXPECTED[field].includes(name)
    );

    if (extra.length) {
      errors.push(`package rule: ${field} adds ${extra.join(", ")}; ${fix}`);
    }
  }

  if (JSON.stringify(pkg.engines) !== JSON.stringify(EXPECTED.engines)) {
    errors.push(
      `package rule: engines is ${JSON.stringify(pkg.engines)}, expected ${JSON.stringify(EXPECTED.engines)}; ${fix}`
    );
  }

  return errors;
};

test("root package.json holds the approved manifest and rejects unapproved changes with the rule and the fix", () => {
  // eslint-disable-next-line typescript/no-unsafe-assignment -- fixture/mock boundary: values are validated by helpers before use.
  const pkg: Manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")
  );

  assert.deepEqual(checkPackage(pkg), []);

  const errors = checkPackage({
    dependencies: { zod: "1" },
    devDependencies: { husky: "1" },
    engines: { node: ">=24" },
  });

  assert.equal(errors.length, 2);
  assert.match(
    errors[0] ?? "",
    /^package rule: dependencies adds zod; remove it/u
  );
  assert.match(errors[1] ?? "", /^package rule: engines is \{"node":">=24"\}/u);
});
