# ADR 0015: Native subagent routing

- **Status**: Accepted
- **Date**: 2026-11-04
- **Audience**: Maintainers

## Context

Explorer rules lived in grounding, although every verb has token-heavy reading. Continuation rules were split across two references, and `SKILL.md` required a `providers.md` read before each launch. Low-risk routine work, such as test cleanup and the diagnostics retrospective, ran on the host model or had a one-off routing rule. Each cost fell on the user as tokens and on the run as orchestrator context.

## Decision

The orchestrator is the user's deputy ([ADR 0012](0012-orchestrator-user-deputy.md)) and middle-manages dispatched agents, whether native subagents or provider delegates. `SKILL.md` carries the routing table, the context guard and the launch and continuation rules inline. Explorer subagents take research, triage, evidence gathering, sweeps and grounding maps. Utility subagents take test cleanup, the retrospective, map correction and mechanical fixes that a deterministic check confirms. Writers take plan tasks, delegates and native slots take differentiated voices, and the orchestrator keeps decisions, rulings, the ledger, user gates and spec and plan authoring. Grounding ([ADR 0014](0014-ground-first-intent-and-evidence-based-level.md)) is one prescribed explorer use.

Explorer and utility subagents share one resolution: the host's `explore-subagents` entry, else its lowest `write-subagents` entry. Doctor reports it as `utility` per canonical platform, so no agent matches platform aliases by hand. Explorer work on a writer-tier entry stays read-only through its brief. The orchestrator works inline only when no entry resolves. A utility subagent edits only assigned paths and runs no Git write commands and no toolkit. Writer briefs carry the resolved explorer model, because a writer runs no toolkit.

For the retrospective, the orchestrator passes terse notes to a utility subagent, which merges them. The subagent cannot see what the orchestrator struggled with, so first-hand notes keep the signal while the formatting cost moves off the host model. With no notes, nothing launches.

Reviewers read directly and launch no explorers. Reading is the review, load-bearing claims need a source check anyway, and a cheap model's misses would pass into every voice. Dispatch also cannot pin the model of a subagent that a provider CLI spawns, so the Claude delegate command line disallows the host's subagent tool. The orchestrator can use explorers to gather evidence when it adjudicates; the ruling stays with it.

Continuation is topic-based: continue a retained subagent when the answer depends on what it already read, and launch fresh for an unrelated topic. Dispatch has no cache-TTL rule. The orchestrator cannot observe a subagent's cache state, TTLs differ by host and tier, and only one host documents resume cache behavior. A TTL rule would add clock tracking and per-host facts that go stale, for a saving nobody has measured. Reviewers are not continued across rounds.

A rule that every branch needs stays inline in `SKILL.md`, because a must-load file adds a tool call to each run. The `SKILL.md` byte budget rises when such rules need the room; references keep branch-specific detail.

## Consequences

Heavy reading at any verb moves off the orchestrator model, and hosts with only writers configured still keep raw material out of orchestrator context. Every run loads a larger `SKILL.md` but makes no extra reference read before launches. An idle, large subagent can bill its context uncached on continuation; the topic rule sends low-context questions to a fresh launch. Token and time savings are unmeasured; diagnostics can collect them from future runs.
