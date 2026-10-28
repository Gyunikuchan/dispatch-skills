# Fix Findings From Dispatch Diagnostics Reports

> **Status:** draft
>
> **Level:** medium — five toolkit modules, one writer template and one approval-gate rule change

## At a Glance
- **What:** Remove the Dispatch defects behind the nine findings in six session `diagnostics.md` reports, and make the remaining diagnostics accurate.
- **How it works:** The toolkit accepts evidence it already owns (RED capture exits, earlier rulings, recorded edit chains), keeps real I/O failures visible, labels governed hashes in writer briefs and names the exhausted model in quota diagnostics.

## Intent & Problem
- Request: investigate, verify, explain and propose fixes for every finding in the `diagnostics.md` files under `.scratch/dispatch-skills`.
- Problem: six reports (dispatch 0.7.3) hold nine findings that reduce to six issues. Each costs orchestrator turns, review rounds or driver time, or names the wrong cause.
- Outcome: a plan that removes each verified defect on the current tree and makes diagnostics accurate for the external cause.

## Background
Verification against HEAD `da83d07c`:

| # | Report finding | Sessions | Verdict on HEAD | Root cause |
| --- | --- | --- | --- | --- |
| 1 | Retro `missing-red-recurs` · `review.ts` | 1025Z | Confirmed | `redGaps` (`scripts/toolkit/red.ts:3`) reads only the writer report heading `## Observed RED failures`. The T1 writer wrote the heading without `## ` and ran RED without the capture wrapper. The tool raised R1/R2/R3 `missing-red` findings and opened two escalations although the orchestrator rejected R1-RED01 with evidence (exit 1). `review.ts:285-295` never reads rulings for tool findings. |
| 2 | H1 `quota` (agy) · `providers.md` | 1118Z, 1750Z, 1130Z | Dispatch behaved correctly; finding text inaccurate | `gemini-4-argon` returns quota (~5 s). Routing moves to `gemini-3.8-flash` (`next-model`) and the one-hour cooldown skips the key. Each hour one probe repeats. H1 tallies providers only and its fix says "add another model alias", but the voice already has two. |
| 3 | Retro `prune-error-cause` · `prune.ts` | 1750Z | Original fixed; residual pattern | `rejections()` (`prune.ts:20-25`) now maps only `review-confirmation-required`. Bare `catch` blocks at `prune.ts:120`, `:123` and `:143` still turn any read error (for example `EACCES`, `EIO`) into `prune-review-required`. |
| 4 | H8 `approval-stale` · `records.ts` | 0201Z | Confirmed; component wrong | The host recorded a non-intent plan edit (seq 9), then appended an approval for the user-seen pre-edit hashes. `ledger.ts:120-124` requires approval data to equal current hashes, and its message omits them. The host reverted the plan, approved, re-applied the edit and re-recorded it (seq 10-13, ~2 min). `gate` (`ledger.ts:187`) already accepts post-approval non-intent chains. The throw lives in `ledger.ts`, not `records.ts`. |
| 5 | H3 rejected share 67 % · `review-prompt.md` | 1130Z | No Dispatch defect | Plan review round 5 rejected R5-F003 and R5-F004 because task entries already defined the scope that reviewers read from a general constraint. The heuristic met its threshold (3 samples). The remedy was artifact-local and the run converged. |
| 6 | Retro `governed-hash-label` · `brief.ts` | 1627Z | Confirmed | `references/templates/writer-brief.md:5,7` and `brief.ts:124` print `(sha256:…)` without a label. Writers compared it with raw file SHA-256 and reported false mismatches. `toolkit.md#edit` names the canonical hash that `lint run` reports. |

> [!NOTE]
> Finding 5 and the external part of finding 2 need no Dispatch code change. The user may remove or reorder `gemini-4-argon` in local config; that config is outside this repository.

## Requirements
### REQ-1 — Tool-captured RED exit is RED evidence
A code review must not raise `missing-red` for a criterion when the task launch's RED capture directory holds a wrapper-written `<criterion>.exit` JSON with a non-zero numeric `status`.
- Acceptance: WHEN the writer report lacks the RED section and `<task>-<launch>.red/<SC>.exit` holds `{"status":1,…}`, `review run` SHALL emit no `missing-red` finding for that criterion.
- Acceptance: A missing, malformed, zero-status or null-status exit file SHALL leave the current gap behavior unchanged.

### REQ-2 — A rejected missing-red ruling settles later rounds
Within one review, a `rejected` ruling on a `missing-red` finding for a task and criterion must stop later rounds from re-raising that gap or opening its escalation.
- Acceptance: WHEN round 1 `R1-RED01` for T1 SC1 has a `rejected` ruling, rounds 2 and later of the same review SHALL emit no `missing-red` finding and no `missing-red:` escalation for T1 SC1, including after the target moves.
- Acceptance: Without a `rejected` ruling, current `unresolved` marking and escalation behavior SHALL remain.

