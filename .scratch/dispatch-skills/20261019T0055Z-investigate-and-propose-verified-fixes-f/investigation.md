# Session efficiency investigation

Status: investigation complete; fix specification awaits approval. No product changes.

Source session: `01a14f6f-3fa3-7bb2-8dfe-3972c3663709`. Evidence folder: `../20261018T1434Z-design-a-safe-workflow-for-dispatch-to-i/`.

## Findings and dispositions

| Issue | Verified evidence | Explanation and proposed fix |
| --- | --- | --- |
| Repeated quota probes | Source metrics contain 21 successful and five quota outcomes. Diagnostics list five Claude failures across plan and code review, about 27 seconds total. `runVoice` in `skills/dispatch/scripts/effects/wave.ts:207` initializes the cascade position for each call; `runSlot:268` invokes it anew. | Confirmed repeated work, but a small direct time cost. Propose session-scoped, model-specific quota evidence, expiry and explicit reprobe. Preserve alternate models, reserve coverage, deadlines and independent slots. Define persistence, concurrent updates and recovery before implementation. A provider-wide exclusion is too broad. |
| Slow successful review slots | Retained metrics report 3188.196 seconds across six waves. Diagnostics show the slow reserve taking up to 15m57s. | Successful reviewers dominate wave latency. Offer an explicit faster configured roster with the same required coverage; measure it before claiming a gain. Do not silently reduce assurance or select models solely from one session's timings. |
| Misleading longest-host-turn wording | `003-code-review/events.jsonl`: final WAVE_DONE at 17:09:44.307 UTC; RULINGS at 19:10:55.417 UTC. The continuation message began at 19:10 UTC. `core/diagnostics.ts:156` assigns the interval to hostMs; `domain/diagnostics.ts:386` calls it a host turn. | The interval is measured elapsed wait, not measured active reasoning. First change labels and caveats without changing totals. Separate reset or other pause time only with explicit evidence; retain unknown time when evidence is absent. Do not infer inactivity from a long gap alone. |
| Partial usage described beside whole-session cost | `retro-source-metrics.json` records eight root/native entries: input 47,638,801; cached input 46,684,544; output 133,959. Diagnostics report provider usage coverage 15/26 and 6,095,929 measured tokens. | Both reports have different boundaries. Clarify the report's present measurement scope. Existing optional native/write attestations remain available; defer a full ingestion protocol until scope, provenance, observation cutoffs and cumulative overlap are defined. Reasoning is already included in output. Missing usage stays unavailable. |
| Preparation tested below the first write | `tests/e2e/implement.test.ts:35` extracts helper code directly and writes it from the test. The self-build reference first materializes that helper through a separate executable block. | The test does not prove that complete entry sequence. Add bounded tests through the documented preparation entry, covering invalid and linked paths before any write, valid preparation, existing files, restoration and cleanup boundaries. Inventory all executable blocks, then assign risk-based checks. Avoid a general documentation runner unless existing hooks cannot cover the real sequence. |
| Repeated aggregate gates | Seven retained npm-test logs: 430.78, 428.56, 612.33, 441.95, 436.03, 447.84, 439.49 seconds, sum 3236.98 seconds. Four failed, three passed. Initial failures include a real shipped-reference parity defect; later logs include setup/timeout failures. | Run affected cheap contract checks first. Preserve failure evidence, replay the exact failing scenario, then use the required unchanged aggregate gate after final bytes. Existing isolated passes do not prove flake causes. Keep all budgets, coverage and concurrency limits. Later product edits still require fresh final evidence. |
| Large context and repeated waiting narration | Metrics snapshot: root received 1,169,076 tool-output characters, made 238 exec calls, emitted 107 assistant messages and compacted twice. Retrieved thread shows repeated unchanged wait updates. | Apply existing lean-context and long-running-work rules: exact symbols, bounded output, file-backed evidence and retained completion handles. First use existing contracts; add automation only for a demonstrated enforcement gap. Do not claim a token saving without a comparable measured run. |

## Options

