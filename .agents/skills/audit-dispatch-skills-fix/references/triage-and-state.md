# Triage and report state

`status.mjs` reads `#### A-<n>:` in `## 3. Findings` and `#### O-<n>:` in `## 4. Opportunities`. Audit prose stays intact. All commands accept `--run <yyyy-mm-dd-hhmm|report-path>`; retain it so a newer audit cannot switch your run. `list` and `batch` are read-only and accept uninitialized reports. `init` validates before writing and preserves existing statuses and notes.

## Status and triage

`- **Status**: open | fixed | false-positive | decision | deferred` may carry ` — <note>`. Missing defect status defaults to open; missing opportunity status defaults to decision. Counts live under their respective section headings, prefixed `> Fix status:` and `> Opportunity status:`. A zero-defect section keeps `No defect findings.`; opportunities are independent of it.

| Triage ruling | Defect status | Opportunity status |
|---|---|---|
| accept | open | open, with explicit selection |
| reject | false-positive | deferred |
| decision | decision | decision |
| defer | deferred | deferred |

Write a JSON file using normal file tools, then:

```text
node <skill>/scripts/status.mjs triage A-5 --run <run> --from <triage.json>
```

The command writes `- **Triage**: <single-line JSON>` and derives the status. Example:

```json
{
  "ruling": "accept",
  "evidence": "Current revision frame drops parser defects; initial author frame retains them.",
  "impact": "The author needs an extra journal read to repair the revision.",
  "recommendation": "Retain code, line and message in the retry frame; verify replay.",
  "group": "revision-diagnostics",
  "priority": "medium",
  "affectedPaths": ["skills/dispatch/scripts/machines/design-revision.ts"],
  "dependsOn": [],
  "verification": ["A retry-frame test retains concrete diagnostics; replay emits the same frame."]
}
```

All rulings require nonblank `evidence`, `impact`, `recommendation` and distinct-string arrays `affectedPaths`, `dependsOn`, `verification`. Accepted items additionally require nonempty paths/checks, a kebab-case `group`, and `priority: high|medium|low`. Nonaccepted items can use empty group/priority/path/check values. Dependencies name existing A- or O-items and exclude self. Cycles are reported by `batch`.

For an accepted opportunity, add `"selection":{"by":"user","quote":"<actual instruction selecting this item or all opportunities>"}`. The quote can come from the invocation or earlier session instructions. Record benefit uncertainty in evidence/impact; priority ranks useful changes and does not assign defect severity. A `decision` record includes your recommendation and the missing selection or intent choice.

For a legacy note beginning `dispatched`, add `"legacyInspection":"<current-tree and artifact inspection; fix present or absent>"` before new work. Init preserves the note and infers no completed phase from it. If work is already present, verify it and recover its plan/review evidence through checkpoints; do not apply it again.

Use `list --kind defect|opportunity`, `--status <status>`, `--severity high,medium` (defects only), or `--full` for inspection. `set <id> <status> --note <text>` retains an old note when omitted. `set open` requires accepted triage; `set fixed` requires code-reviewed execution. Change other dispositions through triage so the reason remains explicit. Declined opportunities use deferred.

## Batches

`batch [--size N]` chooses one ready coherent group, default ceiling 4, maximum 25. Dependencies must be fixed or appear earlier in the same group. Defect severity ranks first, opportunity triage priority next, numeric ID breaks ties. Topological order overrides rank within a group. It reports cycles, oversized groups and unresolved external prerequisites instead of padding or silently splitting; independent groups can still proceed.

The host owns semantic grouping and authorization. The script validates metadata and graph constraints; it cannot infer whether two changes belong together or whether a supplied user quote selects the item. Inspect those claims.

## Execution checkpoints

```text
node <skill>/scripts/status.mjs progress A-5,O-2 --run <run> --from <progress.json>
```

Each member receives the same `- **Execution**: <single-line JSON>`. The command adds `members` from the ID argument. First checkpoint:

```json
{
  "batchId": "revision-diagnostics-1",
  "phase": "planned",
  "plan": ".scratch/dispatch-skills/<session>/revision-diagnostics.plan.md",
  "evidence": "The plan defines the accepted IDs, bounded paths and all criteria."
}
```

| Phase | Evidence to inspect | Added field |
|---|---|---|
| planned | Authored plan, exact membership and scope | plan |
| plan-reviewed | Completed Dispatch plan review and settled plan | planReview |
| implemented | Direct implementation, criterion coverage and passing Verify commands | implementation |
| code-reviewed | Completed Dispatch code review, adjudicated findings and post-fix verification | codeReview |

Fields are paths to evidence **files**, not directories. A plan's inline review section or a retained Dispatch frame/journal can provide planReview; a test/criterion evidence note supplies implementation; a code review report or terminal frame supplies codeReview. The nonblank `evidence` summary must describe actual results and limitations. Record unsupported claims as open concerns, not passes.

Advance one phase at a time or repeat the current phase. Retain batchId, membership and prior artifact paths; omitted prior fields are carried forward. Each referenced file must exist and resolve inside the repository root. Use forward-slash repository-relative paths without traversal. Planned members must equal the complete accepted open group and have settled dependencies. Batch IDs are not reused. Triage is frozen while Execution is active.

The helper validates schema, phase order, membership and file existence. The host verifies that linked reviews are complete, findings settled, commands passed, and evidence applies to the current files. An arbitrary existing file is not review proof.

If scope, selection or feasibility changes, record `phase: abandoned` with the same identity and a concrete reason. The helper releases unfinished members and retains the original membership, last record, links and abandonment reason in `- **Execution history**: <JSON array>` on every member. Fixed members keep their code-reviewed Execution and status; its membership narrows to the fixed subset so the remaining work can exit without erasing proof. Inspect the tree, re-triage unfinished items, and start a new batch ID; preserve completed work. Entirely fixed batches cannot be abandoned. Fixed items, including legacy records, cannot be re-triaged or reset through set; use a new audit item for new work. Historical terminal statuses remain readable without invented metadata.

Only one unfinished batch can be active. A first planned checkpoint is rejected while another batch needs resume; resolve or abandon that batch before starting independent work.

## Recovery

| Last recorded phase | Next action |
|---|---|
| No Execution | Inspect legacy dispatched notes and any work created before checkpointing; triage before planning |
| planned | Reattach the retained plan run or review that exact plan |
| plan-reviewed | Check for unrecorded edits/tests, then implement the settled plan directly |
| implemented | Review the actual batch changes; retain implementation and test evidence |
| code-reviewed | Check current artifacts and verification freshness, then mark verified members fixed |
| Abandoned history only | Inspect retained work and revised intent, then re-triage |

Record a failed command, incomplete review, unavailable provider or blocker in the status note/evidence artifact at the last completed phase. A failure does not advance the checkpoint. Dispatch's journal governs its own run recovery; the report governs which remediation phase remains. Reattach handles/runs before starting replacements. Concurrent-report-change errors require reloading and rechecking; rejected metadata commands leave the report unchanged.
