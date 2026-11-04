# Glossary

| Term | Meaning | Banned synonym |
|---|---|---|
| orchestrator | Host agent that acts as the user's deputy: middle-manages native subagents and delegates, verifies claims and keeps decisions. | master agent |
| subagent | Native worker launched by the host agent with bounded permissions. | slave agent, sub-agent |
| explorer subagent | Read-only native worker for research, triage and distillation; writes only an assigned map. | read-only delegate |
| utility subagent | Native worker for low-risk misc tasks on doctor's `utility` entry; edits only assigned paths. | lowest subagent |
| delegate | Provider voice with read-only access. | |
| writer | Native worker with explicit task paths in a private worktree. | |
| **tool** | Deterministic CLI operation invoked by the orchestrator. | |
| **ledger** | Append-only record of approvals, edits, evidence, writers and integration. | |
| **result file** | Full output artifact named by a tool's compact stdout path. | |
| criterion | Checkable governing outcome. | |
| handoff | Delivered behavior, verification status, concerns and retained artifact paths. | |

The [toolkit contract](toolkit.md) owns operational shapes and arguments.
