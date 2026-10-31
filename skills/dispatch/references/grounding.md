# Grounding

Initial grounding is required for every new spec, regardless of question size. Run `doctor run` and use its configured explorer for this platform; if none is configured, self-ground under [Publish](#publish). Ground each design increment before authoring its plan ([design increments](#design-increments)). Also ground before design, plan or `ask` when understanding needs many files read.

Grounding maps the landscape around the planned decision (constraints, consumers, reuse candidates, parallel implementations, conventions and precedent) so that grilling, design and planning do not miss load-bearing details.

## Launch

Run `doctor run` without `--level`. When it reports a configured explorer for this platform, use its resolved model and effort exactly. Send the explorer the question-driven [explorer brief](templates/explorer-brief.md), which sets a 16 KB (16,384 UTF-8 byte) budget per map. Fill `{{cliPath}}` with the `dispatch.ts` path the orchestrator invokes and `{{session}}` with the session directory, both resolvable from the explorer's working directory. Launch one native explorer. The brief sets no search direction; its Coverage checklist is the completeness contract. Follow [native slot rules](providers.md#native-slots); a host that cannot launch the configured slot is a blocker, not permission to substitute. Launch the native explorer on an agent type that can write files.

## Design increments

Before authoring each design increment plan, ground that increment with the same launch, using the increment's objective and questions. Earlier increments can change repository facts, and a broad design omits local seams that the plan needs. Save the increment map as `<session>/<slug>.context.md` for that plan's slug.

## Follow-up explorers

At any step, including `ask`, when an open question needs many files read and no current map answers it, send the question to a live explorer that holds relevant context, when the host can continue agents. Otherwise, or when no live explorer holds relevant context, launch one fresh explorer. A continued explorer is the same launch under [providers](providers.md#subagent-context), so the fresh-context rule does not apply to it; reuse its retained handle. Reviewers are not continued across rounds.

Consider a follow-up to search for reuse candidates or consumers while authoring a design or plan, check a review finding, or diagnose a failed repair; these examples are guidance, not a gate. Put only that question and its limited Coverage checklist in the brief. Use the follow-up output form in the [explorer brief](templates/explorer-brief.md#map-budget-and-output); keep `<slug>.context.md` for the initial map. Lint each map and verify load-bearing claims at source before relying on it.

## Check and recover

Run `lint run` on each explorer map before using it. Relaunch a failed, timed-out or lint-failing explorer once with the available error evidence, including the lint result when available. For a size error, ask it to compress wording while retaining every entry and `Not covered` item. If no map survives the retry, use the self-grounding checklist under Publish.

Treat maps as claims, not authority. Keep `Not covered` items open until checked. When checking a claim, read its cited range; read a whole file only when a decision depends on wording the map did not capture. Verify each load-bearing claim at source before relying on it. Verify each `Surprise` at its ref before reporting it to the user. Then resolve it before planning, cite it in a spec, or add it to the governing spec's `## Open Questions`.

## Publish

An explorer edits no repository source or config. It writes only its map to the brief's `outputPath`, except host tool caches under [native slots](providers.md#native-slots). Do not run a `git status` check. Return the whole map inline only when the host has no write-capable agent type; the orchestrator then saves it verbatim to `outputPath`, runs `lint run` and fixes only reported defects. Context-map lint is the deterministic check.

Save the initial map used for planning as `<session>/<slug>.context.md`.

When no explorer is configured for the host, or no map survives recovery, self-ground with the same questions, Coverage checklist, source refs, load-bearing checks and Surprise handling; save the result at the canonical path.
