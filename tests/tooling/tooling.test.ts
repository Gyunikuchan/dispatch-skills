import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { checkTerms, toolingRoot } from "../../scripts/check-terms.ts";
import { hashes } from "../../scripts/generate-hashes.ts";
import { validateConfigs } from "../../scripts/validate-configs.ts";
import { tempDir } from "../helpers/fake-ports.ts";
import { defined } from "../helpers/guards.ts";

test("root-aware hash fixture recognizes contract and catches drift", () => {
  const root = tempDir();
  const skill = path.join(root, "skills/dispatch");

  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "contract");
  hashes(root);
  assert.deepEqual(hashes(root, true), []);
  fs.writeFileSync(path.join(skill, "SKILL.md"), "changed");
  assert.match(hashes(root, true).join(","), /SKILL\.md/u);
  hashes(root);
  assert.deepEqual(hashes(root, true), []);
  assert.deepEqual(
    Object.keys(
      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      JSON.parse(
        fs.readFileSync(path.join(skill, "skill-hashes.json"), "utf-8")
      )
    ),
    ["SKILL.md"]
  );
});

test("toolingRoot defaults and requires a directory value", () => {
  assert.equal(toolingRoot([]), ".");
  assert.equal(toolingRoot(["--check"]), ".");
  assert.equal(toolingRoot(["--check", "--root", "."]), ".");

  for (const args of [
    ["--root"],
    ["--root", "--check"],
    ["--check", "--root"],
  ]) {
    assert.throws(
      () => toolingRoot(args),
      /--root requires a directory value/u
    );
  }
});

test("root-aware terminology fixture reports actionable paths while skipping code and glossary", () => {
  const root = tempDir();
  const skill = path.join(root, "skills/dispatch");

  fs.mkdirSync(path.join(skill, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(skill, "references/glossary.md"),
    "| Term | Banned synonym |\n|---|---|\n| subagent | sub-agent |\n"
  );
  fs.writeFileSync(
    path.join(skill, "SKILL.md"),
    "Use a sub-agent.\n`sub-agent`\n```\nsub-agent\n```\n"
  );
  const errors = checkTerms(root);
  assert.equal(errors.length, 1);
  assert.match(defined(errors[0]), /SKILL\.md:1.*subagent/u);
});

test("root-aware strict config fixture validates sample without reading ignored local config", () => {
  const root = tempDir();
  const skill = path.join(root, "skills/dispatch");

  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, "config.sample.jsonc"),
    '{"read-delegates":{"codex":{"targets":[{"low":{"model":"test"}}]}}}'
  );
  fs.writeFileSync(path.join(skill, "config.local.jsonc"), "invalid");
  assert.deepEqual(validateConfigs(root), []);
  fs.writeFileSync(path.join(skill, "config.sample.jsonc"), '{"unknown":true}');
  assert.match(
    validateConfigs(root).join(","),
    /config.sample.jsonc.*Unrecognized/u
  );
});
