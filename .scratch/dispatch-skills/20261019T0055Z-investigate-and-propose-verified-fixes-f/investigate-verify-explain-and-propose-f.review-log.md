# Review log: investigate-verify-explain-and-propose-f.plan.md

## Review Findings & Resolutions

### Review 20261019T0055Z-investigate-and-propose-verified-fixes-f/001-plan/plan.review.s1

#### Round 1 — full

- Reviewers: claude[0] claude-opus-5-5 (low), agy[0] gemini-4-argon (medium), opencode[0] opencode-go/muse-spark-1.3-contributor (xhigh)

##### R1-F001

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: claude[0]
- Location: § T4 — Bind quota eligibility to recoverable waves
- Category: state-machine
- Finding: wave.ts change lets a local worker apply quota evidence it observes mid-wave to combinations it has not launched yet, but that skip decision lives only in process memory. A replacement worker after a crash recovers from the frozen input without that evidence, so it can launch a combination the original worker had skipped, or take a different cascade path. REQ-5 requires recovery to reuse the decisions for work already issued, and SC6/SC7 assume deterministic replay.
- Required change: Choose one of two fixes. (a) Drop mid-wave local suppression, so only the frozen input snapshot decides. (b) Write each local skip decision durably next to the slot outcome before acting on it, and have waveRecovery read it back. Then add a crash-after-local-skip case to 'quota decisions survive worker recovery boundaries'.
- Ruling:
  REQ-5 requires stable issued decisions. Remove mid-wave suppression; only the immutable input governs launch eligibility.

##### R1-F002

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: claude[0]
- Location: § T3 — Persist bounded quota eligibility and expose reprobe
- Category: edge-case
- Finding: The cap of 64 observations per key, plus the rule to ignore all of a key's evidence when the cap is exceeded, conflicts with pruning that runs only 'during explicit reprobe or future preparation'. The plan does not define 'future preparation' as a store operation. A long session with repeated hourly failures and no reprobe can pass the cap, and the key then silently stops being suppressed. REQ-4 requires bounded expiry, not an evidence drop caused by volume.
- Required change: Make wave-input preparation remove validated expired observations for the keys it reads, before it applies the cap. Alternatively, count only unexpired observations against the cap. Add the over-cap case to quota-state.test.ts.
- Ruling:
  The volume cap can discard useful valid evidence. Replace the growing scan with generation/hour buckets: at most two candidate buckets can hold unexpired one-hour evidence.

##### R1-F003

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: claude[0]
- Location: § T3 — Persist bounded quota eligibility and expose reprobe
- Category: architecture
- Finding: The lib/cli.ts invariant says 'Unknown provider/mode is a usage error'. parseCommand in lib/cli.ts has no provider specifications, so it can only check syntax. Provider and mode validity depend on the selected controller's specifications, which dispatch.ts resolves. The plan does not say which layer owns this check, so it can be missed or duplicated.
- Required change: Have cli.ts check only shape: nonempty values and flags scoped to the action. Give provider and mode membership checks to dispatch.ts, against the selected controller's specifications and before any write. Add one unknown-provider case to the SC5 subprocess test.
- Ruling:
  Clarify ownership: parseCommand owns argv shape/action scope; dispatch owns provider/mode membership against its selected specifications before writes. Existing injected provider validation may remain as an early check.

##### R1-F004

- Status: **[Fixed]**
- Severity: CONSIDER
- Sources: claude[0]
- Location: § T4 — Bind quota eligibility to recoverable waves
- Category: coherence
- Finding: There are two exported sessionDirOf functions: skills/dispatch/scripts/effects/handoff.ts:L13 and skills/dispatch/scripts/machines/root.ts:L382. The dispatch.ts wiring says 'existing sessionDirOf' without naming which one.
- Required change: Name the module whose sessionDirOf dispatch.ts wiring must use. Prefer the one dispatch.ts already imports.
- Ruling:
  Use the existing effects/handoff.ts import explicitly; no new root-machine dependency.

##### R1-F005

- Status: **[Fixed]**
- Severity: CONSIDER
- Sources: claude[0]
- Location: § Verification Plan
- Category: verification
- Finding: REQ-2 and REQ-5 say test and timing budgets must not change. The plan adds three E2E files (self-build-preparation, quota-state, quota-routing) that run subprocesses, and it gives no runtime bound and no check against the current per-file budgets.
- Required change: In Manual Verification, record per-file durations for the new E2E files against the existing budget mechanism, and keep each file inside it without raising limits.
- Ruling:
  Record durations and preserve existing limits. scripts/test-reporter.ts explicitly exempts E2E from its 1000ms per-file gate; do not invent an E2E budget. Keep existing subprocess deadlines and non-E2E timing gates.

