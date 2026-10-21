# Dispatch Toolkit Baseline — 2026-10

Date: 2026-10-21
Controller: `v0.7.3` (`3d49b6ed41bb12705b8f49e92ebfa4be7c95dc31`)
Input revision: `f3c165ab669a6bd409883faf87fbc84899f39650` (temporary local integration commit; not branch-reachable)

## Summary

The two committed sample tasks were each submitted to the harness once, in sequence, with the pinned task settings. `word-frequency` is an environment failure: no writer started and the held-out suite failed 4/4 because `wordFrequency` was absent. It is unusable as an I08 correctness reference and cannot prove that there was no regression. Comparisons require a matched environment, and repeating a failing sample cannot by itself establish correctness. `stats-cli` completed: its final `npm test` passed 28/28 and its held-out suite passed 3/3.

These are single observations, not a trend. The first task had three internal Dispatch implementation attempts across two Dispatch sessions. The second had four attempts in the retained session artifacts across two Dispatch sessions: three failed before code was written, then the fourth completed. These internal attempts are part of one outer Claude Code session per harness task; neither harness command was retried and no task, prompt, or seed was changed.

Unavailable fields are: before/after word counts for changed instruction files (neither task changed an instruction file); per-invocation native writer token subtotals in Dispatch diagnostics; and AGY cache-write tokens. The host result records aggregate Claude model usage, which has a different scope from Dispatch's per-invocation provider totals. The outer Claude result text for `stats-cli` says two runs failed and the third completed; the retained session artifacts record one failed run in the first session and three runs in the second session (two failed, one completed). Counts below follow the retained artifacts.

## Method

The task definitions were read from `docs/evaluations/samples/tasks.json` at the input revision. Each harness command ran once from the T2 worktree and wrote to the absolute original caller-session path shown below. The held-out acceptance files remained outside each disposable sample working copy.

```text
node docs/evaluations/samples/run-sample.ts run --task word-frequency --controller v0.7.3 --out C:\Users\fchei\Projects\dispatch-skills\.scratch\dispatch-skills\20261021T1011Z-refactor-dispatch-to-cut-complexity-brit\.state\scratch\evaluations\baseline\word-frequency
node docs/evaluations/samples/run-sample.ts run --task stats-cli --controller v0.7.3 --out C:\Users\fchei\Projects\dispatch-skills\.scratch\dispatch-skills\20261021T1011Z-refactor-dispatch-to-cut-complexity-brit\.state\scratch\evaluations\baseline\stats-cli
```

The first outer session ran from `2026-10-21T14:47:20.905Z` to `14:56:19.247Z`; the second ran from `14:58:40.386Z` to `15:22:47.809Z`. Both used `claude-opus-5-5`, `permissionMode: auto`, Node `v24.19.0`, Claude Code `2.1.301`, Git `2.55.0.windows.4`, npm `11.17.0`, and Windows (`win32`). The task prompts selected Dispatch level `medium`; a separate host model effort was not recorded. The tasks specify a 240-minute timeout. The harness did not time out.

Input commit `f3c165ab669a6bd409883faf87fbc84899f39650` is present locally as a temporary integration commit, but is not reachable from a branch and may be garbage-collected. Use the blob hashes below as durable content identities. At that commit, `tasks.json` had blob `8bd8183b74dddd7f1a8a170c63f8423ebd57bf8f`. The committed seed and held-out files had these blobs:

| Path at input commit | Blob |
| --- | --- |
| `docs/evaluations/samples/textstats/README.md` | `78f27f60f505c0db8ae5360d7998233b142b8542` |
| `docs/evaluations/samples/textstats/package.json` | `915cb143a4cdee96016592e5d762435457d677c2` |
| `docs/evaluations/samples/textstats/src/text.js` | `387133c8372742a27858f9cfc5d417768962c0fb` |
| `docs/evaluations/samples/textstats/test/text.test.js` | `45a70e73fe85efc8d47742e84fc15bbf99a2312c` |
| `docs/evaluations/samples/acceptance/word-frequency.test.js` | `168bd3e0bea5d0f8ef305b7c2c8b210867aaf06e` |
| `docs/evaluations/samples/acceptance/stats-cli.test.js` | `7de8f8362fea5dc13cfd097aa4463a019febef8d` |