### REQ-3 — Approval accepts a recorded non-intent edit chain
An approval append must accept the user-approved tuple when every artifact's approved hash equals its current hash, or reaches it through recorded non-intent edit records. Earlier edit history and unrecorded changes before the approval must not invalidate an approval of the current text. The gate must honor the same chain.
- Acceptance: WHEN a non-intent edit `A→B` is recorded and the plan now hashes `B`, appending an approval with plan `A` SHALL succeed, and `gate` SHALL allow brief render.
- Acceptance: WHEN the chain is missing, broken or contains an intent, dependency or discard edit, the append SHALL fail with `approval-stale`, and its message SHALL list the current hashes per artifact.

### REQ-4 — Prune keeps unexpected I/O failures visible
Prune review checks must map only absent or malformed review artifacts to `prune-review-required`.
- Acceptance: An `ENOENT` directory or file, or unparsable JSON, SHALL still refuse with `prune-review-required`.
- Acceptance: Any other read error SHALL propagate with its original code.

### REQ-5 — Writer briefs label governed hashes
Writer briefs must identify spec, plan and design hashes as governed canonical hashes and point to `lint run` for comparison.
- Acceptance: A rendered brief SHALL show each hash with the label `governed hash` and state that raw file SHA-256 differs.

### REQ-6 — Quota diagnostics name the model and recovery
H1 quota evidence must name each failed provider and model and state how many attempts routing recovered. The proposed fix must match the observed cause.
- Acceptance: For two quota failures on `agy`/`gemini-4-argon` that routed `next-model` and whose slots later completed `ok`, H1 evidence SHALL include `agy/gemini-4-argon ×2` and `2 recovered by fallback`.
- Acceptance: A failure with absent routing, `stop`, native fallback, or a failed or pending later attempt SHALL NOT count as recovered.
- Acceptance: The quota fix text SHALL tell the user to reorder or remove the exhausted alias, or check its quota, and SHALL NOT tell them to add an alias.

### REQ-7 — H8 names the module that rejects
H8 must cite the module that throws the recorded rejection class.
- Acceptance: `approval-stale` and `key-conflict` rejections SHALL cite `scripts/toolkit/ledger.ts`; other classes SHALL keep `scripts/toolkit/records.ts`.

## Non-goals
- Changing quota cooldown duration, routing order or user provider config.
- Changing H3 thresholds or the review prompt.
- Relaxing the writer report heading rule or parsing free-form RED prose.
- Suppressing tool findings for `duplicate` or `deferred` rulings, or for other tool finding types.

## Constraints
- Stack neutrality: no host language, runner or reporter assumption; capture exit files use the wrapper JSON shape only.
- No new dependency or runtime prerequisite.
- User-only approval rules stay: approval needs a user quote; xhigh/max selection stays user-only.
- Post-approval edit-chain checks keep current strictness (`unrecorded-change`, `intent-change`).
- Regenerate `skills/dispatch/skill-hashes.json` for changed hash-tracked files.
- (assumption) Wrapper-written exit files are trustworthy evidence because the brief tool generates the wrapper and only the writer writes to the task RED directory.

## Decisions
### DEC-1 — Approval chain instead of message-only
- Context: Finding 4 cost a revert/re-apply cycle.
- Options: (a) message lists current hashes only; (b) approval accepts recorded non-intent chains plus the message from (a).
- Choice: (b).
- Rationale: The gate already treats an approved tuple plus recorded non-intent edits as approved; edits recorded before the approval are the same evidence. (a) still forces the revert dance.
- Rejected: (a) alone — leaves the workflow cost; free approval of any hash — removes user intent binding.

| Dimension | (a) Message only | (b) Chain + message |
| --- | --- | --- |
| Host turns saved | Fewer retries | Revert cycle removed |
| Gate change | None | Pre-approval non-intent edits walk |
| Risk | None | Low; intent edits still block |

### DEC-2 — Deterministic RED evidence plus ruling carry-forward
- Context: Finding 1 had two independent causes: bypassed wrapper and a malformed heading; rulings were ignored.
- Options: (a) lenient heading parse; (b) accept wrapper exit files; (c) carry a `rejected` ruling forward; (d) (b)+(c).
- Choice: (d).
- Rationale: (b) removes the first false finding when the wrapper ran; (c) handles verified rejections when it did not. Both use tool-owned records, not prose.
- Rejected: (a) — prose parsing grows heuristics and still misses the bypass case.

### DEC-3 — Keep H1 for recovered quota, make it accurate
- Context: Fallback recovered every agy quota failure, yet a probe repeats each hour.
- Options: suppress H1 when all recovered; keep H1 with model and recovery detail.
- Choice: keep with detail.
- Rationale: The user still pays ~5 s per hour and can act by reordering the alias; suppression hides that.
- Rejected: suppression — loses an actionable config signal.

### DEC-4 — No change for H3 finding
- Context: Round 5 rejections were artifact-local scope reads.
- Choice: no Dispatch change; report the verdict.
- Rationale: The heuristic fired as designed and the proposed fix applied to the artifact.

## Discussion Record
- 2026-10-28: User asked to investigate, verify, explain and propose fixes for all findings in session `diagnostics.md` files and to commit when done. The `/brainstorming` prefix was satisfied by option analysis in DEC-1..DEC-4; per standing preference, the orchestrator settled non-intent choices without further questions.

## Open Questions
- none
