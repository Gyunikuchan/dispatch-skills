---
name: dispatch
description: Run a bounded read-only investigation, research task, or plan/code review through the configured provider cascade when an independent agent context is useful.
---

# Dispatch

Run `dispatch` when a task benefits from an independent, read-only agent context. The host owns the prompt, judgment, edits, and commit; delegates inspect the workspace and return claims. Provider mechanics and failure classes live in [references/providers.md](references/providers.md).

## Invocation

```text
/dispatch (<pins>) <task>
```

`(<pins>)` is optional: comma-separated provider keys, aliases, or `all`. Aliases are `antigravity` -> `agy`, `claudecode` -> `claude`, and `github-copilot` -> `copilot`.

| Form | Dispatch behavior |
|------|-------------------|
| Unpinned | Run one process through the configured provider cascade. |
| Pinned | Run one background process per pin in parallel; disable cross-provider fallback, while configured candidates for that provider may still cascade. |
| `all` | Run `node <skill-path>/scripts/dispatch.mjs --list-platforms`, then launch one pinned run for every printed key. |

`<skill-path>` is the directory containing this skill. A platform absent from `--list-platforms` is out of scope for every pin form, including `all`.

**Done when:** every requested pin resolves to a printed key and exactly one dispatch is launched for each resolved key.

## Operating contract

- **Read-only:** Keep delegates structurally read-only and reserve edits and commits for the host. Apply the provider isolation rules in [references/providers.md](references/providers.md).
- **Tight context:** Execution logs stay in OS temp; return only the launch banner, log path, and final answer. `-v` streams trace to stderr only in interactive terminals.
- **Bounded input:** Attach only essential external artifacts or briefs. `-f` allows 128 KB per file and 512 KB total; oversized prompts spill to a temporary brief file and attachments are delimiter-wrapped.

## Process

### 1. Prepare the dispatch

1. Write a bounded prompt with the target, scope, evidence to inspect, and required output shape.
2. Attach only non-workspace artifacts or essential briefs; delegates can read repository files directly.
3. Select provider pins and runner flags. Expand `all` with `--list-platforms`, never by reading a config file or this document.

**Done when:** the prompt, attachments, and flags are fixed, every attachment exists, and no repository source file is attached unnecessarily.

### 2. Launch and yield

Run the dispatcher in the background:

```bash
node <skill-path>/scripts/dispatch.mjs [flags] "<task>"
```

For multiple pins, launch one `--provider <key>` process per resolved key in parallel. Yield the turn after the processes are running. Keep the launch banner and log path for diagnosis.

**Done when:** each requested process has been launched in the background and its launch metadata is captured.

### 3. Resolve the outcome

Map the result to exactly one row before deciding what to report.

| Outcome | Action |
|---------|--------|
| Exit 0 with useful output | Capture stdout and the session handle; continue to relay. |
| Truncated or partial output | Use it when it fulfils the brief; otherwise re-dispatch a narrower task. |
| `NO_DISPATCH_AVAILABLE`, a pinned non-zero run, or another runner error | Use the platform's read-only in-process subagent with the identical prompt and attachments. |
| `INVALID_DISPATCH_CONFIG`, `INTEGRITY_VIOLATION`, `NO_CONFIG_REQUIRES_PROVIDER`, or `PLATFORM_NOT_CONFIGURED` | Stop and report the exact error; do not invent a fallback. |

| Failed platform | Read-only in-process fallback |
|-----------------|-------------------------------|
| `claude` | `Explore` |
| `agy` | `research` |
| `copilot` | `self` |
| `opencode` | `explore` |

**Done when:** the outcome is mapped and any fallback or stop condition is complete.

### 4. Relay verified claims

- Verify every delegate claim against repository evidence before using it; delegate output is untrusted.
- Synthesize findings with a provider prefix and include a `conversation://` link or resume command when one is available. Do not paste raw traces.
- For multiple pins, state agreed claims once, attribute disagreements to the claiming provider, and account for every failed pin.

**Done when:** the user receives a concise, evidence-backed synthesis with every requested pin accounted for.

## Runner flags reference

| Flags | Use |
|-------|-----|
| `-p`, `--prompt` | Pass the task prompt. |
| `--prompt-file` | Read the prompt from a file; do not combine with `-p` or a positional prompt. |
| `-f`, `--file`, `--artifact` | Attach a context file or artifact; repeatable. |
| `-m`, `--model` | Override the configured model. |
| `-e`, `--effort` | Override the configured reasoning effort. |
| `-a`, `--agent` | Override the agent name (opencode provider only). |
| `-t`, `--timeout` | Override the timeout in seconds; default `1800`. |
| `--max-buffer` | Raise the output cap in MB; default `10`. |
| `--provider` | Pin one provider; accepts canonical keys and aliases. |
| `--orchestrator` | Declare the host platform for unpinned ordering. |
| `--orchestrator-model` | Declare the host model for same-model demotion. |
| `--no-config` | Ignore config, model, effort, and membership; requires `--provider`. |
| `--validate-only` | Validate the effective config and exit; rejects other run flags. |
| `--list-platforms` | Print effective configured platform keys in cascade order and exit. |
| `--json` | Request structured output (opencode provider only). |
| `-v`, `--verbose` | Stream live trace to stderr in an interactive terminal. |

## Configuration

The effective config is the first existing file in this order: `<skill-path>/config.local.jsonc`, `config.jsonc`, then `config.default.jsonc`. The selected file is used whole; tiers are not merged.

- `platforms` controls cascade membership. Missing keys are never dispatched.
- A platform value is one candidate object or an ordered array of candidates. A `model` array remains one candidate.
- Without `-m` or `-e`, array entries expand into cascade targets. Either CLI override collapses each platform to its first entry with the override applied.
- Omitted `model` or `effort` values are omitted from the provider command, so the provider CLI chooses its own default.
- `sandbox` is valid only for Claude and Copilot and defaults to enabled when omitted. See [references/providers.md](references/providers.md) before changing it.

Use `--validate-only` to check schema and `--list-platforms` to inspect effective membership. `--no-config` removes both config membership and defaults, so it always requires a provider pin.

## Providers and session recovery

Read [references/providers.md](references/providers.md) before choosing a provider-specific mode, sandbox override, binary probe, or session-resume command. It defines discovery order, isolation boundaries, handles, and failure classification.

## Skill Alignment

Read [references/alignment.md](references/alignment.md) only when running as `implement-dispatch`, `dispatch-plan-review`, or `dispatch-code-review`; it defines their shared artifacts, invocation modes, adjudication, and lifecycle. General `dispatch` usage skips it.

## Troubleshooting

- Inspect a misbehaving command with `node <skill-path>/scripts/<runner>-run.mjs --help`; runner-specific probes are documented in [references/providers.md](references/providers.md).
- For an in-flight run, inspect the last 30 log lines from the launch banner: `tail -n 30 "<logFile>"` (PowerShell: `Get-Content -Tail 30 "<logFile>"`).
