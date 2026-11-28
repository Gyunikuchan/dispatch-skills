import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
  latest,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  checks as planChecks,
  loadPlan,
} from "../../../skills/dispatch/scripts/toolkit/plan-view.ts";
import { defined } from "../../helpers/guards.ts";
import { fakeGit } from "./helpers/fake-git.ts";
import {
  dictionaryOf,
  flag,
  jsonObject,
  listOf,
  narrow,
  numeric,
  optional,
  parseJson,
  readJson,
  withFields,
  text,
} from "./helpers/json.ts";
import type { JsonObject } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

test("status report exposes bindings approval gate open escalations and torn tail without locking", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("mission.spec.md", "mission");
    const plan = f.artifact("work.plan.md", "plan");

    const append = async (
      kind: string,
      key: string,
      data: unknown,
      by = "orchestrator"
    ) =>
      await appendRecord(
        f.session,
        { kind, key, data, by, ...(by === "user" && { quote: "approved" }) },
        f.deps
      );

    await append("bind", "bind", {
      spec: "mission.spec.md",
      plan: "work.plan.md",
    });
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
    await append("confirm", "confirm", { spec: hashes.spec }, "user");
    await append("approval", "approval", hashes, "user");
    await append("level", "level", { level: "high" });
    await append("escalation", "open-a", {
      id: "a",
      state: "open",
      summary: "first",
    });
    await append("escalation", "close-a", {
      id: "a",
      state: "resolved",
      summary: "done",
    });
    await append("escalation", "open-b", {
      id: "b",
      state: "open",
      summary: "pending",
    });

    const run = async () => {
      f.lines.length = 0;
      assert.equal(
        await main(["status", "show", "--session", f.session], f.deps),
        0
      );

      return readJson(
        defined(f.output().path),
        withFields({
          level: optional(text),
          bound: optional(jsonObject),
          current: optional(jsonObject),
          approved: optional(jsonObject),
          gate: optional(jsonObject),
          escalations: optional(listOf(jsonObject)),
          recordCount: optional(numeric),
          tornTail: optional(flag),
        })
      );
    };

    const report = await run();
    assert.equal(report.level, "high");
    assert.deepEqual(report.bound, {
      spec: "mission.spec.md",
      plan: "work.plan.md",
    });
    assert.deepEqual(report.current, hashes);
    assert.deepEqual(report.approved, hashes);
    assert.deepEqual(report.gate, { allowed: true });
    assert.deepEqual(report.escalations, [
      { id: "b", state: "open", summary: "pending" },
    ]);
    assert.equal(report.recordCount, 7);
    assert.equal(report.tornTail, false);
    fs.writeFileSync(plan, "changed");
    fs.appendFileSync(path.join(f.session, "ledger.jsonl"), "{torn");
    const changed = await run();
    assert.deepEqual(changed.gate, {
      allowed: false,
      reason: "unrecorded-change",
      artifact: "plan",
    });
    assert.equal(changed.tornTail, true);
    assert.equal(changed.recordCount, 7);
    assert.equal(fs.existsSync(path.join(f.session, ".state", "lock")), false);
    assert.ok(
      fs
        .readFileSync(path.join(f.session, "ledger.jsonl"), "utf-8")
        .endsWith("{torn")
    );
  } finally {
    f.cleanup();
  }
});

const PLAN = [
  "# Work",
  "## Task Map",
  "| ID | Title | Outcome | Prerequisites | Criteria |",
  "| --- | --- | --- | --- | --- |",
  "| T1 | File | Works | none | SC1, SC2 |",
  "## Proposed Changes",
  "### T1 \u2014 File",
  "#### [NEW] src/file.ts",
  "- Purpose: behavior.",
  "## Success Criteria",
  "- [SC1] Works",
  "  - Changes: src/file.ts",
  "  - Check: `node check`",
  "  - Evidence: check",
  "- [SC2] Also works",
  "  - Changes: src/file.ts",
  "  - Check: `node check2`",
  "  - Evidence: check",
  "## Verification Plan",
  "### Automated Tests",
  "- `node contract`",
].join("\n");

test("status retains missing automated criteria for manual completions and waivers", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("mission.spec.md", "mission");
    f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );
    const cwd = path.join(f.session, ".state/worktrees/integration");
    fs.mkdirSync(cwd, { recursive: true });

    const head = "a".repeat(40);
    const tree = "b".repeat(40);

    f.deps.run = fakeGit({
      session: f.session,
      head,
      tree,
      testedTree: tree,
      changes: [],
      calls: [],
    });
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: ".state/worktrees/integration",
          branch: "integration",
          base: head,
          dest: { path: f.root, branch: "main" },
        },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "manual-complete",
        key: "manual-complete",
        by: "user",
        quote: "accepted",
        data: { criterion: "SC1", evidence: "reviewed" },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "waiver",
        key: "waiver",
        by: "user",
        quote: "accepted",
        data: { criterion: "SC2", reason: "accepted risk" },
      },
      f.deps
    );
    await main(["status", "show", "--session", f.session], f.deps);

    const value = readJson(
      defined(f.output().path),
      withFields({
        criteria: listOf(text),
        criterionStatuses: listOf(withFields({ criterion: text, state: text })),
      })
    );

    assert.ok(value.criteria.includes("SC1"), JSON.stringify(value));
    assert.ok(value.criteria.includes("SC2"), JSON.stringify(value));
    assert.equal(
      value.criterionStatuses.find((row) => row.criterion === "SC1")?.state,
      "manual"
    );
    assert.equal(
      value.criterionStatuses.find((row) => row.criterion === "SC2")?.state,
      "waived"
    );
  } finally {
    f.cleanup();
  }
});

test("status retains recovery status with broken and missing plan", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("mission.spec.md", "mission");
    const plan = f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "level",
        key: "level",
        by: "orchestrator",
        data: { level: "low" },
      },
      f.deps
    );
    const cwd = path.join(f.session, ".state/worktrees/integration");
    fs.mkdirSync(cwd, { recursive: true });

    const head = "a".repeat(40);
    const tree = "b".repeat(40);

    f.deps.run = fakeGit({
      session: f.session,
      head,
      tree,
      testedTree: tree,
      changes: [],
      calls: [],
    });
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: ".state/worktrees/integration",
          branch: "integration",
          base: head,
          dest: { path: f.root, branch: "main" },
        },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "writer",
        key: "writer",
        by: "tool",
        data: {
          phase: "launched",
          task: "T1",
          path: ".state/worktrees/T1-1",
          base: {
            commit: head,
            seq: 1,
            taskSection: `sha256:${"a".repeat(64)}`,
          },
        },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "escalation",
        key: "blocked",
        by: "orchestrator",
        data: { id: "E1", state: "open", summary: "Recovery needed" },
      },
      f.deps
    );
    await main(["status", "show", "--session", f.session], f.deps);

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const before = JSON.parse(
      fs.readFileSync(defined(f.output().path), "utf-8")
    );

    // Check broken plan behavior
    f.lines.length = 0;
    fs.writeFileSync(plan, "# Broken plan\n");
    assert.equal(
      await main(["status", "show", "--session", f.session], f.deps),
      0
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const broken = JSON.parse(
      fs.readFileSync(defined(f.output().path), "utf-8")
    );

    for (const field of ["level", "bound", "escalations", "recordCount"]) {
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.deepEqual(broken[field], before[field], field);
    }

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(broken.writers.state, "unavailable");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(broken.criteria.state, "unavailable");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.ok(broken.writers.reason.length > 0);
    assert.match(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      broken.criteria.reason,
      /defect|missing|required|task|section/iu
    );

    // Check missing plan behavior
    f.lines.length = 0;
    fs.rmSync(plan);
    assert.equal(
      await main(["status", "show", "--session", f.session], f.deps),
      0
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const missing = JSON.parse(
      fs.readFileSync(defined(f.output().path), "utf-8")
    );

    for (const field of ["level", "bound", "escalations", "recordCount"]) {
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.deepEqual(missing[field], before[field], field);
    }

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(missing.writers.state, "unavailable");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(missing.criteria.state, "unavailable");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.ok(missing.writers.reason.length > 0);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(missing.current.plan, null);
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.match(missing.criteria.reason, /unreadable/u);
  } finally {
    f.cleanup();
  }
});

