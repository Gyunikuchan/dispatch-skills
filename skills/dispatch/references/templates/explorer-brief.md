# Explorer brief

## Objective

{{objective}}

Map the landscape around the planned decision (constraints, consumers, reuse candidates, conventions and precedent) so grilling, design and planning do not miss load-bearing details ([grounding intent](../grounding.md)).

## Questions

{{questions}}

Answer these questions about the planned decision; do not return a general repository survey. Report material facts the questions missed under `Surprises`.

## Strategy

{{strategy}} — `single`, `outside-in` or `inside-out`.

For `deep`, both explorers answer the same questions and complete the full Coverage checklist.

## Host rules and tools

Apply the [host rule discovery rule](quality-bar.md#shared). Use repository read tools and skills named by applicable host rules before the generic tool order below (for example, a wiki reader or code index). Host tool caches follow [native slots](../providers.md#native-slots). List any named tool or skill that cannot run under `Not covered`. Name the tool used in the map's `Tool` field.

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

For reuse candidates (helpers, utilities and types) and host conventions the change must follow, add `reuse:` or `style:` entries to `Conventions`. Follow the [plain-text description rule](context-map.md#field-notes) for Precedent and Conventions entries. Each `Precedent` entry states what to copy in one clause and lists every file it touches: code, tests, docs, samples, generated artifacts and string-keyed sites. List findings that contradict the objective or questions under `Surprises`.

## Map, budget and output

Use the [context map template](context-map.md), including its source commit, strategy and tool fields. Every backticked ref is a repository-relative file path with forward slashes and optional `:line` or `:start-end`; never a bare filename, bare `:line`, directory or non-path token. Cite Map, Flow and Invariant entries with `path:line` or `path:start-end`; quote each Invariant at its ref and mark absence claims unverified.

Keep this map within 16,384 UTF-8 bytes (16 KB). If it exceeds the budget, compress wording while retaining every entry and `Not covered` item.

Use `<session>/<slug>.context.md` for one initial map; for `deep` initial grounding use `<session>/<slug>.outside-in.context.md` or `<session>/<slug>.inside-out.context.md`; for a follow-up use `<session>/<slug>.followup-<n>.context.md` with strategy `single`. Follow [grounding's output rule](../grounding.md#publish) for `{{outputPath}}` and the inline fallback. After writing the map, run `node {{cliPath}} lint run {{outputPath}} --session {{session}}` and fix every reported defect before returning. An explorer that returns its map inline skips this step.
