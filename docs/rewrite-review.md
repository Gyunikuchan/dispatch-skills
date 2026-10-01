# v0.7.0 rewrite review against v0.6.1

Completed 2026-10-01. Stable tag: `v0.6.1` (`0efe940cdb0df2b0a18417fccf13d6c364f418a1`). Rewrite: HEAD `443439aac99fbd755a22dc9d87c716301ed0e388`. The checkout remains labeled 0.6.1; v0.7.0 is the intended release.

## Synthesis

Retain the rewrite architecture. Native TypeScript, pure machines, durable journal authority, generic runners, eight host awaits, strict sandbox failure and fewer recovery branches improve correctness and token efficiency. The main repair need is composition: retained helpers, policies and templates sometimes do not reach the real workflow. Green helper tests and a preserved-behavior inventory do not establish delivered parity.

The most serious verified defect is false dispute settlement: a failed reviewer can be recorded as confirming an orchestrator rejection of a MUST. Review scope and governing context are also lost at prompt construction; native work no longer overlaps CLI work; OpenCode local safeguards exist but are not wired. Human migration prose needs targeted restoration, not a return to the old procedural contract.

16 retained findings: 1 MUST, 14 SHOULD, 1 CONSIDER. Severity is the synthesized repair priority, not delegate agreement. Five substantive reports plus one partial response informed the review; two slots failed. Several plausible delegate claims were rejected after checking production composition.

## Prioritized findings

Paths below are relative to `skills/dispatch/scripts/` unless stated otherwise. Detailed triggers, stable-side evidence, bounded repairs and validation are in the evidence trail below.

| Priority | ID | Finding | Evidence owner |
|---|---|---|---|
| MUST | R06 | Timed-out affinity reviewer falsely closes rejected MUST by omission | machines/review.ts:203-218; protocol reproduction |
| SHOULD | R01 | First code prompt can omit explicit Git range when task context exists | effects/prepare-review.ts:54-66; scope reproduction |
| SHOULD | R02 | Delta/disputes-only scopes reuse full original changed paths | machines/review.ts:167-169,333-362; effects/prepare-review.ts:86-111 |
| SHOULD | R07 | Implementation review has neither governing plan nor walkthrough | machines/implement.ts:456-460; effects/prepare-review.ts:60-66 |
| SHOULD | R03 | Native-only and early fallback work waits for entire CLI wave | effects/index.ts:52-56; effects/wave.ts:350-373 |
| SHOULD | R04 | OpenCode local preflight, GPU lock and WAN trap never wired | dispatch.ts:54-63; providers/runner.ts:287; effects/wave.ts:196-200 |
| SHOULD | R05 | OpenCode production request supplies no explicit read-only agent | providers/opencode.ts:75-79; effects/wave.ts:196-200 |
| SHOULD | R08 | Parser success hides runner timeout/truncation flags; output cap does not stop child | providers/runner.ts:308-316; providers/node-process.ts:40-47 |
| SHOULD | R09 | Antigravity modes lose separate profile selection | providers/agy.ts:39-46 |
| SHOULD | R10 | OpenCode native configuration path selectors stripped | providers/runner.ts:22-42 |
| SHOULD | R13 | Windows Claude discovery omits evidenced .cmd shim layout | providers/claude.ts:49; providers/discovery.ts:43-46 |
| SHOULD | R11 | Host event shape and fix metadata insufficiently disclosed | core/frame.ts:5-15; machines/types.ts:58-72; SKILL.md |
| SHOULD | R14 | Development audit scripts cannot import removed runner modules | .agents/skills/audit-dispatch-skills/scripts/{baseline,probe-dispatch,finalize}.mjs; smoke failures |
| SHOULD | R15 | Root README promises removed branch fallback and phase syntax; design flow unclear | README.md:143,152,155 |
| SHOULD | R16 | Safety assurance exceeds actual credential/file boundary | README.md:67; providers/runner.ts:72-84,116-137 |
| CONSIDER | R12 | Plan template references removed Resolution log section | references/templates/plan.md:84 |

