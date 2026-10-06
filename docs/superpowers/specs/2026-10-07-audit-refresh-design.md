# Audit Dispatch Skills Refresh

- Date: 2026-10-07
- Status: Proposed; awaiting written-spec approval
- Scope: Repository-local audit tooling and its handoff to audit-dispatch-skills-fix

## 1. Intent and success

Refresh `audit-dispatch-skills` so it finds consequential defects and useful improvements in Dispatch's correctness, clarity, context use, coordination, and recovery. The audit should challenge whether the workflow fulfills the user's objective, not merely whether code agrees with instructions. Success means actionable, verified findings at a bounded audit cost, with explicit coverage and limitations. Finding volume and checklist completion are not success measures.

The agreed approach is a scenario-based static walkthrough of every verb, shared-contract and cross-verb review, deterministic repository checks, and small provider smoke probes. Production diagnostics supply evidence about actual use; the audit does not recreate production by executing complete Dispatch flows.

User constraints:

- Audit agents trace the skill without running its full workflows or launching its nested delegates.
- Cheap live provider probes may remain.
- Examine inefficiency, ambiguity, wrong behavior, and avoidable delay; these examples do not exhaust the audit's scope.
- Propose improvements as well as identify defects, with evidence appropriate to each claim.
- Preserve report-only operation; remediation remains a separate task.

The numerical limits below are proposed defaults for review, not measured cost estimates. Implementation must expose them in one audit-owned configuration and report effective values for each run.

## 2. Current weaknesses and retained strengths

The current skill assigns one deep auditor per skill directory. Consequently, the main Dispatch implementation shares one scope while small aliases receive separate scopes. The deep brief demands every file and exported branch, includes retired paths, and treats broad reading as completion evidence. Provider probes exercise attachment handling and discovery, not verb workflows. Document footprint estimates cannot establish real token expenditure or latency.

Retain independent claims, lead-agent verification, severity ordering, repository containment, resumption, and the report's fix-status interface. Existing baseline, probe, finalization, and shared helpers have active consumers; reuse or adapt them rather than deleting them solely because they are `.mjs` files. File-extension migration is outside this refresh.

## 3. Scope and alternatives

In scope:

- `.agents/skills/audit-dispatch-skills/SKILL.md`, owned references, scripts, scenario definitions, and calibration fixtures.
- Focused changes to `.agents/skills/audit-dispatch-skills-fix/` if needed for the explicitly defined empty-findings behavior.
- Audit tooling tests and minimal supporting maintainer documentation.
- Static inspection of shipped skills, runtime, public documentation, tests, and repository-owned tooling relevant to Dispatch.

Out of scope: changing Dispatch runtime behavior, implementing audit findings, rewriting production diagnostics, auditing unrelated local skills in depth, adding dependencies, or building a generic evaluation platform. Vendored skills remain untouched. Audit self-review includes the audit/fix workflow's own safety, cost controls, and report contract.

Three approaches were considered:

| Approach | Benefit | Limitation |
|---|---|---|
| Refresh the existing exhaustive directory audit | Small workflow change | Preserves uneven scopes and weak evidence of goal fulfillment |
| Execute realistic tasks through every verb | Observes actual behavior and cost | Expensive; overlaps production diagnostics and contradicts the requested execution boundary |
| Static scenario walkthroughs plus bounded probes | Traces decisions and handoffs with targeted evidence | Cannot establish observed agent behavior or production performance |

Choose the third approach. Missing empirical evidence becomes a named limitation or follow-up, not an implied pass.

## 4. Audit structure and ownership

The lead owns the baseline, scenario selection, scheduling, adjudication, report, and finalization. It commissions six independent scopes: `ask`, `design`, `plan`, `review`, `implement`, and `shared`. This replaces per-directory fan-out.

Each verb auditor owns its entry conditions, instructions, reachable transitions, emitted host instructions, outcome, and branch-specific documentation. It follows dependencies only far enough to establish the relevant contract and routes shared concerns to the lead. The shared auditor owns invocation/routing, aliases, provider boundaries, permissions, common prompts and context loading, journals/recovery, cross-verb handoffs, public setup/usage claims, and audit tooling contracts.

