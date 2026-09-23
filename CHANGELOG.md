# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Faster implementation runs: the driver runs verify gates itself and extracts failure identities, RED checks run only the new tests, an unchanged tree reuses its baseline, and the pre-production RED review runs only at `high` effort and above
- Easier recovery: a failed task can `retry` in the same run with your ruling as context, and verify logs are kept per run
- Plans can declare `[GENERATED]` paths with a generator command; the driver regenerates them at completion instead of asking about them
- Leaner walkthroughs and write briefs: task snapshots live in Git, the RED matrix renders as a table, and writers receive a hashed brief file
- All temporary files for a run now live in one session directory under the OS temp directory

## [0.5.0] - 2026-09-22

- Unified delegation, plan, design, review, and implementation under one model-visible `dispatch` skill and script-driven action protocol.
- Retained four familiar slash commands as small user-invoked compatibility aliases.
- Made standalone reviews report-only by default; accepted fixes require explicit `--fix`.
- Consolidated provider candidates, native write subagents, and phase policy into one dispatch config.
- Added shipped-contract terminology enforcement and made CLI `--help` the flag source of truth.
- **Breaking:** v0.4 configs and operational skill interfaces are retired. See the [v0.5.0 migration and decision notes](docs/v0.5.0-release-notes.md).

## [0.4.0] - 2026-09-21

- New `dispatch-design-review` skill: large features can start from a reviewed technical design and ship in reviewed increments
- Interrupted implementation runs can resume where they left off
- More reliable implementation runs, with bounded retries and clearer failure reporting
- Quieter output and lower token use during reviews
- **Breaking:** delegated Claude and OpenCode implementation entries need an explicit `model`; update your config from `config.sample.jsonc`

## [0.3.0] - 2026-09-19

- Major overhaul of the dispatch and review pipelines: simpler flows, less noise, clearer errors, better token efficiency
- Reviews now accept both free-form prose or json reports and reach consensus more reliably
- **Breaking:** configs are no longer bundled — create yours from `config.sample.jsonc` (replaces `config.default.jsonc`)

## [0.2.0] - 2026-09-16

- Initial release of the skill suite: `dispatch`, `implement-dispatch`, `dispatch-plan-review`, `dispatch-code-review`, and the audit skills
- Dispatch tasks across Claude, Copilot, and opencode with automatic platform/model fallbacks
- Plan and code review with multiple independent reviewers and consensus gating
- Built-in test suite and pre-commit skill integrity checks
