---
{
  "dispatch": {
    "schemaVersion": 1,
    "kind": "code",
    "slug": "refactor",
    "invocationId": "ffda6691-d2c0-43bf-b82f-8dc7e18a7f7e",
    "baseSha": "0140746fff25e5cc18e78ab7dc39be7815700f4e",
    "headSha": "0140746fff25e5cc18e78ab7dc39be7815700f4e",
    "worktreeHash": "sha256:8ffa094970e8f67375f6066bc6c4123467c58754704618db86f9fa1bfddde4a6",
    "contentHash": "sha256:44f5964718d5d96d7c5328244e1ca70876c5165c10076b8147de59266397d5a2",
    "pathHashes": {
      "skills/dispatch/scripts/agy-run.mjs": "sha256:60f5875fbabc1a0bf1dd562e32baf3dfc6d708913193475f86c25bc280dc2182",
      "skills/dispatch/scripts/claude-run.mjs": "sha256:56053aba399a2523f9b9f573af8350431679f54f38d1b7c722d24e8f814843b5",
      "skills/dispatch/scripts/common.mjs": "sha256:68bf47bdeb7c5c167700cd32a22b910af15156a8518ae84093ed8d82a1b19265",
      "skills/dispatch/scripts/copilot-run.mjs": "sha256:0c0a852a55e2aca3447bbe16f904d60d0e42a91c52d40ee80c4827cd70c1ac0a",
      "skills/dispatch/scripts/dispatch.mjs": "sha256:f14f2b5a03117758fa776b662340f7f1996bde8327c556af56b46857528f3c9d",
      "skills/dispatch/scripts/opencode-run.mjs": "sha256:3c7f1a3f828aace56afeffd5367b0d1330259b205456ba2c84320f51d4e751f8",
      "skills/dispatch/skill-hashes.json": "sha256:aa0ec58518eb0893275cb8ba0d18510ef2197c6beae719383a5e7f2854b8f7b9",
      "skills/implement-dispatch/scripts/resolve-flow.mjs": "sha256:ee0e8f454f6e2d7907cce1e7e9b22fc4dfce39f9476fc827a49e5ec87d6dfd56",
      "skills/implement-dispatch/skill-hashes.json": "sha256:16630e87e100f0721aabb8f9e1765a146cf92aff9db99f8b1366edc98d9548f4",
      "tests/skills/dispatch/common.test.mjs": "sha256:e24411375f508687d302027a35a39adb7a5c6f789694c66f7188593c2c1f9dd1",
      "tests/skills/dispatch/config.test.mjs": "sha256:633c0b4e7244ce4e4517854b678465f5907a992e1af1e1dc9934b0cd05659915",
      "tests/skills/dispatch/dispatch.test.mjs": "sha256:617cf4a00423b0d3726110d7a35251b3b64503dcfcdcec9cfec2857e9e7c48e7"
    },
    "reviewedAt": "2026-09-17T08:28:21.332Z"
  }
}
---
# Walkthrough — Validate provider, model, and effort specs before invocation across dispatch and runners

Validate provider, model, and effort specs before invocation across dispatch and runners

## Changes Made

### Selected review scope
- **[MODIFY]** `skills/dispatch/scripts/agy-run.mjs` — Included in the selected review scope.
- **[MODIFY]** `skills/dispatch/scripts/claude-run.mjs` — Included in the selected review scope.
- **[MODIFY]** `skills/dispatch/scripts/common.mjs` — Included in the selected review scope.
- **[MODIFY]** `skills/dispatch/scripts/copilot-run.mjs` — Included in the selected review scope.
- **[MODIFY]** `skills/dispatch/scripts/dispatch.mjs` — Included in the selected review scope.
- **[MODIFY]** `skills/dispatch/scripts/opencode-run.mjs` — Included in the selected review scope.
- **[MODIFY]** `skills/dispatch/skill-hashes.json` — Included in the selected review scope.
- **[MODIFY]** `skills/implement-dispatch/scripts/resolve-flow.mjs` — Included in the selected review scope.
- **[MODIFY]** `skills/implement-dispatch/skill-hashes.json` — Included in the selected review scope.
- **[MODIFY]** `tests/skills/dispatch/common.test.mjs` — Included in the selected review scope.
- **[MODIFY]** `tests/skills/dispatch/config.test.mjs` — Included in the selected review scope.
- **[MODIFY]** `tests/skills/dispatch/dispatch.test.mjs` — Included in the selected review scope.

## Verification & Validation
### Automated Tests
- Command: `npm test` — 1247 passed, 0 failed, 3 skipped
### Manual Verification
- None recorded.

## Key Deviations
None.

## Review Findings & Resolutions

### Round 1 — Claude, 2026-09-17

- **[Accepted]** skills/implement-dispatch/scripts/resolve-flow.mjs:L397 — coupling: hand-rolled model/effort checks diverge from common.mjs validators → delegated validateCandidateObject and validateSinglePlatformEntry to validateModelSpec and validateEffortSpec.
- **[Accepted]** skills/dispatch/scripts/common.mjs:L2205 — reuse: inline model/effort validation in validateCandidate diverges from common validators → delegated to validateModelSpec and validateEffortSpec.
- **[Accepted]** skills/dispatch/scripts/common.mjs:L152 — correctness: comma-separated models can contain empty parts → validateModelSpec now validates comma-split entries.

## Follow-ups
None.