Agents receive fresh contexts where the host supports them, a common intent brief, assigned scenarios, entrypoint pointers, baseline digest, evidence rules, effective limits, and an exclusive findings path. Do not preload the implementation or the lead's suspected findings. When context isolation is unavailable, record that limitation; separate agents are not automatically independent evidence.

Use available native agent slots, reserving capacity for the lead; queue scopes when slots are full. On hosts without subagents, perform the same scopes sequentially and disclose reduced independence. No auditor delegates further. Reuse command/agent handles and the repository's event-driven waiting policy.

### Walkthrough method

For each scenario, first state the expected user outcome and constraints from the objective and repository principles. Then trace from `skills/dispatch/SKILL.md` through the selected verb guide into the relevant instructions, runtime transitions, and tests. Use CodeGraph where required by repository guidance. Read referenced detail when the traced decision needs it; whole-tree reading is not a completion requirement.

Record one compact row per material decision or handoff:

| Field | Required evidence |
|---|---|
| Situation | Scenario, trigger, and relevant state |
| Available information | Inputs and references actually available to the host agent |
| Required action | Decision, command, artifact, or event and its owner |
| Transition | Producer, consumer, validation, and next state |
| Outcome | How this advances or blocks the expected user result |
| Support | Current `path:line`, relevant test, or explicit evidence gap |

At each transition examine missing information, contradictions, premature completion, stalls, repeated reads/context, unnecessary round trips, duplicate verification, and recovery. Inspect tests through the behavior they establish; missing export-name matches and test counts are leads, not findings. Ask whether removal, consolidation, or deterministic enforcement would simplify the flow without weakening its assurance boundaries.

Reading code can prove that a required round trip exists. Calling it unnecessary requires showing which decision or assurance it fails to add. Static repetition does not prove measured token waste.

## 5. Scenario coverage

Default to three scenarios per verb: normal completion, a material decision, and failure or recovery. These are representative traces, not exhaustive state-space coverage.

| Verb | Normal outcome | Decision case | Failure/recovery case |
|---|---|---|---|
| ask | Resolve a bounded question with supported advice | Missing context or disagreement affects the answer | Provider unavailable or incomplete response |
| design | Produce coherent increments and explicit boundaries | User changes an architectural constraint | Interrupted author/review handoff |
| plan | Produce an executable plan for one coherent unit | Scope does not fit the requested verb | Review/revision reveals an unmet prerequisite |
| review | Rule findings against the exact review target | Report-only versus explicitly requested fixes | Target drift or partial reviewer failure |
| implement | Deliver an approved scoped change with criterion evidence | Scope amendment or assurance-level decision | Interrupted writer attempt or failed verification |

These entries define coverage classes. The lead instantiates concrete task prompts, starting conditions, and expected outcomes from the current checkout at run start. It records why each branch was selected before auditors begin. For review, the three scenarios collectively cover code, design, and plan targets; uncovered kind-by-branch combinations remain explicit.

The shared scope traces four boundaries: design to plan, plan to implement, review findings to fixes, and interruption to resumed ownership. Check artifact identity, retained decisions/rationale, approval authority, validation, and evidence expected by the receiving workflow. Verb auditors supply producer/consumer evidence; shared adjudication avoids repeating complete verb walkthroughs.

Use explicit user scope first, then changes since the last recorded audit revision, prior unresolved defects, and optional diagnostics to select risky variants. Without a prior report, inspect recent relevant commits and record the comparison range. Rotate equally ranked untested branches deterministically using prior coverage; when history is absent use stable ordering. Default coverage always includes all five verbs. A user-narrowed run is labeled partial.

## 6. Cost controls and baseline

