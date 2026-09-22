---
name: dispatch-code-review
description: Review a selected diff across independent agent CLIs, verify every claim against code, and apply safe accepted fixes in standalone mode.
---

# dispatch-code-review

The selected diff is authoritative: verify every delegate claim against a changed line or direct
contract locus. Shared finality and logging rules are in
[`review.md`](../dispatch/references/review.md).

## Invocation

```text
/dispatch-code-review (<pins>) [<plan-or-walkthrough.md>] [<summary or focus>]
```

Pins use `dispatch` grammar. Preparation resolves the shared artifact slug.

## Prepare and launch

1. Run:

   ```bash
   node <skills-dir>/dispatch/scripts/prepare-review.mjs --kind code --request <json-file|->
   ```

   Standalone requests carry `selector`, classified `summary`/`focus`, and
   an explicit `range` only when the user named one (`trailingText` is unread). For
   count/`all` pins, prepare once per `dispatch.mjs --list-targets` entry with
   `selector: {provider: <platform>, candidateIndex}`.
   Orchestrated requests carry `mode`, `reviewMode`, `roundId`, `consensus`, caller-resolved
   `targets`/`reserves`, and optional finding packet/context.
2. Preparation validates the explicit commit/range or current staged, unstaged, untracked, or
   merge-base diff, excludes `.scratch/`, generated, vendored, and binary paths, and returns
   `No reviewable changes; name a commit or range to review.` without substituting `HEAD~1`.
3. The manifest pairs the plan and walkthrough
   (`.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`), compares freshness, derives scope, and
   returns bounded views/prompts, attachments, response schema, argv, context, and cleanup paths. A missing walkthrough comes from the canonical template when summary and
   verification inputs are complete.
4. On `decision-required` (`walkthrough-inputs`), standalone asks once for the listed `missing`
   inputs and prepares again; an orchestrator stops with the corrective diagnostic.
5. On `ready`, execute only `dispatch.argv` in the background and follow `review.md`'s one-shot
   early-fallback launch protocol. Await every terminal target/reserve/fallback outcome. Classify
   missing runner results through
   [`dispatch`'s run contract](../dispatch/SKILL.md#run), without polling.

**Done when:** preparation is ready, the exact manifest argv is launched, and outcomes are
terminal.

## Adjudicate and fix

1. Read every direct, reserve, or native-fallback report from its slot's
   `dispatch.outputPath` (or documented stdout-result channel). A fallback must first be captured
   there under the original candidate/source identity with fallback metadata; it receives no
   alternate adjudication path. Normalize with `<skills-dir>/dispatch/scripts/parse-report.mjs --kind code --file <path>`, adding
   `--rebuttal-packet <packet>` for rebuttals. Exit `3`: read the prose report per review; exit
   `1` is an empty report; `2` is terminal.
2. Verify each in-scope finding against its cited changed line and surrounding contract, and each
   `adjacent` finding at its cited locus. Reject uncited, contradicted, or unverifiable claims.
   Apply `review.md` finality and sanitize every artifact write.
3. Both modes record accepted `adjacent` findings under `## Follow-ups`. Standalone also applies
   accepted in-scope `MUST` and safe `SHOULD` fixes as independence clusters via
   `node <skills-dir>/dispatch/scripts/fix-clustering.mjs --cluster` (pairwise disjoint paths,
   same-file findings separate, union verification), defers unapplied items to `## Follow-ups` with
   application records, reruns host verify until green or two identical failures per cluster, and
   updates `## Changes Made`, `## Verification & Validation`, and the enriched resolution log.
   Orchestrated records adjudications but leaves fixes to its caller.
4. Once verify is green, re-review only changed paths/live findings within the cap. Rebuttal keys
   must exactly match the packet: `CONFIRM` settles, `REBUT` remains live, `INTENT-DISPUTE`
   becomes disputed.

**Done when:** findings are verified against code, permitted fixes pass host verification,
resolutions are logged, and consensus is evaluated.

## Settle and report

After every source is terminal and consensus exits `0`, standalone lists accepted `adjacent`
findings and asks which to address before the checkpoint. For chosen ones: fix, reverify, move
them from
`## Follow-ups` to `## Changes Made`, and re-review the changed paths in a new loop with a
fresh round cap until consensus exits `0`, offering that loop's findings the same way. Unchosen
ones stay under `## Follow-ups`. Orchestrated returns them to its caller unasked.

Then send preparation `action: "checkpoint-preview"` and resend its `settlement` and
`settledWrites` as `action: "checkpoint"`. It compares the declared post-adjudication state
and atomically records range, path, worktree, and walkthrough-content freshness, so the checkpoint
is the last write. Failed, incomplete, or unsettled runs keep the previous checkpoint.
Drift means rerun preparation, never force the write.

Prune finished `cleanupPaths` finally-style on every outcome; keep invocation state until
checkpoint/abort; report cleanup failures. A pending native fallback leaves the prompt path
unfinished: prune it once that fallback has consumed it or reached a terminal outcome. Standalone reports a concise provider-attributed
result and applied fixes; orchestrated returns adjudications without editing code or reporting
again.

**Done when:** every finding is ruled, every accepted `adjacent` finding is offered or returned,
permitted fixes verify, the walkthrough is current, metadata is checkpointed, and temp paths are
handled.

## Verify walkthrough freshness

Statelessly verify a checkpointed walkthrough artifact against current git and working-tree state without ephemeral invocation state:

```bash
node <skills-dir>/dispatch/scripts/resolve-review-range.mjs --verify-freshness <walkthrough-path> [--repo-root <path>]
```

Exits 0 (fresh), 1 (stale/drifted), or 2 (error). Details and output schema in [README.md](README.md#verify-walkthrough-freshness).

