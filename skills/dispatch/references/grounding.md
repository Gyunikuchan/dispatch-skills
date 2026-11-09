# Grounding

Initial grounding is required for every new spec, regardless of question size. Follow the [scope round](#scope-round) rule. Ground each design increment before authoring its plan ([design increments](#design-increments)). Also ground before `ask` when understanding needs many files read.

Grounding maps the landscape around the planned decision (constraints, consumers, reuse candidates, parallel implementations, conventions and precedent) so that grilling, design and planning do not miss load-bearing details.

## Launch

Run `doctor run --host <platform>` without `--level` and launch every map explorer on the [`brief explorer`](toolkit.md#brief-explorer) result, including scope round, design increment, retry and replacement. General explorer use follows [routing](../SKILL.md#routing). Send the explorer the question-driven [explorer brief](templates/explorer-brief.md), whose per-map budget the toolkit renders from `DEFAULT_MAP_BUDGET`. Render it with the [`brief explorer`](toolkit.md#brief-explorer) action from a values file holding `objective`, `questions`, and `outputPath`. Launch one map explorer per grounding phase. The brief sets no search direction; its Coverage checklist is the completeness contract. You may launch research explorers in parallel, one per independent topic, alongside the map explorer when the [context guard](../SKILL.md#context-guard) warrants it; each replies inline with cited sources and writes no map. Follow [native slot rules](providers.md#native-slots) and [launch and continue](../SKILL.md#launch-and-continue). Launch the map explorer on an agent type that can write files.

## Scope round

After `confirm` and before authoring a standalone plan or any design, ground the confirmed scope with the same launch, explorer brief and Coverage checklist. Start with questions from the confirmed spec's REQs and DECs, then add any related or unrelated question the orchestrator needs to plan or design. Give the explorer the governing spec path and its `<session>/<slug>.spec.context.md` map path. Continue the live explorer when the host can; otherwise launch a fresh one with both paths. If the spec-phase map does not exist, ground from the spec alone.

At pre-spec capture time, resolve any symlinked cited path with `realpath` and require the result inside the repository root, for example `.claude/CLAUDE.md` -> `AGENTS.md`. When inspecting a cited path against `Commit: <sha>`, check both the cited path and its resolved target path: `git ls-tree <sha> -- <path>` lists the path and `git diff --name-only <sha> -- <path>` is empty. Mark any untracked, ignored, out-of-repository symlink or dirty cited path `(uncommitted)` in `<slug>.spec.context.md`.

The Scope Round explorer carries forward an entry from `<session>/<slug>.spec.context.md` without re-reading it only when it meets the [explorer brief's scope-round rule](templates/explorer-brief.md#map-budget-and-output).

If `Commit` is absent, a path or symlink target was `(uncommitted)` at capture time or is untracked or ignored, has diffs against `<sha>`, or its line ranges shifted, re-read and re-verify the source or record it under `Not covered`. Spend the exploration budget on rigorous code-level discovery of refined `REQ`s, `DEC`s, planning-altitude test seams, callers and parallel implementations.

Write the full scope map to the plan or design path defined under [Publish](#publish), which also owns the inline fallback. Use the [explorer brief's reply rules](templates/explorer-brief.md#map-budget-and-output). Read any delta and apply [map checks](#check-and-recover).

## Design increments

Before authoring each design increment plan, ground that increment with the same launch, using the increment's objective and questions. Earlier increments can change repository facts, and a broad design omits local seams that the plan needs. Save the increment map as `<session>/<increment-slug>.plan.context.md`. Before authoring, check local seams, consumers and invariants under [map checks](#check-and-recover).

## Check and recover

Before using a map, run orchestrator `lint run` only when the explorer did not report a passing `lint run` (including inline fallback) or after the orchestrator edits the map. Relaunch a failed, timed-out or lint-failing explorer once with the available error evidence, including the lint result when available. For a size error, ask it to compress wording while retaining every entry and `Not covered` item. If no map survives the retry, use the self-grounding checklist under Publish.

Treat maps as claims, not authority. Read only needed map sections once, never the whole scope map. Keep `Not covered` items open until checked. When checking a claim, read its cited range; read a whole file only when a decision depends on wording the map did not capture. Verify each load-bearing claim at source before relying on it. Verify each `Surprise` at its ref before reporting it to the user. When the orchestrator verifies at source that a map claim is wrong, including errors reported by reviewers, writers or explorers, correct every map still read downstream and re-lint each corrected map before the next downstream launch. Then resolve a verified `Surprise` before planning, cite it in a spec, or add it to the governing spec's `## Open Questions`.

## Publish

An explorer edits no repository source or config. It writes only its map to the brief's `outputPath`, except host tool caches under [native slots](providers.md#native-slots). Do not run a `git status` check. For a written map, reply under the [explorer brief's output rule](templates/explorer-brief.md#map-budget-and-output). The orchestrator reads `Surprises` and `Not covered` from the map file. Return the whole map inline only when the host has no write-capable agent type; the orchestrator then saves it verbatim to `outputPath`, runs `lint run` and fixes only reported defects. Context-map lint is the deterministic check.

Save the initial map as `<session>/<slug>.spec.context.md`. Save a scope-round map as `<session>/<slug>.plan.context.md` or `<session>/<slug>.design.context.md`, matching the artifact it grounds.

When no `utility` entry resolves for the host, or no map survives recovery, self-ground with the same questions, Coverage checklist, source refs, load-bearing checks and Surprise handling; save the result at the path for its phase.
