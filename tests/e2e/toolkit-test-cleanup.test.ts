import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { JsonObject } from "../../skills/dispatch/scripts/lib/config.ts";
import { readManifest } from "../../skills/dispatch/scripts/lib/session.ts";
import { foldLedger } from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  checks,
  loadPlan,
} from "../../skills/dispatch/scripts/toolkit/plan-view.ts";
import {
  arrayOf,
  defined,
  isNumber,
  isString,
  maybe,
  narrow,
  objectWith,
} from "./helpers/json.ts";
import {
  captureIntegrationReview,
  planSource,
  toolkitRepo,
} from "./helpers/toolkit-repo.ts";

const isStatuses = arrayOf(
  objectWith({ criterion: isString, state: isString, reason: maybe(isString) })
);

const target = "tests/step.test.ts";

const source = planSource
  .replace(
    "#### [MODIFY] src/file.ts",
    `#### [MODIFY] src/file.ts\n- Purpose: implements behavior.\n#### [NEW] ${target}`
  )
  .replace(
    "  - Changes: src/file.ts",
    `  - Changes: src/file.ts, ${target}\n  - Tests: ${target}`
  );

const twoCriteriaSource = [
  "# Work",
  "",
  "## Task Map",
  "| ID | Title | Outcome | Prerequisites | Criteria |",
  "| --- | --- | --- | --- | --- |",
  "| T1 | File | Works | none | SC1 |",
  "| T2 | Other | Works | none | SC2 |",
  "",
  "## Proposed Changes",
  "### T1 — File",
  "#### [MODIFY] src/file.ts",
  "- Purpose: implements behavior.",
  `#### [NEW] ${target}`,
  "- Purpose: implements behavior.",
  "",
  "### T2 — Other",
  "#### [NEW] src/other.ts",
  "- Purpose: implements behavior.",
  "#### [NEW] tests/other.test.ts",
  "- Purpose: tests other behavior.",
  "",
  "## Success Criteria",
  "- [SC1] File works",
  `  - Changes: src/file.ts, ${target}`,
  `  - Tests: ${target}`,
  '  - Check: `node -e "process.exit(0)"`',
  "  - Evidence: check",
  "- [SC2] Other works",
  "  - Changes: src/other.ts, tests/other.test.ts",
  "  - Tests: tests/other.test.ts",
  '  - Check: `node -e "process.exit(0)"`',
  "  - Evidence: check",
  "",
  "## Verification Plan",
  "### Automated Tests",
  "- `node -e \"process.stdout.write('contract')\"`",
  "",
].join("\n");

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;

const integrated = async (verify = true, plan = source) => {
  const r = await toolkitRepo(plan);

  await r.level();

  const made = await r.run(["worktree", "create", "T1"]);

  assert.equal(made.output.ok, true, JSON.stringify(made));

  const { path: writerRel } = narrow(
    made.value,
    objectWith({ path: isString })
  );

  const writer = path.join(r.session, writerRel);

  fs.mkdirSync(path.join(writer, "tests"), { recursive: true });
  fs.writeFileSync(path.join(writer, target), "step\n");

  const submitted = await r.run(["worktree", "submit", "T1"]);

  assert.equal(submitted.exit, 0);

  const didIntegrate = await r.run(["worktree", "integrate", "T1"]);

  assert.equal(didIntegrate.exit, 0);

  if (verify) {
    const checked = await r.run(["check", "run"]);

    assert.equal(checked.output.ok, true);
  }

  return r;
};

const integrateTaskTwo = async (r: Repo) => {
  const made = await r.run(["worktree", "create", "T2"]);

  assert.equal(made.output.ok, true, JSON.stringify(made));

  const { path: writerRel } = narrow(
    made.value,
    objectWith({ path: isString })
  );

  const writer = path.join(r.session, writerRel);

  fs.mkdirSync(path.join(writer, "tests"), { recursive: true });
  fs.writeFileSync(path.join(writer, "src/other.ts"), "other\n");
  fs.writeFileSync(path.join(writer, "tests/other.test.ts"), "other test\n");

  const submitted = await r.run(["worktree", "submit", "T2"]);

  assert.equal(submitted.exit, 0);

  const didIntegrate = await r.run(["worktree", "integrate", "T2"]);

  assert.equal(didIntegrate.exit, 0);
};

const cleanupFile = (r: Repo, data: JsonObject) => {
  const file = path.join(r.session, "cleanup.json");

  fs.writeFileSync(file, JSON.stringify(data));

  return file;
};

const commit = async (
  r: Repo,
  data: JsonObject,
  hook?: Parameters<Repo["run"]>[1]
) =>
  await r.run(
    [
      "worktree",
      "commit",
      "--reason",
      "remove step tests",
      "--test-cleanup",
      cleanupFile(r, data),
    ],
    hook
  );

