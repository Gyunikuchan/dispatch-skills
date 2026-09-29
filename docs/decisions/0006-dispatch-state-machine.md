# ADR 0006: Dispatch as typed state machines over an event journal

- **Status**: Accepted
- **Date**: 2026-09-30
- **Spec**: `dispatch-state-machine.spec.md` in the brainstorming session folder (`.scratch/dispatch-skills/20260929T1630Z-ab5d2d9be77b-rewrite-dispatch-as/`)

## Context

`dispatch` coordinates read delegates, native write subagents, and an orchestrating host agent
through multi-phase workflows: ask, design, plan, review, and implement. The host is an LLM that
acts at judgment points and is billed per token; delegates are external CLIs that fail in many
provider-specific ways; runs last minutes to hours and must survive crashes and context resets.

The skill must be:

- **correct first**: every transition explicit, every failure handled, recovery exact;
- **cheap per host turn**: the host sees only what its next decision needs;
- **fast to verify**: logic testable without processes, git, or clocks;
- **portable**: copy the files and run them on any supported OS and host platform, with no install
  or build step and no runtime dependency;
- **easy to extend**: adding a state, event, effect, provider, or failure class is local and
  compiler-guided.

## Decision

### Language and runtime

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | All source, tests, and repository tooling are native TypeScript (`.ts`) executed directly by Node type stripping; `tsc` runs with `strict` and extra strictness flags for checking only | Real type syntax for readability; strictness without annotation noise; no build, no output tree | JavaScript with JSDoc types (verbose under strict); compiled `.ts` shipped as generated JavaScript (build step, duplicated tree) |
| D2 | Node ≥ 22.18 is the only runtime prerequisite; a plain-JavaScript `guard.mjs` imported first reports older Node with an actionable message | Type stripping is on by default from 22.18; the guard turns a syntax error into a clear instruction | Loader hooks or flags for older Node |
| D3 | Erasable syntax only (`erasableSyntaxOnly`, `verbatimModuleSyntax`); closed sets are union literals and `as const` objects; relative imports carry `.ts` | Required by type stripping; unions also give exhaustive checks | `enum`, `namespace`, parameter properties, decorators |
| D4 | Zero runtime dependencies; `typescript` and `@types/node` are dev-only | Hosts need nothing beyond Node | Any runtime package |

### Engine

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D5 | Each workflow is a pure reducer `step(state, event) → { state, effects }` over discriminated-union states and events, with an exhaustive `switch` whose `never` default makes a missing case a compile error | Strongest static guarantees with the least machinery; state is plain JSON | A generic statechart engine (string-keyed wiring, weak typing, an engine to maintain); durable coroutines (state hidden in the program counter, backward jumps awkward) |
| D6 | Six machines: `root`, `ask`, `review`, `implement`, `design`, `revision`; a parent embeds a child's state as a field, forwards events to it, and maps its terminal states | Composition without a framework; the review machine is reused by every review kind | Flat single machine |
| D7 | Each machine exports a `transitions` table; a test checks it against the reducer and a script renders diagrams from it | Documentation that cannot drift from code | Hand-drawn diagrams |
| D8 | Layers: `core` (journal, interpreter, frames, validation) → `machines` → `policy` → `domain`; `effects` → `providers` → `lib` for I/O. `machines`, `policy`, and `domain` import no filesystem, process, OS, clock, randomness, or environment | All decision logic is pure and testable in memory; a guard enforces the rule | Mixed logic and I/O |

### State and recovery

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D9 | One append-only `events.jsonl` per run is the sole authority; state is `fold(events)`; recovery is replay | Deterministic recovery and a complete audit trail in one format | A mutable state file (no history; a bad write loses the run); rebuilding state by re-parsing rendered artifacts (heuristic, marker-heavy) |
| D10 | Appends are fsynced; a torn last line is dropped and its effect re-executed; a bad line mid-file, a sequence gap, or an unknown schema version is an engine fault | Crash safety without migration logic | Tolerant repair of mid-file damage |
| D11 | Reducers never read time or files; timestamps and every external observation (git fingerprints, verify results, parsed artifacts) enter through events | Replay is exact | Reading the world during replay |
| D12 | Host-authored inputs (plan, design) are parsed once when submitted and the parse is stored in the event; driver outputs (walkthrough, review log, report) are rendered from state and never parsed | No parse-back drift; hand edits to rendered output are not an input channel | Parsing rendered Markdown on recovery |
| D13 | In a host-authored plan or design, the driver owns only the trailing `## Review Findings & Resolutions` section, located by heading and replaced wholesale; the governed hash excludes it | Review history lives beside the artifact without markers or parsing | Markers inside the artifact; a separate review file per plan |

