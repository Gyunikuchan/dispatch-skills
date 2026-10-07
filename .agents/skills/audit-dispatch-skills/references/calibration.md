# Calibration

Read this only when asked to calibrate the audit or accept an audit-brief rewrite. Calibration measures whether the briefs find real defects without condemning intended behavior. It is a separate, static run on six curated cases, not a Dispatch audit and not a live Dispatch flow.

**Objective**: for each arm (`old` = audit briefs at the recorded baseline commit, `new` = current briefs), fixed claims for all six cases in `<skill>/fixtures/calibration/cases.json`, scored by root cause against the answer keys, with usage reported as measured or unavailable.

## Scope overrides

In both arms, calibration scope replaces the brief's ordinary scope:

- Audit only the assigned case packet: its scenario and excerpts, plus repository files at the excerpt's `commit` when a contract needs one more dependency. Ignore directory, whole-audit, baseline, scenario-selection and report steps in either brief.
- Never run provider probes, `dispatch.ts start`/`send`, nested auditors, or tests. A packet whose `constraints` you cannot honor is a failed case, not a reason to widen scope.
- Never read the fixture, `git log`/`git show` of later commits, or the fix commit. File access cannot enforce this; record any exposure in the case output rather than claiming blinding.

Old-arm adaptation: give the old auditor every path in `briefs.old` from the baseline (`git show <briefs.old.commit>:<path>`; blobs are in the packet; `broad.md` and `deep.md` were removed later), with the overrides above. This is a scoped comparison, not a full old-audit benchmark; say so in the report.

## Steps

1. **Expected outcomes first.** Before opening any packet, write each verb's independent expected outcome (from `AGENTS.md` and `skills/dispatch/SKILL.md`) into your notes.
2. **Prepare.** Requires a reserved run (`baseline.mjs --run <run>`).

   ```bash
   node <skill>/scripts/calibrate.ts prepare --run <run> --host <host> --model <model> --effort <effort>
   ```

   Writes `calibration/packets/<arm>/<case>.json` and `calibration/manifest.json` under the work directory. Packets withhold kind, category, severity, answer key and fix commit. Use the same host, model and effort for every case in both arms.
3. **Run each case once per arm** in a fresh native subagent context: give it one bundled file holding the arm's brief, the packet path, and the scope overrides. Require it to read the bundle first and to start its reply with a `BRIEF:` line naming the brief checks it applied; rerun a case whose reply lacks that line, because auditors otherwise skip the brief and the arms stop differing in method. It returns claims, each `{id, verdict: defect|opportunity|none, claim, evidence}`; `evidence` is the static trace (file:line steps) or deterministic check supporting a `defect`. Store raw output under `calibration/raw/<arm>/<case>.md` and record its usage (input/output tokens, tool calls, wall seconds) or `null` when the host does not expose a metric.
4. **Fix claims before reveal.** Packets carry opaque ids; map each back through `manifest.json` `packetIds`. Write `calibration/claims/<arm>.json` as `{arm, cases: {<case id>: Claim[]}}` with every case present, then:

   ```bash
   node <skill>/scripts/calibrate.ts fix --run <run> --arm <old|new>
   ```

   Do not open `cases.json` answer keys until both arms are fixed. Editing claims afterwards makes summarize refuse.
5. **Adjudicate by root cause.** Now read the answer keys. For each defect case and arm, set `match` to the claim id whose cause and consequence match `rootCause`, regardless of wording, with a one-line `rationale`; otherwise `match: null`. Match a `defect` claim, or for an `efficiency` case also an `opportunity` claim, since the briefs keep unmeasured repetition an opportunity. A claim that names the right file but a different cause is a miss. Write `{arms: {old: {...}, new: {...}}}` to `calibration/adjudication.json` and usage to `calibration/usage.json` as `{old: {...}, new: {...}}`.
6. **Summarize.**

   ```bash
   node <skill>/scripts/calibrate.ts summarize --run <run> --adjudication <work>/calibration/adjudication.json --usage <work>/calibration/usage.json
   ```

   Writes `calibration/summary.json`. Any `defect` claim on a control is a false defect; a `defect` claim without evidence is unsupported.
7. **Provider smoke.** Separately, run one bounded probe per the main skill's probe step (`probe-dispatch.mjs`). Record each provider as passed, failed or skipped with its cause.

## Acceptance (C7)

The `new` arm passes only when it recovers at least three of four defects, misses no high/critical defect, verifies no defect against either control, has results for all six cases, and every `defect` claim is supported. `summary.pass` reflects the `new` arm; `old` is comparison only.

On failure, record it and revise the briefs within the bounded work; never relabel, swap or drop cases. Any rerun needs a recorded rationale and remaining budget. Six cases support calibration, not statistical reliability claims.

## Report

Write `calibration/report.md` in the work directory with: settings; per-arm recovered, missed, false defects, unsupported claims and missing cases; old/new useful verified findings; usage per arm with every `unavailable` metric named and no savings stated for those metrics; scope adaptations and answer-exposure notes; provider smoke results with skip/failure causes. Do not claim calibration succeeded without these recorded results.
