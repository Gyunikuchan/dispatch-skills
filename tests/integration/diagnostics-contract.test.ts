import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CATEGORIES,
  DIAGNOSTIC_LIMITS,
} from "../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import { OVERLAY_ROOT } from "./scan.ts";

const read = (name: string) =>
  fs.readFileSync(path.join(OVERLAY_ROOT, "skills/dispatch/", name), "utf-8");

test("phase prose records bounded retro observations as a JSON array", () => {
  const instruction = read("references/diagnostics.md");
  assert.ok(
    Buffer.byteLength(instruction.replaceAll(/\r?\n/gu, "\r\n")) <=
      DIAGNOSTIC_LIMITS.instructionBytes
  );
  assert.match(
    instruction,
    /merge your terse notes into the JSON array at `<session>\/\.state\/retro\.json` yourself/u
  );
  assert.match(
    instruction,
    /Without notes, add nothing; if no file, write `\[\]`/u
  );
  assert.match(instruction, /Then run `diagnostics render`/u);
  assert.match(
    instruction,
    /Collection or a failed merge is never a workflow gate/u
  );
  assert.ok(instruction.includes("JSON array"));
  assert.ok(instruction.includes("<session>/.state/retro.json"));
  assert.ok(
    instruction.includes("{id,component,category,evidence,impact,proposedFix}")
  );
  assert.ok(instruction.includes("unique ids"));
  assert.ok(instruction.includes("1-48 A-Za-z0-9_- chars"));

  for (const key of Object.keys(CATEGORIES)) {
    assert.ok(instruction.includes(`\`${key}\``), key);
  }

  assert.ok(
    instruction.includes(`at most ${DIAGNOSTIC_LIMITS.fieldBytes} bytes`)
  );
  assert.match(
    instruction,
    /Exclude repository, toolchain, and user-work issues/u
  );
  assert.match(instruction, /Fixes must hold on any repository and machine/u);
  assert.match(
    instruction,
    /no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets/u
  );

  for (const term of [
    "valid empty",
    "missing",
    "unreadable",
    "malformed",
    "non-array",
    "workflow gate",
  ]) {
    assert.ok(instruction.includes(term), term);
  }

  assert.ok(read("SKILL.md").includes("returned `instructions`"));
});

test("phase prose completes the report before cleaning owned worktrees", () => {
  for (const name of ["SKILL.md", "references/worktree-cleanup.md"]) {
    assert.match(read(name), /report complete[\s\S]*worktree cleanup/u);
  }

  assert.match(read("references/worktree-cleanup.md"), /unrelated/u);
});

test("diagnostics retain privacy and measurement guidance", () => {
  const human = read("references/readme/troubleshooting.md");
  const concepts = read("references/readme/concepts.md");

  const toolkit =
    read("references/toolkit.md").split("### diagnostics render")[1] ?? "";

  for (const label of [
    "Billed tokens",
    "User turns",
    "LLM turns",
    "Tool calls (tool turns)",
    "Rate basis",
    "Uncached input / turn",
  ]) {
    assert.ok(toolkit.includes(`\`${label}\``), label);
  }

  assert.ok(toolkit.includes("### Spend & Turns by Role"));
  assert.ok(toolkit.includes("### Spend & Turns by Stage"));
  assert.ok(toolkit.includes("### Turns & context efficiency by agent"));
  assert.ok(toolkit.includes("### Responder yield"));
  assert.ok(toolkit.includes("## Review health"));
  assert.ok(!toolkit.includes("Review CLI attempt spans"));
  assert.ok(!toolkit.includes("Review yield by slot"));
  assert.ok(
    concepts.includes("Captured CLI attempts retain reported provider usage")
  );
  assert.ok(concepts.includes("Native timing and usage"));

  for (const term of [
    "marks an unavailable value",
    "cost estimate in USD",
    "full conversation totals",
    "work, pauses and scheduling",
    "Review `diagnostics.md` before sharing it",
    "Total storage loss",
    "effective configuration",
    "Native slots",
    "No findings does not prove complete collection",
    "zero unpriced units",
    "matched input and event columns",
  ]) {
    assert.ok(human.includes(term), term);
  }
});

test("diagnostics instructions specify grounding retro items and yield format", () => {
  const instruction = read("references/diagnostics.md");
  assert.ok(instruction.includes("id: grounding-<phase>"));
  assert.ok(instruction.includes("component: references/grounding.md"));
  assert.ok(instruction.includes("category: information-access"));
  assert.ok(
    instruction.includes(
      "evidence: map <n>, nested <n>, research <n>, not-covered <n>, yield <changed>/<launched>, tokens <per explorer from launch notice, else unavailable>"
    )
  );
  assert.match(
    instruction,
    /`yield` counts nested and research explorers whose reply changed a REQ, DEC, scope or blast radius/u
  );
  assert.doesNotMatch(instruction, /\b(?:gap|scout)\b/iu);
  assert.doesNotMatch(read("SKILL.md"), /grounding-<phase>/u);
});
