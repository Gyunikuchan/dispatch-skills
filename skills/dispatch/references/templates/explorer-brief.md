# Explorer brief

## Objective

{{objective}}

Map the landscape around the planned decision (constraints, consumers, reuse candidates, conventions and precedent) so grilling, design and planning do not miss load-bearing details.

## Questions

{{questions}}

Answer the planned-decision questions, not a general repository survey.

For a scope round, use the confirmed spec's REQs and DECs as the baseline, then answer any related or unrelated planning questions the caller adds.

When inspecting a file for a pre-spec map (`Commit: <sha>`), resolve any symlinked path with `realpath` and require the result inside the repository root. Check the cited path and its resolved target path: `git ls-tree <sha> -- <path>` lists the path and `git diff --name-only <sha> -- <path>` is empty. Mark any untracked, ignored, out-of-repository symlink or dirty cited path `(uncommitted)`.

## Host rules and tools

Apply the host rule discovery rule below. Use repository read tools and skills named by applicable host rules before the generic tool order below (for example, a wiki reader or code index). Host tool caches follow the native slots rule. Launch the map explorer on an agent type that can write files.

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

For reuse candidates (helpers, utilities and types) and host conventions the change must follow, add `reuse:` or `style:` entries to `Conventions`. For each changed predicate or contract with parallel implementations, add a `parallel:` entry naming each one. Follow the plain-text description rule below for Precedent and Conventions entries. Each `Precedent` entry states what to copy in one clause and lists every file it touches: code, tests, docs, samples, generated artifacts and string-keyed sites. Under `Surprises`, report material facts the objective or questions missed or contradict.

## Map, budget and output

For map tasks, use the embedded context map template below, including its source commit and tool fields. Every backticked ref is a repository-relative file path with forward slashes and optional `:line` or `:start-end`; never a bare filename, bare `:line`, directory or non-path token. Cite Map, Flow and Invariant entries with `path:line` or `path:start-end`; quote each Invariant at its ref. Apply the shared evidence rule below to every external-format and absence claim: state sample coverage and uncertainty, inspect the search method's exclusions, obtain direct host-appropriate evidence, and otherwise mark the claim unverified.

Keep this map within {{mapBudget}} UTF-8 bytes. If it exceeds the budget, compress wording while retaining every entry and `Not covered` item.

For a scope round, the caller provides the confirmed spec path and the spec-phase map path when it exists. Read the spec and map; if the map is absent, use the spec alone. In a scope round, carry forward an entry from the spec-phase map only when its recorded `Commit: <sha>` is present, no cited path is marked `(uncommitted)`, every symlink resolves inside the repository root, `git ls-tree <sha> -- <cited-and-resolved-paths>` lists every cited and resolved target path, and `git diff --name-only <sha> -- <cited-and-resolved-paths>` is empty. Otherwise it re-reads the file. Dedicate the search budget to thorough discovery of refined `REQ`s, `DEC`s, local seams, callers, invariants and `Not covered` items. Write the full scope map to the phase path for its phase. When the spec-phase map exists, add to the reply entries added, corrected and removed and new `Surprises`; “no material delta” is valid. If the map must be returned inline, return the full map for the caller to save under its phase path.

Use `<session>/<slug>.spec.context.md` for pre-spec grounding, `<session>/<slug>.plan.context.md` or `<session>/<slug>.design.context.md` for a scope round. Follow the output rule for `{{outputPath}}` and the inline fallback. After writing a map, run `node {{cliPath}} lint run {{outputPath}} --session {{session}}` and fix every reported defect before returning. An explorer that returns its map inline skips this step. For every written map, reply only with its path, lint status, and counts of `Surprises` and `Not covered` entries; a scope round also includes its delta when the spec-phase map exists.

For non-map research and follow-up questions, return a distilled answer inline with cited sources; write no file. Use no prescribed format or context-map lint.

## Quality

{{quality}}

## Context map template

{{contextMapTemplate}}
