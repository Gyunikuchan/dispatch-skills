# Glossary

| Term | Meaning | Banned synonym |
|---|---|---|
| orchestrator | Host agent that coordinates tools and writers, verifies claims and acts as the user's deputy. | master agent |
| subagent | Native worker launched by the host agent with bounded permissions. | slave agent, sub-agent |
| delegate | Provider voice with read-only access. | |
| writer | Native worker with explicit task paths in a private worktree. | |
| **tool** | Deterministic CLI operation invoked by the orchestrator. | |
| **ledger** | Append-only record of approvals, edits, evidence, writers and integration. | |
| **result file** | Full output artifact named by a tool's compact stdout path. | |
| criterion | Checkable governing outcome. | |
| handoff | Delivered behavior, verification status, concerns and retained artifact paths. | |

The [toolkit contract](toolkit.md) owns operational shapes and arguments.
