# Safe preparation, truthful diagnostics and bounded quota routing

> **Status:** draft
>
> **Level:** high — fixes affect executable preparation and recoverable provider routing; diagnostics must remain observational.

## Intent & Problem

Fix the defects and avoidable routing work found in self-build session `01a14f6f-3fa3-7bb2-8dfe-3972c3663709`: preparation can write before session ownership checks, diagnostics can imply active work or complete usage accounting without evidence, and successive waves repeatedly probe the same quota-exhausted model.

This spec governs resulting Dispatch behavior. The current invocation investigates and produces this fix spec and a reviewed implementation plan; implementation follows later authorization. The supporting `investigation.md` records evidence, reproductions and dispositions for every reported issue.

## Background

- The documented materializer in `skills/dispatch/references/self-build.md` creates scratch and writes a helper before checking initialized-session ownership or linked ancestors. Disposable probes executed that block unchanged: an arbitrary uninitialized directory and a `.state` junction both accepted a helper write and exited 0. Later capture validation cannot protect an earlier write. The current end-to-end test extracts helpers directly and misses the materialization entry.
- Diagnostics measure elapsed journal intervals. The final review result at 17:09:44.307 UTC preceded its ruling at 19:10:55.417 UTC; a usage-reset continuation accounts for much of that gap. H6 calls it a host turn. The duration is valid; active reasoning time is unmeasured.
- Provider diagnostics measured 6,095,929 tokens with coverage 15/26. Separate root/native snapshots contain 47,638,801 cumulative input tokens, including 46,684,544 cached input tokens. These have different measurement boundaries. Optional native/write tokens and duration attestations already exist, but do not establish a complete measured host total.
- Five quota failures cost about 27 seconds directly. `runVoice` restarts its model cascade for every wave. That follows current policy but repeats known failures. Slow successful reserves dominate review duration; quota suppression alone cannot be presented as a large elapsed-time saving.
- Existing repository rules already require lean context, retained handles, completion waits and focused checks before final aggregate verification. The observed operating-practice failures do not justify more standing instructions.

## Requirements

### REQ-1 — Validate preparation ownership before writing

The documented preparation entry must establish the canonical target and initialized session under that target's `.scratch`, reject pre-existing linked path components and invalid helper targets, and validate existing helper bytes before creating directories or helper output. Supply the target explicitly where ownership cannot otherwise be established. Preserve valid idempotent materialization and refuse different existing helper content.
- Acceptance: The actual entry rejects uninitialized/unowned sessions and linked session, `.state`, scratch or helper ancestors before modifying those locations. A valid session materializes only the selected helper in owned scratch. Identical existing helpers are reusable; different bytes remain intact with a failure.

### REQ-2 — Test the complete documented preparation sequence

Exercise materialization, capture and verification through the documented entry sequence. Preserve complete-controller inventory checks and fixed-controller continuation. Enumerate the reference's executable blocks and give each write boundary a test or an explicit evidence-backed disposition. Use existing hooks; a test-only extraction shortcut must not replace the entry being claimed.
- Acceptance: Regression cases fail on the reproduced original behavior and pass after repair. Valid preparation produces a verified complete inventory. Invalid capture inputs cannot create snapshot output; permitted owned helpers and partial copies follow documented recovery. Restore, ledger and cleanup guards retain coverage or receive targeted checks where absent. Test budgets remain unchanged.

### REQ-3 — Report elapsed wait and usage scope truthfully

Describe host gaps as elapsed host-await time, which can include work, pauses and scheduling. Infer neither active reasoning nor reset duration without evidence. Label measured provider usage and coverage, native/write estimates and unavailable values separately. Identify the frame-byte-derived orchestrator estimate as frame exposure, not full orchestrator usage. Preserve totals and cached/uncached input distinctions.
- Acceptance: Replaying the source gap preserves its duration without asserting two hours of active adjudication. Reports state that provider measurements and frame estimates are not full conversation totals. Missing usage stays unavailable and reasoning is not added twice. Privacy, sanitization, size limits, disabled structural absence and failure isolation remain intact.

### REQ-4 — Avoid repeating valid quota failures across session waves

