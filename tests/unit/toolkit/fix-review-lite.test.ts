import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  appendRecord,
  appendRecords,
  foldLedger,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import { fixture } from "../../helpers/review-fixture.ts";
import {
  jsonObject,
  narrow,
  readJson,
  text as textCheck,
} from "./helpers/json.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface GitResult {
  exit: number;
  stdout: string;
  stderr: string;
}

const DIFF = `${[
  "--- a/work.plan.md",
  "+++ b/work.plan.md",
  "@@ -1 +1,3 @@",
  " # Work",
  "+",
  "+Writes are serialized; see `skills/writer.ts:12-30`.",
].join("\n")}\n`;

const put = (f: Fixture, rel: string, text = "export const value = 1;\n") => {
  const file = path.join(f.root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const gitStub = (
  f: Fixture,
  listing: string[],
  diff: (argv: string[]) => GitResult = () => ({
    exit: 1,
    stdout: DIFF,
    stderr: "",
  })
) => {
  const calls: string[][] = [];
  // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
  f.deps.run = (argv) => {
    calls.push(argv);

    if (argv[1] === "ls-files") {
      return Promise.resolve({
        exit: 0,
        stdout: listing.map((file) => `${file}\0`).join(""),
        stderr: "",
      });
    }

    if (argv[1] === "diff") {
      return Promise.resolve(diff(argv));
    }

    throw new Error(`Unexpected Git argv ${JSON.stringify(argv)}`);
  };

  return calls;
};

const brief = async (f: Fixture, artifact = f.plan) => {
  f.lines.length = 0;
  fs.copyFileSync(
    path.resolve(
      "skills/dispatch/references/templates/fix-review-lite-brief.md"
    ),
    path.join(
      f.deps.skillRoot,
      "references",
      "templates",
      "fix-review-lite-brief.md"
    )
  );

  const exit = await main(
    [
      "brief",
      "fix-review-lite",
      artifact,
      "--session",
      f.session,
      "--host",
      "claude",
    ],
    f.deps
  );

  const output = f.output();

  const value =
    (output.path ?? "").length > 0
      ? readJson(defined(output.path), jsonObject)
      : null;

  return {
    exit,
    output,
    value,
    text:
      typeof value?.["briefPath"] === "string"
        ? fs.readFileSync(value["briefPath"], "utf-8")
        : "",
  };
};

const reviewed = async (f: Fixture) => {
  const callResult = await f.call();

  assert.equal(callResult.exit, 0);
  await f.add("ruling", {
    subject: "review:plan-work.plan:R1-F001",
    ruling: "accepted",
    rationale: "Serialized writes fix it",
  });
  fs.appendFileSync(
    f.plan,
    "\n## Fix\nWrites are serialized; see `skills/writer.ts:12-30`.\n"
  );
};

const briefFiles = (f: Fixture) => {
  const dir = path.join(f.session, ".state", "briefs");

  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.startsWith("fix-review-lite-"))
    : [];
};

test("fix-review-lite renders an accepted design fix and returns the design round note key", async () => {
  const f = await fixture();

  try {
    const design = f.artifact(
      "work.design.md",
      "# Design\n## Boundaries\nSingle writer.\n"
    );

    const callResult2 = await f.call("design", design);

    assert.equal(callResult2.exit, 0);
    await f.add("ruling", {
      subject: "review:design-work.design:R1-F001",
      ruling: "accepted",
      rationale: "Serialized writes fix it",
    });
    fs.appendFileSync(design, "\n## Fix\nWrites are serialized.\n");
    gitStub(f, []);

    const { exit, text, value } = await brief(f, design);
    assert.equal(exit, 0, text);
    assert.match(text, /R1-F001.*Serialized writes fix it/u);
    assert.equal(value?.["noteKey"], "fix-review-lite:design-work.design:1:1");
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite brief: states the repository root, relative paths, readable paths, diff and reading bound", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");
    gitStub(f, ["skills/writer.ts"]);
    const { exit, value, text } = await brief(f);
    assert.equal(exit, 0);
    assert.ok(
      text.includes(fs.realpathSync(f.root)),
      "repository root is named"
    );
    assert.match(text, /relative paths? resolve against/iu);
    const diffPath = narrow(value?.["diffPath"], textCheck);
    assert.ok(text.includes(diffPath), "diff path is readable");
    assert.ok(!text.includes("round-1.input.md"), "round input is not listed");
    assert.equal(fs.readFileSync(diffPath, "utf-8"), DIFF);
    assert.ok(
      text.includes(f.plan) || text.includes(path.basename(f.plan)),
      "artifact is readable"
    );
    assert.match(text, /## Reading bound/u);
    assert.match(text, /never read a withheld path, even as a search hit/u);
    assert.doesNotMatch(text, /\{\{\w+\}\}/u);
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite brief: cites added-line references only and withholds nothing in the repository", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");
    put(f, "skills/context.ts");
    gitStub(f, ["skills/writer.ts", "skills/context.ts"], () => ({
      exit: 1,
      stderr: "",
      stdout: `${[
        "--- a/work.plan.md",
        "+++ b/work.plan.md",
        "@@ -1,3 +1,3 @@",
        " context `skills/context.ts:1`",
        "-removed `skills/removed.ts:2`",
        "+added `skills/writer.ts:12-30`",
      ].join("\n")}\n`,
    }));
    const { exit, value, text } = await brief(f);
    assert.equal(exit, 0);
    assert.equal(defined(value)["citations"], 1);
    assert.equal(defined(value)["withheld"], 0);
    assert.ok(text.includes("`skills/writer.ts:12-30`"));
    assert.ok(!text.includes("skills/context.ts"));
    assert.ok(!text.includes("skills/removed.ts"));
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite brief: carries the quality-bar evidence line once and no host rule text", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");
    gitStub(f, ["skills/writer.ts"]);
    const { exit, text } = await brief(f);
    assert.equal(exit, 0);
    assert.equal(text.match(/^- Evidence:/gmu)?.length, 1);
    assert.ok(!text.includes("Host rule files"));
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite brief: launch values come from the utility entry of the host", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");
    gitStub(f, ["skills/writer.ts"]);
    fs.writeFileSync(
      path.join(f.deps.skillRoot, "config.jsonc"),
      JSON.stringify({
        "read-delegates": {
          codex: { targets: [{ low: { model: "reader" } }] },
        },
        "utility-subagents": {
          claude: {
            model: "haiku",
            effort: "medium",
            "context-limit": 150_000,
          },
        },
      })
    );
    const { exit, value } = await brief(f);
    assert.equal(exit, 0);
    assert.deepEqual(defined(value)["model"], ["haiku"]);
    assert.equal(defined(value)["effort"], "medium");
    assert.equal(defined(value)["contextLimit"], 150_000);
    assert.match(narrow(value?.["launchAs"], textCheck), /haiku/u);
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite selection resolves the reviewed round across artifacts", async () => {
  {
    const f = await fixture();

    try {
      await reviewed(f);
      const other = path.join(f.root, "other", "work.plan.md");
      put(f, "other/work.plan.md", "# Other\n## Work\nAnother body.\n");
      assert.equal(
        await main(
          [
            "review",
            "run",
            other,
            "--kind",
            "plan",
            "--level",
            "medium",
            "--session",
            f.session,
            "--host",
            "opencode",
          ],
          f.deps
        ),
        0
      );
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, value } = await brief(f);
      assert.equal(exit, 0);
      assert.equal(defined(value)["round"], 1);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "fix-review-lite-outside-")
    );

    try {
      const outside = path.join(outsideDir, "work.plan.md");
      fs.writeFileSync(outside, "# Outside\n## Work\nOutside body.\n");
      assert.equal(
        await main(
          [
            "review",
            "run",
            outside,
            "--kind",
            "plan",
            "--level",
            "medium",
            "--session",
            f.session,
            "--host",
            "opencode",
          ],
          f.deps
        ),
        0
      );
      await f.add("ruling", {
        subject: "review:plan-work.plan:R1-F001",
        ruling: "accepted",
        rationale: "Serialized writes fix it",
      });
      fs.appendFileSync(outside, "\n## Fix\nChanged.\n");
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, value } = await brief(f, outside);
      assert.equal(exit, 0);
      assert.equal(defined(value)["round"], 1);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      f.cleanup();
    }
  }

  {
    const f = await fixture(false);

    try {
      assert.equal(
        await main(
          [
            "review",
            "run",
            f.plan,
            "--kind",
            "plan",
            "--level",
            "medium",
            "--session",
            f.session,
            "--host",
            "opencode",
            "--spec",
            f.spec,
          ],
          f.deps
        ),
        0
      );
      await f.add("ruling", {
        subject: "review:plan-work.plan:R1-F001",
        ruling: "accepted",
        rationale: "Serialized writes fix it",
      });
      fs.appendFileSync(f.plan, "\n## Fix\nChanged.\n");
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, value } = await brief(f);
      assert.equal(exit, 0);
      assert.equal(defined(value)["round"], 1);
    } finally {
      f.cleanup();
    }
  }
});

