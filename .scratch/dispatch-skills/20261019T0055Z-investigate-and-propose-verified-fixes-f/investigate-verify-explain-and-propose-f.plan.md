# Repair preparation boundaries, diagnostic labels and repeated quota routing

> **TL;DR:** Validate preparation before helper writes, report elapsed wait and usage scope accurately, and avoid repeating known quota failures without reducing review coverage.
>
> **Parent:** `.scratch/dispatch-skills/20261019T0055Z-investigate-and-propose-verified-fixes-f/investigate-verify-explain-and-propose-f.spec.md` · sha256:7615113c174af09993617f042e3bf4c79a14cb6c72079fd705e65aed56a91ac3
>
> **Decide:** Approve this implementation plan before writer launch. This invocation commits planning artifacts only.
>
> **Risk:** high — preparation writes and recoverable worker routing cross durable boundaries.
>
> **Scope:** Self-build reference and preparation tests; diagnostics renderer and contracts; session quota policy/storage, reprobe CLI, worker integration and recovery tests; generated integrity metadata.

## Background

The supporting `investigation.md` records disposable reproductions: the documented materializer accepted an arbitrary uninitialized directory and followed a `.state` junction before writing a helper. The capture helper's later checks do not protect that earlier write. The existing delivery proof extracts helpers directly and bypasses this entry.

`core/diagnostics.ts` measures journal intervals; `domain/diagnostics.ts` H6 calls them host turns. A measured 121-minute interval includes the source session's usage-reset pause. Provider diagnostics and host/native cumulative counters have different scopes; frame bytes estimate only frame exposure.

`effects/wave.ts` starts each `runVoice` at the first model/mode. Repeated probing is current designed behavior. Five failures cost about 27 seconds directly; slow successful reviewers account for much more latency. This plan promises eliminated redundant launches under a defined cooldown, not a measured wall-time or billing improvement.

## Key Decisions & Context

- Spec DEC-1 governs product behavior; this plan is an implementation input, not instructions to repeat the investigation.
- Under DEC-2, keep the executable reference and harden its materializer. Add explicit target argv and read-only initialized-session checks before its first write. Do not create a second production helper framework or generic Markdown executor.
- Quota cooldown is `H = 3600000 ms` from the first valid durably published observation in an hour bucket. Later coalesced failures do not extend it. A clock earlier than the observation makes it ineligible for suppression. Use no provider reset-text parser or new configuration knob.
- Quota keys are structured `(provider, configured model alias or null, actual launch mode)`. Hash their serialized tuple for filenames; never encode raw aliases as path segments. Different efforts share the same key. Changed aliases or modes use different keys; restarting the process does not clear a session's evidence.
- Add `session quota-reprobe --session-dir <dir> --provider <id> --mode <mode> [--model <alias>]`. Omitted model means the provider default (`null`), not a literal alias. Reprobe is a maintenance action for one exact key and affects only not-yet-published wave inputs. Validate session ownership and flags before writing. Do not combine it with init/reactivate/handoff flags or mutate configuration.
- Store generation markers and immutable failure observations under `<session>/.state/quota/<tuple-hash>/`. Each exact tuple has an atomic generation marker. Failure filenames identify the captured generation and `floor(observedAt / H)` hour bucket. Exclusive publication coalesces same-key/same-generation failures in one bucket to the first valid published observation; distinct keys or buckets do not overwrite. Reprobe atomically replaces one key's marker with a fresh opaque generation. Late old-generation failures cannot undo reprobe. Concurrent reprobes may coalesce; the last complete marker defines future eligibility.
- Each first-issued worker input embeds the validated eligibility snapshot, decision time, policy version, matching generations, exact skipped keys and reasons. Preserve this input unchanged on worker reattachment/recovery. A reset or expiry does not retroactively alter an issued wave. Concurrent waves already prepared may each launch an eligible key; this is not a global single-flight system.
- For each current roster key, including reserves, read only its current generation marker and the current and previous hour buckets under that generation, using the supplied clock. Validate schema, tuple, generation, bucket, timestamp and expiry. Bound observations to 4 KiB and generation records to 8 KiB. Old record counts cannot disable valid current evidence; perform no global or unbounded scans. Retain old buckets as session evidence outside the hot read path, with no new pruning or deletion machinery. Unsupported, oversized, malformed, future-dated or unverifiable state cannot suppress a launch. On quota-store failure use the normal cascade and a bounded operational warning. No credentials, provider output, absolute repository paths or prompts enter quota records. Missing old input snapshots mean no suppression, not a guessed policy decision.
- Quota state is execution state, independent of diagnostics. Keep accepted outcomes and required coverage authoritative. No machine event or protocol revision is needed if the new input fields remain additive and self-contained; recovery tests must verify that premise. Do not change semantic recovery contracts to avoid a failing test.
- Under DEC-3, defer automatic roster replacement and complete host usage ingestion. Apply existing lean-context, completion-wait and check-ordering rules rather than adding standing instructions.
- Future implementation must use the fixed-controller self-build procedure. Writers use CodeGraph before reading code, preserve unrelated work, and operate only inside their declared paths. A final task owns generated hashes to avoid concurrent generator writes.