| Resource | Default bound | On exhaustion |
|---|---|---|
| Auditor scopes | Six; no nested delegates | Record any unlaunched scope as a gap |
| Scenarios | Three per verb plus four shared boundaries | Extra scenarios require an explicit expansion of run scope |
| Additional investigations | Two targeted branch expansions per scope | Return remaining leads without claiming coverage |
| Auditor inspection | 40 tool invocations and 20 minutes per scope | Persist findings and remaining gaps; stop at the next controllable boundary |
| Clarification/repair | One follow-up per scope | Lead uses available evidence and marks incomplete work |
| Lead investigation/adjudication | 60 tool invocations; exclude waits and final report/preservation operations | Publish a partial report with remaining claims unverified |
| Baseline tests | One aggregate suite invocation per audit | Preserve failures; no whole-suite retries in the audit |
| Focused test reproduction | Up to three lead-owned invocations | Record unresolved reproduction needs |

Tool/time limits are agent-enforced unless the host exposes enforceable controls; report overshoot and enforcement limitations. Tool counts are not interchangeable across hosts and are not token measurements. A configured host token limit is honored when available; absence is reported rather than emulated with estimates. Verification of already submitted claims remains lead-owned; if interrupted or budget-limited, publish a partial report with those claims marked unverified.

The lead captures revision, dirty state, effective settings, selected scenarios, available host capabilities, and relevant configuration fingerprints without secrets. Build one shared baseline: run the current `npm test` once, check links/anchors and hash drift without rewriting hashes, and inventory relevant paths. Use existing artifacts from this same audit when resuming. Remove mandatory whole-suite coverage collection and whole-tree export-to-test-name mapping as completion gates. Document-size estimates may remain clearly labeled supporting metrics.

No audit action invokes a full Dispatch start/send workflow, production writer, hash regeneration, or fix operation. Focused repository tests remain allowed; executing isolated test fixtures is distinct from commissioning a live Dispatch task. Tests and probes write only to approved scratch/temp locations.

## 7. Provider smoke probes

Discover providers and modes without model prompts, then select at most one reachable configured mode per provider. Support discovery-only and provider filtering. Additional modes are an explicit coverage expansion. Resolve read-delegate settings for the configured `low` level; record model, effort, and mode rather than silently inventing cheaper settings. A missing usable configuration yields an untested target.

Defaults: one model-bearing process launch per selected provider, zero retries/fallback launches, a 60-second per-target deadline covering preparation and execution, a 10-second termination grace, and a 16 KiB captured-output ceiling. Request at most 128 output tokens where the adapter supports a real generation limit. A byte cap bounds captured output, not model reasoning or billed usage; record unsupported generation limits. Selection and deadlines bound attempts, not dollars.

The read probe uses synthetic nonces in one small attachment and one sibling file in an isolated fixture directory. Ask for only the two values. Run through the current read-only provider adapter, with the fixture as working directory and no production task context. Retain the configured sandbox boundary; do not downgrade it to obtain coverage. Fixture and prompt text together are capped at 2 KiB, excluding adapter-owned instructions.

Enforce the single-launch bound at the process boundary, including runner-internal effort retries or fallback behavior. Preparation/discovery subprocesses may run but must be classified and timed separately from model-bearing launches. If an adapter cannot honor the launch, deadline, or output-capture limits, skip its live probe and report why. Hard monetary ceilings require provider support; this design makes no guarantee of a dollar cost.

Denylist enforcement is tested through the real preflight/attachment code with an injected process guard that refuses a model-bearing launch. Assert the prohibited attachment's content never reaches the launch request. Report attachment exclusion and whole-request rejection separately according to the actual contract. This must not be inferred from a missing nonce in a model response. The existing live denylist call is removed from the default probe budget.

Persist target lifecycle and results independently: selected, running, passed, failed, unavailable, skipped, or interrupted. On timeout terminate and confirm exit where possible; an unconfirmed process remains an explicit blocker to cleanup. Auth, quota, and missing binaries are environment limitations; reproducible adapter defects are candidate findings. No installation, login, or automatic retry is attempted by the audit.

## 8. Findings, opportunities, and evidence

Auditors return claims, scenario traces, examined-file lists, coverage gaps, and out-of-scope handoffs. They do not declare their own claims verified. Zero findings is valid. No finding quota or forced improvement proposal applies.