test("uncommitted consumers report the delivery source as not yet delivered", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("mission.spec.md", "mission");
    f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        by: "tool",
        key: "bind",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );

    const source = "a".repeat(40);
    const dest = { path: f.root, branch: "main" };
    const relative = ".state/worktrees/integration";

    fs.mkdirSync(path.join(f.session, relative), { recursive: true });

    const state = {
      session: f.session,
      head: source,
      tree: "b".repeat(40),
      testedTree: "b".repeat(40),
      changes: [],
      calls: [],
    };

    f.deps.run = fakeGit(state);
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        by: "tool",
        data: {
          phase: "opened",
          path: relative,
          branch: "integration",
          base: "f".repeat(40),
          dest,
        },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        by: "tool",
        data: {
          phase: "delivered",
          mode: "uncommitted",
          dest,
          from: "f".repeat(40),
          source,
        },
      },
      f.deps
    );
    f.lines.length = 0;
    assert.equal(
      await main(["status", "show", "--session", f.session], f.deps),
      0
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const { integration } = JSON.parse(
      fs.readFileSync(defined(f.output().path), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(integration.source, source);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(integration.undelivered, false);
  } finally {
    f.cleanup();
  }
});

const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

test("status budget and coverage admission reflect rulings and open slots", async () => {
  // status budget reflects rulings after completion
  {
    const f = sessionFixture({ memory: true });

    try {
      const review = "plan-work.plan";
      const directory = path.join(f.session, ".state/reviews", review);

      for (const round of [1, 2]) {
        fs.mkdirSync(path.join(directory, `round-${round}`), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(directory, `round-${round}`, "round.json"),
          JSON.stringify({ round, cap: 2, startSeq: 0 })
        );
        fs.writeFileSync(
          path.join(directory, `round-${round}`, "findings.json"),
          JSON.stringify({
            review,
            round,
            cap: 2,
            findings:
              round === 2
                ? [{ id: "R2-F001", severity: "MUST", sources: [] }]
                : [],
          })
        );
      }

      const budget = async () => {
        f.lines.length = 0;
        assert.equal(
          await main(["status", "show", "--session", f.session], f.deps),
          0
        );

        return readJson(
          defined(f.output().path),
          withFields({ reviews: dictionaryOf(jsonObject) })
        ).reviews[review];
      };

      assert.deepEqual(await budget(), {
        cap: 2,
        ceiling: 4,
        nextRound: 3,
        asOfSeq: 0,
        state: "requires-continuation",
      });
      await appendRecord(
        f.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "ruling-accepted",
          data: {
            subject: `review:${review}:R2-F001`,
            ruling: "accepted",
            rationale: "Fixed",
          },
        },
        f.deps
      );
      assert.deepEqual(await budget(), {
        cap: 2,
        ceiling: 4,
        nextRound: 3,
        asOfSeq: 1,
        state: "allowed",
      });
    } finally {
      f.cleanup();
    }
  }

  // status reports coverage admission for open and unreadable slots
  {
    const f = sessionFixture({ memory: true });

    try {
      const review = "code-integration";

      const directory = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1"
      );

      const roster = ["codex[0]", "opencode[1]"].map((slot, index) => ({
        slot,
        provider: "codex",
        index,
        reserve: false,
      }));

      write(path.join(directory, "round.json"), {
        round: 1,
        generation: 1,
        cap: 1,
        scope: "Full review",
        startSeq: 0,
        spec: { path: "/spec.md", hash: `sha256:${"a".repeat(64)}` },
        target: { base: "b", head: "h" },
        roster,
      });
      write(path.join(directory, "gen-1/slots/opencode[1].json"), {
        slot: "opencode[1]",
        state: "done",
        text: "report",
      });
      write(path.join(directory, "gen-1/slots/codex[0].json"), {
        slot: "codex[0]",
        state: "failed",
        cls: "timeout",
        reason: "slow",
      });
      write(path.join(directory, "findings.json"), {
        review,
        round: 1,
        cap: 1,
        findings: [],
      });

      const budget = async () => {
        f.lines.length = 0;
        assert.equal(
          await main(["status", "show", "--session", f.session], f.deps),
          0
        );

        return readJson(
          defined(f.output().path),
          withFields({ reviews: dictionaryOf(jsonObject) })
        ).reviews[review];
      };

      // An entry-less failure cannot be ordered, so coverage is unreadable but status still answers.
      assert.deepEqual(await budget(), {
        cap: 1,
        ceiling: 3,
        nextRound: 2,
        asOfSeq: 0,
        state: "requires-continuation",
        coverage: { state: "unreadable" },
      });
      write(path.join(directory, "gen-1/attempts.json"), [
        { slot: "codex[0]", seq: 0, wholeTarget: true, outcome: "timeout" },
      ]);
      assert.deepEqual(await budget(), {
        cap: 1,
        ceiling: 3,
        nextRound: 2,
        asOfSeq: 0,
        state: "allowed",
        coverage: {
          state: "readable",
          open: ["codex[0]"],
          decision: "rerun",
          use: "free",
        },
      });
    } finally {
      f.cleanup();
    }
  }
});

