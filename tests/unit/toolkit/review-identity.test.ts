import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import type { HandlerContext } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  rejectionRequest,
  reviewId,
} from "../../../skills/dispatch/scripts/toolkit/confirmations.ts";
import type { RejectionRequest } from "../../../skills/dispatch/scripts/toolkit/confirmations.ts";
import { stableValue } from "../../../skills/dispatch/scripts/toolkit/domain/stable-value.ts";
import type { Finding } from "../../../skills/dispatch/scripts/toolkit/domain/types.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
  latest,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import type { LedgerRecord } from "../../../skills/dispatch/scripts/toolkit/records.ts";
import {
  evaluateReviewClosed,
  isReviewClosed,
  reviewIdentity,
} from "../../../skills/dispatch/scripts/toolkit/review-identity.ts";
import { defined } from "../../helpers/guards.ts";
import { refusal } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

const gitOutput = (stdout = "") => ({ exit: 0, stdout, stderr: "" });

const source = [
  "# Work",
  "## Task Map",
  "| ID | Title | Outcome | Prerequisites | Criteria |",
  "| --- | --- | --- | --- | --- |",
  "| T1 | File | Works | none | SC1 |",
  "## Proposed Changes",
  "### T1 \u2014 File",
  "#### [NEW] src/file.ts",
  "- Purpose: behavior.",
  "## Success Criteria",
  "- [SC1] Works",
  "  - Changes: src/file.ts",
  "  - Check: `node check`",
  "  - Evidence: check",
  "## Verification Plan",
  "### Automated Tests",
  "- `node contract`",
].join("\n");

