---
{
  "dispatch": {
    "schemaVersion": 1,
    "kind": "plan",
    "slug": "upsert-scratch-dispatch-skills-gitignore",
    "invocationId": "af6cc228-93ee-4b56-989c-cdcffa7a91fa",
    "contentHash": "sha256:1538dd024438e4aad3efbdd39ea08c065a8ab956d43bbf930e00b5ea7b0ebe95",
    "sectionHashes": {
      "__preamble__": "sha256:f2e3ee9ffe81928d45075d547447f5c1f7412227e97668097c77621c52f2dc64",
      "Key Decisions & Context": "sha256:3043cc895449ab1bee7b14c30c143b603d0d5ba7894af076cd77ee4af016fb2d",
      "User Review Required": "sha256:ff13ac360899fcf81a0c84655b4d2bf10e9043f70f3e5f66d400bdd0aed2178a",
      "Open Questions & Assumptions": "sha256:db2b70aae3db1429fa3a45f6a6086338970ca0f3eaf15955554c90f8505a894b",
      "Success Criteria": "sha256:edb7f99d6c583462bb195e23dfef127c79b4a9c2889aeef289ca057addd1ff4a",
      "Proposed Changes": "sha256:7e767fd72c76f08e5bd2f6d6b5d8f0c4f3b6fadd3a9bf83cdf1fa3e955197971",
      "Rollback & Blast Radius": "sha256:d6c0d684d0ef2bd5b43baa3bbe6131bec6dcdfb17d1960f605404df1ecef9a24",
      "Verification Plan": "sha256:bd3f79c802ab67242875404b1d61ac35df739cc9dd39ed3cbb64a736fb6ca67c",
      "Out of Scope": "sha256:f3b41969b176ae2e258cf8db02a7314b07effb4cfe9d8f573ee23390706f2fc6"
    },
    "reviewedAt": "2026-09-28T08:50:04.646Z"
  }
}
---
# Upsert workspace session-root .gitignore

> **TL;DR:** Host repositories get `.scratch/dispatch-skills/` created with no ignore rules, so run state can be committed. Make `workspaceSessionRoot` upsert a canonical `.gitignore` that keeps only chat deliverables trackable.
> **Decide:** none
> **Risk:** low — one idempotent file write in an existing helper
> **Scope:** skills/dispatch/scripts/lib/session-lifecycle.mjs

## Key Decisions & Context
- Upsert on every `workspaceSessionRoot` call (create when missing, rewrite when content differs), not only on first mkdir: repairs stale or deleted files and keeps rules current across skill upgrades. Rejected: create-only (drifts after upgrades).
- Canonical content equals this repository's tracked `.scratch/dispatch-skills/.gitignore`, so the repo's copy stays unchanged.
- Skip the write when content already matches to avoid mtime churn.

## User Review Required
None.

## Open Questions & Assumptions
- Assumes host-customized rules in this file are not preserved (the file is dispatch-owned inside dispatch's own scratch root).

## Success Criteria
- [SC1] `workspaceSessionRoot` creates `.scratch/dispatch-skills/.gitignore` with canonical content when missing and restores it when content differs.
  - Changes: skills/dispatch/scripts/lib/session-lifecycle.mjs, tests/skills/dispatch/lib/session-lifecycle.test.mjs
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="upserts session-root gitignore" tests/skills/dispatch/lib/session-lifecycle.test.mjs`
  - Evidence: red
  - Test rationale: Asserts observable file content after calling the public helper on a temp repo; fails today because no file is written, and is deterministic with no timing or platform dependence.

## Proposed Changes

### Session lifecycle

#### [MODIFY] skills/dispatch/scripts/lib/session-lifecycle.mjs
- Changes: add `SESSION_ROOT_GITIGNORE` constant (content of the repo's tracked file) and write it to `<base>/.gitignore` in `workspaceSessionRoot` when missing or different.
- Invariants: return value and directory safety checks unchanged; published (OS temp) root unaffected.

#### [MODIFY] tests/skills/dispatch/lib/session-lifecycle.test.mjs
- Changes: add test "upserts session-root gitignore": fresh repo → file created with deliverable allow-list; overwritten with junk → restored on next call.

## Rollback & Blast Radius
Revert the helper change; callers unaffected.

## Verification Plan
### Automated Tests
- `npm test`
### Manual Verification
- None.

## Review Findings & Resolutions
<!-- dispatch-review-budget {"schemaVersion":1,"phase":"plan-review","budgetId":"001-implement:plan-review","reviewWaves":1,"roundLimit":2} -->

### Round 1 — 2026-09-28
- **Sources:** {"plan-review:R1:agy:0":{"candidateIndex":0,"effort":"medium","model":"gemini-3.7-flash","provider":"agy","session":null,"status":"target","substitutesFor":null}}
- failed-targets: []

## Out of Scope
Published temp root ignore rules.
