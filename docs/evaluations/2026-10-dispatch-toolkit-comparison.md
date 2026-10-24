# Dispatch Toolkit Comparison — 2026-10

Date: 2026-10-24
Controller: `ed416ff55baac072700347fdef040a0a23e28eb3`

## Summary

Verdict: **pass** under the fixed REQ-11 rule. Correctness is no worse for either task: `word-frequency` acceptance improved from 0/4 to 4/4, and `stats-cli` remained 3/3 with final verification passing on both sides. The only task verified on both sides is `stats-cli`; its host token total fell from 11,955,363 to 4,341,806. The `word-frequency` baseline was not verified, so it is excluded from the token condition. The measured `stats-cli` cost and elapsed time also fell, so the stricter cost-or-time reading passes. Both comparison runs used controller `ed416ff55baac072700347fdef040a0a23e28eb3` once on 2026-10-24.

The runs also exposed an I07 controller defect: generated writer briefs omitted a RED-capture command. This drove four accepted code findings about writer load-time RED failures on `word-frequency`, and six unique missing-RED findings plus three temporary T2 escalations (`SC4`–`SC6`) on `stats-cli`. REQ-5 and DEC-5 require TDD guidance but treat missing RED evidence as a review finding, not an admission failure. Both changes integrated and passed final verification and held-out acceptance (`word-frequency` 9/9 and 4/4; `stats-cli` 35/35 and 3/3), so the observed correctness signal remained no worse under REQ-11. Fix the brief-generation defect before I09 deletes the legacy engine. Confounders include Claude Code `2.1.301` versus `2.1.309` and the required Windows `System32` tar resolution. Comparison Git/npm versions, user-level instruction hashes, active phase times, and provider token subtotals are unavailable.

## Method

The I01 harness, tasks, seed and held-out acceptance files are unchanged. The controller was pinned by full commit SHA. Before both runs, the caller recorded an empty sample-path diff and empty ignored/untracked status (exit 0), and the self-check passed (exit 0). The portable, repository-relative command equivalents below are shown from the repository root. The actual runs used the absolute harness path and absolute output directories in the caller checkout; the launcher records retain the exact command lines. Each command ran once, in baseline order:

```text
node docs/evaluations/samples/run-sample.ts run --task word-frequency --controller ed416ff55baac072700347fdef040a0a23e28eb3 --out .scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/comparison/word-frequency
node docs/evaluations/samples/run-sample.ts run --task stats-cli --controller ed416ff55baac072700347fdef040a0a23e28eb3 --out .scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/comparison/stats-cli
```

Each command ran once; neither task, seed, prompt, acceptance file nor harness was changed. The baseline input revision was `f3c165ab669a6bd409883faf87fbc84899f39650`; the comparison input revision is the pinned controller commit. Every task, seed and acceptance blob below matches the baseline table.

| Path | Baseline blob | `ed416ff5` blob |
| --- | --- | --- |
| `docs/evaluations/samples/tasks.json` | `8bd8183b74dddd7f1a8a170c63f8423ebd57bf8f` | `8bd8183b74dddd7f1a8a170c63f8423ebd57bf8f` |
| `docs/evaluations/samples/textstats/README.md` | `78f27f60f505c0db8ae5360d7998233b142b8542` | `78f27f60f505c0db8ae5360d7998233b142b8542` |
| `docs/evaluations/samples/textstats/package.json` | `915cb143a4cdee96016592e5d762435457d677c2` | `915cb143a4cdee96016592e5d762435457d677c2` |
| `docs/evaluations/samples/textstats/src/text.js` | `387133c8372742a27858f9cfc5d417768962c0fb` | `387133c8372742a27858f9cfc5d417768962c0fb` |
| `docs/evaluations/samples/textstats/test/text.test.js` | `45a70e73fe85efc8d47742e84fc15bbf99a2312c` | `45a70e73fe85efc8d47742e84fc15bbf99a2312c` |
| `docs/evaluations/samples/acceptance/word-frequency.test.js` | `168bd3e0bea5d0f8ef305b7c2c8b210867aaf06e` | `168bd3e0bea5d0f8ef305b7c2c8b210867aaf06e` |
| `docs/evaluations/samples/acceptance/stats-cli.test.js` | `7de8f8362fea5dc13cfd097aa4463a019febef8d` | `7de8f8362fea5dc13cfd097aa4463a019febef8d` |

