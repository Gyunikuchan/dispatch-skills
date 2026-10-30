---
name: optimise-tests
description: Measure this repository's test suite, refactor it unit by unit with parallel scoped writers, and report measured runtime and leaf-test reductions under the high-value test bar.
disable-model-invocation: true
metadata:
  internal: true
---

# Optimise Tests

You, the lead, make the `tests/` suite faster and higher-signal while preserving required behavior and baseline failures. Deterministic scripts measure; native writers refactor one unit each and provide positive retention and action evidence; you own the baseline, scheduling, checks, the move pass, the gate and the handoff.

**Objective**: fewer reported leaf tests and lower suite wall time, with a green suite and durable tests that meet the [high-value bar](../../../skills/dispatch/references/templates/quality-bar.md#code). Coverage is informational implementation feedback. Report measured leaf-test and suite-duration deltas separately from ledger-derived scenario, case, and setup savings. Report unmet objectives explicitly.

Paths are relative to the repo root. `<run>` is the current local time as `yyyy-mm-dd-hhmm`, fixed once at the start; `<work>` is `.scratch/optimise-tests/<run>`. `<skill>` is the directory holding this `SKILL.md`:

| Host | `<skill>` | Unit writers |
|---|---|---|
| Antigravity | `.agents/skills/optimise-tests` | parallel subagents |
| Claude Code | `.claude/skills/optimise-tests` | `Agent` tool (`general-purpose`), one call per packet |
| Copilot | `.github/skills/optimise-tests` | sequential, in your own context |
| OpenCode | `.opencode/skill/optimise-tests` | `task` tool, one call per packet |
| Codex | `.agents/skills/optimise-tests` | native subagents, one per packet |

[config.json](config.json) holds the units (test folders, in run order), `packetLineBudget`, `slowTestMs`, `maxParallelWriters`, `coverageInclude` and `excludeFromWriters`. A unit id is its folder path (for example `tests/unit/policy`) and is the value `--units` accepts.

**Ownership**: each writer owns the files of one packet, inside one unit folder. Paths matching `excludeFromWriters` (shared helpers and fixtures) and every other folder are lead-owned; writers report needed changes there to the lead. Writers never run git write commands.

## 1. Baseline

Check that `git status --porcelain` lists no changes under `tests/`, `skills/`, `scripts/` or `<skill>/scripts/`; a dirty tree makes the deltas unattributable, so ask the user to commit or stash first. Save `git status --porcelain` to `<work>/baseline-status.txt`; check 1 in step 3 preserves every path it lists. Then run the full suite once:

```bash
node <skill>/scripts/inventory.ts --out <work>/before --coverage
```

It writes `<work>/before/inventory.json` (`totals`, `files`, `coverage`, `candidates`, `failures`), `<work>/before/events.jsonl`, and one packet per unit at `<work>/before/packets/<id>.json`. The id is the unit path with `/` replaced by `-` (`tests-unit-policy`); a unit over `packetLineBudget` splits into `<id>-1`, `<id>-2`, … by file-name prefix cluster. Packet candidates surface duplicate titles, shared imports, merge clusters, budget overruns (`budgetOverruns`), and dense files (`denseFiles`). Recorded `failures` are a red baseline: note each one and leave those tests unchanged; report any proposed action on them as a blocker for lead review.

**Done when:** `inventory.json` exists with nonzero `totals.tests`, a nonempty `coverage` map, and a packet for every configured unit.

## 2. Run unit writers

Launch one native writer per packet, in parallel, at most `maxParallelWriters` at once; queue the rest and start the next as each returns. On a host without native subagents, process packets one at a time yourself. Brief each writer:

```
Optimise packet <id> of the dispatch-skills test suite. Read <skill>/references/criteria.md and follow it.
Mandate: aggressively prune low-signal tests under the high-value test bar. Challenge every test's right to exist. Delete or merge any test that cannot defend a plausible severe defect distinct from static types or adjacent tests.
Packet: <work>/before/packets/<id>.json. Inspect candidate telemetry (budgetOverruns, denseFiles, slowestTests) to target slow and test-dense files for pruning, consolidation, or splitting.
Scope: you own only the packet's files in <unit>. <new-files>
Verify: the focused Node test command from AGENTS.md § Verification Details over the files you own.
Ledger: append complete action and retained-scenario JSON records to <work>/ledger/<id>.jsonl. Classify every baseline test. The lead owns optional savings records after the full after snapshot.
Never run git write commands. Return only completion (ledger path, verify result, any lead-owned request) or a blocker.
```

Set `<new-files>` to "Single-packet unit: you may add new test files in <unit> to split dense or slow files in-place." when the unit has one packet. When a unit is split into several packets, set it to "Multi-packet unit: do not create files; propose required `move` or `split` actions with explicit before and intended after references in the ledger for the lead." so parallel writers never pick the same new path.

Pass the packet only; leave your own suspicions out so each writer judges its tests from the evidence. Writer questions about intent (a test may be the only evidence of a documented contract) go to the user; keep the other writers running meanwhile.

**Done when:** every packet's writer has returned completion or a blocker, and every blocker is resolved or recorded for the handoff.

## 3. Check each unit

As each writer returns, run checks 2 and 3a for its packet. Run check 3b for a unit once all of its writers have returned, and check 1 once every writer has returned, so no in-flight writer's edits are judged:

1. Compare `git status --porcelain` against the union of all packets' owned paths (packet files, plus new files created in single-packet units). Ignore paths listed in `<work>/baseline-status.txt` and under `.scratch/`. Revert a remaining changed path under `tests/` that no packet owns, and record it as a rejected edit. Report any other remaining changed path to the user instead of reverting it, since a shared tree gives no per-writer attribution; never revert another packet's owned path.
2. Check its evidence against [criteria.md](references/criteria.md): every baseline test has an action or positive retain record; records are structurally complete; and duplicate or hollow deletion claims have the required evidence. Check same-defect claims against the named surviving tests. Resolve after references against the full after inventory in step 5. Return incomplete or unsupported evidence to the writer. An uncertain required contract stays unchanged and remains a blocker outside the gate ledger.
3. Run the focused command from `AGENTS.md` § Verification Details:
   a. Over the returning packet's owned files (including any in-place split files created by single-packet writers). If red, send the failing output back to that writer once; if still red, restore only that packet's failing files and record the gap.
   b. Over the whole unit, after all its writers return. If red, attribute each failing file to its owning packet and handle it as in 3a.

**Done when:** every unit's 3b run is green, and every rejected or restored change is recorded.

## 4. Move pass

After all units pass step 3, apply ledger `move` actions and multi-packet `split` actions serially as lead-owned work. Move or split tests to match their after references, update imports, and remove superseded source tests. Single-packet writers already split files directly in Step 2; multi-packet writers propose moves and splits in their ledger while leaving files in place. Apply helper and fixture requests as lead-owned work. Run the focused command over every file touched, then confirm each after reference against the final inventory.

**Done when:** every `move`, multi-packet `split`, and lead-owned request is applied or declined with a recorded reason, its evidence matches the resulting tests, and the touched files are green.

## 5. Gate

Run the full suite again; a partial `--units` run cannot serve as the after snapshot, because files it skips read as zero covered lines:

```bash
node <skill>/scripts/inventory.ts --out <work>/after --coverage
node <skill>/scripts/compare.ts <work>/before/inventory.json <work>/after/inventory.json --ledger <work>/ledger > <work>/compare.md
npm test
```

The comparison validates complete action and retention evidence and reports after-run failures. Review retained scenarios against the high-value bar and check same-defect claims against the named survivors. Coverage changes, including zero or missing metrics, are informational and require no disposition, digest binding or approval. Missing classifications, malformed records, unknown kinds and invalid evidence fail the gate even when coverage holds.

The report measures reported leaf-test counts and suite wall-clock duration. Add at most one optional `savings` record for ledger-derived scenarios, cases, cosmetic table merges, or reduced repeated setup calls, with concrete evidence. `compare.md` labels these separately from measured totals; unreported quantities remain unmeasured. A table merge that retains all cases is cosmetic, not removed work. Preserve configured concurrency and timing budgets.

**Done when:** `compare.ts` exits 0 and `npm test` passes, both after the last change.

## 6. Hand off

Reply in the handoff format of `AGENTS.md` § Long-Running Work and Handoff. Report measured leaf-test and suite-duration deltas against the baseline; if an objective was not met, say so. Keep these results separate from ledger-derived scenario, case, cosmetic-merge, and setup claims. Include `<work>/compare.md`, ledger paths, counts of deleted, merged, moved, and restored tests, informational coverage changes, plus every rejected edit and unresolved blocker.

**Done when:** the reply is sent.
