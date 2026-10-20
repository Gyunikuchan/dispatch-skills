# Clarify inline hotfix recovery ordering

> **TL;DR:** An inline decision admitted an empty candidate and reran a failing aggregate check. State edit order at the existing contract; retain runtime behavior.
>
> **Parent:** `.scratch/dispatch-skills/20261020T1548Z-investigate-verify-explain-and-propose-f/investigate-verify-explain-and-propose-f.spec.md` · sha256:80251f8eb54c5909f01fb811e96b16e9519cade1ffe079c9aa1f2c81955c8af9
>
> **Decide:** Approve this bounded proposal before product implementation.
>
> **Risk:** low — guidance and generated hashes only
>
> **Scope:** skills/dispatch/references/verbs/implement.md, skills/dispatch/skill-hashes.json

## Background
See [verified investigation](investigation.report.md). Journal seq 108–116 shows a zero-file inline hotfix followed by 498.205 seconds of unchanged failing verification. Current `beginHotfix` in `skills/dispatch/scripts/machines/implement.ts:1846` immediately snapshots inline output; writer mode prepares a brief. The 5085.507-second evidence-await interval has no intervening journal events; activity and performance cause remain unknown.

## Key Decisions & Context
- Use the existing answer contract as the canonical home for a short ordered procedure; no new runtime phase or duplicate standalone guide.
- Compare inline baseline, inline delivered failure, and writer delivered failure. Preserve existing user gates, limits, external-path reasons and admission.
- H6 is an accurate elapsed measurement with unknown attribution. Retain diagnostics wording and propose no timing change (REQ-1).

## Out of Scope
- Runtime changes, new tests that assert exact prose, and timing-budget changes.
- Changes to the original session, its report, or unrelated fixture repairs.

## Task Map

| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Clarify recovery order | Hosts submit completed inline edits and launch writer repairs in the correct order | none | SC1, SC2 |

## Proposed Changes

### T1 — Clarify recovery order

- #### [MODIFY] skills/dispatch/references/verbs/implement.md
  - Changes: Add a short hotfix-order subsection adjacent to the baseline/failure answer shapes. First inspect the failing check, determine root cause and bounded paths, and satisfy any existing user/production/level gate. For inline mode, apply the bounded repair in the caller checkout before sending the matching baseline or failure DECISION; include rationale and external path reasons. Explain that the decision snapshots and admits existing edits, then verifies them, with no intervening write frame. For delivered writer mode, send the decision first, then launch the emitted writer and use taskless receipts. Point to existing scope and recovery policy instead of restating it.
  - Invariants: Preserve baseline versus delivered availability, hotfix size and single-attempt limits, external-path admission, user gates, verification, and failure preservation. An external path declaration grants no exemption from user gates. Do not imply that a retry grants new write scope or restores a withdrawn hotfix.

- #### [GENERATED] skills/dispatch/skill-hashes.json
  - Command: `npm run hashes`
  - Inputs: skills/dispatch/references/verbs/implement.md

## Success Criteria
- [SC1] Recovery guidance distinguishes inline edits before decision from writer decision before launch and preserves existing boundaries.
  - Satisfies: REQ-1, REQ-2
  - Changes: skills/dispatch/references/verbs/implement.md
  - Evidence: review
  - Enforcement infeasibility: This criterion changes only agent instructions. Deterministic prose assertions cannot prove that a host follows the sequence; the runtime admission and limits remain enforced by existing code and tests.
  - Test rationale: Exact-text tests would mirror prose; bounded scenario inspection verifies action order against the unchanged machine contract.
  - Review: artifact: skills/dispatch/references/verbs/implement.md; scenario: walk baseline inline, delivered inline, delivered writer, external path requiring user gate, and withdrawn hotfix; pass: each route names correct order without adding authority, resetting limits, or promising a write frame for inline mode.
- [SC2] Generated hashes and repository checks pass after the guidance change.
  - Satisfies: REQ-3
  - Changes: skills/dispatch/skill-hashes.json
  - Verify: `npm test` [FINAL]
  - Evidence: verify
  - Test rationale: Existing aggregate checks enforce hashes, types, diagrams and repository contracts; no new test is needed for unchanged runtime behavior.

## Verification Plan
- Seams: none

### Automated Tests
- `git diff --check`

### Manual Verification
- Perform SC1 scenario inspection against current beginHotfix and recovery handling before submission.
- Run the generator, then the unchanged final npm test gate. Failed required checks stay open.
- Confirm only the two scoped product paths changed and the investigation dispositions remain supported.

## Rollback & Blast Radius
Only hosts reading implementation guidance are affected. Revert the guidance and regenerate hashes to reverse. No interfaces, data, dependencies or machine transitions change.

## Review Findings & Resolutions
No reviews conducted yet.