## Proposed repair sequence

1. **Settlement and outcome truth.** R06 first; define successful/waived criterion outcomes (O02) before claiming autonomous criterion completion. Validate failed affinity/source/substitute, all-failed review, successful CLEAN, and fail/blocked evidence.
2. **Review context and bounded scope.** R01/R02/R07 together through one prepared-scope owner. Validate generated first-round range, governing artifacts, prior-round deltas and disputes-only material. Keep unchanged prompt/rubric requirements aligned with data actually supplied.
3. **Provider production composition.** R03/R04/R05/R08/R09/R10/R13. Test interpreter→worker→runner observable launches and limits. Wire intended early-native and local preparation paths, then remove superseded helper APIs. Preserve explicit sandbox opt-outs and evidence-proven discovery layouts.
4. **Executable host contract.** R11 and O05. Generate minimal await-specific reply envelopes from the owning validator/types; check examples. Forward alias --fix explicitly. Keep session and write rules single-sourced.
5. **Human documentation and maintainer tooling.** R12/R14/R15/R16, O01/O06/O07. Port or retire stale consumers; restore usage/migration details in human docs. No bulk prose rollback.

This is a recommendation, not authorization to implement changes. No production fixes or commit were performed.

## North-star improvements and removals

- **Highest value:** composition tests (O04), checked criterion outcomes (O02), and concise source/coverage summaries with full raw captures referenced by path (O11).
- **Streamline:** high-value typed payloads (O03), duplicate session-root derivation (O09), unconsumed report schemas after caller inventory (O08), stale increment-era comments/diagnostics (O10).
- **Restore only useful disclosure:** human configuration/migration examples (O01/O06), compact alias/clarification rules (O05), release labeling at release time (O07).
- **Keep removed:** voting-style consensus option, separate rebuttal protocols, parse-back markers, phase jumping, cross-run verification caches and silent sandbox downgrade. Do not reintroduce legacy support without an explicit requirement.

## Verification and limits

- `npm test`: typecheck/hash/term/config gates completed; 525 assertions passed across 90 files. Exit 1: effects-restore exceeded the aggregate 1.00 s per-file budget. Isolated rerun passed 19/19, file 309 ms. Full aggregate gate is not reported clean.
- Scratch reproductions: missing range, unchanged full paths under narrow scope labels, failed-source false settlement, and timedOut/truncated output accepted as success.
- Audit import smoke: baseline, probe-dispatch and finalize all failed ERR_MODULE_NOT_FOUND.
- Delegate coverage: Antigravity, Codex, OpenCode[0,1,2] substantive; OpenCode[3] progress-only; Claude cli-outdated; OpenCode[4] timeout. Ineligible native-only Copilot targets excluded by configured host policy.
- Source review and these checks do not certify all platform installations, live sandbox behavior or every workflow transition. Compatibility-layout and RED-manual-completion questions remain explicitly uncertain.
- All raw claims, per-slot outcomes/logs and journal are preserved in `.state/runs/001-ask` in this authoritative temp session. Existing dirty scratch artifacts remain preserved.

## Evidence and evolving review trail

The updates below show how findings were added and adjudicated as delegates returned. Early pending statements are historical; the synthesis and final coverage above govern.

Status: complete; source-verified synthesis. Historical updates below preserve the review trail; the synthesis and final coverage statement are authoritative.

## Scope and baseline

- Stable: git tag `v0.6.1`.
- Rewrite: HEAD `443439a` (`refactor(dispatch): promote the state-machine driver`). Package metadata still declares 0.6.1; v0.7.0 is the intended release label.
- Compare shipped contracts, operational references, provider behavior, workflow guarantees, configuration, documentation and observable tests. Distinguish regressions from deliberate simplification; stable behavior is evidence, not a blanket requirement.
- Existing dirty scratch artifacts preserved. Report-only work; no production fixes or commits authorized.
- North stars: correctness, token efficiency, native collaboration, independently verified claims, structural least privilege, context hygiene, autonomous convergence and host neutrality.

