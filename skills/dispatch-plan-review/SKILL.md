---
name: dispatch-plan-review
description: Review an implementation plan across independent agent CLIs before code is written, verifying every returned claim.
---

# dispatch-plan-review

Review or author one plan, then verify every claim against the requirement, repository rules, and
cited section. Follow [`alignment.md`](../dispatch/references/alignment.md).

## Invocation

```text
/dispatch-plan-review (<pins>) [<plan.md>] [<requirement or focus>]
```

Pins use `dispatch` grammar. Preparation classifies unambiguous trailing text; a legacy plan with
unclear coverage keeps the overwrite / as-is / fresh-slug choice.

## Prepare and launch

1. Send a closed JSON request:

   ```bash
   node <skill-path>/scripts/prepare-review.mjs --request <json-file|->
   ```

   Standalone requests carry `selector` plus unclassified `trailingText` (or classified
   `requirement`/`focus`); for count/`all` pins, prepare once per `dispatch.mjs --list-targets`
   entry with `selector: {provider: <platform>, candidateIndex}`. Orchestrated
   requests carry `mode`, `reviewMode`, `roundId`, `consensus`, caller-resolved
   `targets`/`reserves`, and optional packet/context. The manifest returns
   the canonical plan (`.scratch/plan/<yyyy-mm-dd>-<slug>.md`), freshness, scope, prompt/views,
   argv, invocation context, and cleanup paths.
2. On `authoring-required`, write the plan from [plan-template.md](references/plan-template.md),
   settling decision-changing ambiguities one focused question at a time, then prepare again.
3. On `decision-required`, standalone asks once per invocation. Later per-target requests carry
   the supplied fields plus `artifactOwned: true`, never a replayed `decision`: `overwrite`
   re-authors and `fresh-slug` throws. An orchestrator may answer only from an artifact it
   authored in-run; otherwise it stops with the manifest diagnostic.
4. On `ready`, execute only `dispatch.argv` in the background and yield. Await every terminal
   target/reserve/fallback outcome, retaining paths still needed.

**Done when:** preparation is ready, the exact manifest argv is launched, and outcomes are
terminal.

## Adjudicate

1. Read each report from `dispatch.outputPath`. Normalize it with
   `scripts/parse-report.mjs --file <path>`, adding `--rebuttal-packet <packet>` for rebuttals.
   Exit `3`: read the prose report per alignment; exit `1` is an empty report; `2` is terminal.
2. Verify each finding at its `§ <Section>` and any cited code, and an `adjacent` finding at its
   cited code. Accept, reject, downgrade, or dispute under alignment finality; rebuttal keys must
   match the packet exactly.
3. Apply accepted in-scope findings to the plan body and accepted `adjacent` findings under
   `## Out of Scope` as deferred follow-ups. Append the enriched source map and every ruling under
   `## Review Findings & Resolutions`; sanitize delegate text first.

**Done when:** every finding is verified at its cited locus, rulings are recorded, and consensus
is evaluated under the alignment cap.

## Settle and report

After every source is terminal and `check-consensus.mjs` exits `0`, standalone lists accepted
`adjacent` findings and asks which to fold into `## Proposed Changes` before the checkpoint. Each
folded one re-reviews that section in a new loop with a fresh cap until consensus exits `0`,
offering that loop's findings the same way. Unchosen ones stay under `## Out of Scope`; orchestrated returns
them unasked.

Then call the same preparation CLI with `action: "checkpoint"`, terminal source keys, consensus
result, and exact `settledWrites.sections`; it atomically records freshness metadata for settled
runs only. Standalone passes `terminalSourceKeys: []`; only orchestrated runs record expected keys.
A rejection prints the observed list as JSON: resend exactly that list and retry once.
Drift means rerun preparation, never force the write.

Prune finished `cleanupPaths` finally-style on every outcome and report failures. Keep invocation
state (`invocationCleanupPath`, never inside `cleanupPaths`) until checkpoint or abort, so
rejections stay retriable. Standalone reports a concise provider-attributed result;
orchestrated returns adjudications without another user report.

**Done when:** the plan reflects every ruling, consensus is settled or escalated, metadata is
checkpointed only for a settled invocation, and temporary paths are handled.
