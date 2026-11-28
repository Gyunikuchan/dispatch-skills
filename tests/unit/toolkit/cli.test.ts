import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { main as dispatchMain } from "../../../skills/dispatch/scripts/dispatch.ts";
import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import type {
  CliDeps,
  HandlerContext,
} from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { landFailure } from "../../../skills/dispatch/scripts/toolkit/land.ts";
import {
  appendRecord,
  foldLedger,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { ToolError } from "../../../skills/dispatch/scripts/toolkit/output.ts";
import {
  checks as checkPlan,
  loadPlan,
} from "../../../skills/dispatch/scripts/toolkit/plan-view.ts";
import { generationLaunchedNative } from "../../../skills/dispatch/scripts/toolkit/review-checkout.ts";
import {
  reviewFixFromCommit,
  reviewFixIdentity,
} from "../../../skills/dispatch/scripts/toolkit/review-fix.ts";
import { defined } from "../../helpers/guards.ts";
import {
  jsonObject,
  narrow,
  optional,
  readJson,
  withFields,
  text,
} from "./helpers/json.ts";
import { sessionFixture, useMemoryAtomicWrite } from "./helpers/session.ts";

describe("toolkit CLI contract", () => {
  test("test cleanup trailer: clips a multiline reason and recovers the interrupted commit", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const from = "a".repeat(40);
      const to = "b".repeat(40);
      const tree = "c".repeat(40);

      const why = `remove\n\t${"x".repeat(77)}😀${"y".repeat(120)}`;
      const criterion = "SC1";
      const cleanup = { removed: [criterion], deleted: 2, merged: 1 };
      fs.mkdirSync(path.join(f.session, ".state/worktrees/integration"), {
        recursive: true,
      });
      f.artifact("mission.spec.md", "# Mission\n");
      f.artifact(
        "work.plan.md",
        [
          "# Work",
          "## Task Map",
          "| ID | Title | Outcome | Prerequisites | Criteria |",
          "| --- | --- | --- | --- | --- |",
          `| T1 | Tests | Tests pass | none | ${criterion} |`,
          "## Proposed Changes",
          "### T1 — Tests",
          "#### [MODIFY] tests/step.ts",
          "- Purpose: Tests behavior.",
          "## Success Criteria",
          `- [${criterion}] Tests pass`,
          "  - Changes: tests/step.ts",
          "  - Tests: tests/step.ts",
          "  - Check: `node --version`",
          "  - Evidence: check",
          "## Verification Plan",
          "### Automated Tests",
          "- `node --version`",
        ].join("\n")
      );
      await appendRecord(
        f.session,
        {
          kind: "bind",
          key: "commit-inputs",
          by: "orchestrator",
          data: { spec: "mission.spec.md", plan: "work.plan.md" },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          data: {
            phase: "opened",
            path: ".state/worktrees/integration",
            branch: "dispatch/test/integration",
            base: from,
            dest: { path: f.root, branch: "main" },
          },
        },
        f.deps
      );

      const check = defined(
        checkPlan(loadPlan(f.session, readManifest(f.session))).find(
          (row) => row.criterion === criterion
        )
      );

      await appendRecord(
        f.session,
        {
          kind: "evidence",
          by: "tool",
          data: {
            criterion,
            commandDigest: check.commandDigest,
            tree,
            before: tree,
            after: tree,
            clean: true,
            exit: 0,
            path: ".state/evidence/test.json",
          },
        },
        f.deps
      );
      const file = path.join(f.root, "test-cleanup.json");
      fs.writeFileSync(file, JSON.stringify(cleanup));

      let head = from;
      let message = "";

      // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
      f.deps.run = async (argv) => {
        const args = argv.slice(1);
        let stdout = "";

        if (args[0] === "rev-parse") {
          if (args[1] === "HEAD") {
            stdout = head;
          } else if (args[1] === "HEAD^") {
            stdout = from;
          } else {
            stdout = tree;
          }
        } else if (args[0] === "diff") {
          if (head === from || args.includes(from)) {
            stdout = "tests/step.ts\0";
          }
        } else if (args[0] === "commit") {
          message = args
            .filter((_, index) => args[index - 1] === "-m")
            .join("\n\n");
          head = to;
        } else if (args[0] === "log") {
          stdout = message;
        } else if (args[0] !== "ls-files" && args[0] !== "add") {
          throw new Error(`Unexpected Git call: ${JSON.stringify(argv)}`);
        }

        return { exit: 0, stdout, stderr: "" };
      };

      const args = [
        "worktree",
        "commit",
        "--reason",
        why,
        "--test-cleanup",
        file,
        "--session",
        f.session,
      ];

      assert.equal(
        await main(args, {
          ...f.deps,
          hook: () => {
            throw new Error("interrupted");
          },
        }),
        2
      );
      assert.equal(
        message.split("\n\n")[0],
        `fix(dispatch): remove ${"x".repeat(77)}`
      );
      f.lines.length = 0;
      assert.equal(await main(args, f.deps), 0);
      assert.equal(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).reason,
        why
      );
    } finally {
      f.cleanup();
    }
  });
  test("commit retries distinguish corrupt correction metadata from completed retries", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const head = "a".repeat(40);
      const reason = "repair bounded SHOULD";

      const directory = path.join(f.session, ".state/worktrees/integration");
      fs.mkdirSync(directory, { recursive: true });
      f.artifact("mission.spec.md", "# Mission\n");
      f.artifact("work.plan.md", "# Work\n");
      await appendRecord(
        f.session,
        {
          kind: "bind",
          key: "commit-inputs",
          by: "orchestrator",
          data: { spec: "mission.spec.md", plan: "work.plan.md" },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          data: {
            phase: "opened",
            path: ".state/worktrees/integration",
            branch: "dispatch/test/integration",
            base: "b".repeat(40),
            dest: { path: f.root, branch: "main" },
          },
        },
        f.deps
      );
      const prefix = `fix(dispatch): ${reason}\n\nDispatch-Fix: ${readManifest(f.session).safeSessionId}\n`;

      const metadata = reviewFixIdentity({
        review: "code-integration",
        round: 3,
        generation: 1,
        findings: ["R3-F001"],
        from: "b".repeat(40),
      });

      let message = "";
      // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
      f.deps.run = async (argv) => {
        const args = argv.slice(1);

        if (args.join(" ") === "rev-parse HEAD") {
          return { exit: 0, stdout: head, stderr: "" };
        }

        if (args[0] === "diff" || args[0] === "ls-files") {
          return { exit: 0, stdout: "", stderr: "" };
        }

        if (args[0] === "log") {
          return { exit: 0, stdout: message, stderr: "" };
        }

        throw new Error(`Unexpected Git call: ${JSON.stringify(argv)}`);
      };

      for (const trailers of [
        `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: broken`,
        `Dispatch-Review-Fix: sha256:${"0".repeat(64)}\nDispatch-Review-Fix-Data: ${metadata.data}`,
        `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: ${metadata.data}`,
      ]) {
        message = prefix + trailers;
        f.lines.length = 0;
        assert.equal(
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
          await main(
            ["worktree", "commit", "--reason", reason, "--session", f.session],
            f.deps
          ),
          1
        );
        assert.equal(f.output().reason, "invalid-review-fix");
        assert.equal(
          foldLedger(f.session).records.filter(
            (row) => row.data["phase"] === "fix"
          ).length,
          0
        );
      }

      message = `${prefix}Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: ${metadata.data}`;
      f.lines.length = 0;
      assert.equal(
        await main(
          ["worktree", "commit", "--reason", reason, "--session", f.session],
          f.deps
        ),
        0
      );
      f.lines.length = 0;
      assert.equal(
        await main(
          ["worktree", "commit", "--reason", reason, "--session", f.session],
          f.deps
        ),
        4
      );
      assert.equal(f.output().reason, "no-changes");
    } finally {
      f.cleanup();
    }
  });
  test("--review-fix is refused outside worktree commit as --review-fix-json is", async () => {
    const f = sessionFixture({ memory: true });

    const refuse = async (flag: string, message: RegExp) => {
      f.lines.length = 0;
      assert.equal(
        await main(
          ["status", "show", flag, "{}", "--session", f.session],
          f.deps
        ),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
      assert.match(f.output().summary, message);
    };

    try {
      await refuse("--review-fix", /--review-fix is only for worktree commit/u);
      await refuse(
        "--review-fix-json",
        /--review-fix-json is only for worktree commit/u
      );
    } finally {
      f.cleanup();
    }
  });

  test("--review-fix names --review-fix-json for an unreadable file and keeps malformed JSON unlabeled", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const missing = path.join(f.root, "missing-review-fix.json");

      assert.equal(
        await main(
          [
            "worktree",
            "commit",
            "--reason",
            "fix",
            "--review-fix",
            missing,
            "--session",
            f.session,
          ],
          f.deps
        ),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
      assert.match(f.output().summary, /Cannot read review-fix file/u);
      assert.match(f.output().summary, /--review-fix-json/u);

      const malformed = f.artifact("malformed-review-fix.json", "{");

      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "worktree",
            "commit",
            "--reason",
            "fix",
            "--review-fix",
            malformed,
            "--session",
            f.session,
          ],
          f.deps
        ),
        1
      );
      assert.match(f.output().summary, /review-fix from .+ is not valid JSON/u);
      assert.doesNotMatch(f.output().summary, /--review-fix-json/u);
    } finally {
      f.cleanup();
    }
  });

  test("review-fix commit splits correction metadata into trailer lines of at most 100 characters", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const reason = "repair bounded SHOULD";
      fs.mkdirSync(path.join(f.session, ".state/worktrees/integration"), {
        recursive: true,
      });
      f.artifact("mission.spec.md", "# Mission\n");
      f.artifact("work.plan.md", "# Work\n");
      await appendRecord(
        f.session,
        {
          kind: "bind",
          key: "commit-inputs",
          by: "orchestrator",
          data: { spec: "mission.spec.md", plan: "work.plan.md" },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          data: {
            phase: "opened",
            path: ".state/worktrees/integration",
            branch: "dispatch/test/integration",
            base: "b".repeat(40),
            dest: { path: f.root, branch: "main" },
          },
        },
        f.deps
      );

      const reviewFix = {
        review: "code-integration",
        round: 3,
        generation: 1,
        findings: [
          "R3-F001",
          "R3-F002",
          "R3-F003",
          "R3-F004",
          "R3-F005",
          "R3-F006",
        ],
        from: "b".repeat(40),
      };

      const file = path.join(f.root, "review-fix.json");
      fs.writeFileSync(file, JSON.stringify(reviewFix));

      let head = "a".repeat(40);
      let message = "";

      // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
      f.deps.run = async (argv) => {
        const args = argv.slice(1);

        if (args.join(" ") === "rev-parse HEAD") {
          return { exit: 0, stdout: head, stderr: "" };
        }

        if (args[0] === "diff") {
          return { exit: 0, stdout: "src/a.ts\0", stderr: "" };
        }

        if (args[0] === "ls-files" || args[0] === "add") {
          return { exit: 0, stdout: "", stderr: "" };
        }

        if (args[0] === "commit") {
          message = args
            .filter((_, index) => args[index - 1] === "-m")
            .join("\n\n");
          head = "c".repeat(40);

          return { exit: 0, stdout: "", stderr: "" };
        }

        throw new Error(`Unexpected Git call: ${JSON.stringify(argv)}`);
      };

      assert.equal(
        await main(
          [
            "worktree",
            "commit",
            "--reason",
            reason,
            "--review-fix",
            file,
            "--session",
            f.session,
          ],
          f.deps
        ),
        0
      );
      const lines = message.split("\n");
      assert.deepEqual(
        lines.filter((line) => line.length > 100),
        []
      );
      assert.ok(
        lines.filter((line) => line.startsWith("Dispatch-Review-Fix-Data: "))
          .length > 1
      );
      assert.deepEqual(reviewFixFromCommit(message), reviewFix);
      assert.deepEqual(
        foldLedger(f.session).records.find((row) => row.data["phase"] === "fix")
          ?.data["reviewFix"],
        reviewFix
      );
    } finally {
      f.cleanup();
    }
  });
  test("usage errors print one line without a result path", async () => {
    const f = sessionFixture({ memory: true });

    try {
      for (const args of [
        ["unknown", "run"],
        ["lint", "unknown"],
        ["lint", "run"],
        ["lint", "run", "--session", f.root],
      ]) {
        f.lines.length = 0;
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        assert.equal(await main(args, f.deps), 1);
        assert.equal(f.output().path, null);
        assert.ok(defined(f.lines[0]).endsWith("\n"));
      }

      fs.writeFileSync(path.join(f.session, "manifest.json"), "{");
      f.lines.length = 0;
      assert.equal(
        await main(["lint", "run", "--session", f.session], f.deps),
        1
      );
      assert.equal(f.output().path, null);
    } finally {
      f.cleanup();
    }
  });
  test("handlers persist success refusals and unexpected faults", async () => {
    const f = sessionFixture({ memory: true });

    try {
      for (const [reason, exit] of [
        ["invalid-input", 1],
        ["fault", 2],
        ["lock-held", 3],
        ["lint-errors", 4],
      ] as const) {
        f.lines.length = 0;
        assert.equal(
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
          await main(["lint", "run", "--session", f.session], {
            ...f.deps,
            handler: () => {
              throw new ToolError(exit, reason, "input field rejected");
            },
          }),
          exit
        );
        const out = f.output();
        assert.equal(out.reason, reason);
        assert.ok(
          out.path?.startsWith(path.join(f.session, ".state", "results")) ===
            true
        );
        assert.match(
          fs.readFileSync(defined(out.path), "utf-8"),
          /input field/u
        );
      }

      for (const fail of [false, true]) {
        f.lines.length = 0;
        assert.equal(
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
          await main(["lint", "run", "--session", f.session], {
            ...f.deps,
            // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
            handler: async () => {
              if (fail) {
                throw new Error("broken handler");
              }

              return {
                ok: true,
                summary: "done",
                value: { answer: 42 },
                exit: 0,
              };
            },
          }),
          fail ? 2 : 0
        );
        assert.ok(fs.existsSync(defined(f.output().path)));
        assert.equal(f.output().ok, !fail);
      }
    } finally {
      f.cleanup();
    }
  });
  test("output write failure reports fault without a path", async () => {
    const f = sessionFixture({ memory: true });

    try {
      assert.equal(
        await main(["lint", "run", "--session", f.session], {
          ...f.deps,
          // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
          handler: async () => ({
            ok: true,
            summary: "done",
            value: {},
            exit: 0,
          }),
          writeResult: () => {
            throw new Error("disk full");
          },
        }),
        2
      );
      assert.equal(f.output().reason, "fault");
      assert.equal(f.output().path, null);
    } finally {
      f.cleanup();
    }
  });
  test("native-failed refuses malformed input and non-review tools", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const q = f.artifact("q.md", "why");

      for (const args of [
        [
          "ask",
          "run",
          q,
          "--session",
          f.session,
          "--host",
          "codex",
          "--native-failed",
          "no-equals",
        ],
        [
          "review",
          "run",
          "worktree",
          "--session",
          f.session,
          "--host",
          "codex",
          "--native-failed",
          "=reason",
        ],
        [
          "review",
          "run",
          "worktree",
          "--session",
          f.session,
          "--host",
          "codex",
          "--native-failed",
          "a#1=",
        ],
      ]) {
        f.lines.length = 0;
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        assert.equal(await main(args, f.deps), 1);
        assert.equal(f.output().reason, "invalid-input");
      }

      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "status",
            "show",
            "--session",
            f.session,
            "--native-failed",
            "a#1=nope",
          ],
          f.deps
        ),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
    } finally {
      f.cleanup();
    }
  });
  test("pins flag is accepted on ask run and review run and rejected on other actions", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const q = f.artifact("q.md", "why");

      for (const action of [
        ["ask", "run", q],
        ["review", "run", "worktree"],
      ]) {
        f.lines.length = 0;
        let seenPins: unknown;

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const exit = await main(
          [
            ...action,
            "--session",
            f.session,
            "--host",
            "codex",
            "--pins",
            "(all)",
          ],
          {
            ...f.deps,
            // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
            handler: async (ctx) => {
              seenPins = ctx.values["pins"];

              return {
                ok: true,
                summary: "ok",
                value: {},
                exit: 0,
              };
            },
          }
        );

        assert.equal(exit, 0, action.join(" "));
        assert.equal(seenPins, "(all)", action.join(" "));
      }

      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "doctor",
            "run",
            "--session",
            f.session,
            "--host",
            "codex",
            "--pins",
            "(all)",
          ],
          f.deps
        ),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
    } finally {
      f.cleanup();
    }
  });
  test("ledger append accepts bom record", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const file = f.artifact(
        "bom-record.json",
        `\uFEFF${JSON.stringify({ kind: "note", key: "bom-note", by: "orchestrator", data: { text: "bom record" } })}`
      );

      assert.equal(
        await main(["ledger", "append", "--session", f.session, file], f.deps),
        0
      );
      assert.equal(f.output().ok, true);
      assert.deepEqual(
        foldLedger(f.session)
          .records.filter((row) => row.key === "bom-note")
          .map((row) => row.kind),
        ["note"]
      );
    } finally {
      f.cleanup();
    }
  });
});