### Host protocol

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D14 | One invocation (`send`) validates and appends a host event, then runs automatic effects in a loop until the state awaits the host or ends, and prints one frame | One process per host turn; no separate advance, drive, or verify commands | One process per micro-step |
| D15 | A closed set of eight awaits: `author`, `native`, `rule`, `fix`, `write`, `evidence`, `decide`, `done`; delegate launches and verification commands are driver-internal | Every host turn is a judgment, never a mechanical relay | Exposing mechanical steps to the host |
| D16 | `decide` carries a typed kind: `approval`, `baseline`, `failure`, `concerns`, `escalation`, `needs-user`, `opt-in`, `drift`; user-owned kinds require `{by, quote}` from chat | One await shape for every decision; ownership is explicit | One await per decision |
| D17 | Frames carry the await, a projection of only the data that decision needs, an exact reply template, and a one-line position breadcrumb; bulk content is referenced by path; no guidance text | Minimal tokens per turn; instructions live once in `SKILL.md`, one short section per await | Guidance embedded in each frame |
| D18 | Host events are validated by hand-written type guards against the current await and existing ids; a rejected event re-emits the same frame with a one-line error and appends nothing; `send --dry-run` validates without effect (the write subagent's envelope self-check) | Single source for reply shapes; bad input never corrupts state | JSON Schema twins of the types |
| D19 | CLI: `start`, `send`, `status`, `doctor`, `session`; exit codes 0 (frame printed), 1 (usage or Node version), 2 (engine fault, fault frame printed), 3 (run lock held) | Small surface; every outcome is machine-readable | A per-feature flag matrix |

### Progress and robustness

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D20 | stderr carries one milestone line at each effect start and sub-milestone (slot finished, reserve used, command started) with breadcrumb and expected duration; a `progress.json` heartbeat every 30 s; `status` is read-only and lock-free, and flags stalls (no output for 5 min) without killing anything | The host can tell working from hung and answer the user at no token cost while waiting | Completion-only banners |
| D21 | The journal records `EFFECT_STARTED`; on resume an in-flight effect is reattached (live wave worker) or relaunched whole | Exact recovery of long effects | Partial-effect resumption |
| D22 | Three failure tiers: bad event (re-emit frame), domain failure (result event the machine handles), engine fault (fault frame, exit 2, nothing appended) | Every failure has one defined path | Exceptions as control flow |
| D23 | A run lock (`pid`, start time) serializes `send`; a lock whose process is gone is broken and the break is journaled | Safe against crashed hosts without manual cleanup | Advisory-only locking |
| D24 | One drift rule: each await records a tree fingerprint; the next `send` parks the host event, snapshots the tree, and routes changes outside that await's permitted paths to `decide:drift` (`adopt` or `stop` per path) | One check replaces per-phase drift logic and write-scope rulings | Phase-specific drift checks |

### Delegates

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D25 | Each provider is a declarative `ProviderSpec` (discovery modes with per-OS candidate globs, argv builder with read-only controls always present, output parser, sandbox flags with support and inactivity detection, optional pre-launch hook, native platform); one generic runner and one discovery scanner serve all | Provider knowledge is data; shared concerns (credential stripping, guardrails, timeouts, process-tree kill, logging) are written once | One bespoke runner per provider |
| D26 | Discovery tries CLI, then desktop bundle, then VS Code bundle; the fallback chain is modes, then configured model aliases, then ordered reserves, then native fallback for the orchestrator's own platform | Zero-config for any install shape | PATH-only discovery |
| D27 | Failure classes form one closed union, and a pure `cascade` policy maps class and position to the next step | Exhaustive, table-tested failure handling | Per-provider classification branches |
| D28 | Sandboxing is strict: with `sandbox: true` (the default), a provider that rejects or cannot activate its sandbox on this host fails the slot as `sandbox-unsupported`, which skips that provider's other models and modes and goes to reserves or native fallback; a delegate never reruns unsandboxed. Running without isolation requires an explicit `sandbox: false`, and `doctor` predicts unsupported providers per OS | Least privilege is structural; every unsandboxed run is a deliberate, visible configuration choice | Downgrading to an unsandboxed rerun with a warning |
| D29 | A wave's CLI slots run in a detached worker; native slots (native-only targets and early fallbacks) are yielded to the host while the worker continues; every roster slot is reconciled before the wave completes | Parallelism across delegates and native subagents | Serial CLI-then-native waves |

### Workflows

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D30 | Every review kind (plan, design, code; fix or report-only) runs the rounds policy of ADR 0005 | One review machine and policy | A second dispute protocol for some kinds |
| D31 | Rounds that fixed nothing review disputes only; each pending rejection is shown to its source slot or that slot's substitute (affinity as a roster rule); an `intent` finding category must be ruled `needs-user` | Dispute rounds cost what a targeted confirmation costs; the raising reviewer judges its own dispute; plan-level disagreements reach the user | Dedicated rebuttal waves |
| D32 | A `REVISE` event, from the host or triggered by a writer's `blocked-by-plan` concern, revises the governing plan or design mid-run: author, delta-scoped review, then rebind. Unchanged verified criteria keep evidence; changed ones reopen; removed ones become deviations; approval is re-requested only if approved paths or commands grew; completed design increments with changed acceptance criteria reopen; objective changes are refused | Discoveries during implementation change the plan without restarting the run; small changes cost one narrow round | Restart the run; revision without review; revision with mandatory user approval |
| D33 | Failure disposition offers `hotfix`, `retry`, or `stop`; `manual-complete` is only a user ruling at `stop`; the driver never reverts code on disposition | Forward progress by default; reverting is the user's own git action | A wide menu of recovery branches |
| D34 | The driver's only tree mutation is restoring a failed writer attempt's changes, after saving them as a patch, before the next model in a launcher cascade | Automatic, lossless model failover | Asking the host at every failover |
| D35 | Verify results are reused only within a run, keyed by input fingerprint | Same content, same result; no cross-run cache to invalidate | Time-bounded cross-run reuse |
| D36 | `design` authors, reviews, and obtains approval for a technical design, then ends without production writes; `implement: <design path>` delivers every ready increment in dependency order without pausing, then runs integration; re-invoking it in the same session resumes the unfinished run bound to that design | Mirrors `plan` → `implement: <plan path>`; minimal babysitting; replay makes stopping free | `design` running increments itself; a pause after every increment |
| D37 | `implement` on an already settled plan skips plan authoring and plan review; there is no phase-selection syntax | Resumption is replay; the input decides the entry point | Phase-selection flags |

### Tests

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D38 | Six tiers: machines, policy, domain, core, providers (all pure or temp-fs only, under 5 s combined), and at most three end-to-end tests with the real CLI, a temporary git repository, and a stub provider | Signal concentrated where logic lives; process cost only where the CLI contract is the subject | Driving the CLI for every scenario |
| D39 | Tests assert the public protocol (frames, events, rendered sections), never internal state shape; one behaviour per test | Tests survive refactors | Internal-state assertions |
| D40 | Rules are enforced mechanically: a test preload makes spawning throw outside the end-to-end tier; guards forbid timing constructs and stray snapshots; the reporter fails any non-end-to-end file over 1 s; the end-to-end tier is capped at three files; judgment-only rules live in `AGENTS.md` | Always-applied rules beat documents agents may not read | A testing README |
| D41 | Exhaustive `never` checks over awaits, decide kinds, events, effects, failure classes, and state tags replace "unhandled case" tests | The compiler proves coverage | Runtime tests for missing cases |

## Consequences

- Hosts need Node ≥ 22.18; Node 22.18–22.x prints one experimental warning on stderr, and stdout
  stays clean.
- Files under `node_modules` cannot be type-stripped; skills are installed outside it.
- A lost run folder cannot be reconstructed from deliverables; the run restarts, and code edits and
  deliverables remain on disk.
- Edits to driver-rendered Markdown are overwritten; the host changes a run only through events.
- After the round cap, orchestrator rejections of `SHOULD` findings are final for every review
  kind.
- Consecutive runs over an identical tree rerun their gates.
- On hosts where a provider cannot sandbox (for example Claude on native Windows, or OpenCode
  without Linux Bubblewrap), that provider fails every slot until its config sets `sandbox: false`.
- Adding a provider means one `ProviderSpec` file plus parser fixtures; adding a state means one
  union member, with the compiler listing every place that must handle it.
- `npm test` targets under 60 seconds; the budget is enforced per file rather than for the whole suite, so
  slow machines do not flake.