test("fix-review-lite refusals leave no file without reviewable accepted changes", async () => {
  {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const roundFile = path.join(f.directory, "round-1", "round.json");
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const metadata = JSON.parse(fs.readFileSync(roundFile, "utf-8"));
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      delete metadata.artifactPath;
      fs.writeFileSync(roundFile, JSON.stringify(metadata));
      const missing = await brief(f);
      assert.equal(missing.exit, 4);
      assert.equal(missing.output.reason, "nothing-to-review");
      assert.deepEqual(briefFiles(f), []);

      put(f, "unreviewed.plan.md", "# Unreviewed\n");

      const unreviewed = await brief(
        f,
        path.join(f.root, "unreviewed.plan.md")
      );

      assert.equal(unreviewed.output.reason, "nothing-to-review");

      put(f, "change.code.md", "# Code\n");
      const code = await brief(f, path.join(f.root, "change.code.md"));
      assert.equal(code.exit, 1);
      assert.equal(code.output.reason, "invalid-input");
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    const callResult3 = await f.call();

    try {
      assert.equal(callResult3.exit, 0);
      fs.appendFileSync(f.plan, "\n## Fix\nChanged.\n");
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, output } = await brief(f);
      assert.equal(exit, 4);
      assert.equal(output.reason, "nothing-to-review");
      assert.deepEqual(briefFiles(f), []);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"], () => ({
        exit: 0,
        stdout: "",
        stderr: "",
      }));
      const { exit, output } = await brief(f);
      assert.equal(exit, 4);
      assert.equal(output.reason, "nothing-to-review");
      assert.deepEqual(briefFiles(f), []);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"], () => ({
        exit: 1,
        stdout: "",
        stderr: "access denied",
      }));
      const { exit, output } = await brief(f);
      assert.equal(exit, 2);
      assert.equal(output.reason, "fault");
      assert.deepEqual(briefFiles(f), []);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      fs.unlinkSync(f.spec);
      const { exit, output } = await brief(f);
      assert.equal(exit, 1);
      assert.equal(output.reason, "invalid-input");
    } finally {
      f.cleanup();
    }
  }
});

