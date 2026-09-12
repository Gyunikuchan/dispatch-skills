# dispatch-plan-review delegate prompt

Filled by `dispatch`'s `fill-template.mjs` (see `dispatch`'s `references/alignment.md` § Prompt Template Filling). The variable bullets below are the declared variables; `--list` reads them off this file.

## Prompt template

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
2. Targeted inspection: inspect files named in proposed changes and key adjacent call sites or interfaces to verify existing contracts, patterns, and blast radius (use AST / code-graph tools if available, e.g. codegraph, graphify). Read the files named in proposed changes plus their call sites, interfaces, and tests; stop at that blast radius.
3. Honour Review Scope: on a re-review round, confine the seven axes to the sections it names plus their contracts, confirm each logged resolution actually landed, and treat sections settled in earlier rounds as closed.
4. Tool Turn Budget counts every tool call. Complete grounding within it when it names a number; otherwise budget `6 + <## Proposed Changes entries>` turns, counting only entries changed since the previous round on a re-review. Spend a tight budget on AST / code-graph queries (`codegraph`, `graphify`) rather than full-file reads. Then emit the report immediately.

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
§ <Section> — <tag>: <defect> → <required change>
```

`<Section>` is the target plan heading; `<tag>` is the axis tag above. Cite `<file>:L<line>` inline for findings referencing existing code.

Structure your review as:
- `## Verdict`: One line — whether the plan is safe to implement as written, and what gates it.
- `## Axis Coverage`: One line per axis — `<axis>: clean` or `<axis>: <n> finding(s)`; on a re-review round, `<axis>: out of scope` for an axis Review Scope excludes. Explicitly list every axis.
- `## MUST-FIX`: Findings blocking implementation, or "None."
- `## SHOULD-FIX`: Weaknesses worth correcting first, or "None."
- `## CONSIDER`: Optional improvements, or "None."
- `## Shorter Path`: Materially simpler plan meeting all criteria, or "None — the plan is already minimal."
````
