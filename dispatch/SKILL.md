---
name: dispatch
description: Dispatch a bounded task across local and external agent CLIs (Claude Code, Antigravity, Copilot, OpenCode) with fallback. Use when delegating work to another agent CLI.
---

# Dispatch

Dispatch a bounded task through the agent **cascade**. The orchestrator owns the brief, judgment, and commit; the implementer CLI executes.

The cascade, in order — this file is the single source of truth for it:

1. **Claude Code** (`claude`).
2. **Antigravity 2.0** (`agy`).
3. **GitHub Copilot** (`copilot`).
4. **Local agent** (`local`) when LM Studio is up.

The orchestrator's own platform is skipped (tried last only with `--allow-same-agent`). If every candidate pass is exhausted, fall back to an **in-process subagent** (Step 3 below; runner exits `NO_DELEGATE_AVAILABLE`).

---

## Operating Invariants

- **Structurally read-only**: delegates run with structural enforcement — `--mode plan` (Antigravity, Copilot), `--allowedTools` restricted to read operations (Claude Code) — plus a prompt-level safety guardrail. Dispatch has no write mode; writes belong to the orchestrator or its native subagent.
- **Context hygiene**: execution logs stream to an OS temp log file; the orchestrator receives only the banner, log path, and final answer (`-v` streams solely to stderr when it is a terminal).
- **Bounded attachments**: `-f` files are capped (128 KB per file, 512 KB total) and wrapped in data delimiters to resist prompt injection; oversized prompts spill to a temp brief file to prevent context or argument-length overflow.
- **Git integrity check**: workspace `git status --porcelain` is compared before and after every delegate run; a mismatch is flagged as a warning. False positives are possible when concurrent processes (IDE auto-save, file watchers, background builds) modify the workspace during the run.

---

## Process

### 1. Formulate task and bound context

1. Draft the prompt text.
2. Identify context files or artifacts to attach via `-f "<path>"`.
3. Choose flags from [Runner Flags Reference](#runner-flags-reference).

Format all paths with forward slashes (`/`) — on Windows, the runner argument parser requires them (macOS and Linux use them natively).

**Done when:** Prompt drafted, `-f` attachment paths validated, and command string constructed.

---

### 2. Dispatch in the background and yield

Run the dispatcher **backgrounded**, then yield the turn. The 1800s (30m) default timeout deliberately outlasts the ~600s ceiling a harness puts on one tool call, so a foreground dispatch risks mid-run termination with output lost. Backgrounding makes the full timeout usable.

**Rely on platform defaults**: Execute with default model, reasoning effort, and timeout. Pass override flags (`-m`, `-e`, `-t`, `--provider`, `-a`) only when the user explicitly requests them.

```bash
# Antigravity (project-local)
node .agents/skills/dispatch/scripts/dispatch.mjs [flags] "<prompt>"
# Claude Code (project-local)
node .claude/skills/dispatch/scripts/dispatch.mjs [flags] "<prompt>"
# Global install (~/.agents/skills/)
node ~/.agents/skills/dispatch/scripts/dispatch.mjs [flags] "<prompt>"
```

Use the path that matches where the skill was installed. Pick exactly one line — do not run all three.

Pin a provider with `--provider <name>` (`local`, `agy`, `claude`, `copilot`) only when requested by the user. A pinned provider disables cascading — its failure returns as-is.

#### Monitoring in flight

The launch banner identifies the session log:

```
[dispatch] Provider: Claude Code (claude) | Mode: READ-ONLY | Log: /tmp/agent-dispatch-logs/claude-<ts>-<pid>.log
```

Read the **tail** of that log to inspect progress:

```bash
tail -n 30 "<logFile>"
```

Yield and await the reactive completion notification.

**Done when:** Dispatch command launched in the background and the turn is yielded.

---

### 3. Fallback gate

Evaluate the dispatcher outcome:

- **Success**: capture stdout and session handle, then proceed to Step 4.
- **Truncated** (`WARNING: Output truncated`): the delegate hit its timeout or buffer cap and returned partial output. Use it if it satisfies the brief; otherwise re-dispatch a narrower task.
- **`NO_DELEGATE_AVAILABLE`**: every local and external pass is exhausted. Fall back in-process:
  - Invoke a read-only subagent (`research` in Antigravity, `Explore` in Claude Code) with identical prompt and attachments.
  - Brief task, or subagents unavailable → execute directly in the current session.

**Done when:** Complete output retrieved from delegate stdout, subagent response, or direct execution.

---

### 4. Relay and synthesis

Relay the response to the user, prefixed by provider (`[Claude Code]`, `[Antigravity 2.0]`, `[GitHub Copilot]`, `[Local OpenCode]`, `[Subagent Fallback]`, or `[Direct Execution]`), including the captured session deep-link or resume command when available.

**Done when:** Output delivered with the provider prefix.

---

## Runner Flags Reference

| Flag | Description | Example |
|------|-------------|---------|
| `-f <path>` | Attach context file or artifact (repeatable, capped) | `-f "src/domain/types.ts"` |
| `--allow-same-agent` | Permit fallback to orchestrator's own CLI | `--allow-same-agent` |
| `--provider <name>` | Pin provider (`local`, `agy`, `claude`, `copilot`; disables cascade) | `--provider agy` |
| `-m <model>` | Override model identifier (user-requested only) | `-m "claude-opus-5"` |
| `-e <level>` | Override reasoning effort (`low`, `medium`, `high`, `max`; user-requested only) | `-e "max"` |
| `-t <sec>` | Override timeout in seconds (default: 1800; user-requested only) | `-t 2400` |
| `--orchestrator <name>` | Override detected orchestrator platform | `--orchestrator claude` |
| `--json` | Request structured JSON output (local provider only) | `--json` |
| `-a <name>` | Override agent name (local provider only) | `-a delegate` |
| `-v` | Stream live trace (terminal debugging only; suppressed when piped) | `-v` |

---

## Providers & Session Handles

| Provider | Key | CLI Binary | Session Handle Format |
|----------|-----|------------|-----------------------|
| **Claude Code** | `claude` | `claude` | `claude --resume <session_id>` |
| **Antigravity 2.0** | `agy` | `agy` | `conversation://<id>` |
| **GitHub Copilot** | `copilot` | `copilot` | `copilot --resume <session_id>` |
| **Local OpenCode** | `local` | `opencode` | Local server logs |

Technical specifications, discovery paths, default models, sandboxing boundaries, and failure classification live in [references/providers.md](references/providers.md).