test("fix-review-lite spec states the reviewed text or its unavailability", async () => {
  {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { text } = await brief(f);
      assert.ok(text.includes(fs.realpathSync(f.spec)));
      assert.doesNotMatch(text, /unavailable/u);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      fs.appendFileSync(f.spec, "\n### REQ-2 — Added later\n");
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, text } = await brief(f);
      assert.equal(exit, 0);
      assert.ok(
        text.includes(path.join(f.directory, "round-1", "spec.snapshot.md"))
      );
      assert.doesNotMatch(text, /unavailable/u);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      fs.appendFileSync(f.spec, "\n### REQ-2 — Added later\n");
      fs.rmSync(path.join(f.directory, "round-1", "spec.snapshot.md"), {
        force: true,
      });
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, text } = await brief(f);
      assert.equal(exit, 0);
      assert.match(text, /reviewed spec text is unavailable/u);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      fs.appendFileSync(f.spec, "\n### REQ-2 — Added later\n");
      fs.writeFileSync(
        path.join(f.directory, "round-1", "spec.snapshot.md"),
        "# Rewritten\n"
      );
      put(f, "skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, text } = await brief(f);
      assert.equal(exit, 0);
      assert.match(text, /reviewed spec text is unavailable/u);
      assert.ok(
        !text.includes(path.join(f.directory, "round-1", "spec.snapshot.md"))
      );
    } finally {
      f.cleanup();
    }
  }
});