Retain quota evidence within the session for the exact configured provider, model alias and launch mode. While evidence is valid, later waves advance through the existing cascade without launching that combination. Evidence has bounded expiry and an explicit reprobe path. Other models and modes stay eligible; a failure does not establish provider-wide exhaustion or independent account quotas.
- Acceptance: Scripted successive waves, including a later run in the same session, launch a quota-failed combination once while its evidence is valid, then use configured alternatives. Expiry and explicit reprobe permit a new attempt. Other sessions and combinations stay eligible. Malformed or unverifiable evidence cannot silently eliminate required coverage. Concurrent updates, interruptions and replay preserve accepted outcomes without relaunching completed effects.

### REQ-5 — Preserve routing assurance and recovery

Retain every required independent slot, configured order among eligible models, mode cascade, reserve consumption, same-platform native fallback, failure reporting, deadlines and launch attestation. Record skipped-launch reasons without inventing measured invocations. Bind eligibility decisions to immutable wave input; recovery reuses decisions for already-issued work. Reprobe affects future work only. Quota state belongs to execution policy, independent of optional diagnostics.
- Acceptance: Cover all-suppressed voices, alternate models/modes, reserves, native fallback, concurrent slots, expiry, configuration changes and recovery after durable boundaries. Required coverage and timing budgets remain unchanged. Suppression works with diagnostics disabled; diagnostics cannot determine policy.

## Non-goals

- Automatic reviewer replacement, reduced assurance, or relaxed timing, concurrency, coverage or acceptance gates.
- A generic documentation executor, scheduler, external dependency, host-log scraper or full host/native usage-ingestion protocol.
- Inferring historical intermittent failure causes, rewriting journals or promising unmeasured latency, token or billing savings.
- More standing instructions for context, waiting or check ordering where existing rules apply.

## Constraints

- Preserve fixed-controller self-build, structural write boundaries, unrelated work, local configuration and supplied evidence.
- Keep Dispatch stack-neutral and portable. Use in-memory fixtures for pure policy; real storage only for byte, link, concurrency and recovery claims.
- Implementation must pass focused affected checks, applicable hash/diagram generation, `npm test` and `git diff --check` after final bytes. Failed checks remain open.
- This invocation ends with completed investigation, fix spec, reviewed implementation plan and a scoped commit. Product implementation and push are not authorized by the commit request.

## Decisions

### DEC-1 — Fix artifacts govern product behavior

- Context: The first draft specified investigation deliverables instead of fixed behavior.
- Options: Planning-process acceptance; product fix requirements.
- Choice: Product fix requirements (user).
- Rationale: The user clarified that investigation precedes a spec and plan for fixing verified issues.
- Rejected: Completing an investigation is not an implementation acceptance test.

### DEC-2 — Three focused fix areas

- Context: Preparation safety, reporting semantics and quota routing have distinct seams.
- Options: Focused fixes; configuration only; broad scheduling/telemetry redesign.
- Choice: Recommend safe preparation and complete-sequence tests, truthful diagnostics, then bounded quota routing.
- Rationale: Address demonstrated behavior without a new coordination subsystem. The implementation plan must declare dependencies and file ownership.
- Rejected: Configuration alone leaves unsafe writes and misleading reporting; broad redesign adds unsupported scope.

### DEC-3 — Defer unproven extensions

- Context: Successful reserves were slow and full-host cost unavailable, but no portable equivalent faster roster or disjoint usage-ingestion contract was established.
- Options: Automatic replacement and new ingestion; explicit roster selection plus truthful reporting.
- Choice: Recommend explicit selection and truthful reporting now; defer automatic replacement and full usage ingestion.
- Rationale: Preserve assurance and keep measurement boundaries explicit. Existing optional native attestations remain available.
- Rejected: Treating all latency as quota overhead or summing overlapping cumulative counters.

## Discussion Record

- 2026-10-19: User requested investigation and fix proposals through dispatch-plan and brainstorming for the named session, then a commit after completion.
- 2026-10-19: User clarified: "do the investigation, spec and plan should be for how to fix them (if there are issues to be fixed)".
- 2026-10-19: Disposable reproductions confirmed invalid-session and junction-mediated helper writes. Existing diagnostic report tests passed 43 tests; wave tests passed 13. These baselines do not close the reproduced gaps.

## Open Questions

- None requiring more investigation before scope approval. The implementation plan must settle quota expiry, persistence and reprobe interfaces against these requirements before writer launch.
