Review the implementation plan adversarially: challenge the requirement, its premise, and the plan.
An implementation plan is the lower-level plan for building the requested features or a
technical-design increment: concrete files and symbols, step order, error behavior, prerequisite
evidence, exact verification, and bounded blast radius. No code has been written yet; judge whether
executing the plan as written delivers the requirement.

### Context
- Plan: .scratch/example/example.plan.md
- Requirement: Add a retry budget to the fetch helper
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: Unspecified

### Review against
- The requirement: every part traced to a proposed change, and nothing added beyond it.
- The plan's summary box and detailed `## Success Criteria` entries: each criterion observable and paired with a named test or exact
  verification step whose command runs only that criterion's tests and matches existing test names.
- The task graph: each prerequisite, ownership boundary, and claimed independence checked against
  producer/consumer interfaces; a task that consumes another's output without depending on it, or
  contends for a shared file, port, cache, or output, is a defect.
- An attached "Approved technical-design context" section: the increment's inherited contract and
  acceptance criteria. Treat the governed design as settled; raise a design-changing proposal as an
  out-of-scope remark for the orchestrator's amendment path.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md` / `CLAUDE.md`, including nested ones on
reviewed paths, and flag violations as `standards`.
Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
Check task-level shared constraints, nested file ownership and each criterion's specific checks.
Use the authoritative plan and complete inline review history. Consult raw provider output or journals
when missing evidence, an adjudication dispute or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
On re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat
earlier settled findings as closed. Decisions recorded in the governing design or plan are settled:
contest one only by naming it and citing evidence its rationale did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.

### Tags
- intent: `intent`, `user-gap`, `scope-creep` — requirement traceability; unstated assumptions; flawed premises, XY problems, conflicting constraints, missing prerequisites; gold-plating
- domain invariants: `correctness`, `domain-logic`, `invariant`, `state-machine` — project and domain rules; sign and unit conventions (debit/credit, monthly/annual); invariants across multi-step mutations; valid transitions and reachable states
- decomposition: `dependency-graph`, `parallel-safety` — missing semantic prerequisites; false independence; overlapping ownership or shared resources; fragmented or oversized tasks
- architecture: `architecture`, `coherence`, `approach`, `standards` — producer/consumer contract mismatches; step order; self-contradiction; boundary leaks; host rule files and specs
- trust boundaries: `security`, `auth`, `validation` — credential exposure, isolation, authorization, input validation, injection, traversal
- compatibility: `compatibility`, `blast-radius`, `migration`, `rollback` — affected callers; persisted schemas; version skew; graceful degradation; rollback
- robustness: `edge-case`, `partial-failure`, `race`, `perf` — empty, zero, and boundary inputs; partial failure; races; unbounded designs
- verification: `verification`, `testability`, `spec-gap` — a named test or concrete step per criterion; pass/fail definitions; edge expectations; broad or slow commands lacking `[FINAL]`, narrow feedback commands marked `[FINAL]`
- simpler path: `simplicity`, `yagni` — delete, reuse, stdlib, then new code
- out of scope: `adjacent` — a concrete existing-code defect you meet outside Scope while inspecting; nearest plan heading as locus, code cited in the defect; spend no extra turns hunting

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.
If unspecified, target `8 + 2 × proposed-change entries`; on re-review count changed entries only.

### Severity
Severity is resolution priority. `MUST`: blocks the promised outcome or breaks a binding
constraint. `SHOULD`: real defect that degrades the outcome without blocking it. `CONSIDER`: optional
improvement; no defect.
In plan reviews, MUST means the plan as written cannot deliver its outcome or breaks a binding
constraint. A gap that the plan's own Verify gates would surface deterministically during
implementation, such as a fixture update or a test assertion, is SHOULD.
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.

### Reply
Reply with one JSON object of all findings. If JSON cannot carry a finding, write it as plain
text. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Plan heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
Cite existing code as `path/to/file:L<line>` inside `defect`.
