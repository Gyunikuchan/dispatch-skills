# Verb walkthrough brief

You audit one Dispatch verb (`ask`, `design`, `plan`, `review` or `implement`) by tracing the scenarios in your packet as a static walkthrough. You return **claims**; the lead verifies them. Zero claims is valid.

**Objective**: find where the verb's instructions and runtime fail to carry a user from the scenario's trigger to its expected outcome, or carry them there at avoidable cost. Repository principles in `AGENTS.md` are the standard; grade agent-facing prose against the `writing-for-agents` skill.

**Constraints**:

- Static only: read and trace. Running `dispatch.ts start`/`send` or any live provider flow is out of bounds; so is launching another agent.
- Write only your packet's `findingsPath`, in the format of [findings.md](findings.md).
- Budget: your packet's run manifest holds the effective limits (`scopeToolCalls`, `scopeMinutes`, `branchExpansionsPerScope`). Count as you go.

## Per scenario

1. **Expect first.** Before opening implementation, write the scenario's expected user outcome and constraints from the packet's `expectedOutcome`, the objective, and `AGENTS.md`. This is the yardstick the trace is held against.
2. **Trace from the entrypoint.** Start at `skills/dispatch/SKILL.md`, follow the verb guide, then the packet's `entries` into the instructions, machine transitions, emitted host frames and the tests that establish them. Use CodeGraph where the repository has `.codegraph/`. Read further only when a traced decision needs it; whole-tree reading earns nothing.
3. **Record one row per material decision or handoff** in the trace's `Path`:

   | Field | Evidence |
   |---|---|
   | Situation | trigger and relevant state |
   | Available information | inputs and references the host agent actually has here |
   | Required action | decision, command, artifact or event, and its owner |
   | Transition | producer, consumer, validation, next state |
   | Outcome | how it advances or blocks the expected result |
   | Support | current `path:line`, the test, or a named evidence gap |

4. **Probe each transition** for missing information, contradictions, premature completion, stalls, repeated reads or context, unnecessary round trips, duplicate verification, and broken recovery.
5. **Seek counterevidence** before writing a claim: a test, guard or later step that already handles the case refutes it. Calling a round trip unnecessary requires naming the decision or assurance it fails to add; static repetition alone is an opportunity, never measured waste.
6. **Simplify**: ask whether removal, consolidation or deterministic enforcement would shorten the path without weakening an assurance boundary. Record the answer as an opportunity, not a defect.

**Done when**: every packet scenario has a trace whose `Result` is filled, every row cites its support, and coverage and counters are written.

## Branch expansion and stopping

- A side branch outside your packet costs one **branch expansion**; past the limit, list it under `Handoff` as a remaining lead.
- Cross-verb, routing, provider, permission or recovery-ownership concerns belong to the shared scope: one `Handoff` line each, then continue.
- At the tool-call or minute limit, stop at the next row boundary, mark unfinished scenarios `gap — budget exhausted`, and write the file. A written partial file beats an unwritten complete one.
- A repair request from the lead (missing or malformed output) gets one pass: fix the named defect in your file only.

Return only your terminal status (`complete` or `partial`), defect and opportunity counts, gaps, and the findings path.