Both comparison `run.json` files confirm controller commit `ed416ff55baac072700347fdef040a0a23e28eb3` and the baseline config SHA-256 `ebf97fac458c0519c57360aeebb8c3e1480aa2b21c890c82362b92449f9bea1f`. The pinned settings are `claude-opus-5-5`, permission mode `auto`, Dispatch level `medium`, diagnostics enabled, and write concurrency 3. Both records show Node `v24.19.0` and Claude Code `2.1.309`; the comparison artifacts do not record Git or npm versions. Baseline versions were Git `2.55.0.windows.4` and npm `11.17.0`. Comparison user-level file hashes were not retained, so no post-run hash is substituted:

| User-level file | Baseline SHA-256 | Comparison SHA-256 |
| --- | --- | --- |
| `~/.claude/CLAUDE.md` | `a071ae5c25478e84abf40c0b9454d937b3c10786e38890b887445d3426ae4afb` | `unavailable` |
| `~/.claude/agents/dispatch-writer.md` | `7a480735dde416b3acf4618c63a200888f957b022eba5c2973aacd3a6ef36665` | `unavailable` |
| `~/.claude/agents/dispatch-writer-medium.md` | `30642cb18c1b21127054f6f3228d473f6dfbf00a17d76353ab3667090b85276d` | `unavailable` |
| `~/.claude/agents/dispatch-writer-high.md` | `1b2a80d511e809add07cc90354d879d0f8e0b7d1dfb0da4c23fc332423056ff9` | `unavailable` |
| `~/.claude/agents/dispatch-writer-xhigh.md` | `1ad667398da594dd2a00fea97af59f37f0239699da6c62d5d386e4510ccc20c1` | `unavailable` |
| `~/.claude/agents/dispatch-writer-max.md` | `59d4a9c606100d078c53a832dc7db139eac71ded5962ff3d0538e762059a5d78` | `unavailable` |
| `~/.claude/settings.json` | `181161104eed45ed164acb63abe864317a3dab1a1fccb950a87e17c272733afb` | `unavailable` |

The launcher record `tar-resolution.txt` shows that Windows System32 `tar.exe` was selected for both runs, as required to avoid Git's GNU tar treating Windows drive paths as remote-host notation. The exact inherited `PATH` is not retained, and neither `claude-result.json` narrative reports another host workaround. Claude Code `2.1.309` versus baseline `2.1.301` and the tar resolution are confounders, not adjustments. The comparison launcher exits were 0 for both commands; each `run.json` and acceptance file also records exit 0.

Account-wide Codex usage is supplementary context, not a verdict input. The usage endpoint reports whole percentages, so changes are rounded percentage-point differences; the snapshots cover account-wide activity and do not attribute usage to an individual run.

| Boundary | Observed at (UTC) | Weekly used | Five-hour used |
| --- | --- | ---: | ---: |
| Before the first sample | `2026-10-24T10:55:40.089Z` | 46% | 19% |
| Between samples, after `word-frequency` and before `stats-cli` | `2026-10-24T11:14:43.9725081Z` | 48% | 32% |
| After both samples, before final document review and verification | `2026-10-24T12:13:14.7149552Z` | 49% | 39% |

From before the first sample to after both samples, the account-wide readings increased by +3 weekly percentage points (46% to 49%) and +20 five-hour percentage points (19% to 39%). These rounded readings do not provide per-run token usage. The final row is specifically the after-samples snapshot, not a post-document-review reading.
Source: `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/comparison/launcher/` (`codex-usage-before.json`, `codex-usage-between.json`, and `codex-usage-after-samples.json`).

## Structural metrics

