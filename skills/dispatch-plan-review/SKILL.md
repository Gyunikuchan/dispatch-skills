---
name: dispatch-plan-review
description: Review an implementation plan through external agent CLIs before code is written, then adjudicate returned claims. Use on /dispatch-plan-review or when a plan needs a pre-implementation cross-agent review.
---

# dispatch-plan-review

The delegate's report is a **claim, not a verdict**. The orchestrator adjudicates every finding against the requirement and host repository rules before editing the plan or reporting to the user.

## Invocation

`dispatch`'s `references/alignment.md` § Invocation is the base grammar (`/dispatch-plan-review (<pins>) [<artifact path>] [<focus>]`); the artifact path here is always the plan.

## Process

### 1. Assemble context and dispatch

Determine the invocation mode first, per `dispatch`'s `references/alignment.md` § Invocation Modes: **orchestrated** when an orchestrating skill hands over a plan path plus a **targets** list (with `Review Scope` and `Tool Turn Budget`), **standalone** otherwise. Standalone resolves the plan below; orchestrated uses the handed-over path, skipping resolution.

Attach the plan file plus any user-specified files with `-f "<path>"` (forward slashes throughout). Resolve the plan in order:

1. **User- or orchestrator-supplied plan** when an explicit path is passed or an orchestrating skill hands one over.
2. **Otherwise**, run the resolver per `dispatch`'s `references/alignment.md` § Plan/Walkthrough Artifact Resolution (it derives the slug; add `--slug <kebab-slug>` only when the user names one or derivation fails):
   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs --kind plan
   ```
   `tier: native` or `scratch-existing` means an artifact already exists — attach it as-is, no authoring. `tier: scratch-new` means none exists: write the returned path following [references/plan-template.md](references/plan-template.md) before dispatching.

**Prompt**: fill [references/prompt-template.md](references/prompt-template.md) (its variable bullets say what each value holds; orchestrated mode takes `Review Scope` and `Tool Turn Budget` from the handover) via `dispatch`'s `fill-template.mjs` per `references/alignment.md` § Prompt Template Filling: `node <skills-dir>/dispatch/scripts/fill-template.mjs --skill <skills-dir>/dispatch-plan-review/references/prompt-template.md --vars <json file> --out <path>` (a JSON vars file carries multi-line values such as `<Requirement>`), then `dispatch --prompt-file <out>`.

**Dispatch**: orchestrated — build one invocation per handed-over target per `dispatch`'s `references/alignment.md` § Invocation Modes; standalone — one per pin, or one cascade dispatch without pins, per § Invocation. Launch every invocation backgrounded and yield the turn; see `dispatch` for cascade, flags, and log monitoring. Dispatch runs structurally read-only.

**Done when:** the plan is resolved (or authored), attached, the prompt is populated, and dispatch is launched backgrounded with the turn yielded.

---

### 2. Adjudicate each actionable claim

Start once every launched dispatch has returned a report, `NO_DISPATCH_AVAILABLE`, or its per-pin fallback result.

Adjudicate per `dispatch`'s `references/alignment.md` § Adjudication (scope, verdict table, evidence over votes, dispute escalation).

Locus note: ground truth is the **requirement plus the host repository's rules**. Claims citing existing code are verified against the cited `<file>:L<line>`; claims proposing a plan change are verified against the target plan section (`§ <Section>`).

**Done when:** every actionable claim carries a verdict and all disputes are resolved (by the user in standalone mode, or returned unescalated per the orchestrator's consensus rule in orchestrated mode).

---

### 3. Fold findings into the plan and report

1. **Update plan body**: Apply every Accepted finding and user-ruled Resolved Dispute **directly to the target plan sections** on disk (`Proposed Changes`, `Verification Plan`, `Rollback & Blast Radius`, etc.). Fold accepted `SHOULD-FIX` / `CONSIDER` items into the plan body or record under **Out of Scope** with rationale (create `## Out of Scope` at the end of the plan when absent).
2. **Record review outcomes**: append this round's log under `## Review Findings & Resolutions` in the plan file per `dispatch`'s `references/alignment.md` § Resolutions Log (create `## Review Findings & Resolutions` at the end of the plan when absent).

**Standalone mode**: report to the user per alignment § User Report. **Orchestrated mode**: skip the user report — the orchestrator's own handoff covers it.

**Done when:** the plan body reflects all accepted changes, `## Review Findings & Resolutions` is updated with this round's adjudications (orchestrated: unescalated disputes logged as `[Disputed]`), and (standalone only) the user report is delivered with provider prefix.
