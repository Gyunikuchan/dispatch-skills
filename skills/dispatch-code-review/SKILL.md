---
name: dispatch-code-review
description: Get a cross-agent review of working-tree code changes, verifying every returned claim against the cited lines. Use on /dispatch-code-review, or when a diff needs a second opinion from another agent CLI.
---

# dispatch-code-review

The delegate's report is a **claim, not a verdict**. The orchestrator adjudicates every finding against the active codebase before updating the walkthrough or reporting to the user.

## Invocation

`dispatch`'s `references/alignment.md` § Invocation is the base grammar (`/dispatch-code-review (<pins>) [<artifact path>] [<focus>]`); the artifact path here is the walkthrough (plan, if any, attaches alongside it).

## Process

### 1. Assemble context and dispatch

Determine the invocation mode first, per `dispatch`'s `references/alignment.md` § Invocation Modes: **orchestrated** when an orchestrating skill hands over a walkthrough path plus a **targets** list (with `Review Scope` and `Tool Turn Budget`), **standalone** otherwise. Standalone resolves context files below; orchestrated uses the handed-over paths, skipping resolution.

Attach the change walkthrough and implementation plan (if present), plus any user-specified files, with `-f "<path>"` (forward slashes throughout).

Resolve context files in order. Plan and walkthrough share one slug and one resolver call:

1. **User- or orchestrator-supplied plan/walkthrough** when an explicit path is passed or an orchestrating skill hands one over — skip the script for that kind. When only *one* kind is supplied and it is a canonical scratch path (`.scratch/plan/<yyyy-mm-dd>-<slug>.md` for a plan, `.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md` for a walkthrough), resolve the other kind from the same slug rather than letting the branch derive a different one — otherwise an explicitly named walkthrough gets paired with an unrelated plan, or none:
   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs --kind <other kind> --slug <slug from the supplied filename>
   ```
   When the supplied path is not a canonical scratch path, there is no slug to share: resolve the other kind normally, and attach nothing for it if it does not exist.
2. **Otherwise**, run the resolver once for both kinds per `dispatch`'s `references/alignment.md` § Plan/Walkthrough Artifact Resolution (it derives the slug; add `--slug <kebab-slug>` only when the user names one or derivation fails):
   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs
   ```
   For `plan`: `tier: native` or `scratch-existing` means a plan already exists — attach it (e.g. from a prior planning phase); `tier: scratch-new` (`exists: false`) — omit `-f` for the plan, none exists.
   For `walkthrough`: `tier: native` or `scratch-existing` means one already exists — attach it as-is; `tier: scratch-new` — author the returned path following [references/walkthrough-template.md](references/walkthrough-template.md) before dispatching.

**Re-review round** (standalone): derive `<Review Scope>` from the resolved walkthrough, not from a caller. No rounds logged under `## Review Findings & Resolutions` means `Full review`; `n` logged rounds means `Re-review round <n+1>`, naming the code changed since that last round.

**Prompt**: fill [references/prompt-template.md](references/prompt-template.md) (its variable bullets say what each value holds; orchestrated mode takes `Review Scope` and `Tool Turn Budget` from the handover) via `dispatch`'s `fill-template.mjs` per `references/alignment.md` § Prompt Template Filling: `node <skills-dir>/dispatch/scripts/fill-template.mjs --skill <skills-dir>/dispatch-code-review/references/prompt-template.md --vars <json file> --out <path>` (a JSON vars file carries multi-line values such as `<Task Summary>`), then `dispatch --prompt-file <out>`.

**Dispatch**: orchestrated — build one invocation per handed-over target per `dispatch`'s `references/alignment.md` § Invocation Modes; standalone — one per pin, or one cascade dispatch without pins, per § Invocation. Launch every invocation backgrounded and yield the turn; see `dispatch` for cascade, flags, and log monitoring. Dispatch runs structurally read-only.

**Done when:** the walkthrough and plan (if present) are resolved (or walkthrough authored), attached, the prompt is populated, and dispatch is launched backgrounded with the turn yielded.

---

### 2. Adjudicate each actionable claim

Start once every launched dispatch has returned a report, `NO_DISPATCH_AVAILABLE`, or its per-pin fallback result.

Adjudicate per `dispatch`'s `references/alignment.md` § Adjudication (scope, verdict table, evidence over votes, dispute escalation).

Locus note: ground truth for a code claim is the cited `<file>:L<line>` plus enough surrounding context to judge. Verify every claim against the cited lines before accepting; classify uncited, contradicted, or unverifiable claims as **Reject**.

**Done when:** every actionable claim carries a verdict and all disputes are resolved (by the user in standalone mode, or returned unescalated per the orchestrator's consensus rule in orchestrated mode).

---

### 3. Fold findings into walkthrough and report

1. **Apply fixes** (standalone mode only — an orchestrated caller owns its own fix step): apply every accepted finding to the codebase — `MUST-FIX` items and any accepted `SHOULD-FIX` small enough to land safely now. Record each accepted `SHOULD-FIX` / `CONSIDER` item you do *not* apply under `## Follow-ups` in the walkthrough, with a one-line reason; an accepted finding with no destination is a finding that gets lost. Update `## Changes Made` and `## Verification & Validation` when fixes change code or results.
2. **Re-verify** (standalone mode only): re-run the host verify command (from `AGENTS.md` / `CLAUDE.md`) until green. Fixes applied in step 1 are unreviewed code; shipping them without re-running the suite is how a review leaves the tree redder than it found it. Record the command and its result in `## Verification & Validation`.
3. **Record review outcomes**: append this round's log under `## Review Findings & Resolutions` in the walkthrough file per `dispatch`'s `references/alignment.md` § Resolutions Log (create the heading at the end of the walkthrough when absent).

**Standalone mode**: report to the user per alignment § User Report. **Orchestrated mode**: skip fix application, re-verification and the user report — the orchestrator applies its own fixes, runs its own verification, and its handoff covers reporting.

**Done when:** (standalone only) accepted fixes are applied, undeferred items are recorded under `## Follow-ups`, and the host verify command is green; `## Review Findings & Resolutions` is updated with this round's adjudications; and (standalone only) the user report is delivered with provider prefix.