test("lint run summary lists first defects with remaining count", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("work.plan.context.md", "# Context map: work\n");

    const file = f.artifact(
      "work.plan.md",
      "# Work\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n## Success Criteria\n"
    );

    assert.equal(
      await main(["lint", "run", file, "--session", f.session], f.deps),
      4
    );
    assert.equal(f.output().reason, "lint-errors");
    assert.match(
      f.output().summary,
      /^plan: 4 errors, 2 warnings; sha256:[0-9a-f]{64}; first 5: L- proposed-changes: .*; L4 task-map: .*; L- verification-plan: .*; L5 success-criteria: .*; L- missing-section: .*; \+1 more in result$/u
    );
  } finally {
    f.cleanup();
  }
});

test("host-sensitive actions refuse missing or unknown host without manifest change", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const q = f.artifact("q.md", "why");

    const values = f.artifact(
      "explorer.json",
      JSON.stringify({
        objective: "Map.",
        questions: "- Q?",
        outputPath: "out.md",
      })
    );

    const cleanupValues = f.artifact(
      "cleanup.json",
      JSON.stringify({ base: "a".repeat(40), integrationPath: "integration" })
    );

    const cases: string[][] = [
      ["doctor", "run"],
      ["review", "run", q, "--kind", "plan"],
      ["ask", "run", q],
      ["brief", "render", "T1"],
      ["brief", "explorer", values],
      ["brief", "test-cleanup", cleanupValues],
      ["brief", "verifier", values],
    ];

    for (const args of cases) {
      const before = fs.readFileSync(
        path.join(f.session, "manifest.json"),
        "utf-8"
      );

      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main([...args, "--session", f.session], f.deps),
        1,
        args.join(" ")
      );
      assert.equal(f.output().reason, "usage", args.join(" "));
      assert.equal(
        fs.readFileSync(path.join(f.session, "manifest.json"), "utf-8"),
        before,
        args.join(" ")
      );
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(
          [...args, "--session", f.session, "--host", "unknown-x"],
          f.deps
        ),
        1,
        args.join(" ")
      );
      assert.equal(f.output().reason, "usage", args.join(" "));
      assert.equal(
        fs.readFileSync(path.join(f.session, "manifest.json"), "utf-8"),
        before,
        args.join(" ")
      );
    }
  } finally {
    f.cleanup();
  }
});

