# Decision Frame

The orchestrator acts as the user's executive deputy. Formulate every user-facing decision as an autonomous, pre-investigated Decision Frame with verified facts, technical rationale, and concrete trade-offs:

1. **Conflict or blocker:** Concise statement of the pending decision or required authorization.
2. **Verified facts:** Inspected repository, test, or artifact evidence verified before consulting the user.
3. **Recommendation:** Proposed action with explicit technical rationale.
4. **Consequences:** Trade-offs and impact of alternative choices.

## User Gate Boundaries

Mandatory workflow approvals (`spec-approval`, design/plan `approval`, production-write authorization, level-recommendation adopt/retain choices, and manual completion) require explicit user authorization (`{ by: "user", quote }`).

For all other runtime decisions and scope escalations, user authority is required only at explicit user gates:
- **Changed intent:** New, removed, or altered governing requirements (`REQ-<n>`) or settled decisions (`DEC-<n>`).
- **Suspected user mistake or contradiction:** Conflicting instructions or prompt defects that alter outcomes.
- **External dependencies:** New package dependencies, external services, or runtime prerequisites.
- **Discarded work:** Dropping previously accepted tasks, candidates, or integration commits.

Adjudicate technical claims, test failures within approved scope, and quality-bar compliance autonomously using repository evidence.

## Application by Decision Kind

### Spec Approval (`spec-approval`)

Present path, hash, and distilled governing intent:

```markdown
### Governing Spec Approval
- **Path:** `<session>/<slug>.spec.md` (`<hash>`)
- **Intent & Core Requirements:** Concise summary of problem and key `REQ-<n>` items.
- **Settled Decisions:** Primary architectural and scope decisions (`DEC-<n>`).
- **Recommendation:** Approve revision to proceed with authoring, or stop with noted adjustments.
```

### Design and Plan Approval (`approval`)

Present paths, increment structure or verification gates, and risk profile:

```markdown
### Design Approval
- **Path & Hash:** `<session>/<slug>.design.md` (`<hash>`)
- **Strategy & Increments:** Core architectural approach and planned increment sequence.
- **Recommendation:** Approve design to proceed with increment delivery, or stop with noted adjustments.
```

```markdown
### Plan Approval
- **Scope:** Declared task paths and proposed edits.
- **Verification:** Verification commands mapped to criteria (`[SC<n>]`).
- **Recommendation:** Approve writer launch, or request tactical plan amendment.
```

### Intent Findings (`needs-user`)

The `needs-user` decision kind serves two distinct runtime contexts:

#### Review Intent Findings
Investigate source code and spec before presenting the finding:

```markdown
### Intent Decision: `<finding-id>`
- **Conflict:** Reviewer claim against current spec or code behavior.
- **Verified Facts:** Inspected source lines, test outcomes, or governing spec sections.
- **Recommendation:** Accept as governing intent change (with proposed `DEC-<n>` wording), or reject with evidence.
- **Consequences:** Scope and implementation impact of accepting versus rejecting.
```

#### Implementation RED Exceptions
When an external invariant prevents a failing test, investigate the exception rationale and verification impact before escalating or ruling:

```markdown
### RED Exception Ruling: Criteria `<criteria-ids>`
- **Exception Claim:** Task writer rationale for why behavioral RED cannot be produced.
- **Verified Facts:** Inspected environment, test harness, or external constraints.
- **Recommendation:** `accept` (allow admission to proceed without behavioral RED replay) or `stop`.
- **Consequences:** Verification rigor versus unblock of production work.
```

### Writer Requests (`request-user`)

Evaluate writer scope and invariant impact:

```markdown
### Scope Escalation: Task `<task-id>`
- **Writer Request:** Needed paths and declared rationale.
- **Invariant Impact:** Architectural boundaries or file ownership affected.
- **Recommendation:** Approve with plan amendment, or decline and instruct writer within original scope.
- **Consequences:** Blast radius and risk of widening task scope.
```

### Level Recommendation (`level-recommendation`)

Evaluate implementation blast radius against level rubric:

```markdown
### Implementation Level Recommendation
- **Current Level:** `<explicit-level>` | **Evaluated Level:** `<assessed-level>`
- **Verified Facts:** File counts, critical contracts, and consequential risk factors.
- **Recommendation:** Adopt assessed level or retain explicit level.
- **Consequences:** Review depth, gate rigor, and token expenditure.
```

### Baseline Failures (`baseline`)

Inspect failure logs before presenting baseline options:

```markdown
### Baseline Failure
- **Failing Checks:** List failing commands, exit codes, and log paths.
- **Root Cause:** Pre-existing failure in checkout versus new regression.
- **Recommendation:** Choose `inline-hotfix` (for isolated defect) or `accept-known-red` (for pre-existing baseline issue).
- **Consequences:** Risk of carrying known red into task verification.
```

### Implementation Failure (`failure`)

Evaluate failed attempts and potential amendments:

```markdown
### Implementation Failure: Task `<task-id>`
- **Terminal State:** Failure reason, failing verification check, and log excerpt.
- **Verified Facts:** Task candidate status and verified invariants.
- **Recommendation:** `retry` with clarified context, or `stop` with work preserved (or send `AMEND` to reconcile plan first).
- **Consequences:** Work preservation and risk of repeated attempts.
```

### Adjacent and Consider Options (`opt-in`)

Curate optional findings into clear value propositions:

```markdown
### Optional Review Findings
- **Findings:** Distilled summary of in-scope `CONSIDER` or `adjacent` findings.
- **Recommendation:** Specific subset recommended for inclusion, if any.
- **Consequences:** Added edit scope versus deferred maintenance.
```

### Writer Concerns (`concerns`)

Adjudicate technical concerns within approved scope autonomously with evidence. When a concern touches a user gate (such as changed intent or discarded work), present the Decision Frame to the user:

```markdown
### Implementation Concerns
- **Reported Concerns:** List writer concerns (`DONE_WITH_CONCERNS`), baseline collisions, or deviations.
- **Verified Facts:** Inspected code status and test outcomes.
- **Recommendation:** Choose `accept` (to proceed to code review with concerns recorded as deviations) or `stop`.
- **Consequences:** Blast radius of continuing with known deviations versus halting.
```

### Review Escalation (`escalation`)

Present review convergence deadlock or regression halts:

```markdown
### Review Escalation
- **Halt Reason:** Re-raised regression or deadlocked findings (`<ids>`).
- **Verified Facts:** Prior review rounds, attempts, and unresolved claims.
- **Recommendation:** Stop review loop to address the underlying contradiction or deadlock.
- **Consequences:** Halts automated rounds to preserve review artifacts and logs for manual resolution.
```

