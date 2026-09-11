---
name: dispatch-plan-review
description: Review an implementation plan through external agent CLIs before code is written, then adjudicate returned claims. Use on /dispatch-plan-review or when a plan needs a pre-implementation cross-agent review.
---

# dispatch-plan-review

The delegate's report is a **claim, not a verdict**. The orchestrator adjudicates every finding against the requirement and host repository rules before editing the plan or reporting to the user.

## Invocation

`dispatch`'s `references/alignment.md` § Invocation is the base grammar (`/dispatch-plan-review (<pins>) [<artifact path>] [<focus>]`); the artifact path here is always the plan.

## Process

### 1. Assemble context and dispatch

Determine the invocation mode first, per `dispatch`'s `references/alignment.md` § Invocation Modes: **orchestrated** when an orchestrating skill hands over both a plan path and dispatch invocations, **standalone** otherwise. Standalone builds per-pin (or cascade) invocations itself and resolves the plan below; orchestrated uses the handed-over path and invocations as-is, skipping resolution.

Attach the plan file plus any user-specified files with `-f "<path>"` (forward slashes throughout). Resolve the plan in order:

1. **User- or orchestrator-supplied plan** when an explicit path is passed or an orchestrating skill hands one over.
2. **Otherwise**, run the resolver per `dispatch`'s `references/alignment.md` § Plan/Walkthrough Artifact Resolution (it derives the slug; add `--slug <kebab-slug>` only when the user names one or derivation fails):
   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs --kind plan
   ```
   `tier: native` or `scratch-existing` means an artifact already exists — attach it as-is, no authoring. `tier: scratch-new` means none exists: write the returned path following the plan template below before dispatching. External delegates read this file with no other context.

#### Plan template

When authoring a plan, use this structure:

````markdown
# <Goal Description>

Brief problem description, background context, and what the change accomplishes.

## Key Decisions & Context
Settled architectural choices, trade-offs, and rationale (e.g. from prior grilling or alignment sessions).

## User Review Required
Breaking changes, critical design decisions, or trade-offs requiring user attention.

## Open Questions & Assumptions
Clarifying questions, settling assumptions, or explicit defaults.

## Proposed Changes

### <Component Name>
Summary of component changes, separated by files (use relative paths with forward slashes):

#### [NEW] <relative-path>
- Purpose, public interface, and rationale.

#### [MODIFY] <relative-path>
- Changes: Concrete symbol/signature changes and behavior updates.
- Invariants: Pre/post-conditions or boundary validations preserved.

#### [DELETE] <relative-path>
- Deleted symbols and migration/cleanup steps.

## Rollback & Blast Radius
Downstream caller impacts, data migrations, and fallback/rollback paths (or "None").

## Verification Plan
### Automated Tests
- Concrete test commands (`npm test`, targeted test files/suites).
### Manual Verification
- Concrete manual verification steps, edge cases, and failure scenarios.

## Review Findings & Resolutions
<!-- Populated during plan review cycles -->
*No reviews conducted yet.*

## Out of Scope
Explicitly unhandled features or deferred follow-ups.
````

#### Prompt template

Populate the template variables:
- `<Plan Path>` — path to the attached plan.
- `<Requirement>` — original user ask, verbatim.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Review Scope>` — `Full review` on a first review. On a re-review, `Re-review round <n> — verify the resolutions logged under ## Review Findings & Resolutions; raise new findings only in sections changed since round <n-1>: <changed sections>`.
- `<Tool Turn Budget>` — orchestrator-supplied tool-turn budget, or `Unspecified`.

````markdown
Review an implementation plan across seven axes. No code has been written yet — judge the plan, not a diff.

### Context & Objective
- Plan: <Plan Path>
- Original Requirement: <Requirement>
- Review Focus: <User Focus Areas>
- Review Scope: <Review Scope>
- Tool Turn Budget: <Tool Turn Budget>

Adhere to this project's conventions (read `AGENTS.md` / `CLAUDE.md` from the workspace) and industry best practices.

### Instructions

#### 1. Ground the Plan
1. Read the attached plan in full.
2. Targeted inspection: inspect files named in proposed changes and key adjacent call sites or interfaces to verify existing contracts, patterns, and blast radius (use AST / code-graph tools if available, e.g. codegraph, graphify). Avoid full-file dumps or open-ended codebase exploration.
3. Honour Review Scope: on a re-review round, confine the seven axes to the sections it names plus their contracts, confirm each logged resolution actually landed, and treat sections settled in earlier rounds as closed.
4. Complete grounding within Tool Turn Budget when it names a number; otherwise spend 3–4 tool turns for focused tasks, up to 8 for broad refactors or cross-cutting migrations, and fewer on a re-review round. Spend a constrained budget on AST / code-graph queries (`codegraph`, `graphify`) rather than full-file reads. Then emit the report immediately.

#### 2. Seven-Axis Evaluation
- **Requirement & Intent Fidelity** (`traceability`, `user-gap`, `scope-creep`):
  - *Traceability*: Bidirectional mapping between requirements and proposed changes. Flag unmet requirements and unstated/undocumented assumptions.
  - *Premise & User Gaps*: Challenge the premise. Flag flawed prompt assumptions, XY problems, conflicting constraints, or missing prerequisites.
  - *Scope Discipline*: Flag unrequested refactors, unnecessary feature additions, or gold-plating beyond the prompt.
