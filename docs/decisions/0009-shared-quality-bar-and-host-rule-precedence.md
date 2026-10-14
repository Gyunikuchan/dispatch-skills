# ADR 0009: Shared quality bar and host-rule precedence

- **Status**: Accepted
- **Date**: 2026-10-15
- **Audience**: Maintainers
- **Spec**: `skills/dispatch/references/templates/quality-bar.md`, `skills/dispatch/references/templates/review-prompt.md`, `skills/dispatch/references/templates/write-brief.md`, `skills/dispatch/scripts/domain/prompt.ts`

## Context

Native writers and code reviewers applied different code quality standards. The code review prompt carried the quality rules: the existing-equivalent search and tool-enforced-issue skip in `review-prompt-code.md` `## inspection`, and the simplicity order, security and resource list, durable test bar, and plan-ID ban in its `## tags` glosses. The write brief stated conventions in one line: read `AGENTS.md` / `CLAUDE.md` and report a conflict with the brief under concerns. Writers learned the reviewer's rules only from findings, and each such finding cost a fix round.

No prompt stated how host rule files rank against dispatch defaults. A reviewer could flag code that followed a host rule because it contradicted a dispatch default, and a writer had no rule for which standard to follow.

Prompt assembly already had one mechanism: `assembleTemplate(frame, kind)` in `domain/prompt.ts` fills each frame `<<slot:NAME>>` from the kind block's `## NAME` section, and throws on a slot without a section or a section without a slot.

## Decision

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | One canonical quality-bar block, `references/templates/quality-bar.md` `## quality`, rendered into task and hot-fix write briefs and the code review prompt. Code reviewer kind blocks keep only the tag mapping and refer to the bar's rules. | Writers and reviewers see the same rules from one source, so writers meet the bar before review instead of after a finding. One home prevents the two copies from drifting. | Link-only reference (writers may skip a link; the rules must be in context); copied text in each template (copies drift) |
| D2 | Precedence: host rule files (`AGENTS.md` / `CLAUDE.md`; the nearest nested file wins over its parent), then the dispatch quality bar, then preference. | The host repository owns its conventions; dispatch defaults fill gaps and must not override a deliberate local choice. A nested file is the more specific rule for its paths. | Dispatch bar over host rules (forces host repositories to conform to dispatch); no stated order (writers and reviewers resolve conflicts differently) |
| D3 | Host rules override only the quality bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding. | Scope, boundaries, protocol, and safety protect acceptance and the caller checkout; a repository file must not widen them. Reporting the conflict keeps the decision with the orchestrator. | Host rules override the whole brief (a host file could expand write scope or skip verification); silent writer resolution (hides the conflict from the orchestrator) |
| D4 | Review: code that follows a host rule is not a finding, even when it contradicts a dispatch default. Where host rules are silent, dispatch defaults apply and violations are findings. Each review kind states this once: code reviews through the quality bar, plan and design reviews through their kind block (D5). | Applies D2 at review time and removes findings that only restate a dispatch preference over a host rule. Dispatch defaults keep their force where the host has no rule. | Dispatch defaults always produce findings (contradicts D2); host rules suppress all dispatch defaults (no bar where the host is silent) |
| D5 | The code quality bar renders only into task and hot-fix write briefs and the code review prompt. Plan and design reviews do not receive the code bar; their kind blocks fill `## quality` with one host-precedence line instead. Each review kind carries the precedence wording exactly once. | The bar targets code. Code rules in plan and design prompts add tokens and invite off-target findings. | Render the bar into every review kind; a separate frame per audience |
| D6 | `assembleTemplate` takes an optional trailing `shared: readonly string[]` of extra kind-block Markdown. Their `## NAME` sections merge with the kind block's sections; a section name declared twice across all inputs throws. | Reuses the existing slot contract; the duplicate check prevents a shared section from silently overwriting or being overwritten by a kind-block section. | String concatenation of files before parsing (a file's title line leaks into the previous section) |
| D7 | Driver-specific writer rules stay in `write-brief-task.md` (RED checkpoint, `RED-MATRIX` naming of driver checks, writer never changes `Retain:`). Generic rules there that duplicated the bar (helper search, durable-bar self-check, behavior-named tests) become references to the quality bar. | Keeps one home per rule: the bar holds generic code quality, the task kind block holds driver protocol. | Move driver rules into the shared bar (reviewers would receive writer-only protocol) |

## Consequences and trade-offs

| Concern | Benefit | Cost or limitation |
| --- | --- | --- |
| Fix rounds | Writers self-check against the reviewer's rules before submission, so fewer findings need a fix round. | The reduction is not measured. |
| Prompt size | Plan and design reviews do not carry the code bar. | Each task and hot-fix write brief grows by about 250 tokens. |
| Single source | One edit to `quality-bar.md` changes writers and code reviewers together; the duplicate-section throw catches a forked copy at assembly. | A rule that needs different writer and reviewer wording must split into the bar plus a kind-block note. |
| Host conventions | Host repositories keep their conventions; reviews no longer flag host-compliant code against dispatch defaults. | A weak or wrong host rule overrides a stronger dispatch default; reviewers report a defective convention once instead of each instance. |
| Safety boundaries | Plan scope, write boundaries, protocol, and safety rules stay outside host-rule override. | Writers must report, not resolve, host-rule conflicts with the brief, which can add an orchestrator decision. |
| Assembly contract | `assembleTemplate` callers without shared inputs are unchanged. | Every shared section name must be unique across the kind block and all shared inputs. |
