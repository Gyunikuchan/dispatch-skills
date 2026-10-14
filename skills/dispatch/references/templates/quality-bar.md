# Code quality bar (shared block)

Shared kind block: `domain/prompt.ts` `assembleTemplate` merges its `## quality` section into task and
hot-fix write briefs and the code review prompt. Keep these rules here only; frames and kind blocks
reference them.

## quality

Code quality bar (shared by writers and code reviewers):
- Precedence: host rule files (`AGENTS.md` / `CLAUDE.md`; the nearest nested file wins over its parent), then this bar, then preference. Code that follows a host rule is not a finding, even when it contradicts this bar. Where host rules are silent, this bar applies.
- Host rules override only this bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- Simplicity: prefer, in order, delete, reuse, stdlib, then new code.
- Reuse: for each new exported or shared symbol, search the repository by name and behaviour for an existing equivalent; reuse a match instead of adding the symbol.
- Security and resources: prevent injection, traversal, missing escaping, exposed secrets, and auth bypass; check object ownership (IDOR); put no sensitive data in logs or errors; close handles; bound memory and concurrency; never block the event loop; avoid hot-path quadratics, N+1 queries, and unpaginated reads; index new filter or sort columns.
- Tests: assert observable outcomes at seams, not internals, and cover failure modes. Each retained (`Retain: durable`) test meets the durable bar in the plan template; implementation steps, internals, no named regression, or redundancy with another retained test fail it. A test that fails the bar is rewritten to meet it, demoted to transient, or deleted when redundant.
- Test naming: name tests, describe blocks, test files, comments, section headers, and fixtures for behavior; never reference plan artifacts (criterion, task, or finding IDs; plan or session paths).
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.
