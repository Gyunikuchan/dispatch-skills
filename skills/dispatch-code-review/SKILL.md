---
name: dispatch-code-review
description: Review a selected diff across independent agent CLIs, verify every claim against code, and apply safe accepted fixes in standalone mode.
---

# dispatch-code-review

The selected diff is authoritative. Verify every delegate claim against a changed line or direct
contract locus; verify an `adjacent` finding at its cited locus. Shared finality and logging rules
are in [`alignment.md`](../dispatch/references/alignment.md).

## Invocation

```text
/dispatch-code-review (<pins>) [<plan-or-walkthrough.md>] [<summary or focus>]
```

Pins use `dispatch` grammar. Pass request text to preparation; it resolves the shared artifact
slug and classifies unambiguous fields. For `decision-required`, ask the returned focused question
and rerun with the decision. Legacy walkthrough mismatch keeps the overwrite / review-as-is /
fresh-slug choice.

## Prepare and launch

1. Run:

   ```bash
   node <skill-path>/scripts/prepare-review.mjs --request <json-file|->
   ```

   Standalone requests carry selector/text and an explicit `range` only when the user named one;
   for count/`all` pins, prepare and launch once per `dispatch.mjs --list-targets` entry with
   `selector: {provider: <platform>, candidateIndex}`.
   Orchestrated requests carry `mode`, `reviewMode`, `roundId`, `consensus`, caller-resolved
   `targets`/`reserves`, unique metrics paths, and optional finding packet/context.
2. Preparation validates the explicit commit/range or current staged, unstaged, untracked, or
   merge-base diff; excludes `.scratch/`, generated, vendored, and binary paths; and returns
   `No reviewable changes; name a commit or range to review.` without substituting `HEAD~1`.
3. The manifest pairs the plan and walkthrough
   (`.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`), compares freshness, derives scope, creates
   bounded views/prompts, and returns attachments, response schema, argv, invocation context, and
   cleanup paths. A missing walkthrough is generated from the canonical template when summary and
   verification inputs are complete.
4. On `decision-required`, standalone asks the user. An orchestrator answers only from artifacts
   it authored in-run; otherwise it stops with the corrective diagnostic.
5. On `ready`, execute only `dispatch.argv` in the background and yield. Await all terminal
   target/reserve/fallback outcomes before continuing.

**Done when:** preparation is ready, the exact manifest argv is launched, and every outcome is
terminal.

## Adjudicate and fix

1. Save each report to owner-only OS temp. Normalize with
   `scripts/parse-report.mjs --file <path>`; add `--rebuttal-packet <packet>` for rebuttals. Exit
   `3`: read the prose report per alignment; exit `1` is an invalid report; exit `2` is terminal.
2. Verify every in-scope finding against its cited changed line and surrounding contract, and every
   `adjacent` finding against its cited locus. Reject uncited, contradicted, or unverifiable claims.
   Apply alignment finality and sanitize every artifact write.
3. Both modes record every accepted `adjacent` finding under `## Follow-ups`. Standalone mode
   applies accepted in-scope `MUST` and safe `SHOULD` fixes; records deferred `SHOULD`/`CONSIDER`
   items under `## Follow-ups`; reruns the host verify command until green or two identical
   failures; and updates `## Changes Made`, `## Verification & Validation`, and the enriched
   resolution log. Orchestrated mode records adjudications but leaves fixes to its caller.
4. Once verify is green, re-review only changed paths/live findings within the cap. Rebuttal
   response keys must exactly match the packet: `CONFIRM` settles, `REBUT` remains live,
   `INTENT-DISPUTE` becomes disputed.

**Done when:** all findings are verified against code, permitted fixes pass host verification,
resolutions are logged, and consensus is evaluated.

## Settle and report

After every expected source is terminal and consensus exits `0`, standalone mode lists accepted
`adjacent` findings, if any, and asks the user which to address before the checkpoint. For chosen
ones, apply the fixes, rerun verification, move them from `## Follow-ups` to `## Changes Made`, and
re-review the changed paths in a new loop with a fresh round cap until consensus exits `0` again;
offer that loop's `adjacent` findings the same way. Unchosen ones stay under `## Follow-ups`.
Orchestrated mode returns them to its caller unasked.

Then call preparation with `action: "checkpoint"`, terminal source keys, consensus result, and
exact `settledWrites.paths`/`walkthroughSections`. It compares the declared post-adjudication state
and atomically records range, path, worktree, and walkthrough-content freshness metadata, so the
checkpoint is the last write. Failed, incomplete, or unsettled runs keep the previous checkpoint.

Prune finished `cleanupPaths` in finally-style handling on every outcome; retain invocation state
only until checkpoint/abort and report cleanup failures. Standalone reports a concise
provider-attributed result and applied fixes. Orchestrated mode returns adjudications without
editing code or issuing another user report.

**Done when:** every finding is ruled, every accepted `adjacent` finding is offered or returned,
permitted fixes are verified, the walkthrough is current, settled metadata is checkpointed, and
temporary paths are handled.