test("host flag refused on other actions", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const before = fs.readFileSync(
      path.join(f.session, "manifest.json"),
      "utf-8"
    );

    for (const args of [
      ["status", "show"],
      ["ledger", "query"],
      ["check", "run"],
      ["report", "render"],
      ["diagnostics", "render"],
      ["worktree", "create", "T1"],
    ]) {
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(
          [...args, "--session", f.session, "--host", "claude"],
          f.deps
        ),
        1,
        args.join(" ")
      );
      assert.equal(f.output().reason, "usage", args.join(" "));
      assert.equal(
        fs.readFileSync(path.join(f.session, "manifest.json"), "utf-8"),
        before,
        args.join(" ")
      );
    }
  } finally {
    f.cleanup();
  }
});

test("host flag replaces recorded host and reroutes voices", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const manifestFile = path.join(f.session, "manifest.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(manifestFile, "utf-8")),
        host: "claude",
      })
    );

    let seen: {
      manifestHost: string | undefined;
      orchestrator: { platform: string } | null | undefined;
    } | null = null;

    const deps = {
      ...f.deps,
      handler: (context: HandlerContext) => {
        seen = {
          manifestHost: context.manifest.host,
          orchestrator: context.deps.orchestrator,
        };

        return { ok: true, summary: "done", value: {}, exit: 0 };
      },
    };

    f.lines.length = 0;
    assert.equal(
      await main(
        ["doctor", "run", "--session", f.session, "--host", "opencode"],
        // SAFETY: deps spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
        //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- CliDeps is reachable only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
        deps as unknown as CliDeps
      ),
      0
    );
    assert.equal(readManifest(f.session).host, "opencode");

    const captured = narrow(
      seen,
      withFields({
        manifestHost: optional(text),
        orchestrator: withFields({ platform: text }),
      })
    );

    assert.deepEqual(captured.manifestHost, "opencode");
    assert.equal(captured.orchestrator.platform, "opencode");
    f.lines.length = 0;
    assert.equal(
      await main(
        ["doctor", "run", "--session", f.session, "--host", "github-copilot"],
        // SAFETY: deps spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
        //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- CliDeps is reachable only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
        deps as unknown as CliDeps
      ),
      0
    );
    assert.equal(readManifest(f.session).host, "copilot");
  } finally {
    f.cleanup();
  }
});

