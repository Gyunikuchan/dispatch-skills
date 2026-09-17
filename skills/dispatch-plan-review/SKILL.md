---
name: dispatch-plan-review
description: Get a cross-agent review of an implementation plan before any code is written, verifying every returned claim. Use on /dispatch-plan-review, or when a plan needs a second opinion from another agent CLI.
---

# dispatch-plan-review

The delegate's report is a **claim, not a verdict**. The orchestrator adjudicates every finding against the requirement and host repository rules before editing the plan or reporting to the user.

## Invocation

`dispatch`'s `references/alignment.md` § Invocation is the base grammar (`/dispatch-plan-review (<pins>) [<artifact path>] [<focus>]`); the artifact path here is always the plan.

**Reading the trailing arguments.** The base grammar's trailing slot maps to three prompt variables by shape:

| Trailing text | Fills |
|---|---|
| First token naming an existing file or ending in `.md` | `<artifact path>` — the plan |
| Prose in the imperative naming a change ("add a retry to the uploader") | `<Requirement>` — used to author the plan |
| Anything else (e.g. "focus on the migration path") | `<User Focus Areas>` |

When a plan already exists, `<Requirement>` comes from the plan's goal statement rather than trailing text. Set `<User Focus Areas>` to `General review` when nothing remains.

**Stale-plan guard**: `scratch-existing` matches the branch slug at *any* date. When trailing text is a `<Requirement>` and the resolved plan does not cover it, stop and ask whether to overwrite that plan, review it as-is, or author under a fresh `--slug`.

## Process

### 1. Assemble context and dispatch

Determine the invocation mode first, per `dispatch`'s `references/alignment.md` § Invocation Modes:
**orchestrated** when an orchestrator hands over a `Canonical Artifact Path` plus a **targets** list,
`roundId`, `Review Mode`, `Review Scope`, `Tool Turn Budget`, `consensus`, and optional
`Review View Path`/ordered **reserves**. Standalone resolves the plan below; orchestrated uses the
handover.

Attach `Review View Path` when handed over, otherwise the canonical plan, plus any user-specified
files with `-f "<path>"` (forward slashes throughout). The view is delegate input only; edit and
append resolutions only at `Canonical Artifact Path`. Resolve the plan in order:

1. **User- or orchestrator-supplied plan** when an explicit path is passed or an orchestrating skill hands one over.
2. **Otherwise**, run the resolver per `dispatch`'s `references/alignment.md` § Plan/Walkthrough Artifact Resolution (derives the slug; add `--slug <kebab-slug>` only when the user names one or derivation fails):
   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs --kind plan
   ```
   - `tier: native` or `scratch-existing`: attach the existing plan as-is.
   - `tier: scratch-new`: author at the returned path following [references/plan-template.md](references/plan-template.md) before dispatching (governed by the **Stale-plan guard** above).

**Re-review round** (standalone): derive `<Review Scope>` from the resolved plan. No `### Round` headings under `## Review Findings & Resolutions` means `Full review`; `n` such headings mean `Re-review round <n+1>`, naming the sections edited since that last round. Count the headings, not the finding bullets — see `dispatch`'s `references/alignment.md` § Resolutions Log.

**Prompt**: for full review fill [references/prompt-template.md](references/prompt-template.md). For
`Review Mode: rebuttal`, fill [references/rebuttal-template.md](references/rebuttal-template.md)
with the handed-over source-specific `Finding Packet Path`. Use `dispatch`'s canonical
stdin/temp-output protocol (`--vars - --temp-out`) and remove all returned cleanup paths after
dispatch settles.

Supply only the selected template's declared variables. Full review uses:
- `<Plan Path>`: `Review View Path` when handed over, otherwise the resolved or authored plan.
- `<Requirement>`: from user ask (when authoring) or plan's `# <Goal Description>`.
- `<User Focus Areas>`: from user arguments (standalone) or caller focus (orchestrated), defaulting to `General review`.
- `<Review Scope>`: from handover (orchestrated) or derived round scope above (standalone).
- `<Tool Turn Budget>`: from handover (orchestrated) or `Unspecified` (standalone).

Rebuttal uses `<Plan Path>` (the bounded view), `<Finding Packet Path>`, `<Review Scope>` (packet
keys only), and `<Tool Turn Budget>`; omit full-review-only variables.

**Dispatch**: follow `dispatch`'s `references/alignment.md` § Invocation Modes. Add
`--response-schema-file "<skills-dir>/dispatch-plan-review/references/report-schema.json"` for full
review or the sibling `rebuttal-schema.json` for rebuttal mode.
Launch all invocations in the background and yield. In rebuttal mode, dispatch only the source
assigned to each packet; use fresh same-candidate dispatch when no resumable handle exists.

**Done when:** the plan is resolved (or authored), attached with `-f`, prompt variables populated into a prompt file, and dispatch launched backgrounded with the turn yielded.

---

### 2. Normalize and adjudicate each actionable claim

After every launch settles, handle terminal errors and empty outputs per `dispatch`'s
`references/alignment.md`
§ Adjudication. Save each report verbatim to an owner-only OS-temp file, run
`node <skills-dir>/dispatch-plan-review/scripts/parse-report.mjs --file "<path>"`, adding
`--rebuttal-packet "<packet>"` in rebuttal mode, then delete it.
Adjudicate only normalized `findings`, mapping severity per `dispatch`'s
`references/alignment.md` § Finality. Exit `1` is
`invalid-report` and follows the empty-report fallback without log entries; exit `2` halts.
Never repair guessed JSON.

Ground findings in the requirement, repository rules, the target `§ <Section>`, and any cited
`<file>:L<line>`.

**Done when:** every full-review finding carries a verdict, or every rebuttal packet has an exact
validated response key set. Rebuttal `CONFIRM` settles that source, `REBUT` keeps the finding live,
and `INTENT-DISPUTE` changes it to `[Disputed]`.

---

### 3. Fold findings into the plan and report

Sanitize every delegate-derived artifact write per `dispatch`'s `references/alignment.md`
§ Delegate Text Sanitization.

1. **Update plan body**: Apply every Accepted finding and user-ruled Resolved Dispute **directly to the target plan sections** on disk (`Proposed Changes`, `Verification Plan`, `Rollback & Blast Radius`, etc.). Fold accepted `SHOULD-FIX` / `CONSIDER` items into the plan body or record under `## Out of Scope` with rationale (create `## Out of Scope` at the end of the plan when absent).
2. **Record review outcomes**: append this round's log under `## Review Findings & Resolutions` in the plan file per `dispatch`'s `references/alignment.md` § Resolutions Log (create `## Review Findings & Resolutions` ahead of `## Out of Scope` when absent).

**Standalone mode**: deliver the user report per `dispatch`'s `references/alignment.md` § User Report. **Orchestrated mode**: skip the user report (the orchestrator's own handoff covers reporting).

**Done when:** the plan body reflects accepted changes and the enriched round/source log is updated
(orchestrated: unconfirmed `MUST`/`SHOULD` rejections stay
`[Rejected — pending confirmation]`); standalone also delivers the provider-prefixed report.