## Verification and delegate coverage

`npm test` started on current checkout. All configured dispatch targets requested with `(all)` at classified high effort. Raw captures and source identities reside in `.state/runs/001-ask`; synthesis is maintained separately here because driver-owned reports must remain driver-owned.

## Confirmed findings

Pending verification.

## Optional improvements and removals

Pending synthesis.

## Changes worth retaining

Pending comparison.

## Rejected or uncertain claims

Pending adjudication.

## Update 1: independently reproduced scope defects

### R01 — SHOULD: first code-review prompt loses an explicit range when task context exists

Current `effects/prepare-review.ts:54-66,106-111`: round 1 returns only `Full review`; task summary uses context instead of target. Thus with target `v0.6.1..HEAD` and a separate task description, neither the range nor the resolved path list reaches the delegate. The retained code-review template explicitly obeys ranges in Scope and otherwise starts with working-tree changes. A review can inspect the wrong diff or report no source changes although preparation found changes. This is a current defect; stable-side attribution is still being checked.

Reproduction: `node scope-evidence.mjs` produced `rangePresent:false` for round 1, while preparation returned two changed source paths. Fix: always render the selected comparison/range and bounded paths independently of the task summary. Validate the actual generated first-round prompt with context distinct from the range, including a clean worktree with committed differences.

### R02 — SHOULD: delta/disputes-only labels do not bound the actual review material

`machines/review.ts:167-169,333-362` passes only scope label and carried disputes to preparation; `effects/prepare-review.ts:86-111` recomputes the original full target's paths. It has no prior-round fingerprint/diff or fixed-path input. Reproduction: both `delta` and `disputes-only` returned the same two paths and original range as the full review. This contradicts ADR 0005 D8 and ADR 0006 D31 and increases token use, unrelated findings and convergence risk. Fix: persist per-round changes and construct explicit delta/dispute scope instructions; do not label the whole original comparison as a delta. Validate generated content and reviewer membership, not just policy state tags.

## Update 1: verification and coverage

- `npm test`: strict typecheck, hash, term and config gates completed; 525/525 assertions passed across 90 files. Command exit 1: `tests/unit/core/effects-restore.test.ts` exceeded the 1.00 s per-file budget under aggregate load.
- Isolated required Node test command for that file: 19/19 passed; file 309 ms, total 503 ms. Contention is plausible; aggregate gate is still a failure, not a clean pass.
- Requested roster: Claude 1, Antigravity 1, OpenCode 5, Codex 1. Configured native-only Copilot targets are ineligible on a Codex orchestrator.
- Claude failed `cli-outdated`: installed 2.1.268, selected model requires >=2.1.280. Other captures pending. No CLI upgrade or config change performed.

## Deliberate improvements to retain

ADR 0006 establishes native TypeScript with no shipped build or runtime dependencies, pure reducers over a journal, one generic provider runner, eight host judgment awaits, and strict sandbox failure instead of automatic unsandboxed retry. ADR 0005 explicitly removes consensus config, replaces cap-extension prompts with severity thresholds and convergence escalation, and marks fixes without subsequent review. ADR 0006 D36 deliberately delivers all ready design increments in one implementation invocation. These are approved changes; do not restore old behavior merely because it differs.

## O01 — SHOULD: restore usable human configuration documentation without expanding always-loaded contracts

`references/readme/configuration.md` shrank from roughly 159 lines to two paragraphs. It no longer explains native-only provider eligibility, writer configuration, independent targets versus model cascades, phase disablement, provider filters, or the removal of `consensus`. The sample retains comments but is not a migration guide; ADRs are maintainer notes. Add compact human-facing configuration examples and a v0.6.1→v0.7.0 migration section, single-sourced under `references/readme/`. Keep the small agent contract.

### R03 — SHOULD: native work is serialized behind the complete CLI wave