test("an unreadable fanout record still counts as a native launch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"));

  try {
    const dir = path.join(root, "round-1");
    fs.mkdirSync(path.join(dir, "gen-1"), { recursive: true });
    assert.equal(
      generationLaunchedNative(dir, 1),
      false,
      "a missing record means no native voice"
    );
    fs.writeFileSync(
      path.join(dir, "gen-1", "fanout.json"),
      JSON.stringify({ nativeLaunched: true })
    );
    assert.equal(
      generationLaunchedNative(dir, 1),
      true,
      "a launched record stays launched"
    );
    fs.writeFileSync(path.join(dir, "gen-1", "fanout.json"), "torn json{{{");
    assert.equal(
      generationLaunchedNative(dir, 1),
      true,
      "a torn record fails closed to launched"
    );
    fs.rmSync(path.join(dir, "gen-1", "fanout.json"));
    fs.mkdirSync(path.join(dir, "gen-1", "fanout.json"));
    assert.equal(
      generationLaunchedNative(dir, 1),
      true,
      "an unreadable record fails closed to launched"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cli ledger append formats array summary and refreshes findings for new and deduplicated ruling batches", async () => {
  const f = sessionFixture({ memory: true });
  const restoreAtomicWrite = useMemoryAtomicWrite();

  try {
    const spec = f.artifact(
      "mission.spec.md",
      "# Mission\n## Intent & Problem\nKeep work recoverable.\n"
    );

    const plan = f.artifact(
      "work.plan.md",
      "# Work\n\n## Review Findings & Resolutions\nDriver note.\n"
    );

    const relative = (file: string) =>
      path.relative(f.root, file).split(path.sep).join("/");

    const append = async (name: string, record: unknown) => {
      const file = path.join(f.root, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(record));
      f.lines.length = 0;

      const exit = await main(
        ["ledger", "append", file, "--session", f.session],
        f.deps
      );

      const output = f.output();

      const value =
        exit === 0 ? readJson(defined(output.path), jsonObject) : null;

      return { exit, output, value };
    };

    await append("bind", {
      kind: "bind",
      by: "orchestrator",
      key: "bind",
      data: { spec: relative(spec), plan: relative(plan) },
    });

    const review = "plan-work.plan";

    const directory = path.join(
      f.session,
      ".state",
      "reviews",
      review,
      "round-1"
    );

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "round.json"),
      JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [] })
    );
    fs.writeFileSync(
      path.join(directory, "findings.json"),
      JSON.stringify({
        review,
        round: 1,
        findings: [
          { id: "R1-F001", severity: "SHOULD" },
          { id: "R1-F002", severity: "SHOULD" },
        ],
      })
    );

    const rulings = [
      {
        kind: "ruling",
        by: "orchestrator",
        key: "ruling-F001",
        data: {
          subject: `review:${review}:R1-F001`,
          ruling: "accepted",
          fix: "proposed",
          rationale: "Fixed",
        },
      },
      {
        kind: "ruling",
        by: "orchestrator",
        key: "ruling-F002",
        data: {
          subject: `review:${review}:R1-F002`,
          ruling: "deferred",
          rationale: "Later",
        },
      },
    ];

    const first = await append("rulings", rulings);
    assert.equal(first.exit, 0);
    assert.equal(first.output.summary, "2 records (last seq 3)");
    assert.deepEqual(
      {
        seq: defined(first.value)["seq"],
        deduped: defined(first.value)["deduped"],
        count: defined(first.value)["count"],
        results: defined(first.value)["results"],
        findingsSection: defined(first.value)["findingsSection"],
      },
      {
        seq: 3,
        deduped: false,
        count: 2,
        results: [
          { seq: 2, deduped: false },
          { seq: 3, deduped: false },
        ],
        findingsSection: "updated",
      }
    );
    assert.match(
      fs.readFileSync(plan, "utf-8"),
      /Round 1 \(plan-work\.plan\): 2 findings/u
    );

    const retried = await append("rulings", rulings);
    assert.equal(retried.output.summary, "2 records (last seq 3, all deduped)");
    assert.deepEqual(
      {
        seq: defined(retried.value)["seq"],
        deduped: defined(retried.value)["deduped"],
        count: defined(retried.value)["count"],
        results: defined(retried.value)["results"],
        findingsSection: defined(retried.value)["findingsSection"],
      },
      {
        seq: 3,
        deduped: true,
        count: 2,
        results: [
          { seq: 2, deduped: true },
          { seq: 3, deduped: true },
        ],
        findingsSection: "unchanged",
      }
    );

    const acceptedF002 = {
      kind: "ruling",
      by: "orchestrator",
      key: "ruling-F002-accepted",
      data: {
        subject: `review:${review}:R1-F002`,
        ruling: "accepted",
        fix: "proposed",
        rationale: "Now fixed",
      },
    };

    const mixed = await append("mixed", [rulings[0], acceptedF002]);
    assert.equal(mixed.output.summary, "2 records (last seq 4)");
    assert.deepEqual(
      {
        seq: defined(mixed.value)["seq"],
        deduped: defined(mixed.value)["deduped"],
        count: defined(mixed.value)["count"],
        results: defined(mixed.value)["results"],
        findingsSection: defined(mixed.value)["findingsSection"],
      },
      {
        seq: 4,
        deduped: false,
        count: 2,
        results: [
          { seq: 2, deduped: true },
          { seq: 4, deduped: false },
        ],
        findingsSection: "updated",
      },
      JSON.stringify(mixed.value)
    );
    assert.match(
      fs.readFileSync(plan, "utf-8"),
      /F002 \| 1 \| SHOULD \|[^|]*\| Accepted \|/u
    );

    const single = await append("single", {
      kind: "note",
      by: "orchestrator",
      key: "single-note",
      data: { text: "single" },
    });

    assert.equal(single.output.summary, "seq 5 appended");
    assert.deepEqual(
      {
        seq: defined(single.value)["seq"],
        deduped: defined(single.value)["deduped"],
      },
      { seq: 5, deduped: false }
    );
    assert.equal("findingsSection" in defined(single.value), false);

    const singleRetry = await append("single", {
      kind: "note",
      by: "orchestrator",
      key: "single-note",
      data: { text: "single" },
    });

    assert.equal(singleRetry.output.summary, "seq 5 deduped");
    assert.deepEqual(
      {
        seq: defined(singleRetry.value)["seq"],
        deduped: defined(singleRetry.value)["deduped"],
      },
      { seq: 5, deduped: true }
    );
  } finally {
    restoreAtomicWrite();
    f.cleanup();
  }
});

