# ADR 0014: Ground-first intent and evidence-based level

- **Status**: Accepted
- **Date**: 2026-10-29
- **Audience**: Maintainers

## Context

Dispatch recommended `plan` or `design` and selected a run level before it understood the problem. Explorers then repeated research already done to make those choices. A spec written from chat alone also lacked a structured round to expose assumptions and open user decisions before planning.

## Decision

For every new spec, Dispatch grounds the domain from questions in the request, invokes `grilling` when the host provides it, writes the spec, then confirms stated and assumed intent. It recommends `plan` or `design` from the scope check in that confirmation. An explicit verb stays unless the scope check contradicts it. When `grilling` is unavailable, Dispatch confirms intent after grounding. This applies to `review` when no spec exists.

Each platform has one explorer configuration entry. `deep` applies to initial grounding; follow-up questions can use a single explorer at any stage. The operational sequence lives in the [spec stage reference](../../skills/dispatch/references/spec-stage.md).

An explicit run level stays in force. Otherwise, Dispatch proposes and records a level after it authors and lints the plan or design, before the first review. The review uses that level; the user confirms a proposed level with artifact approval after review. For a design, record the level before design review and carry it to increment plans. Review or implementation may raise it to `high` and record the change in the ledger, but it never decreases mid-run. `xhigh` and `max` remain user-selected. The level rubric and resolution order live in the [configuration guide](../../skills/dispatch/references/readme/configuration.md#understand-levels-and-pins).

The `brainstorming` skill was rejected because it repeats grounding, writes a foreign spec, and hands off to another planning flow. `grilling` adds clarification while Dispatch keeps canonical artifact ownership.

## Consequences

Scope and assumptions are checked before planning, and the level follows the artifact that needs reviews. Explorer configuration no longer depends on the level, and the spec template no longer varies by level. Hosts without `grilling` use intent confirmation after grounding; `ask` and standalone `review` keep their existing level resolution.
