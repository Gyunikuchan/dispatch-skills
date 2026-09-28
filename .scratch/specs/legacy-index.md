# Legacy code and reference index

**Snapshot:** 2026-09-28, current working tree. Existing uncommitted changes were present and are included in the scan.

**Scope:** Dispatch source, docs, tests, root guidance, and repository-authored `.agents` skills. I used CodeGraph first, then text searches and inspected candidate source/tests. Existing `.scratch` contents, `.git`, `.codegraph`, and dependencies were not scanned. This is a targeted legacy inventory, not the full platform audit; no tests or live provider probes were run.

The only file created by this scan is this index. Do not commit it unless requested; `AGENTS.md` says not to commit `.scratch/` files by default.

## High confidence stale references: dated artifact filenames

The current uncommitted changes in `skills/dispatch/scripts/artifacts/resolve-paths.mjs` remove date-prefixed canonical artifact names, `--date`, date extraction, the any-date lookup, and the off-date collision scan. Related tests now expect slug-only filenames. The remaining docs/comments below still show or describe the old filename shape.

| Location | Finding | Suggested follow-up |
| --- | --- | --- |
| `README.md:131,152`; `skills/dispatch/README.md:128-129` | Resume examples use `artifacts/2026-09-22-…` / `artifacts/2026-09-24-…` filenames. | Update examples to the current slug-only artifact paths. |
| `skills/dispatch/references/readme/verbs.md:129-130,156-157` | Review and implement examples also use date-prefixed filenames. | Update with the same canonical path format. |
| `skills/dispatch/scripts/review/preparation.mjs:114-116` | `slugFromPath` is described as reading a “dated” filename, but the current regex matches the slug-only form. | Remove “dated” from the JSDoc; decide separately whether explicit old paths should remain accepted. |

Current working-tree changes already cover `skills/dispatch/scripts/artifacts/resolve-paths.mjs`, `tests/skills/dispatch/artifacts/artifact-resolution.test.mjs`, and `tests/skills/dispatch/review/preparation.test.mjs`. The implementation now builds and discovers slug-only names. Explicit user-supplied paths to older files were not exercised in this scan.

## Runtime behavior to decide before removal

| Location | Current behavior | Removal consideration |
| --- | --- | --- |
| `skills/dispatch/scripts/runners/opencode.mjs:827-844` | Reads both project-root `opencode.json`/`.jsonc` and `.opencode/` config files. The comment at `830-834` explicitly says the root files serve repos that have not migrated to `.opencode`. | This is the clearest remaining migration compatibility path. Confirm OpenCode's supported config precedence and whether root-level files should stop being read; update the corresponding config-resolution tests and provider docs if removed. |
| `skills/dispatch/scripts/review/resolution-log.mjs:28-36`; `tests/skills/dispatch/review/resolution-log.test.mjs:215-225` | Normalizes em/en dashes and accepts one or more hyphens in “Rejected — pending confirmation”. | Input-tolerance compatibility. Decide whether reviewer-produced logs should accept only the canonical spelling. |
| `skills/dispatch/scripts/review/resolution-log.mjs:556,615-616`; `tests/skills/dispatch/review/resolution-log.test.mjs:207-212` | `findUnsettledResolutionLines` uses non-strict parsing; a test preserves conservative results for malformed/duplicate sections. | A malformed-input recovery path, not clearly an old schema. Check callers before removing it. |
| `skills/dispatch/references/providers.md:40-46,70-75`; runner tests under `tests/skills/dispatch/runners/claude.test.mjs` and `copilot.test.mjs` | Documents and tests `--no-sandbox` opt-outs and one unsandboxed retry when a CLI reports sandbox support is unavailable. OpenCode also accepts `--no-sandbox` in `skills/dispatch/scripts/runners/opencode.mjs:1852-1860`. | Current provider-version/platform fallback and user option, rather than historical file-format support. Remove only if the intended cleanup includes dropping this behavior. |

## Historical or rejection-only references

| Location | Why it appears | Suggested handling |
| --- | --- | --- |
| `tests/skills/dispatch/lib/config.test.mjs:128-130` | Negative test named “rejects the obsolete design-review policy key”; the key is rejected, not supported. | Keep as a rejection guard, or rename/generalize if the goal is only to remove obsolete terminology. |
| `docs/decisions/0001-strict-dispatch-config-format.md:3-19` | Accepted decision records the prior permissive config and explicitly says no automatic migration is provided. | Historical decision record; not evidence of a migration path in current code. |
| `CHANGELOG.md:12,16`; `skills/dispatch/references/providers.md:83-87`; `skills/dispatch/scripts/runners/opencode.mjs:40-41,1786-1787,1929` | Historical release note and current support-boundary text state that old dispatch interfaces/configs and OpenCode v1 flags are retired or unsupported. | Documentation-only references to removed support. Keep if users need upgrade history/support boundaries; remove only if the requested cleanup includes history and explanatory negatives. |
| `.agents/skills/brainstorming/scripts/stop-server.sh:63-65` | Comment says ambiguous or legacy PID metadata fails closed as stale. The behavior rejects/removes stale metadata; it does not resume an old format. | Terminology-only candidate; preserve the fail-closed behavior. |

## Intentional compatibility that the repo guide says to keep

`AGENTS.md:35-49` defines the four companion skills as user-invoked aliases to `dispatch`; `CHANGELOG.md:12` and `docs/dispatch-implement-notes.md:3` describe the same interface. These are current public entry points, not accidental legacy code. Keep them unless the user separately changes the architecture.

## Search hits not classified as legacy support

- `skills/dispatch/scripts/ledger/events.mjs:141-143,302-311` actively validates ledger v1 ordinary segments and v2 phased segments; the tests cover both. The version numbers are current protocol versions, not proof of an obsolete compatibility branch.
- `skills/dispatch/scripts/runners/opencode.mjs` references to `/v1` are OpenAI-compatible HTTP endpoints. Its v1 CLI references explicitly say no fallback is supported.
- “Migration”, “compatibility”, and “rollback” in review axes, design templates, and example requirements describe current review work, not prior dispatch formats.
- `.agents/skills/brainstorming/SKILL.md` uses date-stamped design-spec filenames for that skill's own output; this is separate from dispatch artifact naming.
- The `.scratch/dispatch-skills/` workspace root documented in `skills/dispatch/references/review.md`, `skills/dispatch/references/templates/plan.md`, and `docs/decisions/0003-chat-session-artifact-lifecycle.md` matches the current workspace-session lifecycle. Only the date-prefixed artifact filenames above appear stale.