// SECTION: refusal pointer
test("the retired brief action returns unknown action", async () => {
  const f = sessionFixture({ memory: true });

  try {
    let dispatched = false;

    const exit = await main(
      [
        "brief",
        ["fix", "check"].join("-"),
        "work.plan.md",
        "--session",
        f.session,
        "--host",
        "claude",
      ],
      {
        ...f.deps,
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        handler: async () => {
          dispatched = true;

          return {
            ok: true,
            summary: "dispatched",
            value: {},
            exit: 0,
          };
        },
      }
    );

    assert.equal(exit, 1);
    assert.equal(f.output().reason, "usage");
    assert.equal(f.output().summary, "Unknown tool or action");
    assert.equal(
      narrow(f.output(), withFields({ help: optional(text) })).help,
      "call table"
    );
    assert.equal(dispatched, false);
  } finally {
    f.cleanup();
  }
});

test("refusal names the section for a resolved action and the call table otherwise", async () => {
  const f = sessionFixture({ memory: true });

  const help = () =>
    narrow(f.output(), withFields({ help: optional(text) })).help;

  const run = async (
    args: string[],
    mutate: (deps: typeof f.deps) => void = () => {}
  ) => {
    f.lines.length = 0;
    const deps = { ...f.deps };
    mutate(deps);

    return await main(args, deps);
  };

  try {
    // Unresolved action and parse failure on a valid action.
    assert.equal(await run(["bogus", "action", "--session", f.session]), 1);
    assert.equal(help(), "call table");
    assert.equal(await run(["--session", f.session]), 1);
    assert.equal(help(), "call table");
    assert.equal(
      await run(["status", "show", "--unknown-flag", "--session", f.session]),
      1
    );
    assert.equal(help(), "status show");
    // Handler fault and result-write fault.
    assert.equal(
      await run(["status", "show", "--session", f.session], (deps) => {
        deps.handler = () => {
          throw new Error("boom");
        };
      }),
      2
    );
    assert.equal(help(), "status show");
    assert.equal(
      await run(["status", "show", "--session", f.session], (deps) => {
        deps.writeResult = () => {
          throw new Error("disk");
        };
      }),
      2
    );
    assert.equal(help(), "status show");
    // Gate refusal.
    const file = f.artifact("bad.plan.md", "# Work\n");
    assert.equal(await run(["lint", "run", file, "--session", f.session]), 4);
    assert.equal(f.output().reason, "lint-errors");
    assert.equal(help(), "lint run");
    // native-pending and ok:true carry no pointer.
    assert.equal(
      await run(["status", "show", "--session", f.session], (deps) => {
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        deps.handler = async () => ({
          ok: false,
          value: {},
          summary: "pending",
          exit: 4,
          reason: "native-pending",
        });
      }),
      4
    );
    assert.equal("help" in f.output(), false);
    assert.equal(
      await run(["status", "show", "--session", f.session], (deps) => {
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        deps.handler = async () => ({
          ok: true,
          value: {},
          summary: "fine",
          exit: 0,
        });
      }),
      0
    );
    assert.equal("help" in f.output(), false);
  } finally {
    f.cleanup();
  }
});

