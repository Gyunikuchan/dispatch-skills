# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-09-25

- Unified delegation, planning, design, review, and implementation under the `dispatch` skill, while retaining familiar slash commands as compatibility aliases.
- Implementation runs need less supervision: `--drive` advances reviews and verification until a decision is needed, with faster, more focused checks and easier recovery from failures or interruptions.
- Standalone reviews are report-only by default, require `--fix` to apply accepted changes, and use finding severity to decide whether to continue.
- Added a brainstorming skill for exploring requirements before implementation.
- **Breaking:** v0.4 configs and operational skill interfaces are retired; use `/dispatch-implement` instead of `/implement-dispatch`, and upgrade OpenCode integrations to CLI v2 and the updated config format (see `config.sample.jsonc`).

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
