# Review coverage

Rules that apply only when a review slot fails or a native voice changes the checkout. Load this reference only on a slot failure or when a round reports `repositoryChanges`.

### Failed-slot coverage

Worktree reviews keep their failed-slot handling. A failed plan or design slot at the cap gets no extra round; its reduced coverage goes in the approval [Decision Frame](decision-frame.md), where the user decides. The rest of this section applies to `code-integration` only: the toolkit derives coverage from saved rounds and user records; it writes nothing.

- **Open:** a logical slot that fails in any round is open, including when every slot of the round failed and no findings file exists. A later failure reopens a closed slot.
- **Closed:** the slot, or its reserve or native substitute, completes a round at whole-target scope (`Full review` or `(coverage)`). A changed-path completion does not close it; a later round that omits the slot does not close it.
- **Rerun:** a slot that failed again in a whole-target attempt after its first failure. A passing rerun closes the slot.

The `decision` follows from the open slots:

| Decision | Condition | Delivery |
| --- | --- | --- |
| `none` | No open slot, no incomplete round | Continues |
| `rerun` | An open slot has no rerun, or a round is incomplete | Refuses |
| `majority` | Every open slot has a rerun and more than half of the saved target slots completed | Continues; the walkthrough records the reduced coverage |
| `user` | Every open slot has a rerun and half or fewer of the target slots completed | Refuses until the user decides |

**Rounds.** A coverage round runs the open slots only, or the full roster when an accepted finding keeps it, at whole-target scope with configured reserve and CLI fallback. Past the saved round-1 cap, one coverage round is free per review when no finding admits a normal continuation under [review provenance](review-rules.md#review-provenance-and-applicability). A normal continuation reruns open slots, uses no free round and needs no grant. An open-only coverage round or a narrowed round with every slot failed finalizes with no findings and counts as used; the next round takes the next number and reruns the open slots at whole-target scope. A full-roster round with every slot failed, including a full-roster coverage round, keeps its number for the retry. Coverage rounds stay within the ceiling. Their findings follow the ruling, MUST and final-round SHOULD rules. At decision `user`, coverage rounds stop, within the cap or past it, until the user records a grant.

**User decisions.** Present both options through the [review escalation Decision Frame](decision-frame.md#review-escalation): accept reduced coverage, or grant one more coverage round. Record each as a resolved `coverage:<review>:<key>` escalation by the user with a quote; the ledger refuses any other author. `accept: <slot>[, <slot>]*` covers the named open slots for failures recorded before it, at any time; a later failure reopens the slot. `grant: <reason>` stays usable until a coverage round consumes it.

**Enforcement.** `review run` refuses `coverage-decision` for the `user` case and the `requires-coverage-decision` budget state reports it. Past the ceiling, a slot at decision `rerun` or `user` gets the same refusal; only `accept:` settles it, because no round fits. `worktree deliver` refuses `coverage-required` at decision `rerun` or `user` and when coverage state cannot be read, before any caller write; an interrupted delivery recovers under existing rules. Verification of an accepted SHOULD fix refuses at decision `rerun` or `user` and on unreadable state; otherwise the last round may hold failed slots that are open or overridden. The walkthrough lists open slots, reduced coverage accepted under the majority rule, overridden slots with the user quote, and coverage rounds.

### Repository changes from native voices

A round that ran a host-platform voice as a native subagent compares each compared checkout before native launch and after native replies arrive, and reports any difference in `repositoryChanges` (`[{cwd, paths}]`) without discarding work; a failed capture or compare keeps all replies and reports `repositoryCheck: {state: "unavailable", reason}` instead. `status show` lists every report the rules below leave open in `value.openRepositoryChanges`. A round with no native voice runs no such check.

Inspect each changed path and check affected findings against current code: a voice's clean result is unproven for changed paths inside the review scope. When you can explain the change, record the explanation in a `note` ledger record with key `repository-changes:<review>:<round>:<reportSeq>` where `<reportSeq>` is the open entry's `reportSeq`, and continue with the kept work. An unavailable check leaves clean results unproven in the same way and is closed with the same key. To rerun the affected voices instead, record the rerun decision with key `repository-rerun:<review>:<round>:<reportSeq>` (by user with a quote), then run `review run`. When you cannot explain the change, stop before delivery or approval and put the paths to the user with a [Decision Frame](decision-frame.md).