The harness recorded disposable seed commits `790b1d2b2709a39ea5f87fa2f323164b71739aaa` (`word-frequency`) and `e9b32c278f42504d293aea44f17e00dd4ac0e4c1` (`stats-cli`). Both run records name controller `v0.7.3` and peeled controller commit `3d49b6ed41bb12705b8f49e92ebfa4be7c95dc31`.

Both runs copied the ignored local Dispatch config byte-for-byte; `run.json` records SHA-256 `ebf97fac458c0519c57360aeebb8c3e1480aa2b21c890c82362b92449f9bea1f`. It enabled diagnostics, set `write-concurrency` to 3, and configured Claude, Codex, AGY, and OpenCode delegates. Actual external provider launches used Codex `gpt-6.1-sol` and AGY `gemini-3.8-flash`; `stats-cli` also used two native Claude `claude-haiku-5-5` writer agents. The medium plan-review configuration targeted two reviewers for two rounds; code review targeted two reviewers for up to three rounds.

The headless host also loaded user-level Claude instructions and writer definitions. Hashes collected for this baseline are:

| User-level file | SHA-256 |
| --- | --- |
| `~/.claude/CLAUDE.md` | `a071ae5c25478e84abf40c0b9454d937b3c10786e38890b887445d3426ae4afb` |
| `~/.claude/agents/dispatch-writer.md` | `7a480735dde416b3acf4618c63a200888f957b022eba5c2973aacd3a6ef36665` |
| `~/.claude/agents/dispatch-writer-medium.md` | `30642cb18c1b21127054f6f3228d473f6dfbf00a17d76353ab3667090b85276d` |
| `~/.claude/agents/dispatch-writer-high.md` | `1b2a80d511e809add07cc90354d879d0f8e0b7d1dfb0da4c23fc332423056ff9` |
| `~/.claude/agents/dispatch-writer-xhigh.md` | `1ad667398da594dd2a00fea97af59f37f0239699da6c62d5d386e4510ccc20c1` |
| `~/.claude/agents/dispatch-writer-max.md` | `59d4a9c606100d078c53a832dc7db139eac71ded5962ff3d0538e762059a5d78` |
| `~/.claude/settings.json` | `181161104eed45ed164acb63abe864317a3dab1a1fccb950a87e17c272733afb` |

The `word-frequency` host result reports that its first two internal attempts hit Windows `Filename too long` errors. A process-only Git long-path environment workaround got past those errors; its third attempt then failed with `spawn ENAMETOOLONG` while snapshotting the unignored `.scratch` state. The host reports that it checked and force-removed the temporary integration worktree, which contained only Dispatch state files. No code was written.

The `stats-cli` host result reports a local `git config --local core.longpaths true` setting and an `.scratch/` entry in `.git/info/exclude` in the disposable sample repository. It says those changes were uncommitted and the working copies were cleaned up. Retained diagnostics show failures caused by long state paths, prior session state entering the snapshot, and an integration worktree under the non-ignored scratch root. These environment repairs are confounders; they did not change the committed seed, task prompt, or controller revision.

## Structural metrics

Each command reads the `v0.7.3` tag, not the current worktree. The TypeScript inventory excludes `.test.ts`, `.spec.ts`, and files under test directories.