test("review identity keeps unexpected read errors", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("work.spec.md", "# Work");
    f.artifact("work.plan.md", source);
    await appendRecord(
      f.session,
      {
        kind: "bind",
        by: "orchestrator",
        key: "bind",
        data: { spec: "work.spec.md", plan: "work.plan.md" },
      },
      f.deps
    );

    const head = "a".repeat(40);
    const base = "b".repeat(40);

    const reviewRoot = path.join(f.session, ".state/reviews/code-integration");
    const roundDir = path.join(reviewRoot, "round-1");

    fs.mkdirSync(roundDir, { recursive: true });

    const ctx: HandlerContext = {
      session: f.session,
      manifest: readManifest(f.session),
      args: [],
      values: {},
      deps: f.deps,
    };

    const identity = async () =>
      await reviewIdentity(ctx, foldLedger(f.session), f.root, head, base);

    const roundFile = path.join(roundDir, "round.json");
    fs.writeFileSync(roundFile, "{}");
    const readFile = fs.readFileSync;

    const read = t.mock.method(
      fs,
      "readFileSync",
      (...args: Parameters<typeof readFile>) => {
        const [file] = args;

        if (String(file) === roundFile) {
          throw Object.assign(
            new Error("Review artifact storage unavailable"),
            { code: "EACCES" }
          );
        }

        return readFile(...args);
      }
    );

    try {
      await assert.rejects(identity, {
        code: "EACCES",
        message: /Review artifact storage unavailable/u,
      });
    } finally {
      read.mock.restore();
    }

    fs.writeFileSync(roundFile, "{invalid");
    await assert.rejects(identity, { reason: "review-required" });
    fs.rmSync(reviewRoot, { recursive: true, force: true });
    await assert.rejects(identity, { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

test("cap-ending SHOULD fixes bound their verified commit chain by ruling paths", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("work.spec.md", "# Work\n");
    f.artifact("work.plan.md", source);

    const baseline = "a".repeat(40);
    const head = "b".repeat(40);
    const base = "c".repeat(40);
    const commitReason = "repair accepted SHOULD";

    const bind = {
      kind: "bind",
      seq: 1,
      key: "bind",
      at: "",
      by: "tool",
      data: { spec: "work.spec.md", plan: "work.plan.md" },
    };

    const reviewFix = {
      review: "code-integration",
      round: 3,
      generation: 1,
      findings: ["R3-F001"],
      from: baseline,
    };

    const ruling = {
      kind: "ruling",
      seq: 2,
      key: "ruling",
      at: "",
      by: "orchestrator",
      data: {
        subject: "review:code-integration:R3-F001",
        ruling: "accepted",
        rationale: "Accept the bounded correction",
        paths: ["src/file.ts", "src/helper.ts"],
      },
    };

    const fix = {
      kind: "integrate",
      seq: 3,
      key: "fix",
      at: "",
      by: "tool",
      data: { phase: "fix", commit: head, reason: commitReason, reviewFix },
    };

    const artifacts = currentHashes(f.root, bind);

    const reviewDir = path.join(
      f.session,
      ".state/reviews/code-integration/round-3"
    );

    fs.mkdirSync(path.join(reviewDir, "gen-1/slots"), { recursive: true });

    const finding = {
      id: "R3-F001",
      severity: "SHOULD",
      locus: "src/file.ts:L1",
      defect: "The source is incorrect",
      requiredChange: "Correct the source",
    };

    fs.writeFileSync(
      path.join(reviewDir, "round.json"),
      JSON.stringify({
        round: 3,
        cap: 3,
        generation: 1,
        startSeq: 1,
        target: { base, head: baseline },
        scope: "Full review",
        artifacts,
        spec: { path: "/work.spec.md", hash: artifacts.spec },
        roster: [{ slot: "reviewer", reserve: false }],
      })
    );
    fs.writeFileSync(
      path.join(reviewDir, "findings.json"),
      JSON.stringify({
        review: "code-integration",
        round: 3,
        findings: [finding],
        failed: [],
      })
    );
    fs.writeFileSync(
      path.join(reviewDir, "gen-1/slots/reviewer.json"),
      JSON.stringify({
        slot: "reviewer",
        state: "done",
        text: '{"status":"CLEAN","findings":[]}',
      })
    );

    const canonical = stableValue(reviewFix);
    const fixDigest = `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
    const fixData = Buffer.from(canonical).toString("base64url");

    const manifest = readManifest(f.session);

    const message = [
      `fix(dispatch): ${commitReason}`,
      "",
      `Dispatch-Fix: ${manifest.safeSessionId}`,
      `Dispatch-Review-Fix: ${fixDigest}`,
      `Dispatch-Review-Fix-Data: ${fixData}`,
      "",
    ].join("\n");

    let commits = [[head, baseline]];
    let changed = ["src/file.ts", "src/helper.ts"];

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = (argv) => {
      const args = argv.slice(1);

      if (
        args[0] === "rev-list" &&
        args[1] === "--reverse" &&
        args[2] === "--parents"
      ) {
        return Promise.resolve(
          gitOutput(`${commits.map((row) => row.join(" ")).join("\n")}\n`)
        );
      }

      if (args[0] === "diff-tree" && args.includes(head)) {
        return Promise.resolve(gitOutput(`${changed.join("\0")}\0`));
      }

      if (
        args[0] === "log" &&
        args[1] === "-1" &&
        args[2] === "--format=%B" &&
        args[3] === head
      ) {
        return Promise.resolve(gitOutput(message));
      }

      throw new Error(`Unexpected Git argv: ${JSON.stringify(argv)}`);
    };

    const ctx: HandlerContext = {
      session: f.session,
      manifest,
      args: [],
      values: {},
      deps: f.deps,
    };

    const correction = {
      ...ruling,
      seq: 3,
      key: "correction",
      data: {
        subject: ruling.data.subject,
        ruling: "accepted",
        rationale: "Correct the severity inputs",
        impact: "degrades",
        trigger: "realistic",
      },
    };

    const checkedFix = { ...fix, seq: 4 };

    const valid = await reviewIdentity(
      ctx,
      {
        records: [bind, ruling, correction, checkedFix],
        lastSeq: 4,
        torn: null,
      },
      f.root,
      head,
      base
    );

    const revised = {
      ...ruling,
      seq: 3,
      key: "revised",
      data: { ...ruling.data, paths: ["src/file.ts", "src/replacement.ts"] },
    };

    await assert.rejects(
      reviewIdentity(
        ctx,
        {
          records: [bind, ruling, revised, checkedFix],
          lastSeq: 4,
          torn: null,
        },
        f.root,
        head,
        base
      ),
      { reason: "review-required" }
    );
    changed = ["src/file.ts", "src/replacement.ts"];

    const reviewIdentityResult = await reviewIdentity(
      ctx,
      { records: [bind, ruling, revised, checkedFix], lastSeq: 4, torn: null },
      f.root,
      head,
      base
    );

    assert.equal(reviewIdentityResult.baseline, baseline);
    assert.equal(valid.baseline, baseline);
    assert.deepEqual(
      valid.corrections.map((row) => row.commit),
      [head]
    );
    changed = ["src/file.ts", "src/other.ts"];
    await assert.rejects(
      reviewIdentity(
        ctx,
        { records: [bind, ruling, fix], lastSeq: 3, torn: null },
        f.root,
        head,
        base
      ),
      { reason: "review-required" }
    );
    changed = [" src/file.ts", "src/helper.ts"];
    await assert.rejects(
      reviewIdentity(
        ctx,
        { records: [bind, ruling, fix], lastSeq: 3, torn: null },
        f.root,
        head,
        base
      ),
      { reason: "review-required" }
    );
    changed = ["src/file.ts"];
    commits = [
      ["d".repeat(40), baseline],
      [head, "d".repeat(40)],
    ];
    await assert.rejects(
      reviewIdentity(
        ctx,
        { records: [bind, ruling, fix], lastSeq: 3, torn: null },
        f.root,
        head,
        base
      ),
      { reason: "review-required" }
    );
    commits = [[head, baseline]];
    fs.writeFileSync(path.join(reviewDir, "findings.json"), "{");
    await assert.rejects(
      reviewIdentity(
        ctx,
        { records: [bind, ruling, fix], lastSeq: 3, torn: null },
        f.root,
        head,
        base
      ),
      { reason: "review-required" }
    );
    fs.writeFileSync(
      path.join(reviewDir, "findings.json"),
      JSON.stringify({
        review: "code-integration",
        round: 3,
        findings: [{ ...finding, severity: "MUST" }],
        failed: [],
      })
    );
    await assert.rejects(
      reviewIdentity(
        ctx,
        { records: [bind, ruling, fix], lastSeq: 3, torn: null },
        f.root,
        head,
        base
      ),
      { reason: "review-required" }
    );
    fs.writeFileSync(
      path.join(reviewDir, "findings.json"),
      JSON.stringify({
        review: "code-integration",
        round: 3,
        findings: [finding],
        failed: [],
      })
    );

    const fallback = {
      ...ruling,
      data: {
        subject: ruling.data.subject,
        ruling: "accepted",
        rationale: "Accept the locus correction",
      },
    };

    const reviewIdentityResult2 = await reviewIdentity(
      ctx,
      { records: [bind, fallback, fix], lastSeq: 3, torn: null },
      f.root,
      head,
      base
    );

    assert.equal(reviewIdentityResult2.baseline, baseline);
    changed = ["src/file.ts", "src/helper.ts"];
    await assert.rejects(
      reviewIdentity(
        ctx,
        { records: [bind, fallback, fix], lastSeq: 3, torn: null },
        f.root,
        head,
        base
      ),
      { reason: "review-required" }
    );
  } finally {
    f.cleanup();
  }
});

test("review identity accepts a narrowed re-review round", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("work.spec.md", "# Work\n");
    f.artifact("work.plan.md", source);

    const head = "a".repeat(40);
    const base = "b".repeat(40);

    const bind = {
      kind: "bind",
      seq: 1,
      key: "bind",
      at: "",
      by: "tool",
      data: { spec: "work.spec.md", plan: "work.plan.md" },
    };

    const artifacts = currentHashes(f.root, bind);
    const dir = path.join(f.session, ".state/reviews/code-integration/round-2");
    fs.mkdirSync(path.join(dir, "gen-1/slots"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "round.json"),
      JSON.stringify({
        round: 2,
        cap: 3,
        generation: 1,
        startSeq: 1,
        target: { base, head },
        scope: "Re-review round 2 (narrowed) — changed: file",
        artifacts,
        spec: { path: "/work.spec.md", hash: artifacts.spec },
        roster: [{ slot: "reviewer", reserve: false }],
      })
    );
    fs.writeFileSync(
      path.join(dir, "findings.json"),
      JSON.stringify({
        review: "code-integration",
        round: 2,
        findings: [],
        failed: [],
      })
    );
    fs.writeFileSync(
      path.join(dir, "gen-1/slots/reviewer.json"),
      JSON.stringify({
        slot: "reviewer",
        state: "done",
        text: '{"status":"CLEAN","findings":[]}',
      })
    );

    const ctx: HandlerContext = {
      session: f.session,
      manifest: readManifest(f.session),
      args: [],
      values: {},
      deps: f.deps,
    };

    const result = await reviewIdentity(
      ctx,
      { records: [bind], lastSeq: 1, torn: null },
      f.root,
      head,
      base
    );

    assert.equal(result.round, 2);
  } finally {
    f.cleanup();
  }
});

// SECTION: Delivery gates read the corrected severity

const correctedGate = async (
  stored: { severity: string; impact: string; trigger: string },
  correction: { impact: string; trigger: string } | null
) => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("work.spec.md", "# Work\n");
    f.artifact("work.plan.md", source);

    const baseline = "a".repeat(40);
    const head = "b".repeat(40);
    const base = "c".repeat(40);
    const commitReason = "repair accepted SHOULD";

    const bind: LedgerRecord = {
      kind: "bind",
      seq: 1,
      key: "bind",
      at: "",
      by: "tool",
      data: { spec: "work.spec.md", plan: "work.plan.md" },
    };

    const reviewFix = {
      review: "code-integration",
      round: 3,
      generation: 1,
      findings: ["R3-F001"],
      from: baseline,
    };

    const ruling: LedgerRecord = {
      kind: "ruling",
      seq: 2,
      key: "ruling",
      at: "",
      by: "orchestrator",
      data: {
        subject: "review:code-integration:R3-F001",
        ruling: "accepted",
        rationale: "impact: corrected after review",
        ...correction,
      },
    };

    const fix: LedgerRecord = {
      kind: "integrate",
      seq: 3,
      key: "fix",
      at: "",
      by: "tool",
      data: { phase: "fix", commit: head, reason: commitReason, reviewFix },
    };

    const artifacts = currentHashes(f.root, bind);

    const reviewDir = path.join(
      f.session,
      ".state/reviews/code-integration/round-3"
    );

    fs.mkdirSync(path.join(reviewDir, "gen-1/slots"), { recursive: true });

    const finding = {
      id: "R3-F001",
      ...stored,
      locus: "src/file.ts:L1",
      defect: "The source is incorrect",
      requiredChange: "Correct the source",
    };

    fs.writeFileSync(
      path.join(reviewDir, "round.json"),
      JSON.stringify({
        round: 3,
        cap: 3,
        generation: 1,
        startSeq: 1,
        target: { base, head: baseline },
        scope: "Full review",
        artifacts,
        spec: { path: "/work.spec.md", hash: artifacts.spec },
        roster: [{ slot: "reviewer", reserve: false }],
      })
    );
    fs.writeFileSync(
      path.join(reviewDir, "findings.json"),
      JSON.stringify({
        review: "code-integration",
        round: 3,
        findings: [finding],
        failed: [],
      })
    );
    fs.writeFileSync(
      path.join(reviewDir, "gen-1/slots/reviewer.json"),
      JSON.stringify({
        slot: "reviewer",
        state: "done",
        text: '{"status":"CLEAN","findings":[]}',
      })
    );

    const canonical = stableValue(reviewFix);
    const fixDigest = `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
    const fixData = Buffer.from(canonical).toString("base64url");

    const manifest = readManifest(f.session);

    const message = [
      `fix(dispatch): ${commitReason}`,
      "",
      `Dispatch-Fix: ${manifest.safeSessionId}`,
      `Dispatch-Review-Fix: ${fixDigest}`,
      `Dispatch-Review-Fix-Data: ${fixData}`,
      "",
    ].join("\n");

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.run = (argv) => {
      const args = argv.slice(1);

      if (
        args[0] === "rev-list" &&
        args[1] === "--reverse" &&
        args[2] === "--parents"
      ) {
        return Promise.resolve(gitOutput(`${head} ${baseline}\n`));
      }

      if (args[0] === "diff-tree" && args.includes(head)) {
        return Promise.resolve(gitOutput("src/file.ts\0"));
      }

      if (
        args[0] === "log" &&
        args[1] === "-1" &&
        args[2] === "--format=%B" &&
        args[3] === head
      ) {
        return Promise.resolve(gitOutput(message));
      }

      throw new Error(`Unexpected Git argv: ${JSON.stringify(argv)}`);
    };

    const ctx: HandlerContext = {
      session: f.session,
      manifest,
      args: [],
      values: {},
      deps: f.deps,
    };

    return await reviewIdentity(
      ctx,
      { records: [bind, ruling, fix], lastSeq: 3, torn: null },
      f.root,
      head,
      base
    )
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({
        ok: false as const,
        reason: refusal(error) ? error.reason : undefined,
      }));
  } finally {
    f.cleanup();
  }
};

test("corrected finding: corrected severity transitions govern final-round fix qualification", async () => {
  const downgraded = await correctedGate(
    { severity: "MUST", impact: "blocks", trigger: "realistic" },
    { impact: "degrades", trigger: "realistic" }
  );

  assert.equal(downgraded.ok, true, JSON.stringify(downgraded));

  for (const stored of [
    { severity: "MUST", impact: "blocks", trigger: "realistic" },
    { severity: "SHOULD", impact: "degrades", trigger: "realistic" },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const result = await correctedGate(stored, {
      impact: "degrades",
      trigger: "contrived",
    });

    assert.equal(result.ok, true, JSON.stringify(result));
  }

  assert.deepEqual(
    await correctedGate(
      { severity: "CONSIDER", impact: "minor", trigger: "contrived" },
      null
    ),
    {
      ok: false,
      reason: "review-required",
    }
  );

  const correctedGateResult = await correctedGate(
    { severity: "SHOULD", impact: "degrades", trigger: "realistic" },
    null
  );

  assert.equal(correctedGateResult.ok, true);

  const raised = await correctedGate(
    { severity: "SHOULD", impact: "degrades", trigger: "realistic" },
    { impact: "blocks", trigger: "realistic" }
  );

  assert.deepEqual(raised, { ok: false, reason: "review-required" });
});

// SECTION: Coverage decision gates the review identity

const [A, B, C] = ["codex[0]", "opencode[1]", "claude[2]"];

interface CoverageRound {
  n: number;
  scope?: string;
  base?: string;
  done: string[];
  failed: string[];
  coverage?: "open" | "full";
}

const coverageIdentity = async (
  rounds: CoverageRound[],
  extra: (seq: number) => LedgerRecord[] = () => [],
  prepare?: (dir: string) => void,
  opened = false
) => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact("work.spec.md", "# Work\n");
    f.artifact("work.plan.md", source);

    const head = "a".repeat(40);
    const base = "b".repeat(40);

    const bind = {
      kind: "bind",
      seq: 1,
      key: "bind",
      at: "",
      by: "tool",
      data: { spec: "work.spec.md", plan: "work.plan.md" },
    };

    const artifacts = currentHashes(f.root, bind);
    const root = path.join(f.session, ".state/reviews/code-integration");

    const spec = {
      path: path.resolve(f.root, "work.spec.md"),
      hash: artifacts.spec,
    };

    for (const item of rounds) {
      const dir = path.join(root, `round-${item.n}`);
      const slots = path.join(dir, "gen-1/slots");
      const whole = item.n === 1 || item.coverage !== undefined;

      fs.mkdirSync(slots, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "round.json"),
        JSON.stringify({
          round: item.n,
          cap: 3,
          generation: 1,
          startSeq: 1,
          target: { base: item.base ?? base, head },
          artifacts,
          spec,
          scope:
            item.scope ??
            (item.n === 1
              ? "Full review"
              : `Re-review round ${item.n} (coverage) — changed paths: src/file.ts; comparison: ${base}..${head}`),
          roster: [...item.done, ...item.failed].map((slot) => ({
            slot,
            reserve: false,
          })),
          ...(item.coverage && { coverage: item.coverage }),
        })
      );
      fs.writeFileSync(
        path.join(dir, "findings.json"),
        JSON.stringify({
          review: "code-integration",
          round: item.n,
          findings: [],
          failed: [],
        })
      );

      for (const slot of item.done) {
        fs.writeFileSync(
          path.join(slots, `${slot}.json`),
          JSON.stringify({
            slot,
            state: "done",
            text: '{"status":"CLEAN","findings":[]}',
          })
        );
      }

      for (const slot of item.failed) {
        fs.writeFileSync(
          path.join(slots, `${slot}.json`),
          JSON.stringify({
            slot,
            state: "failed",
            cls: "timeout",
            reason: "slow",
          })
        );
      }

      if (item.failed.length) {
        fs.writeFileSync(
          path.join(dir, "gen-1/attempts.json"),
          JSON.stringify(
            item.failed.map((slot) => ({
              slot,
              seq: 2,
              wholeTarget: whole,
              outcome: "timeout",
            }))
          )
        );
      }
    }

    prepare?.(root);

    const records: LedgerRecord[] = [
      bind,
      ...(opened
        ? [
            {
              kind: "integrate",
              seq: 2,
              key: "opened",
              at: "",
              by: "tool",
              data: { phase: "opened", base },
            },
          ]
        : []),
      ...extra(10),
    ];

    const ctx: HandlerContext = {
      session: f.session,
      manifest: readManifest(f.session),
      args: [],
      values: {},
      deps: f.deps,
    };

    return await reviewIdentity(
      ctx,
      { records, lastSeq: 20, torn: null },
      f.root,
      head,
      base
    )
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({
        ok: false as const,
        reason: refusal(error) ? error.reason : undefined,
      }));
  } finally {
    f.cleanup();
  }
};

