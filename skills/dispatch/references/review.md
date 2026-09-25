# Review contract

Use this reference for `review` actions. Terms come from [glossary.md](glossary.md); provider isolation and fallback come from [providers.md](providers.md).

## Evidence and rulings

Read every direct, reserve, or native-fallback report through the same parse path. A fallback replaces transport only: preserve the original candidate/source identity and metadata. Refusal, truncation, empty output, missing scope coverage, or loose loci require fallback.

Delegate reports are claims, not verification. Deduplicate and verify every finding against requirements, repository rules, and its cited locus. Accept verified defects regardless of votes. Reject contradicted, missing, uncited, speculative, or unverifiable claims, unused capability, and changes conflicting with a user-approved decision. Clarify related ambiguous findings together. Sanitize text before relay or artifact writes.

With `consensus: true`, rejected/downgraded `MUST`/`SHOULD` await `CONFIRM` from every reachable citing source; `REBUT` remains live and `INTENT-DISPUTE` records a dispute. With `consensus: false`, host rulings are final. `CONSIDER` and verified adjacent findings are host-final. At a cap with live `MUST`, offer cap-sized extension (default) or user rulings and a final verification wave.

Standalone review is report-only unless the user supplied `--fix`. Accepted adjacent findings remain follow-ups and are offered after the main scope settles.

## Resolution log and settlement

Append rounds beneath `## Review Findings & Resolutions` using the enriched finding and `application:` shapes emitted by the driver. Preserve finding IDs and cite only reporting sources. Unknown statuses or malformed bullets never settle. Accepted `MUST` findings require immediate action when fixes are enabled; unapplied accepted advice retains sorted paths, dependencies, verification, and reason.

Consensus (`review/consensus.mjs`): `0` settled, `1` live, `2` invalid. `MUST`/`SHOULD` trigger another round within the initial cap; extensions need `MUST`. A cap without `MUST` needs no extension prompt; disputed/unconfirmed findings still require a ruling. Checkpoint after terminal sources, recorded rulings and verification, and consensus `0`. Verify checkpoint preview before commit; drift restarts preparation.

## Minimum walkthrough contract

A walkthrough exists before baseline verification and contains, in order:

1. one H1;
2. `## Changes Made`;
3. `## Verification & Validation`, including `Command: \`<command>\` — exit <status>; <evidence>` records;
4. `## Outcome Traceability`, mapping every criterion to observable behavior and owning production paths;
5. `## Key Deviations`;
6. `## Review Findings & Resolutions`, initially `*No reviews conducted yet.*`; and
7. `## Follow-ups`.

Passing commands alone do not prove the outcome.

## Wave and artifact lifecycle

Execute the driver's launch argv directly and unbuffered; wrappers hide streamed slot lines. `selectedTargets` is the complete, ordered roster for this wave: `(all)` selects every target voice, not one preferred candidate. Inspect failed slots once, launch each matching slot's own early fallback in parallel, then await terminal outcomes without polling. Reconcile every selected slot with direct success, reserve substitution, native capture, or a named failure before advancing; an empty early reply is not an empty roster. Other failures consume ordered reserves before fallback. Configuration, membership, and integrity errors are terminal.

Canonical scratch artifacts use `.scratch/plan/<yyyy-mm-dd>-<slug>.md` and `.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`; they are the only persistent review write targets. Standalone reviews retain them in place. Views, packets, reports, and run state stay in the run's OS-temp session directory. Remove completed cleanup paths finally-style; retain unresolved inputs. Before successful relocation, warn that the OS may delete the plan and walkthrough and report every destination.

Design review uses the same preparation, parsing, rebuttal, consensus, and checkpoint core with its architectural kind block. Increment-plan review receives its bounded approved-design excerpt and binding from the driver. Final integration review is restricted to ledger-owned paths and its recorded baseline; ambiguous ownership fails closed.
