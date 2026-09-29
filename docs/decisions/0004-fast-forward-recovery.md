# ADR 0004: Fast-forward recovery

- **Status**: Accepted
- **Date**: 2026-09-29

## Context

`dispatch implement` handled a bug or an unexpected stall by opening another write attempt, often
followed by another review wave. A simple fix therefore went through a heavy nested loop. The
failure disposition also offered to revert paths to their task-start state, and an agent answering
pre-approved driver gates could choose that, discarding substantial work without the user's
decision. The goal is to finish faster, favor moving forward, keep correctness, and make reverting
the user's own last resort.

## Decision

The driver enforces these rules itself. Contract prose names only the decisions the host makes.

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | Enforce in the driver, not contract prose | Only the driver can show that a fix stayed small or that a revert was approved | Contract-only; driver enforcing reverts only |
| D2 | Hot-fix mode by size: the host edits inline, or one single-shot writer does the work | Trivial fixes are fastest inline, and the writer keeps isolation for substantive work | Host always; writer always |
| D3 | Re-run the stalled check now; review hot-fixed paths later in the final code review via `finalFocus` | Every hot fix is verified and reviewed without adding a review round | Verify only; an immediate review round |
| D4 | A no-progress check instead of a count cap | A hot fix is withdrawn for the segment only when the failure it targeted survives unchanged | A fixed count per segment |
| D5 | A fixed budget of 10 files / 150 lines | The budget only separates host mode from writer mode | Small configurable defaults |
| D6 | Wide scope with an audit trail; `external` paths, each with a reason, are left out of the budget | External drift must not stall the run; the final review covers every extension | Plan scope only |
| D7 | Hard limits: outside the repository, `.git/`, secrets paths, deleting task-start files, git writes | These operations lose work or cross trust boundaries | — |
| D8 | A violation re-asks and never reverts | A revert could discard substantial work | Auto-restore |
| D9 | Revert requires `userApproved {by, quote}` and is listed last | Reverting is the user's call and a last resort | Agent-ruled reverts |
| D10 | Save a patch before every discard, including cascade restores; a patch that cannot be saved stops the discard | Nothing is lost silently, and failover stays automatic | Gating cascade restores on approval |
| D11 | The orchestrator judges whether the evidence names a locus | The driver cannot classify failures reliably, and D4 bounds a wrong judgement | Driver-side classification |
| D12 | Skip scoped commands whose fingerprint is unchanged, within the same run | The same content gives the same result | Reuse across runs |
| D13 | Re-review only after an applied MUST fix | The final review still covers non-MUST fixes | Re-review after every fix round |
| D14 | Skip the post-review scoped gate when the final gate re-runs its stale commands | Running the same commands twice in a row adds no evidence | — |
| D15 | Not adopted: CONFIRM only for MUST, ask-at-cap as the default, one-round settlement for minor findings | Not selected; changing CONFIRM would silence reviewer dissent | — |
| D16 | No writer merge | Merging with red criteria loses RED independence | — |
| D17 | No legacy support | Old reply shapes are refused, not translated | Compatibility shims |
| D18 | Offer a hot fix at every stall: failure disposition, blocked, missing context, and `baseline-red` (host only); list baseline hot fixes in the approval question | Unexpected stalls happen beyond verify failures, and disclosing them keeps approval informed | Verify failures only |
| D19 | No production edits by a hot fix before RED validates | Preserves RED independence | Allowing them and re-running RED |
| D20 | Enforce the git limits through HEAD, index, and stash fingerprints | The driver observes effects, not commands | Trusting the orchestrator |

### Implementation notes

- **Ledger.** A `hotfix-start` event opens a hot fix and a `hotfix` event records it. A `hotfix`
  event allows one new terminal verification for the current attempt, so a check whose
  verification was already recorded can re-run on the hot-fixed tree.
- **Baseline hot fixes.** They run before approval, when no ledger segment exists yet. They are
  kept in run state and appended as `hotfix` events once approval opens the segment.
- **Resuming after a hot fix.** A failure raised by verification re-runs that verification. A
  blocked, missing-context, or other stall continues the writer, which spends a writer attempt;
  the hot fix itself never does.
- **Interrupted hot fixes.** An interrupted host hot fix re-asks its edit question. The kept tree is
  judged when the host replies.