## Open Questions & Assumptions

- No unresolved user decision. The one-hour bound is a tactical default, paired with explicit reprobe; it does not assert a provider's real reset schedule.
- Validate pre-existing linked paths and canonical ownership; this change does not claim protection against hostile concurrent replacement of filesystem ancestors. Preserve the existing local-workspace trust model.
- Preserve raw historical sessions. The source metrics end before final handoff and are not billing data. Tests and review durations overlap.

## Out of Scope

Automatic roster changes, reduced assurance, changed timing/concurrency/coverage gates, new dependencies, host-log scraping, full host/native accounting, historical journal repair, and unrelated test cleanup. Retain all existing test scenarios; add only discriminating regression cases.

## Task Map

| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Close the preparation entry write gap | Documented preparation rejects unsafe ownership and links before writing and remains usable for fixed-controller delivery | none | SC1, SC2 |
| T2 | Make diagnostics describe their measurements | Elapsed waits and token coverage are reported without implying active reasoning or whole-host totals | none | SC3 |
| T3 | Persist bounded quota eligibility and expose reprobe | Session-scoped exact-key evidence survives processes, expires and can be explicitly cleared without lost updates | none | SC4, SC5 |
| T4 | Bind quota eligibility to recoverable waves | Required slots cascade past known failures with immutable decisions and unchanged fallback/recovery guarantees | T3 | SC6, SC7 |
| T5 | Integrate metadata and final verification | Shipped files are registered, hashes are current and the complete unchanged gate passes | T1, T2, T4 | SC8 |

## Proposed Changes

### T1 — Close the preparation entry write gap

- Constraints: Harden only the documented sequence and its tests. Complete all ownership/link/selected-helper checks before the materializer creates scratch or writes; retain diagnostics on failure rather than deleting unrelated bytes.

- #### [MODIFY] skills/dispatch/references/self-build.md
  - Changes: Change materializer argv to `reference target session heading`; require canonical absolute inputs, a real target repository, an initialized manifest bound to that repository, a real `.state`, session containment under target `.scratch`, and unlinked ancestors for all writable locations. Read and compare an existing helper without following a linked helper. Preserve exact named-section/fence validation, `wx` publication, same-byte reuse and mismatch refusal. Update invocation prose and examples together.
  - Invariants: Validate the manifest in read-only form before using any initializer/reactivator that creates directories. The embedded wrapper cannot import a candidate's mutable runtime. Preserve the standalone whole-skill capture, recovery, ledger, cleanup and partial-output guards; macOS system aliases remain explicitly normalized without accepting mutable links.
  - Reuse: Searched `readManifest`, `reactivateSession`, `canonicalRepositoryRoot`, capture `unlinked`/`inside` and the reference's existing guards. Use their existing identity rules, but do not call mutating session activation during bootstrap. Keep minimal standalone validation in this existing wrapper because the selected source can differ from the candidate.

- #### [NEW] tests/e2e/self-build-preparation.test.ts
  - Purpose: `documented preparation rejects unsafe ownership and linked paths` executes the actual documented preparation block against owned disposable repositories, including valid preparation, uninitialized/outside sessions, forged manifest ownership, linked target/session/`.state`/scratch/helper paths, malformed or duplicate sections, differing existing helper bytes and same-byte reuse. Assert external sentinel bytes and output locations, not copied source text. Test valid capture/verify and invalid capture output boundaries.
  - Reuse: Existing `tests/helpers/e2e.ts` fixture and the fixed-controller proof supply disposable Git/session setup. Extract only the executable entry itself, then run the documented helper sequence; do not substitute test-authored materialization logic. New file isolates physical subprocess claims from fast unit files.

