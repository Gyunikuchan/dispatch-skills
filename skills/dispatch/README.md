# Dispatch

Independent model perspectives with one recorded workflow: ask, design, plan, review, and implement. The host verifies findings and controls native writes while provider delegates remain read-only.

Plans present meaningful task summaries followed by file changes and prerequisites. Implementation schedules ready tasks within `write-concurrency`, gives each writer an isolated worktree and focused brief, and independently checks results before accepting them. See [task execution](references/readme/concepts.md) and [implementation](references/verbs/implement.md) for evidence, recovery, and delivery boundaries.

Requires Git and Node `^22.18 || >=23.6` with native TypeScript stripping. Install and authenticate the configured provider CLIs. Copy `config.sample.jsonc` to `config.local.jsonc`, select installed providers, and use `doctor` to inspect config, integrity, effective targets, sandbox support, and Node version.

Commands below run from the repository root.

```text
node skills/dispatch/scripts/dispatch.ts doctor
node skills/dispatch/scripts/dispatch.ts session init --objective "Normalize inputs"
node skills/dispatch/scripts/dispatch.ts start plan --session-dir <returned-dir> --orchestrator codex --level low --level-source explicit -- Normalize inputs
node skills/dispatch/scripts/dispatch.ts send --run <returned-run> --event @reply.json
node skills/dispatch/scripts/dispatch.ts status --run <returned-run>
```

Read [concepts](references/readme/concepts.md), [configuration](references/readme/configuration.md), [verbs](references/readme/verbs.md), and [troubleshooting](references/readme/troubleshooting.md). The executing host follows the [contract](.).
