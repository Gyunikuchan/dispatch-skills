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

Resolve `<skills-dir>` as `dispatch` does (the parent of the loaded skill directory; see `dispatch` Step 2).

Outputs JSON: `{ slug, slugSource, date, plan?: { tier, path, exists }, walkthrough?: { tier, path, exists } }`, where `tier` is `native`, `scratch-existing`, or `scratch-new`, and `slugSource` is `explicit`, `branch`, or `conversation`.

### Slug: derived, not chosen

`--slug` is optional; pass it only when the user names one. Otherwise the script derives it, in order:

1. **Branch**: the current git branch name (a `feature/`, `fix/`, `chore/`, etc. prefix is stripped, the remainder kebab-cased). This is what lets two independent invocations — a plan review today, a code review tomorrow, no orchestrator in between — land on the same file without any coordination: same branch, same derived slug, same resolved path.
2. **Conversation**: on a protected branch (`main`, `master`, `develop`, `trunk`) or detached HEAD, where a branch slug would collide across unrelated changes, `conversation-<first 8 chars>` of the active orchestrator's conversation id. Only this conversation finds that artifact automatically; a later session needs the path or slug.

Derivation fails (script exits non-zero) only when both fail — e.g. OpenCode, which exposes no conversation id, on a protected branch. Pass `--slug <kebab-case-slug>` explicitly then. An explicit user- or orchestrator-supplied path always takes priority over derivation.

### Consuming skills

- `implement-dispatch` runs the script once at Step 1 and reuses the resolved paths for the whole run; `resolve-flow.mjs` takes no artifact inputs.
- `dispatch-plan-review` / `dispatch-code-review`, run standalone, call the same script, so a standalone review lands on the same artifact an `implement-dispatch` run (or an earlier standalone review) already produced.

## Invocation

Base grammar, shared by both standalone review skills:

```
/<review-skill> (<pins>) [<artifact path>] [<focus>]
```

- `(<pins>)` — comma-separated provider keys (`claude`, `agy`, `copilot`, `opencode`), or `dispatch`'s `--provider` aliases (e.g. `antigravity`, `claudecode`), normalized to the canonical key. No level: standalone reviews run a single round.
- **No pins**: fall back to `dispatch`'s default cascade (one dispatch, cascading through providers on failure).
- **Pins given**: fan out one backgrounded `dispatch --provider <key>` per pin, in parallel — never `--no-config`, so model/effort come from `dispatch`'s own config for each pinned provider.
- A failed pin falls back to `dispatch`'s in-process read-only subagent (Step 3's table) for that pin only — never substituted with another platform, since a pin names a delegate the user specifically asked for.
- `implement-dispatch` extends this grammar with `<level>`, `: <ask>`, and pinning `all` across configured platforms (unavailable in standalone reviews; see its own `## Invocation`); its round/consensus mechanics are its own, not part of this base grammar.

## Invocation Modes

Detection: a review skill runs **orchestrated** when an orchestrating skill hands over an artifact path plus a **targets** list (`{ platform, model?, effort?, allowSameAgent? }` entries), with `Review Scope` and `Tool Turn Budget`; otherwise it runs **standalone**. The orchestrator hands over data only; the review skill builds invocations, fills its prompt, and owns the round log.

| Review step | Standalone | Orchestrated |
|---|---|---|
| Resolve artifact paths | Run resolver | Skip — use handed-over path |
| Author artifact if absent | Yes (skill template) | No — orchestrator authored it |
| Build dispatch invocations | From pins / cascade (§ Invocation) | One backgrounded `dispatch --provider <platform> --no-config [-m <model>] [-e <effort>] [--allow-same-agent] --prompt-file <filled>` per handed-over target |
| Populate prompt template | Yes (§ Prompt Template Filling) | Yes (§ Prompt Template Filling; uses the handed-over Review Scope / Tool Turn Budget) |
| Adjudicate (shared table) | Yes | Yes |
| Escalate disputes | Immediately | Per orchestrator's consensus rule |
| Fold findings + log resolutions | Yes | Yes — the review skill appends the round log in both modes; an orchestrator only rewrites its ruled `[Disputed]` lines to `[Resolved Dispute]` |
| Apply code fixes (code review) | Yes | No — orchestrator applies (its fix step) |
| Report to user | Full report | None — orchestrator's handoff covers it |
| Artifact lifecycle | Retain in place | Orchestrator decides |

**Target → flag mapping** (orchestrated): `--provider <target.platform> --no-config`; add `-m <target.model>`, `-e <target.effort>`, and `--allow-same-agent` only when the target carries `model`, `effort`, or `allowSameAgent: true`. Attach context with `-f "<path>"` and pass the filled prompt with `--prompt-file "<path>"` instead of `-p`/positional.

## Prompt Template Filling

How the two review skills turn their `## Prompt template` block into a concrete dispatch prompt, without an ad-hoc extraction script or shell-quoting a multi-line, backtick-heavy prompt.