const accept = (seq: number, slots: string[]) => ({
  seq,
  key: `coverage:code-integration:${seq}`,
  at: "",
  kind: "escalation",
  by: "user",
  quote: "accept it",
  data: {
    id: `coverage:code-integration:${seq}`,
    state: "resolved",
    summary: `accept: ${slots.join(", ")}`,
  },
});

const rerunRounds: CoverageRound[] = [
  { n: 1, done: [B, C], failed: [A] },
  { n: 2, coverage: "full", done: [B, C], failed: [A] },
];

test("review identity reads coverage decision: majority and override accept a failed slot", async () => {
  const majority = await coverageIdentity(rerunRounds);
  assert.equal(majority.ok, true, JSON.stringify(majority));
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
  assert.equal((majority as { value: { round: number } }).value.round, 2);

  const overridden = await coverageIdentity(
    [{ n: 1, done: [B, C], failed: [A] }],
    (seq) => [accept(seq, [A])]
  );

  assert.equal(overridden.ok, true, JSON.stringify(overridden));
});

test("review identity reads coverage decision: rerun, user and unreadable state refuse", async () => {
  const refused = { ok: false, reason: "review-required" };
  assert.deepEqual(
    await coverageIdentity([{ n: 1, done: [B, C], failed: [A] }]),
    refused,
    "a failed slot with no rerun"
  );
  assert.deepEqual(
    await coverageIdentity([
      { n: 1, done: [C], failed: [A, B] },
      { n: 2, coverage: "full", done: [C], failed: [A, B] },
    ]),
    refused,
    "a rerun that left half or fewer complete"
  );
  assert.deepEqual(
    await coverageIdentity(
      rerunRounds,
      () => [],
      (root) => {
        fs.rmSync(path.join(root, "round-2/gen-1/attempts.json"));
      }
    ),
    refused,
    "a failed slot with no attempt entry"
  );
  assert.deepEqual(
    await coverageIdentity([{ n: 1, done: [], failed: [A, B, C] }], (seq) => [
      accept(seq, [A, B, C]),
    ]),
    refused,
    "a last round with no completed slot"
  );
  assert.deepEqual(
    await coverageIdentity([{ n: 1, done: [B, C], failed: [A] }], (seq) => [
      { ...accept(seq, [A]), by: "orchestrator" },
    ]),
    refused,
    "an override from another author"
  );
});

