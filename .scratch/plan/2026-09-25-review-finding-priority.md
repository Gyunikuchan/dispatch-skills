---
{
  "dispatch": {
    "schemaVersion": 1,
    "kind": "plan",
    "slug": "review-finding-priority",
    "invocationId": "c0b67a59-95b0-4aa7-885e-a57cf48dc03e",
    "contentHash": "sha256:5cc322534d41f30bd40c841aeaea9f478b0a27800dc8118b8798588138991ac1",
    "sectionHashes": {
      "__preamble__": "sha256:cb485c68358cf26cc58975254751462808372ac0acc7cefe7b1f3f0a7fe68cf1",
      "Key Decisions & Context": "sha256:d04e229304d2661b8476bc91a6781972ad806d0c021d3412398807e461f85328",
      "User Review Required": "sha256:cf47c5d693afccdcd126536a3fe63d6d44c2b9a9c5ef4027f98348e6d8e2fa99",
      "Open Questions & Assumptions": "sha256:daaa1b515012b135e50d169a567a7ef1508799a26211a30a6389d9cd40914a08",
      "Success Criteria": "sha256:fe5ced29de0e2273797c8563e33b1f5bcbca07d9b27f6edaaa3cee74f819fea9",
      "Proposed Changes": "sha256:fe89088532f60074105614d4c6a202b6c02fa41a91ad9f3ee23da9146499c6ad",
      "Rollback & Blast Radius": "sha256:84ecc45af4f3a02c295cc0d0cec12f28a32fcd63c6150bf5590a2725325b7ad0",
      "Verification Plan": "sha256:a02db61625da43a45a575a697feb0f9ed9837b6426d73dea82e8c5f83d345cc8",
      "Out of Scope": "sha256:67107e9a145b772a56c09ab959ebead5139198cb21adb1c9ee4b8712d18a347f"
    },
    "reviewedAt": "2026-09-25T05:03:08.147Z"
  }
}
---
# Make review finding priorities consistent without SHOULD-only review rounds

Reviewer agents currently assign MUST/SHOULD/CONSIDER without a shared classification rule. The parser accepts any of the three labels, and the review driver starts another within-cap wave for SHOULD alone. Align code, plan, and design reviewers on resolution priority, preserve host evidence-based rulings, and make only MUST trigger severity-driven review continuation.

## Key Decisions & Context

- Approved design: `docs/superpowers/specs/2026-09-25-review-finding-priority-design.md`.
- The user chose action priority rather than confidence or impact. MUST blocks the promised outcome or violates a binding constraint; SHOULD is a real defect requiring resolution but not another review round; CONSIDER is host-adjudicated optional advice.
- The same compact classification appears in every assembled delegate prompt via the shared frame, while the host-facing review contract owns adjudication rules. Keep existing report JSON, parser, log format, and consensus contracts.
- Accepted in-scope MUST/SHOULD under `--fix` remain in the immediate fix queue. Report-only reviews record accepted findings without changing production files. Rejected/downgraded MUST/SHOULD still get confirmation under consensus; inconclusive disputes go to the user. Fix-induced content changes still trigger a review wave.
- Existing user-owned staged `.scratch/plan/2026-09-25-all-target-native-review-accountability*.md` files are unrelated and must remain untouched.

## User Review Required

None; the design decisions above were approved. Review this plan before invoking `/dispatch-implement`.

## Open Questions & Assumptions

- An accepted SHOULD in a report-only review is a documented unfixed finding, not permission to write code.
- The historical test expecting SHOULD to start a second within-cap round is intentionally inverted; MUST and fix-induced changed-state coverage remain unchanged.

## Success Criteria

