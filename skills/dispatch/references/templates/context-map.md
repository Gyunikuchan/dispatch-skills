# Context map: <topic>

> **Commit:** <full or short SHA>
>
> **Strategy:** single | outside-in | inside-out | merged
>
> **Tool:** code-index | lsp | text | `<host tool>`

This is a claims artifact, not governing authority. Verify each claim you rely on at its source ref. Mark absence claims as unverified until checked.

## Map
- <component> — `path/to/file.ts:12-40`

## Flows
- <flow>: `a.ts:10` → `b.ts:22`

## Invariants
- <claim> — `path.ts:5-9` — "<verbatim quote from the cited range>"

## Coverage
- entry-points: `path:line`[, …] | not covered — <reason>
- callers | tests | docs | config | generated | string-keys | platform-branches: (same form)

## Precedent
- <analogue in plain text>: <what to copy in plain text, one clause> — `path`[, `path:line`, …]

## Conventions
- reuse: <helper/utility/type and when to use it, plain text> — `path:line`
- style: <idiom, naming or rule in plain text> — `path:start-end`

## Surprises
- <finding> — `path:line`

## Not covered
- <item>

### Field notes

- Use repository-relative paths with forward slashes. Map, Flow, Invariant, Surprise and Conventions entries need line refs. Coverage and Precedent may use path-only refs.
- Quote invariant source text verbatim inside double quotes. Lint compares whitespace-normalised text within the cited range.
- Use plain text before the — separator in Precedent and Conventions entries, including symbol names and dotted helpers; reserve backticks for repository refs.
- Conventions is optional and does not produce plan-coverage warnings.
- Tool may name a host read tool.
- Mark consumers found only by text search with `(text-only)`. Prefix merged entries supported by one map with `[disputed]`, except same-key Coverage and Precedent entries: they merge with unioned refs when neither map says `not covered` for that key ([context merge](../toolkit.md#context-merge)).
- A single map warns above 16,384 UTF-8 bytes and errors above 32,768 bytes. A merged map warns above 24,576 bytes.
- `merged` is reserved for `context merge` output; explorers select `single`, `outside-in` or `inside-out`.
