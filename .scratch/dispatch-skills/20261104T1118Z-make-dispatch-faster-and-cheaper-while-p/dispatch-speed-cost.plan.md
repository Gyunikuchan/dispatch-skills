# Dispatch speed and cost streamlining

> **Parent:** `.scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/dispatch-speed-cost.spec.md` · sha256:cd5c4b52c21d3aae248b063c8066f9122ce5ef89704be06a9f68f38230e0ebee
>
> **Decide:** approve the two tasks, the REQ-1 deletion inventory and the level
>
> **Risk:** med — prose edits change orchestrator gates (spec confirmation, retro merge, review ceiling wording) that many tests pin
>
> **Scope:** `skills/dispatch/`, `tests/`, `docs/decisions/`

## At a Glance
- **What:** Cut one user round trip per spec, one subagent launch per verb handoff, a possible 13 KB reviewer read per round, and duplicated orchestrator prose; keep every rule once.
- **How it works:** T1 changes spec confirmation, retro merge and review-prompt links; T2 then replaces restated rules with links to their single home. See [Task Map](#task-map).

## Background
- Spec stage runs grilling (step 2), then authors (step 3), then a separate Confirm exchange (step 4) — `skills/dispatch/references/spec-stage.md:12-16`. Vendored grilling ends with a shared-understanding check — `.agents/skills/grilling/SKILL.md:30` (read-only).
- Retro merge launches a utility subagent with orchestrator notes only — `skills/dispatch/references/diagnostics.md:3`; ADR rationale `docs/decisions/0015-native-subagent-routing.md:17`.
- Review prompts inline selected quality criteria under Inspection (slot `<<slot:quality>>` at `skills/dispatch/references/templates/review-prompt.md:41`) and also link the whole bar — `skills/dispatch/references/templates/review-prompt-code.md:35`, `skills/dispatch/references/templates/review-prompt-plan.md:25`, `skills/dispatch/references/templates/review-prompt-design.md:25`.
- Context maps: `dispatch-speed-cost.spec.context.md` and `dispatch-speed-cost.plan.context.md` in the session folder.

## Key Decisions & Context
- Spec DEC-4: the Confirm exchange becomes grilling's final shared-understanding check; the spec is authored only once no decision is open.
- Spec DEC-6, DEC-11: retro merge is inline; investigation stays delegated under the context guard; ADR 0015 records the speed and launch-count rationale.
- Spec DEC-7, DEC-10: prompts point to the inlined criteria; the Visual-aid bar stays whole.
- Spec DEC-5, REQ-1: each deletion below names its surviving home or enforcing code. No deleted sentence lacks both.
- Spec DEC-8: no change to review roster, rounds, writer payload, whole-spec reads, test cleanup, plan review or approval.
- Prompt wording "the quality criteria below": criteria render after the template line in every kind (code golden lines 53-77; plan golden lines 49-89), so "below" stays true without a heading. `## quality` stays a slot delimiter that never renders (`tests/integration/domain-templates.test.ts:288`).

### REQ-1 deletion inventory

| ID | File | Deleted or merged text | Surviving home | Enforcing code |
| --- | --- | --- | --- | --- |
| C1 | `skills/dispatch/references/decision-frame.md` (Review escalation, 2nd paragraph) | ": MUST continuation reached the round-1 cap plus 2 rounds, plus 2 more rounds per granted resolution" | `skills/dispatch/references/review-rules.md:18` | `skills/dispatch/scripts/toolkit/findings.ts:86-102` |
| C2 | same file, last paragraph | "Re-author, model-effort and relax-split each grant 2 rounds. `defer` grants none: the next run above the ceiling refuses `round-cap`, while a pending MUST rejection keeps its confirmation round." | `skills/dispatch/references/review-rules.md:18` | `skills/dispatch/scripts/toolkit/findings.ts:98-121`, `skills/dispatch/scripts/toolkit/review.ts:243` |
| C3 | same file, last paragraph | "The ledger refuses a ceiling resolution that is not user-authored and quoted, lacks an option prefix, or defers a code review." | `skills/dispatch/references/toolkit.md:200` | `skills/dispatch/scripts/toolkit/records.ts:153-160` |
| C4 | `skills/dispatch/references/toolkit.md` (`review run` Refusals) | "An accepted MUST fix or pending MUST rejection permits continuation … (plan and design only, with no pending MUST rejection)." (two sentences) | `skills/dispatch/references/review-rules.md:18`, `skills/dispatch/references/toolkit.md:200` | `skills/dispatch/scripts/toolkit/findings.ts:86-121`, `skills/dispatch/scripts/toolkit/review.ts:242-249`, `skills/dispatch/scripts/toolkit/records.ts:153-160` |
| C5 | `skills/dispatch/references/verbs/implement.md` step 4 | "Writers edit only assigned paths and run no Git write commands ([native slot boundaries](../providers.md#native-slots))." | `skills/dispatch/SKILL.md:63` (always loaded); writers get it from `skills/dispatch/references/templates/writer-brief.md:3` | none (brief-carried) |
| C6 | `skills/dispatch/references/verbs/implement.md` step 6 | "; the toolkit refuses an all-empty record" | `skills/dispatch/references/toolkit.md:66` (`test-cleanup-empty`) | `skills/dispatch/scripts/toolkit/integrate.ts:68` |
| C7 | `skills/dispatch/references/spec-stage.md` Approval | "implementation uses one approval tuple for the current spec, plan and optional design hashes, with actual user words" → link | `skills/dispatch/references/decision-frame.md:12` | `skills/dispatch/scripts/toolkit/records.ts:148-150` |

Kept on purpose: whole-spec read sentences (each names a different reader), verb quality-bar link lists, the delivery sentence in `verbs/implement.md` step 9 (the orchestrator action; its toolkit link is pinned at `tests/integration/skill-contract.test.ts:202`), the ceiling record JSON template and option list in `decision-frame.md`.

## Constraints
- Agent-facing prose follows `.agents/skills/writing-for-agents/SKILL.md` and ASD-STE100; edit nothing under `.agents/skills/`.
- `skills/dispatch/SKILL.md` ≤ 7,424 B; `skills/dispatch/references/diagnostics.md` ≤ 1,024 B with CRLF line ends (`skills/dispatch/scripts/toolkit/domain/diagnostics.ts:100`).
- Hash-tracked edits: run `npm run hashes` after the last skill edit, before submit.
- Golden fixtures equal rendered output exactly (`tests/unit/toolkit/domain/prompt.test.ts:94`); edit each golden line to match its template change.
- ADRs record current state only.
- Use the exact replacement text given in each task; adjust only to satisfy a pinned test, and report any adjustment.

## Out of Scope
- `skills/dispatch/references/review-rules.md:5` quality-bar link: orchestrator-facing, not a rendered prompt.
- Timing-budget baseline failure (spec DEC-9).

## Task Map

| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Combined confirm, inline retro, prompt links | Spec confirmation is grilling's last exchange, retro merges inline, and review prompts point to their inlined criteria | none | SC1, SC2, SC3 |
| T2 | Single home for restated rules | Restated ceiling, writer-boundary, test-cleanup and approval rules become links to their single home | T1 | SC4 |

## Proposed Changes

### T1 — Combined confirm, inline retro, prompt links
- Constraints: before submit, run `git grep -n -i "retro" -- skills/dispatch docs/decisions` and confirm no line still pairs the retrospective with a utility subagent or launch.
- With `grilling`, the orchestrator authors and lints the spec when no decision is open, then presents it once; the reply is the `confirm`. A reply that opens a decision resumes grilling. Without `grilling`, the single Confirm exchange is unchanged.
- At each verb handoff with diagnostics on, the orchestrator writes its own notes to `<session>/.state/retro.json`; no subagent launches. Raw-source investigation still follows the context guard.
- Rendered code, plan and design review prompts say "the quality criteria below" and contain no `quality-bar.md` link.

<details>

- #### [MODIFY] skills/dispatch/references/spec-stage.md
  - Changes: Step 2: replace "Continue until no user decision is open; map its output into the canonical spec as best effort." with "Continue until no user decision is open; the step 4 exchange replaces grilling's closing shared-understanding confirmation, so ask no separate one. Map its output into the canonical spec as best effort." Step 4: replace its first sentence with "In one exchange, present the spec path, stated and assumed intent separately and recommend `plan` or `design` from the scope check. When `grilling` ran, this exchange is its closing shared-understanding confirmation: if the reply opens or changes a decision, resume grilling for that branch, then update the spec and its DECs with the user's actual quotes, lint it and repeat this exchange; record no `edit` or `confirm` until the user accepts the repeated exchange. When `grilling` was unavailable, use grounded scope and present the critique in this Confirm exchange." In the kept sentence "If the reply changes intent beyond the presented alternative, follow the [revision protocol]…", insert "in this fallback" after "presented alternative". Keep the rest of step 4 and the record paragraph unchanged. The record paragraph then serves both paths through its "otherwise:" lead-in.
  - Invariants: exactly one "Record the user's reply as a `confirm` ledger record with the spec hash" sentence; fallback wording pinned at `tests/integration/skill-contract.test.ts:142-154` stays; a pre-confirmation decision change records no `edit` record and no early `confirm`.
- #### [MODIFY] skills/dispatch/references/diagnostics.md
  - Changes: Line 3 becomes "If enabled, at each verb's final handoff, merge your terse notes into the JSON array at `<session>/.state/retro.json` yourself (unique ids, max 20 defects); investigating logs/chat follows the [context guard](../SKILL.md#context-guard). Without notes, add nothing; if no file, write `[]`. Then you run `diagnostics render`. `[]` is valid empty; missing, unreadable, malformed or non-array input is uncollected." Last line becomes "Collection or a failed merge is never a workflow gate." No other line changes.
  - Invariants: item schema, limits, exclusions unchanged; measured result 1,022 B with CRLF (cap 1,024).
- #### [MODIFY] skills/dispatch/SKILL.md
  - Changes: Routing row "Test cleanup, retro, map correction, mechanical fixes that a deterministic check confirms" drops ", retro".
  - Invariants: five routing rows; byte budget.
- #### [MODIFY] skills/dispatch/references/readme/concepts.md
  - Changes: Line 26 "such as test cleanup, the diagnostics retrospective, and mechanical fixes" → "such as test cleanup and mechanical fixes". Line 64 → "The host agent merges its own terse notes on Dispatch instruction, driver or routing friction in the [retro format](../diagnostics.md) and launches no subagent for it. Without observations, nothing is added. Findings cover Dispatch's own behavior. Proposed fixes are unverified."
- #### [MODIFY] skills/dispatch/references/readme/configuration.md
  - Changes: Line 91 "such as test cleanup and the diagnostics retrospective" → "such as test cleanup and mechanical fixes". Line 95 sentence "At each verb handoff with observations, the host agent launches at most one utility subagent to merge its notes; without observations, it launches nothing." → "At each verb handoff with observations, the host agent merges its notes itself and launches no subagent."
- #### [MODIFY] skills/dispatch/references/readme/troubleshooting.md
  - Changes: Line 75 "A failed retro launch does not gate the workflow." → "A failed retro merge does not gate the workflow."
- #### [MODIFY] skills/dispatch/README.md
  - Changes: Line 24 "It writes a spec, confirms what it assumed, and recommends `plan` or `design`." → "It then writes the spec and, in the exchange that ends the questions, confirms what it assumed and recommends `plan` or `design`." Line 137 diagnostics cell "when on, adds at most one utility subagent launch per verb handoff, only when the host agent has observations" → "when on, the host agent merges its own notes at each verb handoff and launches no subagent".
- #### [MODIFY] skills/dispatch/config.sample.jsonc
  - Changes: Lines 16-17 comment → "// Optional; true writes the session diagnostics.md retrospective from host notes merged at" / "// each verb handoff, with no subagent launch; false adds nothing."
- #### [MODIFY] skills/dispatch/references/templates/review-prompt-code.md
  - Changes: "Judge quality using the selected sections of the [quality bar](quality-bar.md)." → "Judge quality using the quality criteria below."
- #### [MODIFY] skills/dispatch/references/templates/review-prompt-plan.md
  - Changes: "- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets." → "- Use the quality criteria below to judge those targets." Rest of the line unchanged.
- #### [MODIFY] skills/dispatch/references/templates/review-prompt-design.md
  - Changes: same replacement as the plan template.
- #### [MODIFY] tests/fixtures/review-prompt-golden/code.md
  - Changes: line 25 matches the code template change.
- #### [MODIFY] tests/fixtures/review-prompt-golden/plan.md
  - Changes: line 15 matches the plan template change.
- #### [MODIFY] tests/fixtures/review-prompt-golden/design.md
  - Changes: line 15 matches the design template change.
- #### [MODIFY] docs/decisions/0014-ground-first-intent-and-evidence-based-level.md
  - Changes: Line 13 "It invokes `grilling` when the host provides it, writes the spec, then confirms stated and assumed intent." → "It invokes `grilling` when the host provides it, writes the spec once no decision is open, then confirms stated and assumed intent in grilling's final shared-understanding exchange, so grilling adds no separate confirmation round trip."
- #### [MODIFY] docs/decisions/0015-native-subagent-routing.md
  - Changes: Line 9 is context and stays. Line 13 "Utility subagents take test cleanup, the retrospective, map correction and mechanical fixes" → "Utility subagents take test cleanup, map correction and mechanical fixes". Line 17 → "For the retrospective, the orchestrator merges its own terse notes into the retro file. The merge is write-only, so a utility launch would add a cold start and a wait while token cost stays about neutral; the inline merge is faster with one fewer launch. Investigation of logs or chat history for retro evidence still follows the context guard. With no notes, nothing is added."
- #### [MODIFY] tests/integration/skill-contract.test.ts
  - Changes: In 'spec stage critiques the request premise before confirmation', assert `refine` matches /replaces grilling's closing shared-understanding confirmation/; assert `confirm` matches /When `grilling` ran, this exchange is its closing shared-understanding confirmation/, /resume grilling for that branch/ and /record no `edit` or `confirm` until the user accepts the repeated exchange/, and that the revision-protocol sentence reads /changes intent beyond the presented alternative in this fallback/. In 'root skill routes work and guards orchestrator context', remove the `['retro', 'Utility subagent']` pair and assert `route('retro')` is undefined.
- #### [MODIFY] tests/integration/diagnostics-contract.test.ts
  - Changes: Replace the utility, "When none resolves" and "With no notes, launch nothing" assertions with /merge your terse notes into the JSON array at `<session>\/\.state\/retro\.json` yourself/, /Without notes, add nothing; if no file, write `\[\]`/ and a match for the `../SKILL.md#context-guard` link; change the gate assertion to /Collection or a failed merge is never a workflow gate/; replace the 'workflow gate' term list entry check only if it no longer holds.
- #### [MODIFY] tests/integration/domain-templates.test.ts
  - Changes: Lines 245 and 289: assert the plan and design templates match /Use the quality criteria below to judge those targets/ and do not contain `](quality-bar.md)`.
- #### [MODIFY] tests/unit/toolkit/domain/prompt.test.ts
  - Changes: In 'assembles prompt matching golden per review kind', assert each rendered prompt contains "the quality criteria below" and no `](quality-bar.md` link.
- #### [GENERATED] skills/dispatch/skill-hashes.json
  - Command: `npm run hashes`
  - Inputs: skills/dispatch/SKILL.md, skills/dispatch/references/spec-stage.md, skills/dispatch/references/diagnostics.md, skills/dispatch/references/readme/concepts.md, skills/dispatch/references/readme/configuration.md, skills/dispatch/references/readme/troubleshooting.md, skills/dispatch/references/templates/review-prompt-code.md, skills/dispatch/references/templates/review-prompt-plan.md, skills/dispatch/references/templates/review-prompt-design.md

</details>

### T2 — Single home for restated rules
- Constraints: requires T1 because both tasks edit `skills/dispatch/references/spec-stage.md`, `tests/integration/skill-contract.test.ts` and `skills/dispatch/skill-hashes.json`.
- The orchestrator reads each review continuation, ceiling, writer-boundary, test-cleanup-empty and approval-tuple rule once; other references link to that home. Apply exactly the REQ-1 deletion inventory C1–C7.

<details>

- #### [MODIFY] skills/dispatch/references/decision-frame.md
  - Changes: C1: "A `review-ceiling` refusal is the ceiling branch: MUST continuation reached the round-1 cap plus 2 rounds, plus 2 more rounds per granted resolution." → "A `review-ceiling` refusal is the ceiling branch of the [continuation rule](review-rules.md#review-provenance-and-applicability)." C2, C3: delete those sentences from the last paragraph; keep the record template sentence and append "See the [escalation record](toolkit.md#escalation)."
  - Invariants: four option bullets and the `defer` offer condition stay.
- #### [MODIFY] skills/dispatch/references/toolkit.md
  - Changes: C4: replace the two sentences with "`round-cap` and `review-ceiling` follow the [continuation rule](review-rules.md#review-provenance-and-applicability); resolve `review-ceiling` under the [review escalation Decision Frame](decision-frame.md#review-escalation) with an [escalation record](#escalation)."
  - Invariants: refusal name list unchanged; terms pinned at `tests/integration/skill-contract.test.ts:296-310` stay.
- #### [MODIFY] skills/dispatch/references/verbs/implement.md
  - Changes: C5: delete the step 4 writer-boundary sentence. C6: delete "; the toolkit refuses an all-empty record" so the sentence ends after "is non-zero".
  - Invariants: phrases pinned at `tests/integration/skill-contract.test.ts:100-112` stay.
- #### [MODIFY] skills/dispatch/references/spec-stage.md
  - Changes: C7: Approval sentence "At medium and above, implementation uses one approval tuple for the current spec, plan and optional design hashes, with actual user words." → "At medium and above, implementation needs the user [approval tuple](decision-frame.md#user-gate-boundaries)."
- #### [MODIFY] tests/integration/skill-contract.test.ts
  - Changes: Add test 'review continuation and ceiling rules have one canonical home': `decision-frame.md` and `toolkit.md` contain neither "round-1 cap plus 2" nor "each grant 2 rounds" and both link `review-rules.md#review-provenance-and-applicability`; `review-rules.md` keeps "the round-1 cap + 2 + 2 per user-resolved grant".
- #### [GENERATED] skills/dispatch/skill-hashes.json
  - Command: `npm run hashes`
  - Inputs: skills/dispatch/references/decision-frame.md, skills/dispatch/references/toolkit.md, skills/dispatch/references/verbs/implement.md, skills/dispatch/references/spec-stage.md

</details>

## Success Criteria
- [SC1] With `grilling`, spec confirmation is grilling's final shared-understanding exchange; the fallback keeps its single Confirm.
  <details>

  - Satisfies: REQ-2
  - Changes: skills/dispatch/references/spec-stage.md, docs/decisions/0014-ground-first-intent-and-evidence-based-level.md, skills/dispatch/README.md, tests/integration/skill-contract.test.ts
  - Tests: tests/integration/skill-contract.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="spec stage critiques the request premise before confirmation" tests/integration/skill-contract.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="spec stage critiques the request premise before confirmation" tests/integration/skill-contract.test.ts`
  - Evidence: red

  </details>
- [SC2] Retro notes merge inline with no utility launch; schema, limits, exclusions and the non-gate rule stay; raw-source investigation follows the context guard.
  <details>

  - Satisfies: REQ-3
  - Changes: skills/dispatch/references/diagnostics.md, skills/dispatch/SKILL.md, skills/dispatch/references/readme/concepts.md, skills/dispatch/references/readme/configuration.md, skills/dispatch/references/readme/troubleshooting.md, skills/dispatch/README.md, skills/dispatch/config.sample.jsonc, docs/decisions/0015-native-subagent-routing.md, tests/integration/diagnostics-contract.test.ts, tests/integration/skill-contract.test.ts
  - Tests: tests/integration/diagnostics-contract.test.ts, tests/integration/skill-contract.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/integration/diagnostics-contract.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/integration/diagnostics-contract.test.ts`
  - Evidence: red

  </details>
- [SC3] Rendered code, plan and design review prompts point to the criteria below and contain no `quality-bar.md` link, with unchanged selected sections.
  <details>

  - Satisfies: REQ-4
  - Changes: skills/dispatch/references/templates/review-prompt-code.md, skills/dispatch/references/templates/review-prompt-plan.md, skills/dispatch/references/templates/review-prompt-design.md, tests/fixtures/review-prompt-golden/code.md, tests/fixtures/review-prompt-golden/plan.md, tests/fixtures/review-prompt-golden/design.md, tests/unit/toolkit/domain/prompt.test.ts, tests/integration/domain-templates.test.ts
  - Tests: tests/unit/toolkit/domain/prompt.test.ts, tests/integration/domain-templates.test.ts, tests/fixtures/review-prompt-golden/code.md, tests/fixtures/review-prompt-golden/plan.md, tests/fixtures/review-prompt-golden/design.md
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="assembles prompt matching golden per review kind" tests/unit/toolkit/domain/prompt.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="assembles prompt matching golden per review kind" tests/unit/toolkit/domain/prompt.test.ts`
  - Evidence: red

  </details>
- [SC4] Each inventoried rule (C1–C7) survives in one home; restating references link to it.
  <details>

  - Satisfies: REQ-1
  - Changes: skills/dispatch/references/decision-frame.md, skills/dispatch/references/toolkit.md, skills/dispatch/references/verbs/implement.md, skills/dispatch/references/spec-stage.md, tests/integration/skill-contract.test.ts
  - Tests: tests/integration/skill-contract.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="review continuation and ceiling rules have one canonical home" tests/integration/skill-contract.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="review continuation and ceiling rules have one canonical home" tests/integration/skill-contract.test.ts`
  - Evidence: red

  </details>
- [SC5] The walkthrough carries a before/after UTF-8 byte table for changed orchestrator-loaded references, the three golden prompts and a rendered writer brief, plus mandated launch and exchange counts per verb, from stored `.scratch/` output.
  <details>

  - Satisfies: REQ-5
  - Verify: `node scripts/brief-size.ts skills/dispatch/SKILL.md skills/dispatch/references/readme/concepts.md skills/dispatch/references/templates/review-prompt-code.md skills/dispatch/references/templates/review-prompt-plan.md skills/dispatch/references/templates/review-prompt-design.md skills/dispatch/references/spec-stage.md skills/dispatch/references/diagnostics.md skills/dispatch/references/decision-frame.md skills/dispatch/references/toolkit.md skills/dispatch/references/verbs/implement.md tests/fixtures/review-prompt-golden/code.md tests/fixtures/review-prompt-golden/plan.md tests/fixtures/review-prompt-golden/design.md`
  - Evidence: review
  - Review: artifact: session `sizes-before.txt`, `sizes-after.txt` and the walkthrough; scenario: after integration the orchestrator (1) writes each Verify path at commit `8c9729a` with `git show 8c9729a:<path>` into session `.state/sizes-before/` and runs `node scripts/brief-size.ts` on those copies into `sizes-before.txt`; (2) runs the Verify command on the integrated tree into `sizes-after.txt`; (3) measures the T1 writer brief rendered by `brief render` (writer-brief template unchanged, so one size serves before and after); (4) counts mandated launches and user exchanges per verb from `skills/dispatch/references/spec-stage.md`, `skills/dispatch/references/diagnostics.md` and `skills/dispatch/references/verbs/*.md` at both commits; pass: every listed file and the brief have before and after bytes, the changed-file total shrinks, and the walkthrough states launch and exchange counts per verb before and after
  - Integration: measures files from both tasks after integration

  </details>

## Verification Plan
- Seams: tests/integration/skill-contract.test.ts, tests/integration/diagnostics-contract.test.ts, tests/integration/domain-templates.test.ts, tests/unit/toolkit/domain/prompt.test.ts, tests/integration/structural-targets.test.ts
### Automated Tests
- `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/integration/skill-contract.test.ts`
- `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/integration/domain-templates.test.ts`
- `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/unit/toolkit/domain/prompt.test.ts`
- `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/integration/structural-targets.test.ts`
- `node scripts/generate-hashes.ts --check`
- `node scripts/check-terms.ts`
### Manual Verification
- Run `npm test` on the integrated tree; judge it against the baseline timing-budget failure (spec DEC-9): all tests pass and only per-file timing lines fail.
- Run `npm run test:e2e` once on the integrated tree.

## Rollback & Blast Radius
- Inspected and unchanged: `skills/dispatch/scripts/toolkit/diagnostics.ts:396` instruction string ("merge retro observations") stays accurate; `skills/dispatch/references/grounding.md:13` scope round after `confirm` is unchanged; `skills/dispatch/references/decision-frame.md:22` Spec approval template still applies to the combined exchange.
- Rollback: revert the delivered diff; no data or ledger format changes.

## Review Findings & Resolutions
*No reviews conducted yet.*
