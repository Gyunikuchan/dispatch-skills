---
name: dispatch-plan-review
description: Get a cross-agent review of an implementation plan before any code is written, verifying every returned claim.
---

# dispatch-plan-review

Review or author one plan, then verify every claim against the requirement, repository rules, and
cited section. Follow [`alignment.md`](../dispatch/references/alignment.md).

## Invocation

```text
/dispatch-plan-review (<pins>) [<plan.md>] [<requirement or focus>]
```

Pins use `dispatch` grammar. Preparation classifies unambiguous trailing text. For
`decision-required`, ask its focused question and rerun with the answer. A legacy plan with unclear
coverage keeps the overwrite / review-as-is / fresh-slug choice.

## Prepare and launch

1. Send a closed JSON request through stdin or file:

   ```bash
   node <skill-path>/scripts/prepare-review.mjs --request <json-file|->
   ```

   Standalone requests carry the user selector/text. Orchestrated requests carry `mode`,
   `reviewMode`, `roundId`, `consensus`, caller-resolved `targets`/`reserves`, unique metrics
   paths, and optional packet/context. The manifest returns the canonical plan
   (`.scratch/plan/<yyyy-mm-dd>-<slug>.md`), freshness, scope, prompt/views, dispatch argv,
   invocation context, and cleanup paths.
2. On `authoring-required`, write the plan from [plan-template.md](references/plan-template.md);
   settle every decision-changing ambiguity one focused question at a time, then prepare again.
3. On `decision-required`, standalone mode asks the user. An orchestrator may answer only from an
   artifact it authored in the same run; otherwise it stops with the manifest diagnostic.
4. On `ready`, execute only `dispatch.argv` in the background and yield. Await every terminal
   target/reserve/fallback outcome before continuing. Remove no path still needed by the active
   invocation.

**Done when:** preparation is ready, the exact manifest argv is launched, and all outcomes are
terminal.

## Adjudicate

1. Save each report to an owner-only OS-temp file. Normalize full reports with
   `scripts/parse-report.mjs --file <path>`; add `--rebuttal-packet <packet>` for rebuttals. Exit
   `1` is invalid report/fallback; exit `2` is terminal. Never repair guessed JSON.
2. Verify each finding at its `§ <Section>` and any cited code. Accept, reject, downgrade, or
   dispute under alignment finality. Rebuttal key sets must exactly match the packet:
   `CONFIRM` settles, `REBUT` remains live, `INTENT-DISPUTE` becomes disputed.
3. Apply accepted findings to the plan body. Append the enriched round source map and every ruling
   under `## Review Findings & Resolutions`; sanitize delegate text first.
4. Continue only while code/plan changed or consensus remains live within the round cap.

## Settle and report

After every expected source is terminal and `check-consensus.mjs` exits `0`, call the same
preparation CLI with `action: "checkpoint"`, terminal source keys, consensus result, and exact
`settledWrites.sections`. It atomically records freshness metadata. A failed, incomplete, or
unsettled run does not checkpoint.

Remove no-longer-needed `cleanupPaths` on success, failure, checkpoint rejection, or abort; report
cleanup failures. Standalone reports a concise provider-attributed result. Orchestrated returns
adjudications without another user report.

**Done when:** the canonical plan reflects every ruling, consensus is settled or explicitly
escalated, metadata is checkpointed only for a settled invocation, and temporary paths are handled.
