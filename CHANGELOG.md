# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-10-06

- Rebuilt `dispatch` on a state-machine driver, so runs recover from interruptions more reliably and fix or revise plans without starting over.
- Task-based plans can run independent tasks in parallel, with each writer in its own isolated worktree.
- Writers follow your repository's rule files, tidy code once tests pass, and can propose plan changes when blocked instead of stopping.
- Run level and scope are double-checked during the run, and the orchestrator reports any judgment calls it made when it finishes.
- Run artifacts stay together in one session folder, and standalone reviews now see the original intent and deliverables.
- Rewritten user guide with workflow diagrams for each verb, plus opt-in diagnostics and live model list refresh.

## [0.6.1] - 2026-09-30

- Implementation runs can resolve unexpected stalls or localized test failures with fast hot fixes instead of heavy restart loops.
- Reverting changes now requires explicit user confirmation, with automatic patch backups saved before any work is discarded.
- Verification and reviews finish faster by skipping redundant checks when files have not changed and limiting re-reviews to applied must-fix items.
- Autonomous review waves run more reliably in the background, recovering smoothly from interruptions without duplicating completed reviews.

## [0.6.0] - 2026-09-29

- Plans, technical designs, and walkthroughs are easier to read and follow, with decisions from early discussions carried into reviews.
- Review and implementation runs handle findings and interruptions more reliably while using less output and fewer tokens.
- Codex can now contribute as a read-only delegate; native subagents are also available when a provider CLI cannot be used.
- Work from each chat stays together in a movable artifact folder, making handoffs and follow-up work easier to manage.

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
