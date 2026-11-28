import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isRecord } from "../../skills/dispatch/scripts/lib/config.ts";
import type { JsonValue } from "../../skills/dispatch/scripts/lib/config.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import { admission } from "../../skills/dispatch/scripts/toolkit/findings.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
  latest,
} from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import { CLEAN } from "../helpers/e2e.ts";
import type { Guard } from "./helpers/json.ts";
import {
  arrayOf,
  defined,
  isBoolean,
  isNumber,
  isString,
  maybe,
  narrow,
  nullable,
  objectWith,
  text,
} from "./helpers/json.ts";
import {
  planSource,
  setupTestSkill,
  toolkitRepo as createToolkitRepo,
} from "./helpers/toolkit-repo.ts";

const source = planSource
  .replace(
    "  - Changes: src/file.ts",
    "  - Changes: src/file.ts, tests/file.test.ts"
  )
  .replace(
    "  - Evidence: check",
    "  - Tests: tests/file.test.ts\n  - RED: `node --test tests/file.test.ts`\n  - Evidence: red"
  );

const PROVIDERS = ["claude", "codex", "opencode"];

const MUST_FINDING = {
  status: "FINDINGS",
  findings: [
    {
      impact: "blocks",
      trigger: "realistic",
      tag: "correctness",
      locus: "src/file.ts:L1",
      defect: "The file returns an invalid result",
      proposedFix: "Return the expected result",
    },
  ],
};

const RepoChangeEntryGuard = objectWith({
  cwd: isString,
  paths: arrayOf(isString),
});

const PendingSlotGuard = objectWith({ slot: isString, replyPath: isString });

const SlotRosterGuard = objectWith({
  slot: isString,
  reserve: maybe(isBoolean),
});

const RoundFileGuard = objectWith({
  scope: isString,
  roster: arrayOf(SlotRosterGuard),
  target: objectWith({ base: isString, head: isString }),
  coverage: maybe(isString),
  coverageUse: maybe(isString),
  generation: maybe(isNumber),
  pins: maybe(nullable(isString)),
  level: maybe(isString),
});

const FindingGuard = objectWith({
  id: isString,
  defect: isString,
  category: maybe(isString),
  locus: maybe(isString),
  severity: maybe(isString),
  impact: maybe(isString),
  trigger: maybe(isString),
  unresolved: maybe(objectWith({ of: isString })),
  recurrence: maybe(objectWith({ of: isString })),
});

const FailedSlotGuard = objectWith({ slot: isString, cls: maybe(isString) });

const RoundCauseGuard = objectWith({
  primary: isString,
  counts: objectWith({
    fixInduced: isNumber,
    recurring: isNumber,
    unknownOrigin: isNumber,
    new: isNumber,
    failed: isNumber,
  }),
});

const FindingsFileGuard = objectWith({
  review: maybe(isString),
  cause: maybe(RoundCauseGuard),
  stepBack: maybe(objectWith({ units: arrayOf(isString) })),
  asOfSeq: maybe(isNumber),
  findings: arrayOf(FindingGuard),
  failed: arrayOf(FailedSlotGuard),
  escalations: maybe(arrayOf(objectWith({ key: isString }))),
  confirmations: maybe(arrayOf(objectWith({ sourceSlot: isString }))),
  units: maybe(
    arrayOf(objectWith({ unit: isString, findings: arrayOf(isString) }))
  ),
});

const CheckoutReportGuard = objectWith({
  asOfSeq: maybe(isNumber),
  repositoryChanges: maybe(arrayOf(RepoChangeEntryGuard)),
});

const AttemptGuard = objectWith({
  slot: isString,
  seq: isNumber,
  wholeTarget: isBoolean,
});

const CreatedGuard = objectWith({ path: isString });

const PendingSlotDetailGuard = objectWith({
  slot: isString,
  replyPath: isString,
  promptPath: maybe(isString),
  attempt: maybe(isString),
});

const PendingRunGuard = objectWith({
  cliWave: maybe(isString),
  review: maybe(isString),
  pending: arrayOf(PendingSlotDetailGuard),
});

const RepositoryCheckGuard = objectWith({
  state: isString,
  reason: maybe(isString),
});

const ReviewResultGuard = objectWith({
  path: maybe(isString),
  review: maybe(isString),
  round: maybe(isNumber),
  repositoryChanges: maybe(arrayOf(RepoChangeEntryGuard)),
  repositoryCheck: maybe(RepositoryCheckGuard),
});

const StatusShowGuard = objectWith({
  openRepositoryChanges: maybe(arrayOf(isRecord)),
});

const createdPath = (result: { value: JsonValue }) =>
  narrow(result.value, CreatedGuard).path;

const pendingRun = (result: { value: JsonValue }) =>
  narrow(result.value, PendingRunGuard);

const reviewResult = (result: { value: JsonValue }) =>
  narrow(result.value, ReviewResultGuard);

const statusChanges = (result: { value: JsonValue }) =>
  narrow(result.value, StatusShowGuard).openRepositoryChanges;

const readJson = <T>(filePath: string, guard: Guard<T>) => {
  const parsed = parseJson(fs.readFileSync(filePath, "utf-8"));

  return narrow(parsed, guard);
};

const denied = () => {
  throw Object.assign(new Error("denied"), { code: "EACCES" });
};

const saveJson = (file: string, value: JsonValue) => {
  fs.writeFileSync(file, JSON.stringify(value));
};

const repositoryPaths = (value: JsonValue) =>
  narrow(value, arrayOf(RepoChangeEntryGuard)).flatMap((entry) => entry.paths);

const openChanges = (value: JsonValue) =>
  narrow(value, arrayOf(isRecord)).map((row) => {
    const review = text(defined(row["review"], "review"));

    const round = narrow(defined(row["round"], "round"), isNumber);

    const check = row["repositoryCheck"];

    return {
      review,
      round,
      reportSeq: row["reportSeq"],
      rerunPending: row["rerunPending"],
      repositoryChanges: row["repositoryChanges"],
      repositoryCheck: isRecord(check) ? { state: check["state"] } : undefined,
    };
  });

const toolkitRepo = async (...args: Parameters<typeof createToolkitRepo>) => {
  const fixture = await createToolkitRepo(...args);

  const { deps } = fixture;

  // Mock review providers expose one CLI mode when the test marks them live.
  deps.liveness = {};

  deps.modes = (provider) => (deps.liveness[provider] === true ? ["cli"] : []);

  return fixture;
};

const coverageRepo = async (rounds: number) => {
  const f = await toolkitRepo();

  f.deps.skillRoot = setupTestSkill(f.deps, f.session, "skill", {
    "read-delegates": Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        { targets: [{ low: { model: "fake" } }] },
      ])
    ),
    phases: { "code-review": { targets: { low: 3 }, rounds: { low: rounds } } },
  });
  f.deps.liveness = Object.fromEntries(
    PROVIDERS.map((provider) => [provider, true])
  );
  f.deps.orchestrator = null;

  const failing = new Set<string>();

  const replies = new Map<string, object>();

  const calls: { provider: string; prompt: string }[] = [];

  f.deps.delegate = async (provider, request) => {
    await Promise.resolve();

    calls.push({
      provider,
      prompt: fs.readFileSync(request.promptPath, "utf-8"),
    });

    if (failing.has(provider)) {
      return {
        outcome: { status: "fail", cls: "auth", detail: "denied" },
        invocations: [],
      };
    }

    return {
      outcome: {
        status: "ok",
        text: JSON.stringify(replies.get(provider) ?? CLEAN),
        resume: null,
        sessionId: null,
      },
      invocations: [],
    };
  };

  await f.level("low");
  await f.approve();

  const made = await f.run(["worktree", "create", "T1"]);

  assert.equal(made.exit, 0, JSON.stringify(made.output));
  fs.writeFileSync(
    path.resolve(f.session, createdPath(made), "src/file.ts"),
    "first\n"
  );

  const submitted = await f.run(["worktree", "submit", "T1"]);

  assert.equal(submitted.exit, 0);

  const integrated = await f.run(["worktree", "integrate", "T1"]);

  assert.equal(integrated.exit, 0);

  const review = async () =>
    await f.run(["review", "run", "integration", "--kind", "code"]);

  const dir = (n: number) =>
    path.join(f.session, ".state/reviews/code-integration", `round-${n}`);

  const round = (n: number) =>
    readJson(path.join(dir(n), "round.json"), RoundFileGuard);

  const findings = (n: number) =>
    readJson(path.join(dir(n), "findings.json"), FindingsFileGuard);

  const attempts = (n: number) =>
    readJson(path.join(dir(n), "gen-1/attempts.json"), arrayOf(AttemptGuard));

  const targets = (n: number) =>
    round(n)
      .roster.filter((slot) => slot.reserve !== true)
      .map((slot) => slot.slot)
      .toSorted();

  const accept = async (id: string) =>
    await appendRecord(
      f.session,
      {
        kind: "ruling",
        by: "orchestrator",
        key: `accept-${id}`,
        data: {
          subject: `review:code-integration:${id}`,
          ruling: "accepted",
          fix: "proposed",
          rationale: "Fix accepted",
        },
      },
      f.deps
    );

  return {
    f,
    failing,
    replies,
    calls,
    review,
    dir,
    round,
    findings,
    attempts,
    targets,
    accept,
  };
};

