---
name: audit-dispatch-skills-fix
description: Triage and explain audit defects and opportunities, then deliver coherent batches through Dispatch planning and review with direct implementation.
disable-model-invocation: true
metadata:
  internal: true
---

# Audit Dispatch Skills Fix

Turn an `audit-dispatch-skills` report into verified changes. Recheck each claim against current source and governing intent. Keep **A-items** as defect claims and **O-items** as improvement hypotheses; selection never proves a benefit.

The report owns remediation state: per-item `Status`, `Triage`, and `Execution` lines, retained execution history, and separate counts in sections 3 and 4. Supporting plans, reviews and test logs provide evidence. `<skill>` means the directory holding this file. Read [triage and state](references/triage-and-state.md) before recording metadata, handling a rejected command, or recovering an interrupted batch.

Fix each batch through **Dispatch plan → Dispatch plan review → direct implementation → Dispatch code review**. Do not start Dispatch implement: a batch can modify that same implementation flow while it is active. Read the repository's `AGENTS.md` and the shipped `dispatch` contract and selected verb guides before using Dispatch. If Dispatch is unavailable, report the missing dependency and preserve the triage state.

## 1. Open and bound

```text
node <skill>/scripts/status.mjs init --run <run-or-report-path>
node <skill>/scripts/status.mjs list --run <run-or-report-path> --full
```

Use the user's report; without one, `init` selects the newest `.scratch/audits/<run>-audit.md`. Keep that identity on **every command**. Init preserves statuses, notes and metadata; new defects default to `open`, opportunities to `decision`. A zero-defect report can still have opportunities.

Confirm the objective, selected item IDs, constraints and verification scope from the request. Triage all items unless the user narrows scope. Opportunity implementation requires explicit selection, which can come from the invocation or an earlier user instruction selecting named items or all opportunities; retain that quote instead of asking again. Unselected opportunities still receive an assessment and recommendation.

**Done when:** the report identity and scope are known, counts match both sections, and existing batch records have been checked for resume.

## 2. Triage and explain

For each in-scope item, inspect current cited source, producer/consumer paths, relevant tests, counterevidence, and the governing outcome. A prior `dispatched` note requires inspecting the current tree and retained artifacts before repeat work. Reproductions must be bounded and relevant.

- **Defect:** confirm the actual failure and impact; reject a contradicted claim with the source or commit evidence.
- **Opportunity:** assess its hypothesis, benefit, cost, trade-offs and simplest useful change. Preserve `unmeasured` claims; define how the hypothesis will be checked. Use `decision` while selection or an intent choice remains unresolved; defer a declined or unsupported improvement with a reason.
- **Both:** resolve overlapping root causes, identify prerequisites, and define scoped paths, acceptance checks, priority and a coherent group. A dependency is settled only by verified `fixed` status; document duplicates in the recommendation rather than implement the same change twice.

Record the ruling and explanation with `triage <id> --from <json-file>` using the reference schema. Explain to the user, by ID, what is real, why it matters, what you recommend, and what evidence supports the ruling. Ask unresolved intent/trade-off questions together, with your recommendation; continue independent work while answers are pending. Update triage from actual answers.

**Done when:** every in-scope item has a recorded ruling, evidence, impact and recommendation; accepted items also have selection where required, bounded paths, dependencies and verification.

## 3. Form a coherent batch

```text
node <skill>/scripts/status.mjs batch --run <run-or-report-path>
```

The command selects one triaged group, with prerequisites first. Defects rank by severity; selected opportunities follow by declared triage priority. Size is a ceiling (default 4, `--size` up to 25), not a target. Group items by shared behavior, dependencies, paths and risk; same-file proximity alone does not establish coherence. Combine a selected opportunity with a defect only when they share one change and compatible verification.

Review the printed group against intent. Resolve cycles, oversized groups, missing prerequisites or inadequate scope by re-triaging before planning; report blocked items and proceed with independent ready groups. A `Resume` result sends you to the recorded phase, not a fresh batch.

Explain the IDs, shared outcome, ordering, risk and completion checks. Choose Dispatch level from its current criteria; do not use a fixed severity-to-level table.

**Done when:** the batch has one checkable outcome, complete dependencies and authorized scope, with no unresolved decision included.

## 4. Plan and review

Invoke `/dispatch <level> plan:` with the batch IDs and report path, triage rationale, selected opportunity quotes, scope, dependencies and acceptance checks. Follow Dispatch's run loop and retain the returned plan and run identity. Its plan flow includes plan review: inspect the completion evidence and final review resolutions; this satisfies the plan-review phase. If the plan lacks a completed review, run `/dispatch <level> review: <plan-path>` and settle it before edits.

Record `planned`, then `plan-reviewed` checkpoints through `progress <ids> --from <json-file>`, linking the plan and its review evidence. Inspect review findings against source and user decisions. Revised scope must remain within authorization; material intent choices go to the user. An invalid batch can be abandoned with its evidence preserved, then re-triaged.

**Done when:** the exact plan is settled and reviewed, findings are resolved or explicitly bounded, scope/criteria are concrete, and both checkpoints are in the report. Disclose `fixedUnreviewed` or missing provider coverage; require further review when it leaves acceptance uncertain.

## 5. Implement directly and review code

Implement the settled plan yourself in the host's normal editing loop. Use its scoped paths and task order. Run its RED checks before behavior changes or record justified exceptions; run plan Verify commands and required repository gates after edits. Preserve unrelated work. Stop before an unresolved scope or intent change; revise and review the plan when its governing outcome changes.

Save criterion-by-criterion evidence and test results, then record `implemented`. Invoke `/dispatch <level> review:` on the exact batch changes with the settled plan, intent and deviations as context. Isolate the target from unrelated changes. Adjudicate claims against source; apply accepted in-scope fixes directly and rerun affected checks. Start another code review when material fixes or coverage gaps require it. Review completion alone does not prove tests passed.

**Done when:** every plan criterion has post-change evidence, required gates pass, code review is complete with findings settled, and `code-reviewed` links the review plus current verification evidence. Unresolved failures remain open.

## 6. Record, resume and hand off

Set each verified member to `fixed` with a concrete outcome and evidence note. The helper requires accepted triage and a `code-reviewed` checkpoint. `fixed` on an opportunity means the selected change and checks completed; report measured benefit separately.

After interruption, read `Execution` and inspect its linked artifacts and current tree. Resume the same Dispatch plan/review run where active; after `implemented`, continue code review rather than repeat implementation. A write or test result lost before checkpointing must be inspected before retry. Abandon a stale batch with a reason before regrouping; retain its history and artifacts.

Loop while ready work remains. Hand off with the report and plan/review links, separate status counts for defects and opportunities, delivered behavior, verification and review coverage, unresolved decisions with recommendations, deferred items with what would settle them, and contradicted claims with evidence. Include the repository's edit-task handoff fields when files changed.

**Done when:** every in-scope item is fixed, rejected with evidence, deferred with a reason, or explicitly awaiting a named decision; no active batch or failed required gate is described as complete.
