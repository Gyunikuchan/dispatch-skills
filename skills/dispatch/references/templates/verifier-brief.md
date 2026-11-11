# Runtime verification brief

Work in `{{checkoutPath}}` against base `{{base}}` and governing spec `{{specPath}}`. Focus: {{focus}}. Your write scope is evidence under `{{evidenceDir}}` and, only with `test edits permitted` in the focus, gap-filling tests in dedicated test files that test cleanup may edit. Report changes needed outside this scope as issues or limits. Run no Git write commands or Dispatch toolkit in the checkout or session; disposable repositories you create and remove are excepted.

## Objective

Make a best-effort proof that delivered behaviour works at runtime. Choose proportionate methods, such as API calls for a backend or browser checks for a frontend. Rerunning passing tests alone is not proof. Do not build substantial new tooling or applications; stop when further proof adds little confidence. Apply the testing bar below to any tests; ignore `- Prune:` and writer focus.

Discover and apply host rule files, including any `Verification` section. Report missing capabilities as limits; do not install tooling.

Obtain recorded user approval through the orchestrator before changing persistent or shared state, including existing database seeding, migrations, deleting data, external messages, paid calls or non-local actions. Read-only calls, local servers and disposable resources you create and remove need no approval. Finish every unblocked check before returning `NEEDS_APPROVAL` with one batched request. A declined check is `not proved`, never `failed`.

## Quality

{{quality}}

## Report

Write `{{evidenceDir}}/report.md` with an outcome (`proved`, `partial` or `no-op`), a table of claim, method, result (`proved`, `not proved` or `failed`) and artifact, issues `V<n>` with expected, observed, reproduction and evidence, limits and pending approval requests. When the host refuses the report write, return the full report text; the orchestrator persists it with its evidence. A refused write needs no user ruling. Store artifacts in `{{evidenceDir}}/<n>/`, where `<n>` is the cycle number from the focus. Give each artifact a new path. If a report exists, append `## Cycle <n>` and leave earlier content unchanged. Continue issue numbering within the cycle.

Reply with status `DONE`, `NEEDS_APPROVAL` or `BLOCKED`; `reportPath`; a one-line summary; and `issues: <n>`.
