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

test("compact status reports the recovery boundary before integration starts", async () => {
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
        next: "inspect",
        reason: "state-unreadable",
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

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const value = JSON.parse(
      fs.readFileSync(defined(f.output().path), "utf-8")
    );

    assert.deepEqual(value, { next: "inspect", reason: "outside-review" });
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
      spec: { path: specPath, hash: hashes.spec },
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
      round: roundFile,
      evidence: nativePath,
      cleanup: "unbound",
    });

    const unreadable = {
      next: "inspect",
      reason: "state-unreadable",
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
      round: roundFile,
      cleanup: "unbound",
    });
    fs.unlinkSync(path.join(f.session, findingsFile));

    write(roundFile, { ...metadata, round: 20, pins: undefined });
    const statusResult10 = await status(true);

    assert.deepEqual(statusResult10.value, {
      next: "inspect",
      reason: "arguments-unavailable",
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