For each claim, the lead checks the cited current source against the governing user outcome, tests counterevidence, merges common root causes, and assigns `Verified`, `Unverified`, or refuted. Preserve source scopes and explain rejected/downgraded claims. A defect's severity follows the existing findings severity definitions; confidence does not inflate severity.

| Evidence class | What it supports |
|---|---|
| Static | Contradictory instructions, reachable transitions, omitted validation, required duplicate loads |
| Deterministic check | A reproduced contract/test/link failure under the recorded command and revision |
| Provider probe | The precise capability checked on one provider/mode/environment |
| Production diagnostic | Observed behavior in its recorded revision, task, and environment |

Keep evidence class, verification, and confidence distinct. Confidence is high when a direct trace or reproduction establishes the consequence and counterevidence has been addressed; medium when a stated environmental/interpretive assumption remains; low when the consequence is only a plausible lead. Medium/low claims remain unverified unless their narrowed wording is directly established. Diagnostics from another revision are historical context until applicability is checked.

Separate improvement opportunities from defects. Each opportunity states the observed structure or friction, proposed change, expected benefit, assurance/tradeoff risk, confidence, and cheapest validation that could settle it. Label unmeasured token/latency benefits as hypotheses. Opportunities require user selection before entering a remediation task; they are not automatically fixable findings.

Measured usage is reported per source when available. Missing data is unavailable, never zero. Report static footprint estimates separately from actual input/output/reasoning usage, probe wall time, and agent audit time. Do not estimate dollar savings from document size.

## 9. Report and fix compatibility

Preserve `.scratch/audits/<run>-audit.md` and the existing defect record grammar in `## 3. Findings`: `#### A-<n>` headings, the severity/axis/verification/source meta line, `Status`, `Location`, `Claim`, `Evidence`, and `Proposal`. Evidence class, scenario IDs, and confidence fit within the existing Evidence prose. Preserve severity grouping and the numbered `## 4.` boundary. The report remains the sole source of fix status.

Report sections:

1. Summary: prioritized verified defects, separate opportunity count, coverage gaps, baseline/probe verdicts, and budget/usage completeness.
2. Dispatch platforms: discovery, selected and untested modes, effective limits, measured results, and failure causes.
3. Findings: actionable defect claims using the existing parser contract.
4. Coverage: scenario outcomes, shared boundaries, examined surfaces, skipped branches, and enforcement limitations.
5. Improvement opportunities: `O-<n>` IDs, tradeoffs, confidence, and validation proposals.
6. Appendix: refuted claims, unresolved leads, command evidence, and artifact integrity/relocation details.

Do not manufacture a defect to satisfy the fix parser. A canonical empty findings section contains `No defect findings.` before `## 4. Coverage`. Update the fix parser to accept this exact empty representation while continuing to reject malformed nonempty findings. Fix init/batch should report zero open findings and finish without starting implementation. Opportunity IDs remain outside its parsed section. Add compatibility tests for zero findings, opportunities-only, and mixed reports.

The final report includes sufficient source excerpts and reproduction details to understand each claim without depending on relocated working files. Raw logs remain supplementary, with secrets redacted before report inclusion.

## 10. Artifacts, interruption, and integrity

Retain the audit-specific lifecycle: working evidence under `.scratch/audits/<run>-work/`, final report beside it, then relocation of working evidence to OS temp. This refresh does not migrate audit artifacts into Dispatch's session journal. This maintained design document lives in `docs/`; operational audit requirements will live in the local audit skill after implementation.

A small run manifest records the baseline identity, selected scenarios/settings, scope lifecycle, provider lifecycle, and retained handles where usable. It is execution bookkeeping, not a second finding-status database. Write records atomically; reserve a run directory exclusively and reject collisions. Baseline and completed captures are immutable on resume. A changed checkout invalidates affected source-based verification; preserve old evidence, retrace affected scopes, or start a new audit when the baseline is no longer comparable.

An interrupted run retains its work directory and marks incomplete scopes/probes. Resume uses existing evidence and confirmed process state rather than launching duplicates. A missing or malformed scope output gets one repair attempt within its budget. Failed probes never prevent static reporting; gaps prevent claims of complete coverage.