test("native-first round runs native beside the cli wave", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "mixed-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
        agy: { targets: [{ low: { model: "cli-model" } }] },
      },
      phases: { "code-review": { targets: { low: 2 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true, agy: true };
    f.deps.delegate = async (provider) => {
      await Promise.resolve();

      if (provider !== "agy") {
        throw new Error(`native-first launch must not call ${provider}`);
      }

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    fs.writeFileSync(path.join(f.root, "src/file.ts"), "mixed change\n");

    const run = async () =>
      await f.run([
        "review",
        "run",
        "worktree",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");
    assert.equal(pendingRun(launched).cliWave, "pending");
    assert.equal(pendingRun(launched).pending.length, 1);
    assert.equal(
      defined(pendingRun(launched).pending[0], "pending").slot,
      "claude[0]"
    );

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    assert.equal(pendingRun(waved).cliWave, "done");

    await Promise.all(
      pendingRun(waved).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const done = await run();

    assert.equal(done.exit, 0);
  } finally {
    f.cleanup();
  }
});

test("pending MUST rejection keeps captured Git confirmation identity across native retry and target movement", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "confirmation-skill", {
      "read-delegates": {
        codex: {
          nativeSubagentsOnly: true,
          targets: [{ low: { model: "native" } }],
        },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "codex", model: "native" };
    f.deps.liveness = {};

    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "first captured change\n"
    );

    const run = async () =>
      await f.run([
        "review",
        "run",
        "worktree",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
        "--host",
        "codex",
      ]);

    const first = await run();

    assert.equal(first.output.reason, "native-pending");
    fs.writeFileSync(
      defined(pendingRun(first).pending[0], "pending").replyPath,
      JSON.stringify({
        status: "FINDINGS",
        findings: [
          {
            impact: "blocks",
            trigger: "realistic",
            tag: "correctness",
            locus: "src/file.ts:L1",
            defect: "Writes are unbounded",
            proposedFix: "Bound the writes",
          },
        ],
      })
    );

    const finding = await run();

    assert.equal(finding.exit, 0);

    const saved = narrow(
      parseJson(
        fs.readFileSync(
          text(defined(reviewResult(finding).path, "path")),
          "utf-8"
        )
      ),
      objectWith({ review: isString })
    );

    await appendRecord(
      f.session,
      {
        kind: "ruling",
        by: "orchestrator",
        key: "reject-captured",
        data: {
          subject: `review:${saved.review}:R1-F001`,
          ruling: "rejected",
          rationale: "Captured writes have a bound",
        },
      },
      f.deps
    );

    const second = await run();

    assert.equal(second.output.reason, "native-pending");

    const oldPrompt = fs.readFileSync(
      text(
        defined(
          defined(pendingRun(second).pending[0], "pending").promptPath,
          "prompt"
        )
      ),
      "utf-8"
    );

    const oldId = defined(
      /Request ID: `(?<request>[^`]+)`/u.exec(oldPrompt)?.groups?.["request"],
      "request"
    );

    fs.writeFileSync(
      defined(pendingRun(second).pending[0], "pending").replyPath,
      JSON.stringify({
        status: "CLEAN",
        findings: [],
        confirmations: [
          {
            requestId: oldId,
            decision: "agree",
            rationale: "The captured writes have a bound",
          },
        ],
      })
    );
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "new captured change\n");

    const moved = await run();

    assert.equal(moved.output.reason, "native-pending");

    const freshPrompt = fs.readFileSync(
      text(
        defined(
          defined(pendingRun(moved).pending[0], "pending").promptPath,
          "prompt"
        )
      ),
      "utf-8"
    );

    const freshId = defined(
      /Request ID: `(?<request>[^`]+)`/u.exec(freshPrompt)?.groups?.["request"],
      "request"
    );

    assert.notEqual(freshId, oldId);
    assert.equal(
      fs.existsSync(
        path.join(
          path.dirname(text(defined(reviewResult(finding).path, "path"))),
          "../round-2/findings.json"
        )
      ),
      false
    );
    fs.writeFileSync(
      defined(pendingRun(moved).pending[0], "pending").replyPath,
      JSON.stringify({
        status: "CLEAN",
        findings: [],
        confirmations: [
          {
            requestId: freshId,
            decision: "agree",
            rationale: "The new captured writes also have a bound",
          },
        ],
      })
    );

    const confirmed = await run();

    assert.equal(confirmed.exit, 0, JSON.stringify(confirmed));
    assert.equal(
      narrow(
        parseJson(
          fs.readFileSync(
            text(defined(reviewResult(confirmed).path, "path")),
            "utf-8"
          )
        ),
        objectWith({
          confirmations: arrayOf(
            objectWith({ responder: objectWith({ native: isBoolean }) })
          ),
        })
      ).confirmations[0]?.responder.native,
      true
    );

    const capped = await run();

    assert.equal(capped.output.reason, "round-cap");
  } finally {
    f.cleanup();
  }
});

test("unchanged target with a pending MUST rejection runs a confirmation-only round through the CLI", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(
      f.deps,
      f.session,
      "confirmation-only-skill",
      {
        "read-delegates": {
          claude: { targets: [{ low: { model: "fake" } }] },
          agy: { targets: [{ low: { model: "fake" } }] },
        },
        phases: { "code-review": { targets: { low: 2 }, rounds: { low: 2 } } },
      }
    );
    f.deps.liveness = { claude: true, agy: true };

    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "first captured change\n"
    );

    let phase: "finding" | "confirmation" = "finding";

    const launched: string[] = [];

    f.deps.delegate = async (provider, request) => {
      await Promise.resolve();

      launched.push(provider);

      if (phase === "finding") {
        const response =
          provider === "claude"
            ? JSON.stringify({
                status: "FINDINGS",
                findings: [
                  {
                    impact: "blocks",
                    trigger: "realistic",
                    tag: "correctness",
                    locus: "src/file.ts:L1",
                    defect: "Writes are unbounded",
                    proposedFix: "Bound the writes",
                  },
                ],
              })
            : JSON.stringify(CLEAN);

        return {
          outcome: {
            status: "ok",
            text: response,
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      }

      const prompt = fs.readFileSync(request.promptPath, "utf-8");

      const ids = [...prompt.matchAll(/Request ID: `(?<request>[^`]+)`/gu)].map(
        (match) => defined(match.groups?.["request"], "request")
      );

      assert.match(prompt, /\(confirmation-only\)/u);

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify({
            status: "CLEAN",
            findings: [],
            confirmations: ids.map((requestId) => ({
              requestId,
              decision: "agree",
              rationale: "The captured bound holds",
            })),
          }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    const run = async () =>
      await f.run([
        "review",
        "run",
        "worktree",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const first = await run();

    assert.equal(first.exit, 0, JSON.stringify(first));

    const review = text(defined(reviewResult(first).review, "review"));

    const dir = path.join(f.session, ".state/reviews", review);

    const firstRound = readJson(
      path.join(dir, "round-1", "round.json"),
      RoundFileGuard
    );

    assert.deepEqual(
      firstRound.roster
        .filter((slot) => slot.reserve !== true)
        .map((slot) => slot.slot),
      ["claude[0]", "agy[0]"]
    );

    await appendRecord(
      f.session,
      {
        kind: "ruling",
        by: "orchestrator",
        key: "reject-must",
        data: {
          subject: `review:${review}:R1-F001`,
          ruling: "rejected",
          rationale: "The captured implementation bounds each write",
        },
      },
      f.deps
    );

    phase = "confirmation";
    launched.length = 0;

    const second = await run();

    assert.equal(second.exit, 0, JSON.stringify(second));

    const round = readJson(
      path.join(dir, "round-2", "round.json"),
      RoundFileGuard
    );

    assert.match(
      round.scope,
      /^Re-review round 2 \(confirmation-only\) — comparison: [a-f0-9]{40}\.\.[a-f0-9]{40}$/u
    );
    assert.deepEqual(
      round.roster
        .filter((slot) => slot.reserve !== true)
        .map((slot) => slot.slot),
      ["claude[0]"]
    );
    assert.deepEqual(launched, ["claude"]);

    const prompt = fs.readFileSync(
      path.join(dir, "round-2", "gen-1", "prompts", "claude[0].md"),
      "utf-8"
    );

    assert.ok(
      prompt.includes(
        `- Target Revision: ${round.target.base}..${round.target.head}`
      ),
      prompt
    );

    const findings = readJson(
      path.join(dir, "round-2", "findings.json"),
      FindingsFileGuard
    );

    const confirmations = defined(findings.confirmations, "confirmations");

    assert.equal(confirmations.length, 1);
    assert.equal(
      defined(confirmations[0], "confirmation").sourceSlot,
      "claude[0]"
    );
    assert.match(second.output.summary, /round 2\/2/u);

    const capped = await run();

    assert.equal(capped.output.reason, "round-cap");
  } finally {
    f.cleanup();
  }
});

test("toolkit worktree review excludes unignored session state and preserves committed session blobs", async () => {
  const f = await toolkitRepo();

  try {
    fs.writeFileSync(path.join(f.root, ".gitignore"), "");
    fs.writeFileSync(
      path.join(f.session, "tracked.txt"),
      "committed session bytes\n"
    );
    f.git(["add", "."]);
    f.git(["commit", "-qm", "tracked session"]);
    fs.writeFileSync(
      path.join(f.session, "tracked.txt"),
      "changed session bytes\n"
    );
    fs.writeFileSync(
      path.join(f.session, "untracked.txt"),
      "untracked session bytes\n"
    );
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "changed code\n");
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "native-skill", {
      "read-delegates": {
        codex: {
          nativeSubagentsOnly: true,
          targets: [{ low: { model: "native" } }],
        },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "codex", model: "native" };
    f.deps.liveness = {};

    const run = async (expected: number) => {
      const result = await f.run([
        "review",
        "run",
        "worktree",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
        "--host",
        "codex",
      ]);

      assert.equal(result.exit, expected, JSON.stringify(result.output));

      for (const key of ["v", "run", "reply", "await", "at"]) {
        assert.equal(Object.hasOwn(result.output, key), false, key);
      }

      return result;
    };

    const pending = await run(4);

    assert.equal(pending.output.reason, "native-pending");
    assert.equal(pendingRun(pending).pending.length, 1);

    const slug = `code-worktree-${crypto
      .createHash("sha256")
      .update(`worktree@${f.git(["rev-parse", "HEAD"]).trim()}`)
      .digest("hex")}`;

    const metadata = path.join(
      f.session,
      ".state/reviews",
      slug,
      "round-1/round.json"
    );

    const before = readJson(metadata, RoundFileGuard);

    await Promise.all(
      pendingRun(pending).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const clean = await run(0);

    assert.deepEqual(
      narrow(
        parseJson(
          fs.readFileSync(
            text(defined(reviewResult(clean).path, "path")),
            "utf-8"
          )
        ),
        objectWith({ findings: arrayOf(isString) })
      ).findings,
      []
    );

    const after = readJson(metadata, RoundFileGuard);

    assert.equal(after.target.head, before.target.head);

    const changed = f
      .git([
        "diff",
        "--name-only",
        `${before.target.base}..${before.target.head}`,
      ])
      .split(/\r?\n/u);

    assert.ok(changed.includes("src/file.ts"));
    assert.equal(
      changed.some((file) => file.startsWith(`${path.basename(f.session)}/`)),
      false
    );
    assert.equal(
      f.git([
        "diff",
        "--name-only",
        `${before.target.base}..${before.target.head}`,
        "--",
        path.basename(f.session),
      ]),
      ""
    );
    assert.equal(
      f.git([
        "show",
        `${before.target.head}:${path.basename(f.session)}/tracked.txt`,
      ]),
      "committed session bytes"
    );
    assert.equal(
      fs.readFileSync(path.join(f.session, "tracked.txt"), "utf-8"),
      "changed session bytes\n"
    );
    assert.equal(
      fs.readFileSync(path.join(f.session, "untracked.txt"), "utf-8"),
      "untracked session bytes\n"
    );
    f.git(["add", "src/file.ts"]);
    f.git(["commit", "-qm", "reviewed change"]);
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "next change\n");

    const nextPending = await run(4);

    assert.equal(nextPending.output.reason, "native-pending");

    const next = `code-worktree-${crypto
      .createHash("sha256")
      .update(`worktree@${f.git(["rev-parse", "HEAD"]).trim()}`)
      .digest("hex")}`;

    assert.equal(
      fs.existsSync(
        path.join(f.session, ".state/reviews", next, "round-1/round.json")
      ),
      true
    );
    assert.equal(
      fs.existsSync(path.join(f.session, ".state/reviews", slug, "round-2")),
      false
    );
  } finally {
    f.cleanup();
  }
});

test("toolkit worktree review snapshots a gitignored session without failing on its exclusion", async () => {
  const f = await toolkitRepo();

  try {
    const top = defined(
      path.relative(f.root, f.session).split(path.sep)[0],
      "top"
    );

    fs.writeFileSync(path.join(f.root, ".gitignore"), `${top}/\n`);
    fs.writeFileSync(
      path.join(f.session, "tracked.txt"),
      "committed session bytes\n"
    );
    fs.writeFileSync(
      path.join(f.session, "deleted.txt"),
      "deleted session bytes\n"
    );
    f.git(["add", ".gitignore"]);
    f.git(["add", "-f", "--", path.relative(f.root, f.session)]);
    f.git(["commit", "-qm", "ignore session"]);
    fs.writeFileSync(
      path.join(f.session, "tracked.txt"),
      "changed session bytes\n"
    );
    fs.rmSync(path.join(f.session, "deleted.txt"));
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "changed code\n");
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "native-skill", {
      "read-delegates": {
        codex: {
          nativeSubagentsOnly: true,
          targets: [{ low: { model: "native" } }],
        },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "codex", model: "native" };
    f.deps.liveness = {};

    const result = await f.run([
      "review",
      "run",
      "worktree",
      "--kind",
      "code",
      "--spec",
      "work.spec.md",
      "--level",
      "low",
      "--host",
      "codex",
    ]);

    assert.equal(
      result.output.reason,
      "native-pending",
      JSON.stringify(result.output)
    );

    const slug = `code-worktree-${crypto
      .createHash("sha256")
      .update(`worktree@${f.git(["rev-parse", "HEAD"]).trim()}`)
      .digest("hex")}`;

    const { target } = readJson(
      path.join(f.session, ".state/reviews", slug, "round-1/round.json"),
      RoundFileGuard
    );

    assert.deepEqual(
      f
        .git(["diff", "--name-only", `${target.base}..${target.head}`])
        .split(/\r?\n/u),
      ["src/file.ts"]
    );
    assert.equal(
      f.git([
        "show",
        `${target.head}:${path.relative(f.root, f.session).split(path.sep).join("/")}/tracked.txt`,
      ]),
      "committed session bytes"
    );
  } finally {
    f.cleanup();
  }
});

test("toolkit code review reports missing evidence without admission gates and tracks changed targets", async () => {
  const f = await toolkitRepo(
    source.replace(
      "## Success Criteria",
      "#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria"
    )
  );

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "skill", {
      "read-delegates": { claude: { targets: [{ low: { model: "fake" } }] } },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 3 } } },
    });
    f.deps.liveness = { claude: true };
    f.deps.orchestrator = null;

    const prompts: string[] = [];

    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();
      prompts.push(fs.readFileSync(request.promptPath, "utf-8"));

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify({ status: "CLEAN", findings: [] }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("medium");
    await f.approve();

    const unknownTarget = await f.run([
      "review",
      "run",
      "unknown",
      "--kind",
      "code",
    ]);

    assert.equal(unknownTarget.output.reason, "invalid-input");

    const nothing = await f.run([
      "review",
      "run",
      "integration",
      "--kind",
      "code",
    ]);

    assert.equal(nothing.output.reason, "nothing-to-review");

    const launch = async (content: string) => {
      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0, JSON.stringify(made.output));

      const rendered = await f.run(["brief", "render", "T1"]);

      assert.equal(rendered.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        content
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      return text(
        defined(
          defined(
            foldLedger(f.session).records.findLast(
              (row) => row.kind === "writer" && row.data["phase"] === "finished"
            ),
            "writer"
          ).data["candidate"],
          "candidate"
        )
      );
    };

    const head = await launch("first\n");

    const integrated = await f.run(["worktree", "integrate", "T1"]);

    assert.equal(integrated.exit, 0);

    const review = async (target = "T1") => {
      const result = await f.run(["review", "run", target, "--kind", "code"]);

      assert.equal(result.exit, 0, JSON.stringify(result.output));

      return readJson(
        text(defined(reviewResult(result).path, "path")),
        FindingsFileGuard
      );
    };

    const first = await review();

    assert.equal(first.findings.length, 1);
    assert.equal(first.cause, undefined);

    const gap = defined(first.findings[0], "gap");

    assert.deepEqual(
      defined(first.units, "units").map((unit) => [unit.unit, unit.findings]),
      [["work.plan.md", [gap.id]]]
    );
    assert.match(gap.defect, /missing-red: T1 SC1; Tests touched: no/u);
    assert.equal(gap.category, "testing");
    assert.match(defined(gap.locus, "locus"), /work.plan.md:L\d+$/u);

    const metadata = readJson(
      path.join(f.session, ".state/reviews/code-T1/round-1/round.json"),
      RoundFileGuard
    );

    assert.equal(metadata.target.head, head);
    assert.ok(
      defined(prompts[0], "prompt").includes(
        `comparison: ${metadata.target.base}..${head}`
      )
    );

    const unchanged = await review();

    assert.deepEqual(defined(unchanged.findings[0], "finding").unresolved, {
      of: gap.id,
    });
    assert.deepEqual(unchanged.cause, {
      primary: "recurring",
      counts: {
        fixInduced: 0,
        recurring: 1,
        unknownOrigin: 0,
        new: 0,
        failed: 0,
      },
    });
    assert.equal(defined(unchanged.escalations, "escalations").length, 0);

    await f.level("high");

    const next = await launch("second\n");

    const third = await review();

    // The later-round missing-RED gap has origin unknown and joins the round after finalize, so the saved cause counts it.
    assert.deepEqual(third.cause, {
      primary: "unknown-origin",
      counts: {
        fixInduced: 0,
        recurring: 0,
        unknownOrigin: 1,
        new: 0,
        failed: 0,
      },
    });
    assert.equal(third.findings.length, 1);

    assert.equal(
      defined(defined(third.escalations, "escalations")[0], "escalation").key,
      "missing-red:code-T1:T1:SC1:R3:g1"
    );
    assert.ok(
      defined(prompts.at(-1), "prompt").includes(`comparison: ${head}..${next}`)
    );
    assert.ok(defined(prompts.at(-1), "prompt").includes("src/file.ts"));

    const integratedReview = await review("integration");

    assert.equal(integratedReview.findings.length, 1);
    assert.ok(
      defined(prompts.at(-1), "prompt").includes("Integrated tasks: T1")
    );

    const integrationTarget = readJson(
      path.join(
        f.session,
        ".state/reviews/code-integration/round-1/round.json"
      ),
      RoundFileGuard
    ).target;

    assert.ok(
      defined(prompts.at(-1), "prompt").includes(
        `comparison: ${integrationTarget.base}..${integrationTarget.head}`
      )
    );

    let moved = false;

    const result = await f.run(
      ["review", "run", "integration", "--kind", "code"],
      async (point) => {
        if (point === "fanout:after-slot" && !moved) {
          moved = true;
          fs.writeFileSync(path.join(f.integration, "src/file.ts"), "fix\n");

          const committed = await f.run([
            "worktree",
            "commit",
            "--reason",
            "fix",
          ]);

          assert.equal(committed.exit, 0);
        }
      }
    );

    assert.equal(result.output.reason, "target-moved");
    assert.equal(
      fs.existsSync(
        path.join(
          f.session,
          ".state/reviews/code-integration/round-2/findings.json"
        )
      ),
      false
    );
  } finally {
    f.cleanup();
  }
});

test("toolkit code review scopes integration recurrence and gaps to committed owner changes", async () => {
  const two = source
    .replace(
      "| T1 | File | Works | none | SC1 |",
      "| T1 | File | Works | none | SC1 |\n| T2 | Other | Works | none | SC2 |"
    )
    .replace(
      "## Success Criteria",
      "#### [MODIFY] tests/file.test.ts\n### T2 — Other\n#### [MODIFY] src/other.ts\n- Purpose: independent behavior.\n## Success Criteria"
    )
    .replace(
      "## Verification Plan",
      '- [SC2] Other works\n  - Changes: src/other.ts\n  - Check: `node -e "process.exit(0)"`\n  - Evidence: check\n## Verification Plan'
    );

  await Promise.all(
    [false, true].map(async (fixOwner) => {
      const f = await toolkitRepo(two, { "src/other.ts": "initial\n" });

      try {
        f.deps.skillRoot = setupTestSkill(f.deps, f.session, "skill", {
          "read-delegates": {
            claude: { targets: [{ low: { model: "fake" } }] },
          },
          phases: {
            "code-review": { targets: { low: 1 }, rounds: { low: 3 } },
          },
        });
        f.deps.liveness = { claude: true };
        f.deps.orchestrator = null;
        f.deps.delegate = async () => {
          await Promise.resolve();

          return {
            outcome: {
              status: "ok",
              text: JSON.stringify({
                status: "FINDINGS",
                findings: [
                  {
                    impact: "degrades",
                    trigger: "realistic",
                    tag: "correctness",
                    locus: "src/file.ts:L1",
                    defect: "The file returns an invalid result",
                    proposedFix: "Return the expected result",
                  },
                ],
              }),
              resume: null,
              sessionId: null,
            },
            invocations: [],
          };
        };

        await f.level("high");
        await f.approve();

        const submit = async (task: string, file: string) => {
          const made = await f.run(["worktree", "create", task]);

          assert.equal(made.exit, 0, JSON.stringify(made.output));
          fs.writeFileSync(
            path.resolve(f.session, createdPath(made), file),
            "changed\n"
          );

          const submitted = await f.run(["worktree", "submit", task]);

          assert.equal(submitted.exit, 0);

          const integrated = await f.run(["worktree", "integrate", task]);

          assert.equal(integrated.exit, 0);
        };

        await submit("T1", "src/file.ts");

        const review = async () => {
          const result = await f.run([
            "review",
            "run",
            "integration",
            "--kind",
            "code",
          ]);

          assert.equal(result.exit, 0, JSON.stringify(result.output));

          return readJson(
            text(defined(reviewResult(result).path, "path")),
            FindingsFileGuard
          );
        };

        const first = await review();

        await appendRecord(
          f.session,
          {
            kind: "ruling",
            key: "accepted",
            by: "orchestrator",
            data: {
              subject: `review:code-integration:${defined(first.findings[0], "finding").id}`,
              ruling: "accepted",
              fix: "proposed",
              rationale: "Fix accepted",
            },
          },
          f.deps
        );

        if (fixOwner) {
          fs.writeFileSync(
            path.join(f.integration, "src/file.ts"),
            "attempted fix\n"
          );

          const committed = await f.run([
            "worktree",
            "commit",
            "--reason",
            "fix",
          ]);

          assert.equal(committed.exit, 0);
        } else {
          await submit("T2", "src/other.ts");
          fs.writeFileSync(
            path.join(f.integration, "src/file.ts"),
            "uncommitted attempted fix\n"
          );
          fs.mkdirSync(path.join(f.integration, "tests"), { recursive: true });
          fs.writeFileSync(
            path.join(f.integration, "tests/file.test.ts"),
            "untracked test\n"
          );
        }

        const second = await review();

        const finding = defined(
          second.findings.find((row) => row.id === "R2-F001"),
          "R2-F001"
        );

        if (fixOwner) {
          assert.deepEqual(finding.recurrence, {
            of: defined(first.findings[0], "finding").id,
          });
          assert.equal(
            defined(second.escalations, "escalations").filter((row) =>
              row.key.startsWith("recurrence:")
            ).length,
            1
          );
          fs.mkdirSync(path.join(f.session, ".state/briefs"), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(f.session, ".state/briefs/T1-1.report.md"),
            "## Observed RED failures\nSC1 failed before the fix\n"
          );

          const rereviewed = await review();

          assert.equal(
            rereviewed.findings.filter((row) =>
              row.defect.startsWith("missing-red:")
            ).length,
            0
          );
        } else {
          assert.deepEqual(finding.unresolved, {
            of: defined(first.findings[0], "finding").id,
          });
          assert.equal(defined(second.escalations, "escalations").length, 0);

          const gap = defined(
            second.findings.find((row) => row.id === "R2-RED01"),
            "R2-RED01"
          );

          assert.ok(gap.unresolved !== undefined);
          assert.deepEqual(
            [gap.severity, gap.impact, gap.trigger],
            ["SHOULD", "degrades", "realistic"]
          );
          assert.match(gap.defect, /Tests touched: no$/u);
        }
      } finally {
        f.cleanup();
      }
    })
  );
});

test("rejected missing-red ruling settles later rounds after the target moves", async () => {
  const f = await toolkitRepo(
    source.replace(
      "## Success Criteria",
      "#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria"
    )
  );

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "skill", {
      "read-delegates": { claude: { targets: [{ low: { model: "fake" } }] } },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 3 } } },
    });
    f.deps.liveness = { claude: true };
    f.deps.orchestrator = null;
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify({ status: "CLEAN", findings: [] }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("high");
    await f.approve();

    const launch = async (content: string) => {
      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0, JSON.stringify(made.output));
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        content
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0, JSON.stringify(submitted.output));

      const integrated = await f.run(["worktree", "integrate", "T1"]);

      assert.equal(integrated.exit, 0, JSON.stringify(integrated.output));
    };

    const review = async () => {
      const result = await f.run(["review", "run", "T1", "--kind", "code"]);

      assert.equal(result.exit, 0, JSON.stringify(result.output));

      return readJson(
        text(defined(reviewResult(result).path, "path")),
        FindingsFileGuard
      );
    };

    await launch("first\n");

    const first = await review();

    assert.ok(first.findings !== undefined, JSON.stringify(first));

    const gap = defined(
      first.findings.find((finding) =>
        finding.defect.startsWith("missing-red: T1 SC1;")
      ),
      "gap"
    );

    await appendRecord(
      f.session,
      {
        kind: "ruling",
        key: "reject-missing-red",
        by: "orchestrator",
        data: {
          subject: `review:${defined(first.review, "review")}:${gap.id}`,
          ruling: "rejected",
          rationale: "The wrapper exit proves the test failed before the fix",
        },
      },
      f.deps
    );

    await launch("second\n");

    const second = await review();

    assert.equal(
      second.findings.some((finding) =>
        finding.defect.startsWith("missing-red: T1 SC1;")
      ),
      false
    );
    assert.equal(
      defined(second.escalations, "escalations").some((row) =>
        row.key.startsWith("missing-red:")
      ),
      false
    );

    await launch("third\n");

    const third = await review();

    assert.equal(
      third.findings.some((finding) =>
        finding.defect.startsWith("missing-red: T1 SC1;")
      ),
      false
    );
    assert.equal(
      defined(third.escalations, "escalations").some((row) =>
        row.key.startsWith("missing-red:")
      ),
      false
    );
  } finally {
    f.cleanup();
  }
});

test("wrapper RED exit suppresses missing-red without a report section", async () => {
  const f = await toolkitRepo(
    source.replace(
      "## Success Criteria",
      "#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria"
    )
  );

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "skill", {
      "read-delegates": { claude: { targets: [{ low: { model: "fake" } }] } },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 3 } } },
    });
    f.deps.liveness = { claude: true };
    f.deps.orchestrator = null;
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify({ status: "CLEAN", findings: [] }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("high");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0, JSON.stringify(made.output));
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "changed\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const launch = narrow(
      defined(
        defined(
          foldLedger(f.session).records.findLast(
            (row) => row.kind === "writer" && row.data["phase"] === "finished"
          ),
          "launch"
        ).data["launch"],
        "launch"
      ),
      isNumber
    );

    const redDir = path.join(f.session, ".state", "briefs", `T1-${launch}.red`);

    fs.mkdirSync(redDir, { recursive: true });
    fs.writeFileSync(
      path.join(redDir, "SC1.exit"),
      `${JSON.stringify({ status: 1, signal: null, error: null })}\n`
    );

    const result = await f.run(["review", "run", "T1", "--kind", "code"]);

    assert.equal(result.exit, 0, JSON.stringify(result.output));
    assert.equal(
      isRecord(result.value) && "findingsSection" in result.value,
      false,
      "code reviews update no document findings section"
    );

    const findings = readJson(
      text(defined(reviewResult(result).path, "path")),
      FindingsFileGuard
    );

    assert.equal(
      findings.findings.some((finding) =>
        finding.defect.startsWith("missing-red: T1 SC1;")
      ),
      false
    );
    assert.equal(
      defined(findings.escalations, "escalations").some((row) =>
        row.key.startsWith("missing-red:")
      ),
      false
    );
  } finally {
    f.cleanup();
  }
});

test("toolkit code review refuses an empty worktree diff before launching voices", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "empty-review-skill", {
      "read-delegates": { claude: { targets: [{ low: { model: "fake" } }] } },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    f.deps.liveness = { claude: true };
    f.deps.orchestrator = null;

    let launches = 0;

    f.deps.delegate = async () => {
      await Promise.resolve();
      launches += 1;

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify({ status: "CLEAN", findings: [] }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const recordsBefore = foldLedger(f.session).records.length;

    const result = await f.run([
      "review",
      "run",
      "worktree",
      "--kind",
      "code",
      "--spec",
      "work.spec.md",
      "--level",
      "low",
    ]);

    assert.equal(result.exit, 4, JSON.stringify(result.output));
    assert.equal(result.output.reason, "nothing-to-review");
    assert.equal(launches, 0);
    assert.equal(foldLedger(f.session).records.length, recordsBefore);

    const reviewsRoot = path.join(f.session, ".state/reviews");

    const rounds = fs.existsSync(reviewsRoot)
      ? fs
          .readdirSync(reviewsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) =>
            fs
              .readdirSync(path.join(reviewsRoot, entry.name))
              .filter((name) => /^round-\d+$/u.test(name))
          )
      : [];

    assert.deepEqual(rounds, []);
  } finally {
    f.cleanup();
  }
});

test("open slot rerun selects whole-target scope and leaves narrowing unchanged once nothing is open", async () => {
  const t = await coverageRepo(4);

  try {
    t.failing.add("claude");

    const first = await t.review();

    assert.equal(first.exit, 0, JSON.stringify(first.output));
    assert.deepEqual(
      t.findings(1).failed.map((reply) => reply.slot),
      ["claude[0]"]
    );
    t.failing.clear();
    t.calls.length = 0;

    const second = await t.review();

    assert.equal(second.exit, 0, JSON.stringify(second.output));

    const metadata = t.round(2);

    assert.equal(metadata.coverage, "open");
    assert.equal(metadata.coverageUse, undefined);
    assert.deepEqual(t.targets(2), ["claude[0]"]);
    assert.equal(
      metadata.scope,
      `Re-review round 2 (coverage) — changed paths: src/file.ts; comparison: ${metadata.target.base}..${metadata.target.head}`
    );
    assert.deepEqual(
      t.calls.map((call) => call.provider),
      ["claude"]
    );
    assert.ok(defined(t.calls[0], "call").prompt.includes(metadata.scope));

    const third = await t.review();

    assert.equal(third.exit, 0, JSON.stringify(third.output));
    assert.match(t.round(3).scope, /^Re-review round 3 \(narrowed\)/u);
    assert.equal(t.round(3).coverage, undefined);
  } finally {
    t.f.cleanup();
  }
});

test("open slot rerun selects whole-target scope with the full roster after a decisive finding", async () => {
  const t = await coverageRepo(4);

  try {
    t.failing.add("claude");
    t.replies.set("codex", MUST_FINDING);

    const first = await t.review();

    assert.equal(first.exit, 0);

    await t.accept("R1-F001");
    t.failing.clear();
    t.replies.delete("codex");
    t.calls.length = 0;

    const second = await t.review();

    assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.equal(t.round(2).coverage, "full");
    assert.deepEqual(t.targets(2), ["claude[0]", "codex[0]", "opencode[0]"]);
    assert.match(
      t.round(2).scope,
      /^Re-review round 2 \(coverage\) — changed paths: src\/file\.ts; comparison: /u
    );
    assert.deepEqual(
      t.calls.map((call) => call.provider).toSorted(),
      PROVIDERS
    );
  } finally {
    t.f.cleanup();
  }
});

const treeBytes = (directory: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(directory, { recursive: true, encoding: "utf-8" })
      .map((name) => {
        const file = path.join(directory, name);

        return [
          name,
          fs.statSync(file).isDirectory() ? "" : fs.readFileSync(file, "utf-8"),
        ];
      })
  );

/** Rewrites a saved findings payload as an earlier version saved it: no finding carries `proposedFix`. */
const dropProposedFix = (file: string) => {
  const saved = parseJson(fs.readFileSync(file, "utf-8"));

  if (!isRecord(saved) || !Array.isArray(saved["findings"])) {
    assert.fail("unexpected findings payload");
  }

  const findings = saved["findings"]
    .filter(isRecord)
    .map((finding) =>
      Object.fromEntries(
        Object.entries(finding).filter(([name]) => name !== "proposedFix")
      )
    );

  fs.writeFileSync(file, JSON.stringify({ ...saved, findings }));
};

test("review run refuses saved findings without proposedFix and leaves the ledger and review directory untouched", async () => {
  const t = await coverageRepo(4);

  try {
    t.replies.set("codex", MUST_FINDING);
    const first = await t.review();

    assert.equal(first.exit, 0);

    dropProposedFix(path.join(t.dir(1), "findings.json"));
    await t.accept("R1-F001");
    t.calls.length = 0;

    const reviewDir = path.dirname(t.dir(1));
    const ledger = path.join(t.f.session, "ledger.jsonl");

    const before = {
      ledger: fs.readFileSync(ledger, "utf-8"),
      tree: treeBytes(reviewDir),
    };

    const refused = await t.review();

    assert.equal(refused.exit, 4, JSON.stringify(refused.output));
    assert.equal(refused.output.reason, "stale-findings");
    assert.equal(t.calls.length, 0);
    assert.deepEqual(
      { ledger: fs.readFileSync(ledger, "utf-8"), tree: treeBytes(reviewDir) },
      before
    );
  } finally {
    t.f.cleanup();
  }
});

const acceptedRuling = (id: string) => ({
  kind: "ruling",
  by: "orchestrator",
  key: `ruling:code-integration:${id}`,
  data: {
    subject: `review:code-integration:${id}`,
    ruling: "accepted",
    rationale: "Verified the defect",
    fix: "proposed",
  },
});

const CHURN = [
  ["The file returns an invalid result", "Return the expected result"],
  ["The parser drops trailing input", "Read to the end of the buffer"],
  ["Retries never terminate", "Stop after the configured attempts"],
] as const;

test("a marked round needs a step-back outcome in its ruling batch and the next round runs as before", async () => {
  const t = await coverageRepo(4);

  try {
    const batch = (...items: object[]) => {
      const file = path.join(t.f.session, "batch.json");
      fs.writeFileSync(file, JSON.stringify(items));

      return file;
    };

    for (const [index, [defect, proposedFix]] of CHURN.entries()) {
      t.replies.set("codex", {
        status: "FINDINGS",
        findings: [{ ...MUST_FINDING.findings[0], defect, proposedFix }],
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- rounds run in order
      const ran = await t.review();
      assert.equal(ran.exit, 0, JSON.stringify(ran.output));

      if (index < CHURN.length - 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- rounds run in order
        await t.accept(`R${index + 1}-F001`);
      }
    }

    assert.deepEqual(t.findings(3).stepBack, { units: ["src/file.ts"] });
    assert.equal(t.findings(2).stepBack, undefined);

    const ledger = path.join(t.f.session, "ledger.jsonl");
    const before = fs.readFileSync(ledger, "utf-8");

    const refused = await t.f.run([
      "ledger",
      "append",
      batch(acceptedRuling("R3-F001")),
    ]);

    assert.equal(refused.exit, 1, JSON.stringify(refused.output));
    assert.equal(refused.output.reason, "invalid-record");
    assert.match(refused.output.summary, /step-back:code-integration:3/u);
    assert.equal(fs.readFileSync(ledger, "utf-8"), before);

    const outcome = {
      kind: "ruling",
      by: "orchestrator",
      key: "step-back:code-integration:3",
      data: {
        subject: "step-back:code-integration:3",
        ruling: "patch",
        rationale: "The cause is local to one file",
      },
    };

    const appended = await t.f.run([
      "ledger",
      "append",
      batch(acceptedRuling("R3-F001"), outcome),
    ]);

    assert.equal(appended.exit, 0, JSON.stringify(appended.output));

    const roster = t.targets(3);
    const fourth = await t.review();

    assert.equal(fourth.exit, 0, JSON.stringify(fourth.output));
    assert.deepEqual(t.targets(4), roster);
    assert.match(t.round(4).scope, /^Re-review round 4 \(/u);
  } finally {
    t.f.cleanup();
  }
});

test("coverage round follows an all-failed narrowed round at whole-target scope", async () => {
  const t = await coverageRepo(4);

  try {
    const first = await t.review();

    assert.equal(first.exit, 0);

    const narrowed = defined(t.targets(1)[0], "target");

    const provider = narrowed.replace(/\[\d+\]$/u, "");

    t.failing.add(provider);

    const second = await t.review();

    assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.match(t.round(2).scope, /^Re-review round 2 \(narrowed\)/u);
    assert.deepEqual(
      t.findings(2).failed.map((reply) => reply.slot),
      [narrowed]
    );
    t.failing.clear();

    const third = await t.review();

    assert.equal(third.exit, 0, JSON.stringify(third.output));
    assert.equal(t.round(3).coverage, "open");
    assert.deepEqual(t.targets(3), [narrowed]);
  } finally {
    t.f.cleanup();
  }
});

test("coverage round past the cap counts an all-failed open-only round as used and stops for a user decision", async () => {
  const t = await coverageRepo(1);

  try {
    t.failing.add("claude");
    t.failing.add("codex");

    const first = await t.review();

    assert.equal(first.exit, 0);

    const used = await t.review();

    assert.equal(used.exit, 0, JSON.stringify(used.output));
    assert.equal(t.round(2).coverageUse, "free");
    assert.deepEqual(t.targets(2), ["claude[0]", "codex[0]"]);
    assert.equal(reviewResult(used).round, 2);
    assert.equal(t.findings(2).failed.length, 2);

    const stopped = await t.review();

    assert.equal(stopped.output.reason, "coverage-decision");
    assert.match(stopped.output.summary, /accept[\s\S]*grant/u);
    assert.equal(fs.existsSync(path.join(t.dir(3), "round.json")), false);
    t.failing.clear();

    await appendRecord(
      t.f.session,
      {
        kind: "escalation",
        by: "user",
        quote: "one more try",
        key: "coverage:code-integration:1",
        data: {
          id: "coverage:code-integration:1",
          state: "resolved",
          summary: "grant: provider restored",
        },
      },
      t.f.deps
    );

    const granted = await t.review();

    assert.equal(granted.exit, 0, JSON.stringify(granted.output));
    assert.equal(t.round(3).coverageUse, "grant");
    assert.equal(t.round(3).coverage, "open");

    const capped = await t.review();

    assert.equal(
      capped.output.reason,
      "round-cap",
      "the grant is consumed and nothing is left open"
    );
  } finally {
    t.f.cleanup();
  }
});

test("coverage round accepted MUST past a used coverage round runs the full roster with no grant", async () => {
  const t = await coverageRepo(1);

  try {
    t.failing.add("claude");
    t.failing.add("codex");

    const first = await t.review();

    assert.equal(first.exit, 0);
    t.failing.delete("claude");
    t.replies.set("claude", MUST_FINDING);

    const second = await t.review();

    assert.equal(second.exit, 0);
    assert.equal(t.round(2).coverageUse, "free");

    await t.accept("R2-F001");
    t.failing.clear();
    t.replies.clear();

    const third = await t.review();

    assert.equal(third.exit, 0, JSON.stringify(third.output));
    assert.equal(t.round(3).coverage, "full");
    assert.equal(t.round(3).coverageUse, undefined);
  } finally {
    t.f.cleanup();
  }
});

test("coverage round full-roster all-failed reuses its number and keeps every failure through retry and native resume", async () => {
  const t = await coverageRepo(1);

  try {
    for (const provider of PROVIDERS) {
      t.failing.add(provider);
    }

    const failed = await t.review();

    assert.equal(failed.output.reason, "review-failed");
    assert.equal(t.attempts(1).length, 3);
    assert.deepEqual(
      t
        .attempts(1)
        .map((entry) => entry.slot)
        .toSorted(),
      ["claude[0]", "codex[0]", "opencode[0]"]
    );

    const retried = await t.review();

    assert.equal(retried.output.reason, "review-failed");
    assert.equal(t.attempts(1).length, 6);
    assert.equal(fs.existsSync(path.join(t.dir(1), "findings.json")), false);
    assert.equal(fs.existsSync(path.join(t.dir(2), "round.json")), false);

    t.f.deps.orchestrator = { platform: "claude", model: "native" };

    const launched = await t.review();

    assert.equal(launched.output.reason, "native-pending");
    assert.equal(pendingRun(launched).cliWave, "pending");
    assert.equal(t.attempts(1).length, 6);

    const pending = await t.review();

    assert.equal(pending.output.reason, "native-pending");
    assert.equal(pendingRun(pending).cliWave, "done");
    assert.equal(t.attempts(1).length, 8);
    fs.writeFileSync(
      defined(pendingRun(pending).pending[0], "pending").replyPath,
      JSON.stringify(CLEAN)
    );

    const resumed = await t.review();

    assert.equal(resumed.exit, 0, JSON.stringify(resumed.output));
    assert.equal(reviewResult(resumed).round, 1);
    assert.equal(t.findings(1).failed.length, 2);
    assert.equal(t.attempts(1).length, 10);
    assert.ok(
      t
        .attempts(1)
        .every((entry) => entry.wholeTarget && Number.isSafeInteger(entry.seq))
    );
  } finally {
    t.f.cleanup();
  }
});

test("repository changes list a tracked edit and rename made during a native round and keep every reply", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0, JSON.stringify(made.output));
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "native edit during round\n"
    );
    f.git(["mv", "src/file.ts", "src/renamed.ts"]);

    await Promise.all(
      pendingRun(waved).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      Array.isArray(reviewResult(done).repositoryChanges),
      "result lists repositoryChanges"
    );

    const listed = new Set(
      repositoryPaths(defined(reviewResult(done).repositoryChanges, "changes"))
    );

    assert.ok(
      listed.has("src/file.ts") && listed.has("src/renamed.ts"),
      `tracked edit and rename are listed: ${JSON.stringify(reviewResult(done).repositoryChanges)}`
    );

    const persisted = narrow(
      parseJson(
        fs.readFileSync(text(defined(reviewResult(done).path, "path")), "utf-8")
      ),
      objectWith({ repositoryChanges: arrayOf(RepoChangeEntryGuard) })
    );

    assert.deepEqual(
      persisted.repositoryChanges,
      reviewResult(done).repositoryChanges
    );

    const status = await f.run(["status", "show"]);

    assert.ok(Array.isArray(statusChanges(status)));
    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) =>
          entry.review === text(defined(reviewResult(done).review, "review"))
      )
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes skip ignored and session files while listing untracked and deleted paths", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "ignored"), "ignored edit\n");
    fs.writeFileSync(
      path.join(f.session, "untracked-session.txt"),
      "session edit\n"
    );
    fs.writeFileSync(path.join(f.root, "src/new-untracked.ts"), "untracked\n");
    fs.mkdirSync(path.join(f.root, "src", "newdir"), { recursive: true });
    fs.writeFileSync(
      path.join(f.root, "src", "newdir", "inner.ts"),
      "untracked inner\n"
    );
    fs.rmSync(path.join(f.root, "src/file.ts"));

    await Promise.all(
      pendingRun(waved).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = repositoryPaths(
      defined(reviewResult(done).repositoryChanges, "changes")
    );

    assert.ok(
      listed.includes("src/new-untracked.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      listed.includes("src/newdir/inner.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      listed.includes("src/file.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      !listed.includes("ignored"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      !listed.some((entry) => entry.includes("untracked-session")),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes report an unavailable check and keep replies when the task worktree is absent", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);

    const worktreePath = path.resolve(f.session, createdPath(made));

    fs.writeFileSync(path.join(worktreePath, "src/file.ts"), "candidate\n");

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.rmSync(worktreePath, { recursive: true, force: true });

    await Promise.all(
      pendingRun(waved).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryCheck?.state === "unavailable",
      JSON.stringify(done.value)
    );
    assert.ok(
      reviewResult(done).repositoryChanges === undefined,
      JSON.stringify(done.value)
    );

    const persisted = narrow(
      parseJson(
        fs.readFileSync(text(defined(reviewResult(done).path, "path")), "utf-8")
      ),
      objectWith({ repositoryCheck: RepositoryCheckGuard })
    );

    assert.equal(persisted.repositoryCheck.state, "unavailable");
  } finally {
    f.cleanup();
  }
});

test("cli-only rounds run no repository check and carry no baseline", async () => {
  {
    const f = await toolkitRepo();

    try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "cli-model" } }] },
        },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
      });
      f.deps.orchestrator = null;
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        "candidate\n"
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);
      fs.writeFileSync(
        path.join(f.root, "src/file.ts"),
        "edit without native\n"
      );

      const done = await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

      assert.equal(done.exit, 0, JSON.stringify(done.output));
      assert.ok(
        !("repositoryChanges" in narrow(done.value, isRecord)),
        JSON.stringify(done.value)
      );
      assert.ok(
        !("repositoryCheck" in narrow(done.value, isRecord)),
        JSON.stringify(done.value)
      );

      const status = await f.run(["status", "show"]);

      assert.ok(
        !("openRepositoryChanges" in narrow(status.value, isRecord)),
        "no open report"
      );
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await toolkitRepo();

    try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "cli-only-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "cli-model" } }] },
        },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
      });
      f.deps.orchestrator = null;
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        "candidate\n"
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      // A spec edit during fan-out supersedes the in-flight round to gen-2;
      // with no native voice no baseline exists to carry, so gen-2 runs no check.
      let moved = false;

      const run = async (hook?: (point: string) => Promise<void> | void) =>
        await f.run(
          [
            "review",
            "run",
            "T1",
            "--kind",
            "code",
            "--spec",
            "work.spec.md",
            "--level",
            "low",
          ],
          hook
        );

      const first = await run((point) => {
        if (point === "fanout:after-slot" && !moved) {
          moved = true;
          fs.appendFileSync(
            path.join(f.root, "work.spec.md"),
            "\nSupersede trigger\n"
          );
        }
      });

      assert.equal(
        first.output.reason,
        "target-moved",
        JSON.stringify(first.output)
      );

      const reviewDirs = fs.readdirSync(path.join(f.session, ".state/reviews"));

      assert.equal(reviewDirs.length, 1);

      const review = defined(reviewDirs[0], "review");

      assert.ok(
        !fs.existsSync(
          path.join(
            f.session,
            ".state/reviews",
            review,
            "round-1/gen-2/checkout-baseline.json"
          )
        ),
        "a cli-only supersede carries no baseline"
      );

      const second = await run();

      assert.equal(second.exit, 0, JSON.stringify(second.output));
      assert.ok(
        reviewResult(second).repositoryChanges === undefined,
        JSON.stringify(second.value)
      );
      assert.ok(
        reviewResult(second).repositoryCheck === undefined,
        JSON.stringify(second.value)
      );

      const status = await f.run(["status", "show"]);

      assert.deepEqual(
        statusChanges(status) ?? [],
        [],
        JSON.stringify(statusChanges(status))
      );
    } finally {
      f.cleanup();
    }
  }
});

test("repository changes list a mode change and an assume-unchanged edit", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);
    fs.writeFileSync(path.join(f.root, "src/mode.sh"), "echo hi\n");
    fs.writeFileSync(path.join(f.root, "src/staged.ts"), "staged base\n");
    f.git(["add", "src/mode.sh", "src/staged.ts"]);
    f.git(["commit", "-qm", "mode file"]);
    f.git(["update-index", "--assume-unchanged", "src/file.ts"]);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    f.git(["update-index", "--chmod=+x", "src/mode.sh"]);
    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "assume-unchanged edit\n"
    );
    fs.writeFileSync(
      path.join(f.root, "src", "untracked-mode.sh"),
      "echo hi\n"
    );
    f.git(["update-index", "--add", "--chmod=+x", "src/untracked-mode.sh"]);
    fs.writeFileSync(
      path.join(f.root, "src/staged.ts"),
      "staged new content\n"
    );
    f.git(["add", "src/staged.ts"]);
    fs.writeFileSync(path.join(f.root, "src/staged.ts"), "staged base\n");

    await Promise.all(
      pendingRun(waved).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = new Set(
      repositoryPaths(defined(reviewResult(done).repositoryChanges, "changes"))
    );

    assert.ok(
      listed.has("src/mode.sh"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      listed.has("src/file.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      listed.has("src/untracked-mode.sh"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      listed.has("src/staged.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes close with a keep note and admit one rerun round at the cap", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "rerun edit\n");

    await Promise.all(
      pendingRun(waved).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      JSON.stringify(done.value)
    );

    const review = text(defined(reviewResult(done).review, "review"));

    const checkout = narrow(
      parseJson(
        fs.readFileSync(
          path.join(
            f.session,
            ".state/reviews",
            review,
            "round-1/gen-1/checkout-report.json"
          ),
          "utf-8"
        )
      ),
      CheckoutReportGuard
    );

    let status = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) => entry.review === review && entry.round === 1
      )
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "Rerun after inspection",
        key: `repository-rerun:${review}:1:${defined(checkout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    status = await f.run(["status", "show"]);

    const open = openChanges(defined(statusChanges(status), "changes")).find(
      (entry) => entry.review === review && entry.round === 1
    );

    assert.ok(
      open !== undefined && open.rerunPending === true,
      JSON.stringify(statusChanges(status))
    );

    const rerunLaunched = await run();

    assert.equal(
      rerunLaunched.output.reason,
      "native-pending",
      JSON.stringify(rerunLaunched.output)
    );

    const rerunWaved = await run();

    assert.equal(rerunWaved.output.reason, "native-pending");

    await Promise.all(
      pendingRun(rerunWaved).pending.map(async (slot) => {
        await fs.promises.writeFile(slot.replyPath, JSON.stringify(CLEAN));
      })
    );

    const rerunDone = await run();

    assert.equal(rerunDone.exit, 0, JSON.stringify(rerunDone.output));
    assert.equal(reviewResult(rerunDone).round, 2);

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:${defined(checkout.asOfSeq, "asOfSeq")}`,
        data: { text: "explained" },
      },
      f.deps
    );

    status = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(status) ?? []).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      JSON.stringify(status.value)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes detect a second edit of an already dirty path", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "first dirty edit\n");

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "second dirty edit\n");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = repositoryPaths(
      defined(reviewResult(done).repositoryChanges, "changes")
    );

    assert.ok(
      listed.includes("src/file.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      "second edit is listed"
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes list task worktree and nested integration changes from their own roots", async () => {
  {
    const f = await toolkitRepo();

    try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "native-model" } }] },
        },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
      });
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        "candidate\n"
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const integrated = await f.run(["worktree", "integrate", "T1"]);

      assert.equal(integrated.exit, 0);

      const run = async () =>
        await f.run([
          "review",
          "run",
          "integration",
          "--kind",
          "code",
          "--spec",
          "work.spec.md",
          "--level",
          "low",
        ]);

      const launched = await run();

      assert.equal(launched.output.reason, "native-pending");

      const waved = await run();

      assert.equal(waved.output.reason, "native-pending");
      fs.writeFileSync(
        path.join(f.integration, "src/file.ts"),
        "integration edit during round\n"
      );

      for (const slot of pendingRun(waved).pending) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }

      const done = await run();

      assert.equal(done.exit, 0, JSON.stringify(done.output));
      assert.ok(
        reviewResult(done).repositoryChanges !== undefined,
        JSON.stringify(done.value)
      );

      const entry = narrow(
        defined(reviewResult(done).repositoryChanges, "changes"),
        arrayOf(RepoChangeEntryGuard)
      ).find((row) => path.resolve(row.cwd) === path.resolve(f.integration));

      const resolved = defined(entry, "entry");

      assert.ok(
        resolved.paths.includes("src/file.ts"),
        JSON.stringify(reviewResult(done).repositoryChanges)
      );
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await toolkitRepo();

    try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "native-model" } }] },
        },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
      });
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);

      const worktree = path.resolve(f.session, createdPath(made));

      fs.writeFileSync(path.join(worktree, "src/file.ts"), "candidate\n");

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const run = async () =>
        await f.run([
          "review",
          "run",
          "T1",
          "--kind",
          "code",
          "--spec",
          "work.spec.md",
          "--level",
          "low",
        ]);

      const launched = await run();

      assert.equal(launched.output.reason, "native-pending");

      const waved = await run();

      assert.equal(waved.output.reason, "native-pending");
      fs.writeFileSync(
        path.join(worktree, "src/file.ts"),
        "worktree edit during round\n"
      );

      for (const slot of pendingRun(waved).pending) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }

      const done = await run();

      assert.equal(done.exit, 0, JSON.stringify(done.output));

      const entry = narrow(
        defined(reviewResult(done).repositoryChanges, "changes"),
        arrayOf(RepoChangeEntryGuard)
      ).find((row) => path.resolve(row.cwd) === worktree);

      const resolved = defined(entry, "entry");

      assert.ok(
        resolved.paths.includes("src/file.ts"),
        JSON.stringify(reviewResult(done).repositoryChanges)
      );
    } finally {
      f.cleanup();
    }
  }
});

test("repository changes rerun a mixed round at whole-target scope and settle later rounds", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
        agy: { targets: [{ low: { model: "cli-model" } }] },
      },
      phases: { "code-review": { targets: { low: 2 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true, agy: true };
    f.deps.delegate = async (provider) => {
      await Promise.resolve();

      if (provider !== "agy") {
        throw new Error("CLI wave must only run agy");
      }

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "mixed rerun edit\n");

    for (const slot of narrow(
      pendingRun(waved).pending,
      arrayOf(PendingSlotGuard)
    )) {
      if (slot.slot.startsWith("claude")) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      JSON.stringify(done.value)
    );

    const review = text(defined(reviewResult(done).review, "review"));

    const checkout = readJson(
      path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1/gen-1/checkout-report.json"
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "rerun mixed",
        key: `repository-rerun:${review}:1:${defined(checkout.asOfSeq, "checkout.asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const relaunched = await run();

    assert.equal(relaunched.output.reason, "native-pending");

    const waved2 = await run();

    assert.equal(waved2.output.reason, "native-pending");

    const round2 = readJson(
      path.join(f.session, ".state/reviews", review, "round-2/round.json"),
      RoundFileGuard
    );

    assert.ok(round2.scope.startsWith("Full review"), round2.scope);
    assert.deepEqual(
      round2.roster
        .filter((slot) => slot.reserve !== true)
        .map((slot) => slot.slot)
        .toSorted(),
      ["agy[0]", "claude[0]"]
    );

    for (const slot of narrow(
      pendingRun(waved2).pending,
      arrayOf(PendingSlotGuard)
    )) {
      if (slot.slot.startsWith("claude")) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }
    }

    const redone = await run();

    assert.equal(redone.exit, 0, JSON.stringify(redone.output));
    assert.equal(reviewResult(redone).round, 2);

    const status = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(status) ?? []).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      JSON.stringify(status.value)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes list edits from a native-only round", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        codex: {
          nativeSubagentsOnly: true,
          targets: [{ low: { model: "native" } }],
        },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "codex", model: null };
    f.deps.liveness = {};
    f.deps.delegate = async () => {
      await Promise.resolve();

      throw new Error("native-only must not call cli");
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
        "--host",
        "codex",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");
    assert.equal(pendingRun(launched).pending.length, 1);
    assert.ok(!("cliWave" in narrow(launched.value, isRecord)));
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "native-only edit\n");

    for (const slot of pendingRun(launched).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = repositoryPaths(
      defined(reviewResult(done).repositoryChanges, "changes")
    );

    assert.ok(
      listed.includes("src/file.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes keep review-failed and name paths for an all-failed round", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: { status: "fail", cls: "auth", detail: "denied" },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "change before all-failed\n"
    );

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, "INVALID REPORT");
    }

    const failed = await run();

    assert.equal(
      failed.output.reason,
      "review-failed",
      JSON.stringify(failed.output)
    );
    assert.match(failed.output.summary, /src\/file\.ts/u);

    const reviewDirs = fs.readdirSync(path.join(f.session, ".state/reviews"));

    assert.ok(reviewDirs.length > 0);

    const reviewName = defined(reviewDirs[0], "review");

    const report = readJson(
      path.join(
        f.session,
        ".state/reviews",
        reviewName,
        "round-1/gen-1/checkout-report.json"
      ),
      CheckoutReportGuard
    );

    assert.ok(
      (report.repositoryChanges ?? [])
        .flatMap((entry) => entry.paths)
        .includes("src/file.ts"),
      JSON.stringify(report)
    );

    const status = await f.run(["status", "show"]);

    const open = openChanges(defined(statusChanges(status), "changes")).flatMap(
      (row) => repositoryPaths(row.repositoryChanges ?? [])
    );

    assert.ok(
      open.includes("src/file.ts"),
      JSON.stringify(statusChanges(status))
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes report unavailable when baseline capture fails and keep replies", async () => {
  await Promise.all(
    (["missing-worktree", "corrupt-baseline"] as const).map(async (mode) => {
      const f = await toolkitRepo();

      try {
        f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
          "read-delegates": {
            claude: { targets: [{ low: { model: "native-model" } }] },
          },
          phases: {
            "code-review": { targets: { low: 1 }, rounds: { low: 2 } },
          },
        });
        f.deps.orchestrator = { platform: "claude", model: null };
        f.deps.liveness = { claude: true };
        f.deps.delegate = async () => {
          await Promise.resolve();

          return {
            outcome: {
              status: "ok",
              text: JSON.stringify(CLEAN),
              resume: null,
              sessionId: null,
            },
            invocations: [],
          };
        };

        await f.level("low");
        await f.approve();

        const made = await f.run(["worktree", "create", "T1"]);

        assert.equal(made.exit, 0);

        const worktree = path.resolve(f.session, createdPath(made));

        fs.writeFileSync(path.join(worktree, "src/file.ts"), "candidate\n");

        const submitted = await f.run(["worktree", "submit", "T1"]);

        assert.equal(submitted.exit, 0);

        if (mode === "missing-worktree") {
          fs.rmSync(worktree, { recursive: true, force: true });
        }

        const run = async () =>
          await f.run([
            "review",
            "run",
            "T1",
            "--kind",
            "code",
            "--spec",
            "work.spec.md",
            "--level",
            "low",
          ]);

        const launched = await run();

        assert.equal(launched.output.reason, "native-pending");

        const waved = await run();

        assert.equal(waved.output.reason, "native-pending");

        const review = text(defined(reviewResult(waved).review, "review"));

        if (mode === "corrupt-baseline") {
          fs.writeFileSync(
            path.join(f.root, "src/file.ts"),
            "edit before corrupt baseline\n"
          );
          fs.writeFileSync(
            path.join(
              f.session,
              ".state/reviews",
              review,
              "round-1/gen-1/checkout-baseline.json"
            ),
            "null"
          );
        }

        for (const slot of pendingRun(waved).pending) {
          fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
        }

        const done = await run();

        assert.equal(done.exit, 0, `${JSON.stringify(done.output)} ${mode}`);
        assert.ok(
          reviewResult(done).repositoryCheck?.state === "unavailable",
          `${JSON.stringify(done.value)} ${mode}`
        );
        assert.ok(
          reviewResult(done).repositoryChanges === undefined,
          `${JSON.stringify(done.value)} ${mode}`
        );
      } finally {
        f.cleanup();
      }
    })
  );
});

test("repository changes return target-moved when the review target itself changes", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
        agy: { targets: [{ low: { model: "cli-model" } }] },
      },
      phases: { "code-review": { targets: { low: 2 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true, agy: true };
    f.deps.delegate = async (provider) => {
      await Promise.resolve();

      if (provider !== "agy") {
        throw new Error("CLI wave must only run agy");
      }

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    fs.writeFileSync(path.join(f.root, "src/file.ts"), "worktree base\n");

    const run = async (hook?: (point: string) => Promise<void> | void) =>
      await f.run(
        [
          "review",
          "run",
          "worktree",
          "--kind",
          "code",
          "--spec",
          "work.spec.md",
          "--level",
          "low",
        ],
        hook
      );

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const moved = await run((point) => {
      if (point === "review:after-pending") {
        fs.writeFileSync(
          path.join(f.root, "src/file.ts"),
          "target edit during finalization\n"
        );
      }
    });

    assert.equal(
      moved.output.reason,
      "target-moved",
      JSON.stringify(moved.output)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes list a moved HEAD diff in a plan review including both rename sides", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "plan-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const run = async () =>
      await f.run([
        "review",
        "run",
        "work.plan.md",
        "--kind",
        "plan",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    f.git(["mv", "src/file.ts", "src/renamed.ts"]);
    f.git(["commit", "-qm", "rename"]);

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = new Set(
      repositoryPaths(defined(reviewResult(done).repositoryChanges, "changes"))
    );

    assert.ok(
      listed.has("src/file.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
    assert.ok(
      listed.has("src/renamed.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes stay open after an interruption between findings and the result file", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "interrupted change\n");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      JSON.stringify(done.value)
    );
    fs.rmSync(defined(done.output.path, "done.output.path"), { force: true });

    const status = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) =>
          entry.review === text(defined(reviewResult(done).review, "review"))
      ),
      "interrupted change stays open"
    );

    const checkout = narrow(
      parseJson(
        fs.readFileSync(
          path.join(
            f.session,
            ".state/reviews",
            text(defined(reviewResult(done).review, "review")),
            "round-1/gen-1/checkout-report.json"
          ),
          "utf-8"
        )
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${text(defined(reviewResult(done).review, "review"))}:1:${defined(checkout.asOfSeq, "asOfSeq")}`,
        data: { text: "explained" },
      },
      f.deps
    );

    const closed = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(closed) ?? []).some(
        (entry) =>
          entry.review === text(defined(reviewResult(done).review, "review"))
      ),
      JSON.stringify(closed.value)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes stay open after an interrupted failed check until a closing note exists", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);

    const worktree = path.resolve(f.session, createdPath(made));

    fs.writeFileSync(path.join(worktree, "src/file.ts"), "candidate\n");

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.rmSync(worktree, { recursive: true, force: true });

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryCheck !== undefined,
      JSON.stringify(done.value)
    );
    fs.rmSync(defined(done.output.path, "done.output.path"), { force: true });

    const status = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) => entry.repositoryCheck !== undefined
      ),
      JSON.stringify(status.value)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes keep rerunPending through an interrupted rerun round", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "rerun interrupt edit\n"
    );

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const review = text(defined(reviewResult(done).review, "review"));

    const checkout = narrow(
      parseJson(
        fs.readFileSync(
          path.join(
            f.session,
            ".state/reviews",
            review,
            "round-1/gen-1/checkout-report.json"
          ),
          "utf-8"
        )
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "rerun",
        key: `repository-rerun:${review}:1:${defined(checkout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const relaunched = await run();

    assert.equal(relaunched.output.reason, "native-pending");

    let status = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) =>
          entry.review === review &&
          entry.round === 1 &&
          entry.rerunPending === true
      ),
      JSON.stringify(status.value)
    );

    const waved2 = await run();

    assert.equal(waved2.output.reason, "native-pending");

    for (const slot of pendingRun(waved2).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const redone = await run();

    assert.equal(redone.exit, 0, JSON.stringify(redone.output));
    assert.equal(reviewResult(redone).round, 2);

    status = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(status) ?? []).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      JSON.stringify(status.value)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes refuse a rerun at the ceiling but keep the report open", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };

    const MUST = {
      status: "FINDINGS",
      findings: [
        {
          impact: "blocks",
          trigger: "realistic",
          tag: "correctness",
          locus: "src/file.ts:L1",
          defect: "The file returns an invalid result",
          proposedFix: "Return the expected result",
        },
      ],
    };

    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const completeRound = async (edit: string, reply: JsonValue = CLEAN) => {
      const launched = await run();

      assert.equal(launched.output.reason, "native-pending");

      const waved = await run();

      assert.equal(waved.output.reason, "native-pending");
      fs.writeFileSync(path.join(f.root, "src/file.ts"), edit);

      for (const slot of pendingRun(waved).pending) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(reply));
      }

      const done = await run();

      assert.equal(done.exit, 0, JSON.stringify(done.output));

      return narrow(
        done.value,
        objectWith({ review: isString, round: isNumber })
      );
    };

    const first = await completeRound("ceiling edit one\n");

    const firstCheckout = narrow(
      parseJson(
        fs.readFileSync(
          path.join(
            f.session,
            ".state/reviews",
            first.review,
            "round-1/gen-1/checkout-report.json"
          ),
          "utf-8"
        )
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "rerun",
        key: `repository-rerun:${first.review}:1:${defined(firstCheckout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const second = await completeRound("ceiling edit two\n");

    assert.equal(second.round, 2);

    const secondCheckout = narrow(
      parseJson(
        fs.readFileSync(
          path.join(
            f.session,
            ".state/reviews",
            second.review,
            "round-2/gen-1/checkout-report.json"
          ),
          "utf-8"
        )
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "rerun",
        key: `repository-rerun:${second.review}:2:${defined(secondCheckout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const third = await completeRound("ceiling edit three\n", MUST);

    assert.equal(third.round, 3);

    await appendRecord(
      f.session,
      {
        kind: "ruling",
        by: "orchestrator",
        key: "accept-ceiling",
        data: {
          subject: `review:${third.review}:R3-F001`,
          ruling: "accepted",
          fix: "proposed",
          rationale: "Fix accepted",
        },
      },
      f.deps
    );

    const thirdCheckout = narrow(
      parseJson(
        fs.readFileSync(
          path.join(
            f.session,
            ".state/reviews",
            third.review,
            "round-3/gen-1/checkout-report.json"
          ),
          "utf-8"
        )
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "rerun",
        key: `repository-rerun:${third.review}:3:${defined(thirdCheckout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const refused = await run();

    assert.equal(
      refused.output.reason,
      "review-ceiling",
      JSON.stringify(refused.output)
    );

    const status = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) =>
          entry.review === third.review &&
          entry.round === 3 &&
          entry.rerunPending === true
      ),
      JSON.stringify(status.value)
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes report unavailable for a dirty submodule re-edit with ignore dirty", async () => {
  const f = await toolkitRepo();

  try {
    const subSrc = fs.mkdtempSync(path.join(os.tmpdir(), "submod-src-"));

    try {
      const gitSrc = (args: string[]) => {
        const result = spawnSync("git", args, {
          cwd: subSrc,
          encoding: "utf-8",
        });

        assert.equal(result.status, 0, result.stderr);
      };

      gitSrc(["init", "-b", "main"]);
      gitSrc(["config", "user.email", "test@example.test"]);
      gitSrc(["config", "user.name", "Toolkit Test"]);
      fs.writeFileSync(path.join(subSrc, "file.txt"), "base\n");
      gitSrc(["add", "."]);
      gitSrc(["commit", "-m", "base"]);

      const subUrl = subSrc.split(path.sep).join("/");

      const add = spawnSync(
        "git",
        [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          subUrl,
          "submod",
        ],
        {
          cwd: f.root,
          encoding: "utf-8",
        }
      );

      assert.equal(add.status, 0, add.stderr);
      f.git(["add", ".gitmodules", "submod"]);
      f.git(["commit", "-qm", "add submodule"]);
      f.git([
        "config",
        "-f",
        ".gitmodules",
        "submodule.submod.ignore",
        "dirty",
      ]);
      f.git(["add", ".gitmodules"]);
      f.git(["commit", "-qm", "ignore dirty"]);
      fs.writeFileSync(
        path.join(f.root, "submod", "file.txt"),
        "dirty before\n"
      );
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "native-model" } }] },
        },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
      });
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        "candidate\n"
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const run = async () =>
        await f.run([
          "review",
          "run",
          "T1",
          "--kind",
          "code",
          "--spec",
          "work.spec.md",
          "--level",
          "low",
        ]);

      const launched = await run();

      assert.equal(launched.output.reason, "native-pending");

      const waved = await run();

      assert.equal(waved.output.reason, "native-pending");
      fs.writeFileSync(
        path.join(f.root, "submod", "file.txt"),
        "dirty after\n"
      );

      for (const slot of pendingRun(waved).pending) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }

      const done = await run();

      assert.equal(done.exit, 0, JSON.stringify(done.output));
      assert.ok(
        reviewResult(done).repositoryCheck?.state === "unavailable",
        JSON.stringify(done.value)
      );
      assert.match(
        defined(reviewResult(done).repositoryCheck?.reason, "reason"),
        /Dirty submodule/u
      );
      assert.ok(
        reviewResult(done).repositoryChanges === undefined,
        JSON.stringify(done.value)
      );
    } finally {
      fs.rmSync(subSrc, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});

test("repository changes report unavailable when checkout reads fail", async (t) => {
  const patches = [
    {
      name: "stat",
      patch: (target: string) => {
        const orig = fs.lstatSync;

        const stat = t.mock.method(
          fs,
          "lstatSync",
          (...args: Parameters<typeof orig>) => {
            const [targetPath] = args;

            if (isString(targetPath) && path.resolve(targetPath) === target) {
              denied();
            }

            return orig(...args);
          }
        );

        return () => {
          stat.mock.restore();
        };
      },
    },
    {
      name: "read",
      patch: (target: string) => {
        const orig = fs.readFileSync;

        const origOpen = fs.openSync;

        const read = t.mock.method(
          fs,
          "readFileSync",
          (...args: Parameters<typeof orig>) => {
            const [targetPath] = args;

            if (isString(targetPath) && path.resolve(targetPath) === target) {
              denied();
            }

            return orig(...args);
          }
        );

        // Content fingerprints stream through openSync: fail the open too, so a
        // read failure still surfaces as an unavailable check.
        const open = t.mock.method(
          fs,
          "openSync",
          (...args: Parameters<typeof origOpen>) => {
            const [targetPath] = args;

            if (isString(targetPath) && path.resolve(targetPath) === target) {
              denied();
            }

            return origOpen(...args);
          }
        );

        return () => {
          open.mock.restore();
          read.mock.restore();
        };
      },
    },
    {
      name: "readlink",
      patch: (target: string) => {
        const origLstat = fs.lstatSync;

        const origLink = fs.readlinkSync;

        const stat = t.mock.method(
          fs,
          "lstatSync",
          (...args: Parameters<typeof origLstat>) => {
            const [targetPath] = args;

            if (isString(targetPath) && path.resolve(targetPath) === target) {
              return {
                isSymbolicLink: () => true,
                isDirectory: () => false,
                mode: 0,
              } satisfies {
                isSymbolicLink: () => boolean;
                isDirectory: () => boolean;
                mode: number;
              };
            }

            return origLstat(...args);
          }
        );

        const link = t.mock.method(
          fs,
          "readlinkSync",
          (...args: Parameters<typeof origLink>) => {
            const [targetPath] = args;

            if (isString(targetPath) && path.resolve(targetPath) === target) {
              denied();
            }

            return origLink(...args);
          }
        );

        return () => {
          link.mock.restore();
          stat.mock.restore();
        };
      },
    },
  ];

  const runMode = async (mode: (typeof patches)[number]) => {
    const f = await toolkitRepo();

    try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "native-model" } }] },
        },
        phases: {
          "code-review": { targets: { low: 1 }, rounds: { low: 2 } },
        },
      });
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        "candidate\n"
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const run = async () =>
        await f.run([
          "review",
          "run",
          "T1",
          "--kind",
          "code",
          "--spec",
          "work.spec.md",
          "--level",
          "low",
        ]);

      const launched = await run();

      assert.equal(launched.output.reason, "native-pending");

      const waved = await run();

      assert.equal(waved.output.reason, "native-pending");

      const target = path.join(f.root, "src/file.ts");

      fs.writeFileSync(target, `edit for ${mode.name}\n`);

      for (const slot of pendingRun(waved).pending) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }

      const restore = mode.patch(target);

      const done = await (async () => {
        try {
          return await run();
        } finally {
          restore();
        }
      })();

      assert.equal(done.exit, 0, `${JSON.stringify(done.output)} ${mode.name}`);
      assert.ok(
        reviewResult(done).repositoryCheck?.state === "unavailable",
        `${JSON.stringify(done.value)} ${mode.name}`
      );
    } finally {
      f.cleanup();
    }
  };

  // Modes share the global fs mocks, so a parallel restore would drop another mode's lstatSync patch.
  for (const mode of patches) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential modes keep each fs patch isolated
    await runMode(mode);
  }
});

test("repository changes carry the baseline across a superseded round", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const review = text(defined(reviewResult(launched).review, "review"));

    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "edit before supersede\n"
    );
    fs.appendFileSync(
      path.join(f.root, "work.spec.md"),
      "\nSupersede trigger\n"
    );

    const superseded = await run();

    assert.equal(
      superseded.output.reason,
      "native-pending",
      JSON.stringify(superseded.output)
    );

    const gen1 = parseJson(
      fs.readFileSync(
        path.join(
          f.session,
          ".state/reviews",
          review,
          "round-1/gen-1/checkout-baseline.json"
        ),
        "utf-8"
      )
    );

    const gen2Path = path.join(
      f.session,
      ".state/reviews",
      review,
      "round-1/gen-2/checkout-baseline.json"
    );

    assert.ok(fs.existsSync(gen2Path), "carried baseline exists");
    assert.deepEqual(parseJson(fs.readFileSync(gen2Path, "utf-8")), gen1);

    for (const slot of pendingRun(superseded).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const waved = await run();

    assert.equal(
      waved.output.reason,
      "native-pending",
      JSON.stringify(waved.output)
    );

    for (const slot of pendingRun(waved).pending) {
      if (!fs.existsSync(slot.replyPath)) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = repositoryPaths(
      defined(reviewResult(done).repositoryChanges, "changes")
    );

    assert.ok(
      listed.includes("src/file.ts"),
      JSON.stringify(reviewResult(done).repositoryChanges)
    );
  } finally {
    f.cleanup();
  }

  const g = await toolkitRepo();

  try {
    g.deps.skillRoot = setupTestSkill(g.deps, g.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    g.deps.orchestrator = { platform: "claude", model: null };
    g.deps.liveness = { claude: true };
    g.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await g.level("low");
    await g.approve();

    const made = await g.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(g.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await g.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await g.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const review = text(defined(reviewResult(launched).review, "review"));

    fs.rmSync(
      path.join(
        g.session,
        ".state/reviews",
        review,
        "round-1/gen-1/checkout-baseline.json"
      )
    );
    fs.appendFileSync(
      path.join(g.root, "work.spec.md"),
      "\nSupersede trigger\n"
    );

    const superseded = await run();

    assert.equal(
      superseded.output.reason,
      "native-pending",
      JSON.stringify(superseded.output)
    );

    const gen2 = narrow(
      parseJson(
        fs.readFileSync(
          path.join(
            g.session,
            ".state/reviews",
            review,
            "round-1/gen-2/checkout-baseline.json"
          ),
          "utf-8"
        )
      ),
      objectWith({ state: isString, reason: maybe(isString) })
    );

    assert.equal(
      gen2.state,
      "unavailable",
      `a predecessor that launched a native voice but lost its baseline carries unavailable: ${JSON.stringify(gen2)}`
    );
    assert.match(
      defined(gen2.reason, "reason"),
      /missing after native launch/u
    );

    for (const slot of pendingRun(superseded).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const waved = await run();

    assert.equal(
      waved.output.reason,
      "native-pending",
      JSON.stringify(waved.output)
    );

    for (const slot of pendingRun(waved).pending) {
      if (!fs.existsSync(slot.replyPath)) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryCheck?.state === "unavailable",
      `a lost baseline reports unavailable instead of clean: ${JSON.stringify(done.value)}`
    );
    assert.ok(
      reviewResult(done).repositoryChanges === undefined,
      JSON.stringify(done.value)
    );
  } finally {
    g.cleanup();
  }
});

test("reused round number keeps a later report open and admits a whole-target rerun", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "rerun edit\n");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      JSON.stringify(done.value)
    );

    const review = text(defined(reviewResult(done).review, "review"));

    const roundDir = path.join(f.session, ".state/reviews", review, "round-1");

    const firstCheckout = readJson(
      path.join(roundDir, "gen-1/checkout-report.json"),
      CheckoutReportGuard
    );

    const firstSeq = defined(firstCheckout.asOfSeq, "asOfSeq");

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:${firstSeq}`,
        data: { text: "explained" },
      },
      f.deps
    );

    const closeSeq = defined(
      foldLedger(f.session).records.findLast(
        (row) =>
          row.kind === "note" &&
          row.key === `repository-changes:${review}:1:${firstSeq}`
      ),
      "note"
    ).seq;

    let status = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(status) ?? []).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      `the acknowledged report stays closed: ${JSON.stringify(statusChanges(status))}`
    );

    // A later report under the reused round number stays open. The rerun note
    // names the later report, so its suffix matches the later identity.
    const laterSeq = closeSeq + 1;

    assert.ok(laterSeq > closeSeq);
    fs.mkdirSync(path.join(roundDir, "gen-9"), { recursive: true });
    fs.writeFileSync(
      path.join(roundDir, "gen-9", "checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: f.root, paths: ["src/file.ts"] }],
        asOfSeq: laterSeq,
      })
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "Rerun after inspection",
        key: `repository-rerun:${review}:1:${laterSeq}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    status = await f.run(["status", "show"]);

    const open = openChanges(defined(statusChanges(status), "changes")).find(
      (entry) => entry.review === review && entry.round === 1
    );

    assert.ok(
      open !== undefined && open.rerunPending === true,
      `a later report under a reused number stays open with rerunPending: ${JSON.stringify(statusChanges(status))}`
    );

    const rerun = await run();

    assert.equal(
      rerun.output.reason,
      "native-pending",
      JSON.stringify(rerun.output)
    );
    assert.equal(
      reviewResult(rerun).round,
      2,
      "the rerun grant admits round 2 above the cap"
    );

    const round2 = readJson(
      path.join(f.session, ".state/reviews", review, "round-2/round.json"),
      RoundFileGuard
    );

    assert.ok(
      round2.scope.startsWith("Full review"),
      `a rerun runs at whole-target scope: ${round2.scope}`
    );
    assert.deepEqual(
      round2.roster
        .filter((slot) => slot.reserve !== true)
        .map((slot) => slot.slot),
      ["claude[0]"]
    );
  } finally {
    f.cleanup();
  }

  const g = await toolkitRepo();

  try {
    g.deps.skillRoot = setupTestSkill(g.deps, g.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    g.deps.orchestrator = { platform: "claude", model: null };
    g.deps.liveness = { claude: true };
    g.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await g.level("low");
    await g.approve();

    const made = await g.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(g.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await g.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await g.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(g.root, "src/file.ts"), "rerun edit\n");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      JSON.stringify(done.value)
    );

    const review = text(defined(reviewResult(done).review, "review"));

    const roundDir = path.join(g.session, ".state/reviews", review, "round-1");

    const firstCheckout = readJson(
      path.join(roundDir, "gen-1/checkout-report.json"),
      CheckoutReportGuard
    );

    const firstSeq = defined(firstCheckout.asOfSeq, "asOfSeq");

    await appendRecord(
      g.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:${firstSeq}`,
        data: { text: "explained" },
      },
      g.deps
    );

    const closeSeq = defined(
      foldLedger(g.session).records.findLast(
        (row) =>
          row.kind === "note" &&
          row.key === `repository-changes:${review}:1:${firstSeq}`
      ),
      "note"
    ).seq;

    // No ledger record lands between the closing note and the later report:
    // the report carries the note's own sequence and still stays open.
    fs.mkdirSync(path.join(roundDir, "gen-9"), { recursive: true });
    fs.writeFileSync(
      path.join(roundDir, "gen-9", "checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: g.root, paths: ["src/file.ts"] }],
        asOfSeq: closeSeq,
      })
    );

    let status = await g.run(["status", "show"]);

    const open = openChanges(defined(statusChanges(status), "changes")).find(
      (entry) => entry.review === review && entry.round === 1
    );

    assert.ok(
      open !== undefined && open.rerunPending !== true,
      `an equal-seq later report stays open: ${JSON.stringify(statusChanges(status))}`
    );

    await appendRecord(
      g.session,
      {
        kind: "note",
        by: "user",
        quote: "Rerun after inspection",
        key: `repository-rerun:${review}:1:${closeSeq}`,
        data: { text: "rerun" },
      },
      g.deps
    );

    status = await g.run(["status", "show"]);

    assert.equal(
      openChanges(defined(statusChanges(status), "changes")).find(
        (entry) => entry.review === review && entry.round === 1
      )?.rerunPending,
      true
    );

    const rerun = await run();

    assert.equal(
      rerun.output.reason,
      "native-pending",
      JSON.stringify(rerun.output)
    );
    assert.equal(
      reviewResult(rerun).round,
      2,
      "the equal-seq report admits the rerun grant"
    );
  } finally {
    g.cleanup();
  }
});

test("retry after all-failed uses no host CLI and keeps the first report until a closing note", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: { status: "fail", cls: "auth", detail: "denied" },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");

    const review = text(defined(reviewResult(waved).review, "review"));

    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "change before all-failed\n"
    );

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, "INVALID REPORT");
    }

    const failed = await run();

    assert.equal(failed.output.reason, "review-failed");
    // Restore the changed path, then retry: the new compare is clean,
    // but the first unacknowledged report must stay open.
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "initial\n");

    const retry = await run();

    assert.equal(
      retry.output.reason,
      "review-failed",
      JSON.stringify(retry.output)
    );

    const kept = readJson(
      path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1/gen-1/checkout-report.json"
      ),
      CheckoutReportGuard
    );

    assert.ok(
      repositoryPaths(defined(kept.repositoryChanges, "changes")).includes(
        "src/file.ts"
      )
    );

    const retryStatus = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(retryStatus), "changes"))
        .flatMap((row) =>
          repositoryPaths(defined(row.repositoryChanges, "paths"))
        )
        .includes("src/file.ts"),
      `the first report survives a clean retry: ${JSON.stringify(statusChanges(retryStatus))}`
    );

    // Recover the CLI: the failed native slot still must not use it
    // (REQ-3: the host CLI never runs for the host provider), so the
    // retry stays failed and the first report stays open until the
    // orchestrator closes it with a note.
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    const done = await run();

    assert.equal(
      done.output.reason,
      "review-failed",
      `no host CLI on retry: ${JSON.stringify(done.output)}`
    );

    let status = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      `the failed report stays open after a clean success: ${JSON.stringify(statusChanges(status))}`
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:${defined(kept.asOfSeq, "asOfSeq")}`,
        data: { text: "explained" },
      },
      f.deps
    );

    status = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(status) ?? []).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      `a closing note clears the retained report: ${JSON.stringify(statusChanges(status))}`
    );
  } finally {
    f.cleanup();
  }
});

test("quoted rerun for an all-failed report starts a fresh whole-target round", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: { status: "fail", cls: "auth", detail: "denied" },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");

    const review = text(defined(reviewResult(waved).review, "review"));

    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "change before all-failed\n"
    );

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, "INVALID REPORT");
    }

    const failed = await run();

    assert.equal(failed.output.reason, "review-failed");

    const failedCheckout = readJson(
      path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1/gen-1/checkout-report.json"
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "Rerun after inspection",
        key: `repository-rerun:${review}:1:${defined(failedCheckout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const rerun = await run();

    assert.equal(
      rerun.output.reason,
      "native-pending",
      `the rerun note starts a fresh round: ${JSON.stringify(rerun.output)}`
    );
    assert.equal(reviewResult(rerun).round, 2);

    const round2 = readJson(
      path.join(f.session, ".state/reviews", review, "round-2/round.json"),
      RoundFileGuard
    );

    assert.ok(
      round2.scope.startsWith("Full review"),
      `a rerun runs at whole-target scope: ${round2.scope}`
    );
    assert.deepEqual(
      round2.roster
        .filter((slot) => slot.reserve !== true)
        .map((slot) => slot.slot),
      ["claude[0]"]
    );

    // The failed report stays open with rerunPending until the rerun completes.
    let status = await f.run(["status", "show"]);

    const open = openChanges(defined(statusChanges(status), "changes")).find(
      (entry) => entry.review === review && entry.round === 1
    );

    assert.ok(
      open !== undefined && open.rerunPending === true,
      `the failed report waits for its rerun: ${JSON.stringify(statusChanges(status))}`
    );

    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    const waved2 = await run();

    assert.equal(waved2.output.reason, "native-pending");

    for (const slot of pendingRun(waved2).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const finished = await run();

    assert.equal(finished.exit, 0, JSON.stringify(finished.output));

    status = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(status) ?? []).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      `the failed report clears once its rerun finalizes: ${JSON.stringify(statusChanges(status))}`
    );
  } finally {
    f.cleanup();
  }
});

