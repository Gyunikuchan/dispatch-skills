Review the technical design adversarially: challenge the requirement, its premise, and the design.
A technical design is the higher-level architectural plan that breaks a large problem into smaller
increments, each later delivered through its own implementation plan. Review at that altitude:
raise architectural issues, and leave file-by-file and symbol-level detail to the plan reviews. No
code has been written yet.

### Context
- Design: .scratch/example/example.design.md
- Spec Path: .scratch/example/example.spec.md
- Spec Hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: Unspecified

### Review against
- Governing targets: every spec REQ and DEC, the design, and its per-increment acceptance criteria.
- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets. Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to the host rule files that the quality section's discovery rule finds.
Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.
A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or ledger records
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
Findings apply to the captured revision and Scope. Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it; those interfaces or call sites may be outside Scope only as needed to substantiate the defect. Spend no extra turns hunting for adjacent findings. Apply this discovery rule to every review kind. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. The governing spec's Decisions and Non-goals, and decisions recorded in the governing design or plan, are settled:
contest one only by naming it and citing evidence it did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Host rule files: before judging or editing, find every file that sets conventions for in-scope paths. Examples: agent rule files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`), contributor guides (`CONTRIBUTING.md`, `CODING_STANDARDS.md`, and style guides they link), and nested copies on in-scope paths; the nearest copy wins over its parent. Read only those that apply; skip rules that configured linters, formatters or type checkers enforce.
- Precedence: Applicable host rule files govern first. For nested `AGENTS.md` files, the nearest file wins over its parent. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, verification requirements, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- **intent** — Trace the ask to applicable REQs and DECs, and check that each is served. Identify a misread user ask, unmet user need, unstated assumption, flawed premise, gold-plating, or XY problem; add nothing beyond the ask. Route a design or plan that changes intent through the user gate.
- **maintainability** — Delete › reuse › stdlib › new. DRY: one source of truth; search the repository by name and behaviour for an existing equivalent before adding any exported/shared symbol, helper, module or type. Rule of three: extract on third use; duplication beats wrong abstraction. YAGNI, KISS; deep modules, low coupling, high cohesion. Remove needless branches; fix root causes once. Preserve Chesterton's fence; names, docs and comments explain why and change with behaviour. Check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers. Smells (judgement calls, never `MUST` alone): Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Repeated Switches, Message Chains, Middle Man, Speculative Generality, Refused Bequest, Mysterious Name.

- **spec** — Apply IEEE 29148 quality: requirements are unambiguous (one interpretation), consistent, verifiable, complete, feasible, and singular (one requirement per statement; identify non-singular requirements). Check completeness across behavior, interfaces and data, failure and recovery, quality requirements, assumptions, and dependencies. Identify misplaced architecture or execution detail while retaining imposed design constraints. An open question that could change scope, behavior, or risk blocks approval; never invent intent, and route a gap through the user gate.

- **usability** — Give each artifact one outcome summary: At a Glance **What** states it and **How it works** adds one method line. State each fact once; a summary must add a distinct view, not restate a later section. Keep task and increment behaviour visible before `<details>`; use the block for file changes and verbose detail. Use `> [!NOTE]` for information the user must know and `> [!IMPORTANT]` only for a decision they must make, consistent with `Decide:` when present. Keep machine fields outside callouts, prefer point form, and retain every required field.

### Visual-aid bar

A visual aid is a diagram, table, code, pseudo-code or data block. Include one when it explains content prose explains poorly or gives a skimmable map of three or more related items in long prose. Match the content to its form:

| Content | Form |
| --- | --- |
| Components and boundaries | Architecture diagram |
| Runtime order | Flow or sequence diagram |
| Lifecycle | State diagram |
| Items with attributes | Table |
| Interfaces and data shapes | Code or data block |
| Algorithm | Pseudo-code |
| Behaviour change | Before/after table or snippet |

Reject duplicate, decorative or stale visuals. A repeated visual or required table needs to reveal new structure, such as parallel lanes or a critical path. Add no fixed count. Give each diagram a one-line text summary; tables and code/data blocks need none. Put orientation visuals in At a Glance and section visuals beside their prose.

- **intent** — Trace every goal to a requirement and state non-goals. Check that the design serves the requested users and does not add work beyond the ask.
- **architecture** — Define separation of concerns, component ownership, contracts, data flow, and boundaries. Weigh alternatives and trade-offs, apply the shared simplicity order, and check internal consistency and step order.
- **correctness** — State system-wide invariants that hold within and across increments, including preconditions, postconditions, valid transitions, and reachable states.
- **reliability** — Cover edge, boundary, and empty inputs; partial failure and update; atomicity and crash consistency; idempotency; races and TOCTOU; floating promises; fail-closed behavior; data loss; and destructive-operation guards.
- **security** — Map trust boundaries and least privilege; use STRIDE to check spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege; check isolation, authorization, validation, ownership, and sensitive-data handling.
- **performance** — Check Big-O on hot paths, N+1 work, unpaginated reads, missing indexes, backpressure, bounded queues, concurrency and memory, resource closure, and event-loop blocking.
- **compatibility** — Check Hyrum's law and semver, breaking changes, expand/contract migration, rollback, version skew with graceful degradation, affected callers, persisted schemas and serialized formats, and OS/shell/path/encoding portability.
- **operability** — Check deployment and runtime operation, observability through logs, metrics, and traces, actionable diagnostics, configuration, and a kill switch.
- **testing** — Make every criterion observable and together sufficient for the goals, including each increment's acceptance criteria. Check testability and an exact verification path.
- **usability** — Check WCAG accessibility, POLA, CLI/API ergonomics, and actionable error messages.
- **decomposition** — Choose independently deliverable, correctly ordered increments with safe parallel work, vertical slices, INVEST sizing, final integration, and no concentration of risk in one increment.

### Tags
Tag each finding with one family; the quality bar's bold family bullets define each family and its hints.
- `intent`
- `spec`
- `correctness`
- `reliability`
- `security`
- `performance`
- `compatibility`
- `maintainability`
- `architecture`
- `decomposition`
- `operability`
- `testing`
- `usability`
- `standards`
- `adjacent`

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.

### Severity
Severity is resolution priority. `MUST`: blocks the promised outcome or breaks a binding
constraint. `SHOULD`: real defect that degrades the outcome without blocking it. `CONSIDER`: optional
improvement; no defect.
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.
Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known
vulnerability class. Preference is not a finding; between technically equivalent approaches, the
author's choice stands. Simplicity findings name the cost removed: concepts, files, or code paths.
Report one finding per defective predicate; list every failing state of it in `defect`.

### Reply
Reply with one JSON object of all findings. If JSON cannot carry a finding, write it as plain
text. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Design heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

When Pending MUST rejection confirmation assigns requests, add `confirmations` to this object. Answer each assigned request exactly once with exactly `requestId`, `decision` (`agree` or `disagree`) and a nonblank evidence-backed `rationale`. Keep ordinary `status` and `findings`. A pending MUST rejection is open until explicit agreement; omission is not confirmation.

Use only the tags above.
Cite existing code as `path/to/file:L<line>` inside `defect`.
For an adjacent finding, use the nearest design heading as locus.