- **Domain & Business Logic** (`domain-logic`, `invariant`, `state-machine`):
  - *Domain & Project Rules*: Adversarial audit against project context and domain authorities (`AGENTS.md` / `CLAUDE.md`). Challenge assumptions; catch mistaken requirements, flawed mental models by user/agent, sign/unit discrepancies (monthly vs. annual, debit vs. credit), or skipped business prerequisites.
  - *Invariants & Integrity*: State consistency and business integrity rules. Ensure operations preserve domain invariants across multi-step mutations.
  - *State Machines & Lifecycles*: Valid state transitions and lifecycle flows. Flag impossible states, unhandled transitions, or missing lifecycle steps.
- **Plan Coherence & Architecture** (`coherence`, `approach`, `standards`):
  - *Internal Coherence*: Cross-section consistency. Flag producer-consumer contract mismatches (signature, type, or payload discrepancies), out-of-order sequencing, and self-contradictory steps.
  - *Architecture & Layering*: System design and module boundaries. Flag boundary leaks (UI querying storage), improper coupling, or patterns violating codebase idioms.
  - *Conventions & Specs*: Adherence to repository guidelines (`AGENTS.md` / `CLAUDE.md`), framework idioms, and authoritative specifications/RFCs.
- **Security & Permissions** (`security`, `auth`, `validation`):
  - *Trust Boundaries & Isolation*: Component trust boundaries, credential exposure, tenant/user data isolation, and least privilege.
  - *Authentication & Authorization*: Role-based access control, permission checks, session validation, and unauthenticated access paths.
  - *Input Validation & Sanitization*: Input boundaries, injection vectors (SQL/command/HTML), path traversal, and unvalidated payloads.
- **Blast Radius & Reversibility** (`blast-radius`, `migration`, `compat`):
  - *Blast Radius*: Cascading impact on adjacent modules, downstream services, client state, or shared URL parameters.
  - *Data & Schema Migration*: Persisted schemas, data model migrations, serialization aliases, and multi-version compatibility. Flag missing migration paths.
  - *Compatibility & Rollback*: Backward compatibility for callers/clients, graceful degradation, and reversibility/rollback paths for breaking changes.
- **Testability & Success Criteria** (`testability`, `spec-gap`):
  - *Verification & Test Surface*: Checkable criteria verified by named automated tests (unit, integration, e2e) or concrete verification steps. Flag subjective or untestable criteria.
  - *Specification Gaps*: Ambiguous acceptance criteria, undefined edge expectations, or success conditions lacking pass/fail definitions.
- **Simplicity & Failure Modes** (`simplicity`, `yagni`, `edge-case`):
  - *Simplicity Ladder*: Prefer: delete requirement → reuse codebase helper/type → stdlib/platform native → new code. Flag speculative abstractions and unneeded dependencies.
  - *Edge Cases & Failure Modes*: Empty, zero, boundary inputs; unhandled error states; partial failures; race conditions; and missing fallback behavior.

#### 3. Report Output

Write every finding as one line in this grammar:

```
## <Section> — <tag>: <defect> → <required change>
```

`<Section>` is the target plan heading; `<tag>` is the axis tag above. Cite `<file>:L<line>` inline for findings referencing existing code.

Structure your review as:
- `## Verdict`: One line — safe to implement as written.
- `## Axis Coverage`: One line per axis — `<axis>: clean` or `<axis>: <n> finding(s)`; on a re-review round, `<axis>: out of scope` for an axis Review Scope excludes. Explicitly list every axis.
- `## MUST-FIX`: Findings blocking implementation, or "None."
- `## SHOULD-FIX`: Weaknesses worth correcting first, or "None."
- `## CONSIDER`: Optional improvements, or "None."
- `## Shorter Path`: Materially simpler plan meeting all criteria, or "None — the plan is already minimal."
````

**Dispatch**: use orchestrator-supplied dispatch invocations when present (retains fan-out breadth and provider pinning). Otherwise dispatch backgrounded and yield the turn; see `dispatch` for cascade, flags, and log monitoring. Dispatch runs structurally read-only.

**Done when:** the plan is resolved (or authored), attached, the prompt is populated, and dispatch is launched backgrounded with the turn yielded.

---

### 2. Adjudicate each actionable claim

Adjudicate per `dispatch`'s `references/alignment.md` § Adjudication (scope, verdict table, evidence over votes, dispute escalation).

Locus note: ground truth is the **requirement plus the host repository's rules**. Claims citing existing code are verified against the cited `<file>:L<line>`; claims proposing a plan change are verified against the target `## <Section>`.

**Done when:** every actionable claim carries a verdict and all disputes are resolved (by the user in standalone mode, or returned unescalated per the orchestrator's consensus rule in orchestrated mode).

---

### 3. Fold findings into the plan and report

1. **Update plan body**: Apply accepted `MUST-FIX` and approved modifications **directly to the target plan sections** on disk (`Proposed Changes`, `Verification Plan`, `Rollback & Blast Radius`, etc.). Fold accepted `SHOULD-FIX` / `CONSIDER` items into the plan body or record under **Out of Scope** with rationale.
2. **Record review outcomes**: append this round's log under `## Review Findings & Resolutions` in the plan file per `dispatch`'s `references/alignment.md` § Resolutions Log.

**Standalone mode**: report to the user per alignment § User Report. **Orchestrated mode**: skip the user report — the orchestrator's own handoff covers it.

**Done when:** the plan body reflects all accepted changes, `## Review Findings & Resolutions` is updated with this round's adjudications, and (standalone only) the user report is delivered with provider prefix.