test("one per-report note closes a report from normal finalization", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "finalized edit\n");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      JSON.stringify(done.value)
    );

    const review = text(defined(reviewResult(done).review, "review"));

    const roundDir = path.join(f.session, ".state/reviews", review, "round-1");

    const checkout = readJson(
      path.join(roundDir, "gen-1/checkout-report.json"),
      CheckoutReportGuard
    );

    const finalized = narrow(
      parseJson(
        fs.readFileSync(text(defined(reviewResult(done).path, "path")), "utf-8")
      ),
      objectWith({ asOfSeq: maybe(isNumber) })
    );

    assert.equal(
      finalized.asOfSeq,
      defined(checkout.asOfSeq, "asOfSeq"),
      "the finalized findings copy carries the report identity"
    );

    let status = await f.run(["status", "show"]);

    assert.ok(
      openChanges(defined(statusChanges(status), "changes")).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      `the finalized report starts open: ${JSON.stringify(statusChanges(status))}`
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:${defined(checkout.asOfSeq, "asOfSeq")}`,
        data: { text: "explained" },
      },
      f.deps
    );

    status = await f.run(["status", "show"]);

    assert.ok(
      !openChanges(statusChanges(status) ?? []).some(
        (entry) => entry.review === review && entry.round === 1
      ),
      `one per-report note closes the finalized report: ${JSON.stringify(statusChanges(status))}`
    );
  } finally {
    f.cleanup();
  }
});

test("a suffixed rerun decision admits the next round above the cap", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(path.join(f.root, "src/file.ts"), "rerun edit\n");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(
      reviewResult(done).repositoryChanges !== undefined,
      JSON.stringify(done.value)
    );

    const review = text(defined(reviewResult(done).review, "review"));

    const checkout = readJson(
      path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1/gen-1/checkout-report.json"
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "Rerun after inspection",
        key: `repository-rerun:${review}:1:${defined(checkout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const status = await f.run(["status", "show"]);

    const open = openChanges(defined(statusChanges(status), "changes")).find(
      (entry) => entry.review === review && entry.round === 1
    );

    assert.ok(
      open !== undefined && open.rerunPending === true,
      `the suffixed rerun decision binds the current report: ${JSON.stringify(statusChanges(status))}`
    );

    const rerun = await run();

    assert.equal(
      rerun.output.reason,
      "native-pending",
      `the suffixed rerun decision admits round 2 above the cap: ${JSON.stringify(rerun.output)}`
    );
    assert.equal(reviewResult(rerun).round, 2);
  } finally {
    f.cleanup();
  }
});