Commands read commit `ed416ff55baac072700347fdef040a0a23e28eb3`. Counts exclude `.test.ts`, `.spec.ts`, and files under test directories unless a metric names a specific source file.

| Metric | Value | Command |
| --- | --- | --- |
| driver TS LOC | 24,560 lines across 136 non-test `.ts` files | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","ed416ff55baac072700347fdef040a0a23e28eb3","--","skills/dispatch/scripts"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts")&&!p.includes("/tests/")&&!p.includes("/test/"));let n=0;for(const p of ps){const s=cp.execFileSync("git",["show","ed416ff55baac072700347fdef040a0a23e28eb3:"+p],{encoding:"utf8"});n+=s.split(/\r?\n/).length-(s.endsWith("\n")?1:0)}console.log(n,ps.length)'` |
| Exported types | 500 `export type` and `export interface` declarations, including type-only re-exports | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","ed416ff55baac072700347fdef040a0a23e28eb3","--","skills/dispatch/scripts"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts")&&!p.includes("/tests/")&&!p.includes("/test/"));let n=0;for(const p of ps){const s=cp.execFileSync("git",["show","ed416ff55baac072700347fdef040a0a23e28eb3:"+p],{encoding:"utf8"});n+=(s.match(/^export type /gm)??[]).length+(s.match(/^export interface /gm)??[]).length}console.log(n)'` |
| Event types | 37 unique uppercase event literals in `skills/dispatch/scripts/core/types.ts` | `node -e 'const cp=require("node:child_process");const s=cp.execFileSync("git",["show","ed416ff55baac072700347fdef040a0a23e28eb3:skills/dispatch/scripts/core/types.ts"],{encoding:"utf8"});console.log(new Set([...s.matchAll(/type\s*:\s*\x27([A-Z][A-Z0-9_]*)\x27/g)].map(m=>m[1])).size)'` |
| Decision kinds | 68 unique lowercase `kind:` literals across non-test driver TypeScript | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","ed416ff55baac072700347fdef040a0a23e28eb3","--","skills/dispatch/scripts"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts")&&!p.includes("/tests/")&&!p.includes("/test/"));const s=ps.map(p=>cp.execFileSync("git",["show","ed416ff55baac072700347fdef040a0a23e28eb3:"+p],{encoding:"utf8"})).join("\n");console.log(new Set([...s.matchAll(/\bkind\s*:\s*\x27([a-z][a-z0-9-]*)\x27/g)].map(m=>m[1])).size)'` |
| State tags | 79 unique lowercase `tag:` literals in non-test machine TypeScript | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","ed416ff55baac072700347fdef040a0a23e28eb3","--","skills/dispatch/scripts/machines"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts"));const s=ps.map(p=>cp.execFileSync("git",["show","ed416ff55baac072700347fdef040a0a23e28eb3:"+p],{encoding:"utf8"})).join("\n");console.log(new Set([...s.matchAll(/\btag\s*:\s*\x27([a-z][a-z0-9-]*)\x27/g)].map(m=>m[1])).size)'` |
| always-loaded prose bytes | `skills/dispatch/SKILL.md`: 3,586 UTF-8 bytes | `node -e 'const cp=require("node:child_process");console.log(cp.execFileSync("git",["show","ed416ff55baac072700347fdef040a0a23e28eb3:skills/dispatch/SKILL.md"]).byteLength)'` |

The legacy engine is still present at this revision, so driver TS LOC and the broad `kind:` and machine `tag:` counts above include both engines. Restricted to `skills/dispatch/scripts/toolkit/`, the same per-file newline method gives 5,640 LOC across 38 non-test TypeScript files, 11 `kind:` literals, and 0 `tag:` literals. I09 owns the structural targets. The root recheck is retained at `.scratch/dispatch-skills/20261024T1055Z-implement-i08-pre-release-comparison-gat/.state/scratch/root-structural-recheck.json`.

## Observations

