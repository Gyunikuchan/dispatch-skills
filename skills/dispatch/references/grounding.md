# Grounding

Initial grounding is required for every new spec, regardless of question size. Run `doctor run` and use its configured explorer for this platform; if none is configured, self-ground under [Publish](#publish). Also ground before design, plan or `ask` when understanding needs many files read.

## Launch

Run `doctor run` without `--level`. When it reports a configured explorer for this platform, use its resolved model and effort exactly. Send each explorer the question-driven [explorer brief](templates/explorer-brief.md), which sets a 16 KB (16,384 UTF-8 byte) budget per map. Launch one native explorer for initial grounding unless `deep: true`; deep applies only to initial grounding, where outside-in and inside-out explorers run in parallel with the same resolved model, effort, objective, questions and full Coverage checklist. Follow [native slot rules](providers.md#native-slots); a host that cannot launch the configured slot is a blocker, not permission to substitute. Launch each native explorer on an agent type that can write files.

Outside-in starts at entry points, docs, config, samples, tests and precedent, then traces into internals. Inside-out starts at the symbols and files planned to change, then traces callers, importers, re-exports and tests. These strategies set the starting direction; both explorers follow the brief's tool order.

## Follow-up explorers

For follow-ups only, launch one explorer when an unanswered question needs many files read and no existing map answers it; handle small lookups directly. This applies at any stage, including grilling, authoring or review adjudication. Put only that question and its limited Coverage checklist in a single-strategy brief. Use the follow-up output form in the [explorer brief](templates/explorer-brief.md#map-budget-and-output); keep `<slug>.context.md` for the initial map. Lint each map and verify load-bearing claims at source before relying on it.

## Check and recover

Run `lint run` on each explorer map before using it. Relaunch a failed, timed-out or lint-failing explorer once with the available error evidence, including the lint result when available. For a size error, ask it to compress wording while retaining every entry and `Not covered` item. If no map survives the retry, use the self-grounding checklist under Publish; if one `deep` map survives, use it and record the missing strategy under `Not covered`.

Treat maps as claims, not authority. Keep `Not covered` items open until checked, and verify each load-bearing claim at source before relying on it. Verify each `Surprise` at its ref before reporting it to the user. Then resolve it before planning, cite it in a spec, or add it to the governing spec's `## Open Questions`.

When both deep maps pass lint, merge them with `context merge <slug>.outside-in.context.md <slug>.inside-out.context.md --out <slug>.context.md --session <session>`. Same-key Coverage and Precedent entries merge undisputed with unioned refs unless either map says `not covered` for that key; other one-sided claims stay `[disputed]` ([rule](toolkit.md#context-merge)). Read the merged map and check every `[disputed]` entry at source; agreed entries need no further check unless they are load-bearing.

## Publish

An explorer may write only its context map to the brief's `outputPath`, on a best-effort basis. Do not run a `git status` check. Return the whole map inline only when the host has no write-capable agent type; the orchestrator then saves it verbatim to `outputPath`, runs `lint run` and fixes only reported defects. Context-map lint is the deterministic check.

Save the initial map used for planning as `<session>/<slug>.context.md`: the single map, merged map or surviving strategy map. For a surviving strategy map, use the canonical filename and put the missing strategy under `Not covered`. Plan lint reads this canonical path.

When no explorer is configured for the host, or no map survives recovery, self-ground with the same questions, Coverage checklist, source refs, load-bearing checks and Surprise handling; save the result at the canonical path.