test("a suffixed rerun decision restarts an all-failed round at whole-target scope", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: { status: "fail", cls: "auth", detail: "denied" },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");

    const review = text(defined(reviewResult(waved).review, "review"));

    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "change before all-failed\n"
    );

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, "INVALID REPORT");
    }

    const failed = await run();

    assert.equal(failed.output.reason, "review-failed");

    const checkout = readJson(
      path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1/gen-1/checkout-report.json"
      ),
      CheckoutReportGuard
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "user",
        quote: "Rerun after inspection",
        key: `repository-rerun:${review}:1:${defined(checkout.asOfSeq, "asOfSeq")}`,
        data: { text: "rerun" },
      },
      f.deps
    );

    const rerun = await run();

    assert.equal(
      rerun.output.reason,
      "native-pending",
      `the suffixed rerun note starts a fresh round: ${JSON.stringify(rerun.output)}`
    );
    assert.equal(reviewResult(rerun).round, 2);

    const round2 = readJson(
      path.join(f.session, ".state/reviews", review, "round-2/round.json"),
      RoundFileGuard
    );

    assert.ok(
      round2.scope.startsWith("Full review"),
      `a suffixed rerun runs at whole-target scope: ${round2.scope}`
    );
    assert.deepEqual(
      round2.roster
        .filter((slot) => slot.reserve !== true)
        .map((slot) => slot.slot),
      ["claude[0]"]
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes list a changed root path named __proto__", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(
      path.join(f.root, "__proto__"),
      "proto edit during round\n"
    );

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = repositoryPaths(
      defined(reviewResult(done).repositoryChanges, "changes")
    );

    assert.ok(
      listed.includes("__proto__"),
      `the adversarial path is listed: ${JSON.stringify(reviewResult(done).repositoryChanges)}`
    );
  } finally {
    f.cleanup();
  }
});