test("statusReport reflects latest strict criterion evidence across pass-fail-pass", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("mission.spec.md", "mission");
    f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );
    const cwd = path.join(f.session, ".state/worktrees/integration");
    fs.mkdirSync(cwd, { recursive: true });

    const head = "a".repeat(40);
    const tree = "b".repeat(40);

    f.deps.run = fakeGit({
      session: f.session,
      head,
      tree,
      testedTree: tree,
      changes: [],
      calls: [],
    });
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: ".state/worktrees/integration",
          branch: "integration",
          base: head,
          dest: { path: f.root, branch: "main" },
        },
      },
      f.deps
    );

    const sc1 = defined(
      planChecks(loadPlan(f.session, readManifest(f.session))).find(
        (row) => row.criterion === "SC1"
      )
    );

    const appendEv = async (seqTag: string, exit: number) =>
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          key: `sc1-${seqTag}`,
          by: "tool",
          data: {
            criterion: "SC1",
            commandDigest: sc1.commandDigest,
            tree,
            clean: true,
            before: tree,
            after: tree,
            exit,
            path: `.state/evidence/${seqTag}.json`,
          },
        },
        f.deps
      );

    const readStatus = async () => {
      f.lines.length = 0;
      assert.equal(
        await main(["status", "show", "--session", f.session], f.deps),
        0
      );

      const report = readJson(
        defined(f.output().path),
        withFields({
          criteria: listOf(text),
          criterionStatuses: listOf(
            withFields({ criterion: text, state: text })
          ),
        })
      );

      return {
        state: report.criterionStatuses.find((row) => row.criterion === "SC1")
          ?.state,
        needsCheck: report.criteria.includes("SC1"),
      };
    };

    await appendEv("pass-1", 0);
    assert.deepEqual(await readStatus(), {
      state: "verified",
      needsCheck: false,
    });
    await appendEv("fail-1", 1);
    assert.deepEqual(await readStatus(), {
      state: "missing",
      needsCheck: true,
    });
    await appendEv("pass-2", 0);
    assert.deepEqual(await readStatus(), {
      state: "verified",
      needsCheck: false,
    });
  } finally {
    f.cleanup();
  }
});

test("compact status reports plan-pending before binding, including an absent ledger, and keeps torn ledgers unreadable", async () => {
  const f = sessionFixture({ memory: true });

  try {
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")),
      {
        next: "continue",
        reason: "plan-pending",
        action: "plan",
      }
    );
    f.lines.length = 0;
    await appendRecord(
      f.session,
      {
        kind: "note",
        key: "retained",
        by: "tool",
        data: { text: "Session retained" },
      },
      f.deps
    );
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );

    assert.deepEqual(
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")),
      {
        next: "continue",
        reason: "plan-pending",
        action: "plan",
      }
    );

    f.lines.length = 0;
    f.artifact("mission.spec.md", "mission");
    f.artifact("work.design.md", "design");
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind-spec-design",
        by: "tool",
        data: { spec: "mission.spec.md", design: "work.design.md" },
      },
      f.deps
    );
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")),
      {
        next: "continue",
        reason: "plan-pending",
        action: "plan",
      }
    );

    f.lines.length = 0;
    fs.appendFileSync(path.join(f.session, "ledger.jsonl"), "{torn");
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")),
      {
        next: "inspect",
        reason: "state-unreadable",
        action: "status show",
      }
    );
  } finally {
    f.cleanup();
  }
});

test("cleanup checkpoints bind to their opening and require a clean descendant and intact proof", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const relative = ".state/worktrees/integration";
    fs.mkdirSync(path.join(f.session, relative), { recursive: true });

    const base = "a".repeat(40);
    const first = "b".repeat(40);
    const second = "c".repeat(40);
    const tree = "d".repeat(40);

    const dest = { path: f.root, branch: "main" };

    const open = async (key: string) =>
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          key,
          by: "tool",
          data: {
            phase: "opened",
            path: relative,
            branch: "integration",
            base,
            dest,
          },
        },
        f.deps
      );

    const opening = await open("opened-first");

    let head = first;
    let dirty = false;
    let diverged = false;

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = ([, ...args]) => {
      let stdout = "";
      let exit = 0;

      if (args[0] === "rev-parse") {
        stdout = args[1] === "HEAD" ? head : tree;
      } else if (args[0] === "diff") {
        stdout = args.includes("--no-renames")
          ? "src/former.ts\0docs/renamed.md\0"
          : "docs/renamed.md\0";
      } else if (args[0] === "merge-base") {
        exit = diverged ? 1 : 0;
      } else if (args[0] === "--no-optional-locks") {
        stdout = dirty ? "?? dirty.md\n" : "";
      } else {
        assert.fail(JSON.stringify(args));
      }

      return Promise.resolve({ exit, stdout, stderr: "" });
    };

    const status = async () => {
      f.lines.length = 0;
      assert.equal(
        await main(
          ["status", "show", "--resume", "--session", f.session],
          f.deps
        ),
        0
      );

      return readJson(
        defined(f.output().path),
        withFields({ cleanup: optional(text) })
      ).cleanup;
    };

    const checkpoint = async (mode: string, value: JsonObject, exit = 0) => {
      f.lines.length = 0;
      assert.equal(
        await main(
          ["ledger", "append", "-", "--cleanup", mode, "--session", f.session],
          {
            ...f.deps,
            readStdin: () => JSON.stringify(value),
          }
        ),
        exit
      );
    };

    assert.equal(await status(), "unbound");
    await checkpoint("skip", { head: first });
    const skip = defined(latest(foldLedger(f.session), "note"));
    assert.equal(skip.key, `test-cleanup:skip:${opening.seq}:${first}`);
    assert.deepEqual(parseJson(narrow(skip.data["text"], text), jsonObject), {
      openingSeq: opening.seq,
      head: first,
      tree,
      paths: ["docs/renamed.md", "src/former.ts"],
    });
    assert.equal(await status(), "checkpoint");

    head = second;
    assert.equal(await status(), "checkpoint");
    await checkpoint("skip", { head: first }, 4);
    dirty = true;
    assert.equal(await status(), "unbound");
    await checkpoint("skip", { head: second }, 4);
    dirty = false;
    diverged = true;
    assert.equal(await status(), "unbound");
    diverged = false;

    await checkpoint("skip", { head: second });
    assert.equal(
      defined(latest(foldLedger(f.session), "note")).key,
      `test-cleanup:skip:${opening.seq}:${second}`
    );
    const report = { removed: [], deleted: 0, merged: 0 };
    await checkpoint("zero", { head, report: { ...report, merged: 1 } }, 1);
    await checkpoint("zero", { head, report });
    assert.equal(await status(), "checkpoint");
    fs.appendFileSync(path.join(f.session, ".state/test-cleanup.json"), " ");
    assert.equal(await status(), "unbound");
    await open("opened-next");
    assert.equal(await status(), "unbound");
    head = base;
    await checkpoint("skip", { head: base });
    assert.deepEqual(
      parseJson(
        narrow(
          defined(latest(foldLedger(f.session), "note")).data["text"],
          text
        ),
        withFields({ paths: listOf(text) })
      ).paths,
      []
    );
    assert.equal(await status(), "checkpoint");
  } finally {
    f.cleanup();
  }
});