##### R1-F006

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: opencode[0]
- Location: § T2 — Make diagnostics describe their measurements
- Category: coherence
- Finding: Plan requires explaining elapsed host-await, provider coverage, native/write estimates and frame-exposure limits in skills/dispatch/references/diagnostics.md:1 while staying within the existing byte budget, but that file holds ~941 bytes leaving ~69-83 bytes under the skills/dispatch/scripts/domain/diagnostics.ts:60 DIAGNOSTIC_LIMITS.instructionBytes 1024 limit; tests/integration/diagnostics-contract.test.ts:11 enforces the budget with CRLF accounting, so the four required explanations cannot fit without shortening protected retro/privacy text and SC3 Verify will fail deterministically.
- Required change: Keep report-scope truth in renderDiagnostics Summary/Overview (already in T2) and human troubleshooting docs; keep diagnostics.md to a minimal H6 pointer within 1024 bytes, or amend the spec to raise the instruction budget with protocol justification and add an explicit byte-count assertion to SC3 Verify.
- Ruling:
  Verified current diagnostics.md is 1010 bytes with LF and exactly 1024 with CRLF. Preserve its protected protocol; put measurement meaning in renderer and existing human troubleshooting, with only a same-budget H6 clarification in the retro instruction.

##### R1-F007

- Status: **[Rejected — Closed by Reviewer]**
- Severity: SHOULD
- Sources: opencode[0]
- Location: § T3 — Persist bounded quota eligibility and expose reprobe
- Category: simplicity
- Finding: skills/dispatch/references/templates/plan.md:121 requires Reuse on every [NEW] entry, but [NEW] docs/self-build-executable-evidence.md in T1 and [NEW] tests/unit/policy/quota.test.ts in T3 omit it; existing tests/unit/policy/cascade.test.ts:29 owns generic cascade ordering that quota.test must distinguish from cooldown eligibility, and existing E2E fixtures owning disposable Git/session setup that the new tests must reuse are unverified, so duplication risk is unchecked.
- Required change: Add Reuse lines to both NEW entries recording names searched and why none was reused (e.g. failureDisposition/next/cascade.ts for quota.test; e2e fixture for docs) or write none found with rationale.
- Ruling:
  Both cited NEW entries already have explicit Reuse lines in the reviewed revision: the docs inventory reuses the operational reference and delivery proof; quota.test reuses generic cascade coverage and adds only distinct cooldown eligibility. T1 also names the existing tests/helpers/e2e.ts fixture. No missing field or demonstrated duplication exists.

##### R1-F008

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: opencode[0]
- Location: § SC1
- Category: verification
- Finding: skills/dispatch/references/templates/plan.md:109 requires Verify to select by literal behavior title and fail on zero selection; SC1 Verify uses --test-name-pattern="documented preparation" substring while SC2 uses anchored ^fixed controller completes delivery and continuation after candidate runtime changes$ in tests/e2e/implement.test.ts:24 and SC5/SC7 use anchored titles, so SC1 can match zero, one, or many tests without proving the intended write-boundary contract.
- Required change: Define the full behavior title in T1 (e.g. documented preparation rejects unsafe ownership and linked paths) and use anchored ^...$ pattern in both SC1 Verify and RED with zero-selection rejection as stated in Verification Plan.
- Ruling:
  Name and anchor the full preparation behavior title and retain explicit rejection of zero selection; anchor other alternative title selectors consistently.

##### R1-F009

- Status: **[Rejected — Closed by Reviewer]**
- Severity: SHOULD
- Sources: opencode[0]
- Location: § T3 — Persist bounded quota eligibility and expose reprobe
- Category: dependency-graph
- Finding: Planned skills/dispatch/scripts/lib/quota-store.ts lives in lib/ where tests/integration/dependency-direction.test.ts:8 allows only same-layer plus type-only skills/dispatch/scripts/core/types.ts:1 imports, and planned skills/dispatch/scripts/policy/quota.ts is in PURE policy per tests/integration/dependency-direction.test.ts:20 with no Date/clock I/O; plan only forbids importing policy/machines, leaving open value-imports of domain/effects that would violate the matrix. Allowed reuse is LinkFs in skills/dispatch/scripts/lib/fs-ext.ts:4 and readManifest/canonicalRepositoryRoot in skills/dispatch/scripts/lib/session.ts:46,103, but domain value-imports are not allowed.
- Required change: Strengthen T3 invariants to value-import only lib/* plus type-only core/types.ts with no value-imports of policy/domain/effects/machines/providers, and rely on the cheap gate tests/unit/domain/diagnostics-report.test.ts tests/integration/dependency-direction.test.ts tests/integration/diagnostics-dependencies.test.ts tests/integration/diagnostics-contract.test.ts tests/unit/policy/cascade.test.ts to surface any violation before npm test.
- Ruling:
  The reviewed plan already requires the repository dependency matrix under T3 core/types invariants and includes dependency-direction.test.ts in the cheap gate. That matrix forbids lib cross-layer value imports, while allowing type-only core/types. Applicable host rules are not relaxed by an incomplete repetition in a file description; no contradictory import is proposed.

#### Round 2 — full

- Reviewers: claude[0] claude-opus-5-5 (low), agy[0] gemini-4-argon (medium), opencode[0] opencode-go/muse-spark-1.3-contributor (xhigh)
- No findings.