test("fix-review-lite withholding: sensitive, outside, session and unlisted citations are withheld with reasons", async () => {
  const f = await fixture();

  try {
    await reviewed(f);

    const sensitive = [
      ".env",
      "deploy/service-account.json",
      ".ssh/config",
      "src/secrets.ts",
      "Config/API_TOKEN.txt",
    ];

    for (const file of sensitive) {
      put(f, file);
    }

    put(f, "skills/writer.ts");
    put(f, "ignored/y.ts");

    const sessionRel = path
      .relative(f.root, f.session)
      .split(path.sep)
      .join("/");

    put(f, `${sessionRel}/notes.md`);
    put(f, ".scratch/dispatch-skills/20261022T0000Z-other/a.md");
    put(f, `${sessionRel}/.state/briefs/x.md`);

    const listing = [
      ...sensitive,
      "skills/writer.ts",
      `${sessionRel}/notes.md`,
      ".scratch/dispatch-skills/20261022T0000Z-other/a.md",
      `${sessionRel}/.state/briefs/x.md`,
    ];

    const cited = [
      ...sensitive,
      "skills/writer.ts",
      "ignored/y.ts",
      "missing.ts",
      "../x.md",
      ".scratch/dispatch-skills/20261022T0000Z-other/a.md",
      `${sessionRel}/notes.md`,
      `${sessionRel}/.state/briefs/x.md`,
    ];

    const diff = `${[
      "--- a/work.plan.md",
      "+++ b/work.plan.md",
      "@@ -1 +1,20 @@",
      ...cited.map((file) => `+Cites \`${file}:1\`.`),
    ].join("\n")}\n`;

    gitStub(f, listing, () => ({ exit: 1, stdout: diff, stderr: "" }));
    const { exit, value, text } = await brief(f);
    assert.equal(exit, 0);

    for (const file of sensitive) {
      assert.ok(text.includes(`\`${file}\`: sensitive`), file);
    }

    assert.ok(text.includes("`../x.md`: outside repository"));
    assert.ok(
      text.includes(
        "`.scratch/dispatch-skills/20261022T0000Z-other/a.md`: session"
      )
    );
    assert.ok(text.includes(`\`${sessionRel}/.state/briefs/x.md\`: session`));
    assert.ok(text.includes("`ignored/y.ts`: not listed"));
    assert.ok(text.includes("`missing.ts`: no match"));

    const unresolved = text
      .split("- Unresolved citations. You may read their listed matches:")[1]
      ?.split("\n\n- Withheld paths. Do not read them:")[0];

    const withheld = text
      .split("- Withheld paths. Do not read them:")[1]
      ?.split("\n\n## Reading bound")[0];

    assert.ok(
      unresolved?.includes("`missing.ts`: no match") === true,
      unresolved
    );
    assert.ok(
      withheld?.includes("`../x.md`: outside repository") === true,
      withheld
    );
    assert.ok(
      text.includes(`\`${sessionRel}/notes.md:1\``) ||
        text.includes(`\`${sessionRel}/notes.md\``),
      "current session artifact is kept"
    );
    assert.ok(text.includes("`skills/writer.ts:1`"));
    assert.equal(defined(value)["unresolved"], 1);
    assert.equal(defined(value)["withheld"], sensitive.length + 4);
  } finally {
    f.cleanup();
  }
});

const citationCases = [
  {
    name: "unique basename keeps its span",
    cited: "writer.ts",
    files: ["lib/writer.ts"],
    expected: "- `lib/writer.ts:1-3`",
    counts: [1, 0, 0],
  },
  {
    name: "two matches list both paths",
    cited: "index.ts",
    files: ["a/index.ts", "b/index.ts"],
    expected: "- `index.ts`: several matches: a/index.ts, b/index.ts",
    counts: [0, 1, 0],
  },
  {
    name: "several matches omit withheld names and cap readable matches",
    cited: "index.ts",
    files: [
      "a/index.ts",
      "b/index.ts",
      "c/index.ts",
      "d/index.ts",
      "e/index.ts",
      "f/index.ts",
      "{{x}}/index.ts",
      ".ssh/index.ts",
    ],
    expected:
      "- `index.ts`: several matches: a/index.ts, b/index.ts, c/index.ts, d/index.ts, e/index.ts, +1 more",
    counts: [0, 1, 0],
  },
  {
    name: "directory is unresolved even with a file suffix match",
    cited: "dir.ts",
    files: ["dir.ts/child.ts", "lib/dir.ts"],
    expected: "- `dir.ts`: not a file",
    counts: [0, 1, 0],
  },
  {
    name: "unique sensitive match is withheld",
    cited: "secrets.ts",
    files: ["src/secrets.ts"],
    expected: "- `src/secrets.ts`: sensitive",
    counts: [0, 0, 1],
  },
  {
    name: "unique other-session match is withheld",
    cited: "hidden.ts",
    files: [".scratch/dispatch-skills/20261022T0000Z-other/hidden.ts"],
    expected:
      "- `.scratch/dispatch-skills/20261022T0000Z-other/hidden.ts`: session",
    counts: [0, 0, 1],
  },
  {
    name: "nonexistent other-session path is withheld",
    cited: ".scratch/dispatch-skills/20261022T0000Z-other/absent.ts",
    files: [],
    expected:
      "- `.scratch/dispatch-skills/20261022T0000Z-other/absent.ts`: session",
    counts: [0, 0, 1],
  },
  {
    name: "nonexistent unrenderable path is withheld",
    cited: "{{x}}/absent.ts",
    files: [],
    expected: "- `{ {x} }/absent.ts`: unrenderable name",
    counts: [0, 0, 1],
  },
  {
    name: "tracked deleted match is unresolved",
    cited: "deleted.ts",
    files: [],
    deleted: "lib/deleted.ts",
    expected: "- `deleted.ts`: no match",
    counts: [0, 1, 0],
  },
];