1. **Recommended: three narrow fix areas.** Safe preparation with complete-entry tests, truthful diagnostic wording and session-scoped quota persistence. Defer full host/native ingestion. Apply compact evidence handling immediately under existing rules. The implementation plan assigns concrete owners, dependencies and unchanged final gates.
2. **Configuration and operating practice only.** Lowest engineering cost and can improve review latency and context use, but does not close preparation coverage or diagnostic semantics.
3. **One broad scheduler and telemetry redesign.** Could combine routing and cost tracking, but adds recovery contracts and coordination before the smaller defects are fixed. Reject for this investigation.

## Limits

This review inspected current source, retained logs, metrics and journal timestamps. It did not recreate the historical session or run live provider probes. Current-checkout focused tests are recorded below; aggregate verification is reported separately in the final planning handoff. The source metrics stop before final handoff; they are not a billing total. Review and test durations can overlap. The reported 4h48m conversation window and 4h22m driver-session window have different boundaries. The first plan run remains in-progress in diagnostics; preserve it as historical evidence rather than silently changing its outcome.

## Planning acceptance

The implementation plan must define the resulting fixed product behavior, with scoped file ownership, behavioral tests and recovery checks. This invocation delivers the investigation, fix spec and reviewed implementation plan; it does not implement those fixes. Commit only completed human artifacts after required checks; exclude raw logs, session state and unrelated scratch.

## Additional verification and final dispositions

The deeper investigation reproduced a preparation safety defect, beyond the coverage gap above. `.state/scratch/investigate.mjs` extracts and executes the documented materializer unchanged. It accepted an arbitrary uninitialized directory and created a helper. It also followed a `.state` junction and wrote outside the supplied session. Both exited 0. All disposable paths were under this investigation's scratch. Results are retained in `.state/scratch/investigation-probes.json`. This proves missing checks for pre-existing links, not resistance to hostile concurrent mutation.

The same probe passed the measured journal gap to the current exported `heuristics` function. H6 reported `Longest host turn` for 2h1m11s without activity evidence. Existing focused baselines passed: 43 tests in `tests/unit/domain/diagnostics-report.test.ts` and 13 in `tests/unit/providers/wave.test.ts`, with repository isolation and reporter hooks. Logs are in `.state/scratch/diagnostics-baseline.log` and `.state/scratch/wave-baseline.log`. These passing baselines do not close the reproduced gaps.

| Disposition | Scope |
| --- | --- |
| Fix F1: preparation | Validate target/session ownership and pre-existing linked ancestors before the materializer's first write; test the complete documented entry sequence and inventory remaining executable block boundaries. |
| Fix F2: reporting | Label elapsed host-await time, measured provider usage, native/write estimates and frame-byte exposure precisely. Preserve numbers, privacy, default-off behavior and execution gates. |
| Fix F3: quota routing improvement | Retain expiring session-scoped evidence for the exact configured provider/model/mode; support explicit reprobe and preserve all coverage and recovery contracts. Current repeated probing follows the documented policy, so this is an improvement rather than a historical contract violation. |
| Defer automatic roster replacement | A universally faster equivalent roster is unproven. Keep selection explicit and assurance unchanged. |
| Defer full host/native telemetry | Optional tokens/duration attestations already exist but lack complete disjoint accounting. Clarify report scope now; defer a new ingestion protocol. |
| Apply existing context/wait rules | Use exact ranges, bounded output, durable evidence and retained completion handles. No new scheduler or standing prose is justified. |
| Apply existing verification rules | Run affected cheap contracts before final aggregate verification. Preserve failed logs and replay exact failures. No demonstrated root cause supports changing budgets or coverage. |

## Planning verification

On 2026-10-19, npm test passed against unchanged product HEAD f3fd1851e708aaf390623d39e02b9a0517cbcf47: 1496 tests passed, one skipped, across 168 files in 470.32 seconds. Type checking and diagram validation passed within that command. The approved spec hash remains sha256:7615113c174af09993617f042e3bf4c79a14cb6c72079fd705e65aed56a91ac3. This checks the planning baseline; the future implementation must run the plan's criterion checks and final aggregate gate after its changes.