`effects/index.ts:52-56` wires `createWaveHandler`; `effects/wave.ts:350-373` awaits `driveWorker` before constructing native-only/fallback descriptors. `machines/ask.ts:55-64` and the review machine then emit `await:native` only after `WAVE_DONE`. Consequently native-only voices and early same-host fallbacks cannot run alongside slow external CLI slots. This loses the stable contract's early parallel native wave and contradicts ADR 0006 D29. It directly increases latency and babysitting exposure, even though the detached CLI worker is concurrent internally.

`startWave`/`finishWave` implement a parallel two-phase API in the same file but are referenced only by tests, not production wiring. Prefer integrating one recoverable wave path, then removing the superseded helper path. Validate through the real interpreter/handler entrypoint with a blocked CLI completion: the native frame must become available before that completion; reconcile every slot once after capture. Helper-only tests currently give false confidence in delivered parallelism.

### R04 — SHOULD: OpenCode local protections exist only behind unwired injected ports

`dispatch.ts:54-63` invokes `runDelegate` without `prepare`; `effects/wave.ts:196-200` constructs requests without endpoint; `providers/runner.ts:287` calls the hook only if `ports.prepare` exists. Searches across shipped scripts found no concrete `fetchModels` or `acquireGpuLock` implementation or endpoint-resolution caller. Therefore normal dispatch never exercises `prepareOpencode` (`providers/opencode.ts:44-55`): local preflight, GPU serialization and WAN proxy trapping are all bypassed. v0.6.1 `runners/opencode.mjs` resolved config/model locality, performed the preflight, acquired/released the cross-process lock and derived proxy traps. Local model review can now pile concurrent launches onto one GPU, hang on offline backends and lose its intended local network confinement.

Fix: supply real bounded preparation ports and resolve the effective endpoint after model selection, keeping remote endpoints free of local-only traps. Validate via production worker wiring with a local-config fixture, offline endpoint, two concurrent local slots and a remote endpoint. Existing `tests/unit/providers/opencode.test.ts` supplies endpoint and prepare ports manually, so its pass does not verify production behavior.

### R05 — SHOULD: OpenCode no longer supplies a read-only agent selection

`providers/opencode.ts:75-79` emits `--agent` only when request.agent exists; the production worker request never sets agent. The old runner called `resolveDefaultAgent` and always passed the resulting choice. With `sandbox:false` (the explicit setting on this Windows review), current invocation is `run --auto` with a prose guardrail and the provider's default agent, rather than an explicitly selected plan agent. This weakens the native tool boundary. The stable resolver could also pick custom agents, so it was not perfect; improve to an explicit verified read-only agent rather than blindly restoring its heuristic. Validate actual worker argv and unavailable-plan-agent failure handling. Classify as a boundary regression, not a claim that this review mutated files.

## Update 2: Codex and two OpenCode captures incorporated

Codex returned a substantial independent analysis; OpenCode[0] returned mainly architecture/preservation claims and opportunities; OpenCode[3] returned a progress narrative, not a completed review. Treat the last as partial coverage despite transport success. Every claim below was independently checked.

### R06 — MUST: failed affinity reviewer falsely settles a rejected MUST by omission

`machines/review.ts:203-218` records failed rows, then closes every carried finding omitted from fresh drafts without checking that its assigned source (or substitute) successfully answered. Reproduction `node protocol-evidence.mjs`: round 1 MUST rejected; assigned reviewer times out in round 2; result is `tag:settled`, finding `closed-by-reviewer`, with zero successful reviewers in round 2. This violates the north star that claims are verified, and turns absence of evidence into reviewer agreement. Stable `driver/review-phase.mjs:1291-1304` left unusable rebuttals live and required reachable confirmation. Fix omission settlement only for a usable response from the affinity reviewer/substitute. Name an unresolved coverage failure when transport fails; do not manufacture confirmation or silently loop forever. Validate failed source, failed substitute, all-failed wave and actual CLEAN controls.

### R07 — SHOULD: implementation review receives neither plan nor walkthrough

