# Drop host-model demotion from delegate ordering

> **Parent:** `.scratch/dispatch-skills/20261104T1323Z-remove-same-model-as-host-de-prioritizat/host-model-demotion.spec.md` · sha256:ee8c56e7c26bfbbe6715c63cfeb8953dca663868bd9b3253c15ba13839887d49
>
> **Decide:** none
>
> **Risk:** low — one pure ordering function with direct unit coverage, one README line.
>
> **Scope:** `skills/dispatch/scripts/policy/`, `tests/unit/policy/`, `README.md`

## At a Glance
- **What:** Unpinned delegate ordering keeps the host platform last but stops ranking the host's own model below the platform's other models.
- **How it works:** `demote()` returns two groups (other platforms, then host platform) instead of three; the unused same-model helpers go away.

## Background
- `skills/dispatch/scripts/policy/roster.ts:144-151` — `demote()` builds three groups: non-host platforms, host platform without the orchestrator model, host platform with it (`isSameModel`). Each group passes through `diversitySort` when `sort` is true.
- `skills/dispatch/scripts/policy/roster.ts:87-99` — `normalizeModelId()` and `isSameModel()`; `demote()` is their only caller.
- `skills/dispatch/scripts/toolkit/fanout.ts:189,194` — reads `orchestrator.model` for native responder records; unchanged.
- `tests/unit/policy/roster.test.ts:41-45` — `grammar-diversity-sort` asserts the three-group order.
- `README.md:13` — states "your host platform and active model last".

## Key Interfaces & Data
- Before: `codex[0]:gpt-5, agy[0]:gemini-pro, codex[1]:gpt-5-mini, claude[0]:claude-sonnet, claude[1]:claude-opus` (host `claude` on `claude-opus-20260101`).
- After: `codex[0]:gpt-5, agy[0]:gemini-pro, codex[1]:gpt-5-mini, claude[0]:claude-opus, claude[1]:claude-sonnet`.
- Roster-local `Orchestrator` (`skills/dispatch/scripts/policy/roster.ts:107`) becomes `{ platform: string }`. The `lib/platform.ts` `Orchestrator` keeps `model`; `fanout.ts` passes that wider object, which still type-checks.

## Key Decisions & Context
- Host-platform group keeps configured order, no model check (spec DEC-1).
- Delete `isSameModel()` and `normalizeModelId()` (spec DEC-2).
- Level `low` (spec DEC-3).
- Drop the roster-local `Orchestrator.model` field: after the change it has no reader in `roster.ts` (spec DEC-2, remove dead references). Spec REQ-2's retained `Orchestrator.model` is the `lib/platform.ts` type.
- Narrowed re-review (`skills/dispatch/references/review-rules.md:20`) and `-m`/`-e` collapse take the first host-platform candidate; that now means the first configured host model. The rule text is model-agnostic, so no doc edit.

## Constraints
- Do not change pinned ordering, `collapse()`, liveness filtering, native-only filtering or `diversitySort()`.
- Keep `Orchestrator.model` in `skills/dispatch/scripts/lib/platform.ts`; `fanout.ts` reads it.
- Update the `demote()` doc comment to the two-group rule.

## Task Map

| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Two-group demotion | Host platform ranks last in config order; same-model code and docs removed | none | SC1, SC2, SC3 |

## Proposed Changes

### T1 — Two-group demotion
- With an orchestrator, `demote()` returns non-host-platform candidates (diversity-sorted when `sort`), then all host-platform candidates (diversity-sorted when `sort`, which keeps config order for one provider).
- `isSameModel()` and `normalizeModelId()` are deleted; README and the roster test describe the new order.

<details>

- #### [MODIFY] skills/dispatch/scripts/policy/roster.ts
  - Changes: `demote()` drops the `same` predicate and third group; doc comment reads "Alternatives first, then the orchestrator platform; each group diversity-sorted." Delete `normalizeModelId()` and `isSameModel()`. Change roster-local `export type Orchestrator` to `{ platform: string }`.
  - Invariants: `demote()` signature and the no-orchestrator branch unchanged; module header comment stays accurate (platform demotion).

- #### [MODIFY] tests/unit/policy/roster.test.ts
  - Changes: rename `grammar-diversity-sort` test to `grammar-diversity-sort: every platform first once, orchestrator platform last in config order` and expect the After order from Key Interfaces & Data. Drop `model` from the `orchestrator` literals at lines 14, 74 and 87.
  - Invariants: other test assertions unchanged.

- #### [MODIFY] README.md
  - Changes: line 13 reads "Cross-platform reviewers are asked first, and your host platform last, so shared blind spots are less likely to survive review."

- #### [GENERATED] skills/dispatch/skill-hashes.json
  - Command: `npm run hashes`
  - Inputs: skills/dispatch/scripts/policy/roster.ts

</details>

## Success Criteria
- [SC1] Unpinned `targets: all` with host `claude` on `claude-opus-20260101` resolves to the After order.
  <details>

  - Satisfies: REQ-1, REQ-3
  - Changes: skills/dispatch/scripts/policy/roster.ts, tests/unit/policy/roster.test.ts
  - Tests: tests/unit/policy/roster.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="grammar-diversity-sort" tests/unit/policy/roster.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="grammar-diversity-sort" tests/unit/policy/roster.test.ts`
  - Evidence: red
  - Pre-existing: no

  </details>
- [SC2] No same-model helper remains in shipped scripts, tests or tooling.
  <details>

  - Satisfies: REQ-2
  - Changes: skills/dispatch/scripts/policy/roster.ts
  - Verify: `node -e "const r=require('node:child_process').spawnSync('git',['grep','-n','-E','isSameModel|normalizeModelId','--','skills','tests','scripts'],{encoding:'utf8'});if(r.status!==1){console.error(r.stdout||r.stderr);process.exit(1)}"`
  - Evidence: verify
  - Pre-existing: no

  </details>
- [SC3] README states the host platform is asked last without the active-model clause.
  <details>

  - Satisfies: REQ-3
  - Changes: README.md
  - Verify: `node -e "const t=require('node:fs').readFileSync('README.md','utf8');if(!t.includes('and your host platform last')||t.includes('active model last'))process.exit(1)"`
  - Evidence: verify
  - Pre-existing: no

  </details>

## Verification Plan
- Seams: `resolveRoster` in `skills/dispatch/scripts/policy/roster.ts`
### Automated Tests
- `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/unit/policy/roster.test.ts`
- `npm test`
### Manual Verification
- None: unit and contract checks cover the behavior.

## Rollback & Blast Radius
- `resolveRoster()` consumers (review run, ask run fanout) get the new order with no interface change. Revert the commit to restore the three-group order.
- `skills/dispatch/scripts/toolkit/fanout.ts` keeps reading `orchestrator.model` from the `lib/platform.ts` type; unchanged.
- `tests/e2e/toolkit-review.test.ts` uses one claude target; order-insensitive.

## Review Findings & Resolutions
*No reviews conducted yet.*
