# Grounding

Initial grounding is required for every new spec, regardless of question size. Follow the [scope round](#scope-round) rule. Ground each design increment before authoring its plan ([design increments](#design-increments)). Also ground before `ask` when understanding needs many files read.

Grounding maps the landscape around the planned decision (constraints, consumers, reuse candidates, parallel implementations, conventions and precedent) so that grilling, design and planning do not miss load-bearing details.

## Launch

Run `doctor run` without `--level`. When it reports a configured explorer for this platform, use its resolved model and effort exactly. The configured explorer is expected to use a cheaper model than the host agent, so token-heavy reading can stay out of the orchestrator's context. Send the explorer the question-driven [explorer brief](templates/explorer-brief.md), which sets a 16 KB (16,384 UTF-8 byte) budget per map. Fill `{{cliPath}}` with the `dispatch.ts` path the orchestrator invokes and `{{session}}` with the session directory, both resolvable from the explorer's working directory. For every explorer launch—grounding, scope round, design increment, follow-up, parallel research, retry or replacement—use this configured model and effort. When no explorer is configured, do the work yourself. Launch one map explorer per grounding phase and one research explorer per independent topic in parallel. The brief sets no search direction; its Coverage checklist is the completeness contract. Follow [native slot rules](providers.md#native-slots); a host that cannot launch the configured slot is a blocker, not permission to substitute. Launch the map explorer on an agent type that can write files.

## Scope round

After `confirm` and before authoring a standalone plan or any design, ground the confirmed scope with the same launch, explorer brief and Coverage checklist. Start with questions from the confirmed spec's REQs and DECs, then add any related or unrelated question the orchestrator needs to plan or design. Give the explorer the governing spec path and its `<session>/<slug>.spec.context.md` map path. Continue the live explorer when the host can; otherwise launch a fresh one with both paths. If the spec-phase map does not exist, ground from the spec alone.

Write the full scope map to the plan or design path defined under [Publish](#publish), which also owns the inline fallback. Use the [explorer brief's reply rules](templates/explorer-brief.md#map-budget-and-output). The orchestrator reads any delta and cited source ranges. With or without a spec-phase baseline, read only needed sections of the current scope map once; do not read the whole scope map. Verify load-bearing claims at their cited source ranges.

## Design increments

Before authoring each design increment plan, ground that increment with the same launch, using the increment's objective and questions. Earlier increments can change repository facts, and a broad design omits local seams that the plan needs. Save the increment map as `<session>/<increment-slug>.plan.context.md`. Before authoring, read its relevant sections once for local seams, consumers and invariants, then verify load-bearing claims at their cited source ranges.

## Follow-up explorers

Explorers are native subagents that edit no repository source or config, dispatched autonomously by orchestrators at any time to keep context lean. Unlike structured grounding phases that produce `.context.md` maps to their assigned `outputPath`, follow-up explorers conduct inline ad-hoc research and write no files. Explorers may research the codebase, web or prior session runs (logs, ledgers, diagnostics and artifacts) at any step, including `ask`. Agents run `ask` to fulfill explicit user requests, but must never invoke `ask run` autonomously for their own internal research; when no explorer is configured for the host platform, investigate directly under [Launch](#launch).

Launch one explorer per independent topic in parallel under [Launch](#launch). Each follow-up, whether a map question or research, answers inline with distilled findings and cited sources.

For a map question that needs many files and no current map answers, continue a live explorer with relevant context when the host permits; otherwise launch a fresh explorer under [Launch](#launch). A continued explorer is the same launch under [providers](providers.md#subagent-context), so the fresh-context rule does not apply; reuse its retained handle. Reviewers are not continued across rounds.

Consider follow-ups for reuse candidates, consumers, review findings or failed repairs. Give each question a limited Coverage checklist. Verify load-bearing claims at source before relying on them.

## Check and recover

Run `lint run` on each explorer map before using it. Relaunch a failed, timed-out or lint-failing explorer once with the available error evidence, including the lint result when available. For a size error, ask it to compress wording while retaining every entry and `Not covered` item. If no map survives the retry, use the self-grounding checklist under Publish.

Treat maps as claims, not authority. Keep `Not covered` items open until checked. When checking a claim, read its cited range; read a whole file only when a decision depends on wording the map did not capture. Verify each load-bearing claim at source before relying on it. Verify each `Surprise` at its ref before reporting it to the user. When the orchestrator verifies at source that a map claim is wrong, including errors reported by reviewers, writers or follow-up explorers, correct every map still read downstream and re-lint each corrected map before the next downstream launch. Then resolve a verified `Surprise` before planning, cite it in a spec, or add it to the governing spec's `## Open Questions`.

## Publish

An explorer edits no repository source or config. It writes only its map to the brief's `outputPath`, except host tool caches under [native slots](providers.md#native-slots). Do not run a `git status` check. For a written map, reply only with its path, lint status, and counts of `Surprises` and `Not covered`; a scope round also includes its delta when the spec-phase map exists. The orchestrator reads `Surprises` and `Not covered` from the map file. Return the whole map inline only when the host has no write-capable agent type; the orchestrator then saves it verbatim to `outputPath`, runs `lint run` and fixes only reported defects. Context-map lint is the deterministic check.

Save the initial map as `<session>/<slug>.spec.context.md`. Save a scope-round map as `<session>/<slug>.plan.context.md` or `<session>/<slug>.design.context.md`, matching the artifact it grounds.

When no explorer is configured for the host, or no map survives recovery, self-ground with the same questions, Coverage checklist, source refs, load-bearing checks and Surprise handling; save the result at the path for its phase.
