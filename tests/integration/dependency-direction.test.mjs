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