test("repository changes hash a multi-chunk file without a full-file read", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    // A file larger than one hash chunk exists before launch; only one byte
    // beyond the first chunk changes during the round.
    const big = path.join(f.root, "src", "big.bin");

    fs.writeFileSync(big, "x".repeat(200 * 1024));

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");

    const bytes = fs.readFileSync(big);

    bytes[100 * 1024] = defined("y".codePointAt(0), "code");
    fs.writeFileSync(big, bytes);

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }

    const done = await run();

    assert.equal(done.exit, 0, JSON.stringify(done.output));

    const listed = repositoryPaths(
      defined(reviewResult(done).repositoryChanges, "changes")
    );

    assert.ok(
      listed.includes("src/big.bin"),
      `the change beyond the first chunk is listed: ${JSON.stringify(reviewResult(done).repositoryChanges)}`
    );
  } finally {
    f.cleanup();
  }
});

test("checkout reports gate sequences on content and order generations numerically", async () => {
  const f = await toolkitRepo();

  try {
    await f.level("low");
    await f.approve();

    const review = "demo-review";

    const roundDir = path.join(f.session, ".state/reviews", review, "round-1");

    fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });
    fs.mkdirSync(path.join(roundDir, "gen-2"), { recursive: true });
    fs.mkdirSync(path.join(roundDir, "gen-10"), { recursive: true });
    fs.writeFileSync(
      path.join(roundDir, "gen-1/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["old-path"] }],
        asOfSeq: 1,
      })
    );
    fs.writeFileSync(
      path.join(roundDir, "gen-2/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["mid-path"] }],
        asOfSeq: 2,
      })
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:1`,
        data: { text: "explained old" },
      },
      f.deps
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:2`,
        data: { text: "explained mid" },
      },
      f.deps
    );

    const reported = async () =>
      openChanges(statusChanges(await f.run(["status", "show"])) ?? []);

    assert.deepEqual(
      await reported(),
      [],
      "the acknowledged report stays closed"
    );
    // A clean later generation must not inflate the sequence past the note.
    fs.writeFileSync(
      path.join(roundDir, "gen-10/checkout-report.json"),
      JSON.stringify({ asOfSeq: 999 })
    );
    assert.deepEqual(
      await reported(),
      [],
      "a clean generation keeps the report closed"
    );
    // A newer content report under a reused number reopens; attempts merge and
    // the numerically latest generation wins the display.
    fs.writeFileSync(
      path.join(roundDir, "gen-10/checkout-report-2.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["new-path"] }],
        asOfSeq: 1000,
      })
    );
    fs.writeFileSync(
      path.join(roundDir, "gen-10/checkout-report-10.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["late-path"] }],
        asOfSeq: 1001,
      })
    );

    const open = await reported();

    assert.equal(open.length, 1, JSON.stringify(open));

    const first = defined(open[0], "open");

    assert.deepEqual(
      repositoryPaths(defined(first.repositoryChanges, "changes")).toSorted(
        (left, right) => left.localeCompare(right)
      ),
      ["late-path", "new-path"]
    );
  } finally {
    f.cleanup();
  }
});