| Metric | Value | Command |
| --- | --- | --- |
| driver TS LOC | 19,182 lines across 98 non-test `.ts` files; spec background says 19.2k | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","v0.7.3","--","skills/dispatch/scripts"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts")&&!p.includes("/tests/")&&!p.includes("/test/"));let n=0;for(const p of ps){const s=cp.execFileSync("git",["show","v0.7.3:"+p],{encoding:"utf8"});n+=s.split(/\r?\n/).length-(s.endsWith("\n")?1:0)}console.log(n,ps.length)'` |
| Exported types | 406 `export type` and `export interface` declarations, including two type-only re-exports; 404 definitions plus 2 re-exports | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","v0.7.3","--","skills/dispatch/scripts"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts")&&!p.includes("/tests/")&&!p.includes("/test/"));let n=0;for(const p of ps){const s=cp.execFileSync("git",["show","v0.7.3:"+p],{encoding:"utf8"});n+=(s.match(/^export type /gm)||[]).length+(s.match(/^export interface /gm)||[]).length}console.log(n)'` |
| Event types | 37 unique uppercase event literals in `core/types.ts` | `node -e 'const cp=require("node:child_process");const s=cp.execFileSync("git",["show","v0.7.3:skills/dispatch/scripts/core/types.ts"],{encoding:"utf8"});console.log(new Set([...s.matchAll(/type\s*:\s*\x27([A-Z][A-Z0-9_]*)\x27/g)].map(m=>m[1])).size)'` |
| Decision kinds | 63 unique lowercase `kind:` literals across non-test driver TypeScript; the narrower `DecideKind` union has 16 members | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","v0.7.3","--","skills/dispatch/scripts"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts")&&!p.includes("/tests/")&&!p.includes("/test/"));const s=ps.map(p=>cp.execFileSync("git",["show","v0.7.3:"+p],{encoding:"utf8"})).join("\n");console.log(new Set([...s.matchAll(/\bkind\s*:\s*\x27([a-z][a-z0-9-]*)\x27/g)].map(m=>m[1])).size)'` |
| State tags | 80 unique lowercase `tag:` literals in non-test machine TypeScript | `node -e 'const cp=require("node:child_process");const ps=cp.execFileSync("git",["ls-tree","-r","--name-only","v0.7.3","--","skills/dispatch/scripts/machines"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.endsWith(".spec.ts"));const s=ps.map(p=>cp.execFileSync("git",["show","v0.7.3:"+p],{encoding:"utf8"})).join("\n");console.log(new Set([...s.matchAll(/\btag\s*:\s*\x27([a-z][a-z0-9-]*)\x27/g)].map(m=>m[1])).size)'` |
| always-loaded prose bytes | `skills/dispatch/SKILL.md`: 6,454 UTF-8 bytes; spec background says about 5 KB | `node -e 'const cp=require("node:child_process");console.log(cp.execFileSync("git",["show","v0.7.3:skills/dispatch/SKILL.md"]).byteLength)'` |

The broad `kind:` count includes effect and internal kind tags, not only host-facing decisions; the narrower 16-member count is the `DecideKind` union. The byte count is the UTF-8 byte length of the tag blob. The baseline `SKILL.md` has 679 whitespace-delimited words; no instruction file changed in either sample task.

## Observations

### word-frequency

