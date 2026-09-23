import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const aliasRoutes = {
  "dispatch-plan-review": "/dispatch review plan:",
  "dispatch-code-review": "/dispatch review code:",
  "dispatch-design-review": "/dispatch review design:",
  "implement-dispatch": "/dispatch implement:",
};
const aliases = Object.keys(aliasRoutes);
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : [path.join(dir, e.name)],
    )
    .filter((f) => /\.(?:md|mjs|jsonc?)$/.test(f));
}

describe("v0.5 dependency direction", () => {
  it("aliases point to dispatch and no other companion", () => {
    for (const name of aliases) {
      const text = read(`skills/${name}/SKILL.md`);
      assert.ok(
        text.includes(aliasRoutes[name]),
        `${name} must map to ${aliasRoutes[name]}`,
      );
      assert.ok(
        text.includes(`${name} requires the dispatch skill`),
        `${name} must name the missing-dispatch diagnostic`,
      );
      for (const other of aliases)
        if (other !== name)
          assert.doesNotMatch(text, new RegExp(`\\b${other}\\b`));
    }
  });
  it("dispatch points to no alias except the marked legacy config probe", () => {
    const offenders = [];
    for (const file of files(path.join(root, "skills/dispatch"))) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const alias of aliases) {
          if (!line.includes(alias)) continue;
          if (
            alias === "implement-dispatch" &&
            line.includes("v0.4 config probe")
          )
            continue;
          offenders.push(`${path.relative(root, file)}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, []);
  });
  it("legacy config probe remains explicit", () =>
    assert.match(
      read("skills/dispatch/scripts/config.mjs"),
      /v0\.4 config probe.*implement-dispatch|implement-dispatch.*v0\.4 config probe/,
    ));
  it("shipped markdown avoids host-specific install paths", () => {
    const offenders = files(path.join(root, "skills"))
      .filter((f) => f.endsWith(".md"))
      .filter((f) =>
        /(?:\.claude|\.agents|\.github)\/skills\/|\.opencode\/skill\//.test(
          fs
            .readFileSync(f, "utf8")
            .replace(/^.*<skill-path>.*$|^.*<skills-dir>.*$/gm, ""),
        ),
      );
    assert.deepEqual(
      offenders.map((f) => path.relative(root, f)),
      [],
    );
  });
});

// SECTION: alias forwarding grammar

/** Builds a matcher from the grammar block in dispatch/SKILL.md, so the aliases track its shape. */
function dispatchGrammar() {
  const block = read("skills/dispatch/SKILL.md").match(/```text\n([\s\S]*?)```/)[1];
  const levels = block.match(/^level\s+=\s+(.+)$/m)[1].split("|").map((s) => s.trim());
  assert.match(block, /review \[plan\|design\|code\] \[--fix\]/);
  assert.match(block, /implement \[--phases from:<phase>\]/);
  const verb = "(?:ask|plan|design|review(?: (?:plan|design|code))?(?: --fix)?|implement(?: --phases from:[a-z-]+)?)";
  return new RegExp(`^/dispatch(?: (?:${levels.join("|")}))?(?: \\([^)]+\\))?(?: ${verb})?: \\S`);
}

describe("alias forwarding conforms to the dispatch grammar", () => {
  const grammar = dispatchGrammar();
  const render = (form, flags) =>
    form
      .replace("<prefix>", "high (all)")
      .replace("<phase>", flags.phase ?? "code-review")
      .replace("<argument>", "x");
  for (const name of aliases) {
    it(`${name} renders grammar-valid invocations`, () => {
      const text = read(`skills/${name}/SKILL.md`);
      const forms = [...text.matchAll(/`(\/dispatch [^`]+)`/g)].map((m) => m[1]);
      const prefixed = forms.filter((f) => f.includes("<prefix>"));
      assert.ok(prefixed.length > 0, `${name} must show the prefixed forwarding form`);
      for (const form of forms) {
        const rendered = render(form, {});
        assert.match(rendered, grammar, `${name}: ${rendered}`);
      }
      // Level and pins go before the verb, never after the argument colon.
      for (const form of prefixed)
        assert.ok(form.indexOf("<prefix>") < form.search(/ (?:review|implement)\b/), form);
    });
  }
  it("the grammar rejects the misplaced forms the aliases once produced", () => {
    for (const bad of [
      "/dispatch --fix review plan: x",
      "/dispatch implement high (all): x",
      "/dispatch high review --fix plan: x",
    ])
      assert.doesNotMatch(bad, grammar, bad);
  });
});