test("compact status points to the active round as history grows and rejects unreadable pointers", async (t) => {
  const f = sessionFixture();

  try {
    f.deps.skillRoot = path.join(f.root, "isolated-skill");

    const base = "a".repeat(40);
    const head = "b".repeat(40);

    const specPath = f.artifact("mission.spec.md", "# Mission");
    f.artifact("work.plan.md", PLAN);

    const append = async (
      kind: string,
      key: string,
      data: JsonObject,
      by = "tool"
    ) =>
      await appendRecord(
        f.session,
        { kind, key, by, data, ...(by === "user" && { quote: "confirmed" }) },
        f.deps
      );

    await append("bind", "bind", {
      spec: "mission.spec.md",
      plan: "work.plan.md",
    });
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
    await append("level", "level", { level: "low" });
    await append("confirm", "confirm", { spec: hashes.spec }, "user");
    const relative = ".state/worktrees/integration";
    fs.mkdirSync(path.join(f.session, relative), { recursive: true });
    await append("integrate", "opened", {
      phase: "opened",
      path: relative,
      branch: "integration",
      base,
      dest: { path: f.root, branch: "main" },
    });
    await append("integrate", "done", {
      phase: "done",
      task: "T1",
      commit: head,
    });
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = ([, ...args]) => {
      let stdout: string;

      if (args[0] === "diff" && args[1] === "--name-only") {
        stdout = "src/file.ts\0";
      } else if (args[0] === "rev-parse") {
        stdout = head;
      } else {
        stdout = "";
      }

      return Promise.resolve({
        exit: 0,
        stdout,
        stderr: "",
      });
    };

    const series = ".state/reviews/code-integration";

    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const write = (relative: string, value: unknown) => {
      const file = path.join(f.session, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));

      return file;
    };

    const status = async (compact: boolean) => {
      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "status",
            "show",
            ...(compact ? ["--resume"] : []),
            "--session",
            f.session,
          ],
          f.deps
        ),
        0
      );
      const bytes = fs.readFileSync(defined(f.output().path));

      return {
        bytes: bytes.length,
        // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
        value: JSON.parse(bytes.toString("utf-8")),
      };
    };

    const slot = "codex[0]";

    let prefix = "";
    let roundFile = "";

    const metadata = {
      round: 0,
      generation: 1,
      cap: 40,
      level: "low",
      pins: null,
      startSeq: 0,
      scope: "Full review",
      spec: { path: fs.realpathSync.native(specPath), hash: hashes.spec },
      artifacts: hashes,
      target: { base, head },
      roster: [
        { slot, provider: "codex", index: 0, native: true, reserve: false },
        {
          slot: "agy[0]",
          provider: "agy",
          index: 0,
          native: false,
          reserve: false,
        },
        {
          slot: "claude[0]",
          provider: "claude",
          index: 0,
          native: true,
          reserve: true,
        },
      ],
    };

    const sizes: { rounds: number; compact: number; detailed: number }[] = [];

    for (let number = 1; number <= 20; number += 1) {
      if (number > 1) {
        write(`${prefix}/findings.json`, {
          review: "code-integration",
          round: number - 1,
          findings: [],
          failed: [],
        });
      }

      prefix = `${series}/round-${number}`;
      roundFile = `${prefix}/round.json`;
      write(roundFile, { ...metadata, round: number });
      write(`${prefix}/gen-1/checkout-report.json`, {
        asOfSeq: 5,
        repositoryChanges: [
          { cwd: f.root, paths: ["a-path-changed-during-review.md"] },
        ],
      });

      if (![1, 5, 20].includes(number)) {
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const compact = await status(true);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const details = await status(false);

      assert.deepEqual(compact.value, {
        next: "review",
        reason: "round-pending",
        action: "review run",
        round: roundFile,
        cleanup: "unbound",
      });
      assert.ok(compact.bytes <= 2048);
      sizes.push({
        rounds: number,
        compact: compact.bytes,
        detailed: details.bytes,
      });
    }

    assert.ok(
      defined(sizes[2]).compact < defined(sizes[2]).detailed,
      JSON.stringify(sizes)
    );

    const prefixBytes = sizes
      .map(
        ({ rounds, compact, detailed }) => `${rounds}: ${compact}/${detailed}`
      )
      .join(", ");

    assert.ok(
      defined(sizes[0]).detailed < defined(sizes[2]).detailed,
      prefixBytes
    );
    t.diagnostic(
      `Round count and compact/detailed UTF-8 bytes — ${prefixBytes}`
    );

    const nativePath = `${prefix}/gen-1/slots/${slot}.json`;

    const reply = path.join(
      f.session,
      prefix,
      "gen-1/replies",
      `${slot}.abcdef.md`
    );

    fs.mkdirSync(path.dirname(reply), { recursive: true });

    const pending = {
      slot,
      state: "native",
      provider: "codex",
      attempt: `${slot}#abcdef`,
      replyPath: reply,
    };

    write(nativePath, pending);
    const statusResult = await status(true);

    assert.deepEqual(statusResult.value, {
      next: "inspect",
      reason: "native-pending",
      action: "review run",
      round: roundFile,
      evidence: nativePath,
      cleanup: "unbound",
    });

    const unreadable = {
      next: "inspect",
      reason: "state-unreadable",
      action: "status show",
      cleanup: "unbound",
    };

    write(nativePath, {
      ...pending,
      provider: "agy",
      attempt: "agy[0]#abcdef",
    });
    const statusResult2 = await status(true);

    assert.deepEqual(statusResult2.value, unreadable);

    const reserve = {
      ...pending,
      provider: "claude",
      attempt: "claude[0]#abcdef",
    };

    write(nativePath, reserve);
    const statusResult3 = await status(true);

    assert.deepEqual(statusResult3.value, unreadable);
    write(`${prefix}/gen-1/fanout.json`, { reserveUsedBy: slot });
    const statusResult4 = await status(true);

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(statusResult4.value.reason, "native-pending");
    write(nativePath, {
      ...pending,
      replyPath: path.join(f.root, "outside.md"),
    });
    const statusResult5 = await status(true);

    assert.deepEqual(statusResult5.value, unreadable);
    fs.unlinkSync(path.join(f.session, nativePath));
    const slotsDir = path.dirname(path.join(f.session, nativePath));
    fs.rmdirSync(slotsDir);
    const externalSlots = path.join(f.root, "external-slots");
    fs.mkdirSync(externalSlots);
    fs.symlinkSync(externalSlots, slotsDir, "junction");
    fs.rmdirSync(externalSlots);
    const statusResult6 = await status(true);

    assert.deepEqual(statusResult6.value, unreadable);
    fs.unlinkSync(slotsDir);
    const olderFindings = `${series}/round-19/findings.json`;
    write(olderFindings, {
      review: "code-integration",
      round: 19,
      failed: [],
      findings: [{ id: "R19-F001", severity: "SHOULD" }],
    });
    const statusResult7 = await status(true);

    assert.deepEqual(statusResult7.value, {
      next: "adjudicate",
      reason: "findings-pending",
      action: "adjudicate",
      evidence: olderFindings,
      cleanup: "unbound",
    });
    write(olderFindings, {
      review: "code-integration",
      round: 19,
      failed: [],
      findings: [],
    });

    write(roundFile, { ...metadata, round: 20, level: "xhigh" });
    const statusResult8 = await status(true);

    assert.deepEqual(statusResult8.value, {
      next: "inspect",
      reason: "gate-blocked",
      action: "status show",
      cleanup: "unbound",
    });
    write(roundFile, { ...metadata, round: 20 });

    const findingsFile = `${prefix}/findings.json`;
    write(findingsFile, {
      review: "code-integration",
      round: 20,
      failed: ["agy[0]"],
      findings: [],
    });
    write(nativePath, {
      slot,
      state: "done",
      text: '{"status":"CLEAN","findings":[]}',
    });
    write(`${prefix}/gen-1/slots/agy[0].json`, {
      slot: "agy[0]",
      state: "failed",
      cls: "timeout",
      reason: "slow",
    });
    write(`${prefix}/gen-1/attempts.json`, [
      { slot: "agy[0]", seq: 5, wholeTarget: true, outcome: "timeout" },
    ]);
    const statusResult9 = await status(true);

    assert.deepEqual(statusResult9.value, {
      next: "review",
      reason: "review-required",
      action: "review run",
      round: roundFile,
      cleanup: "unbound",
    });
    fs.unlinkSync(path.join(f.session, findingsFile));

    write(roundFile, { ...metadata, round: 20, pins: undefined });
    const statusResult10 = await status(true);

    assert.deepEqual(statusResult10.value, {
      next: "inspect",
      reason: "arguments-unavailable",
      action: "arguments",
      round: roundFile,
      cleanup: "unbound",
    });
    write(roundFile, { ...metadata, round: 20, pins: ["codex"] });
    const statusResult11 = await status(true);

    assert.deepEqual(statusResult11.value, unreadable);
    fs.writeFileSync(path.join(f.session, roundFile), "{invalid");
    const statusResult12 = await status(true);

    assert.deepEqual(statusResult12.value, unreadable);
    fs.rmSync(path.join(f.session, prefix), { recursive: true });
    const outside = path.join(f.root, "outside-round");
    fs.mkdirSync(outside);
    fs.writeFileSync(
      path.join(outside, "round.json"),
      JSON.stringify({ ...metadata, round: 20 })
    );
    fs.symlinkSync(outside, path.join(f.session, prefix), "junction");
    const statusResult13 = await status(true);

    assert.deepEqual(statusResult13.value, unreadable);
  } finally {
    f.cleanup();
  }
});