test("check run is registered, accepts --task, and verify run is unknown", async () => {
  const f = sessionFixture({ memory: true });

  try {
    let seenTask: unknown;

    const exit = await main(
      ["check", "run", "--session", f.session, "--task", "T1"],
      {
        ...f.deps,
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        handler: async (ctx) => {
          seenTask = ctx.values["task"];

          return {
            ok: true,
            summary: "ok",
            value: {},
            exit: 0,
          };
        },
      }
    );

    assert.equal(exit, 0);
    assert.equal(seenTask, "T1");
    f.lines.length = 0;
    assert.equal(
      await main(
        ["status", "show", "--session", f.session, "--task", "T1"],
        f.deps
      ),
      1
    );
    assert.equal(f.output().reason, "invalid-input");
    f.lines.length = 0;
    assert.equal(
      await main(["verify", "run", "--session", f.session], f.deps),
      1
    );
    assert.equal(f.output().reason, "usage");
  } finally {
    f.cleanup();
  }
});

test("rejects --reuse and --fresh outside check run or combined", async () => {
  const f = sessionFixture({ memory: true });

  try {
    for (const flag of ["--reuse", "--fresh"]) {
      for (const argv of [
        ["status", "show", flag, "--session", f.session],
        ["doctor", "run", flag, "--host", "opencode", "--session", f.session],
      ]) {
        f.lines.length = 0;
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        assert.equal(await main(argv, f.deps), 1, argv.join(" "));
        assert.equal(f.output().reason, "invalid-input", argv.join(" "));
      }

      let seenFlag: unknown;
      f.lines.length = 0;

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const exit = await main(["check", "run", flag, "--session", f.session], {
        ...f.deps,
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        handler: async (ctx) => {
          seenFlag = ctx.values[flag.slice(2)];

          return {
            ok: true,
            summary: "ok",
            value: {},
            exit: 0,
          };
        },
      });

      assert.equal(exit, 0, flag);
      assert.equal(seenFlag, true, flag);
    }

    f.lines.length = 0;
    assert.equal(
      await main(
        ["check", "run", "--reuse", "--fresh", "--session", f.session],
        f.deps
      ),
      1
    );
    assert.equal(f.output().reason, "invalid-input");
  } finally {
    f.cleanup();
  }
});

test("rejects --probe outside doctor run and surfaces probe-failed on doctor run --probe", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skillRoot = path.join(f.root, "probe-skill");
    fs.mkdirSync(skillRoot);
    fs.writeFileSync(
      path.join(skillRoot, "config.jsonc"),
      JSON.stringify({
        "read-delegates": {
          codex: { targets: [{ low: { model: "reader" } }] },
        },
        "write-subagents": { codex: { low: { model: "writer" } } },
        "utility-subagents": {
          codex: { model: "reader", "context-limit": 300_000 },
        },
      })
    );
    const calls: string[] = [];

    const deps = {
      ...f.deps,
      skillRoot,
      probe: {
        discovery: {
          resolve: () => ({ status: "path" as const, path: "codex" }),
          doctor: () => [],
          probes: 0,
        },
        spawn: (binary: string) => {
          calls.push(binary);

          return { exit: 1, stdout: "untrusted subprocess text", stderr: "" };
        },
      },
    };

    assert.equal(
      await main(
        ["status", "show", "--session", f.session, "--probe"],
        // SAFETY: deps spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
        //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- CliDeps is reachable only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
        deps as unknown as CliDeps
      ),
      1
    );
    assert.equal(f.output().reason, "invalid-input");
    assert.match(f.output().summary, /--probe is only for doctor run/u);
    assert.deepEqual(calls, []);

    f.lines.length = 0;
    assert.equal(
      await main(
        [
          "doctor",
          "run",
          "--session",
          f.session,
          "--host",
          "codex",
          "--level",
          "low",
          "--probe",
        ],
        // SAFETY: deps spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
        //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- CliDeps is reachable only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
        deps as unknown as CliDeps
      ),
      0
    );
    const output = f.output();
    assert.deepEqual(
      [output.ok, output.reason, calls],
      [false, "probe-failed", ["codex"]]
    );
    const reportText = fs.readFileSync(defined(output.path), "utf-8");
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const report = JSON.parse(reportText);
    assert.deepEqual(
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      [report.level, report.reason, report.probes[0].failureCategory],
      ["low", "probe-failed", "probe-error"]
    );
    assert.equal(reportText.includes("untrusted subprocess text"), false);
  } finally {
    f.cleanup();
  }
});

test("cleanup checkpoint flags are scoped to ledger append", async () => {
  const f = sessionFixture({ memory: true });

  try {
    assert.equal(
      await main(
        ["ledger", "append", "-", "--cleanup", "skip", "--session", f.session],
        {
          ...f.deps,
          readStdin: () =>
            '{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
        }
      ),
      4
    );
    assert.equal(
      await main(
        ["status", "show", "--cleanup", "skip", "--session", f.session],
        f.deps
      ),
      1
    );
    assert.equal(
      await main(
        ["ledger", "append", "-", "--resume", "--session", f.session],
        f.deps
      ),
      1
    );
    assert.equal(
      await main(
        [
          "ledger",
          "append",
          "receipt.json",
          "--cleanup",
          "skip",
          "--session",
          f.session,
        ],
        f.deps
      ),
      1
    );

    const note = {
      kind: "note",
      by: "tool",
      key: `test-cleanup:skip:1:${"a".repeat(40)}`,
      data: { text: "handwritten" },
    };

    const append = async (key: string) =>
      await main(["ledger", "append", "-", "--session", f.session], {
        ...f.deps,
        readStdin: () => JSON.stringify({ ...note, key }),
      });

    assert.equal(await append(note.key), 1);
    assert.equal(await append("test-cleanup:skip"), 0);
  } finally {
    f.cleanup();
  }
});