test("two separately closed reports in one reused round stay closed", async () => {
  const f = await toolkitRepo();

  try {
    await f.level("low");
    await f.approve();

    const review = "demo-report-close2";

    const roundDir = path.join(f.session, ".state/reviews", review, "round-1");

    fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });
    fs.mkdirSync(path.join(roundDir, "gen-2"), { recursive: true });

    const reported = async () =>
      openChanges(statusChanges(await f.run(["status", "show"])) ?? []);

    const seqA = foldLedger(f.session).lastSeq;

    fs.writeFileSync(
      path.join(roundDir, "gen-1/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["a-path"] }],
        asOfSeq: seqA,
      })
    );

    let open = await reported();

    assert.equal(open.length, 1, JSON.stringify(open));

    const firstOpen = defined(open[0], "open");

    assert.equal(firstOpen.reportSeq, seqA);

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:${seqA}`,
        data: { text: "explained A" },
      },
      f.deps
    );
    assert.deepEqual(await reported(), [], "the first per-report close holds");

    const seqB = foldLedger(f.session).lastSeq;

    fs.writeFileSync(
      path.join(roundDir, "gen-2/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["b-path"] }],
        asOfSeq: seqB,
      })
    );

    open = await reported();

    assert.equal(open.length, 1, JSON.stringify(open));

    const secondOpen = defined(open[0], "open");

    assert.deepEqual(
      repositoryPaths(defined(secondOpen.repositoryChanges, "changes")),
      ["b-path"]
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        by: "orchestrator",
        key: `repository-changes:${review}:1:${seqB}`,
        data: { text: "explained B" },
      },
      f.deps
    );
    assert.deepEqual(
      await reported(),
      [],
      "the second per-report close holds while the first stays closed"
    );
  } finally {
    f.cleanup();
  }
});

test("later changed paths merge with the finalized findings report", async () => {
  const f = await toolkitRepo();

  try {
    await f.level("low");
    await f.approve();

    const review = "demo-merge-paths";

    const roundDir = path.join(f.session, ".state/reviews", review, "round-1");

    fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });

    const seqA = foldLedger(f.session).lastSeq;

    fs.writeFileSync(
      path.join(roundDir, "gen-1/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["a-path"] }],
        asOfSeq: seqA,
      })
    );

    const seqB = seqA + 1;

    fs.writeFileSync(
      path.join(roundDir, "findings.json"),
      JSON.stringify({
        review,
        round: 1,
        cap: 1,
        level: "low",
        findings: [],
        clusters: [],
        failed: [],
        repositoryChanges: [{ cwd: "c", paths: ["b-path"] }],
        budget: { asOfSeq: seqB },
      })
    );

    const open = openChanges(
      statusChanges(await f.run(["status", "show"])) ?? []
    );

    assert.equal(open.length, 1, JSON.stringify(open));

    const first = defined(open[0], "open");

    assert.deepEqual(
      repositoryPaths(defined(first.repositoryChanges, "changes")).toSorted(
        (left, right) => left.localeCompare(right)
      ),
      ["a-path", "b-path"]
    );
  } finally {
    f.cleanup();
  }
});

test("later unavailable checks merge with earlier changed paths", async () => {
  const f = await toolkitRepo();

  try {
    await f.level("low");
    await f.approve();

    const reported = async (name: string) =>
      openChanges(statusChanges(await f.run(["status", "show"])) ?? []).find(
        (entry) => entry.review === name
      );

    // A finalized unavailable check keeps the earlier attempt paths.
    const first = "demo-merge-check";

    const firstDir = path.join(f.session, ".state/reviews", first, "round-1");

    fs.mkdirSync(path.join(firstDir, "gen-1"), { recursive: true });

    const seqA = foldLedger(f.session).lastSeq;

    fs.writeFileSync(
      path.join(firstDir, "gen-1/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["a-path"] }],
        asOfSeq: seqA,
      })
    );
    fs.writeFileSync(
      path.join(firstDir, "findings.json"),
      JSON.stringify({
        review: first,
        round: 1,
        cap: 1,
        level: "low",
        findings: [],
        clusters: [],
        failed: [],
        repositoryCheck: { state: "unavailable", reason: "compare failed" },
        budget: { asOfSeq: seqA + 1 },
      })
    );

    let open = await reported(first);

    const firstOpen = defined(open, "open");

    assert.deepEqual(
      repositoryPaths(defined(firstOpen.repositoryChanges, "changes")),
      ["a-path"]
    );
    assert.equal(firstOpen.repositoryCheck?.state, "unavailable");

    // An earlier unavailable attempt survives a later finalized path report.
    const second = "demo-merge-check2";

    const secondDir = path.join(f.session, ".state/reviews", second, "round-1");

    fs.mkdirSync(path.join(secondDir, "gen-1"), { recursive: true });

    const seqC = foldLedger(f.session).lastSeq;

    fs.writeFileSync(
      path.join(secondDir, "gen-1/checkout-report.json"),
      JSON.stringify({
        repositoryCheck: { state: "unavailable", reason: "capture failed" },
        asOfSeq: seqC,
      })
    );
    fs.writeFileSync(
      path.join(secondDir, "findings.json"),
      JSON.stringify({
        review: second,
        round: 1,
        cap: 1,
        level: "low",
        findings: [],
        clusters: [],
        failed: [],
        repositoryChanges: [{ cwd: "c", paths: ["b-path"] }],
        budget: { asOfSeq: seqC + 1 },
      })
    );

    open = await reported(second);

    const secondOpen = defined(open, "open");

    assert.deepEqual(
      repositoryPaths(defined(secondOpen.repositoryChanges, "changes")),
      ["b-path"]
    );
    assert.equal(secondOpen.repositoryCheck?.state, "unavailable");
  } finally {
    f.cleanup();
  }
});

test("two failed generations with different paths both stay open", async () => {
  const f = await toolkitRepo();

  try {
    await f.level("low");
    await f.approve();

    const review = "demo-merge-gens";

    const roundDir = path.join(f.session, ".state/reviews", review, "round-1");

    fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });
    fs.mkdirSync(path.join(roundDir, "gen-2"), { recursive: true });

    const seq = foldLedger(f.session).lastSeq;

    fs.writeFileSync(
      path.join(roundDir, "gen-1/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["a-path"] }],
        asOfSeq: seq,
      })
    );
    fs.writeFileSync(
      path.join(roundDir, "gen-2/checkout-report.json"),
      JSON.stringify({
        repositoryChanges: [{ cwd: "c", paths: ["b-path"] }],
        asOfSeq: seq + 1,
      })
    );

    const open = openChanges(
      statusChanges(await f.run(["status", "show"])) ?? []
    );

    assert.equal(open.length, 1, JSON.stringify(open));

    const first = defined(open[0], "open");

    assert.deepEqual(
      repositoryPaths(defined(first.repositoryChanges, "changes")).toSorted(
        (left, right) => left.localeCompare(right)
      ),
      ["a-path", "b-path"]
    );
  } finally {
    f.cleanup();
  }
});

test("quoted and stale rerun notes bind only the open report", async () => {
  {
    const f = await toolkitRepo();

    try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "native-model" } }] },
        },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
      });
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        "candidate\n"
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const run = async () =>
        await f.run([
          "review",
          "run",
          "T1",
          "--kind",
          "code",
          "--spec",
          "work.spec.md",
          "--level",
          "low",
        ]);

      const launched = await run();

      assert.equal(launched.output.reason, "native-pending");

      const waved = await run();

      assert.equal(waved.output.reason, "native-pending");
      fs.writeFileSync(path.join(f.root, "src/file.ts"), "covered edit\n");

      for (const slot of pendingRun(waved).pending) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }

      const done = await run();

      assert.equal(done.exit, 0, JSON.stringify(done.output));

      const review = text(defined(reviewResult(done).review, "review"));

      const roundDir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1"
      );

      const checkout = readJson(
        path.join(roundDir, "gen-1/checkout-report.json"),
        CheckoutReportGuard
      );

      const seqA = defined(checkout.asOfSeq, "checkout.asOfSeq");

      // A later generation reports again under the reused round number.
      await f.level("low");

      const seqB = foldLedger(f.session).lastSeq;

      assert.ok(
        seqB > seqA,
        "the later report carries a distinct later identity"
      );
      fs.mkdirSync(path.join(roundDir, "gen-9"), { recursive: true });
      fs.writeFileSync(
        path.join(roundDir, "gen-9/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: f.root, paths: ["src/other.ts"] }],
          asOfSeq: seqB,
        })
      );

      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "orchestrator",
          key: `repository-changes:${review}:1:${seqB}`,
          data: { text: "explained later" },
        },
        f.deps
      );

      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "user",
          quote: "Rerun after inspection",
          key: `repository-rerun:${review}:1:${seqA}`,
          data: { text: "rerun open" },
        },
        f.deps
      );

      const open = defined(
        openChanges(statusChanges(await f.run(["status", "show"])) ?? []).find(
          (entry) => entry.review === review && entry.round === 1
        ),
        "open"
      );

      assert.equal(
        open.reportSeq,
        seqA,
        `the open entry binds the remaining report: ${JSON.stringify(open)}`
      );
      assert.equal(
        open.rerunPending,
        true,
        `the quoted rerun for the remaining report marks rerunPending: ${JSON.stringify(open)}`
      );

      const { budget } = admission(f.session, foldLedger(f.session), review, 1);

      assert.equal(
        budget.nextRound,
        2,
        `the quoted rerun admits the next round above the cap: ${JSON.stringify(budget)}`
      );
      assert.equal(budget.state, "allowed");

      const rerun = await run();

      assert.equal(
        rerun.output.reason,
        "native-pending",
        `the quoted rerun starts round 2: ${JSON.stringify(rerun.output)}`
      );
      assert.equal(reviewResult(rerun).round, 2);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await toolkitRepo();

    try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
        "read-delegates": {
          claude: { targets: [{ low: { model: "native-model" } }] },
        },
        phases: { "code-review": { targets: { low: 1 }, rounds: { low: 1 } } },
      });
      f.deps.orchestrator = { platform: "claude", model: null };
      f.deps.liveness = { claude: true };
      f.deps.delegate = async () => {
        await Promise.resolve();

        return {
          outcome: {
            status: "ok",
            text: JSON.stringify(CLEAN),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };

      await f.level("low");
      await f.approve();

      const made = await f.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);
      fs.writeFileSync(
        path.resolve(f.session, createdPath(made), "src/file.ts"),
        "candidate\n"
      );

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const run = async () =>
        await f.run([
          "review",
          "run",
          "T1",
          "--kind",
          "code",
          "--spec",
          "work.spec.md",
          "--level",
          "low",
        ]);

      const launched = await run();

      assert.equal(launched.output.reason, "native-pending");

      const waved = await run();

      assert.equal(waved.output.reason, "native-pending");
      fs.writeFileSync(path.join(f.root, "src/file.ts"), "covered edit\n");

      for (const slot of pendingRun(waved).pending) {
        fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      }

      const done = await run();

      assert.equal(done.exit, 0, JSON.stringify(done.output));

      const review = text(defined(reviewResult(done).review, "review"));

      const roundDir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1"
      );

      const checkout = readJson(
        path.join(roundDir, "gen-1/checkout-report.json"),
        CheckoutReportGuard
      );

      const seqA = defined(checkout.asOfSeq, "checkout.asOfSeq");

      await f.level("low");

      const seqB = foldLedger(f.session).lastSeq;

      assert.ok(
        seqB > seqA,
        "the later report carries a distinct later identity"
      );
      fs.mkdirSync(path.join(roundDir, "gen-9"), { recursive: true });
      fs.writeFileSync(
        path.join(roundDir, "gen-9/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: f.root, paths: ["src/other.ts"] }],
          asOfSeq: seqB,
        })
      );

      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "orchestrator",
          key: `repository-changes:${review}:1:${seqB}`,
          data: { text: "explained later" },
        },
        f.deps
      );

      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "user",
          quote: "Rerun after inspection",
          key: `repository-rerun:${review}:1:${seqB}`,
          data: { text: "rerun closed" },
        },
        f.deps
      );

      const open = defined(
        openChanges(statusChanges(await f.run(["status", "show"])) ?? []).find(
          (entry) => entry.review === review && entry.round === 1
        ),
        "open"
      );

      assert.equal(
        open.reportSeq,
        seqA,
        `the open entry binds the remaining report: ${JSON.stringify(open)}`
      );
      assert.equal(
        open.rerunPending,
        undefined,
        `a stale note for the closed report leaves no rerunPending: ${JSON.stringify(open)}`
      );

      const { budget } = admission(f.session, foldLedger(f.session), review, 1);

      assert.equal(
        budget.state,
        "requires-continuation",
        `a stale note for the closed report admits no round: ${JSON.stringify(budget)}`
      );

      const refused = await run();

      assert.equal(
        refused.output.reason,
        "round-cap",
        `a stale note for the closed report starts no round: ${JSON.stringify(refused.output)}`
      );
    } finally {
      f.cleanup();
    }
  }
});

test("a host change past a pending reserve finalizes with a reply a fallback and a failure", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "mixed-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
        agy: { targets: [{ low: { model: "cli-model" } }] },
        codex: { targets: [{ low: { model: "cli-model" } }] },
        copilot: { targets: [{ low: { model: "cli-model" } }] },
      },
      phases: { "code-review": { targets: { low: 3 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true, agy: true, codex: true, copilot: true };

    const launches: { provider: string; targetSlot: string | undefined }[] = [];

    f.deps.delegate = async (provider, request) => {
      await Promise.resolve();
      launches.push({ provider, targetSlot: request.targetSlot });

      if (provider === "copilot") {
        return {
          outcome: { status: "fail", cls: "config", detail: "unsupported" },
          invocations: [],
        };
      }

      if (provider === "codex") {
        return {
          outcome: { status: "fail", cls: "auth", detail: "denied" },
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const reservePending = defined(
      narrow(
        pendingRun(launched).pending,
        arrayOf(objectWith({ slot: isString, attempt: isString }))
      ).find((slot) => slot.slot === "codex[0]"),
      "reserve"
    );

    assert.ok(
      reservePending.attempt.startsWith("claude[0]#"),
      `the pending voice runs on the host reserve: ${reservePending.attempt}`
    );
    // The session moves to the agy host before the reserve completes. agy
    // turns native-first while codex keeps its pending claude reserve attempt.
    f.deps.orchestrator = { platform: "agy", model: null };

    const resumed = await f.run([
      "review",
      "run",
      "T1",
      "--kind",
      "code",
      "--spec",
      "work.spec.md",
      "--level",
      "low",
      "--native-failed",
      `${reservePending.attempt}=BLOCKED: old host denied`,
    ]);

    assert.equal(
      resumed.exit,
      0,
      `every saved outcome returns, so the round finalizes: ${JSON.stringify(resumed.output)}`
    );

    const finalized = readJson(
      text(defined(reviewResult(resumed).path, "path")),
      FindingsFileGuard
    );

    assert.deepEqual(
      finalized.failed.map((entry) => entry.slot),
      ["copilot[0]"],
      `the reply, the reserve fallback and the failure all reach finalization: ${JSON.stringify(finalized.failed)}`
    );
    assert.ok(
      launches.some(
        (launch) =>
          launch.provider === "claude" && launch.targetSlot === "codex[0]"
      ),
      `the pending reserve falls back through its physical cli: ${JSON.stringify(launches)}`
    );
  } finally {
    f.cleanup();
  }
});

test("an interrupted cli voice resumes with its saved reserve after a host change", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "mixed-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
        agy: { targets: [{ low: { model: "cli-model" } }] },
        codex: { targets: [{ low: { model: "cli-model" } }] },
        copilot: { targets: [{ low: { model: "cli-model" } }] },
      },
      phases: { "code-review": { targets: { low: 3 }, rounds: { low: 1 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true, agy: true, codex: true, copilot: true };

    const launches: string[] = [];

    f.deps.delegate = async (provider) => {
      await Promise.resolve();
      launches.push(provider);

      if (provider === "copilot") {
        return {
          outcome: { status: "fail", cls: "config", detail: "unsupported" },
          invocations: [],
        };
      }

      if (provider === "codex") {
        return {
          outcome: { status: "fail", cls: "auth", detail: "denied" },
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");
    assert.ok(
      narrow(
        pendingRun(launched).pending,
        arrayOf(objectWith({ slot: isString }))
      ).some((slot) => slot.slot === "codex[0]"),
      `codex holds the host reserve: ${JSON.stringify(pendingRun(launched).pending)}`
    );

    // The wave is interrupted before the copilot voice settles: its save is
    // lost while agy stays done and codex keeps its pending host reserve.
    const reviewsRoot = path.join(f.session, ".state/reviews");

    const reviewDir = path.join(
      reviewsRoot,
      defined(fs.readdirSync(reviewsRoot)[0], "review")
    );

    fs.unlinkSync(
      path.join(reviewDir, "round-1/gen-1/slots", "copilot[0].json")
    );
    // The session resumes on the agy host with no failure report.
    f.deps.orchestrator = { platform: "agy", model: null };

    const resumed = await run();

    assert.equal(
      resumed.exit,
      0,
      `the round finalizes instead of dropping the interrupted voice: ${JSON.stringify(resumed.output)}`
    );

    const finalized = readJson(
      text(defined(reviewResult(resumed).path, "path")),
      FindingsFileGuard
    );

    assert.deepEqual(
      finalized.failed.map((entry) => entry.slot),
      ["copilot[0]"],
      `the interrupted voice reaches finalization: ${JSON.stringify(finalized.failed)}`
    );
    assert.ok(
      launches.includes("claude"),
      `the saved reserve falls back through its physical cli: ${JSON.stringify(launches)}`
    );
  } finally {
    f.cleanup();
  }
});

test("a partial cli-only round resumed on a new host keeps every voice", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "plain-skill", {
      "read-delegates": {
        agy: { targets: [{ low: { model: "cli-model" } }] },
        codex: { targets: [{ low: { model: "cli-model" } }] },
        copilot: { targets: [{ low: { model: "cli-model" } }] },
      },
      phases: { "code-review": { targets: { low: 3 }, rounds: { low: 1 } } },
    });
    // The first host is not among the roster targets, so the round runs its
    // plain cli wave with no native voice.
    f.deps.orchestrator = { platform: "opencode", model: null };
    f.deps.liveness = { agy: true, codex: true, copilot: true };

    const launches: string[] = [];

    f.deps.delegate = async (provider) => {
      await Promise.resolve();
      launches.push(provider);

      if (provider === "copilot") {
        return {
          outcome: { status: "fail", cls: "config", detail: "unsupported" },
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const first = await run();

    assert.equal(
      first.exit,
      0,
      `the plain cli wave finalizes: ${JSON.stringify(first.output)}`
    );
    assert.deepEqual(launches.toSorted(), ["agy", "codex", "copilot"]);
    launches.splice(0);

    // The round is interrupted after only agy settles; codex and copilot never
    // saved an outcome. The session resumes on the agy host, which is one of
    // the completed targets.
    const reviewsRoot = path.join(f.session, ".state/reviews");

    const reviewDir = path.join(
      reviewsRoot,
      defined(fs.readdirSync(reviewsRoot)[0], "review")
    );

    const slotsDir = path.join(reviewDir, "round-1/gen-1/slots");

    fs.unlinkSync(path.join(slotsDir, "codex[0].json"));
    fs.unlinkSync(path.join(slotsDir, "copilot[0].json"));
    fs.rmSync(path.join(reviewDir, "round-1/findings.json"), { force: true });
    f.deps.orchestrator = { platform: "agy", model: null };

    const resumed = await run();

    assert.equal(
      resumed.exit,
      0,
      `the resumed round finalizes instead of dropping voices: ${JSON.stringify(resumed.output)}`
    );

    const finalized = readJson(
      text(defined(reviewResult(resumed).path, "path")),
      FindingsFileGuard
    );

    assert.deepEqual(
      launches.toSorted(),
      ["codex", "copilot"],
      "only the unsaved voices run again"
    );
    assert.deepEqual(
      finalized.failed.map((entry) => ({ slot: entry.slot, cls: entry.cls })),
      [{ slot: "copilot[0]", cls: "config" }],
      "the mocked Copilot refusal reaches finalization"
    );
  } finally {
    f.cleanup();
  }
});

test("sibling reports stay open with correct rerun bindings", async () => {
  {
    const f = await toolkitRepo();

    try {
      await f.level("low");
      await f.approve();

      const review = "demo-sibling-close";

      const roundDir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1"
      );

      fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });
      fs.mkdirSync(path.join(roundDir, "gen-2"), { recursive: true });
      fs.writeFileSync(
        path.join(roundDir, "round.json"),
        JSON.stringify({
          round: 1,
          cap: 1,
          startSeq: foldLedger(f.session).lastSeq,
          generation: 1,
          roster: [{ slot: "claude[0]", provider: "claude", index: 0 }],
          scope: "Full review",
        })
      );

      const seqA = foldLedger(f.session).lastSeq;

      fs.writeFileSync(
        path.join(roundDir, "gen-1/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: "c", paths: ["a-path"] }],
          asOfSeq: seqA,
        })
      );

      await f.level("low");

      const seqB = foldLedger(f.session).lastSeq;

      fs.writeFileSync(
        path.join(roundDir, "gen-2/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: "c", paths: ["b-path"] }],
          asOfSeq: seqB,
        })
      );
      assert.ok(seqB > seqA, "the two reports carry distinct identities");

      // The user records a rerun decision for the earlier report while the
      // later one is still open.
      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "user",
          quote: "Rerun after inspection",
          key: `repository-rerun:${review}:1:${seqA}`,
          data: { text: "rerun open" },
        },
        f.deps
      );

      const noteSeq = foldLedger(f.session).lastSeq;

      // Round 2 finalizes at ordinary differential scope, not the rerun.
      const round2Dir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-2"
      );

      fs.mkdirSync(path.join(round2Dir, "gen-1"), { recursive: true });
      fs.writeFileSync(
        path.join(round2Dir, "round.json"),
        JSON.stringify({
          round: 2,
          cap: 1,
          startSeq: noteSeq,
          generation: 1,
          roster: [{ slot: "claude[0]", provider: "claude", index: 0 }],
          scope: "Re-review round 2 (full) — changed: x; comparison: a..b",
        })
      );
      fs.writeFileSync(
        path.join(round2Dir, "findings.json"),
        JSON.stringify({
          review,
          round: 2,
          findings: [],
          clusters: [],
          failed: [],
        })
      );

      // Closing the sibling report leaves the remaining report open, but round
      // 2 already finalized past the executable rerun window: the entry carries
      // no rerun binding and closes with a repository-changes note.
      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "orchestrator",
          key: `repository-changes:${review}:1:${seqB}`,
          data: { text: "explained later" },
        },
        f.deps
      );

      const open = defined(
        openChanges(statusChanges(await f.run(["status", "show"])) ?? []).find(
          (entry) => entry.review === review && entry.round === 1
        ),
        "open"
      );

      assert.equal(
        open.reportSeq,
        seqA,
        `the open entry binds the remaining report: ${JSON.stringify(open)}`
      );
      assert.equal(
        open.rerunPending,
        undefined,
        `a finalized round 2 leaves no rerun binding: ${JSON.stringify(open)}`
      );

      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "orchestrator",
          key: `repository-changes:${review}:1:${seqA}`,
          data: { text: "explained earlier" },
        },
        f.deps
      );

      const closed = openChanges(
        statusChanges(await f.run(["status", "show"])) ?? []
      ).filter((entry) => entry.review === review && entry.round === 1);

      assert.deepEqual(
        closed,
        [],
        `a changes note closes the remaining report: ${JSON.stringify(closed)}`
      );
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await toolkitRepo();

    try {
      await f.level("low");
      await f.approve();

      const review = "demo-sibling-final-window";

      const roundDir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1"
      );

      fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });
      fs.mkdirSync(path.join(roundDir, "gen-2"), { recursive: true });
      fs.writeFileSync(
        path.join(roundDir, "round.json"),
        JSON.stringify({
          round: 1,
          cap: 1,
          startSeq: foldLedger(f.session).lastSeq,
          generation: 1,
          roster: [{ slot: "claude[0]", provider: "claude", index: 0 }],
          scope: "Full review",
        })
      );

      const seqA = foldLedger(f.session).lastSeq;

      fs.writeFileSync(
        path.join(roundDir, "gen-1/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: "c", paths: ["a-path"] }],
          asOfSeq: seqA,
        })
      );

      await f.level("low");

      const seqB = foldLedger(f.session).lastSeq;

      fs.writeFileSync(
        path.join(roundDir, "gen-2/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: "c", paths: ["b-path"] }],
          asOfSeq: seqB,
        })
      );
      assert.ok(seqB > seqA, "the two reports carry distinct identities");

      // The rerun for the later report finalizes round 2 at whole-target scope.
      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "user",
          quote: "Rerun after inspection",
          key: `repository-rerun:${review}:1:${seqB}`,
          data: { text: "rerun later" },
        },
        f.deps
      );

      const noteSeq = foldLedger(f.session).lastSeq;

      const round2Dir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-2"
      );

      fs.mkdirSync(path.join(round2Dir, "gen-1"), { recursive: true });
      fs.writeFileSync(
        path.join(round2Dir, "round.json"),
        JSON.stringify({
          round: 2,
          cap: 1,
          startSeq: noteSeq,
          generation: 1,
          roster: [{ slot: "claude[0]", provider: "claude", index: 0 }],
          scope: "Full review — changed paths: b-path; comparison: a..b",
        })
      );
      fs.writeFileSync(
        path.join(round2Dir, "findings.json"),
        JSON.stringify({
          review,
          round: 2,
          findings: [],
          clusters: [],
          failed: [],
        })
      );

      const open = defined(
        openChanges(statusChanges(await f.run(["status", "show"])) ?? []).find(
          (entry) => entry.review === review && entry.round === 1
        ),
        "open"
      );

      assert.equal(
        open.reportSeq,
        seqA,
        `the open entry binds the remaining report: ${JSON.stringify(open)}`
      );
      assert.equal(
        open.rerunPending,
        undefined,
        `the remaining sibling carries no rerun binding: ${JSON.stringify(open)}`
      );

      // A rerun decision recorded after round 2 finalized cannot execute, so it
      // adds no binding; only a repository-changes note closes the report.
      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "user",
          quote: "Rerun after inspection",
          key: `repository-rerun:${review}:1:${seqA}`,
          data: { text: "rerun past window" },
        },
        f.deps
      );

      const reopened = defined(
        openChanges(statusChanges(await f.run(["status", "show"])) ?? []).find(
          (entry) => entry.review === review && entry.round === 1
        ),
        "reopened"
      );

      assert.equal(
        reopened.rerunPending,
        undefined,
        `a late rerun note offers only the changes-note close: ${JSON.stringify(reopened)}`
      );

      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "orchestrator",
          key: `repository-changes:${review}:1:${seqA}`,
          data: { text: "explained earlier" },
        },
        f.deps
      );

      const closed = openChanges(
        statusChanges(await f.run(["status", "show"])) ?? []
      ).filter((entry) => entry.review === review && entry.round === 1);

      assert.deepEqual(
        closed,
        [],
        `a changes note closes the remaining report: ${JSON.stringify(closed)}`
      );
    } finally {
      f.cleanup();
    }
  }

  {
    const f = await toolkitRepo();

    try {
      await f.level("low");
      await f.approve();

      const review = "demo-rerun-sibling-scope";

      const roundDir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-1"
      );

      fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });
      fs.mkdirSync(path.join(roundDir, "gen-2"), { recursive: true });
      fs.writeFileSync(
        path.join(roundDir, "round.json"),
        JSON.stringify({
          round: 1,
          cap: 1,
          startSeq: foldLedger(f.session).lastSeq,
          generation: 1,
          roster: [{ slot: "claude[0]", provider: "claude", index: 0 }],
          scope: "Full review",
        })
      );

      const seqA = foldLedger(f.session).lastSeq;

      fs.writeFileSync(
        path.join(roundDir, "gen-1/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: "c", paths: ["a-path"] }],
          asOfSeq: seqA,
        })
      );

      await f.level("low");

      const seqB = foldLedger(f.session).lastSeq;

      fs.writeFileSync(
        path.join(roundDir, "gen-2/checkout-report.json"),
        JSON.stringify({
          repositoryChanges: [{ cwd: "c", paths: ["b-path"] }],
          asOfSeq: seqB,
        })
      );
      assert.ok(seqB > seqA, "the two reports carry distinct identities");

      await appendRecord(
        f.session,
        {
          kind: "note",
          by: "user",
          quote: "Rerun after inspection",
          key: `repository-rerun:${review}:1:${seqB}`,
          data: { text: "rerun later" },
        },
        f.deps
      );

      const noteSeq = foldLedger(f.session).lastSeq;

      const round2Dir = path.join(
        f.session,
        ".state/reviews",
        review,
        "round-2"
      );

      fs.mkdirSync(path.join(round2Dir, "gen-1"), { recursive: true });
      fs.writeFileSync(
        path.join(round2Dir, "round.json"),
        JSON.stringify({
          round: 2,
          cap: 1,
          startSeq: noteSeq,
          generation: 1,
          roster: [{ slot: "claude[0]", provider: "claude", index: 0 }],
          scope: "Full review — changed paths: b-path; comparison: a..b",
        })
      );
      fs.writeFileSync(
        path.join(round2Dir, "findings.json"),
        JSON.stringify({
          review,
          round: 2,
          findings: [],
          clusters: [],
          failed: [],
        })
      );

      const status = await f.run(["status", "show"]);

      const open = defined(
        openChanges(defined(statusChanges(status), "changes")).find(
          (entry) => entry.review === review && entry.round === 1
        ),
        "open"
      );

      assert.equal(
        open.reportSeq,
        seqA,
        `the open entry binds the earlier report: ${JSON.stringify(open)}`
      );
      assert.equal(
        open.rerunPending,
        undefined,
        `the earlier report carries no rerun binding: ${JSON.stringify(open)}`
      );
    } finally {
      f.cleanup();
    }
  }
});

test("an all-failed round surfaces a checkout write failure instead of a quiet review-failed", async (t) => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: { status: "fail", cls: "auth", detail: "denied" },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async () =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");
    fs.writeFileSync(
      path.join(f.root, "src/file.ts"),
      "change before all-failed\n"
    );

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, "INVALID REPORT");
    }

    // A persistence failure must stay explicit: the thrown review-failed names
    // the unwritten report instead of implying durable repository evidence.
    const realWrite = fs.writeFileSync;

    const write = t.mock.method(
      fs,
      "writeFileSync",
      (...args: Parameters<typeof realWrite>) => {
        const [targetPath] = args;

        if (isString(targetPath) && targetPath.includes("checkout-report")) {
          throw new Error("injected checkout-report write failure");
        }

        realWrite(...args);
      }
    );

    const failed = await (async () => {
      try {
        return await run();
      } finally {
        write.mock.restore();
      }
    })();

    assert.equal(
      failed.output.reason,
      "review-failed",
      JSON.stringify(failed.output)
    );
    assert.match(
      failed.output.summary,
      /checkout report unavailable/u,
      JSON.stringify(failed.output)
    );
    assert.match(
      failed.output.summary,
      /injected checkout-report write failure/u,
      JSON.stringify(failed.output)
    );
    assert.match(
      failed.output.summary,
      /Every review slot failed/u,
      `the write failure keeps the normal all-failed message: ${JSON.stringify(failed.output)}`
    );
    assert.match(
      failed.output.summary,
      /src\/file\.ts/u,
      `the write failure still names the detected change: ${JSON.stringify(failed.output)}`
    );

    const reviewDirs = fs.readdirSync(path.join(f.session, ".state/reviews"));

    assert.ok(reviewDirs.length > 0);
    assert.equal(
      fs.existsSync(
        path.join(
          f.session,
          ".state/reviews",
          defined(reviewDirs[0], "review"),
          "round-1/gen-1/checkout-report.json"
        )
      ),
      false,
      "no report is durable"
    );
  } finally {
    f.cleanup();
  }
});

test("an all-failed round keeps an ignored failure report visible", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "checkout-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
      },
      phases: { "code-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: { status: "fail", cls: "auth", detail: "denied" },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const made = await f.run(["worktree", "create", "T1"]);

    assert.equal(made.exit, 0);
    fs.writeFileSync(
      path.resolve(f.session, createdPath(made), "src/file.ts"),
      "candidate\n"
    );

    const submitted = await f.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const run = async (extra: string[] = []) =>
      await f.run([
        "review",
        "run",
        "T1",
        "--kind",
        "code",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
        ...extra,
      ]);

    const launched = await run();

    assert.equal(launched.output.reason, "native-pending");

    const waved = await run();

    assert.equal(waved.output.reason, "native-pending");

    for (const slot of pendingRun(waved).pending) {
      fs.writeFileSync(slot.replyPath, "INVALID REPORT");
    }

    // A report that matches no saved attempt is ignored, but the all-failed
    // result still names it so the caller sees where its report went.
    const failed = await run(["--native-failed", "stale[0]#m9=voice gone"]);

    assert.equal(
      failed.output.reason,
      "review-failed",
      JSON.stringify(failed.output)
    );
    assert.match(
      failed.output.summary,
      /ignored reports: stale\[0\]#m9/u,
      JSON.stringify(failed.output)
    );
  } finally {
    f.cleanup();
  }
});

test("inter-round diff holds governed text from real Git", async () => {
  const f = await toolkitRepo();

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "inter-round-skill", {
      "read-delegates": { agy: { targets: [{ low: { model: "cli-model" } }] } },
      phases: { "plan-review": { targets: { low: 1 }, rounds: { low: 2 } } },
    });
    f.deps.liveness = { agy: true };
    f.deps.delegate = async () => {
      await Promise.resolve();

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await f.level("low");
    await f.approve();

    const run = async () =>
      await f.run([
        "review",
        "run",
        "work.plan.md",
        "--kind",
        "plan",
        "--spec",
        "work.spec.md",
        "--level",
        "low",
      ]);

    const first = await run();

    assert.equal(first.exit, 0, JSON.stringify(first.output));

    const plan = path.join(f.root, "work.plan.md");

    fs.writeFileSync(
      plan,
      fs
        .readFileSync(plan, "utf-8")
        .replace(
          "- Purpose: implements behavior.",
          "- Purpose: implements behavior with a guard."
        )
    );

    const second = await run();

    assert.equal(second.exit, 0, JSON.stringify(second.output));

    const roundDir = path.join(
      path.dirname(
        path.dirname(text(defined(reviewResult(second).path, "path")))
      ),
      "round-2"
    );

    const diff = fs.readFileSync(
      path.join(roundDir, "inter-round.diff"),
      "utf-8"
    );

    assert.match(diff, /^\+- Purpose: implements behavior with a guard\.$/mu);
    assert.doesNotMatch(diff, /Review Findings & Resolutions|Budget \(/u);

    const roundJson = narrow(
      parseJson(fs.readFileSync(path.join(roundDir, "round.json"), "utf-8")),
      objectWith({ interRound: objectWith({ diff: isString }) })
    );

    assert.equal(
      roundJson.interRound.diff,
      `\`${path.join(roundDir, "inter-round.diff")}\` (unified diff of the governed text)`
    );
  } finally {
    f.cleanup();
  }
});