| Field | Value | Source |
| --- | --- | --- |
| Run id and session directory | Harness task `word-frequency`; `run.json` has no separate opaque run ID. Retained Dispatch sessions: `20261021T1447Z-add-wordfrequency-text-top-export-to-src` and `20261021T1449Z-wordfrequency`. | `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/baseline/word-frequency/run.json`; `sessions/*/manifest.json` |
| Instruction revision | Controller `v0.7.3`, commit `3d49b6ed41bb12705b8f49e92ebfa4be7c95dc31`; local config SHA-256 `ebf97fac458c0519c57360aeebb8c3e1480aa2b21c890c82362b92449f9bea1f`; host instruction and agent hashes are listed in Method. | `run.json`; Method |
| Task | `word-frequency`, size class `small`; task prompt requests `wordFrequency(text, { top })` in `src/text.js`. | `docs/evaluations/samples/tasks.json` blob above; `run.json` |
| Model, effort, provider, concurrency, tooling | Host `claude-opus-5-5`, explicit level `medium`, host effort unavailable, permission `auto`; diagnostics on, write concurrency 3. Four external review launches in the final internal attempt: Codex `gpt-6.1-sol` low (2), AGY `gemini-3.8-flash` low (2); no writer launched. Node `v24.19.0`, Claude Code `2.1.301`, Git `2.55.0.windows.4`, npm `11.17.0`, Windows. | `tasks.json`; `run.json`; `sessions/20261021T1449Z-wordfrequency/diagnostics.md`; Method |
| Whitespace-delimited word counts | `unavailable` for changed instruction files: none changed. Baseline `SKILL.md`: 679 words; after count is not applicable because it was unchanged. | Tag command above; session manifests |
| Elapsed active time per phase | Three internal attempts across two sessions. Session 1447: implementation 31s, plan 42s, total 1m14s, user wait <1s. Session 1449 run 1: implementation 14s, plan 6s, total 21s, user wait <1s. Session 1449 run 2: implementation 1m28s, plan 47s, plan review 3m35s, total 5m51s, user wait 14s. The outer harness ran 8m58.342s. | `sessions/*/diagnostics.md`; `run.json` |
| Verification duration | The seed's `npm test` passed 5/5 in 109.2947ms. The focused `wordFrequency` command failed because `test/word-frequency.test.js` did not exist. Held-out acceptance ran in 122.8094ms and failed 4/4. | `sessions/20261021T1449Z-wordfrequency/.state/runs/002-implement/implement.verify.1/{1,2}.log`; `acceptance.json` |
| Invocation counts | Four provider CLI invocations in plan review (two rounds): Codex 2, AGY 2. Zero writer invocations; the earlier two internal attempts also had zero provider launches. | `sessions/*/diagnostics.md` |
| Token subtotals | Host Claude usage: Opus input 94, cache read 3,417,862, cache creation 116,908, output 27,491, cost USD 2.1690324; Haiku input 6, cache read 48,537, cache creation 29,963, output 3,040, cost USD 0.005751345. Dispatch provider usage: Codex input 51,705, cache read 395,520, cache write 0, output 2,759; AGY input 214,504, cache read 140,758, cache write `unavailable`, output 1,239. Estimated `~` values are excluded. | `claude-result.json`; `sessions/20261021T1449Z-wordfrequency/diagnostics.md` |
| Repair attempts and admission defects | Three Dispatch attempts: one failed on a Windows long-path snapshot error; one failed on the same class of path error after scanning the first session; one completed plan and review but failed at `spawn ENAMETOOLONG` before writer launch. No code was written and no admission defect was recorded. Diagnostics record 4 accepted host retros and no rejected retros, separate from reviewer findings. The host used a process-only Git long-path environment workaround and reports manually force-removing a temporary integration worktree after checking its contents. | `claude-result.json`; `sessions/*/.state/runs/*/events.jsonl`; `sessions/*/diagnostics.md` |
| Review findings and adjudicated outcomes | Four unique plan-review findings, all `SHOULD`: 2 accepted/fixed and 2 rejected/closed. The walkthrough review log repeats these findings; counts here are deduplicated. | `sessions/20261021T1449Z-wordfrequency/add-a-wordfrequency-text-top-export-to-s.review-log.md`; walkthrough review log |
| Final verification outcome | Dispatch implementation failed before a writer started. Seed `npm test`: pass 5/5. Held-out acceptance: 4/4 failed (0 passed); all failures say `wordFrequency is not a function` or expected `RangeError` but received `TypeError`. Outer Claude CLI exit status was 0, but the harness result is failed because acceptance exit status was 1. | `run.json`; `claude-result.json`; `implement.verify.1/*.log`; `acceptance.json` |
| Coverage | Measured: phase times, reviewer invocations and external provider tokens, host Claude model usage, review outcomes, seed verification, and held-out acceptance. Partial/unavailable: no writer work or writer verification; no per-invocation native usage; AGY cache-write; changed-file word-count pair. | `run.json`; `claude-result.json`; session diagnostics; `acceptance.json` |

### stats-cli