`machines/implement.ts:456-460` starts code review with empty target and context containing only final-focus paths; `effects/prepare-review.ts:60-66` hardcodes both artifact paths to `None`. The retained code template requires criterion and verification-table review and approved design context. Stable `review/prepare-code.mjs:654` supplies these paths. Reviewers can check local code but cannot reliably validate the approved outcome. Fix explicit plan/walkthrough/design bindings and bounded criterion evidence in the review spec/prepared prompt. Validate the generated implementation-review prompt, including an increment governed by a technical design.

### R08 — SHOULD: useful output bypasses runner timeout and cap failures

`providers/runner.ts:308-316` accepts a successful parse before checking runner-owned timedOut/truncated flags. `providers/node-process.ts:40-47` clips excess stdout but does not terminate the process. `node protocol-evidence.mjs` independently demonstrated `status:ok` for both a truncated and timed-out exit-zero result. Stable `runners/shared.mjs:1386` gives runner limit failures precedence. At minimum preserve explicit limit/truncation provenance so the workflow can decide whether bounded partial evidence is usable; do not count it as an ordinary full response. Terminate runaway output and preserve partial logs. Validate parser-success plus each flag and actual process-tree cancellation.

### R09 — SHOULD: Antigravity mode cascade loses profile selection

`providers/agy.ts:39-46` ignores mode and returns empty env; shared whitelist omits `JETSKI_APP_DATA_DIR`. Stable `runners/agy.mjs:125,441` selects separate mode profiles. Binary fallback can therefore repeat one default profile instead of reaching independently authenticated native state. Restore declarative per-mode profile selection and verify launch env for each mode; preserve credential stripping.

### R10 — SHOULD: OpenCode configuration-path overrides are stripped

Current shared whitelist omits `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` (`providers/runner.ts:22-42`); provider argv supplies no replacement. Stable `runners/opencode.mjs:227` explicitly preserves these non-secret native config selectors. Custom configuration can silently fall back to a different backend/settings. Preserve vetted provider-specific path selectors; decide inline configuration separately. Validate observable child env, credential removal, and native config precedence.

### R11 — SHOULD: host reply protocol lacks the event shape needed to execute it

`SKILL.md` names awaits and fields, but `core/frame.ts:5-15` gives only a shell command with an event-file placeholder. `machines/types.ts:58-72` expects object-valued rulings and fix metadata `affectedPaths`, `dependsOn`, `verification`; frames/prose do not provide a concrete event envelope or these required names for fix metadata. Native actual-model metadata is likewise disclosed incompletely. Stable review-phase emitted a schema and reply guidance. Keep eight awaits, but generate a compact event template for the current await, or disclose it once in an await-specific reference. Validate templates against the real validator. Do not reintroduce duplicate schema/type definitions.

### R12 — CONSIDER: retained plan template points at a removed operational section

`references/templates/plan.md:84` refers to `review.md` “§ Resolution log”; the current nine-line review reference contains no such section. Remove the stale authoring instruction where the driver now owns rendering, or link its actual owner. Add section-reference checks for non-link prose references.

### Rejected claim: untouched caller dirt is always attributed to writers

Codex traced `git.changedSince` and raw `createSnapshot`, but omitted production `effects/index.ts:75-83`, which replaces diff paths with snapshot-relative `changedPaths` plus recovery entry deltas. Do not accept this as a shipped regression on the cited evidence. The low-level helper remains misleading and could be streamlined, but normal handler composition compensates. This illustrates why production-path verification is necessary even for plausible, precisely cited claims.

### Uncertain: Codex installation-layout loss

Codex reports omitted desktop/editor layouts compared with old `runners/codex.mjs:224,261`; current `providers/codex.ts:36-39` is narrower. Source difference confirmed. Actual current installer layouts and affected installations were not verified, so treat as a compatibility coverage candidate. Restore only evidenced supported layouts declaratively, with filesystem fixtures.

### Uncertain: manual completion RED observation

The old failure path demanded separate redEvidence; current manual completion takes user-attributed criterion evidence. ADR 0006 deliberately narrows recovery and authorizes a user stop ruling, but does not clearly distinguish observed RED from an explicit waiver. Record this as a traceability question, not an automatic demand to restore the old recovery matrix. Prefer an explicit observed/waived distinction tied to the current plan.