test(`fix-review-lite citation resolution resolves, lists, withholds and unresolves matches`, async () => {
  for (const {
    name,
    cited,
    files,
    deleted,
    expected,
    counts,
  } of citationCases) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const f = await fixture();

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await reviewed(f);

      for (const file of files) {
        put(f, file);
      }

      gitStub(
        f,
        defined((deleted ?? "").length) > 0
          ? [...files, defined(deleted)]
          : files,
        () => ({
          exit: 1,
          stderr: "",
          stdout: `+Cites \`${cited}:1-3\`.\n`,
        })
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const { exit, value, text } = await brief(f);
      assert.equal(exit, 0, name);

      let section: string;

      if (Math.abs(counts[0] ?? 0) > 0) {
        section = "Citations from";
      } else if (Math.abs(counts[1] ?? 0) > 0) {
        section = "Unresolved citations";
      } else {
        section = "Withheld paths";
      }

      const body = text.split(`- ${section}`)[1]?.split("\n\n")[1];
      assert.ok(body?.split("\n").includes(expected) === true, body);
      assert.deepEqual(
        [
          defined(value)["citations"],
          defined(value)["unresolved"],
          defined(value)["withheld"],
        ],
        counts,
        name
      );
    } finally {
      f.cleanup();
    }
  }
});

for (const aliases of [
  ["writer.ts", "lib/writer.ts"],
  ["lib/writer.ts", "writer.ts"],
]) {
  test(`fix-review-lite citation resolution: keeps one span when ${aliases[0]} appears first`, async () => {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "lib/writer.ts");
      const citations = aliases.map((alias) => `\`${alias}:1-3\``);
      gitStub(f, ["lib/writer.ts"], () => ({
        exit: 1,
        stderr: "",
        stdout: `+Cites ${citations.join(" and ")}.\n`,
      }));
      const { exit, value, text } = await brief(f);
      assert.equal(exit, 0);
      assert.equal(text.split("- `lib/writer.ts:1-3`").length - 1, 1);
      assert.deepEqual(
        [
          defined(value)["citations"],
          defined(value)["unresolved"],
          defined(value)["withheld"],
        ],
        [1, 0, 0]
      );
    } finally {
      f.cleanup();
    }
  });
}