| Field | Value | Source |
| --- | --- | --- |
| Run id and session directory | Harness task `stats-cli`; `run.json` has no separate opaque run ID. Retained Dispatch sessions: `20261021T1459Z-add-summarize-library-and-textstats-cli` and `20261021T1501Z-textstats`. | `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/baseline/stats-cli/run.json`; `sessions/*/manifest.json` |
| Instruction revision | Controller `v0.7.3`, commit `3d49b6ed41bb12705b8f49e92ebfa4be7c95dc31`; local config SHA-256 `ebf97fac458c0519c57360aeebb8c3e1480aa2b21c890c82362b92449f9bea1f`; host instruction and agent hashes are listed in Method. | `run.json`; Method |
| Task | `stats-cli`, size class `multi-module`; task prompt requests `summarize(text, { top })` and a `bin/textstats.js` CLI. | `docs/evaluations/samples/tasks.json` blob above; `run.json` |
| Model, effort, provider, concurrency, tooling | Host `claude-opus-5-5`, explicit level `medium`, host effort unavailable, permission `auto`; diagnostics on, write concurrency 3. Twelve external review launches: Codex `gpt-6.1-sol` low (6), AGY `gemini-3.8-flash` low (6); two native Claude `claude-haiku-5-5` high writer launches. Node `v24.19.0`, Claude Code `2.1.301`, Git `2.55.0.windows.4`, npm `11.17.0`, Windows. | `tasks.json`; `run.json`; `sessions/20261021T1501Z-textstats/diagnostics.md`; Method |
| Whitespace-delimited word counts | `unavailable` for changed instruction files: none changed. Baseline `SKILL.md`: 679 words; after count is not applicable because it was unchanged. | Tag command above; session manifests |
| Elapsed active time per phase | Four internal attempts in two sessions. Session 1459 run 1: implementation 40s, plan 55s, total 1m36s, user wait <1s. Session 1501 run 1: implementation 15s, plan 6s, total 22s, user wait <1s. Session 1501 run 2: implementation 2m4s, plan 1m10s, plan review 7m15s, total 10m31s, user wait 18s. Session 1501 run 3: implementation 6m8s, plan <1s, plan review 39s, code review 2m41s, total 9m30s, user wait 9s. Outer harness elapsed 24m7.423s. | `sessions/*/diagnostics.md`; `run.json` |
| Verification duration | Final `npm test` passed 28/28 in 1,960.7391ms. Held-out acceptance passed 3/3 in 535.9771ms. | `sessions/20261021T1501Z-textstats/.state/runs/003-implement/implement.verify.8/4.log`; `acceptance.json` |
| Invocation counts | Session 1459: 0 provider launches. Session 1501 run 1: 0. Run 2: 6 external plan-review launches. Run 3: 8 total launches (2 native Claude writers, 2 external plan reviewers, 4 external code reviewers). External totals: Codex 6, AGY 6; native writer invocations 2. | `sessions/*/diagnostics.md`; `sessions/20261021T1501Z-textstats/.state/runs/003-implement/events.jsonl` |
| Token subtotals | Host Claude usage: Opus input 184, cache read 9,807,145, cache creation 161,871, output 49,588, cost USD 4.248893; Haiku input 80, cache read 1,668,580, cache creation 210,014, output 57,901, cost USD 0.07189605. Dispatch provider usage: Codex input 172,588, cache read 882,304, cache write 0, output 6,331; AGY input 417,545, cache read 718,877, cache write `unavailable`, output 3,589. Native per-invocation usage and estimated `~` values are excluded. | `claude-result.json`; `sessions/20261021T1501Z-textstats/diagnostics.md` |
| Repair attempts and admission defects | Retained artifacts show three failed attempts before the fourth completed: a long-path snapshot error in session 1459; a `Filename too long` snapshot error and an `Invalid snapshot path` after integration checkout in session 1501 runs 1 and 2; session 1501 run 3 completed. No admission defect is recorded for the completed run. The host reports setting local Git `core.longpaths=true` and adding `.scratch/` to `.git/info/exclude` in the disposable sample repository; it says both were uncommitted and the working copies were cleaned. Host diagnostics record 4 accepted and 2 rejected retrospectives. The outer result's attempt count differs from the retained run directories; see Summary. | `claude-result.json`; `sessions/*/.state/runs/*/events.jsonl`; `sessions/*/diagnostics.md` |
| Review findings and adjudicated outcomes | Seven unique findings accepted/fixed and none rejected: 3 `MUST`, 4 `SHOULD`. They include six plan-review findings across three rounds and one code-review finding; the next code-review round and the final session's plan review had no findings. Walkthrough review log duplicates are excluded from the count. | `sessions/20261021T1501Z-textstats/add-summarize-text-top-in-src-summary-js.review-log.md`; walkthrough review log |
| Final verification outcome | Final mapped library and CLI tests passed; aggregate `npm test` passed 28/28. Held-out acceptance passed 3/3. Earlier baseline and RED checks include expected failures while the new files or implementation were absent; those are not final failures. Outer Claude CLI exit status was 0 and acceptance exit status was 0. | `run.json`; `sessions/20261021T1501Z-textstats/.state/runs/003-implement/implement.verify.8/*.log`; `acceptance.json` |
| Coverage | Measured: phase times, reviewer and native writer invocation counts, external provider tokens, host Claude model usage, review outcomes, final verification, and held-out acceptance. Partial/unavailable: no per-invocation native writer tokens; AGY cache-write; changed-file word-count pair. | `run.json`; `claude-result.json`; session diagnostics; `acceptance.json` |

## Harness coverage and operating limits

The `stats-cli` CLI oracle does not directly assert the `summarize` export. The acceptance process has no separate timeout after the host limit. A preparation failure may leave a temporary copy. The harness copies the current seed directory, so future runs must keep transient files out of that directory.

## Artifacts

All harness outputs and session evidence are retained under these repository-relative directories. The `baseline/launcher/` directory holds captured harness stdout and stderr for each task.

- `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/baseline/word-frequency/`
- `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/baseline/stats-cli/`
- `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/.state/scratch/evaluations/baseline/launcher/`