const resumeCompact = async (f: ReturnType<typeof sessionFixture>) => {
  f.lines.length = 0;
  assert.equal(
    await main(["status", "show", "--resume", "--session", f.session], f.deps),
    0
  );

  return readJson(defined(f.output().path), jsonObject);
};

const setupLowOpened = async (f: ReturnType<typeof sessionFixture>) => {
  f.artifact("mission.spec.md", "mission");
  const planFile = f.artifact("work.plan.md", PLAN);
  await appendRecord(
    f.session,
    {
      kind: "bind",
      key: "bind",
      by: "tool",
      data: { spec: "mission.spec.md", plan: "work.plan.md" },
    },
    f.deps
  );
  const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
  await appendRecord(
    f.session,
    {
      kind: "level",
      key: "level",
      by: "orchestrator",
      data: { level: "low" },
    },
    f.deps
  );
  await appendRecord(
    f.session,
    {
      kind: "confirm",
      key: "confirm",
      by: "user",
      quote: "confirmed",
      data: { spec: hashes.spec },
    },
    f.deps
  );
  const integrationDir = path.join(f.session, ".state/worktrees/integration");
  fs.mkdirSync(integrationDir, { recursive: true });
  const head = "a".repeat(40);
  const tree = "b".repeat(40);
  f.deps.run = fakeGit({
    session: f.session,
    head,
    tree,
    testedTree: tree,
    changes: [],
    calls: [],
  });
  await appendRecord(
    f.session,
    {
      kind: "integrate",
      key: "opened",
      by: "tool",
      data: {
        phase: "opened",
        path: ".state/worktrees/integration",
        branch: "integration",
        base: head,
        dest: { path: f.root, branch: "main" },
      },
    },
    f.deps
  );

  return { planFile, integrationDir };
};

const pathVariant = (
  f: ReturnType<typeof sessionFixture>,
  tag: string,
  kind: "absolute" | "traversing" | "symlink"
) => {
  if (kind === "absolute") {
    return path.join(f.root, `outside-${tag}`);
  }

  if (kind === "traversing") {
    return `../../outside-${tag}`;
  }

  const symlinkTarget = path.join(f.root, `symlink-target-${tag}`);
  fs.mkdirSync(symlinkTarget, { recursive: true });
  const symlinkRel = `.state/worktrees/link-${tag}`;
  const symlinkFull = path.join(f.session, symlinkRel);
  fs.mkdirSync(path.dirname(symlinkFull), { recursive: true });
  fs.symlinkSync(symlinkTarget, symlinkFull, "junction");

  return symlinkRel;
};

const checkTerminalResumeState = async (
  terminal: "deliver-started" | "delivered" | "committed" | "closed"
) => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("mission.spec.md", "mission");
    f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );

    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));

    await appendRecord(
      f.session,
      {
        kind: "confirm",
        key: "confirm",
        by: "user",
        quote: "confirmed",
        data: { spec: hashes.spec },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "approval",
        key: "approval",
        by: "user",
        quote: "approved",
        data: hashes,
      },
      f.deps
    );

    const base = "a".repeat(40);
    const source = "b".repeat(40);
    const commitHash = "c".repeat(40);
    const dest = { path: f.root, branch: "main" };

    const integrationDir = path.join(f.session, ".state/worktrees/integration");

    fs.mkdirSync(integrationDir, { recursive: true });
    const gitCalls: string[][] = [];

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = (argv) => {
      gitCalls.push(argv);

      return Promise.resolve({
        exit: 0,
        stdout: `${source}\n`,
        stderr: "",
      });
    };

    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: ".state/worktrees/integration",
          branch: "integration",
          base,
          dest,
        },
      },
      f.deps
    );

    if (terminal === "deliver-started") {
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          key: "deliver-started",
          by: "tool",
          data: {
            phase: "deliver-started",
            mode: "uncommitted",
            dest,
            from: base,
            source,
          },
        },
        f.deps
      );
      assert.deepEqual(await resumeCompact(f), {
        next: "continue",
        reason: "delivery-pending",
        action: "worktree deliver",
        cleanup: "unbound",
      });
    } else if (terminal === "delivered") {
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          key: "delivered",
          by: "tool",
          data: {
            phase: "delivered",
            mode: "uncommitted",
            dest,
            from: base,
            source,
          },
        },
        f.deps
      );
      assert.deepEqual(await resumeCompact(f), {
        next: "continue",
        reason: "delivered",
        action: "report complete",
        cleanup: "unbound",
      });

      fs.rmSync(integrationDir, { recursive: true, force: true });
      f.lines.length = 0;
      assert.equal(
        await main(["status", "show", "--session", f.session], f.deps),
        0
      );

      const detailed = readJson(
        defined(f.output().path),
        withFields({ integration: withFields({ state: text }) })
      );

      assert.equal(detailed.integration.state, "missing");
      assert.deepEqual(await resumeCompact(f), {
        next: "continue",
        reason: "delivered",
        action: "report complete",
        cleanup: "unbound",
      });
    } else if (terminal === "committed") {
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          key: "delivered",
          by: "tool",
          data: {
            phase: "delivered",
            mode: "uncommitted",
            dest,
            from: base,
            source,
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          key: "committed",
          by: "tool",
          data: { phase: "committed", commit: commitHash, source },
        },
        f.deps
      );
      assert.deepEqual(await resumeCompact(f), {
        next: "continue",
        reason: "delivered",
        action: "report complete",
        cleanup: "unbound",
      });
    } else {
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          key: "closed",
          by: "tool",
          data: { phase: "closed", reason: "Session complete" },
        },
        f.deps
      );
      assert.deepEqual(await resumeCompact(f), {
        next: "inspect",
        reason: "closed",
        action: "worktree cleanup",
        cleanup: "unbound",
      });
    }

    assert.deepEqual(gitCalls, []);
  } finally {
    f.cleanup();
  }
};