test("review identity reads coverage decision: failures outside the applicable rounds are ignored", async () => {
  const rounds: CoverageRound[] = [
    { n: 1, base: "c".repeat(40), done: [B, C], failed: [A] },
    { n: 2, coverage: "open", done: [B, C], failed: [] },
  ];

  assert.deepEqual(
    await coverageIdentity(rounds),
    { ok: false, reason: "review-required" },
    "without a predicate the earlier failure stays open"
  );

  const coverageIdentityResult = await coverageIdentity(
    rounds,
    () => [],
    undefined,
    true
  );

  assert.equal(coverageIdentityResult.ok, true);
});

// SECTION: Confirmation-only rounds

const identityRoster = [
  {
    slot: "reviewer",
    provider: "codex",
    model: null,
    index: 0,
    reserve: false,
    native: false,
  },
];

interface IdentitySeed {
  n: number;
  scope: string;
  head: string;
  startSeq: number;
  findings: object[];
  roster?: typeof identityRoster;
  requests?: RejectionRequest[];
  confirmations?: object[];
  slotText?: string;
  responder?: object;
}

const seedIdentityRounds = (
  f: ReturnType<typeof sessionFixture>,
  base: string,
  artifacts: ReturnType<typeof currentHashes>,
  spec: { path: string; hash: string },
  rounds: readonly IdentitySeed[]
) => {
  const root = path.join(f.session, ".state/reviews/code-integration");

  for (const item of rounds) {
    const dir = path.join(root, `round-${item.n}`);
    const slots = path.join(dir, "gen-1/slots");
    const roster = item.roster ?? identityRoster;

    fs.mkdirSync(slots, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "round.json"),
      JSON.stringify({
        round: item.n,
        cap: 3,
        generation: 1,
        startSeq: item.startSeq,
        target: { base, head: item.head },
        artifacts,
        spec,
        scope: item.scope,
        roster,
        ...(item.requests && { requests: item.requests }),
      })
    );
    fs.writeFileSync(
      path.join(dir, "findings.json"),
      JSON.stringify({
        review: "code-integration",
        round: item.n,
        findings: item.findings,
        failed: [],
        ...(item.confirmations && { confirmations: item.confirmations }),
      })
    );

    for (const slot of roster.filter((entry) => !entry.reserve)) {
      fs.writeFileSync(
        path.join(slots, `${slot.slot}.json`),
        JSON.stringify({
          slot: slot.slot,
          state: "done",
          text: item.slotText ?? '{"status":"CLEAN","findings":[]}',
          ...(item.responder && { responder: item.responder }),
        })
      );
    }
  }
};