export const stoppedIntegrationReview = async (historicalRounds = 0) => {
  const { f } = await coverageRepo(2);

  try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, "recovery-skill", {
      "read-delegates": {
        claude: { targets: [{ low: { model: "native-model" } }] },
        agy: { targets: [{ low: { model: "cli-model" } }] },
      },
      phases: {
        "code-review": {
          targets: { low: 2 },
          rounds: { low: historicalRounds + 2 },
        },
      },
    });
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.liveness = { claude: true, agy: true };

    let cliCalls = 0;

    f.deps.delegate = async (provider) => {
      await Promise.resolve();
      assert.equal(provider, "agy");
      cliCalls += 1;

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify(CLEAN),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    const head = () => f.git(["rev-parse", "HEAD"], f.integration);

    const checkpoint = async () => {
      f.deps.readStdin = () =>
        JSON.stringify({
          head: head(),
          report: { removed: [], deleted: 0, merged: 0 },
        });

      const receipt = await f.run([
        "ledger",
        "append",
        "-",
        "--cleanup",
        "zero",
      ]);

      assert.equal(receipt.exit, 0, JSON.stringify(receipt.output));
    };

    const resume = async () => {
      const status = await f.run(["status", "show", "--resume"]);

      assert.equal(status.exit, 0, JSON.stringify(status.output));

      return narrow(
        status.value,
        objectWith({
          next: isString,
          reason: isString,
          action: isString,
          cleanup: isString,
          round: maybe(isString),
          evidence: maybe(isString),
        })
      );
    };

    const args = [
      "review",
      "run",
      "integration",
      "--kind",
      "code",
      "--level",
      "low",
      "--pins",
      "(claude,agy)",
    ];

    const run = async () => await f.run(args);

    await checkpoint();

    if (historicalRounds > 0) {
      const fold = foldLedger(f.session);

      const artifacts = currentHashes(f.root, latest(fold, "bind"));

      const spec = {
        path: fs.realpathSync.native(path.join(f.root, "work.spec.md")),
        hash: artifacts.spec,
      };

      const target = {
        base: defined(
          defined(
            fold.records.findLast(
              (row) =>
                row.kind === "integrate" && row.data["phase"] === "opened"
            ),
            "integrate"
          ).data["base"],
          "base"
        ),
        head: head(),
      };

      const roster = ["claude", "agy"].map((provider) => ({
        slot: `${provider}[0]`,
        provider,
        index: 0,
        native: provider === "claude",
        reserve: false,
      }));

      // Seed history for the byte replay. The active round below uses the actual review workflow.
      for (let round = 1; round <= historicalRounds; round += 1) {
        const dir = path.join(
          f.session,
          ".state/reviews/code-integration",
          `round-${round}`
        );

        const slots = path.join(dir, "gen-1/slots");

        fs.mkdirSync(slots, { recursive: true });
        saveJson(path.join(dir, "round.json"), {
          round,
          generation: 1,
          cap: historicalRounds + 2,
          level: "low",
          pins: "(claude,agy)",
          roster,
          scope: "Full review",
          startSeq: fold.lastSeq,
          spec,
          target,
          artifacts,
          turnTarget: 8,
          rulingSnapshot: "[]",
        });
        saveJson(path.join(dir, "findings.json"), {
          review: "code-integration",
          round,
          failed: [],
          findings: [],
        });
        saveJson(path.join(dir, "gen-1/checkout-report.json"), {
          asOfSeq: fold.lastSeq,
          repositoryChanges: [
            { cwd: f.integration, paths: ["docs/review-observation.md"] },
          ],
        });

        for (const { slot } of roster) {
          saveJson(path.join(slots, `${slot}.json`), {
            slot,
            state: "done",
            text: JSON.stringify(CLEAN),
          });
        }
      }
    }

    const launched = await run();

    assert.equal(
      launched.output.reason,
      "native-pending",
      JSON.stringify(launched.output)
    );

    const stopped = await run();

    assert.equal(
      stopped.output.reason,
      "native-pending",
      JSON.stringify(stopped.output)
    );
    assert.equal(pendingRun(stopped).cliWave, "done");
    assert.equal(cliCalls, 1);

    return { f, head, resume, run, stopped, cliCalls: () => cliCalls };
  } catch (error) {
    f.cleanup();

    throw error;
  }
};

