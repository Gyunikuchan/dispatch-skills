---
name: optimise-tests
description: Measure this repository's test suite, refactor it unit by unit with parallel scoped writers, and prove no coverage loss with a runtime and test-count delta.
disable-model-invocation: true
metadata:
  internal: true
---

# Optimise Tests

You, the lead, make the `tests/` suite of this repository faster and higher-signal without losing coverage. Deterministic scripts measure; native writers refactor one unit each; you own the baseline, scheduling, checks, the move pass, the gate and the handoff.

**Objective**: a green suite with no production file losing covered lines, fewer low-signal tests, and a measured runtime and test-count reduction, with a ledger entry for every pruned, merged or moved test.

Paths are relative to the repo root. `<run>` is the current local time as `yyyy-mm-dd-hhmm`, fixed once at the start; `<work>` is `.scratch/optimise-tests/<run>`. `<skill>` is the directory holding this `SKILL.md`:

| Host | `<skill>` | Unit writers |
|---|---|---|
| Antigravity | `.agents/skills/optimise-tests` | parallel subagents |
| Claude Code | `.claude/skills/optimise-tests` | `Agent` tool (`general-purpose`), one call per packet |
| Copilot | `.github/skills/optimise-tests` | sequential, in your own context |
| OpenCode | `.opencode/skill/optimise-tests` | `task` tool, one call per packet |
| Codex | `.agents/skills/optimise-tests` | native subagents, one per packet |

[config.json](config.json) holds the units (test folders, in run order), `packetLineBudget`, `slowTestMs`, `maxParallelWriters`, `coverageInclude` and `excludeFromWriters`. A unit id is its folder path (for example `tests/unit/policy`) and is the value `--units` accepts.

**Ownership**: each writer owns the files of one packet, inside one unit folder. Paths matching `excludeFromWriters` (shared helpers and fixtures) and every other folder are lead-owned; writers request changes there through the ledger. Writers never run git write commands.

## 1. Baseline

Check that `git status --porcelain` lists no changes under `tests/`, `skills/`, `scripts/` or `<skill>/scripts/`; a dirty tree makes the deltas unattributable, so ask the user to commit or stash first. Save `git status --porcelain` to `<work>/baseline-status.txt`; check 1 in step 3 preserves every path it lists. Then run the full suite once:

```bash
node <skill>/scripts/inventory.ts --out <work>/before --coverage
```

It writes `<work>/before/inventory.json` (`totals`, `files`, `coverage`, `candidates`, `failures`), `<work>/before/events.jsonl`, and one packet per unit at `<work>/before/packets/<id>.json`. The id is the unit path with `/` replaced by `-` (`tests-unit-policy`); a unit over `packetLineBudget` splits into `<id>-1`, `<id>-2`, … by file-name prefix cluster. Recorded `failures` are a red baseline: note each one; writers leave failing tests unchanged unless the ledger proves the failure is the defect being removed.

**Done when:** `inventory.json` exists with nonzero `totals.tests`, a nonempty `coverage` map, and a packet for every configured unit.

## 2. Run unit writers

Launch one native writer per packet, in parallel, at most `maxParallelWriters` at once; queue the rest and start the next as each returns. On a host without native subagents, process packets one at a time yourself. Brief each writer:

```
Optimise packet <id> of the dispatch-skills test suite. Read <skill>/references/criteria.md and follow it.
Packet: <work>/before/packets/<id>.json. You own only the packet's files in <unit>. <new-files>
Verify: the focused Node test command from .claude/CLAUDE.md § Verification Details over the files you own.
Ledger: append one JSON line per action to <work>/ledger/<id>.jsonl.
Never run git write commands. Return only completion (ledger path, verify result) or a blocker.
```

Set `<new-files>` to "You may add new test files in <unit>." when the unit has one packet. When a unit is split into several packets, set it to "Do not create files; record new-file splits as ledger `move` lines." so parallel writers never pick the same new path.

Pass the packet only; leave your own suspicions out so each writer judges its tests from the evidence. Writer questions about intent (a test may be the only evidence of a documented contract) go to the user; keep the other writers running meanwhile.

**Done when:** every packet's writer has returned completion or a blocker, and every blocker is resolved or recorded for the handoff.

## 3. Check each unit

As each writer returns, run checks 2 and 3a for its packet. Run check 3b for a unit once all of its writers have returned, and check 1 once every writer has returned, so no in-flight writer's edits are judged:

1. Compare `git status --porcelain` against the union of all packets' owned paths (packet files, plus new files in single-packet units). Ignore paths listed in `<work>/baseline-status.txt` and under `.scratch/`. Revert a remaining changed path under `tests/` that no packet owns, and record it as a rejected edit. Report any other remaining changed path to the user instead of reverting it, since a shared tree gives no per-writer attribution; never revert another packet's owned path.
2. Check its ledger: each `delete` or `merge` line carries `coveredBy` or `reason` per [criteria.md](references/criteria.md); remove the change for any line that does not.
3. Run the focused command from `.claude/CLAUDE.md` § Verification Details:
   a. Over the returning packet's owned files. If red, send the failing output back to that writer once; if still red, restore only that packet's failing files and record the gap.
   b. Over the whole unit, after all its writers return. If red, attribute each failing file to its owning packet and handle it as in 3a.

**Done when:** every unit's 3b run is green, and every rejected or restored change is recorded.

## 4. Move pass

After all units pass step 3, apply ledger lines with `action: "move"` serially, yourself or through one writer: move the test to its `moveTo` file, update its imports, and delete the source test. Then apply the lead-owned requests (helper or fixture changes) the same way. Run the focused command over every file touched.

**Done when:** every `move` and lead-owned request is applied or declined with a recorded reason, and the touched files are green.

## 5. Gate

Run the full suite again; a partial `--units` run cannot serve as the after snapshot, because files it skips read as zero covered lines:

```bash
node <skill>/scripts/inventory.ts --out <work>/after --coverage
node <skill>/scripts/compare.ts <work>/before/inventory.json <work>/after/inventory.json > <work>/compare.md
npm test
```

`compare.ts` exits 1 and lists each production file whose covered lines dropped (a missing file counts as zero) and each after-run failure. For each drop, find the ledger line that removed the covering test, then restore or rewrite that test, and rerun the gate from the first command.

**Done when:** `compare.ts` exits 0 and `npm test` passes, both after the last change.

## 6. Hand off

Reply in the handoff format of `.claude/CLAUDE.md` § Long-Running Work and Handoff. State whether the test count and suite duration each decreased versus the baseline; if either did not, report it as an unmet objective, not a successful optimisation. Include the `<work>/compare.md` table, the ledger paths, the counts of deleted, merged, moved and restored tests, and every rejected edit, blocker and unresolved intent question.

**Done when:** the reply is sent.
