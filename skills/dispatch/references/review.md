# Review contract

Use this reference for `review` actions. Terms come from [glossary.md](glossary.md); provider isolation and fallback come from [providers.md](providers.md).

## Evidence and rulings

Read every direct, reserve, or native-fallback report through the same parse path. A fallback replaces transport only: preserve the original candidate/source identity and metadata. Refusal, truncation, empty output, missing scope coverage, or loose loci require fallback.

Delegate reports are claims, not verification. Deduplicate and verify every finding against requirements, repository rules, and its cited locus. Accept verified defects regardless of votes; apply the prompt's priority rubric. Reject contradicted, missing, uncited, speculative, or unverifiable claims, unused capability, and findings contradicting a decision recorded in the governing design or plan; rule `needs-user` when such a finding cites evidence the recorded rationale did not weigh, and update the decision entry with any approved reversal. Clarify related ambiguous findings together. Sanitize text before relay or artifact writes.

Code reviews that apply fixes (`review code --fix`, `implement`) follow [Review rounds](#review-rounds). In other reviews, rejected/downgraded in-scope `MUST`/`SHOULD` await `CONFIRM` from every reachable citing source; `REBUT` remains live and `INTENT-DISPUTE` records a dispute; at a cap with live `MUST`, offer cap-sized extension (default) or user rulings and a final verification wave. `CONSIDER` and verified adjacent findings are host-final.

Standalone review is report-only unless the user supplied `--fix`. With `--fix`, queue accepted in-scope `CONSIDER` findings only when they have bounded fix metadata. A bounded, uncertain in-scope `CONSIDER` is recorded as `Pending User`; do not rebut or reopen review for it. Ask once after available review waves are exhausted. An accepted answer is applied and verified without another review wave. Accepted adjacent findings remain follow-ups and are offered after the main scope settles.

## Resolution log and settlement

Append rounds beneath `## Review Findings & Resolutions` using the shapes the driver emits. Source maps, failed targets, and application records are `dispatch-sources`, `dispatch-failed-targets`, and `dispatch-application` HTML comments, each followed by a derived visible line (`- Reviewers:`, `- Failed:`, `<State> →`); only comments are parsed, and a derived line must match its comment. A duplicate entry carries `[dup=<first ID>]` and body `<locus> → see <first ID>`. Preserve finding IDs and cite only reporting sources. Unknown statuses or malformed bullets never settle. Accepted in-scope `MUST`/`SHOULD` and bounded `CONSIDER` require immediate action under `--fix`; report-only acceptance records without edits. Unapplied accepted advice retains sorted paths, dependencies, verification, and reason.

Consensus (`review/consensus.mjs`): `0` settled, `1` live, `2` invalid. Persist one cumulative review-wave budget per logical phase identity in parser-owned log markers; carry it through parent/child transitions and artifact recovery. Without a marker, recovery keeps the supplied phase budget. Rebuttals, final verification, fix application, and checkpoints do not consume waves; adjacent opt-in and checkpoint drift do not reset the budget. Apply and verify accepted fixes before cap decisions. Outside review rounds, only live `MUST` permits a cap extension. Disputed/unconfirmed findings still require a ruling. Checkpoint after terminal sources, recorded rulings and verification, and consensus `0`. Verify checkpoint preview before commit; drift restarts preparation within the same budget.

## Review rounds

Governs `review code --fix` and `implement` code review ([ADR 0005](../../../docs/decisions/0005-review-rounds-policy.md)); the driver (`review/rounds.mjs`) enforces it.

- **Threshold** after round N (cap = configured rounds): `SHOULD` while N < cap, `MUST` once N ≥ cap. `MUST` rounds are uncapped.
- **Scope**: rounds through the cap review the full diff plus all open pending rejections; later rounds review only fixes applied since the previous round plus open `MUST` pending rejections.
- **Disputes**: a rejected in-scope `MUST`/`SHOULD` is `Rejected — Pending Confirmation` and rides the next round as context. The Read delegate accepts by omission (closed by Read delegate) or re-raises it as a regular finding with new evidence; rule a re-raise like a new finding, answering that evidence.
- **Convergence**: a re-raise of an applied fix, or a second re-raise of a pending rejection (location + category, loose text match), halts the run with an `escalation` question. Answer `stop`; never finalize the finding.
- **Adjudication**: the driver closes pending rejections below the threshold (closed by orchestrator); at or above it, only the Read delegate closes them.
- **Next round** runs when any finding at or above the threshold was fixed this round or is pending. Otherwise the loop exits; unreviewed fixes go through the final gate and completion lists them as `fixedUnreviewed` with rejections, round count, and cap status.

## Minimum walkthrough contract

A walkthrough exists before baseline verification and contains, in order:

1. one H1, then the `Delivered`, `Parent`, `Status`, `Deviations` summary box;
2. `## Context`, only when Parent is `user request`;
3. `## Changes Made`;
4. `## Verification`, a `| SC | Outcome | Evidence |` table with one row per criterion, then a `Final gate:` line;
5. `## Deviations & Follow-ups`, `- Deviation:` / `- Follow-up:` bullets or `None.`; and
6. `## Review Findings & Resolutions`, initially `*No reviews conducted yet.*`.

Run evidence lives in `.state/<slug>.evidence.json`, never in the walkthrough. Passing commands alone do not prove the outcome.

For plan-less code review, fill the request `context` from the chat: ask, decisions tagged `(user)`, assumptions, out of scope, focus; omit empty fields.

## Wave and artifact lifecycle

`--drive` runs launch argv itself; a `launch` it stops at may leave the wave running. `selectedTargets` plus any `nativeLaunches` is the complete roster for this wave: `(all)` selects every target voice, not one preferred candidate. Launch every returned `nativeLaunches` and `earlyFallbacks` entry in one parallel round, then reply once; that reply waits for the wave. Reconcile every roster slot with direct success, reserve substitution, native capture, or a named failure before advancing; an empty early reply is not an empty roster. Other failures consume ordered reserves before fallback. Configuration, membership, and integrity errors are terminal.

Initialize one chat folder before a pre-driver spec with `node <skill-path>/scripts/session.mjs init --objective "<objective>"`; carry its absolute `sessionDir` as `--session-dir` on every invocation. Deliverables live at `<sessionDir>/<slug>.<type>.md`; ledgers, caches, and run files live under `<sessionDir>/.state/`, one `runs/NNN-<kind>/` folder per run. Dispatch-owned working copies of native artifacts go in the session; native originals stay with their owner. Terminal handoff moves the whole folder to `<realpath(os.tmpdir())>/dispatch-skills/<folder>/` after writes settle. A verified staged copy must publish before source removal. Report exactly one authoritative root in `handoff.destinations[0]` and the move result in `handoff.warning`. Reactivate that same folder before new work; on collision or loss, stop with the recovery paths. Pauses and intermediate design increments stay in `.scratch/dispatch-skills/`. The OS may delete published temp data. Never delete run files or logs before handoff; the move is the only cleanup.

Design review uses the same preparation, parsing, rebuttal, consensus, and checkpoint core with its architectural kind block. The driver binds each increment plan to its approved design and supplies a bounded excerpt. Final integration review is restricted to ledger-owned paths and its recorded baseline; ambiguous ownership fails closed.
