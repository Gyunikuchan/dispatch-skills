---
name: audit-dispatch-skills-fix
description: Verify and fix the open findings of the latest audit-dispatch-skills report, batch by batch, through implement-dispatch.
disable-model-invocation: true
metadata:
  internal: true
---

# Audit Dispatch Skills Fix

Closes out an `audit-dispatch-skills` report. The report holds **claims** that were verified against the code at audit time; you re-verify each one against the code as it is **now**, drop the false positives, surface what needs the user's call, and fix the rest in batches through `implement-dispatch`.

The report **is** the state of the run, not the conversation: each finding carries a `- **Status**: open | fixed | false-positive | decision | deferred` line that `<skill>/scripts/status.mjs` reads and rewrites in place. There is no second state file. A run that stops anywhere resumes from the report.

Paths are relative to the repo root. Findings are cited by ID (`A-7`), never by pasted body. `<skill>` is this skill's own directory, which differs per host:

| Host | `<skill>` |
|---|---|
| Antigravity | `.agents/skills/audit-dispatch-skills-fix` |
| Claude Code | `.claude/skills/audit-dispatch-skills-fix` |
| Copilot | `.github/skills/audit-dispatch-skills-fix` |
| OpenCode | `.opencode/skill/audit-dispatch-skills-fix` |

If this skill was installed somewhere else, `<skill>` is wherever this `SKILL.md` lives.

## 1. Open the report

```bash
node <skill>/scripts/status.mjs init
```

Targets the newest `.scratch/audits/<run>-audit.md` (`--run <yyyy-mm-dd-hhmm>` targets an older one), backfills `- **Status**: open` on any finding written without one, and refreshes the counts blockquote under `## 3. Findings`. Re-running it keeps every status and note already recorded, so use it to refresh after the report is edited by hand.

It reads the findings section in the shape `audit-dispatch-skills` § "5. Write the report" fixes, and errors out rather than writing a status line into a report that has drifted from it. On that error, repair the report's finding headings and meta lines first.

Confirm with the user which run you are working if the printed path is not the one they named.

**Done when:** the printed total matches the report's finding count and the counts line is in the report.

## 2. Triage the next batch

```bash
node <skill>/scripts/status.mjs batch
```

Prints the next open findings — highest severity first, grouped by the file they touch — with full Location / Claim / Evidence / Proposal. Sized dynamically based on the 5-batch target (`ceil(total / 5)`), lead finding severity, and lead-file cluster size (keeping same-file clusters intact up to 25; override with `--size <n>` or `--batches <n>`): the group sharing the highest-severity finding's file leads, and the rest of the open pool tops it up in rank order. For **each** finding in the batch, open the cited locations and decide:

| Verdict | Action |
|---|---|
| The code still matches the claim | leave `open` — it goes into step 3 |
| The code contradicts the claim, or a later commit already fixed it | `set <id> false-positive --note "<the contradicting line or commit>"` |
| The proposal is one of several defensible designs, changes a public interface, adds a dependency, or trades off against a pillar in `AGENTS.md` | `set <id> decision --note "<the question, and your recommendation>"` |
| Real, but out of this run's scope (needs another OS, another repo, a CLI you cannot reach) | `set <id> deferred --note "<what would settle it>"` |

A finding whose note begins `dispatched` was handed to `implement-dispatch` by an earlier run that did not get to record the result. Check the cited location against the tree before re-dispatching it — the fix may already be there.

```bash
node <skill>/scripts/status.mjs set A-7 false-positive --note "SKILL.md:90 already reads `git status --short` (fixed in e2eafb6)"
```

If the batch produced any `decision` findings, put them to the user as **one** question — never one per finding — and stop there. Their answers change what step 3 fixes, so step 3 waits; record each answer with `set <id> open` (proceed) or `set <id> deferred` (drop) before continuing.

**Done when:** every finding in the batch has been opened at its cited location and carries a verdict in its `Status` line, and either no `decision` findings remain or the user has answered the one question they were asked.

## 3. Fix the batch

If no finding in the batch is still `open` — all triaged to `false-positive`, `deferred` or `decision` — skip this step entirely and go to step 4; never invoke `implement-dispatch` with an empty list.

First mark the batch, so an interruption between here and step 4 is recoverable:

```bash
node <skill>/scripts/status.mjs set A-3 open --note "dispatched <run or batch label>"
```

Without it the batch has no identity in the report between dispatch and step 4's `set … fixed`: a run interrupted in that window makes step 2's `batch` reprint the already-fixed findings byte-identically, and the work gets dispatched twice.

Then hand the still-`open` findings of this batch to `implement-dispatch`, quoting each finding's ID, Location, Claim and Proposal in the ask, plus the shared success criteria: the proposal's tests exist and fail before the fix, `npm test` passes after, and the invariants in `AGENTS.md` (dependency flow, structural least privilege, cross-platform, context hygiene) hold.

```
/implement-dispatch <level>: Fix audit findings A-3, A-12, A-14 from .scratch/audits/<run>-audit.md
```

Pick `<level>` from the batch: `low` for a single mechanical edit, `medium` by default, `high` for a fix that crosses runners, skills or platforms, `xhigh` for a batch that changes a shared schema or the dispatch contract itself.

The report is state, not a work product: `implement-dispatch` fixes the repository and never edits the report — every status change goes through `status.mjs set`. A finding whose fix it refutes during its own plan review goes back to step 2's table as `false-positive`, with the reviewing agent's reason in the note.

**Done when:** `implement-dispatch` reports consensus and `npm test` passes (`npm run hashes` first if it reports hash drift).

## 4. Record and loop

```bash
node <skill>/scripts/status.mjs set A-3 fixed --note "<commit or one-line summary>"
node <skill>/scripts/status.mjs list --status open
```

Return to step 2 while any finding is `open`. Statuses land in the report per finding as each one is settled, so an interrupted run never loses the batch.

**Done when:** `list --status open` prints `No open findings.` and no finding rows. (It always writes a `<n> of <total> findings listed.` tally to stderr, which most hosts merge into the same output — so "prints nothing" is never literally true.)

## 5. Hand off

Reply with the report path and, in this order: counts by status (the blockquote under `## 3. Findings`); the `decision` findings with your recommendation for each; the `deferred` findings with what would settle them; the `false-positive` findings with the contradicting evidence in one line each; and the test result.

**Done when:** the reply carries all five, and every `decision` finding is either answered by the user (then fixed through step 3) or named as still awaiting their call.