test("compact status distinguishes pre-integration approval, baseline, and terminal integration states", async () => {
  // Pre-integration: approval-pending then baseline-pending
  {
    const f = sessionFixture({ memory: true });

    try {
      f.artifact("mission.spec.md", "mission");
      f.artifact("work.plan.md", PLAN);
      await appendRecord(
        f.session,
        {
          kind: "bind",
          key: "bind",
          by: "tool",
          data: { spec: "mission.spec.md", plan: "work.plan.md" },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "level",
          key: "level",
          by: "orchestrator",
          data: { level: "medium" },
        },
        f.deps
      );

      assert.deepEqual(await resumeCompact(f), {
        next: "inspect",
        reason: "approval-pending",
        action: "approval",
      });

      const hashes = currentHashes(
        f.root,
        latest(foldLedger(f.session), "bind")
      );

      await appendRecord(
        f.session,
        {
          kind: "confirm",
          key: "confirm",
          by: "user",
          quote: "confirmed",
          data: { spec: hashes.spec },
        },
        f.deps
      );
      assert.deepEqual(await resumeCompact(f), {
        next: "inspect",
        reason: "approval-pending",
        action: "approval",
      });

      await appendRecord(
        f.session,
        {
          kind: "approval",
          key: "approval",
          by: "user",
          quote: "approved",
          data: hashes,
        },
        f.deps
      );
      assert.deepEqual(await resumeCompact(f), {
        next: "continue",
        reason: "baseline-pending",
        action: "check run",
      });
    } finally {
      f.cleanup();
    }
  }

  // Terminal integration states run sequentially because memoryNodeFs hooks global fs.
  await checkTerminalResumeState("deliver-started");
  await checkTerminalResumeState("delivered");
  await checkTerminalResumeState("committed");
  await checkTerminalResumeState("closed");
});

test("compact status rejects missing integration worktree and missing or unparsable bound plan after opening at low level", async () => {
  {
    const f = sessionFixture({ memory: true });

    try {
      const { planFile } = await setupLowOpened(f);
      fs.writeFileSync(planFile, "# Broken plan\n");
      assert.deepEqual(await resumeCompact(f), {
        next: "inspect",
        reason: "state-unreadable",
        action: "status show",
        cleanup: "unbound",
      });
      fs.rmSync(planFile);
      assert.deepEqual(await resumeCompact(f), {
        next: "inspect",
        reason: "state-unreadable",
        action: "status show",
        cleanup: "unbound",
      });
    } finally {
      f.cleanup();
    }
  }

  {
    const f = sessionFixture({ memory: true });

    try {
      const { integrationDir } = await setupLowOpened(f);
      fs.rmSync(integrationDir, { recursive: true, force: true });
      assert.deepEqual(await resumeCompact(f), {
        next: "inspect",
        reason: "state-unreadable",
        action: "status show",
        cleanup: "unbound",
      });
    } finally {
      f.cleanup();
    }
  }
});

test("resume filters review-class criteria so automated verification reaches review-pending", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const planWithReview = [
      "# Work",
      "## Task Map",
      "| ID | Title | Outcome | Prerequisites | Criteria |",
      "| --- | --- | --- | --- | --- |",
      "| T1 | File | Works | none | SC1, SC2 |",
      "## Proposed Changes",
      "### T1 \u2014 File",
      "#### [NEW] src/file.ts",
      "- Purpose: behavior.",
      "## Success Criteria",
      "- [SC1] Automated check",
      "  - Changes: src/file.ts",
      "  - Check: `node check`",
      "  - Evidence: check",
      "- [SC2] Review only criterion",
      "  - Changes: src/file.ts",
      "  - Review: check design intent",
      "  - Evidence: review",
      "## Verification Plan",
      "### Automated Tests",
      "- `node contract`",
    ].join("\n");

    f.artifact("mission.spec.md", "mission");
    f.artifact("work.plan.md", planWithReview);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
    await appendRecord(
      f.session,
      {
        kind: "confirm",
        key: "confirm",
        by: "user",
        quote: "confirmed",
        data: { spec: hashes.spec },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "approval",
        key: "approval",
        by: "user",
        quote: "approved",
        data: hashes,
      },
      f.deps
    );

    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const tree = "c".repeat(40);
    const integrationDir = path.join(f.session, ".state/worktrees/integration");
    fs.mkdirSync(integrationDir, { recursive: true });

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = ([, ...args]) => {
      let stdout = "";

      if (args[0] === "rev-parse") {
        stdout = args[1] === "HEAD" ? `${head}\n` : `${tree}\n`;
      } else if (args[0] === "write-tree") {
        stdout = `${tree}\n`;
      } else if (args[0] === "diff") {
        stdout = "";
      } else if (args[0] === "merge-base") {
        return Promise.resolve({ exit: 0, stdout: "", stderr: "" });
      } else if (args[0] === "--no-optional-locks") {
        stdout = "";
      }

      return Promise.resolve({ exit: 0, stdout, stderr: "" });
    };

    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: ".state/worktrees/integration",
          branch: "integration",
          base,
          dest: { path: f.root, branch: "main" },
        },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "writer",
        key: "launched",
        by: "tool",
        data: {
          phase: "launched",
          task: "T1",
          path: ".state/worktrees/T1-1",
          base: {
            commit: base,
            seq: 1,
            taskSection: `sha256:${"a".repeat(64)}`,
          },
        },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "writer",
        key: "finished",
        by: "tool",
        data: { phase: "finished", task: "T1", launch: 1, candidate: head },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "done",
        by: "tool",
        data: { phase: "done", task: "T1", commit: head },
      },
      f.deps
    );

    const allChecks = planChecks(loadPlan(f.session, readManifest(f.session)));

    for (const check of allChecks.filter((c) => c.evidenceClass !== "review")) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential ledger appends maintain distinct seq order
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          key: `ev-${check.criterion}`,
          by: "tool",
          data: {
            criterion: check.criterion,
            commandDigest: check.commandDigest,
            tree,
            clean: true,
            before: tree,
            after: tree,
            exit: 0,
            path: `.state/evidence/${check.criterion}.json`,
          },
        },
        f.deps
      );
    }

    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "verification",
        by: "orchestrator",
        data: {
          phase: "verification",
          cycle: 1,
          outcome: "no-op",
          head,
          reason: "verified",
          open: [],
        },
      },
      f.deps
    );
    await main(
      ["ledger", "append", "-", "--cleanup", "skip", "--session", f.session],
      { ...f.deps, readStdin: () => JSON.stringify({ head }) }
    );

    f.lines.length = 0;
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")),
      {
        next: "review",
        reason: "review-pending",
        action: "review run",
        cleanup: "checkpoint",
      }
    );
  } finally {
    f.cleanup();
  }
});