- #### [MODIFY] tests/e2e/implement.test.ts
  - Changes: In `fixed controller completes delivery and continuation after candidate runtime changes`, obtain capture/verify helpers through the documented materializer with target argv rather than writing their bodies directly. Preserve every existing delivered-candidate, complete-inventory, continuation and exactly-once assertion.
  - Invariants: Do not rerun unrelated scenarios in the criterion's focused Verify. Do not enlarge the proof's timeout or remove its failure evidence.

- #### [NEW] docs/self-build-executable-evidence.md
  - Purpose: Maintainer evidence inventory for every executable block in `self-build.md`: owner, invocation entry, writes, guard, concrete test name or review-only disposition and reason. Cover shell driver calls, restore, ledger/dependency setup and cleanup in addition to preparation. Point to operational owners; add no standing agent policy. Add missing targeted restore/ledger/cleanup boundary scenarios to the new preparation test file, or document a precise existing test that covers each.
  - Reuse: The reference is the operational source of truth; this inventory records proof rather than duplicating its workflow. Existing delivery proof is reused for fixed-controller continuation.

### T2 — Make diagnostics describe their measurements

- #### [MODIFY] skills/dispatch/scripts/domain/diagnostics.ts
  - Changes: H6 says elapsed host-await gap and explicitly leaves internal activity unknown. Label measured usage as provider CLI measurements with launch coverage. Label native/write estimates and unavailable values separately. Label frame-byte estimates as projected frame exposure, not total orchestrator usage; state that conversation totals are unavailable. Remove unconditional independent-quota claims from H1 advice while preserving next-model advice.
  - Invariants: Numeric facts, phase attribution, cache normalization, privacy/sanitization, bounded reports and failure isolation remain unchanged. Do not add pause inference, native telemetry transport or execution policy here. Preserve component registration until T5 adds the new shipped files.

- #### [MODIFY] tests/unit/domain/diagnostics-report.test.ts
  - Changes: Add `elapsed waits and partial usage remain explicit` to exercise H6 plus rendered summary for a known long gap, partial provider usage and unavailable native values; preserve measured numbers and no reasoning double-count. Update affected existing label expectations without removing scenarios.
  - Invariants: Expectations derive from the report contract, not renderer text copied into fixtures. Existing numeric and privacy tests remain.

- #### [MODIFY] tests/unit/core/diagnostics-waits.test.ts
  - Changes: Preserve journal host/user/driver interval tests and adapt only assertions affected by truthful rendering; add no second elapsed-time algorithm.
  - Invariants: No inferred reset subtraction or changes to journal timing attribution.

- #### [MODIFY] tests/integration/diagnostics-contract.test.ts
  - Changes: Extend the existing enabled/disabled and checkpoint contract coverage to verify reporting scope and preserve disabled structural absence with an inert quota directory fixture only. T4/SC7 owns quota-enabled execution with diagnostics on/off, so T2 remains independent of T3.
  - Invariants: Diagnostics stay observational; quota execution must not require diagnostic notes or prompts.

- #### [MODIFY] skills/dispatch/references/diagnostics.md
  - Changes: Retain required RETRO fields and privacy instructions; permit only a minimal H6 clarification within the same byte budget. Current bytes are 1010 LF and exactly 1024 CRLF. REQ-3 does not require measurement explanations in this retro instruction.
  - Invariants: Keep the existing byte-budget test and 1024-byte CRLF limit; put full measurement meaning in the renderer and human troubleshooting owner.

- #### [MODIFY] skills/dispatch/references/readme/troubleshooting.md
  - Changes: Explain elapsed host-await meaning, provider measurement coverage, optional native/write estimates and frame exposure limits. Link to existing attestations and distinguish report scope from full conversation totals.
  - Invariants: Keep human recovery guidance in this existing owner; add no telemetry protocol or standing agent policy.

### T3 — Persist bounded quota eligibility and expose reprobe

- Constraints: Implement the exact-key generation/hour-bucket contract above. Use atomic replacement only for a single key's generation marker; immutable observations use exclusive publication with intentional same-bucket coalescing. Store outages revert to normal routing, not missing reviewers.