Each review skill owns its template in its own `references/prompt-template.md` (skill-owned, not shared); `dispatch` holds no template content. `tests/integration/review-skill-parity.test.mjs` guards drift between the two.

### Script

```bash
node <skills-dir>/dispatch/scripts/fill-template.mjs --skill <skills-dir>/<review-skill>/references/prompt-template.md \
  [--section "Prompt template"] (--var Name=Value)... [--vars <json file>] [--out <path>] [--list]
```

Resolve `<skills-dir>` as `dispatch` does (the parent of the loaded skill directory; see `dispatch` Step 2).

- **Variable derivation**: required variables are the backtick-quoted `` `<Name>` `` bullets between the `Prompt template` heading and its fenced block — read directly off the template file, never hand-maintained. `--list` prints them as a JSON array.
- **Fill**: `--var Name=Value` (repeatable) or `--vars <json file>` (a JSON object of strings; supports multi-line values, e.g. a verbatim `<Requirement>`) supplies every declared variable; `--var` wins over `--vars` on a name collision. Substitution is single-pass over declared names only, so a supplied value is never re-scanned and ungoverned grammar placeholders in the template body (`<file>:L<line>`, `<tag>`, `<axis>`, `<Section>`) are left untouched.
- **Output**: `--out <path>` writes the filled prompt (recommended: `.scratch/plan/<date>-<slug>-<kind>-review-prompt[-<target>].md`) and prints the path; omitted, the filled prompt prints to stdout.

### Dispatching the filled prompt

Pass the written file straight to `dispatch` with `--prompt-file <path>` (see Runner Flags Reference) instead of the prompt on argv — this avoids re-quoting a multi-line, backtick-heavy prompt through the shell. `--prompt-file` cannot combine with `-p` or a positional prompt.

## Adjudication

Scope: adjudicate every actionable claim (a proposed defect, cut, or recommendation). Discard passing axes, clean verdicts, and praise immediately.

| Verdict | Criterion | Action |
|---------|-----------|--------|
| **Accept** | Requirement, repository rule, or cited code confirms the defect | Fold into the artifact and log per § Resolutions Log |
| **Reject** | Contradicted by the artifact/code, target locus missing, already addressed, uncited, or unverifiable | Drop from changes; log rejection |
| **Downgrade** | Real but trivial — style, taste, or speculative | Fold into next steps / Out of Scope or drop; log |
| **Disputed** | Unsettleable from the artifact or code alone (intent, unverified external figures, deliberate trade-offs) | Escalate per Invocation Modes |

**Evidence over votes**: when aggregating multi-delegate reports, dedupe duplicate claims pointing to the same defect at the same locus into a single finding, then verify against the requirement, repository rules, and cited code. Accept valid findings regardless of delegate count; reject refuted findings even if unanimous. Provider agreement is context, never evidence.

**Dispute escalation**: query the user via interactive question tool (`ask_question` / `AskUserQuestion`) before applying a **Disputed** finding. Batch up to 4 questions per invocation (successive batches for more); quote the locus, state the delegate's claim, and provide a counter-reading with accept / reject / defer options. Apply the user's choice verbatim as final. Mandatory escalation triggers: repository-named domain authorities, persisted schema, shared URL state, or an explicit user request. In orchestrated mode, escalation instead defers to the orchestrator's consensus rule — return Disputed findings unescalated to the caller (see § Resolutions Log).

## Resolutions Log

Append this round's complete adjudication log under `## Review Findings & Resolutions` in the artifact (create the heading at the end of the artifact when absent), one line per finding:

- `- **[Accepted]** <locus> — <tag>: <defect> → <resolution & where applied>`
- `- **[Resolved Dispute]** <locus> — <tag>: <defect> → <user ruling & action>`
- `- **[Rejected / Downgraded]** <locus> — <tag>: <defect> → <rejection rationale>`
- `- **[Disputed]** <locus> — <tag>: <defect> → <counter-reading>` — orchestrated mode only, for a dispute returned unescalated to the orchestrator's own consensus loop. Rewritten as `[Resolved Dispute]` once the orchestrator rules on it.

## User Report

Standalone mode only (orchestrated mode reports nothing — the orchestrator's own handoff covers it). Prefix with the provider label from the dispatch result, including session deep-link or resume command when available:

1. **Verdict**: one line — readiness as amended.
2. **Accepted findings**: each in delegate grammar, MUST-FIX first.
3. **Next steps**: prioritized items deferred to next steps / Out of Scope.
4. **Adjudication note**: one line summarizing rejected/downgraded counts and dispute resolutions (omit when all findings were accepted without dispute).
5. When the resolved slug's `slugSource` is `conversation`, add one line noting a later session won't find the artifact unless given the path or slug.

## Artifact Lifecycle

Standalone reviews always retain their artifact in place. Only an orchestrator owning the full review-and-implement lifecycle relocates scratch artifacts to the OS temp directory, and only on consensus/completion — a standalone review has no later phase to hand the artifact to, so moving it would strand the next invocation's lookup.

<!-- Add further shared conventions for these three skills as new `## <Topic>` sections above this comment. -->
