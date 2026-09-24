import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { assembleTemplate } from "../../skills/dispatch/scripts/review/fill-template.mjs";
import { REVIEW_KINDS } from "../../skills/dispatch/scripts/review/kinds.mjs";
import { parseReport } from "../../skills/dispatch/scripts/review/parse-report.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const templates = path.join(root, "skills/dispatch/references/templates");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const schema = (name) =>
  JSON.parse(read(`skills/dispatch/references/templates/schemas/${name}.json`));
const examples = (template) =>
  [...template.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1].replaceAll(/<[^>]+>/g, "example")),
  );

// SECTION: Shared review-kind contract

describe("shared review frames match kind registries and parser schemas", () => {
  for (const kind of ["plan", "code", "design"]) {
    it(`${kind} assembles complete frames and matches its parser schema`, () => {
      const assembled = assembleTemplate(
        path.join(templates, "review-prompt.md"),
        path.join(templates, `review-prompt-${kind}.md`),
      );
      const rebuttal = assembleTemplate(
        path.join(templates, "rebuttal.md"),
        path.join(templates, `rebuttal-${kind}.md`),
      );
      for (const result of [assembled, rebuttal]) {
        assert.doesNotMatch(result.template, /<<slot:/);
        assert.ok(result.variables.length > 0);
      }
      assert.ok(REVIEW_KINDS[kind]);
      assert.equal(
        parseReport(kind, JSON.stringify({ status: "CLEAN", findings: [] })).reportKind,
        kind,
      );
      const finding = examples(assembled.template).find(
        (item) => item.status === "FINDINGS",
      ).findings[0];
      const required = schema(`report-${kind}`).properties.findings.items?.required ?? [
        "defect",
        "locus",
        "requiredChange",
        "severity",
        "tag",
      ];
      assert.deepEqual(Object.keys(finding).sort(), required.sort());
    });
  }
  it("keeps rebuttal examples aligned with the parser schema", () => {
    const assembled = assembleTemplate(
      path.join(templates, "rebuttal.md"),
      path.join(templates, "rebuttal-plan.md"),
    );
    const response = examples(assembled.template)[0].responses[0];
    assert.deepEqual(
      Object.keys(response).sort(),
      schema("rebuttal").properties.responses.items.required.sort(),
    );
  });

  it("keeps the common evidence and reply frame single-sourced", () => {
    const frame = read("skills/dispatch/references/templates/review-prompt.md");
    assert.match(frame, /Adhere to this project's conventions/);
    assert.match(
      frame,
      /Your whole reply is one JSON object holding every finding/,
    );
    for (const kind of ["plan", "code", "design"])
      assert.doesNotMatch(
        read(`skills/dispatch/references/templates/review-prompt-${kind}.md`),
        /Your whole reply is one JSON object/,
      );
  });
  it("keeps aliases independent of prompt implementation", () => {
    for (const name of [
      "dispatch-plan-review",
      "dispatch-code-review",
      "dispatch-design-review",
    ]) {
      const text = read(`skills/${name}/SKILL.md`);
      assert.doesNotMatch(text, /prepare-review|parse-report|review-prompt/);
      assert.match(text, /dispatch review/);
    }
  });
});

// SECTION: Alias isolation and forwarding

describe("review aliases preserve dispatch forwarding order", () => {
  it("review aliases place --fix after the kind and implement places --phases after the verb", () => {
    for (const kind of ["plan", "design", "code"]) {
      const text = read(`skills/dispatch-${kind}-review/SKILL.md`);
      assert.ok(
        text.includes(`/dispatch <prefix> review ${kind} --fix: <argument>`),
        `dispatch-${kind}-review must forward --fix after \`${kind}\``,
      );
      assert.match(text, /level and pins before `review`/);
    }
    const implement = read("skills/implement-dispatch/SKILL.md");
    assert.ok(
      implement.includes("/dispatch <prefix> implement --phases from:<phase>: <argument>"),
      "implement-dispatch must forward --phases after `implement`",
    );
    assert.match(implement, /level and pins before `implement`/);
  });
});
