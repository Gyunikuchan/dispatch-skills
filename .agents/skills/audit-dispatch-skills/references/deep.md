# Deep audit brief

You audit **one skill end to end**: its `SKILL.md`, `README.md`, references, config, scripts, and the tests that exercise them (`tests/skills/<name>/`, plus any test importing its scripts). You are the only auditor reading this skill in full, so be relentless inside it; cross-skill matters belong to the broad auditor — note them in `Handoff` and move on.

Read first: `.agents/AGENTS.md` (the standard), `.agents/skills/writing-for-agents/SKILL.md` and its `SKILL-MECHANICS.md`, then every file in scope. Use the work dir's `metrics.md` and `tests.txt` (coverage, uncovered lines) as leads, confirmed by reading the code. Test evidence is the work dir's `tests.txt`; re-run a single file with `node --test <file>` only — never `npm test`/`npm run hashes`.

Write findings in the format of [findings.md](findings.md).

## Axes

Apply every axis and record each in the coverage table.

- **`purpose`**: Walk each `SKILL.md` step as the agent would, through every script call and every platform branch. Does the skill achieve its stated goal? Bugs, unhandled branches, error paths whose output leaves the agent stuck, flags that do nothing.
- **`compliance`**: Check each `AGENTS.md` rule that applies (pillars, dependency invariants, documentation standards, authoring and portability, comments). A deviation backed by a stated rationale that holds up is compliant; flag deviations whose rationale is absent or wrong, and say where you looked for one.
- **`agent-doc`**: Grade `SKILL.md` and operational references against `writing-for-agents`: description as a context pointer (leading word, one trigger per branch), completion criteria (clarity and demand), information hierarchy and disclosure, co-location, sprawl, single source of truth, caches of the environment, no-ops, negation, leading-word opportunities. Verify non-operational rationale or maintainer background is relocated to `references/notes.md` rather than bloating agent context. Propose the rewritten passage.
- **`readme`**: Check every flag, default, path, and behaviour claim in `README.md` against `SKILL.md` and the scripts. Apply the human inclusion filter: *Is this something the human user of the skill needs to know?* Grade at human altitude: what it does, prerequisites and install, invocation examples as slash commands or prompts, configuration, quirks and troubleshooting. Flag agent-internal details that belong in `SKILL.md` and background notes that belong in `references/notes.md`.
- **`staleness`**: Comments, JSDoc, `--help` text, and docs that contradict current code; flags documented but absent from `--help` (and the reverse); mentions of removed features, renamed files, or old paths.
- **`code`**: Readability and architecture — `// SECTION:` grouping, types/tunable constants/main functions hoisted to the top, structure aligned with `skills/dispatch/scripts/claude-run.mjs`; redundant or dead code; helpers duplicated across scripts that belong in `skills/dispatch/scripts/common.mjs`.
- **`security`**: Structural read-only enforcement, environment sanitisation, denylist gaps, injection (argv, `cmd.exe` escaping, prompt content), path traversal, temp-file permissions, delegate-output sanitisation.
- **`portability`**: Windows, macOS, Linux; bash, zsh, PowerShell — path separators, `.cmd`/`.bat` launchers, shell syntax in docs, case sensitivity, line endings.
- **`tests`**: Map every exported function and branch to a test. Report missing scenarios (name the case and the branch it covers), redundant or overlapping tests to prune, tests at the wrong level (unit vs integration), non-hermetic tests (real binaries, network, home directory), and file grouping to right-size.
- **`efficiency`**: What the skill's flow costs the orchestrator's context — description length, `SKILL.md` size, what reaches context versus logs, redundant dispatches or loops.

**Done when:** every axis has a coverage row, `Files opened` lists every file in scope, and every finding cites `path:line` evidence.
