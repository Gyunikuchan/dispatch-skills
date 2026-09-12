# Broad audit brief

You audit **across** skills and the repository around them; deep auditors own each skill's internals. Open skill files to check relationships between them, not to re-audit one in isolation.

Scope: how `skills/*` fit together; `.agents/AGENTS.md` (`.claude/CLAUDE.md` symlinks to it); root `README.md`; `scripts/`; `tests/integration/`, `tests/scripts/`, and the test tree layout; `package.json`, `.husky/`, `.gitignore`, `.gitattributes`, `skills-lock.json`, `.opencode/`, `.vscode/`, `.agents/hooks.json`, `.agents/mcp_config.json`.

Read first: `.agents/AGENTS.md` (the standard), `.agents/skills/writing-for-agents/SKILL.md` and its `SKILL-MECHANICS.md`, then `skills/dispatch/references/alignment.md` and each skill's `SKILL.md` frontmatter and section headings. Use the work dir's `metrics.md` and `tests.txt` as leads. Test evidence is the work dir's `tests.txt`; re-run a single file with `node --test <file>` only — never `npm test`/`npm run hashes`.

Write findings in the format of [findings.md](findings.md).

## Axes

Apply every axis and record each in the coverage table.

- **`dependency`**: The unidirectional flow in `AGENTS.md`. Search each upstream skill for downstream names (allowed: `dispatch`'s `references/alignment.md` and its gated Skill Alignment section). References by path where a skill name belongs. Standalone installs: does each skill work with only its declared dependencies, and is graceful degradation stated?
- **`alignment`**: `alignment.md` as the single source — conventions restated or drifted in the review-flow skills; shared review schemas (claim format, severity, adjudication, resolutions log, user report) identical where they must be; cross-skill behavioral flow: do multi-skill orchestrations (`implement-dispatch` → `dispatch-plan-review` → `dispatch` → `dispatch-code-review`) pass state, artifacts, and parameters seamlessly so the combined workflow converges to consensus and meets its overarching objective without deadlocks or context leaks; the same review behaving compatibly when invoked standalone and from `implement-dispatch`; plan-review/code-review parity against `tests/integration/review-skill-parity.test.mjs`.
- **`consistency`**: Terminology and leading words across skills (cascade, delegate, claim, adjudicate, consensus), flag names and defaults, structure and tone across skill READMEs against human documentation criteria, install commands, cross-links, and use of `references/notes.md` for background material.
- **`hub-docs`**: Root `README.md` against the Documentation Standards (value proposition, install, catalog with dependencies, quick start, architecture highlights): strictly human-optimized, accurate today, enticing, high level.
- **`context-files`**: `AGENTS.md` graded against `writing-for-agents` as always-loaded context (no-ops, duplication with skills or the environment, stale rules, negation) and checked for accuracy against the repo as it is.
- **`tooling`**: `package.json` scripts; the husky pre-commit pattern against the real file layout; which files `scripts/generate-hashes.mjs` hashes versus which it should; `scripts/validate-configs.mjs` search paths; ignore and attribute rules; lockfile and agent config files.
- **`tests`**: Test tree mirroring source; missing cross-skill guards (doc-versus-`--help` flag drift, dependency direction, link integrity); redundant suites, overlapping unit vs integration assertions to prune or consolidate; `npm test` side effects.
- **`security`**: The read-only boundary end to end (dispatch → reviews → `implement-dispatch`), what content reaches delegates, secrets committed in config.
- **`portability`**: Shell snippets across every doc against the `AGENTS.md` portability rule.
- **`opportunities`**: Simplifications, redundant code or helper duplicates to hoist into a shared home (`skills/dispatch/scripts/common.mjs`), redundant cross-suite test cases to prune, files or skills to merge or split, guard tests that would retire a manual review item.

**Done when:** every axis has a coverage row, `Files opened` lists every file read, and every finding cites `path:line` evidence.