const confirmationOf = (request: RejectionRequest, rationale: string) => {
  const responder = {
    slot: "reviewer",
    provider: "codex",
    model: null,
    native: false,
  };

  return {
    reply: {
      ...request,
      sourceSlot: "reviewer",
      responder,
      decision: "agree",
      replyRationale: rationale,
    },
    slotText: JSON.stringify({
      status: "CLEAN",
      findings: [],
      confirmations: [
        { requestId: request.requestId, decision: "agree", rationale },
      ],
    }),
  };
};

const reviewClaim = (id: string, defect: string): Finding => ({
  id,
  severity: "MUST",
  impact: "blocks",
  trigger: "realistic",
  category: "correctness",
  locus: "src/file.ts:L1",
  defect,
  requiredChange: "Bound the writes",
  sources: ["reviewer"],
  scope: "in",
});

test("confirmation-only round preserves substantive review identity and rejects unverified accepted MUST", async () => {
  // A verified fix settles an accepted MUST across a confirmation-only round.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.artifact("work.spec.md", "# Work\n");
      f.artifact("work.plan.md", source);
      await appendRecord(
        f.session,
        {
          kind: "bind",
          by: "orchestrator",
          key: "bind",
          data: { spec: "work.spec.md", plan: "work.plan.md" },
        },
        f.deps
      );

      const artifacts = currentHashes(
        f.root,
        latest(foldLedger(f.session), "bind")
      );

      const base = "c".repeat(40);
      const first = "a".repeat(40);
      const second = "b".repeat(40);

      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "opened",
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

      const accepted = await appendRecord(
        f.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "accept-first",
          data: {
            subject: "review:code-integration:R1-F001",
            ruling: "accepted",
            rationale: "The bounded fix is required",
          },
        },
        f.deps
      );

      const rejected = await appendRecord(
        f.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "reject-second",
          data: {
            subject: "review:code-integration:R2-F001",
            ruling: "rejected",
            rationale: "The captured bound holds",
          },
        },
        f.deps
      );

      const claim = reviewClaim("R2-F001", "Writes are unbounded");

      const spec = {
        path: path.resolve(f.root, "work.spec.md"),
        hash: defined(artifacts["spec"]),
      };

      const request = rejectionRequest({
        review: "code-integration",
        finding: "R2-F001",
        rulingSeq: rejected.seq,
        claim,
        rationale: "The captured bound holds",
        target: { base, head: second },
        spec,
        sourceSlots: ["reviewer"],
      });

      const confirmation = confirmationOf(request, "The captured bound holds");
      seedIdentityRounds(f, base, artifacts, spec, [
        {
          n: 1,
          scope: "Full review",
          head: first,
          startSeq: 1,
          findings: [reviewClaim("R1-F001", "Writes are unbounded")],
        },
        {
          n: 2,
          scope: `Re-review round 2 (full) — changed: src/file.ts; comparison: ${first}..${second}`,
          head: second,
          startSeq: rejected.seq + 1,
          findings: [claim],
        },
        {
          n: 3,
          scope: `Re-review round 3 (confirmation-only) — comparison: ${second}..${second}`,
          head: second,
          startSeq: rejected.seq + 2,
          findings: [],
          requests: [request],
          confirmations: [confirmation.reply],
          slotText: confirmation.slotText,
          responder: confirmation.reply.responder,
        },
      ]);

      const ctx: HandlerContext = {
        session: f.session,
        manifest: readManifest(f.session),
        args: [],
        values: {},
        deps: f.deps,
      };

      const identity = await reviewIdentity(
        ctx,
        foldLedger(f.session),
        f.root,
        second,
        base
      );

      assert.equal(identity.baseline, second);
      assert.deepEqual(
        {
          round: identity.round,
          generation: identity.generation,
          startSeq: identity.startSeq,
        },
        { round: 2, generation: 1, startSeq: rejected.seq + 1 }
      );
      assert.ok(accepted.seq > 0);
      f.lines.length = 0;

      const exit = await main(
        ["report", "complete", "--session", f.session],
        f.deps
      );

      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const output = JSON.parse(defined(f.lines[0]));
      assert.equal(exit, 4);
      assert.equal(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        output.reason,
        "no-integration",
        "the confirmation gate admits the report before the missing integration refuses it"
      );
    } finally {
      f.cleanup();
    }
  }

  // An accepted MUST with no later substantive verification still refuses, even when a confirmation-only round has no findings.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.artifact("work.spec.md", "# Work\n");
      f.artifact("work.plan.md", source);
      await appendRecord(
        f.session,
        {
          kind: "bind",
          by: "orchestrator",
          key: "bind",
          data: { spec: "work.spec.md", plan: "work.plan.md" },
        },
        f.deps
      );

      const artifacts = currentHashes(
        f.root,
        latest(foldLedger(f.session), "bind")
      );

      const base = "c".repeat(40);
      const head = "a".repeat(40);

      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "opened",
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

      const accepted = await appendRecord(
        f.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "accept-unverified",
          data: {
            subject: "review:code-integration:R1-F001",
            ruling: "accepted",
            rationale: "Claimed resolution",
          },
        },
        f.deps
      );

      const rejected = await appendRecord(
        f.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "reject-other",
          data: {
            subject: "review:code-integration:R1-F002",
            ruling: "rejected",
            rationale: "Still broken",
          },
        },
        f.deps
      );

      const claim = reviewClaim("R1-F002", "Retries are unbounded");

      const spec = {
        path: path.resolve(f.root, "work.spec.md"),
        hash: defined(artifacts.spec),
      };

      const request = rejectionRequest({
        review: "code-integration",
        finding: "R1-F002",
        rulingSeq: rejected.seq,
        claim,
        rationale: "Still broken",
        target: { base, head },
        spec,
        sourceSlots: ["reviewer"],
      });

      const confirmation = confirmationOf(request, "Still broken");
      seedIdentityRounds(f, base, artifacts, spec, [
        {
          n: 1,
          scope: "Full review",
          head,
          startSeq: accepted.seq,
          findings: [reviewClaim("R1-F001", "Writes are unbounded"), claim],
        },
        {
          n: 2,
          scope: `Re-review round 2 (confirmation-only) — comparison: ${head}..${head}`,
          head,
          startSeq: rejected.seq + 1,
          findings: [],
          requests: [request],
          confirmations: [confirmation.reply],
          slotText: confirmation.slotText,
          responder: confirmation.reply.responder,
        },
      ]);

      const ctx: HandlerContext = {
        session: f.session,
        manifest: readManifest(f.session),
        args: [],
        values: {},
        deps: f.deps,
      };

      await assert.rejects(
        reviewIdentity(ctx, foldLedger(f.session), f.root, head, base),
        {
          reason: "review-required",
        }
      );
    } finally {
      f.cleanup();
    }
  }

  // A recurrence in the substantive round blocks settlement even when the confirmation-only round reports no findings.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.artifact("work.spec.md", "# Work\n");
      f.artifact("work.plan.md", source);
      await appendRecord(
        f.session,
        {
          kind: "bind",
          by: "orchestrator",
          key: "bind",
          data: { spec: "work.spec.md", plan: "work.plan.md" },
        },
        f.deps
      );

      const artifacts = currentHashes(
        f.root,
        latest(foldLedger(f.session), "bind")
      );

      const base = "c".repeat(40);
      const first = "a".repeat(40);
      const second = "b".repeat(40);

      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "opened",
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

      const accepted = await appendRecord(
        f.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "accept-recurring",
          data: {
            subject: "review:code-integration:R1-F001",
            ruling: "accepted",
            rationale: "Claimed resolution",
          },
        },
        f.deps
      );

      const rejected = await appendRecord(
        f.session,
        {
          kind: "ruling",
          by: "orchestrator",
          key: "reject-current",
          data: {
            subject: "review:code-integration:R2-F001",
            ruling: "rejected",
            rationale: "Still unbounded",
          },
        },
        f.deps
      );

      const claim = reviewClaim("R2-F001", "Retries are unbounded");

      const spec = {
        path: path.resolve(f.root, "work.spec.md"),
        hash: defined(artifacts["spec"]),
      };

      const request = rejectionRequest({
        review: "code-integration",
        finding: "R2-F001",
        rulingSeq: rejected.seq,
        claim,
        rationale: "Still unbounded",
        target: { base, head: second },
        spec,
        sourceSlots: ["reviewer"],
      });

      const confirmation = confirmationOf(request, "Still unbounded");
      seedIdentityRounds(f, base, artifacts, spec, [
        {
          n: 1,
          scope: "Full review",
          head: first,
          startSeq: accepted.seq,
          findings: [reviewClaim("R1-F001", "Writes are unbounded")],
        },
        {
          n: 2,
          scope: `Re-review round 2 (full) — changed: src/file.ts; comparison: ${first}..${second}`,
          head: second,
          startSeq: rejected.seq + 1,
          findings: [
            claim,
            {
              ...reviewClaim("R2-F002", "Writes are unbounded"),
              severity: "SHOULD",
              impact: "degrades",
              recurrence: { of: "R1-F001" },
            },
          ],
        },
        {
          n: 3,
          scope: `Re-review round 3 (confirmation-only) — comparison: ${second}..${second}`,
          head: second,
          startSeq: rejected.seq + 2,
          findings: [],
          requests: [request],
          confirmations: [confirmation.reply],
          slotText: confirmation.slotText,
          responder: confirmation.reply.responder,
        },
      ]);

      const ctx: HandlerContext = {
        session: f.session,
        manifest: readManifest(f.session),
        args: [],
        values: {},
        deps: f.deps,
      };

      await assert.rejects(
        reviewIdentity(ctx, foldLedger(f.session), f.root, second, base),
        {
          reason: "review-required",
        }
      );
    } finally {
      f.cleanup();
    }
  }
});