test("fix-review-lite consumer search excludes sessions roots and unlisted paths", async () => {
  {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "skills/writer.ts");
      put(f, ".env");
      put(f, "src/secrets.ts");
      put(f, "weird secret.txt");
      gitStub(f, [
        "skills/writer.ts",
        ".env",
        "src/secrets.ts",
        "weird secret.txt",
      ]);
      const { exit, text } = await brief(f);
      assert.equal(exit, 0);
      assert.match(text, /git grep -n -I -F --untracked -e <name> -- \. /u);
      assert.ok(!text.includes("-l -I"), "no names-only fallback");
      assert.ok(text.includes('":(exclude,literal).scratch/dispatch-skills"'));
      assert.ok(text.includes('":(exclude,literal).env"'));
      assert.ok(text.includes('":(exclude,literal)src/secrets.ts"'));
      assert.ok(text.includes('":(exclude,glob)weird?secret.txt"'));
      assert.ok(text.includes("`weird secret.txt`: sensitive"));
      assert.match(text, /add `-w` before `-e`/u);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      const repo = path.join(f.root, "repo");
      fs.mkdirSync(repo, { recursive: true });
      const manifest = path.join(f.session, "manifest.json");
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(manifest, "utf-8")),
          repositoryRoot: fs.realpathSync(repo),
        })
      );
      put(f, "repo/skills/writer.ts");
      gitStub(f, ["skills/writer.ts"]);
      const { exit, text } = await brief(f);
      assert.equal(exit, 0);
      assert.ok(
        text.includes("`skills/writer.ts:12-30`") ||
          text.includes("`skills/writer.ts:12`"),
        "repository citation kept"
      );
      assert.ok(
        !text.includes(":(exclude"),
        "no exclude for the outside sessions root"
      );
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await fixture();

    try {
      await reviewed(f);
      put(f, "{{x}}/a.md");
      put(f, "{{x}}/.env");
      put(f, "skills/writer.ts");

      const diff = `${[
        "--- a/work.plan.md",
        "+++ b/work.plan.md",
        "@@ -1 +1,3 @@",
        " # Work",
        "+Cites `{{x}}/a.md:1`, `{{x}}/.env:1` and `{{y}}/b.md:1`.",
      ].join("\n")}\n`;

      gitStub(f, ["{{x}}/a.md", "{{x}}/.env", "skills/writer.ts"], () => ({
        exit: 1,
        stdout: diff,
        stderr: "",
      }));
      const { exit, text } = await brief(f);
      assert.equal(exit, 0);
      assert.ok(text.includes("`{ {x} }/a.md`: unrenderable name"));
      assert.ok(text.includes("`{ {y} }/b.md`: unrenderable name"));
      assert.equal(text.split('":(exclude,glob)??x??/a.md"').length - 1, 1);
      assert.equal(text.split('":(exclude,glob)??x??/.env"').length - 1, 1);
      assert.ok(
        !text.includes("??y??"),
        "unlisted unrenderable citation adds no exclude"
      );
    } finally {
      f.cleanup();
    }
  }
});