- #### [MODIFY] skills/dispatch/scripts/core/types.ts
  - Changes: Add type-only quota tuple, snapshot and observation shapes shared by policy, lib, effects and CLI, with schema version and nullable configured model. Do not add machine events or make optional diagnostics semantic.
  - Reuse: Searched `FailureClass`, `Invocation`, `HandlerContext`, `WaveInput` and `DiagnosticUsage`; none represents cross-run execution eligibility. Use existing failure classification and core type-only sharing rather than importing policy into lib.
  - Invariants: Keep the dependency matrix; `core/types.ts` imports nothing.

- #### [NEW] skills/dispatch/scripts/policy/quota.ts
  - Purpose: Pure validation/eligibility reducer over provided observations, generation and clock. Export the finite cooldown and snapshot decision function; the caller supplies time. Exact expiry is eligible; a future observation or invalid record cannot suppress. Select only matching generation/key evidence and preserve configured cascade order.
  - Reuse: Searched `failureDisposition`, `next`, roster resolution and diagnostics collectors. Reuse cascade classification; no existing module owns cross-wave quota eligibility. Do no I/O or runtime clock reads in policy.

- #### [NEW] skills/dispatch/scripts/lib/quota-store.ts
  - Purpose: Session-owned `.state/quota/<tuple-hash>/` persistence. Validate manifest/root and linked writable ancestors; atomically publish complete generation markers and exclusive immutable failure files. Expose bounded read/write/reset operations using existing filesystem primitives, without importing policy or machines. Include tuple and generation in each record and verify identity; retain unsupported records for diagnosis but never suppress from them. Failed record writes do not change the completed provider result.
  - Reuse: Reuse `readManifest`, `canonicalRepositoryRoot`, `nodeLinkFs`, `publishExclusive` and atomic file operations. No existing execution store has this per-key generation/hour-bucket contract. Read only the two candidate buckets and validate each against the supplied clock; retain old buckets without scanning or pruning them. Invalid candidate state fails open to normal routing.

- #### [MODIFY] skills/dispatch/scripts/lib/cli.ts
  - Changes: Parse the exact `session quota-reprobe` interface above; restrict provider/model/mode flags to that action and require nonempty provider/mode. Reject unrelated flags and positionals. Preserve existing actions and refresh-config exclusion rules.
  - Invariants: Omitted model remains null; literal model aliases are not normalized into another alias. The parser owns argv shape and action-only flags. Existing injected provider syntax checks may remain; import no provider specifications into lib.

- #### [MODIFY] skills/dispatch/scripts/dispatch.ts
  - Changes: Validate provider and mode membership against the selected controller's `SPECS` before any write, then dispatch the maintenance command using repository/session identity and quota store. Reprobe one key and emit a compact result with future-wave semantics; do not load/modify a live worker, its input or configuration.
  - Invariants: Validate before writing; return exit 1 for bad arguments or unowned session. Keep credentials, local config and raw provider output out of records/results.

- #### [NEW] tests/unit/policy/quota.test.ts
  - Purpose: `quota eligibility preserves exact keys and bounded expiry` exercises public decisions for same/different model/mode/provider, null/default versus literal aliases, changed generations, exact expiry, backwards clock, invalid/oversized data and configured-order retention. In-memory only.
  - Reuse: Existing cascade tests remain the owner of generic cascade ordering; these tests own only cooldown eligibility.

- #### [MODIFY] tests/unit/lib/cli.test.ts
  - Changes: Add `quota reprobe validates its exact session action` for the public argv interface and misuse of action-only flags. Retain all existing command cases.

- #### [NEW] tests/e2e/quota-state.test.ts
  - Purpose: `quota state survives sessions and reprobe races` uses real files/processes to show retention across processes/runs, session isolation, same-bucket coalescing without cooldown extension, distinct-key/bucket preservation, concurrent generation replacement, late old-generation failure, corrupt/oversized/linked state refusal and safe fallback on I/O errors. Include over 64 expired buckets plus valid current evidence and prove suppression still works. Add unknown-provider and unknown-mode CLI subprocess cases that fail before writes. Assert no writes outside owned state. Avoid live providers and wall-clock sleeps.
  - Reuse: Existing E2E session fixtures and subprocess helpers provide real storage; pure expiry stays in unit tests. Preserve quota evidence when a run's worker files are cleaned at done and when the session is reactivated.