// SECTION: Closed-review recurrence escalations on resume

const closedPlanReview = reviewId("plan", "old.plan.md");
const closureHead = "a".repeat(40);
const closureBase = "b".repeat(40);

const seedCleanIntegrationRound = async (
  f: ReturnType<typeof sessionFixture>,
  findings: object[] = []
) => {
  f.artifact("work.spec.md", "# Work\n");
  f.artifact("work.plan.md", source);
  await appendRecord(
    f.session,
    {
      kind: "bind",
      by: "orchestrator",
      key: "bind",
      data: { spec: "work.spec.md", plan: "work.plan.md" },
    },
    f.deps
  );

  const artifacts = currentHashes(
    f.root,
    latest(foldLedger(f.session), "bind")
  );

  seedIdentityRounds(
    f,
    closureBase,
    artifacts,
    {
      path: path.resolve(f.root, "work.spec.md"),
      hash: defined(artifacts.spec),
    },
    [{ n: 1, scope: "Full review", head: closureHead, startSeq: 1, findings }]
  );
};

const seedClosedPlanReview = (
  f: ReturnType<typeof sessionFixture>,
  findings: object[]
) => {
  const dir = path.join(
    f.session,
    ".state/reviews",
    closedPlanReview,
    "round-1"
  );

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "round.json"),
    JSON.stringify({
      round: 1,
      cap: 3,
      generation: 1,
      startSeq: 1,
      target: "d".repeat(64),
      spec: {
        path: path.resolve(f.root, "work.spec.md"),
        hash: "e".repeat(64),
      },
      scope: "Full review",
      roster: identityRoster,
    })
  );
  fs.writeFileSync(
    path.join(dir, "findings.json"),
    JSON.stringify({ review: closedPlanReview, round: 1, findings, failed: [] })
  );
};

