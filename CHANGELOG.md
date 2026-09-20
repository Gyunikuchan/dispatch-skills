# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Breaking:** delegated Claude and OpenCode implementation entries must resolve an explicit
  `model`; copy the updated `implement-dispatch/config.sample.jsonc` shape before invoking them.
- Implementation delegates now return typed outcomes and use bounded native-only escalation:
  three attempts for delegated targets and two for self execution.

## [0.3.0] - 2026-09-19

- Major overhaul of the dispatch and review pipelines: simpler flows, less noise, clearer errors, better token efficiency
- Reviews now accept both free-form prose or json reports and reach consensus more reliably
- **Breaking:** configs are no longer bundled — create yours from `config.sample.jsonc` (replaces `config.default.jsonc`)

## [0.2.0] - 2026-09-16

- Initial release of the skill suite: `dispatch`, `implement-dispatch`, `dispatch-plan-review`, `dispatch-code-review`, and the audit skills
- Dispatch tasks across Claude, Copilot, and opencode with automatic platform/model fallbacks
- Plan and code review with multiple independent reviewers and consensus gating
- Built-in test suite and pre-commit skill integrity checks
