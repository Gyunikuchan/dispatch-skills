# Drop host-model demotion from delegate ordering

## At a Glance

- **What:** Unpinned delegate ordering keeps the host platform last but stops ranking the host's own model below the platform's other models.
- **How it works:** `demote()` returns two groups (other platforms, then host platform) instead of three; the unused same-model helpers go away.
- **Counts:** 3/3 criteria (verified 3 · manual 0 · waived 0 · missing 0); 4 files (0 new · 4 modified · 0 deleted); 0 recorded edits; 0 unplanned paths; 0 open escalations; 0 deferred rulings; 0 findings (0 open)

## Visuals

None.

## Review Focus

- Risk: low
- Waived criterion contract — see Verification

## Behaviour Changes

### T1 — Two-group demotion

- With an orchestrator, `demote()` returns non-host-platform candidates (diversity-sorted when `sort`), then all host-platform candidates (diversity-sorted when `sort`, which keeps config order for one provider).
- `isSameModel()` and `normalizeModelId()` are deleted; README and the roster test describe the new order.

<details>

- `README.md` · modified
- `skills/dispatch/scripts/policy/roster.ts` · modified
- `skills/dispatch/skill-hashes.json` · modified
- `tests/unit/policy/roster.test.ts` · modified

</details>

## Verification

- **Status:** exceptions recorded

### Waived

- contract · Reason: npm test: all 762 tests pass; only the pre-existing per-file 1.00s timing budget fails on unrelated tests/unit/toolkit files in this container, same as baseline before edits.; quote: Waive

## Deviations & Follow-ups

None.

## Review Findings & Resolutions

- Round 1 (code-integration): 0 findings — [findings](.state/reviews/code-integration/round-1/findings.json)

## Appendix

<details>

<summary>Audit records</summary>

### Provenance

- Spec: .scratch/dispatch-skills/20261104T1323Z-remove-same-model-as-host-de-prioritizat/host-model-demotion.spec.md · sha256:ee8c56e7c26b
- Plan: .scratch/dispatch-skills/20261104T1323Z-remove-same-model-as-host-de-prioritizat/host-model-demotion.plan.md · sha256:74de71ddfc73
- Integration: source 89bba13c9af6f63cef141f99982c02d27c28a720 · branch ccr-d196cc13-f6lxsw · ref refs/dispatch/a1b68311809f/delivered-source

### Verified Evidence

| SC | Evidence |
| --- | --- |
| SC1 | .state/evidence/ba2af305d63a8bd4ada379f5888d9ce49df57dab6da151892ddbbc45ae4446bf.json |
| SC2 | .state/evidence/41c45a8cc31b28dc974ceb8f1d6a0686b634ce2337a055b30f8893d049ce84bd.json |
| SC3 | .state/evidence/5e90550c655d9acba7edea024a056aadc01261d50a80b0f553aa09cf62ab4466.json |

### User-Attributed Records

| Seq | Kind | Record | User quote |
| --- | --- | --- | --- |
| 1 | confirm | {"spec":"sha256:ee8c56e7c26bfbbe6715c63cfeb8953dca663868bd9b3253c15ba13839887d49"} | Confirm |
| 2 | level | {"level":"low"} | yes to all |
| 15 | waiver | {"criterion":"contract","reason":"npm test: all 762 tests pass; only the pre-existing per-file 1.00s timing budget fails on unrelated tests/unit/toolkit files in this container, same as baseline before edits."} | Waive |

</details>
