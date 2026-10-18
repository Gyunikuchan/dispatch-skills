# ADR 0009: Shared quality bar and host-rule precedence

- **Status**: Accepted
- **Date**: 2026-10-15
- **Audience**: Maintainers
- **Spec**: `skills/dispatch/references/templates/quality-bar.md`, `skills/dispatch/references/templates/review-prompt.md`, `skills/dispatch/references/templates/write-brief.md`, `skills/dispatch/scripts/domain/prompt.ts`

## Context

Native writers and code reviewers applied different code quality standards. The code review prompt carried the quality rules: the existing-equivalent search and tool-enforced-issue skip in `review-prompt-code.md` `## inspection`, and the simplicity order, security and resource list, durable test bar, and plan-ID ban in its `## tags` glosses. The write brief stated conventions in one line: read `AGENTS.md` and report a conflict with the brief under concerns. Writers learned the reviewer's rules only from findings, and each such finding cost a fix round.

No prompt stated how host rule files rank against dispatch defaults. A reviewer could flag code that followed a host rule because it contradicted a dispatch default, and a writer had no rule for which standard to follow.

Prompt assembly already had one mechanism: `assembleTemplate(frame, kind)` in `domain/prompt.ts` fills each frame `<<slot:NAME>>` from the kind block's `## NAME` section, and throws on a slot without a section or a section without a slot.

## Decision

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | One canonical `quality-bar.md` with `shared`, `code`, `plan` and `design` sections. Criteria have one home; prompts retain tag taxonomy and reference the bar. | Authors, writers and reviewers receive the same applicable rules before work. | Copies in each prompt; reviewer-only criteria |
| D2 | Precedence: host rule files (`AGENTS.md`; the nearest nested file wins over its parent), then the dispatch quality bar, then preference. | The host repository owns its conventions; dispatch defaults fill gaps and must not override a deliberate local choice. A nested file is the more specific rule for its paths. | Dispatch bar over host rules (forces host repositories to conform to dispatch); no stated order (writers and reviewers resolve conflicts differently) |
| D3 | Host rules override only the quality bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding. | Scope, boundaries, protocol, and safety protect acceptance and the caller checkout; a repository file must not widen them. Reporting the conflict keeps the decision with the orchestrator. | Host rules override the whole brief (a host file could expand write scope or skip verification); silent writer resolution (hides the conflict from the orchestrator) |
| D4 | Every consumer receives host-rule precedence through `shared`; host-compliant content is not a finding, while defaults apply where host rules are silent. | One precedence home preserves D2 across kinds. | Repeating precedence in kind blocks |
| D5 | **Superseded:** the original code-only rendering decision is replaced by the consumer map below. | Plan/design authors need the criteria used to review their proposals; plan authors/reviewers also need code criteria to assess planned changes. | A second artifact bar that duplicates shared rules |
| D6 | `assembleTemplate` takes an optional trailing `shared: readonly string[]` of extra kind-block Markdown. Their `## NAME` sections merge with the kind block's sections; a section name declared twice across all inputs throws. | Reuses the existing slot contract; the duplicate check prevents a shared section from silently overwriting or being overwritten by a kind-block section. | String concatenation of files before parsing (a file's title line leaks into the previous section) |
| D7 | Driver-specific writer rules stay in `write-brief-task.md` (RED checkpoint, `RED-MATRIX` naming of driver checks, writer never changes `Retain:`). Generic rules there that duplicated the bar (helper search, durable-bar self-check, behavior-named tests) become references to the quality bar. | Keeps one home per rule: the bar holds generic code quality, the task kind block holds driver protocol. | Move driver rules into the shared bar (reviewers would receive writer-only protocol) |

## Delivered consumer map

| Consumer | Required sections |
| --- | --- |
| Task/hot-fix writer and code reviewer | shared + code |
| Plan author and reviewer | shared + plan + code |
| Design author and reviewer | shared + design |

`domain/prompt.ts` `qualityBar(consumer)` selects these sections for assembled prompts. Author frames name required read sections; authors read them before drafting, including nested authoring. Review kind blocks retain tag vocabulary rather than another criteria copy. The [quality bar](../../skills/dispatch/references/templates/quality-bar.md) owns the criteria and the [author contract](../../skills/dispatch/SKILL.md#await-author) owns required reading. The local [test-optimisation criteria](../../.agents/skills/optimise-tests/references/criteria.md) owns its ledger, coverage dispositions, deletion proof, and packet-specific timing rules and points back to the code bar. [AGENTS.md](../../AGENTS.md) keeps repository-wide test entrypoints, storage guidance, and timing requirements. Spec alignment joins the shared bar; [ADR 0010](0010-canonical-session-intent.md) owns intent semantics. D2/D3's host precedence and safety boundaries remain unchanged.

## Consequences and trade-offs

| Concern | Benefit | Cost or limitation |
| --- | --- | --- |
| Fix rounds | Writers self-check against the reviewer's rules before submission, so fewer findings need a fix round. | The reduction is not measured. |
| Prompt size | Consumers carry shared plus their applicable kind sections. | Plan reviews also carry code criteria; author reading and prompt sizes depend on kind. |
| Single source | One edit to `quality-bar.md` changes all applicable consumers together; the duplicate-section throw catches a forked copy at assembly. | A rule that needs different writer and reviewer wording must split into the bar plus a kind-block note. |
| Host conventions | Host repositories keep their conventions; reviews no longer flag host-compliant code against dispatch defaults. | A weak or wrong host rule overrides a stronger dispatch default; reviewers report a defective convention once instead of each instance. |
| Safety boundaries | Plan scope, write boundaries, protocol, and safety rules stay outside host-rule override. | Writers must report, not resolve, host-rule conflicts with the brief, which can add an orchestrator decision. |
| Assembly contract | `assembleTemplate` callers without shared inputs are unchanged. | Every shared section name must be unique across the kind block and all shared inputs. |