test("fix-review-lite citations: a leading ./ normalizes to the repository path, so one citation is kept once", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");

    const diff = `${[
      "--- a/work.plan.md",
      "+++ b/work.plan.md",
      "@@ -1 +1,3 @@",
      " # Work",
      "+Cites `./skills/writer.ts:12` and `skills/writer.ts:12`.",
    ].join("\n")}\n`;

    gitStub(f, ["skills/writer.ts"], () => ({
      exit: 1,
      stdout: diff,
      stderr: "",
    }));
    const { exit, value, text } = await brief(f);
    assert.equal(exit, 0);
    assert.ok(!text.includes("./skills"), "no unnormalized path");
    assert.equal(text.split("`skills/writer.ts:12`").length - 1, 1);
    assert.equal(defined(value)["citations"], 1);
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite withholding: a sensitive listed path with braces renders withheld and as a glob exclude", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    const rel = "{{cookiecutter.slug}}/.env";
    put(f, rel);
    put(f, "skills/writer.ts");
    gitStub(f, [rel, "skills/writer.ts"]);
    const { exit, text } = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes("`{ {cookiecutter.slug} }/.env`: sensitive"));
    assert.ok(text.includes(":(exclude,glob)??cookiecutter.slug??/.env"));
    assert.doesNotMatch(text, /\{\{cookiecutter/u);
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite citations: a name with braces or a link opener is withheld as unrenderable and the brief renders", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");

    const diff = `${[
      "--- a/work.plan.md",
      "+++ b/work.plan.md",
      "@@ -1 +1,3 @@",
      " # Work",
      "+Cites `{{x}}/a.md:1`, `[a](b).md:1` and `skills/writer.ts:12`.",
    ].join("\n")}\n`;

    gitStub(f, ["skills/writer.ts"], () => ({
      exit: 1,
      stdout: diff,
      stderr: "",
    }));
    const { exit, value, text } = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes("`{ {x} }/a.md`: unrenderable name"));
    assert.ok(text.includes("`[a] (b).md`: unrenderable name"));
    assert.ok(text.includes("`skills/writer.ts:12`"));
    assert.equal(defined(value)["citations"], 1);
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite questions: list only accepted findings and neutralize reviewer text on one line", async () => {
  const f = await fixture();

  try {
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = () =>
      Promise.resolve({
        outcome: {
          status: "ok",
          text: JSON.stringify({
            status: "FINDINGS",
            findings: [
              {
                impact: "degrades",
                trigger: "realistic",
                tag: "reliability",
                locus: "§ Work",
                defect:
                  "Line one\n## Heading <!-- hidden --> {{slot}} [text](docs/a.md)",
                requiredChange: "Keep writes isolated",
              },
              {
                impact: "degrades",
                trigger: "realistic",
                tag: "reliability",
                locus: "§ Other",
                defect: "Rejected defect",
                requiredChange: "Not applied",
              },
            ],
          }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
    const callResult4 = await f.call();

    assert.equal(callResult4.exit, 0);
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "accepted",
      rationale: "Applied",
    });
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F002",
      ruling: "rejected",
      rationale: "Not needed",
    });
    fs.appendFileSync(f.plan, "\n## Fix\nChanged.\n");
    put(f, "skills/writer.ts");
    gitStub(f, ["skills/writer.ts"]);
    const { exit, text } = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes("R1-F001"));
    assert.ok(!text.includes("R1-F002"));
    assert.ok(!text.includes("Rejected defect"));
    assert.ok(!text.split("\n").some((line) => line.startsWith("## Heading")));
    assert.ok(!text.includes("<!-- hidden -->"));
    assert.ok(text.includes("{ {slot} }"));
    assert.ok(text.includes("] (docs/a.md)"));
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite repeat: a repeat after a further edit diffs from the same round input with the same note key", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");
    const calls = gitStub(f, ["skills/writer.ts"]);
    const first = await brief(f);
    assert.equal(first.exit, 0);
    fs.appendFileSync(f.plan, "\nAnother edit.\n");
    const second = await brief(f);
    assert.equal(second.exit, 0);
    const diffs = calls.filter((argv) => argv[1] === "diff");
    assert.equal(diffs.length, 2);
    const input = path.join(f.directory, "round-1.input.md");
    assert.equal(defined(diffs[0]).at(-2), input);
    assert.equal(defined(diffs[1]).at(-2), input);
    assert.equal(
      defined(first.value)["noteKey"],
      defined(second.value)["noteKey"]
    );
  } finally {
    f.cleanup();
  }
});

test("fix-review-lite advisory notes: the ordinal skips past existing keys, ignores other keys and a note under it appends", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    put(f, "skills/writer.ts");
    gitStub(f, ["skills/writer.ts"]);
    const prefix = "fix-review-lite:plan-work.plan:1:";

    for (const suffix of ["1", "3", "x", "0"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "orchestrator",
          key: prefix + suffix,
          data: { text: "Checked <!-- odd --> text" },
        },
        f.deps
      );
    }

    const { exit, value } = await brief(f);
    assert.equal(exit, 0);
    assert.equal(defined(value)["noteKey"], `${prefix}4`);

    const appendRecordResult = await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: defined(value)["noteKey"],
        data: { text: "Advisory result" },
      },
      f.deps
    );

    assert.equal(appendRecordResult.deduped, false);
  } finally {
    f.cleanup();
  }
});

test("note skeleton: the summary keeps the absolute path and the filled note appends under the displayed key", async () => {
  const f = await fixture();

  try {
    await reviewed(f);
    gitStub(f, ["skills/writer.ts"]);
    const { exit, output, value } = await brief(f);
    assert.equal(exit, 0);
    const [head, json] = output.summary.split("; skeleton ");
    assert.match(
      defined(head),
      /1 accepted, 0 citations, 1 unresolved, 0 withheld/u
    );
    assert.ok(defined(head).includes(narrow(value?.["briefPath"], textCheck)));
    assert.ok((json ?? "").length > 0, "summary must include a note skeleton");
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const skeleton = JSON.parse(defined(json));
    assert.deepEqual(skeleton, {
      kind: "note",
      by: "orchestrator",
      key: defined(value)["noteKey"],
      data: {
        text: "kind plan; raised <n>; confirmed <n>; rejected <id: evidence | none>; mode <explorer|inline>",
      },
    });
    assert.deepEqual(defined(value)["noteSkeleton"], skeleton);

    const filled = {
      ...skeleton,
      data: {
        text: "kind plan; raised 1; confirmed 1; rejected none; mode explorer",
      },
    };

    const appended = await appendRecords(f.session, filled, f.deps);
    assert.equal(appended.deduped, false);
    assert.equal(foldLedger(f.session).records.at(-1)?.key, skeleton.key);
  } finally {
    f.cleanup();
  }
});

