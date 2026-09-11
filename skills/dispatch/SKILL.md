---
name: dispatch
description: Dispatch a bounded read-only task to another agent CLI (Claude Code, Antigravity, Copilot, OpenCode) with provider fallback. Use on /dispatch or when delegating investigation, research, or review to another agent.
---

# Dispatch

Dispatch a bounded **read-only** task through the agent **cascade** (investigation, research, plan/code reviews). The orchestrator owns the brief, judgment, edits, and commit; the delegate CLI inspects and analyzes.

The cascade order and per-provider model/effort come from [config.default.jsonc](config.default.jsonc) — see [Configuration](#configuration) below. Its shipped default order is:

1. **Claude Code** (`claude`).
2. **Antigravity 2.0** (`agy`).
3. **GitHub Copilot** (`copilot`).
4. **OpenCode** (`opencode`) against whatever provider/model `opencode.jsonc` configures, or opencode's own CLI default when unconfigured — dispatch assumes no particular provider.

A platform omitted from the loaded config is never dispatched, regardless of order. The orchestrator's own platform is skipped (tried last only with `--allow-same-agent`). If every candidate pass is exhausted, fall back to an **in-process subagent** (Step 3 below; runner exits `NO_DISPATCH_AVAILABLE`).

---

## Operating Invariants

- **Structurally read-only**: delegates run with structural enforcement — `--mode plan` (Antigravity, Copilot), `--allowedTools` restricted to read operations (Claude Code) — plus a prompt-level safety guardrail. Dispatch has no write mode; writes belong to the orchestrator or its native subagent. Antigravity additionally passes `--dangerously-skip-permissions` to auto-approve read-only tool requests (file reads, search) in headless mode; write operations stay structurally blocked by `--mode plan` regardless.
- **Context hygiene**: execution logs stream to an OS temp log file; the orchestrator receives only the banner, log path, and final answer (`-v` streams solely to stderr when it is a terminal).
- **Bounded attachments**: `-f` files are capped (128 KB per file, 512 KB total) and wrapped in data delimiters to resist prompt injection; oversized prompts spill to a temp brief file to prevent context or argument-length overflow.
- **Git integrity check**: workspace `git status --porcelain` is compared before and after every delegate run; a mismatch is flagged as a warning. False positives are possible from concurrent IDE/build activity.

---

## Process

### 1. Formulate task and bound context

1. Draft prompt text.
2. Identify context files or artifacts to attach via `-f "<path>"` (forward slashes only).
3. Select flags from [Runner Flags Reference](#runner-flags-reference).

**Done when:** Prompt drafted, `-f` paths validated, and command string constructed.

---

### 2. Dispatch in the background and yield

Run the dispatcher **backgrounded**, then yield the turn. Backgrounding allows the 1800s default timeout to complete safely beyond harness tool-call limits.

Rely on platform defaults (model, reasoning effort, timeout). Pass override flags (`-m`, `-e`, `-t`, `--provider`, `-a`) only when explicitly requested.

```bash
# Antigravity (project-local)
node .agents/skills/dispatch/scripts/dispatch.mjs [flags] "<prompt>"
# Claude Code (project-local)
node .claude/skills/dispatch/scripts/dispatch.mjs [flags] "<prompt>"
# Global install (~/.agents/skills/)
node ~/.agents/skills/dispatch/scripts/dispatch.mjs [flags] "<prompt>"
```

Pick the single line matching the skill installation location.

**Claude Code**: execute with `dangerouslyDisableSandbox: true` (Antigravity's language server TCP socket binding conflicts with the Bash sandbox; read-only safety is structurally enforced by `--mode plan` and restricted `--allowedTools`).

**Pinned provider**: `--provider <name>` (`opencode`, `agy`, `claude`, `copilot`) pins execution and disables cascading on failure.

Yield the turn and await the completion notification.

**Done when:** Dispatch process launched in the background and the turn is yielded.

---

### 3. Fallback gate

Evaluate runner outcome:

- **Success**: capture stdout and session handle, then proceed to Step 4.
- **Truncated** (`WARNING: Output truncated`): use partial output if it fulfills the brief; otherwise re-dispatch a narrowed task.
- **`NO_DISPATCH_AVAILABLE`**: all cascade passes exhausted. Fall back in-process to the platform's read-only subagent, with identical prompt and attachments:

  | Platform | Read-only subagent |
  |----------|---------------------|
  | `claude` | `Explore` |
  | `agy` | `research` |
  | `copilot` | `self` (read-only tool set) |
  | `opencode` | orchestrator executes directly |

  For brief tasks or when subagents are unavailable, execute directly in the current session.

**Done when:** Complete output obtained from delegate stdout, subagent response, or direct execution.

---

### 4. Relay and synthesis

Deliver response to the user prefixed by provider (`[Claude Code]`, `[Antigravity 2.0]`, `[GitHub Copilot]`, `[OpenCode]`, `[Subagent Fallback]`, or `[Direct Execution]`), including captured session deep-link (`conversation://<id>`) or resume command (`claude --resume <id>`, `copilot --resume <id>`) when present.

**Done when:** Output delivered to the user with the appropriate provider prefix.

---

## Runner Flags Reference

| Flag | Description | Example |
|------|-------------|---------|
| `-f <path>` | Attach context file or artifact (repeatable, capped) | `-f "src/domain/types.ts"` |
| `--prompt-file <path>` | Read the prompt from a file instead of `-p`/positional (cannot combine with either) | `--prompt-file "<path to filled prompt>"` |
| `--allow-same-agent` | Permit fallback to orchestrator's own CLI | `--allow-same-agent` |
| `--provider <name>` | Pin provider (`opencode`, `agy`, `claude`, `copilot`; disables cascade) | `--provider agy` |
| `-m <model>` | Override model identifier (user-requested only) | `-m "claude-opus-5"` |
| `-e <effort>` | Override reasoning effort; passed through verbatim to the target CLI (values are platform-specific; user-requested only) | `-e "high"` |
| `-t <sec>` | Override timeout in seconds (default: 1800; user-requested only) | `-t 2400` |
| `--orchestrator <name>` | Override detected orchestrator platform | `--orchestrator claude` |
| `--json` | Request structured JSON output (opencode provider only) | `--json` |
| `-a <name>` | Override agent name (opencode provider only) | `-a delegate` |
| `-v` | Stream live trace (terminal debugging only; suppressed when piped) | `-v` |
| `--no-config` | Skip loading the cascade config entirely; requires `--provider` | `--no-config --provider claude` |
| `--validate-only` | Validate the loaded config and exit (no dispatch) | `--validate-only` |

---

## Configuration

Cascade order and per-provider model/effort come from a JSONC config, loaded wholly (no merging) from the first of, in precedence order: `config.local.jsonc` next to this skill, `config.jsonc` next to this skill, then the shipped [config.default.jsonc](config.default.jsonc). Copy the default and edit a `config.jsonc`/`config.local.jsonc` (both git-ignored) to override it.

Schema: `{ "platforms": { "<claude|agy|copilot|opencode>": { "model"?: string | string[], "effort"?: string } } }`. Key order is cascade order; a platform key omitted entirely means "never dispatched" (distinct from an empty `{}` entry, which dispatches with no `-m`/`-e` override). `model` may be an array for `claude` only, tried in order as fallback models within that one cascade slot. CLI `-m`/`-e` always win over the config entry for the resolved provider.

Run `node scripts/dispatch.mjs --validate-only` to check the loaded config's shape without dispatching anything.

---

## Providers & Session Handles

| Provider | Key | CLI Binary | Session Handle Format |
|----------|-----|------------|-----------------------|
| **Claude Code** | `claude` | `claude` | `claude --resume <session_id>` |
| **Antigravity 2.0** | `agy` | `agy` | `conversation://<id>` |
| **GitHub Copilot** | `copilot` | `copilot` | `copilot --resume <session_id>` |
| **OpenCode** | `opencode` | `opencode` | Local server logs |

Technical specifications, discovery paths, default models, sandboxing boundaries, and failure classification live in [references/providers.md](references/providers.md).

---

## Skill Alignment (implement-dispatch, dispatch-plan-review, dispatch-code-review only)

Not part of general `dispatch` usage — skip this section and [references/alignment.md](references/alignment.md) entirely unless you are running as `implement-dispatch`, `dispatch-plan-review`, or `dispatch-code-review`. It holds conventions those three skills share so independent invocations converge on the same artifacts and behavior instead of drifting apart; other callers of `dispatch` have no reason to load it.

Topics: Plan/Walkthrough Artifact Resolution, Invocation, Invocation Modes, Adjudication, Resolutions Log, User Report, Artifact Lifecycle.

---

## Troubleshooting

- **In-flight progress**: When waking from a timer or investigating a long-running dispatch, inspect recent activity via the log path emitted in the launch banner:
  ```bash
  tail -n 30 "<logFile>"
  ```
  PowerShell:
  ```powershell
  Get-Content -Tail 30 "<logFile>"
  ```
- **Direct runner execution**: Execute a provider runner directly to diagnose binary discovery, authentication, or environment issues (e.g. `node <skill-path>/scripts/claude-run.mjs --help`).
