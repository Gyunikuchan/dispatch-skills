# ADR 0015: Native subagent routing

- **Status**: Accepted
- **Date**: 2026-11-04
- **Updated**: 2026-11-12
- **Audience**: Maintainers

## Context

Explorer rules lived in grounding, although every verb has token-heavy reading. Continuation rules were split across two references, and `SKILL.md` required a `providers.md` read before each launch. Low-risk routine work, such as test cleanup and the diagnostics retrospective, ran on the host model or had a one-off routing rule. Each cost fell on the user as tokens and on the run as orchestrator context.

One design invocation delivering every increment needs each increment's work to run outside the parent's context, while keeping user gates and decisions with the parent.

## Decision

The orchestrator is the user's deputy ([ADR 0012](0012-orchestrator-user-deputy.md)) and middle-manages dispatched agents, whether native subagents or provider delegates. `SKILL.md` carries the routing table, the context guard and the launch and continuation rules inline. Explorer subagents take research, triage, evidence gathering, sweeps and grounding maps. Utility subagents take test cleanup, map correction and mechanical fixes that a deterministic check confirms. Writers take plan tasks, delegates and native slots take differentiated voices, and the orchestrator keeps decisions, rulings, the ledger, user gates and spec and plan authoring. A design increment goes to a child orchestrator where verified, else the same orchestrator chains it. Grounding ([ADR 0014](0014-ground-first-intent-and-evidence-based-level.md)) is one prescribed explorer use.

Each increment runs in its own session owned by the parent, so the child keeps a clean context and history is linked through recorded session paths rather than shared. The parent owns the design session, user gates, every `by: "user"` record, session creation and seeding, plan reads, deviation rulings and design edits, plan approvals and caller commits; the child owns one increment's plan, reviews, writers, verification, uncommitted delivery, report and cleanup. On hosts without the capability the same orchestrator chains increments in sequence, carrying earlier outcomes only through their walkthroughs.

A child orchestrator is a native subagent one layer below the parent. It runs on the parent's model and effort through documented inheritance, as an exception to the rule that native launches use exactly the launch result's model and effort; writers, explorers, utility subagents and voices the child launches keep the launch-result rule. Claude Code is the verified host; other hosts chain until verified. The child first replies capability-ready or capability-missing for native subagent launch in its own context, and waits for parent continuation before increment work; on capability-missing the parent chains that increment in its session. A continued child writes files inside its launch boundary, as an exception to the follow-up-answers-inline rule, as does a writer continued for an assigned review fix. At each checkpoint or gate the child returns to the parent with a deviation request, gate request or result and waits for continuation. See [child orchestrators](../../skills/dispatch/references/providers.md#child-orchestrators).

Explorer and utility subagents share one resolution from the required `utility-subagents` entry (renamed from `explore-subagents`), with fallback to writer entries removed. Doctor reports it as `utility` per canonical platform with its token `context-limit`, so no agent matches platform aliases by hand. The utility tier provides two briefs: `brief explorer` (rendering map or research briefs with limits and nesting rules) and `brief test-cleanup`. `SKILL.md` defines who may launch what in a role table: the orchestrator and child orchestrators may launch any role; lead explorers may launch nested explorers under the brief rule; writers may launch research explorers for heavy reading outside task paths and utility subagents for tedious, simple edits in their task paths; reviewers and voices launch nothing. A utility subagent edits only assigned paths and runs no Git write commands and no toolkit; the writer inspects its delta and verifies the work. When the host provides no launch tool, the agent does that work inline.

For the retrospective, the orchestrator merges its own terse notes into the retro file. The merge is write-only, so a utility launch would add a cold start and a wait while token cost stays about neutral; the inline merge is faster with one fewer launch. Investigation of logs or chat history for retro evidence still follows the context guard. With no notes, nothing is added.

Reviewers read directly and launch no explorers. Reading is the review, load-bearing claims need a source check anyway, and a cheap model's misses would pass into every voice. Dispatch also cannot pin the model of a subagent that a provider CLI spawns, so the Claude delegate command line disallows the host's subagent tool. The orchestrator can use explorers to gather evidence when it adjudicates; the ruling stays with it.

Continuation is topic-based: continue a retained subagent when the answer depends on what it already read, and launch fresh for an unrelated topic. Dispatch has no cache-TTL rule. The orchestrator cannot observe a subagent's cache state, TTLs differ by host and tier, and only one host documents resume cache behavior. A TTL rule would add clock tracking and per-host facts that go stale, for a saving nobody has measured. Reviewers are not continued across rounds.

A rule that every branch needs stays inline in `SKILL.md`, because a must-load file adds a tool call to each run. The `SKILL.md` byte budget rises when such rules need the room; references keep branch-specific detail.

## Consequences

Heavy reading at any verb moves off the orchestrator model, and hosts with only writers configured still keep raw material out of orchestrator context. Every run loads a larger `SKILL.md` but makes no extra reference read before launches. An idle, large subagent can bill its context uncached on continuation; the topic rule sends low-context questions to a fresh launch. Token and time savings are unmeasured; diagnostics can collect them from future runs.