const recordEscalation = async (
  f: ReturnType<typeof sessionFixture>,
  id: string,
  state: "open" | "resolved",
  summary: string
) =>
  await appendRecord(
    f.session,
    {
      kind: "escalation",
      by: "tool",
      key: `${id}:${state}`,
      data: { id, state, summary },
    },
    f.deps
  );

const recordCeilingClose = async (
  f: ReturnType<typeof sessionFixture>,
  review: string
) => {
  const id = `ceiling:${review}:3`;

  await recordEscalation(f, id, "open", "ceiling 3 reached");
  await appendRecord(
    f.session,
    {
      kind: "escalation",
      by: "user",
      quote: "close it",
      key: `${id}:resolved`,
      data: {
        id,
        state: "resolved",
        summary: "close: accepted residual plan risk",
      },
    },
    f.deps
  );
};

const resumeIdentity = async (f: ReturnType<typeof sessionFixture>) =>
  await reviewIdentity(
    {
      session: f.session,
      manifest: readManifest(f.session),
      args: [],
      values: {},
      deps: f.deps,
    },
    foldLedger(f.session),
    f.root,
    closureHead,
    closureBase
  );

test("closed plan review recurrence escalations do not block code review resume after a clean pass", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, [
      {
        id: "F1",
        severity: "SHOULD",
        sources: ["reviewer"],
        locus: "work.plan.md:L1",
      },
    ]);
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "unruled SHOULD"
    );

    const identity = await resumeIdentity(f);

    assert.equal(identity.round, 1);
  } finally {
    f.cleanup();
  }
});

test("closed plan review recurrence escalations do not block code review resume after a ceiling close", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, [
      {
        id: "F1",
        severity: "MUST",
        sources: ["reviewer"],
        locus: "work.plan.md:L1",
      },
    ]);
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "unruled MUST"
    );
    await recordCeilingClose(f, closedPlanReview);

    const identity = await resumeIdentity(f);

    assert.equal(identity.round, 1);
  } finally {
    f.cleanup();
  }
});