const cleanups = (r: Repo) =>
  foldLedger(r.session).records.filter(
    (row) => row.data["phase"] === "test-cleanup"
  );

const removal = { removed: ["SC1"], deleted: 2, merged: 1 };

test("test cleanup commit records removed criteria and counts once", async () => {
  const r = await integrated();

  try {
    const before = r.git(["rev-parse", "HEAD"], r.integration);

    fs.rmSync(path.join(r.integration, target));

    const done = await commit(r, removal);

    assert.equal(done.output.ok, true, JSON.stringify(done));

    const head = r.git(["rev-parse", "HEAD"], r.integration);

    assert.notEqual(head, before);
    assert.match(
      r.git(["log", "-1", "--format=%B"], r.integration),
      /Dispatch-Test-Cleanup-Data: /u
    );

    const [record] = cleanups(r);

    const first = defined(record, "cleanup record");

    assert.equal(cleanups(r).length, 1);
    assert.deepEqual(
      {
        from: first.data["from"],
        fromTree: first.data["fromTree"],
        to: first.data["to"],
        removed: first.data["removed"],
        deleted: first.data["deleted"],
        merged: first.data["merged"],
        trees: first.data["trees"],
      },
      {
        from: before,
        fromTree: r.git(["rev-parse", `${before}^{tree}`], r.integration),
        to: head,
        ...removal,
        trees: {
          SC1: r.git(["rev-parse", `${before}^{tree}`], r.integration),
        },
      }
    );

    fs.writeFileSync(path.join(r.integration, "src/file.ts"), "again\n");

    const repeated = await commit(r, removal);

    assert.equal(repeated.output.reason, "test-cleanup-recorded");
    assert.equal(cleanups(r).length, 1);
  } finally {
    r.cleanup();
  }
});

