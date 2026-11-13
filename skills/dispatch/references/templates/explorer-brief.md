# Explorer brief

## Objective

{{objective}}

Map the landscape around the planned decision (constraints, consumers, reuse candidates, conventions and precedent) so grilling, design and planning do not miss load-bearing details.

## Questions

{{questions}}

Answer the planned-decision questions, not a general repository survey.

## Limit and nesting rules

Token limit for this host: {{limit}}.
Split threshold: {{splitAt}}.
Launch model and effort for nested launches: {{nestedLaunch}}.

Work solo by default. Split only when expected reading exceeds the split threshold. Estimate expected reading in files and bytes using ~4 bytes per token (about 20 KB or ~5 files per ~5k tokens). The token limit is a soft budget.

After recon, hand off only an independent sub-topic (no other shard reads its files) of about 15 files or 60 KB of expected reading. Use the fewest nested explorers that bring the remaining work under the split threshold, at most four. Nesting is limited to one level; a nested explorer launches nothing.

If no independent sub-topic qualifies, coherent single-topic work stays solo past the limit: finish it whole and report the expected overrun (tokens above the limit) in your reply.

When you have no tool to launch a subagent, do the work yourself and say so in your reply.

In your reply, report each nested explorer's model and tokens where available, or `unavailable`.

## Host rules and tools

Apply the host rule discovery rule below. Use repository read tools and skills named by applicable host rules before the generic tool order below (for example, a wiki reader or code index). Host tool caches follow the native slots rule.

## Tool order

For callers and references, use the first available tool in this order, moving on when it cannot answer the question:

1. Code index
2. Language-server references
3. Text search

Mark consumers found only by text search as `(text-only)` and list unresolved dynamic dispatch under Not covered (map) or as open items (research).

<!-- kind: map -->
## Coverage checklist

Launch the map explorer on an agent type that can write files.

Complete every item; the checklist is the completeness contract, not a search order. For each item, give refs or `Not covered — <reason>`:

- entry points
- validation gates each new or changed input crosses
- callers of each symbol to change
- callers and impacted tests of each changed shared helper
- saved states, resume paths and callers that read a changed value
- tests
- docs and references
- config and schema
- generated artifacts
- string-keyed sites
- platform branches

For a template or prompt edit, trace its renderer and generated consumers; cite them in the `callers` and `generated` coverage entries.

For reuse candidates (helpers, utilities and types) and host conventions the change must follow, add `reuse:` or `style:` entries to `Conventions`. For each changed predicate or contract with parallel implementations, add a `parallel:` entry naming each one. Follow the plain-text description rule below for Precedent and Conventions entries. Each `Precedent` entry states what to copy in one clause and lists every file it touches: code, tests, docs, samples, generated artifacts and string-keyed sites. Under `Surprises`, report material facts the objective or questions missed or contradict.

## Map, budget and output

For map tasks, use the embedded context map template below, including its source commit and tool fields. Every backticked ref is a repository-relative file path with forward slashes and optional `:line` or `:start-end`; never a bare filename, bare `:line`, directory or non-path token. Cite Map, Flow and Invariant entries with `path:line` or `path:start-end`; quote each Invariant at its ref. Write only your assigned map (`{{outputPath}}` or assigned partial maps in `{{session}}`), except host tool caches or indexes; edit no other file.

Keep this map within {{mapBudget}} UTF-8 bytes. If it exceeds the budget, compress wording while retaining every entry and `Not covered` item.

When inspecting a file for a pre-spec map (`Commit: <sha>`), resolve any symlinked path with `realpath` and require the result inside the repository root. Check the cited path and its resolved target path: `git ls-tree <sha> -- <path>` lists the path and `git diff --name-only <sha> -- <path>` is empty. Mark any untracked, ignored, out-of-repository symlink or dirty cited path `(uncommitted)`.

For a scope round, use the confirmed spec's REQs and DECs as the baseline, then answer any related or unrelated planning questions the caller adds. The caller provides the confirmed spec path and the spec-phase map path when it exists. Read the spec and map; if the map is absent, use the spec alone. In a scope round, carry forward an entry from the spec-phase map only when its recorded `Commit: <sha>` is present, no cited path is marked `(uncommitted)`, every symlink resolves inside the repository root, `git ls-tree <sha> -- <cited-and-resolved-paths>` lists every cited and resolved target path, and `git diff --name-only <sha> -- <cited-and-resolved-paths>` is empty. Otherwise it re-reads the file. Dedicate the search budget to thorough discovery of refined `REQ`s, `DEC`s, local seams, callers, invariants and `Not covered` items. Write the full scope map to the phase path for its phase. When the spec-phase map exists, add to the reply entries added, corrected and removed and new `Surprises`; “no material delta” is valid. If the map must be returned inline, return the full map for the caller to save under its phase path.

When the change touches a shared contract, schema or predicate with consumers in several areas, assign one nested explorer the objective and the covered paths, not the findings, to report surfaces absent from them.

Assign each nested explorer a partial map path in the session directory `{{session}}`. Nested explorers reply with only their partial map path and counts (they run no map lint). Consolidate the partial maps into the one phase map at `{{outputPath}}` within {{mapBudget}} UTF-8 bytes; keep partial maps as evidence. Answer every base grounding question and Coverage item or list it under `Not covered`.

Use `<session>/<slug>.spec.context.md` for pre-spec grounding, `<session>/<slug>.plan.context.md` or `<session>/<slug>.design.context.md` for a scope round. Follow the output rule for `{{outputPath}}` and the inline fallback. After the lead writes the consolidated map at `{{outputPath}}`, run `node {{cliPath}} lint run {{outputPath}} --session {{session}}` and fix every reported defect before returning. An explorer that returns its map inline skips this step. For the lead's consolidated map at `{{outputPath}}`, reply only with its path, lint status, counts of `Surprises` and `Not covered` entries, any expected overrun, and the per-nested-explorer model and token report; a scope round also includes its delta when the spec-phase map exists. Nested map explorers reply only with their assigned partial-map path and counts as specified above.

## Context map template

{{contextMapTemplate}}
<!-- /kind: map -->

<!-- kind: research -->
## Research output and budget

Reply inline with a distilled answer and cited sources within {{replyLimit}} UTF-8 bytes; write no map file, use no prescribed format, and run no context-map lint. List any unread remainder as open items.

When nesting: each nested explorer replies inline to the lead within {{replyLimit}} UTF-8 bytes. The lead consolidates the nested replies into its one reply within the {{replyLimit}} UTF-8 byte limit, preserves their citations, and adds the per-nested-explorer model and token report (or `unavailable`).
<!-- /kind: research -->

## Quality

{{quality}}