### O02 — SHOULD: criterion outcomes should be checkable

`machines/implement.ts:499-518` accepts any nonblank outcome and checks only freshness before completion. An outcome such as `failed` with explanatory evidence can satisfy the current structural gate. The host contract requires every criterion, so this is a reliability weakness; stable-side evidence has not established a regression. Define pass versus explicit user waiver semantics and prevent fail/blocked evidence from completing a run. Test observable completion behavior.

### O03 — CONSIDER: finish the high-value typed payload boundaries

`core/types.ts` retains generic Payload aliases and increment placeholder comments for rulings, criterion evidence, plans, fingerprints and effects. Replace the highest-risk host/effect payloads with existing domain shapes, keeping dependency direction intact. This makes the compiler help enforce intended contracts instead of relying on casts and repeated runtime parsing.

### O04 — SHOULD: test composition, not merely preserved-behavior labels

`tests/integration/preserved-behaviour.test.ts:39` checks behavior keys appear in listed files. This is a useful index, not evidence of behavioral equivalence. R03/R04/R07 demonstrate helpers or templates survive while production wiring drops behavior. Add a small number of worker/interpreter/generated-prompt seam checks; prioritize false settlement, missing context, native overlap and local preparation. Keep the faster pure tests and the matrix as traceability.

## Update 3: remaining completed delegates adjudicated

### R13 — SHOULD: Windows Claude `.cmd` installation no longer discovered

`providers/claude.ts:49` names only claude.exe and executable paths for the CLI mode; `providers/discovery.ts:43-46` expands PATHEXT only for extensionless names. Stable `runners/claude.mjs:1128` tried both claude.cmd and claude.exe. Windows PATH installations containing only the npm shim are missed. Add the evidenced candidate and validate a filesystem fixture containing only the shim. No CLI upgrade performed.

### R14 — SHOULD: repository audit tooling imports deleted modules

`.agents/skills/audit-dispatch-skills/scripts/baseline.mjs:20-21`, `probe-dispatch.mjs:31-32`, and `finalize.mjs:19` import removed platform/config/runner modules. Read-only dynamic-import smoke checks for all three returned ERR_MODULE_NOT_FOUND for lib/platform.mjs. This concretely breaks development baseline/probe/finalization; these consumers are outside the shipped package and new integration scan. Port to current APIs or explicitly retire stale tooling after preserving artifacts. Do not blindly replace extensions because exported APIs changed too. Validate development-skill imports alongside shipped boundaries.

### R15 — SHOULD: root usage documentation contradicts delivered workflows

README.md:143 promises clean-tree branch fallback; git.ts:78-85 and prepare-review.ts:99-100 return empty/no prompts for an empty working tree. README.md:152 recommends removed --phases from:code-review; ADR 0006 D37 intentionally removed it. README.md:155 implies design itself implements increments, but design stops at approval and a later implement invocation delivers them. Rewrite examples to explicit supported comparison and journal recovery. If clean-tree fallback remains desirable, decide that separately rather than restoring old heuristics by default. Validate human examples and clean-tree behavior.

### R16 — SHOULD: safety prose overstates sensitive-file isolation

README.md:67 promises delegates run without credentials or access to sensitive files. The runner strips selected ambient env and rejects sensitive attachments; workspace denial is prompt text (runner.ts:72-84,116-137), authentication remains available, and explicit sandbox opt-out leaves broad filesystem access. Stable human configuration prose accurately stated defense in depth was not a complete secret boundary. Restore precise wording and scope caveat while retaining strict sandbox behavior. No claim that secrets were accessed during this review.

### Additional bounded opportunities