### T4 — Bind quota eligibility to recoverable waves

- Constraints: Depends on T3 for schema, store and CLI generation semantics. After creating immutable input, never refresh its decisions during recovery, worker retry, expiry or reprobe. Already-issued concurrent waves are permitted to share their earlier eligible decision.

- #### [MODIFY] skills/dispatch/scripts/effects/wave.ts
  - Changes: Extend `WaveInput`, `WaveDeps` and `WorkerDeps` with narrowly scoped quota snapshot/publication ports. At first input publication, enumerate roster and reserve keys for available modes and store the policy snapshot. `runVoice` bypasses suppressed combinations using existing cascade transitions and records a skipped-quota reason with no invocation. On real quota failure publish an observation stamped with the input generation before the worker completes its slot. Only the frozen `WaveInput` snapshot governs launch eligibility for the entire wave, including not-yet-started slots and combinations. Observations affect only future unpublished inputs; already-published concurrent waves keep their decisions.
  - Invariants: All-suppressed voices still reach reserves/native fallback or named failure; no empty success and no reduced coverage. Keep per-slot/reserve/wave ceilings, claims, launch fences, attestation, reports and one terminal result unchanged. A missing snapshot in a retained old input means the old normal cascade. Store errors cannot erase accepted results. Recovery consumes retained outcomes and frozen input rather than replaying known completed launches.
  - Reuse: Use `next`, `modelsOf`, `runVoice`, `runSlot`, `prepareWorker`, `runWaveWorker`, `waveRecovery` and existing claim/publication primitives. Do not add another scheduler or provider classification layer.

- #### [MODIFY] skills/dispatch/scripts/dispatch.ts
  - Changes: Wire quota snapshot ports in `waveRuntime` and failure publication in `workerDeps`, deriving the session from the current run via `sessionDirOf` imported from `scripts/effects/handoff.ts` and checking its identity. Enumerate only the provider modes already supported by runtime discovery. Pass the policy clock explicitly; keep policy execution outside diagnostics.
  - Invariants: T3 orders this shared file. Snapshot content is portable/self-contained; do not embed new absolute sidecar references requiring checkpoint path rebinding.

- #### [MODIFY] tests/unit/providers/wave.test.ts
  - Changes: Add `quota snapshots preserve cascade coverage across waves` through exported wave handlers: first quota observation, later-wave bypass, other models/modes, reserves, all-suppressed/native fallback, distinct slots and no synthetic invocation counts. Cover legacy one-wave and two-wave native-host paths, with ask and all review kinds via their existing public effect interface.
  - Invariants: Use fake clock and in-memory filesystem/ports. Preserve all existing scenarios and deadlines; no unit subprocesses.

- #### [MODIFY] tests/unit/providers/wave-claim.test.ts
  - Changes: Add `quota decisions survive worker recovery boundaries` covering crash after input, claim, quota observation, slot outcome and completion publication; quota observation/reprobe/expiry after input without changing that wave's not-yet-started slots or combinations; already-published concurrent waves; late result after generation reset; live reattach and dead replacement. Verify exactly-once completed slot consumption and unchanged launch fencing.
  - Invariants: Expected launch counts follow consumer effects, not internal helper calls. Preserve existing claim/heartbeat coverage.

- #### [NEW] tests/e2e/quota-routing.test.ts
  - Purpose: `quota routing survives cross-run continuation` drives separate driver/worker processes with scripted provider executables: same-session successive waves/runs, diagnostics on/off, explicit reprobe and retained input after interruption. Exercise ask, standalone review, plan/design review and implementation's embedded review through existing fixture flows; assert required slots and one terminal completion. Check session move/reactivation and retained inputs without access to mutable quota sidecars.
  - Reuse: Existing E2E scripted CLI fixture, parent flow fixtures and wave recovery protocols are the test seam; no live-provider dependency. Use a compact family table only for distinct parent adapter paths; do not duplicate the entire suite or weaken budgets.

- #### [MODIFY] skills/dispatch/references/providers.md
  - Changes: Document exact-key session cooldown, one-hour expiry, actual mode separation, skipped-launch reasons, explicit reprobe syntax, in-flight snapshot semantics and fallback coverage. Replace unconditional per-model quota assertions with the rule that failure of one combination does not prove others exhausted.
  - Invariants: Existing sandbox, permission, model attestation, credential and native capture rules remain intact; no changes to always-loaded SKILL.md.