Finalization waits for all writers/probes to stop, compares content fingerprints as well as Git status, and reports concurrent changes without reverting them. Status text alone cannot detect additional edits to an already-dirty file. Snapshot tracked files and relevant preexisting nonignored untracked files, excluding only audit-owned outputs; fingerprint protected local config files without logging contents. Report the integrity check's exclusions instead of claiming ignored-file coverage. Audit-attributable writes outside containment are themselves findings. Preserve evidence when relocation fails and report the authoritative path; do not delete uncertain copies.

## 11. Calibration and verification

Validate the audit against a compact fixture corpus before accepting the rewrite. Curate four historical defects spanning instruction ambiguity, transition/handoff correctness, efficiency, and recovery or permissions, plus two intentional-behavior controls. Each case has a small source snapshot with relevant dependencies, a task scenario, and a maintainer-owned answer key. Only cases whose defect and resolution are supported by repository history qualify; an efficiency case needs a demonstrated redundant operation, not a speculative token estimate.

Give calibration auditors the scenario and necessary source, with answer keys and fix commits withheld from their briefs. Calibration is a separate invocation with only assigned cases, not a live Dispatch flow. The lead reveals the answer key after claims are fixed, then adjudicates matches by root cause rather than wording. Fresh context and revision records make limitations visible; no claim of experimental blinding is made where file access cannot isolate answers.

Initial acceptance: recover at least three of four known defects, including every selected high/critical defect; verify no false defect against either intentional-behavior control; and ground every accepted finding in a reproducible static trace or deterministic check. Record raw case outcomes, false positives, misses, agent/probe cost, and unavailable telemetry. Run the old and rewritten audit briefs on the same cases and host/model configuration once each, without live probes, to compare useful verified findings and cost. Small samples support calibration, not statistical reliability claims. If thresholds fail, revise and record the failure; do not silently relabel the cases. Subsequent case additions should include unseen examples to reduce overfitting.

| Criterion | Required verification |
|---|---|
| C1: Every verb and boundary is represented | Scenario-selection tests and a generated coverage report include all required classes; partial scope is explicit |
| C2: Static audit stays within its execution boundary | Calibration traces contain no live start/send flow or nested auditor launches; owned writes stay contained |
| C3: Probes remain bounded | Injected process tests verify launch counts, internal retry blocking, deadlines, output limits, no-launch denylist checks, and interrupted cleanup |
| C4: Evidence remains honest | Report fixtures cover unsupported performance claims, missing usage, historical diagnostics, unverified claims, and refutation |
| C5: Fix handoff remains usable | Existing report parser/status behavior plus empty, opportunities-only, and mixed-report tests pass |
| C6: Recovery preserves evidence | Resume/collision tests preserve baselines; dirty-file content changes are detected; failed relocation retains evidence |
| C7: Audit finds useful issues | Calibration meets the stated recall/control thresholds and reports the old/new comparison |
| C8: Repository checks pass | Focused audit tooling tests, `npm test`, and `git diff --check`; regenerate hashes only if implementation changes hash-tracked files |

Use public test entrypoints and the repository's isolated-temp/block-spawn harness. Real Git/subprocess cases belong in E2E tests. The default test suite uses fake provider ports and performs no billable live probes. One explicitly budgeted smoke invocation validates available real providers during implementation verification; unavailable providers remain gaps and do not block delivering the static audit when the bounded adapter contract passes deterministic tests.

## 12. Implementation boundaries and next stage

Implementation should adapt existing baseline/probe/finalization helpers, replace directory briefs with verb/shared walkthrough briefs and scenario references, introduce minimal execution bookkeeping and budget configuration, and narrowly extend the fix parser for canonical empty reports. Retire stale or redundant instructions after transferring their necessary behavior. Keep runtime contracts canonical in Dispatch; audit references point to them and specify how to examine them.

This document defines the design, not an implementation task sequence. After written-spec approval, create the implementation plan, map tasks to C1-C8, and present its execution method for user selection. No implementation or live calibration is authorized by the spec-writing task alone.