const checkEscapingWriterPath = async (
  kind: "absolute" | "traversing" | "symlink"
) => {
  const f = sessionFixture({ memory: kind !== "symlink" });

  try {
    const stored = pathVariant(f, `writer-${kind}`, kind);

    f.artifact("mission.spec.md", "mission");
    f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );

    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));

    await appendRecord(
      f.session,
      {
        kind: "confirm",
        key: "confirm",
        by: "user",
        quote: "confirmed",
        data: { spec: hashes.spec },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "approval",
        key: "approval",
        by: "user",
        quote: "approved",
        data: hashes,
      },
      f.deps
    );

    const base = "a".repeat(40);
    const tree = "b".repeat(40);

    const integrationDir = path.join(f.session, ".state/worktrees/integration");

    fs.mkdirSync(integrationDir, { recursive: true });

    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: ".state/worktrees/integration",
          branch: "integration",
          base,
          dest: { path: f.root, branch: "main" },
        },
      },
      f.deps
    );

    const realSession = fs.realpathSync(f.session);
    const cwds: string[] = [];

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = ([, ...args], options) => {
      cwds.push(options.cwd);

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return Promise.resolve({
          exit: 0,
          stdout: `${base}\n`,
          stderr: "",
        });
      }

      if (args[0] === "rev-parse" || args[0] === "write-tree") {
        return Promise.resolve({
          exit: 0,
          stdout: `${tree}\n`,
          stderr: "",
        });
      }

      return Promise.resolve({ exit: 0, stdout: "", stderr: "" });
    };

    await appendRecord(
      f.session,
      {
        kind: "writer",
        key: `launched-${kind}`,
        by: "tool",
        data: {
          phase: "launched",
          task: "T1",
          path: stored,
          base: {
            commit: base,
            seq: 1,
            taskSection: `sha256:${"a".repeat(64)}`,
          },
        },
      },
      f.deps
    );

    f.lines.length = 0;
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")),
      {
        next: "inspect",
        reason: "state-unreadable",
        action: "status show",
        cleanup: "unbound",
      }
    );

    f.lines.length = 0;
    assert.equal(
      await main(["status", "show", "--session", f.session], f.deps),
      0
    );

    const detailed = readJson(
      defined(f.output().path),
      withFields({
        writers: withFields({ state: text, reason: text }),
        integration: withFields({ state: text }),
        criteria: listOf(text),
      })
    );

    assert.equal(detailed.writers.state, "unavailable");
    assert.ok(
      detailed.writers.reason.includes(stored),
      detailed.writers.reason
    );
    assert.equal(detailed.integration.state, "present");

    for (const cwd of cwds) {
      const rel = path.relative(realSession, fs.realpathSync(cwd));
      assert.ok(
        rel !== ".." &&
          !rel.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(rel),
        `Git ran outside session: ${cwd}`
      );
    }
  } finally {
    f.cleanup();
  }
};

const checkEscapingIntegrationPath = async (
  kind: "absolute" | "traversing" | "symlink"
) => {
  const f = sessionFixture({ memory: kind !== "symlink" });

  try {
    const stored = pathVariant(f, `int-${kind}`, kind);

    f.artifact("mission.spec.md", "mission");
    f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );

    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));

    await appendRecord(
      f.session,
      {
        kind: "confirm",
        key: "confirm",
        by: "user",
        quote: "confirmed",
        data: { spec: hashes.spec },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "approval",
        key: "approval",
        by: "user",
        quote: "approved",
        data: hashes,
      },
      f.deps
    );

    const base = "a".repeat(40);
    const cwds: string[] = [];

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = (_argv, options) => {
      cwds.push(options.cwd);

      return Promise.resolve({ exit: 0, stdout: `${base}\n`, stderr: "" });
    };

    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: stored,
          branch: "integration",
          base,
          dest: { path: f.root, branch: "main" },
        },
      },
      f.deps
    );

    f.lines.length = 0;
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")),
      {
        next: "inspect",
        reason: "state-unreadable",
        action: "status show",
        cleanup: "unbound",
      }
    );

    f.lines.length = 0;
    assert.equal(
      await main(["status", "show", "--session", f.session], f.deps),
      0
    );

    const detailed = readJson(
      defined(f.output().path),
      withFields({
        writers: listOf(withFields({ task: text, state: text })),
        integration: withFields({ state: text, reason: text }),
        criteria: withFields({ state: text, reason: text }),
      })
    );

    assert.equal(detailed.integration.state, "unavailable");
    assert.ok(
      detailed.integration.reason.includes(stored),
      detailed.integration.reason
    );
    assert.equal(detailed.criteria.state, "unavailable");
    assert.ok(
      detailed.criteria.reason.includes(stored),
      detailed.criteria.reason
    );
    assert.equal(detailed.writers[0]?.state, "unlaunched");
    assert.deepEqual(cwds, []);
  } finally {
    f.cleanup();
  }
};

const checkEscapingLedgerSymlink = async () => {
  const f = sessionFixture();

  try {
    const ledger = path.join(f.session, "ledger.jsonl");
    const outsideLedger = path.join(f.root, "outside-ledger.jsonl");

    // Populate a valid external ledger so failure proves symlink rejection rather than parse failure.
    fs.writeFileSync(
      outsideLedger,
      `${JSON.stringify({
        seq: 1,
        key: "note-1",
        at: "2026-01-01T00:00:00.000Z",
        kind: "note",
        by: "tool",
        data: { text: "outside" },
      })}\n`
    );
    fs.symlinkSync(outsideLedger, ledger, "file");

    assert.deepEqual(await resumeCompact(f), {
      next: "inspect",
      reason: "state-unreadable",
      action: "status show",
    });
  } finally {
    f.cleanup();
  }
};

test("status refuses escaping ledger, writer, and integration paths before running Git and marks affected sections unavailable", async () => {
  await checkEscapingLedgerSymlink();
  await checkEscapingWriterPath("absolute");
  await checkEscapingWriterPath("traversing");
  await checkEscapingWriterPath("symlink");
  await checkEscapingIntegrationPath("absolute");
  await checkEscapingIntegrationPath("traversing");
  await checkEscapingIntegrationPath("symlink");
});