- [SC1] Code, plan, and design delegate prompts contain the same verifiable classification rubric and consequences; host guidance follows the same rubric without duplicating kind-specific text.
  - Changes: `skills/dispatch/references/templates/review-prompt.md`, `skills/dispatch/references/review.md`, `skills/dispatch/scripts/driver/review-phase.mjs`, `tests/skills/dispatch/review/fill-template.test.mjs`, `tests/fixtures/review-prompt-golden/review-prompt-plan.md`, `tests/fixtures/review-prompt-golden/review-prompt-code.md`, `tests/fixtures/review-prompt-golden/review-prompt-design.md`
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="(assembled (code|plan|design) prompts carry shared severity rubric|assembles the (plan|code|design) review prompt to its whitespace-normalized golden)" tests/skills/dispatch/review/fill-template.test.mjs`
  - Evidence: red
  - Test rationale: Assembling all three real kind blocks against the shared frame prevents one reviewer kind silently missing the contract; assertions focus on the semantic labels and decisive wording, not the entire prompt.
- [SC2] A verified SHOULD-only review settles without another severity-driven round or extension prompt, including within the initial cap; a MUST still triggers another round or cap extension.
  - Changes: `skills/dispatch/scripts/driver/review-phase.mjs`, `skills/dispatch/references/review.md`, `tests/skills/dispatch/driver/scripted.test.mjs`
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="(SHOULD alone|report-only accepted MUST|extends twice at cap-sized increments)" tests/skills/dispatch/driver/scripted.test.mjs`
  - Evidence: red
  - Test rationale: The renamed SHOULD-only test goes red against the old trigger. Existing MUST extension coverage checks within-cap rounds 1–3 and the preserved cap path; no duplicate MUST-only test.