test("accepts optional correlation on review runs only", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const ref = "01234567-89ab-4def-8123-0123456789ab";
    assert.equal(
      await main(
        ["status", "show", "--resume-ref", ref, "--session", f.session],
        f.deps
      ),
      1
    );
    assert.match(f.output().summary, /--resume-ref is only for review run/u);
    const seen: unknown[] = [];

    const deps = {
      ...f.deps,
      handler: (ctx: HandlerContext) => {
        seen.push(ctx.values["resume-ref"]);

        return { ok: true, exit: 0, summary: "ok", value: {} };
      },
    };

    const review = [
      "review",
      "run",
      "integration",
      "--host",
      "codex",
      "--session",
      f.session,
    ];

    // SAFETY: deps spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
    //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- CliDeps is reachable only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
    assert.equal(await main(review, deps as unknown as CliDeps), 0);
    assert.equal(
      // SAFETY: deps spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
      //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- CliDeps is reachable only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
      await main([...review, "--resume-ref", ref], deps as unknown as CliDeps),
      0
    );
    assert.deepEqual(seen, [undefined, ref]);
  } finally {
    f.cleanup();
  }
});

test("help ruling requires severity-correction rationale to name impact or trigger literally", async () => {
  const f = sessionFixture({ memory: true });

  try {
    assert.equal(await dispatchMain(["help", "ruling"], f.deps), 0);
    assert.match(
      f.lines.join("\n"),
      /a rationale that does not literally name each changed dimension \(`impact` and\/or `trigger`\)/u
    );
  } finally {
    f.cleanup();
  }
});

describe("stepped outcomes", () => {
  const stepped = withFields({
    step: optional(text),
    help: optional(text),
    reason: optional(text),
    summary: text,
  });

  const run = async (
    f: ReturnType<typeof sessionFixture>,
    args: string[],
    handler: NonNullable<CliDeps["handler"]>
  ) => {
    f.lines.length = 0;

    const exit = await main([...args, "--session", f.session], {
      ...f.deps,
      handler,
    });

    return { exit, out: narrow(f.output(), stepped) };
  };

  test("worktree land is a registered action that takes --ack-stale", async () => {
    const f = sessionFixture({ memory: true });

    try {
      let called = false;

      const { exit, out } = await run(
        f,
        ["worktree", "land", "T1", "--ack-stale", "reviewed"],
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        async (ctx) => {
          called = true;
          assert.deepEqual(ctx.args, ["T1"]);
          assert.equal(ctx.values["ack-stale"], "reviewed");

          return { ok: true, summary: "landed", value: {}, exit: 0 };
        }
      );

      assert.equal(exit, 0);
      assert.equal(out.summary, "landed");
      assert.equal(called, true);
      assert.equal("step" in out, false);
    } finally {
      f.cleanup();
    }
  });

  test("a step prefixes the summary and sets the help heading of that step", async () => {
    const f = sessionFixture({ memory: true });

    try {
      for (const [step, reason, help] of [
        ["submit", "no-changes", "worktree submit"],
        ["integrate", "stale-candidate", "worktree integrate"],
        ["integrate", "integration-abandoned", "worktree create"],
        ["check", "mutated", "check run"],
        ["edit", "lint-errors", "lint run"],
        ["fix-review-lite", "no-completed-round", "brief fix-review-lite"],
        ["note", "invalid-input", "ledger append"],
        ["review", "level-pending", "review run"],
      ] as const) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits observe one output line at a time
        const { exit, out } = await run(
          f,
          ["worktree", "land", "T1"],
          // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
          async () => ({
            ok: false,
            summary: `${reason}; 2 paths`,
            value: {},
            exit: 0,
            reason,
            step,
          })
        );

        assert.equal(exit, 0);
        assert.equal(out.summary, `${step}: ${reason}; 2 paths`);
        assert.equal(out.step, step);
        assert.equal(out.reason, reason);
        assert.equal(out.help, help);
      }
    } finally {
      f.cleanup();
    }
  });

  test("a refusal that carries a step keeps its reason first in the summary", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const plain = await run(f, ["worktree", "land", "T1"], () => {
        throw new ToolError(4, "no-open-launch", "no-open-launch", "submit");
      });

      assert.equal(plain.exit, 4);
      assert.equal(plain.out.summary, "submit: no-open-launch");
      assert.equal(plain.out.step, "submit");
      assert.equal(plain.out.help, "worktree submit");

      const detailed = await run(f, ["worktree", "land", "T1"], () => {
        throw new ToolError(4, "integration-pending", "T2", "integrate");
      });

      assert.equal(detailed.out.summary, "integrate: integration-pending: T2");
      assert.equal(detailed.out.help, "worktree integrate");

      const bare = await run(f, ["worktree", "land", "T1"], () => {
        throw new ToolError(4, "no-open-launch", "no-open-launch");
      });

      assert.equal(bare.out.summary, "no-open-launch");
      assert.equal(bare.out.step, undefined);
      assert.equal(bare.out.help, "worktree land");
    } finally {
      f.cleanup();
    }
  });

  test("land failures keep step, reason and counts when item lists overflow 1,024 B", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const paths = Array.from(
        { length: 30 },
        (_, index) =>
          `src/${String(index).padStart(2, "0")}/${"p".repeat(300)}.ts`
      );

      const conflict = await run(
        f,
        ["worktree", "land", "T1"],
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        async () =>
          landFailure("integrate", {
            ok: false,
            exit: 0,
            reason: "conflict",
            summary: "",
            value: { task: "T1", paths, reason: "conflict" },
          })
      );

      assert.ok(Buffer.byteLength(conflict.out.summary) <= 1024);
      assert.ok(
        conflict.out.summary.startsWith("integrate: conflict; 30 paths; first ")
      );
      assert.equal(
        /first (?<shown>\d+):/u.exec(conflict.out.summary)?.groups?.["shown"],
        "4"
      );
      assert.match(conflict.out.summary, /; \+26 more in result$/u);
      assert.equal(conflict.out.step, "integrate");

      const criteria = Array.from(
        { length: 12 },
        (_, index) => `SC${index + 1}`
      );

      const failed = await run(
        f,
        ["worktree", "land", "T1"],
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        async () =>
          landFailure("check", {
            ok: false,
            exit: 0,
            reason: "checks-failed",
            summary: "",
            value: {
              checks: criteria.map((criterion) => ({
                criterion,
                path: `.state/evidence/${"e".repeat(300)}.json`,
              })),
              failed: criteria,
              mutated: [],
              dirty: [],
            },
          })
      );

      assert.ok(Buffer.byteLength(failed.out.summary) <= 1024);
      assert.ok(
        failed.out.summary.startsWith(
          "check: checks-failed; 12 checks, 12 failed, 0 mutated, 0 dirty; first "
        )
      );
      assert.match(failed.out.summary, /; \+\d+ more in result$/u);
      assert.equal(failed.out.step, "check");
      assert.equal(failed.out.help, "check run");

      const few = landFailure("integrate", {
        ok: false,
        exit: 0,
        reason: "conflict",
        summary: "",
        value: { paths: ["a.ts", "b.ts"] },
      });

      assert.equal(few.summary, "conflict; 2 paths; first 2: a.ts; b.ts");
    } finally {
      f.cleanup();
    }
  });
});

