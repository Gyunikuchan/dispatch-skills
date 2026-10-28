# Grounding

For new specs, use this grounding procedure under the [spec-stage sequence](spec-stage.md#resolve-and-author). Also ground before design, plan or `ask` when understanding needs many files read.

## Launch

Run `doctor run` without `--level` and use the resolved explorer model and effort exactly. Send each explorer the question-driven [explorer brief](templates/explorer-brief.md), which sets a 16 KB (16,384 UTF-8 byte) budget per map. Launch one native explorer for initial grounding unless `deep: true`; deep applies only to initial grounding, where outside-in and inside-out explorers run in parallel with the same resolved model, effort, objective, questions and full Coverage checklist. Follow [native slot rules](providers.md#native-slots); a host that cannot launch the configured slot is a blocker, not permission to substitute.

Outside-in starts at entry points, docs, config, samples, tests and precedent, then traces into internals. Inside-out starts at the symbols and files planned to change, then traces callers, importers, re-exports and tests. These strategies set the starting direction; both explorers follow the brief's tool order.

## Follow-up explorers

At any stage, including grilling, authoring or review adjudication, launch one follow-up explorer when an unanswered question needs many files read and no existing map answers it. Put only that question and its limited Coverage checklist in a single-strategy brief. Handle small lookups directly. Use the follow-up output form in the [explorer brief](templates/explorer-brief.md#map-budget-and-output); keep `<slug>.context.md` for the initial map. Lint each map and verify load-bearing claims at source before relying on it.

## Check and recover

Run `lint run` on each explorer map before using it. Relaunch a failed, timed-out or lint-failing explorer once with the available error evidence, including the lint result when available. For a size error, ask it to compress wording while retaining every entry and `Not covered` item. If no map survives the retry, use the self-grounding checklist under Publish; if one `deep` map survives, use it and record the missing strategy under `Not covered`.

Treat maps as claims, not authority. Keep `Not covered` items open until checked, and verify each load-bearing claim at source before relying on it. Resolve each `Surprise` before planning or add it to the governing spec's `## Open Questions`.

When both deep maps pass lint, merge them with `context merge <slug>.outside-in.context.md <slug>.inside-out.context.md --out <slug>.context.md --session <session>`. Read the merged map and check every `[disputed]` entry at source; agreed entries need no further check unless they are load-bearing.

## Publish

An explorer may write only its context map to the brief's `outputPath`, on a best-effort basis. Do not run a `git status` check. When the host agent cannot write files, return the whole map inline; the orchestrator saves it to `outputPath`. Context-map lint is the deterministic check.

Save the initial map used for planning as `<session>/<slug>.context.md`: the single map, merged map or surviving strategy map. For a surviving strategy map, use the canonical filename and put the missing strategy under `Not covered`. Plan lint reads this canonical path.

When no explorer is configured for the host, or no map survives recovery, self-ground with the same questions, Coverage checklist, source refs, load-bearing checks and Surprise handling; save the result at the canonical path.
