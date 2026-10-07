---
name: audit-dispatch-skills
description: Report-only static audit of Dispatch through scenario walkthroughs of each verb, shared handoff review, and bounded provider probes.
disable-model-invocation: true
metadata:
  internal: true
---

# Audit Dispatch Skills

A **report-only**, static audit of the `dispatch-skills` repository. Six scope auditors trace concrete scenarios (one per verb: `ask`, `design`, `plan`, `review`, `implement`; plus `shared` for cross-verb contracts) and return **claims**. You, the lead, own the baseline, scenario selection, scheduling, probe handles, verification, the report and finalization. Complete Dispatch flows are never executed; production diagnostics supply observed behavior. Fixes happen in a later task the user chooses.

**Objective**: a verified, self-contained report of where Dispatch fails to carry users to their intended outcomes, or does so at avoidable cost, with coverage and its gaps stated honestly.

Paths are relative to the repo root. `<run>` is the current local time as `yyyy-mm-dd-hhmm`, fixed once at the start. `<skill>` is the directory holding this `SKILL.md`:

| Host | `<skill>` | Backgrounding a command | Scope auditors |
|---|---|---|---|
| Antigravity | `.agents/skills/audit-dispatch-skills` | run the command with `&` | parallel subagents |
| Claude Code | `.claude/skills/audit-dispatch-skills` | Bash with `run_in_background: true` and `dangerouslyDisableSandbox: true` (Antigravity binds a local TCP socket) | `Agent` tool (`general-purpose`), one call per scope |
| Copilot | `.github/skills/audit-dispatch-skills` | run the command with `&` | sequential, in your own context |
| OpenCode | `.opencode/skill/audit-dispatch-skills` | run the command with `&` | `task` tool, one call per scope |
| Codex | `.agents/skills/audit-dispatch-skills` | start once and retain the command session handle | native subagents, one per scope |

**Containment**: every working file lives under `.scratch/audits/<run>-work/`; the report is `.scratch/audits/<run>-audit.md`. Step 7 relocates the work directory to OS temp. A run that stops early keeps it in place; resume with `--resume` and reuse every recorded artifact.

**Budgets**: `<skill>/config.json` holds the defaults; the run manifest (`<run>-work/manifest.json`) holds the effective limits and counters. You spend `leadInvestigationCalls` on verification (waits and report writing excluded) and `focusedReproductions` on single test files. Exhausting a budget makes the run **partial**; it never extends the budget.

## 1. Baseline

Write the objective and the independent expected outcome of each verb (from `AGENTS.md` and `skills/dispatch/SKILL.md`) into your notes before reading implementation; they are the yardstick for adjudication.

```bash
node <skill>/scripts/baseline.mjs --run <run>
```

Reserves the run, then writes the manifest, repo status and content snapshot, one aggregate `npm test` capture (`tests.txt`) and labeled metric leads (`metrics.md`). A failing test is audit evidence, not a stop. On resume pass `--resume`: a completed baseline is reused, never rerun.

**Done when:** the manifest records a complete baseline and the printed digest is noted for the report summary.

## 2. Select scenarios

Gather risk leads as JSON: changes since the last audit revision (or recent relevant commits, recording the range), unresolved defects from the previous report, and diagnostics. Then:

```bash
node <skill>/scripts/scenarios.ts --run <run> [--risk <leads.json>] [--prior <coverage.json>] [--scopes <ids>] [--scenarios <ids>]
```

It selects one scenario per mandatory class from [scenarios.json](references/scenarios.json), ranked explicit → risk → least-covered → stable ID, records the selection in the manifest and writes `<run>-work/packets/<scope>.json`. `--scopes`/`--scenarios` are for an explicit user narrowing only; the run is then partial. Every printed `gap:` line goes into the report's coverage section.

**Done when:** packets exist for every selected scope and the manifest records the selection.

## 3. Launch the provider probe

```bash
node <skill>/scripts/probe-dispatch.mjs --run <run> > .scratch/audits/<run>-work/probe-stdout.txt 2>&1
```

Run it **backgrounded** and keep its handle; the redirection is the only capture of its output. `--only a,b` narrows providers; `--discover-only` skips live prompts. The probe enforces its own launch, deadline and capture limits and records each provider's lifecycle in the manifest. Continue without waiting.

**Done when:** the probe is running and its handle is recorded.

## 4. Run scope auditors

Launch each scope as a fresh native agent that can write files, using available slots and reserving your own; queue the rest. No auditor launches further agents. Brief each one:

```
Audit scope <scope> of the dispatch-skills repo. Read <skill>/<packet.reference> and follow it.
Packet: .scratch/audits/<run>-work/packets/<scope>.json (scenarios, evidence, findings path).
Write only <packet.findingsPath>. Return terminal status, counts, gaps and the findings path.
```

Pass the packet only; leave your suspected findings and implementation excerpts out so traces stay independent. Record each handle and lifecycle in the manifest. On a host without native agents, run the scopes yourself one at a time and record `reduced independence: sequential lead execution` as a coverage gap.

When a scope returns, its file must exist and follow [findings.md](references/findings.md). A missing or malformed file gets **one** repair follow-up naming the defect; the shared scope's follow-up also carries any verb `Handoff` lines for its boundaries. After that, mark the scope `partial` with its gaps and verify late observations yourself rather than relaunching.

**Done when:** every scope has a terminal lifecycle (`complete`, `partial` or `failed`) in the manifest.

## 5. Verify

Wait for the probe: its manifest lifecycle is terminal (`complete`, `skipped`, `failed`, `timeout`); quote `probe-stdout.txt` for any `failed`. A failed or skipped provider never blocks static reporting; its cause goes into the platform section, and a reproducible adapter defect becomes a claim.

For every claim in every findings file:

1. **Dedupe** by root cause; keep every source scope and the highest severity the evidence supports.
2. **Verify** against the cited current source, the expected outcome from step 1 and counterevidence. Confirmed → `Verified`; contradicted → refuted with the evidence; settled only by an environment you lack, or by medium/low confidence that is not directly established → `Unverified` plus what would settle it.
3. Classify each as a **defect** or an **opportunity** per [findings.md](references/findings.md).

If `leadInvestigationCalls` runs out, name the remaining claims `Unverified` and the run partial.

**Done when:** every claim is `Verified`, `Unverified` or refuted, and every gap from steps 2–5 is listed.

## 6. Write the report

Write `.scratch/audits/<run>-audit.md` exactly as [report.md](references/report.md) defines: section order, the parsed findings grammar, the zero-defect sentinel, opportunities, coverage and budget evidence.

The run is **complete** only when the baseline and probe have terminal evidence, every scope finished `complete`, every claim is adjudicated, and no coverage gap remains; otherwise the summary says **partial** and names each gap.

**Done when:** the report satisfies report.md's completion criterion.

## 7. Finalize

```bash
node <skill>/scripts/finalize.mjs --run <run>
```

Run it only after every scope and the probe have stopped. It compares content fingerprints against the baseline, relocates the work directory to OS temp, and appends the authoritative path and integrity result to the report.

**Done when:** the integrity result is printed. `unchanged` closes the step. A `CHANGED` result closes it once every named file is attributed in the reply (an auditor write or concurrent user edit); an audit-attributable write is itself a finding. A failed relocation leaves the work directory authoritative; report its path.

## 8. Hand off

Reply with the report path, complete/partial status, defect counts by severity, the top five fixes, opportunity count, and the probe table. Offer to triage defects and opportunities through `audit-dispatch-skills-fix`; opportunity implementation requires the user's explicit selection and can share a coherent batch with related defects.

**Done when:** the reply is sent.
