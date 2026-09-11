# Skill Alignment: implement-dispatch, dispatch-plan-review, dispatch-code-review

Conventions shared by `implement-dispatch`, `dispatch-plan-review`, and `dispatch-code-review` so independent invocations of these three skills converge instead of drifting apart — whether run together in one flow or invoked separately in separate sessions. Not general `dispatch` usage; other callers have no reason to read this file. Consuming skills reference each topic below by name rather than restating it.

## Plan/Walkthrough Artifact Resolution

How the three skills locate or author the plan and walkthrough files they read and write.

### Resolution order

Host convention still wins outright: when the repo's `AGENTS.md` / `CLAUDE.md` names an explicit plan/walkthrough path or directory, use it and stop — the tiers below don't apply.

Otherwise, resolve each artifact kind (`plan`, `walkthrough`) independently in this order, and reuse whatever is found — never author a second copy of the same artifact:

1. **Native tier**: the orchestrator platform's own artifact (e.g. Antigravity's `<appDataDir>/brain/<conversation-id>/implementation_plan.md` / `walkthrough.md`). Only scanned when the orchestrator actually is a platform with a known native artifact (currently `agy`) — running under Claude Code or any other platform skips this tier entirely rather than risk surfacing an unrelated session's file. When the active conversation id is known (`ANTIGRAVITY_CONVERSATION_ID`), that exact directory is checked; otherwise a same-platform newest-mtime guess across every conversation is a best-effort fallback.
2. **Scratch-existing tier**: an already-authored `.scratch/plan/<yyyy-mm-dd>-<slug>.md` (or `-walkthrough.md`) matching the resolved slug, regardless of date — a code review run the day after planning must still find yesterday's plan.
3. **Scratch-new tier**: no artifact exists yet. Author one at the deterministic `.scratch/plan/<yyyy-mm-dd>-<slug>.md` path following the consuming skill's template.

### Script

```bash
node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs [--slug <kebab-slug>] [--date <yyyy-mm-dd>] [--kind plan|walkthrough|both] [--orchestrator <name>]
```

Resolve `<skills-dir>` as `dispatch` does (`.agents/skills`, `.claude/skills`, or `~/.agents/skills`).

Outputs JSON: `{ slug, date, plan?: { tier, path, exists }, walkthrough?: { tier, path, exists } }`, where `tier` is `native`, `scratch-existing`, or `scratch-new`.

### Slug: derived, not chosen

`--slug` is optional. When omitted, it is derived deterministically from the current git branch name (a `feature/`, `fix/`, `chore/`, etc. prefix is stripped, the remainder kebab-cased). This is what lets two independent invocations — a plan review today, a code review tomorrow, no orchestrator in between — land on the same file without any coordination: same branch, same derived slug, same resolved path.

Derivation fails (script exits non-zero) on a protected branch name (`main`, `master`, `develop`, `trunk`) or detached HEAD, since a slug derived there would collide across unrelated changes. Pass `--slug <kebab-case-slug>` explicitly in that case — an explicit user- or orchestrator-supplied path always takes priority over derivation regardless.

### Consuming skills

- `implement-dispatch` resolves the slug once at Step 1 and reuses it for both `resolve-artifact-paths.mjs` and `resolve-flow.mjs --slug`.
- `dispatch-plan-review` / `dispatch-code-review`, run standalone, resolve the slug the same way before calling the script, so a standalone review lands on the same artifact an `implement-dispatch` run (or an earlier standalone review) already produced.

<!-- Add further shared conventions for these three skills as new `## <Topic>` sections above this comment. -->
