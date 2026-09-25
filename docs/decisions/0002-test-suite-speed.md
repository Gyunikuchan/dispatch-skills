# ADR 0002: Test suite speed — cache git reads, keep subprocess tests

- **Status**: Accepted; option 2 implemented
- **Date**: 2026-09-26
- **Evidence**: a retrospective of the 36-minute `implement` run `bb936cef` (the gate-resolution and
  rebuttal-retry fixes), plus spawn traces and CPU profiles of `npm test` on Windows (16 logical
  cores, Node 24)

## Context

In the 36-minute run, the time went to:

| Bucket | Time |
|---|---|
| Two full `npm test` runs (baseline gate and final gate) | 10m41s (30%) |
| Three delegate review launches | 6m58s |
| Driver steps other than launches and verification | under 1 min |

The driver scripts are not slow in real runs: git reads on this repository take about 50 ms. The
cost is in the tests. `npm test` takes about 320 s of wall-clock time over 122 files. A trace of
every spawned process in the suite found:

- about 20,800 child processes, about 4,425 s of summed wait time;
- about 1,550 `dispatch.mjs` processes, because each driver-harness step spawns one;
- 15,784 git calls from the dispatch scripts themselves, 1,042 s in total, averaging 66 ms each
  under suite load (about 23 ms on an idle machine);
- 7,268 of those calls repeat a read already made in the same process with no git write in between
  (460 s). The repeats are mostly `rev-parse --show-toplevel` (2,707 calls in total) and
  `ls-files -v` plus `ls-files --stage` (1,577 calls each).

The machine is fully busy for the whole suite run. A driver test file that takes 75 s alone takes
about 210 s inside the suite, so wall-clock time follows total work, not the slowest file.

## Options considered

### 1. Split the slowest test files — rejected

Splitting the three slowest files (`ordinary-resume`, `ordinary-friction-scope`,
`ordinary-red-admission`, 208–225 s each) into ten files was implemented and measured:

| | Suite wall-clock time |
|---|---|
| Before | 317 s |
| After | 326 s |

The slowest-file position moved to other files (`scripted` 181 s, `ordinary-resume-bound` 175 s,
`red-ruling` 174 s). Splitting only helps when one file limits the run while cores sit idle; here
every core was already busy. The change was reverted.

A per-file `{ concurrency: true }` flag was also rejected. `drive()` and the fixtures call
`spawnSync` and `execFileSync`, which block the event loop, so tests in one file would still run
one after another.

### 2. Cache repeated git reads within a process — accepted

A driver step is one short-lived process. Changes made by subagents or the orchestrator happen
between steps, so a cache that lives only inside one process cannot go stale because of them. The
implementation:

- **`lib/git-root.mjs`**: `showToplevel` and `requireToplevel` replace seven scattered
  `rev-parse --show-toplevel` spawns and evidence's `--is-inside-work-tree` probe. Only successful
  lookups are cached: a work-tree root cannot move within a process, but a directory may become a
  repository. A source guard test keeps new `show-toplevel` spawns out of shipped scripts.
- **`indexEntries` in `lib/git-state.mjs`**:
  - One `ls-files -v --stage -z` call replaces the separate tag and stage listings. A test pins the
    result to the old two-call digest, so fingerprints stored in existing run state stay valid.
  - The result is cached against a SHA-256 hash of the index file's bytes. Any index write changes
    the hash, so the cache needs no invalidation calls at write sites, and forgetting one cannot cause
    a stale read. Reading and hashing the index costs far less than a git spawn. Code review rejected
    an earlier key of stat identity (inode, size, mtime, ctime): two rewrites within one timestamp
    tick can reuse an inode at an equal size and serve stale entries.
  - When `GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR` redirects Git, or in a
    linked work tree (`.git` is a file), the index is read without the cache.

`status`, `diff` and `hash-object` depend on the working tree, which the driver and verify commands
can change within a step. Caching them would require invalidation at every write site, for an
estimated 13 s more. They are left uncached.

Expected saving: about 18 s per suite run (≈271 s of repeated calls spread across ~15 parallel
workers), which is about 6% and roughly 40 s per dispatch session. The gain is small; it was
accepted because it is low-risk and needs no interface changes.

### 3. Run `drive` in-process in tests — rejected

Calling `drive()` directly would remove about 1,550 node process starts, the largest share of the
suite's wait time. It was rejected because it weakens what the tests prove:

- The command-line contract would no longer be tested: argument parsing, one compact JSON line on
  stdout, exit codes and stderr banners.
- Module-level state would carry over between steps and between tests. That can hide bugs where the
  driver relies on in-memory state instead of the durable state file.
- Per-step environment variables would have to be written into the shared `process.env`.
- `process.exit` calls and direct console output would have to become return values.
- A crash or hang would take down the whole test file instead of one child process with a timeout.

## Consequences

- New repository-root lookups use `lib/git-root.mjs`, which the source guard test enforces.
- New index reads go through `indexEntries`. The index cache must stay keyed on the index
  content hash; do not replace it with stat identity or explicit invalidation.
- The largest remaining savings are outside the tests:
  - skip the baseline full-suite gate when the working-tree content id (`contentTreeId`) matches
    the last green run of the same command (about 5 min per session);
  - or run the baseline suite in the background while the tests-only stage runs.
  Both change gate semantics and are not decided here.