const noteRecord = (
  key: string,
  overrides: { kind?: string; by?: string } = {}
) =>
  JSON.stringify({
    kind: "note",
    by: "orchestrator",
    key,
    data: { text: "kind plan; raised 1" },
    ...overrides,
  });

describe("bookkeeping flags", () => {
  const stepped = withFields({
    step: optional(text),
    help: optional(text),
    reason: optional(text),
    summary: text,
  });

  const noteKey = "fix-review-lite:plan-work.plan:1:1";

  const review = async (
    f: ReturnType<typeof sessionFixture>,
    args: string[],
    payload: string
  ) => {
    f.lines.length = 0;

    const exit = await main(
      [
        "review",
        "run",
        ...args,
        "--host",
        "codex",
        "--note",
        "-",
        "--session",
        f.session,
      ],
      { ...f.deps, readStdin: () => payload }
    );

    return { exit, out: narrow(f.output(), stepped) };
  };

  test("--fix-review-lite and --note are scoped to lint run and review run", async () => {
    const f = sessionFixture({ memory: true });

    try {
      assert.equal(
        await main(
          ["status", "show", "--fix-review-lite", "--session", f.session],
          f.deps
        ),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
      assert.match(
        f.output().summary,
        /--fix-review-lite is only for lint run/u
      );

      f.lines.length = 0;
      assert.equal(
        await main(
          ["status", "show", "--note", "-", "--session", f.session],
          f.deps
        ),
        1
      );
      assert.match(f.output().summary, /--note is only for review run/u);
    } finally {
      f.cleanup();
    }
  });

  test("a bare --fix-review-lite parses as a boolean and leaves the next flag alone", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const seen: unknown[] = [];

      const exit = await main(
        [
          "lint",
          "run",
          "work.plan.md",
          "--edit",
          "fields.json",
          "--fix-review-lite",
          "--session",
          f.session,
        ],
        {
          ...f.deps,
          // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
          handler: async (ctx: HandlerContext) => {
            seen.push(
              ctx.args,
              ctx.values["edit"],
              ctx.values["fix-review-lite"]
            );

            return { ok: true, exit: 0, summary: "ok", value: {} };
          },
        }
      );

      assert.equal(exit, 0);
      assert.deepEqual(seen, [["work.plan.md"], "fields.json", true]);
    } finally {
      f.cleanup();
    }
  });

  test("lint run refuses --fix-review-lite without an edit payload", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const before = foldLedger(f.session).lastSeq;

      assert.equal(
        await main(
          [
            "lint",
            "run",
            "work.plan.md",
            "--fix-review-lite",
            "--session",
            f.session,
          ],
          f.deps
        ),
        1
      );

      const out = narrow(f.output(), stepped);

      assert.equal(out.reason, "invalid-input");
      assert.equal(out.step, undefined);
      assert.match(out.summary, /--fix-review-lite needs --edit or --json/u);
      assert.equal(foldLedger(f.session).lastSeq, before);
    } finally {
      f.cleanup();
    }
  });

  test("review run refuses a --note payload that does not match this review before any append", async () => {
    const f = sessionFixture({ memory: true });

    try {
      const before = foldLedger(f.session).lastSeq;

      const cases: [string, string[], string][] = [
        ["invalid JSON", ["work.plan.md", "--kind", "plan"], "not json"],
        ["a non-object payload", ["work.plan.md", "--kind", "plan"], "[]"],
        [
          "a record kind other than note",
          ["work.plan.md", "--kind", "plan"],
          noteRecord(noteKey, { kind: "level" }),
        ],
        [
          "a record author other than the orchestrator",
          ["work.plan.md", "--kind", "plan"],
          noteRecord(noteKey, { by: "user" }),
        ],
        [
          "a key outside the fix-review-lite namespace",
          ["work.plan.md", "--kind", "plan"],
          noteRecord("other:plan-work.plan:1:1"),
        ],
        [
          "another review's key",
          ["work.plan.md", "--kind", "plan"],
          noteRecord("fix-review-lite:plan-other.plan:1:1"),
        ],
        [
          "a zero ordinal",
          ["work.plan.md", "--kind", "plan"],
          noteRecord("fix-review-lite:plan-work.plan:1:0"),
        ],
        [
          "a round with no completed round on record",
          ["work.plan.md", "--kind", "plan"],
          noteRecord(noteKey),
        ],
        ["a code review target", ["integration"], noteRecord(noteKey)],
      ];

      for (const [label, args, payload] of cases) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits observe one output line at a time
        const { exit, out } = await review(f, args, payload);

        assert.equal(exit, 1, label);
        assert.equal(out.reason, "invalid-input", label);
        assert.equal(out.step, "note", label);
        assert.equal(out.help, "ledger append", label);
        assert.ok(out.summary.startsWith("note: "), label);
        assert.equal(foldLedger(f.session).lastSeq, before, label);
      }
    } finally {
      f.cleanup();
    }
  });
});
