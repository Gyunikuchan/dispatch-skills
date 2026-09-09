# dispatch

Hand a bounded task to another coding-agent CLI, and get back only the answer.

An orchestrating agent keeps the brief, the judgment, and the commit. `dispatch` picks an available implementer CLI, runs it read-only by default, streams the full execution trace to a temp log, and returns the final answer plus a session handle. Nothing else reaches the orchestrator's context.

This skill stands alone — it references no other skill and needs no host configuration.

## Install

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch
```

Installs to `.agents/skills/dispatch/` and symlinks into `.claude/skills/` (and any other detected agent directory). Add `-g` for a user-level install under `~/.agents/skills/`.

## The cascade

Providers are tried in order, skipping the orchestrator's own platform so a task is not handed back to the agent that delegated it:

1. **Claude Code** (`claude`).
2. **Antigravity** (`agy`).
3. **GitHub Copilot** (`copilot`).
4. **Local OpenCode** (`local`) — `opencode` against LM Studio, when the local server is up.

The orchestrator's own CLI is tried as a last resort only with `--allow-same-agent`.

Pin one with `--provider <name>`; a pinned provider never cascades, and its failure is returned as-is.

## Usage

```bash
node .agents/skills/dispatch/scripts/dispatch.mjs [flags] "<prompt>"
```

Delegate a bounded question, read-only, letting the cascade choose:

```bash
node .agents/skills/dispatch/scripts/dispatch.mjs \
  -f "src/domain/pricing.ts" \
  "Explain how discount stacking is applied in the attached file, and flag any order-dependence."
```

Pin a provider:

```bash
node .agents/skills/dispatch/scripts/dispatch.mjs --provider agy \
  "Trace the off-by-one through src/lib/pagination.ts and describe the fix."
```

| Flag | Description |
|------|-------------|
| `-f <path>` | Attach a context file (repeatable; 128 KB per file, 512 KB total) |
| `-m <model>` | Override the model identifier |
| `-e <level>` | Override reasoning effort (`low`, `medium`, `high`, `max`) |
| `-t <sec>` | Override timeout in seconds (default 1800) |
| `--provider <name>` | Pin a provider and disable cascading |
| `--orchestrator <name>` | Override detected orchestrator platform |
| `--allow-same-agent` | Permit falling back to the orchestrator's own CLI |
| `--json` | Request structured JSON output (local provider only) |
| `-a <name>` | Override agent name (local provider only) |
| `-v` | Stream a live trace to an attached terminal |

Run any provider directly for debugging — each runner is its own CLI:

```bash
node .agents/skills/dispatch/scripts/claude-run.mjs --help
```

## Design invariants

- **Always read-only.** Delegates cannot modify the workspace; writes belong to the orchestrator or its native subagent.
- **Context hygiene.** Execution logs stream to an OS temp file; the caller receives only the banner, log path, and final answer.
- **Bounded attachments.** Oversized prompts spill to a brief file rather than overflowing argv or the delegate's context.
- **Sandboxing.** The local provider enforces WAN proxy-trapping, environment whitelisting, and workspace path boundaries (bubblewrap on Linux when present). External CLIs are bracketed by Git integrity checks.

The workspace boundary is resolved from `git rev-parse --show-toplevel`, falling back to the current directory — so the runner acts on the repository it is invoked in, wherever it is installed.

## Requirements

Node >= 18, plus at least one provider CLI on `PATH`. No dependencies.

## Layout

```
scripts/          runners: dispatch, common, and one per provider
references/       provider mechanics and session handling
SKILL.md          agent-facing operating instructions
```

`SKILL.md` is the contract an orchestrating agent reads; this README is for humans.
