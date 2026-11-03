# Explorer brief

## Objective

{{objective}}

Map the landscape around the planned decision (constraints, consumers, reuse candidates, conventions and precedent) so grilling, design and planning do not miss load-bearing details ([grounding intent](../grounding.md)).

## Questions

{{questions}}

Answer the planned-decision questions, not a general repository survey.

For a scope round, use the confirmed spec's REQs and DECs as the baseline, then answer any related or unrelated planning questions the caller adds.

## Host rules and tools

Apply the [host rule discovery rule](quality-bar.md#shared). Use repository read tools and skills named by applicable host rules before the generic tool order below (for example, a wiki reader or code index). Host tool caches follow [native slots](../providers.md#native-slots). List any named tool or skill that cannot run under `Not covered`. Name the tool used in the map's `Tool` field.

For any delegation already permitted by the assignment, use available host controls to request fresh context without parent conversation history. If unsupported or unverifiable, continue and report the limitation through existing reporting channels. Give each new child a self-contained brief with this launch instruction; preserve required reply schemas.

## Tool order

For callers and references, use the first available tool in this order, moving on when it cannot answer the question:

1. Code index
2. Language-server references
3. Text search

Mark consumers found only by text search as `(text-only)` and list unresolved dynamic dispatch under `Not covered`.

## Coverage checklist

Complete every item; the checklist is the completeness contract, not a search order. For each item, give refs or `Not covered — <reason>`:

- entry points
- callers of each symbol to change
- tests
- docs and references
- config and schema
- generated artifacts
- string-keyed sites
- platform branches

For a template or prompt edit, trace its renderer and generated consumers; cite them in the `callers` and `generated` coverage entries.

For reuse candidates (helpers, utilities and types) and host conventions the change must follow, add `reuse:` or `style:` entries to `Conventions`. For each changed predicate or contract with parallel implementations, add a `parallel:` entry naming each one. Follow the [plain-text description rule](context-map.md#field-notes) for Precedent and Conventions entries. Each `Precedent` entry states what to copy in one clause and lists every file it touches: code, tests, docs, samples, generated artifacts and string-keyed sites. Under `Surprises`, report material facts the objective or questions missed or contradict.

## Map, budget and output

For map tasks, use the [context map template](context-map.md), including its source commit and tool fields. Every backticked ref is a repository-relative file path with forward slashes and optional `:line` or `:start-end`; never a bare filename, bare `:line`, directory or non-path token. Cite Map, Flow and Invariant entries with `path:line` or `path:start-end`; quote each Invariant at its ref. Apply the [shared evidence rule](quality-bar.md#shared) to every external-format and absence claim: state sample coverage and uncertainty, inspect the search method's exclusions, obtain direct host-appropriate evidence, and otherwise mark the claim unverified.

Keep this map within 16,384 UTF-8 bytes (16 KB). If it exceeds the budget, compress wording while retaining every entry and `Not covered` item.

For a scope round, the caller provides the confirmed spec path and the spec-phase map path when it exists. Read the spec and map; if the map is absent, use the spec alone. Write the full scope map to the phase path defined in [grounding](../grounding.md#publish). When the spec-phase map exists, add to the reply entries added, corrected and removed and new `Surprises`; “no material delta” is valid. If the map must be returned inline, return the full map for the caller to save under its phase path.

Use `<session>/<slug>.spec.context.md` for pre-spec grounding, `<session>/<slug>.plan.context.md` or `<session>/<slug>.design.context.md` for a scope round. Follow [grounding's output rule](../grounding.md#publish) for `{{outputPath}}` and the inline fallback. After writing a map, run `node {{cliPath}} lint run {{outputPath}} --session {{session}}` and fix every reported defect before returning. An explorer that returns its map inline skips this step. For every written map, reply only with its path, lint status, and counts of `Surprises` and `Not covered` entries; a scope round also includes its delta when the spec-phase map exists.

For non-map research and follow-up questions, return a distilled answer inline with cited sources; write no file. Use no prescribed format or context-map lint.