Each row below records the toolkit run from retained artifacts. Field definitions follow the [evaluation protocol](../dispatch-efficiency-evaluation.md#observation-table), and baseline collection methods follow the [v0.7.3 baseline report](2026-10-dispatch-toolkit-baseline.md). `unavailable` is used only where no retained artifact records a value.

### word-frequency

| Field | Value | Source |
| --- | --- | --- |
| Run id and session directory | Harness task `word-frequency`; no separate opaque run ID. Dispatch session: `20261024T1104Z-add-wordfrequency-text-top-export-to-src`; outer interval `2026-10-24T11:03:59.815Z`–`2026-10-24T11:11:06.256Z`. | `run.json`; session `manifest.json` |
| Instruction revision | Controller revision and commit `ed416ff55baac072700347fdef040a0a23e28eb3`; config SHA-256 matches baseline. | `run.json`; Method |
| Task | `word-frequency`, size class `small`, 240-minute timeout; requests `wordFrequency(text, { top })` in `src/text.js`. | Pinned `tasks.json` blob above; `run.json` |
| Model, effort, provider, concurrency, tooling | Host `claude-opus-5-5`, Dispatch level `medium`, host effort unavailable, permission `auto`; diagnostics enabled, configured write concurrency 3; one native writer launch and eight provider CLI invocations. Provider/model/effort breakdown is unavailable (0/8 token coverage). Windows, Node `v24.19.0`, Claude Code `2.1.309`; comparison Git and npm versions are `unavailable`. | `run.json`; `claude-result.json`; config hash; session `diagnostics.md`; session `ledger.jsonl`; launcher records |
| Whitespace-delimited word counts | No instruction file changed during the task. `skills/dispatch/SKILL.md`: baseline 679 words; comparison controller 438 words; unchanged during each run. | Baseline Method; controller blob at `ed416ff55baac072700347fdef040a0a23e28eb3`; session `manifest.json` |
| Elapsed active time per phase | `unavailable`; toolkit diagnostics record no phase times. | Session `diagnostics.md` |
| Verification duration | Final `npm test` passed 9/9 in 164.5729 ms; held-out acceptance passed 4/4 in 144.5687 ms. | Session `.state/evidence/7fb4470c0f12f9d5c282f6826ccda37d3a113da4965ec973a9b117ab88efbe55.log`; `acceptance.json` |
| Invocation counts | One native writer invocation; eight provider CLI invocations across the review runs. Provider breakdown is unavailable. | `claude-result.json`; session `diagnostics.md`; session `ledger.jsonl` |
| Token subtotals | Host model usage: input 76, cache read 2,044,110, cache creation 123,827, output 24,390; total 2,192,403 tokens; cost USD 1.396886185. Provider token subtotals are `unavailable` (0/8 coverage). | `claude-result.json` `modelUsage`; session `diagnostics.md` |
| Repair attempts and admission defects | One initial writer launch; zero writer re-dispatches; one successful integration; all six evidence checks passed. No lint parse errors or gate refusals with exit 4. | Session `ledger.jsonl`; session `.state/results/`; session `.state/evidence/` |
| Review findings and adjudicated outcomes | Six unique accepted findings, all `SHOULD` (two plan findings and four code findings); one plan finding, `SHOULD`, was rejected. Four repeated code findings in round 2 were ruled duplicates and are not counted again. | Session review `findings.json` files; session `ledger.jsonl`; walkthrough |
| Final verification outcome | `npm test` passed 9/9; held-out acceptance passed 4/4; five SC checks and the contract check (six evidence checks) all have exit 0. Verified: yes. | Session `.state/evidence/`; walkthrough; `acceptance.json` |
| Coverage | Measured: host token classes and cost, outer run time, total invocation count, review outcomes, final verification and held-out acceptance. Partial: eight provider CLI launches are counted but have no provider/model breakdown or token usage. Unavailable: phase times and provider token subtotals. | `run.json`; `claude-result.json`; session `diagnostics.md`; ledger, review and acceptance records |

### stats-cli

| Field | Value | Source |
| --- | --- | --- |
| Run id and session directory | Harness task `stats-cli`; `run.json` has no separate opaque run ID. Dispatch session: `20261024T1115Z-add-summarize-library-and-textstats-cli` (`manifest.json` session ID `01a16d8c-8ed2-7ab0-8425-5e446ea96d04`); outer interval `2026-10-24T11:14:45.209Z`–`2026-10-24T11:28:06.456Z`. | `run.json`; session `manifest.json` |
| Instruction revision | Controller revision and commit `ed416ff55baac072700347fdef040a0a23e28eb3`; config SHA-256 matches baseline. | `run.json`; Method |
| Task | `stats-cli`, size class `multi-module`, 240-minute timeout; requests `summarize(text, { top })` and a `bin/textstats.js` CLI. | Pinned `tasks.json` blob above; `run.json` |
| Model, effort, provider, concurrency, tooling | Host `claude-opus-5-5`, Dispatch level `medium`, host effort unavailable, permission `auto`; diagnostics enabled, configured write concurrency 3; two native `claude-haiku-5-5` high writer launches and eight provider CLI invocations. Provider/model/effort breakdown is unavailable (0/8 token coverage). Windows, Node `v24.19.0`, Claude Code `2.1.309`; comparison Git and npm versions are `unavailable`. | `run.json`; `claude-result.json`; config hash; session `diagnostics.md`; session `ledger.jsonl`; launcher records |
| Whitespace-delimited word counts | No instruction file changed during the task. `skills/dispatch/SKILL.md`: baseline 679 words; comparison controller 438 words; unchanged during the run. | Baseline Method; controller blob at `ed416ff55baac072700347fdef040a0a23e28eb3`; session `manifest.json` |
| Elapsed active time per phase | `unavailable`; toolkit diagnostics report no phase times. | Session `diagnostics.md` |
| Verification duration | Final `npm test` passed 35/35 in 2,043.8147 ms; held-out acceptance passed 3/3 in 856.667 ms. | Session `.state/evidence/1a571aadb485fbe0591e3d4871e599d59a2351f2eee75c00f2d2a7b8f1e7e113.log`; `acceptance.json` |
| Invocation counts | Two native high writer invocations (one each for T1 and T2); eight provider CLI invocations across the review runs. Provider breakdown is unavailable. | `claude-result.json`; session `diagnostics.md`; session `ledger.jsonl` |
| Token subtotals | Host model usage: input 132, cache read 4,102,906, cache creation 185,990, output 52,778; total 4,341,806 tokens; cost USD 1.974000445. Provider token subtotals are `unavailable` (0/8 coverage). | `claude-result.json` `modelUsage`; session `diagnostics.md` |
| Repair attempts and admission defects | One initial launch for each of two writers; zero writer re-dispatches; one post-review code fix rejects `--top` values beyond the safe integer range; all seven numbered SC checks and the contract check passed afterward. Three temporary missing-RED escalations for T2 SC4–SC6 were resolved after orchestrator reproduction against the base tree. Five failed ledger-append results are separate bookkeeping failures: two `invalid-input` results, `input requires a readable JSON record file` (exit 1; `ledger-append-0ccce470-2dff-40e1-ab08-acadaf6b8196.json`, `ledger-append-fe4d0649-dc3c-4916-9ba3-603958c865d0.json`), and three `key-conflict` results (exit 2; keys `missing-red:code-integration:T2:SC4:R2:g1`, `missing-red:code-integration:T2:SC5:R2:g1`, and `missing-red:code-integration:T2:SC6:R2:g1`; files `ledger-append-ce082baa-4311-4799-a299-3a9801745445.json`, `ledger-append-bd5cfc71-d73a-4c04-8944-d6c2ba1166b1.json`, and `ledger-append-679446e4-7eed-48cd-940a-3e1dbf06bcd5.json`). These exits are not exit-4 gate refusals. | Session `ledger.jsonl`; session `.state/results/` (five named `ledger-append` files); session `.state/evidence/`; session `.state/scratch/red/`; `skills/dispatch/scripts/toolkit/ledger.ts:96` |
| Review findings and adjudicated outcomes | Ten unique accepted findings (1 `MUST`, 9 `SHOULD`); none rejected. Six repeated code findings in round 2 were ruled duplicates and are not counted again. | Session review `findings.json` files; session `ledger.jsonl`; walkthrough |
| Final verification outcome | `npm test` passed 35/35; held-out acceptance passed 3/3; all seven numbered SC checks and the contract check (eight evidence checks) have exit 0. Verified: yes. | Session `.state/evidence/`; walkthrough; `acceptance.json` |
| Coverage | Measured: host token classes and cost, outer run time, total invocation count, review outcomes, final verification and held-out acceptance. Partial: eight provider CLI launches are counted but have no provider/model breakdown or token usage. Unavailable: phase times, provider token subtotals, comparison Git/npm versions, and comparison user-level file hashes. | `run.json`; `claude-result.json`; session `diagnostics.md`; ledger, review and acceptance records; launcher records |

## Comparison

### word-frequency

| Measure | Baseline | Comparison | Source |
| --- | --- | --- | --- |
| Held-out acceptance | Failed, 0/4 passed. | Passed, 4/4. | Baseline and comparison `acceptance.json` |
| Final verification | No implementation ran; seed `npm test` passed 5/5, then held-out acceptance failed 0/4. | Final `npm test` passed 9/9; held-out acceptance passed 4/4. | Baseline and comparison verification logs; both `acceptance.json` files |
| Repair attempts | Three internal Dispatch attempts; two retries after the first; no writer launched. | One first-launch writer; zero writer re-dispatches or failed verification/tool results. | Baseline retained events and `claude-result.json`; comparison ledger and results |
| Admission defects | 0 journal admission records. | 0 lint parse errors; 0 gate refusals with exit 4 and a `reason`. | Baseline session events; comparison lint and tool result JSON |
| Accepted findings by severity | 2 accepted `SHOULD`; 2 rejected `SHOULD`. | 6 unique accepted `SHOULD`; 1 rejected `SHOULD`; round-2 duplicates excluded. | Baseline review log and rulings; comparison findings and ledger rulings |
| Verified (yes/no) | No. | Yes. | Acceptance and final verification records |
| Host input tokens | 100 | 76 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host cache-read tokens | 3,466,399 | 2,044,110 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host cache-creation tokens | 146,871 | 123,827 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host output tokens | 30,531 | 24,390 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host tokens total | 3,643,901 | 2,192,403 | Sum the four host token classes across every model in `claude-result.json` `modelUsage` |
| Cost USD | 2.174783745 | 1.396886185 | Sum model `costUSD` in baseline and comparison `claude-result.json` `modelUsage` |
| Elapsed outer time | 8m 58.342s | 7m 6.441s | Baseline and comparison `run.json` start and end timestamps |
| Invocation counts | 4 provider CLI invocations (Codex 2, AGY 2); no writer launch. | 8 provider CLI invocations (provider breakdown unavailable); one native writer launch. | Baseline diagnostics; comparison session diagnostics, `claude-result.json`, and ledger |
| Provider tokens | Codex: input 51,705, cache read 395,520, cache write 0, output 2,759. AGY: input 214,504, cache read 140,758, cache write `unavailable`, output 1,239. | `unavailable` (0/8 provider CLI token coverage). | Baseline session diagnostics; comparison session `diagnostics.md` |

### stats-cli

| Measure | Baseline | Comparison | Source |
| --- | --- | --- | --- |
| Held-out acceptance | Passed, 3/3. | Passed, 3/3. | Baseline and comparison `acceptance.json` |
| Final verification | Final `npm test` passed 28/28; held-out acceptance passed 3/3. | Final `npm test` passed 35/35; held-out acceptance passed 3/3. | Baseline and comparison verification logs; both `acceptance.json` files |
| Repair attempts | Four internal attempts across two sessions; three failed before code was written and the fourth completed. | Two first-launch writers and zero writer re-dispatches; one post-review safe-integer code fix; five failed ledger appends: two `invalid-input` (exit 1, unreadable JSON record input; files `ledger-append-0ccce470-2dff-40e1-ab08-acadaf6b8196.json` and `ledger-append-fe4d0649-dc3c-4916-9ba3-603958c865d0.json`) and three `key-conflict` (exit 2, T2 keys `missing-red:code-integration:T2:SC4:R2:g1`, `missing-red:code-integration:T2:SC5:R2:g1`, `missing-red:code-integration:T2:SC6:R2:g1`; files `ledger-append-ce082baa-4311-4799-a299-3a9801745445.json`, `ledger-append-bd5cfc71-d73a-4c04-8944-d6c2ba1166b1.json`, and `ledger-append-679446e4-7eed-48cd-940a-3e1dbf06bcd5.json`). All seven numbered SC checks and the contract check then passed. | Baseline retained run artifacts and `claude-result.json`; comparison ledger, evidence and named files in the stats-cli session `.state/results/` |
| Admission defects | 0 journal admission records. | 0 lint parse errors; 0 gate refusals with exit 4 and a `reason`. The five failed ledger-append calls in the Repair attempts row returned exit 1 or 2, not exit 4; three temporary missing-RED escalations were resolved after orchestrator reproduction against the base tree. | Baseline session events; comparison lint results, ledger, reviews, RED logs and failed tool results |
| Accepted findings by severity | 3 accepted `MUST`, 4 accepted `SHOULD`; none rejected. | 1 accepted `MUST`, 9 accepted `SHOULD`; none rejected. Six round-2 repeated code findings were duplicates and are excluded. | Baseline and comparison review logs, findings files, and rulings |
| Verified (yes/no) | Yes. | Yes. | Acceptance and final verification records |
| Host input tokens | 264 | 132 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host cache-read tokens | 11,475,725 | 4,102,906 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host cache-creation tokens | 371,885 | 185,990 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host output tokens | 107,489 | 52,778 | Baseline and comparison `claude-result.json` `modelUsage`, summed across models |
| Host tokens total | 11,955,363 | 4,341,806 | Sum the four host token classes across every model in `claude-result.json` `modelUsage` |
| Cost USD | 4.32078905 | 1.974000445 | Sum model `costUSD` in baseline and comparison `claude-result.json` `modelUsage` |
| Elapsed outer time | 24m 7.423s | 13m 21.247s | Baseline and comparison `run.json` start and end timestamps |
| Invocation counts | 12 provider CLI invocations (Codex 6, AGY 6); 2 native Claude writer invocations. | 8 provider CLI invocations (provider breakdown unavailable); 2 native high writer invocations. | Baseline and comparison diagnostics, `claude-result.json`, and ledger |
| Provider tokens | Codex: input 172,588, cache read 882,304, cache write 0, output 6,331. AGY: input 417,545, cache read 718,877, cache write `unavailable`, output 3,589. | `unavailable` (0/8 provider CLI token coverage). | Baseline session diagnostics; comparison session `diagnostics.md` |

REQ-11 passes only if both fixed conditions hold:

1. **Correctness is no worse for each task.** Held-out acceptance and final orchestrator verification are no worse than baseline. Accepted findings, repair attempts and admission defects are not higher unless each increase is explained from cited artifacts. Baseline admission defects are journal admission records; toolkit admission defects are lint parse errors and gate refusals (exit 4 with a `reason`). An unavailable count leaves this condition unsatisfied.
2. **Host tokens per verified task are not higher with comparable coverage.** Sum input, cache-read, cache-creation and output tokens across all models in `claude-result.json` `modelUsage`, counting only tasks verified on both sides. At least one task must be verified on both sides. `word-frequency` is excluded from this condition when its baseline acceptance is not verified; its correctness comparison still applies. An unavailable value leaves this condition unsatisfied.

Condition 1 is satisfied for both tasks. The findings increase exposed the same I07 controller defect: generated writer briefs omitted a RED-capture command. On `word-frequency`, acceptance improved from 0/4 to 4/4 and final implementation verification passed where the baseline never reached implementation. Accepted unique findings rose from two to six, all `SHOULD`: two plan findings clarified criteria and verification, and four code findings reported writer load-time RED failures that the orchestrator reproduced with stub exports. On `stats-cli`, acceptance remained 3/3 and final verification passed 28/28 then 35/35. Accepted findings rose from seven to ten: three accepted plan findings addressed digit-only `--top` input `01`, zero-selected test-name patterns, and validating arguments before file reading; one code finding fixed a 309-digit `--top` safe-integer overflow; and six unique missing-RED findings traced to the absent brief command. Three temporary T2 `SC4`–`SC6` escalations were separate from that ten-finding count; they arose from the same missing-RED capture, were reproduced against the base tree, and were resolved as a bounded limitation. The orchestrator reproduced the focused failures on the base tree, and final verification and held-out acceptance passed. Four round-2 code findings were ruled duplicates for `word-frequency` and six for `stats-cli`. REQ-5 and DEC-5 treat missing RED evidence as a review finding rather than an admission failure, so this controller defect is a follow-up, not a failed admission check. The actual integrated changes passed final checks and held-out tests on both tasks, so the measured correctness outcomes remain no worse; fix brief generation before I09 deletes the legacy engine.

The stats-cli repair-attempt evidence records five failed ledger-append operations in addition to the one code fix; the baseline records three failed attempts before its fourth, successful outer attempt. These are different units. The two `invalid-input` results report that the supplied input was not a readable JSON record file; the three `key-conflict` results report different content for the repeated T2 missing-RED keys. They returned exit 1 or 2, not exit 4, so they do not add admission defects. The raw failed-tool count is higher, but each failure is explained by its retained result file, the writer did not re-dispatch, and final required verification and acceptance passed. Under condition 1's stated allowance for explained increases, this does not reverse the no-worse correctness determination for these samples. The five exact files and keys are listed in the stats-cli repair-attempt rows above.

Condition 2 is satisfied over the only task verified on both sides: `stats-cli`. Its host tokens fell from 11,955,363 to 4,341,806 (input 264→132, cache read 11,475,725→4,102,906, cache creation 371,885→185,990, output 107,489→52,778). Both sums use every model in `claude-result.json` `modelUsage`, so host-token coverage is comparable. `word-frequency` is excluded because its baseline acceptance was not verified. Provider token subtotals are unavailable for the comparison runs, but they are not substituted for the complete host `modelUsage` totals.

The stricter protocol reading, which requires at least one measured cost or time dimension to improve, also holds on `stats-cli`: host cost fell from USD 4.32078905 to USD 1.974000445, and outer elapsed time fell from 24m 7.423s to 13m 21.247s. These are single observations, not a trend. The sample size is one run per task per side; Claude Code version and tar-resolution differences remain confounders, and phase-level timing and several environment/provider fields are unavailable.

## Coverage

The baseline measured phase times, reviewer invocations and provider tokens, host model usage, review outcomes, seed/final verification and acceptance. Baseline native per-invocation writer tokens, AGY cache-write tokens, and changed-instruction-file word-count pairs are unavailable or not applicable because no instruction file changed; details are in the [v0.7.3 baseline report](2026-10-dispatch-toolkit-baseline.md). The comparison measured host token classes and cost, outer elapsed time, invocation totals, review outcomes, final verification and held-out acceptance. Provider invocation counts are partial because provider/model identities and token subtotals have 0/8 coverage. Active phase times, comparison Git and npm versions, and comparison user-level file hashes are unavailable in the retained comparison artifacts.

## Artifacts

- Comparison task runs: `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/comparison/word-frequency/` and `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/comparison/stats-cli/`
- Comparison launcher records: `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/comparison/launcher/`
- Baseline runs: `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/baseline/`
- Structural metric recheck: `.scratch/dispatch-skills/20261024T1055Z-implement-i08-pre-release-comparison-gat/.state/scratch/root-structural-recheck.json`