### T5 — Integrate metadata and final verification

- Constraints: Own all generator writes after upstream changes settle; run affected cheap integration checks before aggregate verification. If an upstream task changes bytes after this task, regenerate and repeat the required final gate.

- #### [MODIFY] skills/dispatch/scripts/domain/diagnostics.ts
  - Changes: Register new `scripts/policy/quota.ts` and `scripts/lib/quota-store.ts` in COMPONENTS, using the existing canonical allowlist mechanism. Preserve T2's report semantics.
  - Invariants: T2 orders this shared file. The existing shipped-file parity test must pass before the costly aggregate.

- #### [GENERATED] skills/dispatch/skill-hashes.json
  - Command: `npm run hashes`
  - Inputs: skills/dispatch/references/self-build.md, skills/dispatch/references/diagnostics.md, skills/dispatch/references/readme/troubleshooting.md, skills/dispatch/references/providers.md, skills/dispatch/scripts/core/types.ts, skills/dispatch/scripts/domain/diagnostics.ts, skills/dispatch/scripts/policy/quota.ts, skills/dispatch/scripts/lib/quota-store.ts, skills/dispatch/scripts/lib/cli.ts, skills/dispatch/scripts/dispatch.ts, skills/dispatch/scripts/effects/wave.ts

## Success Criteria

- [SC1] The documented preparation entry rejects unsafe ownership and linked paths before any helper write.
  - Satisfies: REQ-1, REQ-2
  - Changes: skills/dispatch/references/self-build.md, tests/e2e/self-build-preparation.test.ts, docs/self-build-executable-evidence.md
  - Tests: tests/e2e/self-build-preparation.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^documented preparation rejects unsafe ownership and linked paths$" tests/e2e/self-build-preparation.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^documented preparation rejects unsafe ownership and linked paths$" tests/e2e/self-build-preparation.test.ts`
  - Evidence: red
  - Retain: durable
  - Test rationale: Lasting write-boundary contract. Tests observe forbidden writes/sentinel mutation through the documented entry and valid complete preparation; helper refactoring can preserve the behavior. Restore/ledger/cleanup cases each name a distinct write boundary in the evidence inventory.

- [SC2] Fixed-controller delivery still verifies the complete selected source and resumes exactly once after candidate changes.
  - Satisfies: REQ-2
  - Changes: tests/e2e/implement.test.ts
  - Tests: tests/e2e/implement.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^fixed controller completes delivery and continuation after candidate runtime changes$" tests/e2e/implement.test.ts`
  - Evidence: verify
  - Retain: durable
  - Test rationale: Reuse the existing controller/candidate integration proof and replace its bypassed entry; do not add another full delivery test. It detects mutable-controller use or duplicate delivery while allowing internal helper changes.

- [SC3] Diagnostic output distinguishes elapsed wait, provider measurements and incomplete host estimates without changing facts or disabled behavior.
  - Satisfies: REQ-3
  - Changes: skills/dispatch/scripts/domain/diagnostics.ts, skills/dispatch/references/diagnostics.md, skills/dispatch/references/readme/troubleshooting.md, tests/unit/domain/diagnostics-report.test.ts, tests/unit/core/diagnostics-waits.test.ts, tests/integration/diagnostics-contract.test.ts
  - Tests: tests/unit/domain/diagnostics-report.test.ts, tests/unit/core/diagnostics-waits.test.ts, tests/integration/diagnostics-contract.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/unit/domain/diagnostics-report.test.ts tests/unit/core/diagnostics-waits.test.ts tests/integration/diagnostics-contract.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^elapsed waits and partial usage remain explicit$" tests/unit/domain/diagnostics-report.test.ts`
  - Evidence: red
  - Retain: durable
  - Test rationale: Renderer test owns public meaning and numeric preservation; existing journal tests own interval attribution; integration owns disabled instructions/fields and checkpoint scope. These are distinct consumer contracts, not repeated source wording checks.

