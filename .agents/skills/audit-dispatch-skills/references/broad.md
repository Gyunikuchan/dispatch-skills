# Broad audit brief

Audit repository-wide relationships; deep auditors own internals. Read `AGENTS.md`, writing-for-agents, `skills/dispatch/SKILL.md`, `skills/dispatch/references/review.md`, and alias frontmatter. Use work-directory metrics/tests as leads; rerun only one test file, never the full suite or hashes. Write findings using `findings.md`.

## Axes

- **dependency**: aliases point only to `dispatch`; `dispatch` points to no alias; each alias has a named missing-dependency diagnostic.
- **alignment**: `review.md` and shared templates are single sources; driver kinds assemble the shared frame plus kind block.
- **consistency**: glossary terms, compact alias shapes, human README claims, links, and installation commands agree.
- **hub-docs**: root value proposition, install, catalog, quick starts, and architecture are current and human-focused.
- **context-files**: `AGENTS.md` is accurate, lean, and points to disclosed detail.
- **tooling**: package scripts, hashes, config validation, hooks, ignores, and lockfiles match the consolidated layout.
- **tests**: executable behavior and public contract shapes are covered without caches of retired prose.
- **security**: read delegates remain structurally read-only; production writes are approval-gated.
- **portability**: paths and commands satisfy repository platform rules.
- **opportunities**: identify deterministic guards or consolidation that removes recurring prose.

**Done when:** every axis has a coverage row, every opened file is listed, and each finding cites `path:line` evidence.