- **O05: alias/clarification disclosure.** Alias forwarding lists omit --fix; add it explicitly. They already inherit dispatch's run loop, so missing repeated session-init instructions are not a defect. For ambiguous new design/plan work, restore concise conditional clarification guidance without making shipped dispatch depend on an unshipped skill.
- **O06: migration guide.** Document removed consensus config, strict sandbox failure, Node requirement, removed phase/direct-runner controls, journal/evidence locations, and missing-phase-policy internal review defaults. Current sample alone is insufficient upgrade guidance.
- **O07: release labeling.** Version/badge still 0.6.1 and CHANGELOG Unreleased empty; update during the intended v0.7.0 release.
- **O08: orphan report schemas.** Inventory consumers of report schemas versus the hand-written parser; wave requests use schemaPath:null. Delete unused twins or generate from one owner to avoid drift.
- **O09: session-root helper duplication.** Centralize similar derivation in root, handoff and interpreter without violating dependency direction.
- **O10: stale development diagnostics.** Plan REVISE rejection still says until revision lands (I06). Correct the current unsupported diagnostic; standalone revision support is a separate contract choice. Clean generic payload placeholders and increment-era comments where they no longer explain rationale.
- **O11: compact status and ask captures.** This run's done frame emitted roughly 16,000 tokens of collapsed delegate prose. Preserve raw claims by path and emit concise source/coverage summaries; progressive disclosure would reduce host context pressure without losing evidence. Ask transport success currently accepts progress-only prose: expose partial/unknown coverage explicitly rather than treating it as a completed answer.

### Further rejected suggestions

- Missing trailing Markdown table pipe is not a verified rendering bug: GFM permits omitted edge pipes. The delegate's merged-cell claim lacks evidence.
- Mandatory orchestrator is a documented current CLI contract; automatic detection is optional convenience, not an established regression.
- Restoring --help authority is incorrect because current CLI has no --help command. Provide a supported compact reference or deliberately add help separately.
- Do not restore old CONFIRM/REBUT protocols, markers, phase jumping, old recovery menus or consensus configuration; their removals are approved ADR changes.
- Adding an OpenCode prompt denylist is redundant; shared formatSafetyPrompt already supplies it. R05 concerns actual tool boundaries.
- One suggested RULINGS example used string values; current parser requires object-valued rulings. R11 must generate validator-checked examples.
- Guard-module absence is a spec-history discrepancy; current troubleshooting explicitly discloses native loader errors on unsupported Node. Do not automatically restore an obsolete promised filename.

## Final coverage and verification

Eight eligible configured slots were requested once. Antigravity, Codex and OpenCode[0,1,2,3] returned text; OpenCode[3] returned only progress and pending background work, so substantive coverage is five reports. Claude failed cli-outdated; OpenCode[4] timed out. Native-only Copilot targets are ineligible on this Codex host. No substitutes or missing reports are represented as completed reviews. Full claims, logs, outcomes, journal and failure details remain in this session folder.

Authoritative root after driver handoff: the current temp session folder. The session moved during synthesis; subsequent report writes use this root. No production source, config, tests or pre-existing scratch artifacts were intentionally changed; no fixes or commit performed.

Verification: npm test completed type/hash/term/config gates and all 525 assertions, but exited 1 on one aggregate per-file timing budget. Isolated effects-restore test passed 19/19 at 309 ms. Two scratch reproduction scripts independently demonstrated missing range/delta scope, false dispute settlement, and successful parsing overriding runner limit flags. Three development audit imports independently failed. Cross-platform live provider layouts, real sandbox behavior, and all possible rewrite transitions are not certified.

Suggested report commit message, if the user later chooses to retain it in tracked documentation: docs(dispatch): record v0.7 rewrite regression review. Scratch/temp artifacts are not committed by default.


## Final checkout drift note

Final verification found HEAD advanced concurrently from reviewed `443439a` to `5341f4e7e12ddca2c1ae3a67634ab042d4eb0aef` (`docs(readme): add branch and tag install example`). `git diff --stat 443439a HEAD` shows only four added README lines. No runtime or agent-contract changes; findings remain tied to the reviewed snapshot and README line numbers refer to that snapshot. The added install example does not resolve the identified stale workflow or safety text. Final git status matches the initial dirty path list; git diff --check passed. No source edits or commit made by this review.