- [SC3] SHOULD remains actionable: under `--fix` an accepted in-scope finding queues a fix; report-only acceptance writes no production fix; under consensus a rejected/downgraded SHOULD requires source confirmation or user ruling. A fix-induced change still triggers re-review.
  - Changes: `skills/dispatch/references/review.md`, `skills/dispatch/scripts/driver/review-phase.mjs`, `skills/dispatch/references/templates/walkthrough.md`, `skills/dispatch/scripts/review/prepare-code.mjs`, `tests/skills/dispatch/driver/scripted.test.mjs`
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="(SHOULD fix|SHOULD report-only|requires rulings for disputed SHOULD|SHOULD confirmation|fix-induced review)" tests/skills/dispatch/driver/scripted.test.mjs`
  - Evidence: verify
  - Test rationale: Characterizes existing consensus and fix behavior before and after the trigger change; these tests are green at baseline and guard against regressions, not RED gates.

## Proposed Changes

### Shared delegate and host contracts

#### [MODIFY] skills/dispatch/references/templates/review-prompt.md
- Changes: Add one short priority rubric in the shared prompt before the JSON reply, defining MUST/SHOULD/CONSIDER in terms of promised outcomes and binding constraints. Instruct delegates to state concrete consequence at a cited locus in `defect` and the remedy in `requiredChange`; tags remain kind-specific.
- Invariants: Same schema, no claim of machine-verified severity, no split definitions across kind blocks. Replace redundant wording elsewhere in this frame so its agent-contract word count is net-neutral or shorter.

#### [MODIFY] skills/dispatch/references/review.md
- Changes: Apply the shared-frame priority rubric when host-adjudicating labels without copying its definitions. Amend the immediate-action sentence to include accepted in-scope SHOULD alongside MUST when fixes are enabled; report-only acceptance stays recorded without edits. Replace the within-cap rounds sentence with MUST-only severity continuation, preserving change-triggered review and rebuttal/cap paths.
- Invariants: Evidence outranks delegate labels; consensus confirmation for rejected/downgraded MUST/SHOULD; host-final CONSIDER; no unauthorized report-only edits. Tighten existing wording to keep this agent contract net-neutral or shorter in word count.

#### [MODIFY] skills/dispatch/scripts/driver/review-phase.mjs
- Changes: In `nextStep`, collapse the within-cap ternary (`hasMust || hasShould` versus `hasMust`) to `!state.finalDone && hasMust`; remove now-unneeded SHOULD trigger local. Retain independent `state.changed` review transition. Update the Follow-ups placeholder matcher alongside the walkthrough template. If necessary, add one short branch-specific adjudication guidance line pointing to the shared rubric without copying it.
- Invariants: SHOULD remains in `writeRound` fix queue and `statusLabel` consensus handling; cap extensions still require MUST; invalid or disputed findings do not silently settle.

### Targeted regression tests

#### [MODIFY] tests/skills/dispatch/review/fill-template.test.mjs
- Changes: Add `assembled (code|plan|design) prompts carry shared severity rubric`, assembling the real frame with all three blocks and checking all labels and the concrete-consequence instruction. Preserve the existing three `assembles the (plan|code|design) review prompt to its whitespace-normalized golden` tests.

#### [MODIFY] tests/fixtures/review-prompt-golden/review-prompt-plan.md
- Changes: Regenerate the plan fixture's fenced prompt by assembling the modified shared frame with the unchanged plan block using `assembleTemplate` in `skills/dispatch/scripts/review/fill-template.mjs`; retain its existing header and the union of the frame and kind-block variable bullets in their present order.

#### [MODIFY] tests/fixtures/review-prompt-golden/review-prompt-code.md
- Changes: Regenerate the code fixture's fenced prompt using the same `assembleTemplate` procedure with the unchanged code block; retain header and union of variable bullets.

#### [MODIFY] tests/fixtures/review-prompt-golden/review-prompt-design.md
- Changes: Regenerate the design fixture's fenced prompt using the same `assembleTemplate` procedure with the unchanged design block; retain header and union of variable bullets.

#### [MODIFY] tests/skills/dispatch/driver/scripted.test.mjs
- Changes: Rename `continues SHOULD inside the initial cap, then settles on a clean round` to `SHOULD alone settles inside the initial cap without another review`; invert review rounds from `[1, 2]` to `[1]`. Characterize baseline behavior with `SHOULD fix queues immediate application`, `SHOULD report-only records without applying`, `SHOULD confirmation settles rejected finding`, and `fix-induced review still runs`. Reuse existing `report-only accepted MUST reaches the cap and requires a stop or extension decision`, `extends twice at cap-sized increments; SHOULD in extension ends without prompting` (covers within-cap MUST rounds 1–3), and `requires rulings for disputed SHOULD without an extension prompt`. Assert each focused selector's summary reports a nonzero selected-test count; reuse existing driver fixtures.

#### [MODIFY] skills/dispatch/references/templates/walkthrough.md
- Changes: Replace the obsolete SHOULD-FIX follow-up label with SHOULD while keeping the existing optional unapplied-items bucket and one-line reason.

#### [MODIFY] skills/dispatch/scripts/review/prepare-code.mjs
- Changes: Match the new walkthrough follow-up placeholder exactly when initializing a code-review walkthrough to `None.`; keep the remaining replacements unchanged.

#### [GENERATED] skills/dispatch/skill-hashes.json
- Command: `npm run hashes`

## Rollback & Blast Radius

Shared prompt affects all three review kinds; driver behavior affects their review continuation, not output schemas or unrelated phases. Revert prompt/reference, trigger and tests together to restore the previous behavior. Existing resolution logs and run-state payloads remain readable; no migration or dependencies.

## Verification Plan

### Automated Tests
- `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="(assembled (code|plan|design) prompts carry shared severity rubric|assembles the (plan|code|design) review prompt to its whitespace-normalized golden)" tests/skills/dispatch/review/fill-template.test.mjs`
- `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="(SHOULD alone|report-only accepted MUST|extends twice at cap-sized increments|SHOULD fix|SHOULD report-only|requires rulings for disputed SHOULD|SHOULD confirmation|fix-induced review)" tests/skills/dispatch/driver/scripted.test.mjs`
- `npm test` [FINAL] after all changes; includes the assembled-prompt golden tests. If skill hashes drift, regenerate and rerun the suite.
- For each focused test command above, confirm the reporter summary names at least one selected, passing test; a zero-selection success is not evidence.
- A pre-existing schema test can fail with EISDIR by treating the existing .claude directory in the driver schema folder as a JSON file; report the baseline failure without changing that directory.

### Manual Verification
- Inspect the generated prompts for all three kinds and ensure definitions match host adjudication guidance.
- Walk through SHOULD-only accepted/rejected/uncertain outcomes with consensus both on and off; verify no severity-driven re-review, while rebuttal, user ruling and authorized fix paths remain accessible.
- Check repository diff excludes user-owned staged `.scratch/` files and unapproved runtime/schema changes.

## Review Findings & Resolutions
### Round 1 — 2026-09-25
- **Sources:** {"plan-review:R1:claude:0":{"provider":"claude","candidateIndex":0,"model":null,"effort":"low","status":"target","session":null,"substitutesFor":null}}
- **[Accepted]** [R1-F001] [MUST] [sources=plan-review:R1:claude:0] § Targeted regression tests — verification: Shared prompt changes invalidate all three existing assembled-prompt golden fixtures, absent from the plan. → Add all three golden fixture paths and exact regeneration and verification steps.
  - application: {"v":1,"findingId":"R1-F001","state":"applied","scope":"in-scope","affectedPaths":[".scratch/plan/2026-09-25-review-finding-priority.md"],"dependsOn":[],"verification":[],"reason":"applied; no verification commands"}
- **[Accepted]** [R1-F002] [SHOULD] [sources=plan-review:R1:claude:0] § Shared delegate and host contracts — coherence: Host reference currently requires immediate action for accepted MUST only, contradicting the planned SHOULD fix queue. → Specify that the reference must include accepted in-scope SHOULD under authorized fixes while preserving report-only behavior.
  - application: {"v":1,"findingId":"R1-F002","state":"applied","scope":"in-scope","affectedPaths":[".scratch/plan/2026-09-25-review-finding-priority.md"],"dependsOn":[],"verification":[],"reason":"applied; no verification commands"}
- **[Accepted]** [R1-F003] [CONSIDER] [sources=plan-review:R1:claude:0] § Success Criteria — verification: Several selector alternatives have no named tests; zero-match filters can be vacuously green. → Specify matching exact test titles and selected-test-count checks in the plan.
- **[Accepted]** [R1-F004] [CONSIDER] [sources=plan-review:R1:claude:0] § Shared delegate and host contracts — standards: Adding prose to both agent contracts could violate the repository net-neutral word-count standard. → Require net-neutral tightening of each touched agent contract and a single authoritative rubric in the shared frame.

### Round 2 — 2026-09-25
- **Sources:** {"plan-review:R2:claude:0":{"provider":"claude","candidateIndex":0,"model":null,"effort":"low","status":"target","session":null,"substitutesFor":null}}
- **[Accepted]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § Success Criteria — verification: SC3 tests characterize existing fix, report-only, and consensus behavior and cannot be expected red. → Classify SC3 as verify-only regression evidence and use a discriminating RED selector only for SC2.
  - application: {"v":1,"findingId":"R2-F001","state":"applied","scope":"in-scope","affectedPaths":[".scratch/plan/2026-09-25-review-finding-priority.md"],"dependsOn":[],"verification":[],"reason":"applied; no verification commands"}
- **[Accepted]** [R2-F002] [SHOULD] [sources=plan-review:R2:claude:0] § Shared delegate and host contracts — coherence: Walkthrough follow-up template still calls accepted SHOULD items SHOULD-FIX although the new rubric has only SHOULD. → Update the exact template wording and its preparation and follow-up consumers together without changing follow-up scope.
  - application: {"v":1,"findingId":"R2-F002","state":"applied","scope":"in-scope","affectedPaths":[".scratch/plan/2026-09-25-review-finding-priority.md"],"dependsOn":[],"verification":[],"reason":"applied; no verification commands"}
- **[Accepted]** [R2-F003] [CONSIDER] [sources=plan-review:R2:claude:0] § Targeted regression tests — verification: Existing multi-round MUST extension test already covers within-cap continuation. → Reuse existing coverage rather than add duplicate MUST-only test.
- **[Accepted]** [R2-F004] [CONSIDER] [sources=plan-review:R2:claude:0] § Targeted regression tests — verification: Golden prompt fixtures lack a named generator command and the plan does not describe exact manual regeneration. → Specify assemble-and-write procedure using the existing assembly helper and preserve fixture metadata.
- **[Accepted]** [R2-F005] [CONSIDER] [sources=plan-review:R2:claude:0] § Shared delegate and host contracts — simplicity: The existing within-cap ternary becomes redundant when both branches trigger on MUST only. → Collapse the entire ternary to the MUST predicate rather than preserving dead branching.

## Out of Scope

Changing severity JSON schema, automatically judging truth or priority from finding prose, fixing unrelated baseline failures, redesigning consensus, and modifying adjacent findings or existing staged work.
