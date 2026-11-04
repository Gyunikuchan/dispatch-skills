# Drop host-model demotion from delegate ordering

> **Status:** draft

## At a Glance
- **What:** Delegate candidate ordering stops demoting the host's own model below the host platform's other models. It keeps the host platform last.
- **How it works:** `demote()` in `skills/dispatch/scripts/policy/roster.ts` keeps two groups (other platforms, then host platform in config order) instead of three.

## Intent & Problem
The host agent is often only the orchestrator. A host-platform delegate on the host's own model can be stronger than the platform's other models, so demoting it below them can rank a weaker reviewer first. The user wants same-platform demotion kept and same-model demotion removed.

## Background
- `demote()` orders unpinned candidates: other platforms, then host-platform models other than the orchestrator model, then host-platform candidates whose model matches the orchestrator model (`isSameModel`). Each group is diversity-sorted.
- `isSameModel()` and `normalizeModelId()` are exported from `roster.ts`; `demote()` is their only caller.
- `Orchestrator.model` is also read by `skills/dispatch/scripts/toolkit/fanout.ts` for native responder records.
- `README.md` line 13 states "Cross-platform reviewers are asked first, and your host platform and active model last".
- `tests/unit/policy/roster.test.ts` test `grammar-diversity-sort` asserts the three-group order.
- No ADR in `docs/decisions/` records the same-model rule.

## Requirements
### REQ-1 — Host platform last, config order inside
Unpinned ordering puts every non-host-platform candidate first (diversity-sorted), then all host-platform candidates in configured order, with no orchestrator-model check.
- Acceptance: with host `claude` on model `claude-opus-20260101` and claude targets `[claude-opus, claude-sonnet]`, `targets: all` resolves to `codex[0]:gpt-5, agy[0]:gemini-pro, codex[1]:gpt-5-mini, claude[0]:claude-opus, claude[1]:claude-sonnet`.

### REQ-2 — Remove dead same-model code
`isSameModel()` and `normalizeModelId()` no longer exist; `Orchestrator.model` remains for fanout responder records.
- Acceptance: `grep -rn "isSameModel\|normalizeModelId" skills tests scripts` returns nothing, and `npm test` passes.

### REQ-3 — Docs and test match behavior
README states the host platform is asked last without mentioning the active model; the roster test name and expectation reflect the new order.
- Acceptance: README.md line 13 reads "your host platform last"; `grammar-diversity-sort` test name no longer says "its own model last".

## Non-goals
- Change pinned ordering, `-m`/`-e` collapse, liveness, native-only filtering or diversity sort.
- Remove `Orchestrator.model` or change fanout responder records.

## Constraints
- Drop legacy behavior without a compatibility switch (repository rule).
- Update `skills/dispatch/skill-hashes.json` with `npm run hashes` after editing hash-tracked `roster.ts`.

## Decisions
### DEC-1 — Host-platform order after the change
- Context: Removing the same-model group leaves an order choice inside the host-platform group.
- Options:
  - Config order, no model check — simplest; user config controls preference.
  - Keep a model-based tie-break — retains the removed rule in another form.
- Choice: Config order, no model check (user)
- User quote: "yes to all"
- Rationale: The host model can be stronger than the platform's other models; config order lets the user rank them.
- Rejected: Model-based tie-break — contradicts the request.

### DEC-2 — Delete unused helpers
- Context: `isSameModel()` and `normalizeModelId()` become unused.
- Options:
  - Delete both — no dead code.
  - Keep as exported utilities — dead code with no caller.
- Choice: Delete both (user)
- User quote: "yes to all"
- Rationale: Repository rule removes all references to dropped behavior.
- Rejected: Keep — no caller.

### DEC-3 — Run level
- Context: Level controls review breadth and approval gate.
- Options:
  - `low` — one function, one test, one doc line.
  - `medium` — adds approval tuple and broader review.
- Choice: `low` (user)
- User quote: "yes to all"
- Rationale: Small, well-bounded change with direct unit coverage.
- Rejected: `medium` — cost exceeds risk.

## Discussion Record
- 2026-11-04: User accepted README and test updates and that no ADR changes ("yes to all").

## Open Questions
- None.