test("test cleanup commit refuses missing evidence, unchanged test paths and empty cleanup", async () => {
  const r = await integrated(false);

  try {
    fs.rmSync(path.join(r.integration, target));

    const head = r.git(["rev-parse", "HEAD"], r.integration);

    const missing = await commit(r, removal);

    assert.equal(missing.output.reason, "test-cleanup-evidence-required");

    const wrongCriterion = await commit(r, {
      removed: ["SC9"],
      deleted: 1,
      merged: 0,
    });

    assert.equal(
      wrongCriterion.output.reason,
      "test-cleanup-evidence-required"
    );
    assert.equal(r.git(["rev-parse", "HEAD"], r.integration), head);
    assert.equal(cleanups(r).length, 0);

    const check = checks(
      defined(
        loadPlan(r.session, defined(readManifest(r.session), "manifest")),
        "plan"
      )
    ).find((row) => row.criterion === "SC1");

    const found = defined(check, "SC1 check");

    const tree = r.git(["rev-parse", "HEAD^{tree}"], r.integration);

    const evidenceFile = path.join(r.session, "legacy-review-evidence.json");

    fs.writeFileSync(
      evidenceFile,
      JSON.stringify({
        kind: "evidence",
        key: "legacy-review-evidence",
        by: "tool",
        data: {
          criterion: "SC1",
          commandDigest: found.commandDigest,
          tree,
          clean: false,
          before: tree,
          after: tree,
          exit: 1,
          path: ".state/evidence/legacy-review.json",
        },
      })
    );

    const appended = await r.run(["ledger", "append", evidenceFile]);

    assert.equal(appended.exit, 0);

    const stillMissing = await commit(r, removal);

    assert.equal(stillMissing.output.reason, "test-cleanup-evidence-required");
    assert.equal(cleanups(r).length, 0);

    fs.writeFileSync(path.join(r.integration, target), "step\n");

    const checked = await r.run(["check", "run"]);

    assert.equal(checked.output.ok, true);

    fs.writeFileSync(path.join(r.integration, "src/other.ts"), "other\n");

    const unchanged = await commit(r, removal);

    assert.equal(unchanged.output.reason, "test-cleanup-paths-unchanged");

    const empty = await commit(r, { removed: [], deleted: 0, merged: 0 });

    assert.equal(empty.output.reason, "test-cleanup-empty");
    assert.equal(r.git(["rev-parse", "HEAD"], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally {
    r.cleanup();
  }
});

test("an interrupted test cleanup commit with split trailers records on retry without a second commit", async () => {
  const criterion = `SC${"1".repeat(320)}`;

  const data = { ...removal, removed: [criterion] };

  const r = await integrated(true, source.replaceAll("SC1", criterion));

  try {
    const before = r.git(["rev-parse", "HEAD"], r.integration);

    fs.rmSync(path.join(r.integration, target));

    const crashed = await commit(r, data, (point) => {
      if (point === "commit:after-commit") {
        throw new Error("crash");
      }
    });

    assert.equal(crashed.exit, 2);
    assert.equal(cleanups(r).length, 0);

    const head = r.git(["rev-parse", "HEAD"], r.integration);

    assert.notEqual(head, before);

    const lines = r
      .git(["log", "-1", "--format=%B"], r.integration)
      .split(/\r?\n/u);

    assert.ok(lines.every((line) => line.length <= 100));
    assert.ok(
      lines.filter((line) => line.startsWith("Dispatch-Test-Cleanup-Data: "))
        .length > 1
    );

    const mismatched = await commit(r, { ...data, deleted: 9 });

    assert.equal(mismatched.output.ok, false);

    const retried = await commit(r, data);

    assert.equal(retried.output.ok, true, JSON.stringify(retried));
    assert.equal(r.git(["rev-parse", "HEAD"], r.integration), head);
    assert.equal(cleanups(r).length, 1);
    assert.equal(
      defined(cleanups(r)[0], "cleanup record").data["from"],
      before
    );
  } finally {
    r.cleanup();
  }
});

test("verify skips criteria whose tests cleanup removed and refuses to select them", async () => {
  const r = await integrated();

  try {
    fs.rmSync(path.join(r.integration, target));

    const done = await commit(r, removal);

    assert.equal(done.output.ok, true);

    const all = await r.run(["check", "run"]);

    assert.equal(all.output.ok, true, JSON.stringify(all));
    assert.deepEqual(
      narrow(
        all.value,
        objectWith({ checks: arrayOf(objectWith({ criterion: isString })) })
      ).checks.map((row) => row.criterion),
      ["contract"]
    );

    const named = await r.run(["check", "run", "--criteria", "SC1"]);

    assert.equal(named.exit, 4);
    assert.equal(named.output.reason, "test-cleanup-removed");
    assert.match(
      named.output.summary,
      /stays bound to their recorded evidence tree/u
    );
  } finally {
    r.cleanup();
  }
});

test("test cleanup commit accepts evidence from an unchanged earlier tree; status names the evidence tree of removed criteria", async () => {
  const r = await integrated(false, twoCriteriaSource);

  try {
    const scoped = await r.run(["check", "run", "--criteria", "SC1"]);

    assert.equal(scoped.output.ok, true);

    const earlyTree = r.git(["rev-parse", "HEAD^{tree}"], r.integration);

    await integrateTaskTwo(r);

    const before = r.git(["rev-parse", "HEAD"], r.integration);
    const beforeTree = r.git(["rev-parse", "HEAD^{tree}"], r.integration);

    assert.notEqual(beforeTree, earlyTree);

    fs.rmSync(path.join(r.integration, target));

    const done = await commit(r, removal);

    assert.equal(done.output.ok, true, JSON.stringify(done));

    const [record] = cleanups(r);

    const first = defined(record, "cleanup record");

    assert.equal(first.data["fromTree"], beforeTree);
    assert.deepEqual(first.data["trees"], { SC1: earlyTree });

    const stale = await r.run(["status", "show"]);

    assert.deepEqual(
      narrow(stale.value, objectWith({ criteria: arrayOf(isString) })).criteria,
      ["SC2", "contract"]
    );

    const checked = await r.run(["check", "run"]);

    assert.equal(checked.output.ok, true);

    const status = await r.run(["status", "show"]);

    const statusVal = narrow(
      status.value,
      objectWith({
        criteria: arrayOf(isString),
        testCleanup: objectWith({
          from: isString,
          trees: objectWith({ SC1: isString }),
          removed: arrayOf(isString),
          deleted: isNumber,
          merged: isNumber,
        }),
        criterionStatuses: isStatuses,
      })
    );

    assert.deepEqual(statusVal.criteria, []);
    assert.deepEqual(statusVal.testCleanup, {
      from: before,
      trees: { SC1: earlyTree },
      removed: ["SC1"],
      deleted: 2,
      merged: 1,
    });

    const row = defined(
      statusVal.criterionStatuses.find((entry) => entry.criterion === "SC1"),
      "SC1 status"
    );

    assert.equal(row.state, "verified");
    assert.equal(
      row.reason,
      `verified at ${earlyTree}; tests removed in cleanup`
    );

    captureIntegrationReview(r);

    const delivered = await r.run(["worktree", "deliver"]);

    assert.equal(delivered.output.ok, true, JSON.stringify(delivered));

    const report = await r.run(["report", "complete"]);

    assert.equal(report.output.ok, true, JSON.stringify(report));

    const reportVal = narrow(
      report.value,
      objectWith({ path: isString, statuses: isStatuses })
    );

    const walkthrough = fs.readFileSync(
      path.join(r.session, reportVal.path),
      "utf-8"
    );

    assert.ok(
      walkthrough.includes(
        `**Test cleanup:** deleted 2 · merged 1 tests; criteria with tests removed: SC1 at ${earlyTree.slice(0, 12)}`
      )
    );

    const reported = defined(
      reportVal.statuses.find((entry) => entry.criterion === "SC1"),
      "reported SC1"
    );

    assert.equal(reported.state, "verified");
    assert.equal(
      reported.reason,
      `verified at ${earlyTree}; tests removed in cleanup`
    );
  } finally {
    r.cleanup();
  }
});

test("test cleanup commit refuses after a declared, renamed, or undeclared path changed", async () => {
  const cases: { label: string; change: (r: Repo) => void }[] = [
    {
      label: "changes path",
      change: (r) => {
        fs.writeFileSync(
          path.join(r.integration, "src/file.ts"),
          "changed after check\n"
        );
        r.git(["add", "src/file.ts"], r.integration);
        r.git(["commit", "-m", "change src"], r.integration);
      },
    },
    {
      label: "tests path",
      change: (r) => {
        fs.writeFileSync(path.join(r.integration, target), "edited test\n");
        r.git(["add", target], r.integration);
        r.git(["commit", "-m", "change test"], r.integration);
      },
    },
    {
      label: "undeclared path",
      change: (r) => {
        fs.writeFileSync(
          path.join(r.integration, "src/undeclared-helper.ts"),
          "helper\n"
        );
        r.git(["add", "src/undeclared-helper.ts"], r.integration);
        r.git(["commit", "-m", "undeclared helper"], r.integration);
      },
    },
    {
      label: "renamed tests path",
      change: (r) => {
        r.git(["mv", target, "tests/other.test.ts"], r.integration);
        r.git(
          ["commit", "-m", "rename step test to other test"],
          r.integration
        );
        fs.rmSync(path.join(r.integration, "tests/other.test.ts"));
      },
    },
  ];

  await Promise.all(
    cases.map(async ({ label, change }) => {
      const r = await integrated(false, twoCriteriaSource);

      try {
        const scoped = await r.run(["check", "run", "--criteria", "SC1"]);

        assert.equal(scoped.output.ok, true, label);

        change(r);

        const head = r.git(["rev-parse", "HEAD"], r.integration);

        if (label !== "renamed tests path") {
          fs.rmSync(path.join(r.integration, target));
        }

        const refused = await commit(r, removal);

        assert.equal(
          refused.output.reason,
          "test-cleanup-evidence-required",
          label
        );
        assert.match(refused.output.summary, /\bSC1\b/u, label);
        assert.equal(r.git(["rev-parse", "HEAD"], r.integration), head, label);
        assert.equal(cleanups(r).length, 0, label);
      } finally {
        r.cleanup();
      }
    })
  );
});

test("test cleanup commit treats a leading-whitespace path as distinct from a trimmed declared path", async () => {
  const plan = twoCriteriaSource
    .replace(
      "### T2 — Other",
      "### T2 — Other\n#### [NEW] foo.ts\n- Purpose: implements foo."
    )
    .replace(
      "  - Changes: src/other.ts, tests/other.test.ts",
      "  - Changes: foo.ts, src/other.ts, tests/other.test.ts"
    );

  const r = await integrated(false, plan);

  try {
    const scoped = await r.run(["check", "run", "--criteria", "SC1"]);

    assert.equal(scoped.output.ok, true);

    fs.writeFileSync(
      path.join(r.integration, " foo.ts"),
      "undeclared leading space\n"
    );

    r.git(["add", " foo.ts"], r.integration);
    r.git(["commit", "-m", "add leading space file"], r.integration);

    const head = r.git(["rev-parse", "HEAD"], r.integration);

    fs.rmSync(path.join(r.integration, target));

    const refused = await commit(r, removal);

    assert.equal(refused.output.reason, "test-cleanup-evidence-required");
    assert.match(refused.output.summary, /\bSC1\b/u);
    assert.equal(r.git(["rev-parse", "HEAD"], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally {
    r.cleanup();
  }
});

test("test cleanup commit accepts a directory-valued Tests path when a file under it changes", async () => {
  const plan = source.replace(`  - Tests: ${target}`, "  - Tests: tests/");

  const r = await integrated(true, plan);

  try {
    const beforeTree = r.git(["rev-parse", "HEAD^{tree}"], r.integration);

    fs.rmSync(path.join(r.integration, target));

    const done = await commit(r, removal);

    assert.equal(done.output.ok, true, JSON.stringify(done));

    const [record] = cleanups(r);

    assert.deepEqual(defined(record, "cleanup record").data["trees"], {
      SC1: beforeTree,
    });
  } finally {
    r.cleanup();
  }
});
