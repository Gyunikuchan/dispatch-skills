# Dispatch speed and cost streamlining

## At a Glance

- **What:** Cut one user round trip per spec, one subagent launch per verb handoff, a possible 13 KB reviewer read per round, and duplicated orchestrator prose; keep every rule once.
- **How it works:** T1 changes spec confirmation, retro merge and review-prompt links; T2 then replaces restated rules with links to their single home. See [Task Map](#task-map).
- **Counts:** 5/5 criteria (verified 4 · manual 1 · waived 0 · missing 0); 24 files (0 new · 24 modified · 0 deleted); 1 recorded edits; 0 unplanned paths; 0 open escalations; 0 deferred rulings; 7 findings (0 open)

## Visuals

None.

## Review Focus

- Risk: med
- Manual criterion SC5 — see Verification
- spec edit (intent) seq 10 — see Deviations & Follow-ups
- Spec stage: with grilling, the Confirm exchange is now grilling's closing confirmation (2 user exchanges -> 1). A reply that opens a decision resumes grilling, updates and lints the spec, and repeats the exchange; no edit or confirm record until accepted. Deviation: REQ-2 acceptance text names the revision protocol; approved plan (plan-review F002) limits it to the no-grilling fallback. Code-review R1-F001 rejected on this basis. — Evidence: [skills/dispatch/references/spec-stage.md](skills/dispatch/references/spec-stage.md)
- Diagnostics retro merge is inline (no utility launch); investigation of logs or chat still follows the context guard. Retro dropped from SKILL.md routing and utility lists in readme/config/ADR 0015. — Evidence: [skills/dispatch/references/diagnostics.md](skills/dispatch/references/diagnostics.md)
- Review prompts no longer link quality-bar.md (criteria are inlined below), saving one reviewer read per launch; goldens updated. — Evidence: [skills/dispatch/references/templates/review-prompt-code.md](skills/dispatch/references/templates/review-prompt-code.md)
- Seven duplicated rules (C1-C7) replaced by links to their canonical home or enforcing code; continuation/ceiling single-home check merged into the canonical-home test during cleanup (SC4 removed, verified at pre-cleanup tree). Code-review R1-F002 rejected: toolkit.md worktree commit still names test-cleanup-empty. — Evidence: [skills/dispatch/references/decision-frame.md](skills/dispatch/references/decision-frame.md)
- Net bytes of measured files 128986 -> 128496 (-490); spec-stage.md +444 for the combined exchange. Reviews ran 1 of 2 configured reviewers (underfill: only the claude provider is configured). — Evidence: [.scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sizes-after.txt](.scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sizes-after.txt)

## Behaviour Changes

### T1 — Combined confirm, inline retro, prompt links

- With `grilling`, the orchestrator authors and lints the spec when no decision is open, then presents it once; the reply is the `confirm`. A reply that opens a decision resumes grilling. Without `grilling`, the single Confirm exchange is unchanged.
- At each verb handoff with diagnostics on, the orchestrator writes its own notes to `<session>/.state/retro.json`; no subagent launches. Raw-source investigation still follows the context guard.
- Rendered code, plan and design review prompts say "the quality criteria below" and contain no `quality-bar.md` link.

<details>

- `docs/decisions/0014-ground-first-intent-and-evidence-based-level.md` · modified
- `docs/decisions/0015-native-subagent-routing.md` · modified
- `skills/dispatch/README.md` · modified
- `skills/dispatch/SKILL.md` · modified
- `skills/dispatch/config.sample.jsonc` · modified
- `skills/dispatch/references/diagnostics.md` · modified
- `skills/dispatch/references/readme/concepts.md` · modified
- `skills/dispatch/references/readme/configuration.md` · modified
- `skills/dispatch/references/readme/troubleshooting.md` · modified
- `skills/dispatch/references/spec-stage.md` · modified
- `skills/dispatch/references/templates/review-prompt-code.md` · modified
- `skills/dispatch/references/templates/review-prompt-design.md` · modified
- `skills/dispatch/references/templates/review-prompt-plan.md` · modified
- `skills/dispatch/skill-hashes.json` · modified
- `tests/fixtures/review-prompt-golden/code.md` · modified
- `tests/fixtures/review-prompt-golden/design.md` · modified
- `tests/fixtures/review-prompt-golden/plan.md` · modified
- `tests/integration/diagnostics-contract.test.ts` · modified
- `tests/integration/domain-templates.test.ts` · modified
- `tests/integration/skill-contract.test.ts` · modified
- `tests/unit/toolkit/domain/prompt.test.ts` · modified

</details>

### T2 — Single home for restated rules

- The orchestrator reads each review continuation, ceiling, writer-boundary, test-cleanup-empty and approval-tuple rule once; other references link to that home. Apply exactly the REQ-1 deletion inventory C1–C7.

<details>

- `skills/dispatch/references/decision-frame.md` · modified
- `skills/dispatch/references/spec-stage.md` · modified
- `skills/dispatch/references/toolkit.md` · modified
- `skills/dispatch/references/verbs/implement.md` · modified
- `skills/dispatch/skill-hashes.json` · modified
- `tests/integration/skill-contract.test.ts` · modified

</details>

## Verification

- **Status:** exceptions recorded
- **Test cleanup:** deleted 0 · merged 1 tests after verification at f65200a0b21e; criteria with tests removed: SC4

### Manual

- SC5 · User evidence: .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sizes-before.txt .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sizes-after.txt .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sc5-counts.md: changed-file total 128986 -> 128496 B; writer brief 35175 B; per-verb launch and exchange counts recorded; quote: Approve

## Deviations & Follow-ups

- Deviation: spec edit (intent) seq 10: User ruling 'Agree to both': drop visual-aid compaction (DEC-10); keep inline retro merge and update ADR 0015 (DEC-11). Confirmed as confirm:spec:2.; diff .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/.state/spec-rev1.diff; affects none

## Review Findings & Resolutions

| Review | ID | Round | Severity | Source | Status | Ruling |
| --- | --- | --- | --- | --- | --- | --- |
| code-integration | R1-F001 | 1 | CONSIDER | claude-sonnet-5-5/high | Rejected | Approved plan (plan-review ruling F002) resolved pre-confirm changes this way: … |
| code-integration | R1-F002 | 1 | CONSIDER | claude-sonnet-5-5/high | Rejected | Claim that the refusal name is absent from every reference is false: toolkit.md… |
| plan-dispatch-speed-cost.plan | R1-F001 | 1 | SHOULD | claude-sonnet-5-5/high | Accepted | Verified: current file is 1,021 B CRLF and the proposed text exceeded 1,024. Pl… |
| plan-dispatch-speed-cost.plan | R1-F002 | 1 | SHOULD | claude-sonnet-5-5/high | Accepted | Verified: revision protocol assumes a confirmed spec. Grilling branch now updat… |
| plan-dispatch-speed-cost.plan | R1-F003 | 1 | SHOULD | claude-sonnet-5-5/high | Accepted | Verified at configuration.md:91 and ADR 0015:13. Both added to T1; T1 runs a re… |
| plan-dispatch-speed-cost.plan | R1-F004 | 1 | SHOULD | claude-sonnet-5-5/high | Accepted | Verified: no baseline capture was named. SC5 Review now names the orchestrator … |
| plan-dispatch-speed-cost.plan | R1-F005 | 1 | CONSIDER | claude-sonnet-5-5/high | Accepted | Accepted: step 2 now names grilling's closing shared-understanding confirmation… |

- Round 1 (code-integration): 2 findings — [findings](.state/reviews/code-integration/round-1/findings.json)

- Round 1 (plan-dispatch-speed-cost.plan): 5 findings — [findings](.state/reviews/plan-dispatch-speed-cost.plan/round-1/findings.json)

- Round 2 (plan-dispatch-speed-cost.plan): 0 findings — [findings](.state/reviews/plan-dispatch-speed-cost.plan/round-2/findings.json)

## Appendix

<details>

<summary>Audit records</summary>

### Provenance

- Spec: .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/dispatch-speed-cost.spec.md · sha256:cd5c4b52c21d
- Plan: .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/dispatch-speed-cost.plan.md · sha256:ed3e5ab06e4c
- Integration: source 1f878081da0034af68063a2e04debdd13fb39577 · branch v0.8.3 · ref refs/dispatch/5c94e53462f0/delivered-source

### Verified Evidence

| SC | Evidence |
| --- | --- |
| SC1 | .state/evidence/ff729f3bd205c9b1d8ffe7ae8b7d0a1f05b74927c8e94b9f3bc85e21c4da9c46.json |
| SC2 | .state/evidence/027345966d1cda4911eb7f62315b3ad224c6ddcdfe485d9bed687e3b32b36ba6.json |
| SC3 | .state/evidence/07c4ed54c4a393abf3375fc6bb03a05176e98ecc2ca25dcbdae2f244617dec90.json |
| SC4 | [source evidence](.state/evidence/222a855b1350eafb3361d36456221f82e7f05c178933bc0479ae1bb7558265bd.json); verified at f65200a0b21e9b2866fc331aedfad4d7c35db9d7; tests removed in cleanup |
| contract | .state/evidence/ec878c04f4b3785d9e4046fd31a9fb98de013f2c92596dc350dd3ce6cc7e7054.json |

### User-Attributed Records

| Seq | Kind | Record | User quote |
| --- | --- | --- | --- |
| 1 | confirm | {"spec":"sha256:ecb2a96d75de002bd9967882a71ad6a3f7a4112ace3da2fe29025d71a120091e"} | Confirm |
| 2 | confirm | {"spec":"sha256:cd5c4b52c21d3aae248b063c8066f9122ce5ef89704be06a9f68f38230e0ebee"} | Agree to both |
| 3 | level | {"level":"medium"} | Approved |
| 11 | approval | {"spec":"sha256:cd5c4b52c21d3aae248b063c8066f9122ce5ef89704be06a9f68f38230e0ebee","plan":"sha256:ed3e5ab06e4c92e017a56ccfa81d041078088cb9402289f31ae5f6141be4bf0b"} | Approve |
| 34 | manual-complete | {"criterion":"SC5","evidence":".scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sizes-before.txt .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sizes-after.txt .scratch/dispatch-skills/20261104T1118Z-make-dispatch-faster-and-cheaper-while-p/sc5-counts.md: changed-file total 128986 -> 128496 B; writer brief 35175 B; per-verb launch and exchange counts recorded"} | Approve |

</details>
