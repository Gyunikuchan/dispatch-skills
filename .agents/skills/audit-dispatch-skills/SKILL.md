---
name: audit-dispatch-skills
description: Report-only audit of the dispatch-skills repository across skills, docs, scripts, tests, and live dispatch platforms.
disable-model-invocation: true
---

# Audit Dispatch Skills

A **report-only** audit of the `dispatch-skills` repository. The standard is `.agents/AGENTS.md`; skills are verified for behavioral flow, correctness, and goal fulfillment; agent-facing docs (`SKILL.md`, references, `AGENTS.md`) are also graded against `writing-for-agents`. Subagents gather raw **claims**; you verify them against the code and own the final report. Fixes happen in a later task the user chooses.

Paths are relative to the repo root. `<run>` is the current local time as `yyyy-mm-dd-hhmm`, fixed once at the start. `<skill>` is this skill's own directory, which differs per host:

| Host | `<skill>` | Backgrounding a command | Subagent mechanism |
|---|---|---|---|
| Antigravity | `.agents/skills/audit-dispatch-skills` | run the command with `&` | spawn parallel subagents |
| Claude Code | `.claude/skills/audit-dispatch-skills` | Bash with `run_in_background: true` and `dangerouslyDisableSandbox: true` (Antigravity binds a local TCP socket) | `Agent` tool, one call per scope |
| Copilot | `.github/skills/audit-dispatch-skills` | run the command with `&` | run scopes sequentially; Copilot has no subagent fan-out |
| OpenCode | `.opencode/skill/audit-dispatch-skills` | run the command with `&` | `task` tool, one call per scope |

If this skill was installed somewhere else, `<skill>` is wherever this `SKILL.md` lives. Where a host offers no parallel fan-out, run the scopes one after another — the report is identical, only slower.

**Containment**: every working file (baseline, probe captures, findings) lives under `.scratch/audits/<run>-work/`; the report is `.scratch/audits/<run>-audit.md`. Step 6 relocates the work directory to OS temp, leaving only the report in the repository. A run that stops early keeps it in place for resumption.

## 1. Baseline

```bash
node <skill>/scripts/baseline.mjs --run <run>
```

Writes to the work directory: `git-status.txt` (repo snapshot, audit output excluded), `tests.txt` (full suite with coverage, no hash write), and `metrics.md` (doc token footprint, broken links/anchors, script structure, exports no test names, test counts, hash drift). Prints a digest; a failing test is audit evidence, not a stop.

**Done when:** the three files exist and the printed digest is noted for the report summary.

## 2. Launch the dispatch probe

```bash
node <skill>/scripts/probe-dispatch.mjs --run <run>
```

Run it **backgrounded** (live prompts take minutes) — see the per-host table above. Discovery is token-free across every provider mode; each reachable provider then gets a read probe (`-f` file from a temp dir under the home directory, plus an un-attached sibling file the delegate must read itself) and a denylist probe. The temp dir is removed when the probe exits. Add `--modes` when the user asks for per-mode coverage: one live target per distinct binary through the provider runner. `--only claude,agy` narrows the whole re-run: an excluded provider is neither discovered nor probed, so it costs nothing and gets no row.

Continue to step 3 without waiting.

**Done when:** the probe is running in the background.

## 3. Fan out subagents

Scopes, derived from the tree rather than assumed:

- one **deep** scope per directory in `skills/` and per repo-authored skill in `.agents/skills/` (real directories not listed in `skills-lock.json`), scope id = skill name;
- one **broad** scope, scope id `broad`.

Spawn every scope in a single message so they run in parallel, as native subagents that can write files (Claude Code: `Agent` with `general-purpose`). Brief each one:

```
Audit <scope path> in the dispatch-skills repo. Read <skill>/references/<deep|broad>.md and follow it.
Work dir: .scratch/audits/<run>-work (baseline evidence: metrics.md, tests.txt).
Write findings to .scratch/audits/<run>-work/findings/<scope-id>.md; write nothing anywhere else.
Return only: finding counts by severity and the findings path.
```

**Done when:** every scope subagent has completed execution, returned its final response, and its findings file exists; re-spawn any scope whose file is missing or lacks an axis coverage table.

## 4. Synthesize

Read every findings file and `<run>-work/dispatch/summary.md` (wait for all subagents and the background probe to finish first). If `summary.md` is missing, the probe crashed: report `probe crashed: <message from probe output>` in the dispatch-platforms section.

1. **Dedupe**: merge findings that name the same defect — same location, or one root cause across locations. Keep every source scope and the highest severity the evidence supports.
2. **Verify** each merged finding by opening its cited locations. Confirmed → `Verified`. Contradicted by the code → refuted, moved to the appendix with the reason. Settled only by a run you cannot do here (another OS, a missing CLI) → `Unverified` plus what would settle it. Evidence decides, not how many scopes raised it.
3. **Probe failures**: for each `FAIL` target, read its `*.read.stderr.txt` and session log to name the cause (auth, quota, sandbox, runner bug). A runner bug becomes a finding; an environment gap (not logged in, CLI absent) is reported in the platform section only.

**Done when:** every finding from every file is `Verified`, `Unverified`, or refuted — none unread.

## 5. Write the report

`.scratch/audits/<run>-audit.md` is self-contained — it quotes what it needs from the work directory rather than linking there. In this order:

1. **Summary**: severity counts, top five fixes by impact, test totals, one-line probe verdict.
2. **Dispatch platforms**: discovery table, not-found list, live-probe table (copied from `<run>-work/dispatch/summary.md`), cause of each failure.
3. **Findings** grouped critical → nit under a `### <Severity>` heading per group. IDs renumbered `A-<n>`. `audit-dispatch-skills-fix` parses this section, so each finding takes exactly this shape:

   ```md
   #### A-<n>: <one-line title>
   - **<severity>** · <axis> · <Verified|Unverified> · <source scope ids>
   - **Status**: open
   - **Location**: `path:line` (comma-separated when several)
   - **Claim**: …
   - **Evidence**: …
   - **Proposal**: …
   ```

   Any legend above the findings names the meta line's third field **Verification**, not "Status", which belongs to the fix line alone. Headings stay `####` (severity groups `###`), the meta line stays a single bullet in that order, and the section heading stays `## 3. Findings` followed by a numbered `## 4.` section. `- **Status**: open` is the fix run's state slot — `audit-dispatch-skills-fix` rewrites that one line per finding and keeps a counts blockquote under the section heading; the report stays the only state file.
4. **Axis coverage**: scope × axis matrix (`✓` checked, `—` n/a with reason, `✗` gap). Any `✗` is named in the summary.
5. **Proposed axes & metrics**: merged from the subagents plus your own.
6. **Appendix**: refuted claims with reasons.

**Done when:** the report is written.

## 6. Finalize

```bash
node <skill>/scripts/finalize.mjs --run <run>
```

Compares the repo against the work directory's `git-status.txt`, moves `.scratch/audits/<run>-work/` to an `audit-dispatch-skills-<run>-*` directory in OS temp, and appends the relocation path and integrity result to the report.

**Done when:** the script has printed its integrity result and `.scratch/audits/` holds only `<run>-audit.md` for this run. `unchanged` closes the step. A `CHANGED` result also closes it, but only once every file it names is attributed in the reply (a subagent write or concurrent user edits) — a repo-modifying audit is itself a finding.

## 7. Hand off

Reply with the report path, severity counts, the top five fixes, and the probe table. Offer to act on the findings through `audit-dispatch-skills-fix`.

**Done when:** the reply is sent with the report path, severity counts, top five fixes, probe table, and offer to act.
