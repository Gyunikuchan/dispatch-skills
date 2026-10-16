# ADR 0007: Review context and intent composition

- **Status**: Accepted; semantic intent decisions updated by [ADR 0010](0010-canonical-session-intent.md)
- **Date**: 2026-10-02
- **Spec**: `skills/dispatch/references/review-rules.md`, `skills/dispatch/references/verbs/review.md`, `skills/dispatch-code-review/SKILL.md`

## Context

Delegated review runs in read-only delegate sandboxes without access to host orchestrator chat history or conversational context.

Prior to v0.7.0, `/dispatch-code-review` attempted to bridge this by generating a `walkthrough.md` artifact. Pre-v0.5.0 required manual authoring; v0.5.0 mechanized extraction (`04e21f9`, `c3b137c`), but generated synthetic boilerplate that lacked grounding and leaked implementation artifacts into host repositories. ADR 0006 (`443439a`) eliminated this mechanism, leaving `Walkthrough:` and `Plan:` defaulting to `None`.

When users invoked standalone code reviews (`/dispatch-code-review` or `start review --kind code`) on revision ranges like `main..HEAD` or working-tree changes, review preparation lacked semantic intent:
1. `reviewSpecFromRun` leaked the comparison range (`main..HEAD`) into `Task Summary`, or defaulted to `Review the selected changes.`.
2. Existing implementation deliverables (`<slug>.plan.md`, `<slug>.walkthrough.md`) produced during the session were ignored.
3. Reviewers could not evaluate whether the changes satisfied the author's original intent, nor could they differentiate intentional design deviations from bugs or `scope-creep`.

Bridging this context requires satisfying four invariants:
- host chat intent and deliberate implementation deviations reach delegate reviewers;
- existing session deliverables serve as structural baselines without synthetic file generation;
- reviews of past or external commit ranges remain autonomous without interactive stalling;
- least privilege and context hygiene are preserved without token bloat.

## Decision

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | Two-channel context composition: separate **Semantic Intent** (the settled governing spec, superseding the short ask/deviation channel) from **Structural Baseline** (governing plan and walkthrough deliverables) | Intent and deliverables answer different review questions (`intent`/`scope-creep` vs `test-gap`/`against`); conflating them into a single blob muddles prompt sections | Monolithic unstructured text; forcing walkthrough authoring for every review |
| D2 | **Superseded by [ADR 0010](0010-canonical-session-intent.md#readers-and-review); historical:** Semantic Intent precedence: (1) explicit `--context` flag, (2) Git commit log extraction (`git log --format="%s%n%b" <range>`) for commit ranges, (3) default fallback `Review the selected changes.` | Active chat intent takes priority; past ranges carry author intent in commit logs; working tree diffs without context fall back safely without failing | Interactive prompting for missing context; failing reviews when context is absent |
| D3 | Structural Baseline precedence: (1) explicit governing artifact paths, (2) automated discovery of unique `*.plan.md` and `*.walkthrough.md` in active `sessionDir` root, (3) fallback to `None` when absent (zero candidates) or ambiguous (multiple candidates) | Discovers active session artifacts when present; fails closed to `None` when multiple artifacts exist to avoid binding the wrong baseline | Binding arbitrary or newest candidate on ambiguity; scanning recursive subdirectories |
| D4 | **Superseded by [ADR 0010](0010-canonical-session-intent.md#readers-and-review); historical:** Translate three-dot comparisons (`A...B`) to two-dot log ranges (`A..B`) during Git commit log extraction | In Git, `diff A...B` compares merge-base to `B`, but `log A...B` lists symmetric difference including `A`-only commits. `A..B` lists only commits introduced on `B` since branching, preventing false `intent` or `scope-creep` findings from base branch commits | Raw `git log A...B`; manual `git merge-base` resolution subprocesses |
| D5 | **Superseded by [ADR 0010](0010-canonical-session-intent.md#readers-and-review); historical:** `--context` CLI flag is permitted only on `start review`; rejected on `ask`, `plan`, `design`, and `implement` with `UsageError` | Reviews inspect completed work where context guides adjudication; write verbs define their scope through arguments and design/plan bindings | Allowing `--context` on write verbs; silently ignoring unused flags |
| D6 | **Superseded by [ADR 0010](0010-canonical-session-intent.md#readers-and-review); historical:** Restrict null context fallback to standalone code reviews; preserve `run.argument` objective in implementation code review | `implement` runs a code review phase where `run.argument` is the implementation objective; nulling context there resulted in literal `null` task descriptions in prompts | Overriding implementation task context; sharing unspecialized spec builders across verbs |
| D7 | **Superseded by [ADR 0010](0010-canonical-session-intent.md#readers-and-review); historical:** Instruct orchestrators via `dispatch-code-review` and `.agents` forwarder contracts to distill active chat intent and deviations into `--context "<intent>"` | Orchestrator harnesses summarize conversation nuance better than static tooling; forwarder contracts guide agents at invocation boundaries | Extracting chat transcripts automatically via host-specific APIs |

## Delivered intent channel

Every review kind receives the settled spec path/hash and reads the whole spec. Code Task Summary comes from Intent & Problem. `--context`, commit-log synthesis and the generic fallback are removed as intent channels. Standalone review reuses its governing spec or authors one from chat and diff, marks inferred requirements `(inferred)`, and records user decisions only with evidence. Missing intent now produces the spec-authoring await rather than silently substituting commit messages.

D3 remains the structural baseline: explicit governing paths, then unique session-root plan/walkthrough discovery, then `None` for absent or ambiguous deliverables. Structural ambiguity never permits guessing the governing spec. Spec resolution and revision follow [spec operation](../../skills/dispatch/references/spec-stage.md); [review rules](../../skills/dispatch/references/review-rules.md) own intent-first rulings and preserve earlier review history.

## Consequences

Reviewers share durable intent with authors and writers, at the cost of whole-spec context and explicit authoring when no spec exists. Historical rationale above explains why short context and commit logs were introduced; those mechanisms no longer govern review. Existing plan/walkthrough discovery remains useful as structural evidence. Changed intent requires a new DEC and owning-artifact recovery, not a replacement context flag.
