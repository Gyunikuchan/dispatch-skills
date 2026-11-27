import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";

import { generateSkillHashes } from "../../../skills/dispatch/scripts/lib/integrity.ts";
import type { JsonObject } from "../../../skills/dispatch/scripts/lib/integrity.ts";
import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  HINT_MAX_BYTES,
  isHintExcludedAction,
  stepHint,
} from "../../../skills/dispatch/scripts/toolkit/hints.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import type { Hashes } from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  checks,
  taskSection,
  loadPlan,
} from "../../../skills/dispatch/scripts/toolkit/plan-view.ts";
import type { LedgerRecord } from "../../../skills/dispatch/scripts/toolkit/records.ts";
import { defined } from "../../helpers/guards.ts";
import { sessionFixture } from "./helpers/session.ts";

const SPEC_SOURCE =
  "# Spec\n## Requirements\n### REQ-1 — Behavior\n- Acceptance: works\n";

const PLAN_SOURCE = [
  "# Plan",
  "",
  "## Task Map",
  "| ID | Title | Outcome | Prerequisites | Criteria |",
  "| --- | --- | --- | --- | --- |",
  "| T1 | Task one | Works | none | SC1 |",
  "| T2 | Task two | Works | T1 | SC2 |",
  "",
  "## Proposed Changes",
  "### T1 — Task one",
  "#### [MODIFY] src/a.ts",
  "- Purpose: implement A.",
  "",
  "### T2 — Task two",
  "#### [MODIFY] src/b.ts",
  "- Purpose: implement B.",
  "",
  "## Success Criteria",
  "- [SC1] A works",
  "  - Changes: src/a.ts",
  '  - Check: `node -e "process.exit(0)"`',
  "  - Evidence: check",
  "- [SC2] B works",
  "  - Changes: src/b.ts",
  '  - Check: `node -e "process.exit(0)"`',
  "  - Evidence: check",
  "",
  "## Verification Plan",
  "### Automated Tests",
  '- `node -e "process.exit(0)"`',
  "",
].join("\n");

// SAFETY: quote is only present when non-empty; all other fields are required.
const rec = (
  seq: number,
  kind: string,
  data: JsonObject,
  by = "orchestrator",
  quote?: string
) =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test restores the static fixture type the double was built with; the runtime shape is asserted below
  ({
    seq,
    kind,
    key: `${kind}:${seq}`,
    at: "2026-01-01T00:00:00.000Z",
    by,
    ...((quote ?? "").length > 0 && { quote }),
    data,
    // SAFETY: quote is only present when non-empty; all other fields are required.
  }) as LedgerRecord;

const makeFold = (...records: LedgerRecord[]) => ({
  records,
  lastSeq: records.at(-1)?.seq ?? 0,
  torn: null,
});

const SPEC_HASH = `sha256:${"1".repeat(64)}`;
const DESIGN_HASH = `sha256:${"2".repeat(64)}`;
const PLAN_HASH = `sha256:${"3".repeat(64)}`;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const TASK_HASH = `sha256:${"4".repeat(64)}`;

const baseHashes: Hashes = { spec: SPEC_HASH, plan: PLAN_HASH };
const designHashes: Hashes = { spec: SPEC_HASH, design: DESIGN_HASH };

const okResult = (value: unknown = {}, reason?: string) => ({
  ok: true,
  value,
  ...((reason ?? "").length > 0 && { reason }),
});

const checkResult = (tree: string, extra: JsonObject = {}) =>
  okResult({
    checks: [
      { tree, clean: true, before: tree, after: tree, exit: 0, ...extra },
    ],
  });

const openedIntegrate = (seq: number) =>
  rec(
    seq,
    "integrate",
    {
      phase: "opened",
      path: ".state/worktrees/integration",
      branch: "dispatch/test/integration",
      base: COMMIT_A,
      dest: { path: "/repo", branch: "main" },
    },
    "tool"
  );