- [SC4] Pure quota eligibility and reprobe parsing preserve exact keys, finite expiry and command ownership.
  - Satisfies: REQ-4, REQ-5
  - Changes: skills/dispatch/scripts/core/types.ts, skills/dispatch/scripts/policy/quota.ts, skills/dispatch/scripts/lib/cli.ts, tests/unit/policy/quota.test.ts, tests/unit/lib/cli.test.ts
  - Tests: tests/unit/policy/quota.test.ts, tests/unit/lib/cli.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(quota eligibility preserves exact keys and bounded expiry|quota reprobe validates its exact session action)$" tests/unit/policy/quota.test.ts tests/unit/lib/cli.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(quota eligibility preserves exact keys and bounded expiry|quota reprobe validates its exact session action)$" tests/unit/policy/quota.test.ts tests/unit/lib/cli.test.ts`
  - Evidence: red
  - Retain: durable
  - Test rationale: Eligibility tests detect over-broad suppression and expiry errors from public decisions; argv tests detect an unusable or unsafe operator action. No I/O in pure tests and no second generic cascade suite.

- [SC5] Quota state survives processes and concurrent updates, while reprobe invalidates late prior-generation observations.
  - Satisfies: REQ-4, REQ-5
  - Changes: skills/dispatch/scripts/lib/quota-store.ts, skills/dispatch/scripts/dispatch.ts, tests/e2e/quota-state.test.ts
  - Tests: tests/e2e/quota-state.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^quota state survives sessions and reprobe races$" tests/e2e/quota-state.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^quota state survives sessions and reprobe races$" tests/e2e/quota-state.test.ts`
  - Evidence: red
  - Retain: durable
  - Test rationale: Filesystem/process boundary proves durable generation replacement and independent observations; in-memory eligibility cannot prove atomic publication, cross-session ownership or linked-path refusal.

- [SC6] Frozen quota decisions skip redundant launches while retaining every required slot and existing cascade path.
  - Satisfies: REQ-4, REQ-5
  - Changes: skills/dispatch/scripts/effects/wave.ts, skills/dispatch/scripts/dispatch.ts, skills/dispatch/references/providers.md, tests/unit/providers/wave.test.ts, tests/unit/providers/wave-claim.test.ts
  - Tests: tests/unit/providers/wave.test.ts, tests/unit/providers/wave-claim.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(quota snapshots preserve cascade coverage across waves|quota decisions survive worker recovery boundaries)$" tests/unit/providers/wave.test.ts tests/unit/providers/wave-claim.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(quota snapshots preserve cascade coverage across waves|quota decisions survive worker recovery boundaries)$" tests/unit/providers/wave.test.ts tests/unit/providers/wave-claim.test.ts`
  - Evidence: red
  - Retain: durable
  - Test rationale: Wave consumer tests assert selected external launches, independent slot coverage and fallback; claim tests detect duplicate effects and changed decisions across durable boundaries. They preserve behavior through internal refactors and have distinct failure claims.

- [SC7] Separate processes and every parent flow retain quota state, portable recovery and diagnostic independence.
  - Satisfies: REQ-4, REQ-5
  - Changes: tests/e2e/quota-routing.test.ts
  - Tests: tests/e2e/quota-routing.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^quota routing survives cross-run continuation$" tests/e2e/quota-routing.test.ts`
  - RED: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^quota routing survives cross-run continuation$" tests/e2e/quota-routing.test.ts`
  - Evidence: red
  - Retain: durable
  - Test rationale: Scripted executables prove actual CLI wiring, cross-run scope and retained input in separate processes, which fake handler ports cannot. Parent families cover distinct adapter paths only; no live-provider or performance assertions.

- [SC8] Shipped-file parity, integrity metadata and the unchanged complete repository gate pass after final bytes.
  - Satisfies: REQ-2, REQ-3, REQ-4, REQ-5
  - Changes: skills/dispatch/scripts/domain/diagnostics.ts, skills/dispatch/skill-hashes.json
  - Verify: `npm test` [FINAL]
  - Evidence: verify
  - Test rationale: Reuse the existing whole-suite contract and shipped-file parity checks. A new test that merely mirrors the generated hash list would add no independent behavioral signal.

## Verification Plan
- Seams: documented `self-build.md` preparation/materializer CLI and existing fixed-controller E2E fixture; `heuristics`, `renderDiagnostics` and diagnostic journal/frame collection; `parseCommand` and session CLI subprocess entry; exported wave handlers/worker recovery using existing in-memory ports; scripted-provider E2E parent flows.

