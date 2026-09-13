# dispatch-code-review

Get a rigorous cross-agent second opinion on code changes in your working tree, then adjudicate findings against project truth.

---

## What It Does

Reviewing your own code or relying solely on a single agent often leaves blind spots in domain edge cases, security seams, and architectural drift. `dispatch-code-review` automates cross-agent code review by delegating inspection of recent session changes or working-tree diffs to an external coding-agent CLI (e.g. Claude Code, Antigravity, GitHub Copilot, or OpenCode).

The core philosophy is **claim vs. verdict**:
1. **Delegate produces claims**: An external delegate CLI inspects uncommitted or recent git diffs, adjacent call sites, and attached walkthroughs/plans across six software engineering axes.
2. **Orchestrator adjudicates**: Your primary orchestrator agent (who holds the full conversation context and tool access) verifies every claim against the cited `<file>:L<line>`, active codebase, and repository rules (`AGENTS.md` / `CLAUDE.md`).
3. **Walkthrough & code updated**: Accepted findings are fixed or logged in the walkthrough file on disk under `## Review Findings & Resolutions`, while true ambiguities are escalated interactively to the user.

```mermaid
flowchart TD
    User(["👤 User"]) -->|"1. Request code review"| Orchestrator["🤖 Orchestrator Agent"]
    Orchestrator -->|"2. Dispatches read-only review"| Delegate["🔍 Delegate CLI (6 Axes)"]
    Delegate -->|"3. Structured claims"| Orchestrator
    Orchestrator -->|"4. Adjudicates against code lines"| Codebase[("💻 Active Code & Walkthrough")]
    Orchestrator -->|"5. Final report & resolutions"| User
```

---

## Prerequisites & Installation

### Prerequisites
- **Node.js**: `v18.0.0` or higher.
- **`dispatch` skill installed**: Required for the cross-agent CLI runner.
- **At least one agent CLI** installed or reachable on your system:
  - **Claude Code**: Claude Desktop, VS Code extension, or standalone CLI (`claude`).
  - **Antigravity 2.0**: Antigravity Desktop app, VS Code extension, or CLI (`agy`).
  - **GitHub Copilot**: Copilot CLI or VS Code extension CLI (`copilot`).
  - **OpenCode**: `opencode` binary, configured via `opencode.jsonc` (any provider/model; see `dispatch`).

### Installation

Install `dispatch-code-review` and its core runner into your project workspace:

```bash
# Install both skills
npx skills add Gyunikuchan/dispatch-skills --skill dispatch
npx skills add Gyunikuchan/dispatch-skills --skill dispatch-code-review
```

To install globally for all projects:

```bash
npx skills add -g Gyunikuchan/dispatch-skills --all
```

To install every skill in this repository:

```bash
npx skills add Gyunikuchan/dispatch-skills --all
```

---

## How to Use

Trigger `dispatch-code-review` directly via the slash command `/dispatch-code-review` (or natural language) in your agent chat session. You do not need to call any scripts manually—the agent will assemble context, dispatch the review, adjudicate the findings against your code, update the walkthrough, and, when run standalone, apply accepted must-fix changes to your working tree.

### 1. Basic Code Review

Review current uncommitted working-tree changes (staged, unstaged, and untracked):

```markdown
/dispatch-code-review
```

### 2. Targeting Specific Review Focus Areas

Pass focus areas directly after the command to steer delegate attention:

```markdown
/dispatch-code-review focus on the CPF allocation math and a11y
```

```markdown
/dispatch-code-review focus on auth boundaries, token lifecycle, and error handling
```

### 3. Pinning Reviewer Providers

Fan out to specific external CLIs in parallel with `(<pins>)` — comma-separated provider keys, no level (standalone reviews run a single round):

```markdown
/dispatch-code-review (claude)
```

```markdown
/dispatch-code-review (claude,agy) focus on resource lifecycle and memory leaks
```

### 4. Explicit Context or Walkthrough Targeting

Pass explicit plan or walkthrough paths if you want the review anchored to specific design docs:

```markdown
/dispatch-code-review .scratch/plan/2026-09-08-auth-v2-walkthrough.md
```

---

## High-Level Behavior & Invariants

- **Claim vs. Verdict Separation**: The external delegate's output is strictly a set of *claims*, not an authoritative verdict. Reviewers reading a diff cold often flag things your codebase already handles. The orchestrator independently verifies every defect citation against lines of code before accepting it.
- **Evidence Over Votes**: Multi-provider agreement is context, not evidence. If two delegates flag a non-existent issue, the orchestrator rejects it. If one delegate discovers a valid subtle boundary bug, the orchestrator accepts it.
- **Working-Tree Diff Prioritization**: Uncommitted changes are reviewed first. When everything is already committed, the review covers the whole branch since it diverged from its base — not just the last commit. The exact resolution lives in [references/prompt-template.md](references/prompt-template.md).
- **Walkthrough Resolution & Authoring** (see `dispatch`'s `references/alignment.md` § Plan/Walkthrough Artifact Resolution): *explicit user-provided walkthrough* → *platform-native walkthrough* (e.g. Antigravity's `walkthrough.md`) → *existing scratch walkthrough* matching the branch-derived slug (reused, not re-authored) → *auto-authored* under `.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`.
- **Walkthrough Updated on Disk**: Accepted fixes and adjudication outcomes are recorded directly under `## Review Findings & Resolutions` in the target walkthrough file.
- **Interactive Dispute Escalation**: When a claim touches ambiguous domain intent, trade-offs, or unverified external figures, the orchestrator will pause and ask you via interactive questions (your agent's interactive question tool) before modifying code.
- **Targeted Grounding**: Delegate CLIs perform fast, targeted inspection (checking only modified files, adjacent call sites, and contracts via code graphs) rather than unbounded codebase scans.
- **Artifact Lifecycle**: standalone runs always retain the walkthrough file in place; only an orchestrator owning the full implement-through-review lifecycle relocates scratch artifacts, and only on consensus/completion.

---

## The Six Evaluation Axes

Every code change is evaluated across six rigorous dimensions:

| Axis | Focus Tags | What Is Evaluated |
|---|---|---|
| **Architecture & Module Design** | `shallow`, `seam`, `adapter`, `coupling` | Depth and leverage (small interfaces hiding deep logic vs. shallow pass-throughs); real seams vs. premature indirection; private internal seams; dependency tier separation. |
| **Domain & Business Logic** | `domain-logic`, `invariant`, `unit`, `math`, `runtime`, `type` | Domain rule adherence (`AGENTS.md` / `CLAUDE.md`); invariant preservation across mutations; unit/sign alignment (monthly vs. annual, inflow vs. outflow); formula accuracy; unguarded indexing (`arr[0]`); floating promises. |
| **Security & Resource Safety** | `vuln`, `auth`, `leak`, `perf` | Vulnerabilities (injection, path traversal, escaping, secrets); auth/permission bypasses; unclosed handles/connections; memory/goroutine leaks; quadratic operations on hot paths. |
| **Simplicity & Anti-Bloat** | `yagni`, `reuse`, `stdlib`, `root-cause` | Simplicity ladder (YAGNI/delete → reuse codebase helpers → stdlib/native platform → shortest diff); root-cause fixes at source over call-site patches. |
| **Blast Radius & Compatibility** | `breaking`, `compat`, `migration`, `scope-creep` | Backwards compatibility for callers; schema/data migration safety; serialized format handling; unrequested changes or diffs exceeding task boundaries. |
| **Test Quality & UI/UX** | `test-gap`, `test-leak`, `ui`, `a11y` | Observable outcome assertions at interface seams; missing failure-mode tests; leaky internal test coupling; visual hierarchy; responsive layout; a11y compliance; API ergonomics. |

---

## Finding Grammar & Adjudication Table

### Standard Finding Grammar

Every finding returned by the reviewer follows a strict single-line grammar citing an exact path and line number:

```
<file>:L<line> — <tag>: <defect> → <required change>
```

The full delegate prompt lives in [references/prompt-template.md](references/prompt-template.md), and the structure used when a walkthrough is auto-authored in [references/walkthrough-template.md](references/walkthrough-template.md); edit those files to customize either.

A finding looks like this in practice:
```
src/domain/cpf.ts:L118 — unit: annual ceiling compared against a monthly wage → divide the ceiling by 12, or lift the wage to annual.
```

The full report skeleton — every heading, in order — lives in [references/prompt-template.md](references/prompt-template.md).

### Adjudication Decision Table

Every claim is checked against the code it cites and then accepted, rejected, downgraded, or marked disputed — and whichever way it goes, the outcome is logged under `## Review Findings & Resolutions` in the walkthrough. A disputed claim is one the code alone cannot settle (intent, a trade-off, an unverified figure); standalone runs put it to you, while an orchestrated run returns it for the orchestrator's consensus rule to handle. The exact criteria, the resolution order, and the escalation mechanics live in one place — `dispatch`'s `references/alignment.md` § Adjudication — rather than being restated here, where they drift.

---

## Nuances, Quirks & Troubleshooting

### Self-Skipping Runner Behavior
By default, the underlying `dispatch` runner avoids delegating to the orchestrator's own platform (e.g. Claude Code will not dispatch to Claude Code) to ensure a genuinely independent second opinion. With one CLI installed, pin it explicitly (`/dispatch-code-review (claude)`), even from the same platform, or let the review fall back to a read-only subagent.

### Inspecting Uncommitted Diffs
Delegates run in a structurally read-only mode and inspect the current working tree (`git diff`, `git diff --staged`, and untracked files). Ensure your changes are saved to disk before triggering review.

### Working on `main` or a Detached HEAD
The walkthrough path's slug normally comes from your branch name, which is what lets a plan review today and a code review tomorrow land on the same pair of files with no coordination. On a protected branch (`main`, `master`, `develop`, `trunk`) or a detached HEAD, a branch slug would collide across unrelated work, so the slug falls back to your conversation id — meaning only *this* session finds that walkthrough automatically; a later session needs the path or an explicit `--slug`. Under OpenCode, which exposes no conversation id, both derivations fail on a protected branch and the resolver exits non-zero: pass `--slug <kebab-case-slug>`, or give the walkthrough path directly.

### No Reviewer Available
If every configured platform is missing, unauthenticated, or out of quota, the dispatch fails with `NO_DISPATCH_AVAILABLE` and the review falls back to an in-process read-only subagent on your own platform. Its findings are prefixed `[Subagent Fallback]` — that prefix means the second opinion came from the same model that wrote the code, so it is a self-check rather than a genuinely independent review. Treat those findings with more scepticism, and re-run with a real delegate once one is reachable.

### Host Convention Reading
Delegates do not require manual rule configuration. They automatically inspect the workspace's `AGENTS.md` or `CLAUDE.md` to evaluate repository-specific idioms, architectural constraints, and coding standards.

### A Standalone Review Edits Your Working Tree
Run on its own, this skill does not stop at reporting: it applies the fixes it accepts, re-runs your project's verify command until green, and updates the walkthrough on disk. Delegates stay read-only throughout — the edits come from the orchestrator, after it has verified each claim against the cited lines. Accepted findings it does not apply are listed under `## Follow-ups` in the walkthrough rather than dropped. Commit or stash anything you want protected first, and review the resulting diff as you would any other change. Driven by an orchestrating skill instead, the review applies nothing itself — the orchestrator owns its own fix step.

### Reviewing Transient Antigravity Walkthroughs
When running inside Antigravity, the orchestrator picks up the active `walkthrough.md` and `implementation_plan.md` from the session brain directory — no manual copy or export. One caveat: it identifies the session exactly only when `ANTIGRAVITY_CONVERSATION_ID` is set. Without it, the lookup falls back to whichever conversation directory was touched most recently, which can belong to a different session if several are open. Check the resolved paths in the run banner, or pass them explicitly, when more than one Antigravity conversation is live.
