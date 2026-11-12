# Glossary

| Term | Meaning | Banned synonym |
|---|---|---|
| orchestrator | Host agent that acts as the user's deputy: middle-manages native subagents and delegates, verifies claims and keeps decisions. | master agent |
| subagent | Native worker launched by the host agent with bounded permissions. | slave agent, sub-agent |
| explorer subagent | Read-only native worker on the utility tier for research, triage and distillation, writing nothing except an assigned map (map explorer) or returning an inline cited reply (research explorer). | read-only delegate |
| utility subagent | Low-cost native worker on doctor's `utility` entry; edits assigned paths in write mode; an explorer is a utility subagent with a read-only brief. | lowest subagent |
| nested explorer | Explorer launched by a lead explorer to investigate an independent sub-topic exceeding the limit. | |
| delegate | Provider voice; CLI delegates have read-only access, native voices write only `replyPath`. | |
| writer | Native worker with explicit task paths in a private worktree. | |
| **tool** | Deterministic CLI operation invoked by the orchestrator. | |
| **ledger** | Append-only record of approvals, edits, evidence, writers and integration. | |
| **result file** | Full output artifact named by a tool's compact stdout path. | |
| criterion | Checkable governing outcome. | |
| handoff | Delivered behavior, verification status, concerns and retained artifact paths. | |

The [toolkit contract](toolkit.md) owns operational shapes and arguments.