test("implementation review recovery reuses saved work", async () => {
  const recovered = await stoppedIntegrationReview();

  const { f, head, resume, run, stopped, cliCalls } = recovered;

  try {
    const view = await resume();

    assert.equal(view.next, "inspect");
    assert.equal(view.reason, "native-pending");
    assert.equal(view.action, "review run");
    assert.equal(view.cleanup, "checkpoint");

    const roundFile = defined(view.round, "view.round");

    const before = readJson(path.join(f.session, roundFile), RoundFileGuard);

    assert.equal(before.pins, "(claude,agy)");
    assert.equal(before.level, "low");

    const slot = readJson(
      path.join(f.session, defined(view.evidence, "view.evidence")),
      objectWith({ attempt: isString, replyPath: isString })
    );

    assert.equal(
      slot.attempt,
      defined(
        defined(pendingRun(stopped).pending[0], "pending").attempt,
        "attempt"
      )
    );
    assert.equal(
      slot.replyPath,
      defined(
        defined(pendingRun(stopped).pending[0], "pending").replyPath,
        "reply"
      )
    );

    const compatible = await run();

    assert.equal(compatible.output.reason, "native-pending");
    assert.equal(
      defined(
        defined(pendingRun(compatible).pending[0], "pending").attempt,
        "attempt"
      ),
      slot.attempt
    );
    assert.equal(cliCalls(), 1);
    fs.writeFileSync(path.join(f.integration, "src/file.ts"), "repaired\n");

    const repaired = await f.run([
      "worktree",
      "commit",
      "--reason",
      "record repair",
    ]);

    assert.equal(repaired.exit, 0);

    const moved = await resume();

    assert.deepEqual(moved, {
      next: "review",
      reason: "target-moved",
      action: "review run",
      round: view.round,
      cleanup: "checkpoint",
    });

    const recaptured = await run();

    assert.equal(
      recaptured.output.reason,
      "native-pending",
      JSON.stringify(recaptured.output)
    );

    const after = readJson(path.join(f.session, roundFile), RoundFileGuard);

    assert.equal(
      after.generation,
      defined(before.generation, "before.generation") + 1
    );
    assert.equal(after.target.head, head());
    assert.notEqual(
      defined(
        defined(pendingRun(recaptured).pending[0], "pending").attempt,
        "attempt"
      ),
      slot.attempt
    );
    assert.equal(cliCalls(), 1);

    const wave = await run();

    assert.equal(wave.output.reason, "native-pending");
    assert.equal(pendingRun(wave).cliWave, "done");
    fs.writeFileSync(
      defined(
        defined(pendingRun(wave).pending[0], "pending").replyPath,
        "reply"
      ),
      JSON.stringify(CLEAN)
    );

    const complete = await run();

    assert.equal(complete.exit, 0, JSON.stringify(complete.output));
    assert.equal(cliCalls(), 2);
    assert.deepEqual(await resume(), {
      next: "continue",
      reason: "review-settled",
      action: "re-check",
      cleanup: "checkpoint",
    });
    fs.writeFileSync(
      path.join(f.session, ".state/test-cleanup.json"),
      '{"removed":[],"deleted":0,"merged":0}'
    );

    await appendRecord(
      f.session,
      {
        kind: "note",
        key: "test-cleanup:skip",
        by: "orchestrator",
        data: { text: "Legacy skip receipt" },
      },
      f.deps
    );
    assert.deepEqual(await resume(), {
      next: "continue",
      reason: "review-settled",
      action: "re-check",
      cleanup: "unbound",
    });
  } finally {
    f.cleanup();
  }
});
