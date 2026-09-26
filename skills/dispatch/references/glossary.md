# Glossary

Single source for dispatch terminology. Contracts, templates, diagnostics, flags, and artifact
headings use these terms.

| Term | Meaning | Banned synonym | Distinct from |
|---|---|---|---|
| **Verb** | One `/dispatch` operation: `ask`, `plan`, `design`, `review`, `implement`. | | command, mode |
| **Phase** | One ordered unit of the workflow. Ordinary order: `plan` → `plan-review` → `baseline` → `implementation` → `code-review` → `handoff`. Design order: `design` → `design-review`; then each increment runs the ordinary phases; then `integration`. | stage | step, increment |
| **Increment** | One `I<nn>` row of a technical design's dependency graph: a governed unit of delivery that runs the ordinary phases once. | milestone | phase |
| **Technical design** | Higher-level architectural plan that breaks a large problem into increments: architecture, boundaries, interfaces, dependency graph, per-increment acceptance criteria; no file-level detail. | | implementation plan |
| **Implementation plan** | Lower-level plan for building the requested features or a technical-design increment: concrete files and symbols, step order, Success Criteria, exact verification. | | technical design |
| **Walkthrough** | Record of a completed implementation: changes, verification results, outcome traceability, review log. | | plan |
| **Level** | Policy and model tier, `low` through `max`. | | effort (a provider setting) |
| **Pin** | User selector fixing providers or breadth. | | |
| **Orchestrator** | The host agent running `dispatch`: drives emitted actions, verifies delegate claims, owns rulings, and owns production writes through the native write subagent. | | driver, read delegate, write subagent |
| **Read delegate** | A dispatched, structurally read-only provider CLI (the default candidate kind). | reviewer | |
| **Write subagent** | A native host subagent that edits code; never dispatched. | implementer | |
| **Candidate / Target / Reserve** | A configured provider entry; one selected for a wave; one held back to replace a failed target. | | |
| **Round / Wave / Slot** | One adjudication record; the concurrent launches for one round; one launched delegate. | iteration | |
| **Affinity** | Routing a rebuttal to its effective source. | | |
| **Change scope / Review Scope / Installation scope** | Implementation size; a review's evidence boundary; where skills are installed. | | |
| **Run** | One driver invocation, with its state file. | | session (a provider handle) |
| **Action** | One driver instruction to the agent (closed set). | | step, task |
| **Finding / Ruling / Settlement / Checkpoint** | A delegate claim; the host's decision on it; the recorded final status of a round (consensus exit `0`, or host-final when `consensus: false`); the recorded freshness metadata. | verdict | |

Only the "Banned synonym" column is enforced (`scripts/check-terms.mjs`). A word that is itself a
glossary term, config key, or provider field (`phase`, `increment`, `effort`, `session`, `mode`,
`command`, `task`) is never banned; "Distinct from" is explanation only, and "step" stays allowed in
plain prose. Code spans and fenced blocks are exempt.

## Ordinary phase inputs and outputs

| Phase | Requires | Produces |
|---|---|---|
| `plan` | ask | plan artifact |
| `plan-review` | plan | settled plan resolution log |
| `baseline` | settled plan | walkthrough with baseline verify records and recorded approval |
| `implementation` | approved baseline | code edits, implementation outcome, ledger events |
| `code-review` | walkthrough + edits | settled code resolution log and checkpoint |
| `handoff` | settled code review | Execution Status, handoff summary, scratch relocation |

The **RED gate** is a gate inside `implementation`: failing tests are
written and confirmed before production edits. Phase and increment are distinct on purpose: a
phase is *how* work proceeds, an increment is *what* part of a design is delivered.