for (const [label, basename, model, keepLaunch, sessionBytes] of [
  ["shortens a long absolute path", "work.plan", "haiku", true, 950],
  [
    "prioritizes the launch line over a long prefix",
    `${"a".repeat(245)}.plan`,
    "h".repeat(240),
    true,
    600,
  ],
  [
    "clips a long launch line after giving up the prefix",
    `${"a".repeat(245)}.plan`,
    "界".repeat(230),
    false,
    600,
  ],
] as const) {
  test(`note skeleton: ${label}`, async () => {
    const f = await fixture();

    try {
      const segments =
        sessionBytes === 950 ? [180, 180, 180, 180, 130] : [180, 180, 100];

      const parent = path.join(
        f.root,
        ...segments.map((size) => "s".repeat(size))
      );

      const folder = path.basename(f.session);

      const session = path.join(
        parent,
        "s".repeat(sessionBytes - 2 - Buffer.byteLength(parent + folder)),
        folder
      );

      fs.mkdirSync(session, { recursive: true });

      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const manifest = JSON.parse(
        fs.readFileSync(path.join(f.session, "manifest.json"), "utf-8")
      );

      fs.writeFileSync(
        path.join(session, "manifest.json"),
        JSON.stringify({ ...manifest, folderName: path.basename(session) })
      );

      const artifact = f.artifact(
        `${basename}.md`,
        "# Work\n## Work\nOriginal body.\n"
      );

      const review = `plan-${basename}`;
      const target = { ...f, session };
      await reviewed(f);
      const round = path.join(session, ".state", "reviews", review, "round-1");
      fs.mkdirSync(round, { recursive: true });
      const originalRound = path.join(f.directory, "round-1");
      fs.copyFileSync(
        path.join(originalRound, "findings.json"),
        path.join(round, "findings.json")
      );
      const metadata = narrow(f.read(1, "round.json"), jsonObject);
      fs.writeFileSync(
        path.join(round, "round.json"),
        JSON.stringify({ ...metadata, artifactPath: artifact })
      );
      await appendRecords(
        session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "accepted-finding",
          data: {
            subject: `review:${review}:R1-F001`,
            ruling: "accepted",
            rationale: "Applied",
          },
        },
        f.deps
      );
      fs.appendFileSync(artifact, "\n## Fix\nChanged.\n");
      gitStub(f, ["skills/writer.ts"]);
      fs.writeFileSync(
        path.join(f.deps.skillRoot, "config.jsonc"),
        JSON.stringify({
          "read-delegates": {
            codex: { targets: [{ low: { model: "reader" } }] },
          },
          "utility-subagents": {
            claude: { model, effort: "medium", "context-limit": 150_000 },
          },
        })
      );
      const { exit, output, value } = await brief(target, artifact);
      assert.equal(exit, 0);
      const [head, json] = output.summary.split("; skeleton ");
      assert.ok(
        (json ?? "").length > 0,
        "summary must include a note skeleton"
      );
      assert.ok(Buffer.byteLength(output.summary) <= 1024);
      assert.deepEqual(
        JSON.parse(defined(json)),
        defined(value)["noteSkeleton"]
      );
      assert.equal(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        JSON.parse(defined(json)).key,
        `fix-review-lite:${review}:1:1`
      );

      const rel = /session-relative (?<g1>\S+) \(\d+ bytes\)$/u.exec(
        defined(head)
      )?.[1];

      assert.ok((rel ?? "").length > 0);
      const briefPath = narrow(value?.["briefPath"], textCheck);
      assert.equal(path.resolve(session, defined(rel)), briefPath);
      assert.ok(fs.existsSync(briefPath));
      assert.equal(
        defined(head).includes(narrow(value?.["launchAs"], textCheck)),
        keepLaunch
      );

      if (keepLaunch && basename.length === 250) {
        assert.match(
          defined(head),
          /^fix-review-lite brief .*…: launch: model /u
        );
      }

      if (!keepLaunch) {
        assert.match(defined(head), /^launch: model 界+…; /u);
      }
    } finally {
      f.cleanup();
    }
  });
}
