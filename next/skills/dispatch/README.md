# Dispatch

Independent model perspectives with one recorded workflow: ask, design, plan, review, and implement. The host verifies findings and controls native writes while provider delegates remain read-only.

Requires Git and Node `^22.18 || >=23.6` with native TypeScript stripping. Install and authenticate the configured provider CLIs. Copy `config.sample.jsonc` to `config.local.jsonc`, select installed providers, and use `doctor` to inspect config, integrity, effective targets, sandbox support, and Node version.

This overlay uses `SKILL.next.md`; I09 renames it to `SKILL.md`. Commands below run from the repository root before cutover. Afterwards remove `next/` from the entrypoint path.

```text
node next/skills/dispatch/scripts/dispatch.ts doctor
node next/skills/dispatch/scripts/dispatch.ts session init --objective "Normalize inputs"
node next/skills/dispatch/scripts/dispatch.ts start plan --session-dir <returned-dir> --orchestrator codex --level low --level-source explicit -- Normalize inputs
node next/skills/dispatch/scripts/dispatch.ts send --run <returned-run> --event @reply.json
node next/skills/dispatch/scripts/dispatch.ts status --run <returned-run>
```

Read [concepts](references/readme/concepts.md), [configuration](references/readme/configuration.md), [verbs](references/readme/verbs.md), and [troubleshooting](references/readme/troubleshooting.md). The executing host follows the [contract](.).