describe("stepHint state machine and router hint envelope", () => {
  test("rows 1-6 omit hints on failure, native-pending, excluded actions, open escalations, level gate, missing bind, and unconfirmed spec", () => {
    const validBind = rec(1, "bind", { spec: "s.spec.md", plan: "p.plan.md" });

    const confirmed = rec(
      2,
      "confirm",
      { spec: SPEC_HASH },
      "user",
      "Confirmed"
    );

    const approved = rec(
      3,
      "approval",
      { spec: SPEC_HASH, plan: PLAN_HASH },
      "user",
      "Approved"
    );

    const opened = openedIntegrate(4);

    const delivered = rec(
      5,
      "integrate",
      {
        phase: "delivered",
        mode: "uncommitted",
        dest: { path: "/repo", branch: "main" },
        from: COMMIT_A,
        source: COMMIT_B,
      },
      "tool"
    );

    // Row 1: !result.ok and native-pending
    assert.equal(
      stepHint({
        fold: makeFold(validBind, confirmed, approved, opened, delivered),
        current: baseHashes,
        action: "worktree deliver",
        result: { ok: false, reason: "checks-failed", value: {} },
      }),
      undefined
    );
    assert.equal(
      stepHint({
        fold: makeFold(validBind, confirmed, approved, opened, delivered),
        current: baseHashes,
        action: "worktree deliver",
        result: { ok: true, reason: "native-pending", value: {} },
      }),
      undefined
    );

    // Row 2: excluded actions
    for (const action of [
      "ask run",
      "diagnostics render",
      "worktree cleanup",
      "review run",
    ]) {
      assert.equal(
        stepHint({
          fold: makeFold(validBind, confirmed, approved, opened, delivered),
          current: baseHashes,
          action,
          result: okResult(),
        }),
        undefined,
        action
      );
    }

    // Row 3: open escalation blocks; resolved escalation allows downstream hint
    const openEsc = rec(6, "escalation", {
      id: "E1",
      state: "open",
      summary: "Need decision",
    });

    assert.equal(
      stepHint({
        fold: makeFold(
          validBind,
          confirmed,
          approved,
          opened,
          delivered,
          openEsc
        ),
        current: baseHashes,
        action: "worktree deliver",
        result: okResult(),
      }),
      undefined
    );

    const resolvedEsc = rec(7, "escalation", {
      id: "E1",
      state: "resolved",
      summary: "Resolved",
    });

    assert.equal(
      stepHint({
        fold: makeFold(
          validBind,
          confirmed,
          approved,
          opened,
          delivered,
          openEsc,
          resolvedEsc
        ),
        current: baseHashes,
        action: "worktree deliver",
        result: okResult(),
      }),
      "Complete walkthrough report — help report complete — report complete --session <session>"
    );

    // Row 4: !levelGate
    const xhighOrch = rec(5, "level", { level: "xhigh" }, "orchestrator");
    assert.equal(
      stepHint({
        fold: makeFold(validBind, confirmed, approved, opened, xhighOrch),
        current: baseHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );

    // Row 5: !bind
    assert.equal(
      stepHint({
        fold: makeFold(confirmed),
        current: baseHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );

    // Row 6: !confirmGate (newly confirmed spec missing or mismatched)
    assert.equal(
      stepHint({
        fold: makeFold(validBind),
        current: baseHashes,
        action: "ledger append",
        result: okResult({ deduped: false }),
      }),
      undefined
    );
    assert.equal(
      stepHint({
        fold: makeFold(validBind, confirmed),
        current: { spec: `sha256:${"9".repeat(64)}`, plan: PLAN_HASH },
        action: "ledger append",
        result: okResult({ deduped: false }),
      }),
      undefined
    );
  });

  test("row 7 emits review run only on fresh non-deduped bind after level and confirmation with no subsequent approval or ruling", () => {
    const level = rec(0, "level", { level: "medium" });
    const confirm = rec(1, "confirm", { spec: SPEC_HASH }, "user", "Confirmed");

    const designBind = rec(2, "bind", {
      spec: "s.spec.md",
      design: "d.design.md",
    });

    // Missing level record yields undefined
    assert.equal(
      stepHint({
        fold: makeFold(confirm, designBind),
        current: designHashes,
        action: "ledger append",
        result: okResult({ seq: 2, deduped: false }),
      }),
      undefined
    );

    // Design bind after level fires review run with --session, --host, and [--pins <pins>]
    assert.equal(
      stepHint({
        fold: makeFold(level, confirm, designBind),
        current: designHashes,
        action: "ledger append",
        result: okResult({ seq: 2, deduped: false }),
      }),
      "Run review — help review run — review run d.design.md --session <session> --host <platform> [--pins <pins>]"
    );

    // Unsafe characters or >240-byte path substitute <artifact> keeping required flags intact
    const longTarget = `plans/${"x".repeat(240)}.plan.md`;

    for (const unsafeTarget of [
      "-draft.plan.md",
      "plans/my plan.plan.md",
      "$HOME/p.plan.md",
      "$(id).plan.md",
      "a;b.plan.md",
      'a"b.plan.md',
      "a\nb.plan.md",
      longTarget,
    ]) {
      const hint = stepHint({
        fold: makeFold(
          level,
          confirm,
          rec(2, "bind", { spec: "s.spec.md", plan: unsafeTarget })
        ),
        current: baseHashes,
        action: "ledger append",
        result: okResult({ seq: 2, deduped: false }),
      });

      assert.equal(
        hint,
        "Run review — help review run — review run <artifact> --session <session> --host <platform> [--pins <pins>]"
      );
      assert.ok(Buffer.byteLength(hint, "utf-8") <= HINT_MAX_BYTES);
      assert.ok(
        hint.includes("--session <session> --host <platform> [--pins <pins>]")
      );
    }

    // Deduplicated bind yields undefined
    assert.equal(
      stepHint({
        fold: makeFold(level, confirm, designBind),
        current: designHashes,
        action: "ledger append",
        result: okResult({ seq: 2, deduped: true }),
      }),
      undefined
    );

    // Spec-only bind yields undefined
    const specBind = rec(2, "bind", { spec: "s.spec.md" });
    assert.equal(
      stepHint({
        fold: makeFold(level, confirm, specBind),
        current: { spec: SPEC_HASH },
        action: "ledger append",
        result: okResult({ seq: 2, deduped: false }),
      }),
      undefined
    );

    // Non-ledger-append action on bind yields undefined
    assert.equal(
      stepHint({
        fold: makeFold(level, confirm, designBind),
        current: designHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );

    // Design approved, then plan bound -> Row 7 fires for the plan!
    const designApproval = rec(
      3,
      "approval",
      { spec: SPEC_HASH, design: DESIGN_HASH },
      "user",
      "Design approved"
    );

    const planBind = rec(4, "bind", {
      spec: "s.spec.md",
      design: "d.design.md",
      plan: "p.plan.md",
    });

    assert.equal(
      stepHint({
        fold: makeFold(level, confirm, designBind, designApproval, planBind),
        current: { ...designHashes, plan: PLAN_HASH },
        action: "ledger append",
        result: okResult({ seq: 4, deduped: false }),
      }),
      "Run review — help review run — review run p.plan.md --session <session> --host <platform> [--pins <pins>]"
    );

    // Re-bind after ruling -> Row 7 fires for the newly bound artifact!
    const ruling = rec(3, "ruling", {
      subject: "review:plan-p.plan:R1-F001",
      ruling: "accepted",
      rationale: "Fixed",
    });

    const rebind = rec(4, "bind", { spec: "s.spec.md", plan: "p.plan.md" });
    assert.equal(
      stepHint({
        fold: makeFold(level, confirm, designBind, ruling, rebind),
        current: baseHashes,
        action: "ledger append",
        result: okResult({ seq: 4, deduped: false }),
      }),
      "Run review — help review run — review run p.plan.md --session <session> --host <platform> [--pins <pins>]"
    );

    // Approval or ruling with seq > at(-1).seq blocks Row 7
    const laterRuling = rec(5, "ruling", {
      subject: "review:plan-p.plan:R1-F001",
      ruling: "accepted",
      rationale: "Fixed",
    });

    assert.equal(
      stepHint({
        fold: makeFold(level, confirm, rebind, laterRuling),
        current: baseHashes,
        action: "ledger append",
        result: okResult({ seq: 4, deduped: false }),
      }),
      undefined
    );

    // Seeded increment session: bind + level + confirm (or status show) yields undefined
    const seededBind = rec(1, "bind", {
      spec: "s.spec.md",
      design: "d.design.md",
    });

    const seededLevel = rec(2, "level", { level: "medium" });

    const seededConfirm = rec(
      3,
      "confirm",
      { spec: SPEC_HASH },
      "user",
      "Confirmed"
    );

    assert.equal(
      stepHint({
        fold: makeFold(seededBind, seededLevel, seededConfirm),
        current: designHashes,
        action: "ledger append",
        result: okResult({ seq: 3, deduped: false }),
      }),
      undefined
    );
    assert.equal(
      stepHint({
        fold: makeFold(seededBind, seededLevel, seededConfirm),
        current: designHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );
  });

  test("rows 8-13 handle gate, baseline check, closed, pending, delivery -> report complete -> cleanup -> committed", () => {
    const planBind = rec(1, "bind", { spec: "s.spec.md", plan: "p.plan.md" });

    const designBind = rec(1, "bind", {
      spec: "s.spec.md",
      design: "d.design.md",
    });

    const confirm = rec(2, "confirm", { spec: SPEC_HASH }, "user", "Confirmed");

    const approval = rec(
      3,
      "approval",
      { spec: SPEC_HASH, plan: PLAN_HASH },
      "user",
      "Approved"
    );

    const designApproval = rec(
      3,
      "approval",
      { spec: SPEC_HASH, design: DESIGN_HASH },
      "user",
      "Approved"
    );

    // Row 8: unapproved or unrecorded change
    assert.equal(
      stepHint({
        fold: makeFold(planBind, confirm),
        current: baseHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );
    assert.equal(
      stepHint({
        fold: makeFold(planBind, confirm, approval),
        current: { spec: SPEC_HASH, plan: `sha256:${"8".repeat(64)}` },
        action: "status show",
        result: okResult(),
      }),
      undefined
    );

    // Row 9: design-only approved -> undefined; approved plan before baseline check -> undefined
    assert.equal(
      stepHint({
        fold: makeFold(designBind, confirm, designApproval),
        current: designHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );
    assert.equal(
      stepHint({
        fold: makeFold(planBind, confirm, approval),
        current: baseHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );

    const opened = openedIntegrate(4);

    // Row 10: closed integration -> undefined
    const closed = rec(
      5,
      "integrate",
      { phase: "closed", reason: "done" },
      "tool"
    );

    assert.equal(
      stepHint({
        fold: makeFold(planBind, confirm, approval, opened, closed),
        current: baseHashes,
        action: "report complete",
        result: okResult(),
      }),
      undefined
    );

    // Row 11: pending conflict beats finished candidate
    const launched = rec(
      5,
      "writer",
      {
        phase: "launched",
        task: "T1",
        path: ".state/worktrees/T1-1",
        base: { commit: COMMIT_A, taskSection: TASK_HASH, seq: 4 },
      },
      "tool"
    );

    const finished = rec(
      6,
      "writer",
      { phase: "finished", task: "T1", launch: 1, candidate: COMMIT_B },
      "tool"
    );

    const startedT2 = rec(
      7,
      "integrate",
      { phase: "started", task: "T2", candidate: COMMIT_C },
      "tool"
    );

    const conflictT2 = rec(
      8,
      "integrate",
      { phase: "conflict", task: "T2", paths: ["src/b.ts"] },
      "tool"
    );

    assert.equal(
      stepHint({
        fold: makeFold(
          planBind,
          confirm,
          approval,
          opened,
          launched,
          finished,
          startedT2,
          conflictT2
        ),
        current: baseHashes,
        action: "worktree submit",
        result: okResult(),
      }),
      undefined
    );

    // Row 12 -> Row 13 -> cleanup -> committed -> status show sequence
    const delivered = rec(
      5,
      "integrate",
      {
        phase: "delivered",
        mode: "uncommitted",
        dest: { path: "/repo", branch: "main" },
        from: COMMIT_A,
        source: COMMIT_B,
      },
      "tool"
    );

    assert.equal(
      stepHint({
        fold: makeFold(planBind, confirm, approval, opened, delivered),
        current: baseHashes,
        action: "worktree deliver",
        result: okResult(),
      }),
      "Complete walkthrough report — help report complete — report complete --session <session>"
    );
    assert.equal(
      stepHint({
        fold: makeFold(planBind, confirm, approval, opened, delivered),
        current: baseHashes,
        action: "report complete",
        result: okResult(),
      }),
      "Clean up worktrees — help worktree cleanup — worktree cleanup --session <session>"
    );
    assert.equal(
      stepHint({
        fold: makeFold(planBind, confirm, approval, opened, delivered),
        current: baseHashes,
        action: "status show",
        result: okResult(),
      }),
      undefined
    );

    // Committed delivery: Row 12 MUST NOT fire; Row 13 still fires on report complete
    const committed = rec(
      6,
      "integrate",
      { phase: "committed", commit: COMMIT_C, source: COMMIT_B },
      "tool"
    );

    assert.equal(
      stepHint({
        fold: makeFold(
          planBind,
          confirm,
          approval,
          opened,
          delivered,
          committed
        ),
        current: baseHashes,
        action: "worktree deliver",
        result: okResult(),
      }),
      undefined
    );
    assert.equal(
      stepHint({
        fold: makeFold(
          planBind,
          confirm,
          approval,
          opened,
          delivered,
          committed
        ),
        current: baseHashes,
        action: "report complete",
        result: okResult(),
      }),
      "Clean up worktrees — help worktree cleanup — worktree cleanup --session <session>"
    );
  });

  test("row 14 covers candidates, tie-breaking, unchecked done, staleness with or without edit, shared-context plan edits, superseded/abandoned launches, and default omissions", async () => {
    const f = sessionFixture({ memory: true });

    try {
      f.artifact("s.spec.md", SPEC_SOURCE);
      f.artifact("p.plan.md", PLAN_SOURCE);
      const manifest = readManifest(f.session);
      await appendRecord(
        f.session,
        {
          kind: "bind",
          by: "orchestrator",
          key: "bind",
          data: { spec: "s.spec.md", plan: "p.plan.md" },
        },
        f.deps
      );

      const hashes = currentHashes(f.root, {
        spec: "s.spec.md",
        plan: "p.plan.md",
      });

      await appendRecord(
        f.session,
        {
          kind: "confirm",
          by: "user",
          key: "confirm",
          quote: "Confirmed",
          data: { spec: hashes.spec },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "approval",
          by: "user",
          key: "approval",
          quote: "Approved",
          data: hashes,
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "level",
          by: "orchestrator",
          key: "level",
          data: { level: "low" },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "opened",
          data: {
            phase: "opened",
            path: ".state/worktrees/integration",
            branch: "dispatch/test/integration",
            base: COMMIT_A,
            dest: { path: f.root, branch: "main" },
          },
        },
        f.deps
      );

      // Failed baseline check and opened integration without candidates omit hints (Row 15 default)
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "check run",
          result: { ok: false, reason: "checks-failed", value: {} },
          session: f.session,
          manifest,
        }),
        undefined
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "check run",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Active launch -> undefined
      const loadedPlan = loadPlan(f.session, manifest);
      const planChecks = checks(loadedPlan);

      const digestFor = (criterion: string) =>
        defined(planChecks.find((row) => row.criterion === criterion))
          .commandDigest;

      const t1Section = taskSection(loadedPlan, "T1");
      const t2Section = taskSection(loadedPlan, "T2");
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t1-launch-1",
          data: {
            phase: "launched",
            task: "T1",
            path: ".state/worktrees/T1-1",
            base: {
              commit: COMMIT_A,
              taskSection: t1Section,
              seq: foldLedger(f.session).lastSeq,
            },
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "brief render",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Superseded launch followed by active launch -> undefined
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t1-launch-2",
          data: {
            phase: "launched",
            task: "T1",
            path: ".state/worktrees/T1-2",
            base: {
              commit: COMMIT_A,
              taskSection: t1Section,
              seq: foldLedger(f.session).lastSeq,
            },
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "status show",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Two non-stale candidates -> picks lowest finished.seq (T2 finished before T1)
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t2-launch-1",
          data: {
            phase: "launched",
            task: "T2",
            path: ".state/worktrees/T2-1",
            base: {
              commit: COMMIT_A,
              taskSection: t2Section,
              seq: foldLedger(f.session).lastSeq,
            },
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t2-fin-1",
          data: {
            phase: "finished",
            task: "T2",
            launch: 1,
            candidate: COMMIT_C,
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t1-fin-2",
          data: {
            phase: "finished",
            task: "T1",
            launch: 2,
            candidate: COMMIT_B,
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "worktree submit",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        "Integrate T2 — help worktree integrate — worktree integrate T2 --session <session>"
      );

      // Integrate T2 without later passing clean evidence for T2's SC2 omits T1 integrate hint
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "int-t2-done",
          data: { phase: "done", task: "T2", commit: COMMIT_C },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "worktree integrate",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Once passing clean non-mutating evidence for SC2 is recorded after T2 integration, check run on COMMIT_C emits T1 candidate hint
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          by: "tool",
          key: "ev-t2",
          data: {
            criterion: "SC2",
            commandDigest: digestFor("SC2"),
            tree: COMMIT_C,
            clean: true,
            before: COMMIT_C,
            after: COMMIT_C,
            exit: 0,
            path: ".state/evidence/sc2.json",
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "check run",
          result: checkResult(COMMIT_C),
          session: f.session,
          manifest,
        }),
        "Integrate T1 — help worktree integrate — worktree integrate T1 --session <session>"
      );

      // Verify done T1 requires action === 'check run' and passing clean non-mutating evidence on the live check tree before suggesting Integrate T2
      const fDone = sessionFixture({ memory: true });

      try {
        fDone.artifact("s.spec.md", SPEC_SOURCE);
        fDone.artifact("p.plan.md", PLAN_SOURCE);
        const mDone = readManifest(fDone.session);
        await appendRecord(
          fDone.session,
          {
            kind: "bind",
            by: "orchestrator",
            key: "bind",
            data: { spec: "s.spec.md", plan: "p.plan.md" },
          },
          fDone.deps
        );

        const hDone = currentHashes(fDone.root, {
          spec: "s.spec.md",
          plan: "p.plan.md",
        });

        await appendRecord(
          fDone.session,
          {
            kind: "confirm",
            by: "user",
            key: "confirm",
            quote: "Confirmed",
            data: { spec: hDone.spec },
          },
          fDone.deps
        );
        await appendRecord(
          fDone.session,
          {
            kind: "approval",
            by: "user",
            key: "approval",
            quote: "Approved",
            data: hDone,
          },
          fDone.deps
        );
        await appendRecord(
          fDone.session,
          {
            kind: "integrate",
            by: "tool",
            key: "opened",
            data: {
              phase: "opened",
              path: ".state/worktrees/integration",
              branch: "dispatch/test/integration",
              base: COMMIT_A,
              dest: { path: fDone.root, branch: "main" },
            },
          },
          fDone.deps
        );
        await appendRecord(
          fDone.session,
          {
            kind: "writer",
            by: "tool",
            key: "w-t1-l",
            data: {
              phase: "launched",
              task: "T1",
              path: ".state/worktrees/T1-1",
              base: { commit: COMMIT_A, taskSection: t1Section, seq: 4 },
            },
          },
          fDone.deps
        );
        await appendRecord(
          fDone.session,
          {
            kind: "writer",
            by: "tool",
            key: "w-t1-f",
            data: {
              phase: "finished",
              task: "T1",
              launch: 1,
              candidate: COMMIT_B,
            },
          },
          fDone.deps
        );
        await appendRecord(
          fDone.session,
          {
            kind: "writer",
            by: "tool",
            key: "w-t2-l",
            data: {
              phase: "launched",
              task: "T2",
              path: ".state/worktrees/T2-1",
              base: { commit: COMMIT_A, taskSection: t2Section, seq: 4 },
            },
          },
          fDone.deps
        );
        await appendRecord(
          fDone.session,
          {
            kind: "writer",
            by: "tool",
            key: "w-t2-f",
            data: {
              phase: "finished",
              task: "T2",
              launch: 1,
              candidate: COMMIT_C,
            },
          },
          fDone.deps
        );
        await appendRecord(
          fDone.session,
          {
            kind: "integrate",
            by: "tool",
            key: "done-t1",
            data: { phase: "done", task: "T1", commit: COMMIT_B },
          },
          fDone.deps
        );

        const baseFold = foldLedger(fDone.session);

        const withEvidence = (criterion: string, extra: JsonObject) => ({
          ...baseFold,
          lastSeq: baseFold.lastSeq + 1,
          records: [
            ...baseFold.records,
            rec(
              baseFold.lastSeq + 1,
              "evidence",
              {
                criterion,
                commandDigest: digestFor(criterion),
                tree: COMMIT_B,
                clean: true,
                before: COMMIT_B,
                after: COMMIT_B,
                exit: 0,
                path: ".state/evidence/ev.json",
                ...extra,
              },
              "tool"
            ),
          ],
        });

        assert.equal(
          stepHint({
            fold: withEvidence("SC1", { exit: 1 }),
            current: hDone,
            action: "check run",
            result: checkResult(COMMIT_B),
            session: fDone.session,
            manifest: mDone,
          }),
          undefined
        );
        assert.equal(
          stepHint({
            fold: withEvidence("SC1", { clean: false }),
            current: hDone,
            action: "check run",
            result: checkResult(COMMIT_B),
            session: fDone.session,
            manifest: mDone,
          }),
          undefined
        );
        assert.equal(
          stepHint({
            fold: withEvidence("SC1", { after: COMMIT_C }),
            current: hDone,
            action: "check run",
            result: checkResult(COMMIT_B),
            session: fDone.session,
            manifest: mDone,
          }),
          undefined
        );
        assert.equal(
          stepHint({
            fold: withEvidence("SC2", {}),
            current: hDone,
            action: "check run",
            result: checkResult(COMMIT_B),
            session: fDone.session,
            manifest: mDone,
          }),
          undefined
        );
        // Non-check-run action omits even when evidence is on COMMIT_B
        assert.equal(
          stepHint({
            fold: withEvidence("SC1", {}),
            current: hDone,
            action: "status show",
            result: okResult(),
            session: fDone.session,
            manifest: mDone,
          }),
          undefined
        );
        // Newer live check tree COMMIT_C omits when SC1 evidence is still on COMMIT_B
        assert.equal(
          stepHint({
            fold: withEvidence("SC1", {}),
            current: hDone,
            action: "check run",
            result: checkResult(COMMIT_C),
            session: fDone.session,
            manifest: mDone,
          }),
          undefined
        );
        // Unclean live check result omits
        assert.equal(
          stepHint({
            fold: withEvidence("SC1", {}),
            current: hDone,
            action: "check run",
            result: checkResult(COMMIT_B, { clean: false }),
            session: fDone.session,
            manifest: mDone,
          }),
          undefined
        );
        // Matching live check run on COMMIT_B emits Integrate T2
        assert.equal(
          stepHint({
            fold: withEvidence("SC1", {}),
            current: hDone,
            action: "check run",
            result: checkResult(COMMIT_B),
            session: fDone.session,
            manifest: mDone,
          }),
          "Integrate T2 — help worktree integrate — worktree integrate T2 --session <session>"
        );
      } finally {
        fDone.cleanup();
      }

      // Changed task section on disk with no later edit record -> stale -> undefined
      f.artifact(
        "p.plan.md",
        PLAN_SOURCE.replace(
          "- Purpose: implement A.",
          "- Purpose: implement updated A."
        )
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "status show",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Shared-context plan edit not naming the candidate task still suppresses Row 14
      f.artifact("p.plan.md", PLAN_SOURCE);
      await appendRecord(
        f.session,
        {
          kind: "edit",
          by: "orchestrator",
          key: "edit-shared",
          data: {
            artifact: "plan",
            before: hashes.plan,
            after: hashes.plan,
            class: "non-intent",
            affects: [],
            rationale: "Clarify shared context",
            diffRef: "d0",
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "status show",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Restore plan, then record plan edit affecting T1 -> stale -> undefined!
      await appendRecord(
        f.session,
        {
          kind: "edit",
          by: "orchestrator",
          key: "edit-t1",
          data: {
            artifact: "plan",
            before: hashes.plan,
            after: hashes.plan,
            class: "non-intent",
            affects: ["T1"],
            rationale: "Update T1",
            diffRef: "d",
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "status show",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Unreadable plan when checking staleness -> fail-open omits (undefined)
      fs.rmSync(path.join(f.root, "p.plan.md"));
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: { spec: defined(hashes.spec), plan: null },
          action: "status show",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Passing checks after all tasks integrated -> undefined
      f.artifact("p.plan.md", PLAN_SOURCE);
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "int-t1-done",
          data: { phase: "done", task: "T1", commit: COMMIT_B },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: currentHashes(f.root, {
            spec: "s.spec.md",
            plan: "p.plan.md",
          }),
          action: "check run",
          result: okResult(),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Abandoned writer -> undefined
      const f2 = sessionFixture({ memory: true });

      try {
        f2.artifact("s.spec.md", SPEC_SOURCE);
        f2.artifact("p.plan.md", PLAN_SOURCE);
        await appendRecord(
          f2.session,
          {
            kind: "bind",
            by: "orchestrator",
            key: "bind",
            data: { spec: "s.spec.md", plan: "p.plan.md" },
          },
          f2.deps
        );

        const h2 = currentHashes(f2.root, {
          spec: "s.spec.md",
          plan: "p.plan.md",
        });

        await appendRecord(
          f2.session,
          {
            kind: "confirm",
            by: "user",
            key: "confirm",
            quote: "Confirmed",
            data: { spec: h2.spec },
          },
          f2.deps
        );
        await appendRecord(
          f2.session,
          {
            kind: "approval",
            by: "user",
            key: "approval",
            quote: "Approved",
            data: h2,
          },
          f2.deps
        );
        await appendRecord(
          f2.session,
          {
            kind: "integrate",
            by: "tool",
            key: "opened",
            data: {
              phase: "opened",
              path: ".state/worktrees/integration",
              branch: "dispatch/test/integration",
              base: COMMIT_A,
              dest: { path: f2.root, branch: "main" },
            },
          },
          f2.deps
        );
        await appendRecord(
          f2.session,
          {
            kind: "writer",
            by: "tool",
            key: "w1",
            data: {
              phase: "launched",
              task: "T1",
              path: ".state/worktrees/T1-1",
              base: { commit: COMMIT_A, taskSection: t1Section, seq: 4 },
            },
          },
          f2.deps
        );
        await appendRecord(
          f2.session,
          {
            kind: "writer",
            by: "tool",
            key: "w2",
            data: {
              phase: "abandoned",
              task: "T1",
              launch: 1,
              reason: "stuck",
            },
          },
          f2.deps
        );
        assert.equal(
          stepHint({
            fold: foldLedger(f2.session),
            current: h2,
            action: "worktree abandon",
            result: okResult(),
            session: f2.session,
            manifest: readManifest(f2.session),
          }),
          undefined
        );
      } finally {
        f2.cleanup();
      }
    } finally {
      f.cleanup();
    }
  });

  test("requires matching post-fix single-tree evidence for all automated criteria of a done task and allows review-only done tasks", async () => {
    const multiPlan = [
      "# Plan",
      "",
      "## Task Map",
      "| ID | Title | Outcome | Prerequisites | Criteria |",
      "| --- | --- | --- | --- | --- |",
      "| T1 | Task one | Works | none | SC1, SC2 |",
      "| T2 | Task two | Works | T1 | SC3 |",
      "",
      "## Proposed Changes",
      "### T1 — Task one",
      "#### [MODIFY] src/a.ts",
      "- Purpose: implement A.",
      "",
      "### T2 — Task two",
      "#### [MODIFY] src/b.ts",
      "- Purpose: implement B.",
      "",
      "## Success Criteria",
      "- [SC1] A check one",
      "  - Changes: src/a.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: check",
      "- [SC2] A check two",
      "  - Changes: src/a.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: check",
      "- [SC3] B check",
      "  - Changes: src/b.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: check",
      "",
      "## Verification Plan",
      "### Automated Tests",
      '- `node -e "process.exit(0)"`',
      "",
    ].join("\n");

    const f = sessionFixture({ memory: true });

    try {
      f.artifact("s.spec.md", SPEC_SOURCE);
      f.artifact("p.plan.md", multiPlan);
      const manifest = readManifest(f.session);
      await appendRecord(
        f.session,
        {
          kind: "bind",
          by: "orchestrator",
          key: "bind",
          data: { spec: "s.spec.md", plan: "p.plan.md" },
        },
        f.deps
      );

      const hashes = currentHashes(f.root, {
        spec: "s.spec.md",
        plan: "p.plan.md",
      });

      await appendRecord(
        f.session,
        {
          kind: "confirm",
          by: "user",
          key: "confirm",
          quote: "Confirmed",
          data: { spec: hashes.spec },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "approval",
          by: "user",
          key: "approval",
          quote: "Approved",
          data: hashes,
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "level",
          by: "orchestrator",
          key: "level",
          data: { level: "low" },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "opened",
          data: {
            phase: "opened",
            path: ".state/worktrees/integration",
            branch: "dispatch/test/integration",
            base: COMMIT_A,
            dest: { path: f.root, branch: "main" },
          },
        },
        f.deps
      );

      const loaded = loadPlan(f.session, manifest);
      const planChecks = checks(loaded);

      const digest = (id: string) =>
        defined(planChecks.find((row) => row.criterion === id)).commandDigest;

      const t1Sec = taskSection(loaded, "T1");
      const t2Sec = taskSection(loaded, "T2");
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t1-l",
          data: {
            phase: "launched",
            task: "T1",
            path: ".state/worktrees/T1-1",
            base: { commit: COMMIT_A, taskSection: t1Sec, seq: 5 },
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t1-f",
          data: {
            phase: "finished",
            task: "T1",
            launch: 1,
            candidate: COMMIT_B,
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t2-l",
          data: {
            phase: "launched",
            task: "T2",
            path: ".state/worktrees/T2-1",
            base: { commit: COMMIT_A, taskSection: t2Sec, seq: 5 },
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t2-f",
          data: {
            phase: "finished",
            task: "T2",
            launch: 1,
            candidate: COMMIT_C,
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "done-t1",
          data: { phase: "done", task: "T1", commit: COMMIT_B },
        },
        f.deps
      );

      // Multi-criterion done task with one criterion passing and the other missing -> undefined
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          by: "tool",
          key: "ev-sc1-only",
          data: {
            criterion: "SC1",
            commandDigest: digest("SC1"),
            tree: COMMIT_B,
            clean: true,
            before: COMMIT_B,
            after: COMMIT_B,
            exit: 0,
            path: ".state/evidence/sc1.json",
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: hashes,
          action: "check run",
          result: checkResult(COMMIT_B),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Partial failure followed by repair fix record and subset rerun -> undefined (stale pre-fix SC1 and mismatched live tree)
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          by: "tool",
          key: "ev-sc2-fail",
          data: {
            criterion: "SC2",
            commandDigest: digest("SC2"),
            tree: COMMIT_B,
            clean: true,
            before: COMMIT_B,
            after: COMMIT_B,
            exit: 1,
            path: ".state/evidence/sc2-fail.json",
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "integrate",
          by: "tool",
          key: "fix-t1",
          data: {
            phase: "fix",
            commit: COMMIT_C,
            reason: "Repair check failure",
          },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          by: "tool",
          key: "ev-sc2-subset",
          data: {
            criterion: "SC2",
            commandDigest: digest("SC2"),
            tree: COMMIT_C,
            clean: true,
            before: COMMIT_C,
            after: COMMIT_C,
            exit: 0,
            path: ".state/evidence/sc2-pass.json",
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: hashes,
          action: "check run",
          result: checkResult(COMMIT_C),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Rerun SC1 on a different tree than SC2 -> undefined
      const treeD = "d".repeat(40);
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          by: "tool",
          key: "ev-sc1-diff-tree",
          data: {
            criterion: "SC1",
            commandDigest: digest("SC1"),
            tree: treeD,
            clean: true,
            before: treeD,
            after: treeD,
            exit: 0,
            path: ".state/evidence/sc1-d.json",
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: hashes,
          action: "check run",
          result: checkResult(treeD),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Rerun SC1 on the same post-fix tree as SC2 -> emits Integrate T2
      await appendRecord(
        f.session,
        {
          kind: "evidence",
          by: "tool",
          key: "ev-sc1-same-tree",
          data: {
            criterion: "SC1",
            commandDigest: digest("SC1"),
            tree: COMMIT_C,
            clean: true,
            before: COMMIT_C,
            after: COMMIT_C,
            exit: 0,
            path: ".state/evidence/sc1-c.json",
          },
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: hashes,
          action: "check run",
          result: checkResult(COMMIT_C),
          session: f.session,
          manifest,
        }),
        "Integrate T2 — help worktree integrate — worktree integrate T2 --session <session>"
      );

      // worktree land carries the check run value under `check`, so it earns the same next-task hint
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: hashes,
          action: "worktree land",
          result: okResult({
            task: "T1",
            checks: { passed: 2 },
            check: checkResult(COMMIT_C).value,
          }),
          session: f.session,
          manifest,
        }),
        "Integrate T2 — help worktree integrate — worktree integrate T2 --session <session>"
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: hashes,
          action: "worktree land",
          result: okResult({
            task: "T1",
            check: checkResult(treeD).value,
          }),
          session: f.session,
          manifest,
        }),
        undefined
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: hashes,
          action: "worktree land",
          result: okResult({ task: "T1", checks: { passed: 2 } }),
          session: f.session,
          manifest,
        }),
        undefined
      );

      // Discriminating post-fix seq test: both pass on COMMIT_B before fix, then check run on COMMIT_B without post-fix evidence yields undefined until both rerun after fix
      const fPostFix = sessionFixture({ memory: true });

      try {
        fPostFix.artifact("s.spec.md", SPEC_SOURCE);
        fPostFix.artifact("p.plan.md", multiPlan);
        const mPF = readManifest(fPostFix.session);
        await appendRecord(
          fPostFix.session,
          {
            kind: "bind",
            by: "orchestrator",
            key: "bind",
            data: { spec: "s.spec.md", plan: "p.plan.md" },
          },
          fPostFix.deps
        );

        const hPF = currentHashes(fPostFix.root, {
          spec: "s.spec.md",
          plan: "p.plan.md",
        });

        await appendRecord(
          fPostFix.session,
          {
            kind: "confirm",
            by: "user",
            key: "confirm",
            quote: "Confirmed",
            data: { spec: hPF.spec },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "approval",
            by: "user",
            key: "approval",
            quote: "Approved",
            data: hPF,
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "integrate",
            by: "tool",
            key: "opened",
            data: {
              phase: "opened",
              path: ".state/worktrees/integration",
              branch: "dispatch/test/integration",
              base: COMMIT_A,
              dest: { path: fPostFix.root, branch: "main" },
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "writer",
            by: "tool",
            key: "w1l",
            data: {
              phase: "launched",
              task: "T1",
              path: ".state/worktrees/T1-1",
              base: { commit: COMMIT_A, taskSection: t1Sec, seq: 4 },
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "writer",
            by: "tool",
            key: "w1f",
            data: {
              phase: "finished",
              task: "T1",
              launch: 1,
              candidate: COMMIT_B,
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "writer",
            by: "tool",
            key: "w2l",
            data: {
              phase: "launched",
              task: "T2",
              path: ".state/worktrees/T2-1",
              base: { commit: COMMIT_A, taskSection: t2Sec, seq: 4 },
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "writer",
            by: "tool",
            key: "w2f",
            data: {
              phase: "finished",
              task: "T2",
              launch: 1,
              candidate: COMMIT_C,
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "integrate",
            by: "tool",
            key: "done-t1",
            data: { phase: "done", task: "T1", commit: COMMIT_B },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "evidence",
            by: "tool",
            key: "pre-sc1",
            data: {
              criterion: "SC1",
              commandDigest: digest("SC1"),
              tree: COMMIT_B,
              clean: true,
              before: COMMIT_B,
              after: COMMIT_B,
              exit: 0,
              path: ".state/evidence/pre1.json",
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "evidence",
            by: "tool",
            key: "pre-sc2",
            data: {
              criterion: "SC2",
              commandDigest: digest("SC2"),
              tree: COMMIT_B,
              clean: true,
              before: COMMIT_B,
              after: COMMIT_B,
              exit: 0,
              path: ".state/evidence/pre2.json",
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "integrate",
            by: "tool",
            key: "fix-after-pass",
            data: { phase: "fix", commit: COMMIT_B, reason: "Post-pass fix" },
          },
          fPostFix.deps
        );

        // Pre-fix evidence on COMMIT_B is rejected purely by ev.seq > minSeq
        assert.equal(
          stepHint({
            fold: foldLedger(fPostFix.session),
            current: hPF,
            action: "check run",
            result: checkResult(COMMIT_B),
            session: fPostFix.session,
            manifest: mPF,
          }),
          undefined
        );

        await appendRecord(
          fPostFix.session,
          {
            kind: "evidence",
            by: "tool",
            key: "post-sc1",
            data: {
              criterion: "SC1",
              commandDigest: digest("SC1"),
              tree: COMMIT_B,
              clean: true,
              before: COMMIT_B,
              after: COMMIT_B,
              exit: 0,
              path: ".state/evidence/post1.json",
            },
          },
          fPostFix.deps
        );
        await appendRecord(
          fPostFix.session,
          {
            kind: "evidence",
            by: "tool",
            key: "post-sc2",
            data: {
              criterion: "SC2",
              commandDigest: digest("SC2"),
              tree: COMMIT_B,
              clean: true,
              before: COMMIT_B,
              after: COMMIT_B,
              exit: 0,
              path: ".state/evidence/post2.json",
            },
          },
          fPostFix.deps
        );
        assert.equal(
          stepHint({
            fold: foldLedger(fPostFix.session),
            current: hPF,
            action: "check run",
            result: checkResult(COMMIT_B),
            session: fPostFix.session,
            manifest: mPF,
          }),
          "Integrate T2 — help worktree integrate — worktree integrate T2 --session <session>"
        );
      } finally {
        fPostFix.cleanup();
      }

      // Stale commandDigest after Check command edit on disk (plan re-approved so Row 8 gate passes and only commandDigest causes omission) -> undefined
      f.artifact(
        "p.plan.md",
        multiPlan.replace(
          '- [SC1] A check one\n  - Changes: src/a.ts\n  - Check: `node -e "process.exit(0)"`',
          '- [SC1] A check one\n  - Changes: src/a.ts\n  - Check: `node -e "process.exit(0)" -- --updated`'
        )
      );

      const updatedHashes = currentHashes(f.root, {
        spec: "s.spec.md",
        plan: "p.plan.md",
      });

      await appendRecord(
        f.session,
        {
          kind: "approval",
          by: "user",
          key: "reapprove-check",
          quote: "Approved updated check",
          data: updatedHashes,
        },
        f.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(f.session),
          current: updatedHashes,
          action: "check run",
          result: checkResult(COMMIT_C),
          session: f.session,
          manifest,
        }),
        undefined
      );
    } finally {
      f.cleanup();
    }

    // Review-only done task (zero automated criteria) vacuously passes verification check and emits Integrate T2
    const reviewOnlyPlan = [
      "# Plan",
      "",
      "## Task Map",
      "| ID | Title | Outcome | Prerequisites | Criteria |",
      "| --- | --- | --- | --- | --- |",
      "| T1 | Docs | Reviewed | none | SC1 |",
      "| T2 | Code | Works | T1 | SC2 |",
      "",
      "## Proposed Changes",
      "### T1 — Docs",
      "#### [MODIFY] src/a.ts",
      "- Purpose: update docs.",
      "",
      "### T2 — Code",
      "#### [MODIFY] src/b.ts",
      "- Purpose: implement B.",
      "",
      "## Success Criteria",
      "- [SC1] Docs reviewed",
      "  - Changes: src/a.ts",
      "  - Evidence: review",
      "- [SC2] B works",
      "  - Changes: src/b.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: check",
      "",
      "## Verification Plan",
      "### Automated Tests",
      '- `node -e "process.exit(0)"`',
      "",
    ].join("\n");

    const fRev = sessionFixture({ memory: true });

    try {
      fRev.artifact("s.spec.md", SPEC_SOURCE);
      fRev.artifact("p.plan.md", reviewOnlyPlan);
      const mRev = readManifest(fRev.session);
      await appendRecord(
        fRev.session,
        {
          kind: "bind",
          by: "orchestrator",
          key: "bind",
          data: { spec: "s.spec.md", plan: "p.plan.md" },
        },
        fRev.deps
      );

      const hRev = currentHashes(fRev.root, {
        spec: "s.spec.md",
        plan: "p.plan.md",
      });

      await appendRecord(
        fRev.session,
        {
          kind: "confirm",
          by: "user",
          key: "confirm",
          quote: "Confirmed",
          data: { spec: hRev.spec },
        },
        fRev.deps
      );
      await appendRecord(
        fRev.session,
        {
          kind: "approval",
          by: "user",
          key: "approval",
          quote: "Approved",
          data: hRev,
        },
        fRev.deps
      );
      await appendRecord(
        fRev.session,
        {
          kind: "integrate",
          by: "tool",
          key: "opened",
          data: {
            phase: "opened",
            path: ".state/worktrees/integration",
            branch: "dispatch/test/integration",
            base: COMMIT_A,
            dest: { path: fRev.root, branch: "main" },
          },
        },
        fRev.deps
      );
      const pRev = loadPlan(fRev.session, mRev);
      await appendRecord(
        fRev.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t1-l",
          data: {
            phase: "launched",
            task: "T1",
            path: ".state/worktrees/T1-1",
            base: {
              commit: COMMIT_A,
              taskSection: taskSection(pRev, "T1"),
              seq: 4,
            },
          },
        },
        fRev.deps
      );
      await appendRecord(
        fRev.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t1-f",
          data: {
            phase: "finished",
            task: "T1",
            launch: 1,
            candidate: COMMIT_B,
          },
        },
        fRev.deps
      );
      await appendRecord(
        fRev.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t2-l",
          data: {
            phase: "launched",
            task: "T2",
            path: ".state/worktrees/T2-1",
            base: {
              commit: COMMIT_A,
              taskSection: taskSection(pRev, "T2"),
              seq: 4,
            },
          },
        },
        fRev.deps
      );
      await appendRecord(
        fRev.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-t2-f",
          data: {
            phase: "finished",
            task: "T2",
            launch: 1,
            candidate: COMMIT_C,
          },
        },
        fRev.deps
      );
      await appendRecord(
        fRev.session,
        {
          kind: "integrate",
          by: "tool",
          key: "done-t1",
          data: { phase: "done", task: "T1", commit: COMMIT_B },
        },
        fRev.deps
      );
      assert.equal(
        stepHint({
          fold: foldLedger(fRev.session),
          current: hRev,
          action: "worktree integrate",
          result: okResult(),
          session: fRev.session,
          manifest: mRev,
        }),
        "Integrate T2 — help worktree integrate — worktree integrate T2 --session <session>"
      );
    } finally {
      fRev.cleanup();
    }
  });

  test("caps hints at 240 UTF-8 single-line bytes, isolates router errors, preserves lazy doctor --level on corrupt ledger, and measures 500-record latency", async (t) => {
    const longTask = `T${"1".repeat(220)}`;
    const fCap = sessionFixture({ memory: true });

    try {
      fCap.artifact("s.spec.md", SPEC_SOURCE);
      const longPlan = PLAN_SOURCE.replaceAll("T1", longTask);
      fCap.artifact("p.plan.md", longPlan);
      const capManifest = readManifest(fCap.session);
      await appendRecord(
        fCap.session,
        {
          kind: "bind",
          by: "orchestrator",
          key: "bind",
          data: { spec: "s.spec.md", plan: "p.plan.md" },
        },
        fCap.deps
      );

      const capHashes = currentHashes(fCap.root, {
        spec: "s.spec.md",
        plan: "p.plan.md",
      });

      await appendRecord(
        fCap.session,
        {
          kind: "confirm",
          by: "user",
          key: "confirm",
          quote: "Confirmed",
          data: { spec: capHashes.spec },
        },
        fCap.deps
      );
      await appendRecord(
        fCap.session,
        {
          kind: "approval",
          by: "user",
          key: "approval",
          quote: "Approved",
          data: capHashes,
        },
        fCap.deps
      );
      await appendRecord(
        fCap.session,
        {
          kind: "integrate",
          by: "tool",
          key: "opened",
          data: {
            phase: "opened",
            path: ".state/worktrees/integration",
            branch: "dispatch/test/integration",
            base: COMMIT_A,
            dest: { path: fCap.root, branch: "main" },
          },
        },
        fCap.deps
      );

      const longSection = taskSection(
        loadPlan(fCap.session, capManifest),
        longTask
      );

      await appendRecord(
        fCap.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-long-1",
          data: {
            phase: "launched",
            task: longTask,
            path: ".state/worktrees/long-1",
            base: {
              commit: COMMIT_A,
              taskSection: longSection,
              seq: foldLedger(fCap.session).lastSeq,
            },
          },
        },
        fCap.deps
      );
      await appendRecord(
        fCap.session,
        {
          kind: "writer",
          by: "tool",
          key: "w-long-fin",
          data: {
            phase: "finished",
            task: longTask,
            launch: 1,
            candidate: COMMIT_B,
          },
        },
        fCap.deps
      );

      const clipped = stepHint({
        fold: foldLedger(fCap.session),
        current: capHashes,
        action: "worktree submit",
        result: okResult(),
        session: fCap.session,
        manifest: capManifest,
      });

      assert.ok((clipped ?? "").length > 0);
      assert.ok(Buffer.byteLength(defined(clipped), "utf-8") <= HINT_MAX_BYTES);
      assert.ok(!/[\r\n]/u.test(defined(clipped)));
    } finally {
      fCap.cleanup();
    }

    // Router envelope: ok:true excluded actions skip folding and omit hint; explicit --level doctor run succeeds on corrupt ledger; post-bind ledger append includes hint
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      fs.writeFileSync(path.join(skill, "SKILL.md"), "test");
      fs.writeFileSync(
        path.join(skill, "skill-hashes.json"),
        JSON.stringify(generateSkillHashes(skill))
      );
      fs.writeFileSync(
        path.join(skill, "config.jsonc"),
        JSON.stringify({
          "read-delegates": {
            codex: { targets: [{ low: { model: "reader" } }] },
          },
          "write-subagents": { codex: { medium: { model: "writer" } } },
          "utility-subagents": {
            codex: { model: "explorer", "context-limit": 300_000 },
          },
        })
      );

      // Successful review run via router (no handler-supplied reason -> router sets complete) omits hint
      assert.equal(isHintExcludedAction("review run"), true);
      assert.equal(isHintExcludedAction("status show"), false);
      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "review",
            "run",
            "worktree",
            "--session",
            f.session,
            "--host",
            "codex",
          ],
          {
            ...f.deps,
            // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
            handler: () =>
              Promise.resolve({
                ok: true,
                summary: "clean",
                value: { skipped: true },
                exit: 0,
              }),
          }
        ),
        0
      );
      assert.equal(f.output().reason, "complete");
      assert.equal("hint" in f.output(), false);

      // Post-bind ledger append after level selection emits hint
      f.artifact("s.spec.md", SPEC_SOURCE);
      f.artifact("p.plan.md", PLAN_SOURCE);

      const specHash = defined(
        currentHashes(f.root, { spec: "s.spec.md" }).spec
      );

      await appendRecord(
        f.session,
        {
          kind: "level",
          by: "orchestrator",
          key: "level",
          data: { level: "medium" },
        },
        f.deps
      );
      await appendRecord(
        f.session,
        {
          kind: "confirm",
          by: "user",
          key: "confirm",
          quote: "Confirmed",
          data: { spec: specHash },
        },
        f.deps
      );

      const bindFile = f.artifact(
        "bind.json",
        JSON.stringify({
          kind: "bind",
          by: "orchestrator",
          key: "bind-plan",
          data: { spec: "s.spec.md", plan: "p.plan.md" },
        })
      );

      f.lines.length = 0;
      assert.equal(
        await main(
          ["ledger", "append", bindFile, "--session", f.session],
          f.deps
        ),
        0
      );
      assert.equal(
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
        (f.output() as { hint?: string }).hint,
        "Run review — help review run — review run p.plan.md --session <session> --host <platform> [--pins <pins>]"
      );

      // Corrupt ledger + explicit --level on doctor run still succeeds (fail-open hint omission); excluded actions also omit without folding
      fs.writeFileSync(
        path.join(f.session, "ledger.jsonl"),
        '{"broken": true\n{"more":"broken"\n'
      );
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
            "medium",
          ],
          {
            ...f.deps,
            skillRoot: skill,
          }
        ),
        0
      );
      assert.equal(f.output().ok, true);
      assert.equal("hint" in f.output(), false);

      // Measure and report 500-record fold + currentHashes + stepHint latency
      const f500 = sessionFixture({ memory: true });

      try {
        f500.artifact("s.spec.md", SPEC_SOURCE);
        f500.artifact("p.plan.md", PLAN_SOURCE);

        const h500 = currentHashes(f500.root, {
          spec: "s.spec.md",
          plan: "p.plan.md",
        });

        const rows = [
          rec(1, "bind", { spec: "s.spec.md", plan: "p.plan.md" }),
          rec(2, "confirm", { spec: h500.spec }, "user", "Confirmed"),
          rec(3, "approval", h500, "user", "Approved"),
          openedIntegrate(4),
          ...Array.from({ length: 496 }, (_, index) =>
            rec(index + 5, "note", { text: `note ${index}` })
          ),
        ];

        fs.writeFileSync(
          path.join(f500.session, "ledger.jsonl"),
          `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
        );
        const manifest500 = readManifest(f500.session);
        const start = performance.now();
        const folded = foldLedger(f500.session);

        const current = currentHashes(
          f500.root,
          folded.records.find((row) => row.kind === "bind")
        );

        const derived = stepHint({
          fold: folded,
          current,
          action: "status show",
          result: okResult(),
          session: f500.session,
          manifest: manifest500,
        });

        const elapsedMs = performance.now() - start;
        assert.equal(folded.records.length, 500);
        assert.equal(derived, undefined);
        t.diagnostic(
          `500-record fold + currentHashes + stepHint latency: ${elapsedMs.toFixed(2)} ms`
        );
      } finally {
        f500.cleanup();
      }
    } finally {
      f.cleanup();
    }
  });
});