### Automated Tests
- `git diff --check`
- Run each criterion's literal Verify and RED commands. New tests use the specified behavior names; every filtered file must select at least one test. Reject zero-selection output. Capture the original behavioral failure, not merely an absent import, missing command or changed argv signature; establish the new interface with a no-op implementation first where needed, then prove the behavioral RED.
- Before the aggregate, run `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts tests/unit/domain/diagnostics-report.test.ts tests/integration/dependency-direction.test.ts tests/integration/diagnostics-dependencies.test.ts tests/integration/diagnostics-contract.test.ts tests/unit/policy/cascade.test.ts` to catch allowlist, dependency and existing-cascade regressions cheaply.
- Run `npm run hashes`, then `npm test` and `git diff --check` after final bytes. No transition topology changes are planned; if a required repair changes a machine transition within approved scope, run `npm run diagrams` before the final aggregate and declare the generated file scope before writing it.

### Manual Verification
- Record durations for new E2E files `self-build-preparation.test.ts`, `quota-state.test.ts` and `quota-routing.test.ts`. Preserve existing subprocess deadlines. `scripts/test-reporter.ts` exempts `tests/e2e` from its per-file 1000 ms gate; keep that gate for non-E2E files and do not add an E2E one-second budget or relax existing limits.
- Check the executable evidence inventory against every current reference fence, including shell variants. An inspection disposition must identify its safety claim, evidence and unexecuted platform limits; it cannot stand in for a reproducible write-boundary test.
- Inspect one enabled report and one disabled run: no invented active-work duration, complete-cost claim, synthetic invocation or diagnostic dependency in routing.
- Review CodeGraph caller evidence for shared wave/types interfaces across ask, plan, design, standalone review and implementation review. Preserve failure evidence after each durable boundary; do not relaunch live handles.
- Preserve failed logs, replay an exact failed scenario when needed, then rerun the unchanged final aggregate. Do not change timeout, concurrency or coverage limits to pass. Record final criterion evidence and the selected controller identity in the walkthrough, then clean every owned worktree and verify `git worktree list --porcelain`.

## Rollback & Blast Radius

T1 changes a documented helper's positional interface; update all known examples and the delivery proof together. No legacy wrapper support is required. T2 changes human report labels only; preserve facts and journal shape. T3/T4 add session-local execution state and optional worker input fields; old inputs retain normal routing, new inputs carry self-contained decisions, and controllers that ignore additive quota optimization still require the existing checkpoint/rebind approval and recovery process before a controller switch. Ignored optimization does not permit live runtime substitution or bypass runtime identity guards. Reverting product files must not delete retained session state or reset a candidate checkout. Preserve the blocked run on any demonstrated recovery-contract failure and resolve through the existing fixed-controller procedure.

## Review Findings & Resolutions

Reviews: 1 · Rounds: 2 · Findings: 9 (Fixed 7, Rejected — Closed by Reviewer 2) · Full log: [investigate-verify-explain-and-propose-f.review-log.md](investigate-verify-explain-and-propose-f.review-log.md)

| Review | ID | Round | Severity | Status | Ruling |
| --- | --- | --- | --- | --- | --- |
| 1 | R1-F001 | 1 | SHOULD | Fixed | REQ-5 requires stable issued decisions. Remove mid-wave suppression; only the i… |
| 1 | R1-F002 | 1 | SHOULD | Fixed | The volume cap can discard useful valid evidence. Replace the growing scan with… |
| 1 | R1-F003 | 1 | SHOULD | Fixed | Clarify ownership: parseCommand owns argv shape/action scope; dispatch owns pro… |
| 1 | R1-F004 | 1 | CONSIDER | Fixed | Use the existing effects/handoff.ts import explicitly; no new root-machine depe… |
| 1 | R1-F005 | 1 | CONSIDER | Fixed | Record durations and preserve existing limits. scripts/test-reporter.ts explici… |
| 1 | R1-F006 | 1 | SHOULD | Fixed | Verified current diagnostics.md is 1010 bytes with LF and exactly 1024 with CRL… |
| 1 | R1-F007 | 1 | SHOULD | Rejected — Closed by Reviewer | Both cited NEW entries already have explicit Reuse lines in the reviewed revisi… |
| 1 | R1-F008 | 1 | SHOULD | Fixed | Name and anchor the full preparation behavior title and retain explicit rejecti… |
| 1 | R1-F009 | 1 | SHOULD | Rejected — Closed by Reviewer | The reviewed plan already requires the repository dependency matrix under T3 co… |