test("compact status with diagnostics resumeRef keeps result within 2048 B and stdout summary JSON within 1024 B", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "config.jsonc"),
      JSON.stringify({ diagnostics: true })
    );
    f.deps.skillRoot = skill;

    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const specPath = f.artifact("mission.spec.md", "# Mission");
    f.artifact("work.plan.md", PLAN);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        key: "bind",
        by: "tool",
        data: { spec: "mission.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );

    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));

    await appendRecord(
      f.session,
      {
        kind: "level",
        key: "level",
        by: "orchestrator",
        data: { level: "low" },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "confirm",
        key: "confirm",
        by: "user",
        quote: "confirmed",
        data: { spec: hashes.spec },
      },
      f.deps
    );
    fs.mkdirSync(path.join(f.session, ".state/worktrees/integration"), {
      recursive: true,
    });
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "opened",
        by: "tool",
        data: {
          phase: "opened",
          path: ".state/worktrees/integration",
          branch: "integration",
          base,
          dest: { path: f.root, branch: "main" },
        },
      },
      f.deps
    );
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "done",
        by: "tool",
        data: {
          phase: "done",
          task: "T1",
          commit: head,
        },
      },
      f.deps
    );

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = ([, ...args]) =>
      Promise.resolve({
        exit: 0,
        stdout:
          args[0] === "diff" && args[1] === "--name-only"
            ? "src/file.ts\0"
            : head,
        stderr: "",
      });

    for (let number = 1; number <= 19; number += 1) {
      const priorDir = path.join(
        f.session,
        ".state/reviews/code-integration",
        `round-${number}`
      );

      fs.mkdirSync(priorDir, { recursive: true });
      write(path.join(priorDir, "round.json"), {
        round: number,
        generation: 1,
        cap: 40,
        level: "low",
        pins: null,
        startSeq: 0,
        scope: "Full review",
        spec: { path: fs.realpathSync.native(specPath), hash: hashes.spec },
        artifacts: hashes,
        target: { base, head },
        roster: [
          {
            slot: "opencode[0]",
            provider: "opencode",
            index: 0,
            native: true,
            reserve: false,
          },
        ],
      });
      write(path.join(priorDir, "findings.json"), {
        review: "code-integration",
        round: number,
        findings: [],
        failed: [],
      });
    }

    const roundDir = ".state/reviews/code-integration/round-20";
    const slot = "opencode[0]";
    const slotPath = `${roundDir}/gen-1/slots/${slot}.json`;

    const replyPath = path.join(
      f.session,
      roundDir,
      "gen-1/replies",
      `${slot}.abcdef.md`
    );

    fs.mkdirSync(path.dirname(replyPath), { recursive: true });
    fs.writeFileSync(replyPath, "reply");
    write(path.join(f.session, `${roundDir}/round.json`), {
      round: 20,
      generation: 1,
      cap: 40,
      level: "low",
      pins: null,
      startSeq: 0,
      scope: "Full review",
      spec: { path: fs.realpathSync.native(specPath), hash: hashes.spec },
      artifacts: hashes,
      target: { base, head },
      roster: [
        { slot, provider: "opencode", index: 0, native: true, reserve: false },
      ],
    });
    write(path.join(f.session, slotPath), {
      slot,
      state: "native",
      provider: "opencode",
      attempt: `${slot}#abcdef`,
      replyPath,
    });

    f.lines.length = 0;
    assert.equal(
      await main(
        ["status", "show", "--resume", "--session", f.session],
        f.deps
      ),
      0
    );

    const out = f.output();
    const resultBytes = fs.readFileSync(defined(out.path));
    assert.ok(resultBytes.length <= 2048, `result bytes ${resultBytes.length}`);
    assert.ok(
      Buffer.byteLength(out.summary, "utf-8") <= 1024,
      `summary bytes ${Buffer.byteLength(out.summary, "utf-8")}`
    );

    const parsedSummary = parseJson(
      out.summary,
      withFields({
        next: text,
        reason: text,
        action: text,
        round: text,
        evidence: text,
        cleanup: text,
        resumeRef: text,
      })
    );

    assert.equal(parsedSummary.next, "inspect");
    assert.equal(parsedSummary.reason, "native-pending");
    assert.equal(parsedSummary.action, "review run");
    assert.deepEqual(JSON.parse(resultBytes.toString("utf-8")), parsedSummary);
  } finally {
    f.cleanup();
  }
});

test("compact status reports gate-blocked in open integration before review round 1 when the gate fails", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const { planFile } = await setupLowOpened(f);
    await appendRecord(
      f.session,
      {
        kind: "level",
        key: "level-medium",
        by: "orchestrator",
        data: { level: "medium" },
      },
      f.deps
    );
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
    await appendRecord(
      f.session,
      {
        kind: "approval",
        key: "approval",
        by: "user",
        quote: "approved",
        data: hashes,
      },
      f.deps
    );

    // Unrecorded parsable plan drift blocks the gate before taskPhaseReason runs.
    fs.writeFileSync(planFile, `${PLAN}\n<!-- unrecorded edit -->\n`);
    assert.deepEqual(await resumeCompact(f), {
      next: "inspect",
      reason: "gate-blocked",
      action: "status show",
      cleanup: "unbound",
    });
  } finally {
    f.cleanup();
  }
});

test("compact status reports state-unreadable when a saved review round has a missing or unparsable bound plan", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const { planFile } = await setupLowOpened(f);
    const head = "a".repeat(40);
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = ([, ...args]) => {
      let stdout = `${head}\n`;

      if (args[0] === "--no-optional-locks") {
        stdout = "";
      } else if (args[0] === "diff" && args[1] === "--name-only") {
        stdout = "src/file.ts\0";
      }

      return Promise.resolve({ exit: 0, stdout, stderr: "" });
    };

    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
    await appendRecord(
      f.session,
      {
        kind: "integrate",
        key: "done",
        by: "tool",
        data: { phase: "done", task: "T1", commit: head },
      },
      f.deps
    );

    const roundDir = path.join(
      f.session,
      ".state/reviews/code-integration/round-1"
    );

    fs.mkdirSync(roundDir, { recursive: true });
    write(path.join(roundDir, "round.json"), {
      round: 1,
      generation: 1,
      cap: 3,
      level: "low",
      pins: null,
      startSeq: 0,
      scope: "Full review",
      spec: {
        path: fs.realpathSync.native(path.join(f.root, "mission.spec.md")),
        hash: hashes.spec,
      },
      artifacts: hashes,
      target: { base: head, head },
      roster: [
        {
          slot: "opencode[0]",
          provider: "opencode",
          index: 0,
          native: true,
          reserve: false,
        },
      ],
    });
    write(path.join(roundDir, "findings.json"), {
      review: "code-integration",
      round: 1,
      findings: [],
      failed: [],
    });

    assert.deepEqual(await resumeCompact(f), {
      next: "review",
      reason: "review-required",
      action: "review run",
      round: ".state/reviews/code-integration/round-1/round.json",
      cleanup: "unbound",
    });

    // Unparsable bound plan returns state-unreadable even when a review round exists.
    fs.writeFileSync(planFile, "# Broken\n");
    assert.deepEqual(await resumeCompact(f), {
      next: "inspect",
      reason: "state-unreadable",
      action: "status show",
      cleanup: "unbound",
    });

    // Missing bound plan also returns state-unreadable.
    fs.unlinkSync(planFile);
    assert.deepEqual(await resumeCompact(f), {
      next: "inspect",
      reason: "state-unreadable",
      action: "status show",
      cleanup: "unbound",
    });
  } finally {
    f.cleanup();
  }
});
