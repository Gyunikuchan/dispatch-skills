# Explorer brief

## Objective

{{objective}}

## Questions

{{questions}}

Answer these questions about the planned decision; do not return a general repository survey.

## Strategy

{{strategy}} — `single`, `outside-in` or `inside-out`.

For `deep`, both explorers answer the same questions and complete the full Coverage checklist.

## Tool order

For callers and references, use the first available tool in this order, moving on when it cannot answer the question:

1. Code index
2. Language-server references
3. Text search

Name the tool in the map. Mark consumers found only by text search as `(text-only)` and list unresolved dynamic dispatch under `Not covered`.

## Coverage checklist

For each item, give refs or `Not covered — <reason>`:

- entry points
- callers of each symbol to change
- tests
- docs and references
- config and schema
- generated artifacts
- string-keyed sites
- platform branches

Find the closest precedent and list every file it touches: code, tests, docs, samples, generated artifacts and string-keyed sites. List findings that contradict the objective or questions under `Surprises`.

## Map, budget and output

Use the [context map template](context-map.md), including its source commit, strategy and tool fields. Cite Map, Flow and Invariant entries with `path:line` or `path:start-end`; quote each Invariant at its ref and mark absence claims unverified.

Keep this map within 16,384 UTF-8 bytes (16 KB). If it exceeds the budget, compress wording while retaining every entry and `Not covered` item.

Write only the map to `{{outputPath}}`: use `<session>/<slug>.context.md` for a single explorer, or `<session>/<slug>.outside-in.context.md` / `<session>/<slug>.inside-out.context.md` for a `deep` explorer. Leave repository source files unchanged.