test("closed plan review recurrence escalations recorded after a ceiling close still block resume", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, [
      {
        id: "F1",
        severity: "MUST",
        sources: ["reviewer"],
        locus: "work.plan.md:L1",
      },
    ]);
    await recordCeilingClose(f, closedPlanReview);
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "recurred after close"
    );

    await assert.rejects(resumeIdentity(f), { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

test("closed plan review with a pending MUST rejection keeps recurrence escalations blocking resume", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, [
      {
        id: "F1",
        severity: "MUST",
        sources: ["reviewer"],
        locus: "work.plan.md:L1",
      },
    ]);
    await appendRecord(
      f.session,
      {
        kind: "ruling",
        by: "orchestrator",
        key: "reject-plan-f1",
        data: {
          subject: `review:${closedPlanReview}:F1`,
          ruling: "rejected",
          rationale: "Plan finding is out of scope",
        },
      },
      f.deps
    );
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "pending rejection"
    );
    await recordCeilingClose(f, closedPlanReview);

    await assert.rejects(resumeIdentity(f), { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

const seedActiveRecurrence = async (
  f: ReturnType<typeof sessionFixture>,
  adjudicated: boolean
) => {
  await seedCleanIntegrationRound(f, [
    {
      id: "F1",
      severity: "SHOULD",
      sources: ["reviewer"],
      locus: "src/file.ts:L1",
    },
  ]);
  seedClosedPlanReview(f, [
    {
      id: "F2",
      severity: "SHOULD",
      sources: ["reviewer"],
      locus: "work.plan.md:L1",
    },
  ]);
  await recordEscalation(
    f,
    `recurrence:${closedPlanReview}:F2:g1`,
    "open",
    "closed plan recurrence"
  );
  await recordEscalation(
    f,
    "recurrence:code-integration:F1:g1",
    "open",
    "active review recurrence"
  );

  if (adjudicated) {
    await appendRecord(
      f.session,
      {
        kind: "ruling",
        by: "orchestrator",
        key: "accept-active-f1",
        data: {
          subject: "review:code-integration:F1",
          ruling: "accepted",
          rationale: "Accept the SHOULD fix",
        },
      },
      f.deps
    );
  }
};

test("active review recurrence escalations keep blocking resume beside a closed plan review", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedActiveRecurrence(f, false);

    await assert.rejects(resumeIdentity(f), { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

test("adjudicated active review recurrence escalations keep blocking resume beside a closed plan review", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedActiveRecurrence(f, true);

    await assert.rejects(resumeIdentity(f), { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

test("open ceiling escalations keep blocking resume even when the closed plan review passed clean", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, [
      {
        id: "F1",
        severity: "SHOULD",
        sources: ["reviewer"],
        locus: "work.plan.md:L1",
      },
    ]);
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "unruled SHOULD"
    );
    await recordEscalation(
      f,
      `ceiling:${closedPlanReview}:3`,
      "open",
      "ceiling 3 reached"
    );

    await assert.rejects(resumeIdentity(f), { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

test("recurrence escalations of a review without recorded rounds keep blocking resume", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "no rounds on disk"
    );

    await assert.rejects(resumeIdentity(f), { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

const malformClosedPlanFindings = (f: ReturnType<typeof sessionFixture>) => {
  fs.writeFileSync(
    path.join(
      f.session,
      ".state/reviews",
      closedPlanReview,
      "round-1",
      "findings.json"
    ),
    JSON.stringify({
      review: closedPlanReview,
      round: 1,
      findings: "malformed",
      failed: [],
    })
  );
};

test("closed plan review with malformed findings evidence keeps recurrence escalations blocking resume", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, []);
    malformClosedPlanFindings(f);
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "unruled SHOULD"
    );

    await assert.rejects(resumeIdentity(f), { reason: "review-required" });
  } finally {
    f.cleanup();
  }
});

test("closed plan review with malformed findings evidence still closes recurrence escalations after a ceiling close", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, []);
    malformClosedPlanFindings(f);
    await recordEscalation(
      f,
      `recurrence:${closedPlanReview}:F1:g1`,
      "open",
      "unruled SHOULD"
    );
    await recordCeilingClose(f, closedPlanReview);

    const identity = await resumeIdentity(f);

    assert.equal(identity.round, 1);
  } finally {
    f.cleanup();
  }
});

// SECTION: Closed-review recurrence predicate

const closure = (
  overrides: Partial<Parameters<typeof evaluateReviewClosed>[0]> = {}
) => ({
  reviewId: "plan-old",
  activeReviewId: "code-integration",
  pendingMustRejections: 0,
  cleanPass: false,
  latestRecurrenceSeq: 4,
  latestCeiling: undefined,
  ...overrides,
});

test("closed review recurrence predicate never closes the active review", () => {
  assert.equal(
    evaluateReviewClosed(
      closure({ reviewId: "code-integration", cleanPass: true })
    ),
    false
  );
});

test("closed review recurrence predicate closes a clean pass with no pending MUST rejection", () => {
  assert.equal(evaluateReviewClosed(closure({ cleanPass: true })), true);
});

test("closed review recurrence predicate keeps a pending MUST rejection blocking after a clean pass", () => {
  assert.equal(
    evaluateReviewClosed(
      closure({ cleanPass: true, pendingMustRejections: 1 })
    ),
    false
  );
});

test("closed review recurrence predicate keeps a review without clean pass or ceiling close blocking", () => {
  assert.equal(evaluateReviewClosed(closure()), false);
});

test("closed review recurrence predicate closes a ceiling close recorded after the latest recurrence", () => {
  const latestCeiling = {
    seq: 5,
    state: "resolved",
    summary: "close: accepted residual risk",
  };

  assert.equal(evaluateReviewClosed(closure({ latestCeiling })), true);
});

test("closed review recurrence predicate closes a ceiling defer recorded after the latest recurrence", () => {
  const latestCeiling = {
    seq: 5,
    state: "resolved",
    summary: "defer: revisit next release",
  };

  assert.equal(evaluateReviewClosed(closure({ latestCeiling })), true);
});

test("closed review recurrence predicate ignores a ceiling close recorded before the latest recurrence", () => {
  const latestCeiling = {
    seq: 3,
    state: "resolved",
    summary: "close: accepted residual risk",
  };

  assert.equal(evaluateReviewClosed(closure({ latestCeiling })), false);
});

test("closed review recurrence predicate ignores open ceilings and re-author grants", () => {
  const open = { seq: 5, state: "open", summary: "ceiling 3 reached" };

  const granted = {
    seq: 5,
    state: "resolved",
    summary: "re-author: split the plan",
  };

  assert.equal(evaluateReviewClosed(closure({ latestCeiling: open })), false);
  assert.equal(
    evaluateReviewClosed(closure({ latestCeiling: granted })),
    false
  );
});

test("closed review recurrence predicate keeps a pending MUST rejection blocking after a ceiling close", () => {
  const latestCeiling = {
    seq: 5,
    state: "resolved",
    summary: "close: accepted residual risk",
  };

  assert.equal(
    evaluateReviewClosed(closure({ pendingMustRejections: 1, latestCeiling })),
    false
  );
});

test("closed review recurrence predicate reads the recorded plan review from disk", async () => {
  const f = sessionFixture({ memory: true });

  try {
    await seedCleanIntegrationRound(f);
    seedClosedPlanReview(f, [
      {
        id: "F1",
        severity: "SHOULD",
        sources: ["reviewer"],
        locus: "work.plan.md:L1",
      },
    ]);

    const fold = foldLedger(f.session);

    assert.equal(
      isReviewClosed(f.session, fold, closedPlanReview, "code-integration"),
      true
    );
    assert.equal(
      isReviewClosed(f.session, fold, closedPlanReview, closedPlanReview),
      false
    );
  } finally {
    f.cleanup();
  }
});
