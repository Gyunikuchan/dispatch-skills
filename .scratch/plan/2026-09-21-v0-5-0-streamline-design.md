# v0.5.0 — Unified dispatch skill with script-driven workflow

## Context & Intent

v0.4.0 contracts grew from ~5.4k to ~11.8k words since v0.3.0 (`implement-dispatch/SKILL.md`
885 → 1,615). A medium `/implement-dispatch` run loads ~6.8k words (~9k tokens) of contracts
before any script output. The load comes from protocol surface, not only from word count:

- The orchestrator sequences ~16 CLIs (`prepare-review`, `parse-report`, `source-map`,
  `check-consensus`, `fix-clustering`, `build-rebuttal-packets`, `resolve-flow`, `ledger*`,
  `implementation-outcome`, `relocate-scratch`, lints, …). Their exit codes, handshakes, and
  ordering are described in prose even though the scripts already enforce them.
- The plan and code review skills share about half their lines (SKILL.md plus templates). Standalone and orchestrated modes are
  restated in every skill.
- Two config files repeat the full platform table once per workflow step.
- Terms drift across contracts ("phase", "stage", "step", "mode"), so one concept can go by
  several names.

Intent: make the skills cheaper to load, easier to follow, and friendlier to invoke. Correctness
and the verification guarantees stay the same. The user accepts a breaking change: less
per-skill isolation, one skill owning all assets, and one config. Every user ruling and its
rationale is recorded under Alternatives & Decisions.

## Goals & Requirements

### Goals

- **G1 — One skill.** A single `dispatch` skill owns every runner, template, schema, script, and
  config.
- **G2 — One grammar.** `/dispatch [level] [(pins)] [<verb-clause>]: [<argument>]`.
- **G3 — Script-driven workflow.** A driver owns the review, implementation, and design loops. The
  agent performs judgment only: verifying claims, ruling, authoring, editing, and asking the user.
- **G4 — Phase independence.** Every phase is its own entry point with artifact inputs; verb-backed phases also run alone. The full
  `implement` flow is the same phases chained, never a separate code path.
- **G5 — Just-in-time guidance.** Rules load only when the phase or action that needs them runs.
- **G6 — Ubiquitous language.** One glossary; every contract, script message, flag, and
  artifact heading uses its terms.

### Non-goals

- No change to provider runners' read-only isolation, credential stripping, or native-fallback
  semantics.
- No change to the review rubrics' substance (tags, severities, locus rules).
- No config migration tooling and no v0.4 artifact readers.
- No automated word-count or byte budgets.

### Ubiquitous language

The glossary is single-sourced in `dispatch/references/glossary.md`. Key terms for this design:

| Term | Meaning | Banned synonym | Distinct from |
|---|---|---|---|
| **Verb** | One `/dispatch` operation: `ask`, `plan`, `design`, `review`, `implement`. | | command, mode |
| **Phase** | One ordered unit of the workflow. Ordinary order: `plan` → `plan-review` → `baseline` → `implementation` → `code-review` → `handoff`. Design order: `design` → `design-review`; then each increment runs the ordinary phases; then `integration`. | stage | step, increment |
| **Increment** | One `I<nn>` row of a technical design's dependency graph: a governed unit of delivery that runs the ordinary phases once. | milestone | phase |
| **Level** | Policy and model tier, `low` through `max`. | | effort (a provider setting) |
| **Pin** | User selector fixing providers or breadth. | | |
| **Read delegate** | A dispatched, structurally read-only provider CLI (the default candidate kind). | reviewer | |
| **Write subagent** | A native host subagent that edits code; never dispatched. | implementer | |
| **Candidate / Target / Reserve** | A configured provider entry; one selected for a wave; one held back to replace a failed target. | | |
| **Round / Wave / Slot** | One adjudication record; the concurrent launches for one round; one launched delegate. | iteration | |
| **Run** | One driver invocation, with its state file. | | session (a provider handle) |
| **Action** | One driver instruction to the agent (closed set, see R3). | | step, task |
| **Finding / Ruling / Settlement / Checkpoint** | A delegate claim; the host's decision on it; the recorded final status of a round (consensus exit `0`, or host-final when `consensus: false`); the recorded freshness metadata. | verdict | |

Only the "Banned synonym" column is checked (R9). A word that is itself a glossary term, config
key, or provider field (`phase`, `increment`, `effort`, `session`, `mode`, `command`, `task`) is
never banned; "Distinct from" is explanation only.

Ordinary phase inputs and outputs (v0.4 origin in parentheses):

| Phase | Requires | Produces |
|---|---|---|
| `plan` | ask | plan artifact |
| `plan-review` | plan | settled plan resolution log (plan review) |
| `baseline` | settled plan | walkthrough with baseline verify records and recorded approval (baseline verification + approval) |
| `implementation` | approved baseline | code edits, implementation outcome, ledger events (implementation) |
| `code-review` | walkthrough + edits | settled code resolution log and checkpoint (code review) |
| `handoff` | settled code review | Execution Status, handoff summary, scratch relocation (handoff) |

v0.4's "tests-only stage" becomes the **RED gate**, a gate inside `implementation`. Phase and
increment are distinct on purpose: a phase is *how* work proceeds, an increment is *what* part of
a design is delivered.

### Invocation

```text
/dispatch [level] [(pins)] [<verb-clause>]: [<argument>]
  level       = low | medium | high | xhigh | max   (optional; auto-classified where applicable)
  pins        = provider keys/aliases, a count, or all (existing grammar; optional with or without level)
  verb-clause = ask (default)                        argument: <ask>
              | plan                                 argument: <ask> | <plan.md>        plan + plan-review
              | design                               argument: <ask> | <design.md>      design + design-review
              | review [plan|design|code] [--fix]    argument: <path> | <range> | none  review alone
              | implement [--phases from:<phase>]    argument: <ask> | <plan.md> | <design.md>
```

The colon separates the prefix (level, pins, verb clause) from the argument and is required
whenever an argument follows. Without a colon, the whole input must parse as a prefix alone
(`/dispatch review`, `/dispatch high (agy) review code`) and runs with no argument; any other
colon-less input is an `ask` (`/dispatch review the auth flow`). With no verb, `/dispatch (pins):
<ask>` is `ask`. A prefix-only `plan`, `design`, or `implement` (no argument) fails with a usage
diagnostic naming the accepted argument forms; only `review` has a no-argument form.
`implement: <ask>` starts at `plan`; `implement: <plan.md>` starts at `plan-review`, as in v0.4.
`ask` does not use the driver: it is the existing single-dispatch runner path, and level and pins
keep working for it through the new `--level` and `--pins` runner flags. `dispatch.mjs --pins
<pins>` resolves named, count, and `all` pins itself and launches the whole wave in one
invocation (one R8 stdout line per slot), so the agent never maps a count to targets or writes a
batch file for `ask`.
With no explicit level, the orchestrator classifies the verb's artifact or diff per v0.4
(mechanical → `low`, bounded → `medium`, cross-cutting/public-contract → `high`; `xhigh`/`max`
explicit only) for `plan`, `design`, `review`, and `implement`. `ask`, and any input that is
uncertain or hard to classify, resolves at `medium`. A classified level that disables a review
phase (`rounds: 0` or `targets: 0`) is raised to the lowest level at which every review phase the
run will enter is enabled (phases skipped by `from:` are ignored); an explicit level is honored as
given, and source `default` is raised like `classified`. A review phase disabled at every level is
skipped (named in the start banner) and ignored by the raise rule. The orchestrator passes the source with `--level-source explicit|classified`; omitting
`--level` means `medium` with source `default`. The resolved level and its source appear in the
start banner and run state. Examples:
`/dispatch high (agy): research X`, `/dispatch review code --fix: main..HEAD`.

`review` kind inference, when no kind is given, in order:

1. `*-design.md` → design;
2. `*-walkthrough.md` → code, scoped to that walkthrough and its paired plan (as in v0.4);
3. any other `*.md` → plan;
4. an argument that resolves as a Git revision or range → code;
5. no argument → code, over uncommitted changes against `HEAD`;
6. anything else fails with a diagnostic naming the accepted forms.

Every standalone review is report-only unless `--fix` is given (R6).

### Requirements

**R1 — Unified config.** `dispatch/config[.local].jsonc` holds exactly three tables:

- `read-delegates`: the one candidate table (platform → candidate or ordered candidate array, with
  inline level overrides for `model`, `effort`, `sandbox`). Default for `ask` and every review.
- `write-subagents`: platform → native write-subagent fields (model or model launch cascade,
  effort) with inline level overrides. Never dispatched. The entry is selected by the host
  platform passed as `--orchestrator`; a missing entry fails with a diagnostic. `--doctor` shows
  the `--orchestrator` entry when given, else every entry.
- `phases`: per-phase policy for `plan-review`, `code-review`, `design-review` — level maps of
  `targets`, `rounds`, `consensus`, plus an optional `only: [<platform>]` membership filter.

Shape (illustrative):

```jsonc
{
  "read-delegates": {
    "claude": { "model": "claude-sonnet-5", "high": { "model": "claude-opus-5" } },
    "agy": [{ "model": "gemini-3.8-flash" }, { "model": "gemini-3.8-pro" }]
  },
  "write-subagents": { "claude": { "model": ["claude-sonnet-5"], "max": { "effort": "high" } } },
  "phases": {
    "code-review": { "targets": { "medium": 1, "high": 3 }, "rounds": { "medium": 2 },
                     "consensus": { "medium": true }, "only": ["agy", "claude"] }
  }
}
```

v0.4 → v0.5 key map: `targetCount` → `targets`, `maxRounds` → `rounds`, `consensus` →
`consensus`, per-section `platforms` → `only` (membership) plus `read-delegates` (models),
`implementation` → `write-subagents`, top-level `platforms` (v0.4 `dispatch` config) →
`read-delegates`; `implement-dispatch/config[.local].jsonc` is retired.
A config is v0.4 when it has any of `platforms`, `plan-review`, `code-review`, `design-review`, or
`implementation` at top level, or is found under `implement-dispatch/`; either fails with a
diagnostic naming this map. The check lives in `dispatch`'s config loader, which probes the
sibling `<skills-dir>/implement-dispatch/config*.jsonc`; I01 adds that probe as a gated exception in
`dependency-direction.test.mjs`, like `alignment.md`.

v0.4 semantics carry over: `rounds: 0`, or unpinned `targets: 0`, disables that phase;
`targets` also accepts `"all"`.

Models live only in the two candidate tables. A phase's `only` filters `read-delegates`; it never
defines candidates, so no platform table is repeated. Per-phase model choice is deliberately
dropped: the level selects the tier.

Level resolution is uniform: exact match, else nearest lower, else lowest higher. All five levels
remain. `ask` accepts a level with or without pins. The level selects the model tier; with no
pins, the target comes from the ordinary cascade at that tier.

**R2 — Phase independence.**

- Every phase in the glossary is an entry point: through its verb, or through `implement
  --phases`. Verb runs stop after their own phases (`plan` → `plan`, `plan-review`; `design` →
  `design`, `design-review`; `review` → one review); `--phases from:` runs forward (D19). Within
  an `implement` run, the walkthrough-scoped `code-review` phase is entered only through
  `--phases from:code-review`; standalone `review <walkthrough.md>` and `review code <range>` are
  sibling entries sharing the same review core.
- The `plan` verb writes no ledger. A `from:` past `plan-review` with no recorded approval emits
  `ask-user` approval, records it in the ledger, then runs.
- `--phases` takes only `from:<phase>`, meaning that phase and every later phase in the fixed
  order. Phase order is fixed and never user-defined, so `from:` is unambiguous; an explicit list
  is rejected because it only adds gate-skipping combinations.
- With a design path, `--phases` applies within the increment that the ledger's `Next Action`
  selects and accepts the ordinary phases plus `integration`; `from:integration` is refused until
  the ledger shows every increment complete. `design` and `design-review` are reached only through
  the `design` or `review design` verbs. Increments are never picked by `--phases` (see D8).
- A phase takes its inputs only from canonical artifacts and Git state, never from in-memory
  output of an earlier phase.
- A phase refuses to run when a required input artifact is missing or unsettled, and names the
  phase that produces it.

**R3 — Driver protocol.** `node <skill-path>/scripts/dispatch.mjs --run plan|design|review|implement [--kind
plan|design|code] [--level <level> [--level-source explicit|classified]] [--pins <pins>] [--fix]
[--phases from:<phase>] --orchestrator <platform> [--orchestrator-model <model>] [-- <argument>]` and `… --next --state
<file> [--input <json>]` each print one compact JSON action from a closed, versioned set. Every
action carries `stateFile` (under `os.tmpdir()`), which the agent passes to the next `--next`. The
driver entry points are flags, not positional subcommands, because `dispatch.mjs` already takes a
positional prompt (a prompt starting with "run" must stay a prompt). `--level` is a new runner flag,
also accepted by `ask` and `--doctor`. `--orchestrator-model` keeps its v0.4 role (same-model
demotion of read delegates).

| Action | Agent does |
|---|---|
| `ask-user` | relay the question, return the answer |
| `author` | write or repair the artifact from the named template |
| `launch` | run the given argv (one `--batch-file` invocation per wave) in the background, yield |
| `native-fallback` | run a read-only native subagent, capture its reply to the given slot |
| `adjudicate` | verify the listed findings against code, return rulings |
| `apply-fixes` | edit inline (host agent, no subagent) for the listed clusters, return the edits |
| `delegate-write` | launch the native write subagent with the given fields, return the envelope |
| `verify` | run the host verify commands, return results |
| `done` | report the given summary |

Every action has a versioned JSON schema under `templates/schemas/`, and every non-terminal
action has a reply schema (`done` is terminal and takes no reply); the driver rejects a reply that fails its schema and re-emits the action.
The `launch` reply is empty (`--input` omitted): the driver reads the wave's `--output-file`
envelope itself.
Verification after `apply-fixes` or `delegate-write` is always a separate `verify` action.

**Approval gate.** In `implement` runs, the driver withholds `delegate-write` and any
`apply-fixes` that edits files other than the plan or design artifact until an `ask-user`
approval of the settled plan is recorded in the ledger, as in v0.4. `plan-review` fixes to the
plan artifact itself are not gated. A standalone `review --fix` has no ledger; the user's `--fix`
is its approval. Edits made outside the loop cannot be prevented by a script; the contract forbids
them.

The driver owns:

- preparation, bounded views, and rebuttal packets;
- source maps, resolution-log writes, and application records;
- consensus, budgets, and round caps;
- clustering, ledger events, and checkpoint preview/commit;
- scratch relocation and cleanup.

Each action carries only the guidance for its branch, so conditional rules move from prose into
the driver. Example: `review code --fix` emits `adjudicate` with verify-then-rule hints, then
`apply-fixes` for accepted findings and `ask-user` for ambiguous ones; without `--fix` the same
review never emits `apply-fixes`.

Driver state lives in OS temp and is a cache. `--next` with no state file rebuilds it. `--run`
over an artifact with an unsettled resolution log resumes from that log; a settled or absent log
starts round 1. Rebuild sources:

| State | Rebuilt from |
|---|---|
| round count, rulings, pending rebuttals | resolution log rounds |
| settlement, checkpoint | resolution log and walkthrough checkpoint |
| attempt budget, clusters, approval, increment | ledger events |
| wave slots, reserve use | not rebuildable: an in-flight wave is re-launched whole |

A standalone review persists only its resolution log (and, with `--fix`, the edits); it has no
ledger, so it has no attempt budget or approval to rebuild. When state is missing and nothing is
rebuildable, the run restarts from its first phase over the current artifacts.

**R4 — Consensus preserved.** With `consensus: true`, rejecting or downgrading a `MUST`/`SHOULD`
finding still goes back to every reachable source that cited it (`CONFIRM` / `REBUT` /
`INTENT-DISPUTE`), exactly as in v0.4. With `consensus: false`, host rulings are final.

**R5 — Aliases.** `dispatch-plan-review`, `dispatch-code-review`, `dispatch-design-review`, and
`implement-dispatch` remain installable skills.

- Each is a short SKILL.md with `disable-model-invocation: true`, so the model sees only
  `dispatch`.
- Each maps its arguments to the verb, e.g. `/implement-dispatch high (agy): X` →
  `dispatch high (agy) implement: X`.
- Each fails with a named diagnostic when `dispatch` is not installed.
- `disable-model-invocation` is Claude Code frontmatter; I06 verifies each supported host. Where a
  host ignores it, the alias description stays one line so it adds little listing cost.

The `dispatch` description states the invocation syntax only; which verb fits a request is left
to the orchestrator.

**R6 — Standalone review fixes are opt-in.** Every standalone review (`plan`, `design`, `code`)
is report-only by default. `--fix` applies accepted in-scope `MUST` and safe `SHOULD` fixes
through the same `apply-fixes` action that `implement` uses, asking the user about ambiguous
findings. Preparation lint failures in a report-only review are reported, not repaired. The
contract permits `--fix` only when the user's request includes it (as D6 does for `implement`).

**R7 — No legacy handling.** Remove:

- legacy walkthrough/plan mismatch decisions and the overwrite / as-is / fresh-slug choices for
  pre-v0.5 artifacts;
- the `ACTIONABLE` status and unknown-bullet tolerance.

A v0.4 config is rejected with a diagnostic that names the v0.5 schema.

**R8 — Content-scaled output, never truncated.**

- Driver stdout is always one compact JSON action; runner stdout is one line per slot (`platform`,
  `status`, `exit`, `session`, `output`). Both carry IDs, statuses, and paths, not artifact bodies
  or redundant fields; `--verbose` adds inline bodies and diagnostics.
- There is no size cap. Payloads the agent must act on in full (findings to adjudicate, clusters
  to apply, opt-in items) are always complete, so large tasks cost what they need.
- Runner flags move from SKILL.md to `--help`.
- The per-slot runner line changes the stdout contract that `--batch-file` consumers and runner
  tests parse; I01 introduces it with `--pins` and ports those runner tests. I01 adds `--level`,
  `--level-source`, and `--pins` to the SKILL.md and README flag tables so
  `tests/integration/flag-parity.test.mjs` stays green; its `--help` CLI list is repointed in
  whichever increment moves each script (I01, I02); I06 moves the flags to `--help` and ports
  the table checks.

**R9 — Terminology enforced.**

- Contracts, templates, script diagnostics, flags, and artifact headings use glossary terms only;
  the check below enforces contracts and templates, and review covers scripts. Only the "Banned
  synonym" words are forbidden; "step" stays allowed in plain prose.
- `scripts/check-terms.mjs` fails on the glossary's "Banned synonym" column in shipped
  contracts and templates. It skips scripts, code spans, and fenced blocks, because existing
  identifiers (`task-start`, `mode=cli`, provider session handles) legitimately use those words.
  Release notes are not a shipped contract and are out of scope.
  It is a deterministic string check, not a size budget.
- It joins `npm test` in I06, after the contract rewrite; earlier increments run it on fixtures
  only.

**R10 — Shared delegate prompt frame.** One review prompt template holds the shared frame
(context block, host-convention reading, re-review rule, turn budget, JSON reply contract) with a
per-kind block for inspection scope, tags, and locus form. Rebuttal templates merge the same way.
Rubric substance is unchanged.

### Acceptance criteria

- **AC1 — One CLI.** Every command the host agent issues is `dispatch.mjs` or a host verify
  command; a scripted-agent test records every argv. Commands inside write subagents are out of
  scope.
- **AC2 — Phases enter alone.** Every phase is entered from fixture artifacts alone; each verb run
  stops after its own phases. For each phase P, `--phases from:P` over the artifacts a full
  `implement` run had produced before P yields the same artifact, ledger, and checkpoint results
  as that full run, under scripted-agent replay of recorded `author`/`delegate-write`/delegate
  replies, comparing ledger events after normalizing timestamps and IDs. `design` and
  `design-review` are covered through their verbs.
- **AC3 — Consensus parity.** Existing consensus, rebuttal, clustering, ledger, and design-graph
  test suites pass unchanged in substance against the driver, except the legacy cases R7 deletes.
- **AC4 — No truncation.** A fixture with more than 50 findings and 20 clusters yields complete
  `adjudicate` and `apply-fixes` payloads.
- **AC5 — Terminology.** `check-terms.mjs` passes on the shipped tree and fails on a seeded
  banned synonym.
- **AC6 — Load reduction measured, not enforced.** Final integration reports, per verb, the
  contract words loaded plus the driver stdout bytes, against these v0.5.0 targets and the v0.4
  baseline:
  - `dispatch/SKILL.md` about 600 words;
  - a medium `implement` run about 3,000 words;
  - a standalone `review code` about 1,200 words.

  Missing a target is reported, not failed. Features may raise these numbers deliberately.

## Architecture & Boundaries

```text
skills/dispatch/
  SKILL.md                 grammar, driver loop, boundaries (always loaded)
  config.sample.jsonc      single config
  references/
    glossary.md            ubiquitous language (single source)
    providers.md           unchanged role; loaded on fallback or provider questions only
    review.md              shared adjudication/finality rules (was alignment.md, trimmed)
    verbs/<verb>.md        implement.md and design.md only; review kinds differ by template data
    templates/             plan, design, walkthrough, review prompt (shared frame + kind blocks),
                           rebuttal, schemas
  scripts/
    dispatch.mjs           runner entry + driver flags (--run/--next)
    driver/                one module per phase, composed by implement
    …                      runners, prep, parse, consensus, ledger, clustering (moved in)
skills/{implement-dispatch,dispatch-plan-review,dispatch-code-review,dispatch-design-review}/
  SKILL.md                 alias only
```

### Invariants

- Delegates stay structurally read-only. All writes go through the host agent or native write
  subagents, as today.
- The driver never edits source code. It writes only canonical scratch artifacts, the ledger, and
  OS-temp state.
- Each phase module is a pure function of (artifacts, Git state, config, run state).
  `implement` composes phase modules and holds no phase logic of its own.
- Increment selection belongs only to the design ledger fold.
- Unidirectional dependency rules reduce to: aliases → `dispatch`; `dispatch` → nothing.

### Boundary changes

- `alignment.md`'s role as the shared review contract moves to `references/review.md`, and its
  Terms section moves to `glossary.md`. I02 creates `review.md` (content moved as-is), deletes
  `alignment.md`, and repoints every script, template, fixture, and test reference
  (`resolve-artifact-paths.mjs`, plan/walkthrough templates, `review-corpus/baseline.json`,
  `generate-hashes.test.mjs`, integration tests including the prose-asserting `*-contracts`
  tests), plus every `alignment.md` link in shipped SKILL.md files and `.agents/AGENTS.md`
  (scanned by `link-integrity`); I06 trims its prose.
- Reference assets move as follows (I02):

  | Current | v0.5 |
  |---|---|
  | `dispatch/references/walkthrough-contract.md` | merged into `review.md` |
  | `*-review/references/prompt-template.md`, `rebuttal-template.md` | `templates/` shared frame + kind blocks |
  | `*-review/references/report-schema.json`, `rebuttal-schema.json` | `templates/schemas/` |
  | `plan-template.md`, `design-template.md`, `walkthrough-template.md` | `templates/` |
  | `implement-dispatch/references/{ledger,verification,implementation-delegate}-contract.md` | `verbs/implement.md` |
  | `implement-dispatch/references/design-contract.md` | `verbs/design.md` |

- Script assets move as follows (I01–I02): `resolve-flow.mjs` → config resolution (I01);
  per-kind `prepare-review.mjs`/`parse-report.mjs` → one kind-parameterized module;
  `plan-lint.mjs`, `design-lint.mjs`, `resolve-review-range.mjs` → `dispatch/scripts` unchanged in
  behavior; every other `implement-dispatch/scripts` module → `dispatch/scripts`.
- Every `alignment.md` reference in CLAUDE.md/AGENTS.md (Host Neutrality, the upstream-naming
  exception, Cross-Skill Alignment, the scratch allowlist's `§ Wave and lifecycle`) is repointed
  to `review.md` in I02; I06 rewrites the architecture and dependency sections.
- Every increment leaves `npm test` and the pre-commit hook green. Tests, repo tooling
  (`scripts/validate-configs.mjs`, `scripts/generate-hashes.mjs`, `.husky/pre-commit`), and
  integration contract tests move or retire in the same increment as the code they cover. Every
  increment that touches `skills/` regenerates `skill-hashes.json` (`npm run hashes`, also run by
  the pre-commit hook) and keeps `HASHED_SKILLS` and the hook's pattern in sync with moved skills.

## Alternatives & Decisions

Each decision gives the ruling first, then the rationale.

- **D1 — Merge into one `dispatch` skill.** Chosen over trimming prose inside separate skills.
  Trimming alone leaves the 16-CLI choreography and the duplicated modes in place, so savings stop
  at ~20–30%. The user accepted reduced isolation for this.
- **D2 — Drive the workflow from a script, not prose.** A prose state table would still depend
  on the agent recalling rules, which conflicts with the correctness-first trade-off. The scripts
  already enforce the invariants, so the prose copy was redundant.
- **D3 — Drop legacy compatibility (user ruling).** v0.5.0 is breaking anyway. Legacy branches
  (old artifact decisions, `ACTIONABLE`, old configs) add contract and code surface for no
  ongoing benefit. A clear schema diagnostic replaces migration tooling.
- **D4 — Keep consensus rebuttals (user ruling).** The host can be wrong. Letting it overrule
  delegates unchecked would weaken the "claims, not verdicts" pillar. Users who want host-final
  rulings set `consensus: false` per level. Proposed alternative rejected: host-final rulings with
  one rebuttal for rejected `MUST` findings only.
- **D5 — Keep the technical-design / increment flow (user ruling).** It moves onto the driver
  unchanged in substance. It loads only for `design` or a design path, so it costs nothing on
  ordinary runs.
- **D6 — Replace `disable-model-invocation` on implement with aliases (user ruling).** One
  model-visible skill means the model could start `implement`. User invocation is preferred: the
  contract tells the model to run `implement` only on an explicit user request. Model-started runs
  are tolerated rather than blocked, because a script cannot reliably tell who started a run; the
  approval gate before production writes still applies. The alias skills keep the familiar slash
  commands, and marking them `disable-model-invocation` removes duplicate descriptions from the
  always-listed skill context and stops triggers competing.
- **D7 — Standalone review is report-only by default; `--fix` opts in (user ruling, reverses the
  earlier keep-autofix ruling).** With one model-visible skill, a review the model starts on its
  own must not edit files. Opt-in autofix still costs only one action branch, since it reuses
  `apply-fixes`.
- **D8 — "Phase" and "increment" stay separate terms (user question).** A phase is a workflow
  unit, while an increment is a design-graph unit that runs all phases. Merging the words would
  make `--phases from:X` ambiguous and blur ledger semantics. `from:<phase>` is accepted because
  phase order is fixed. Increments stay selected only by the ledger's `Next Action`, which
  preserves the v0.4 guarantee that only ledger-proven-ready work is dispatched.
- **D9 — No automated word or byte budgets (user ruling).** Word counts are an unreliable proxy,
  and features may legitimately need more words. Targets are measured and reported at final
  integration (AC6) instead of failing `npm test`.
- **D10 — No driver output cap (user question).** A hard cap would truncate findings or clusters
  on large tasks, which is a correctness failure. Spilling to files would not save tokens either,
  because the agent must read everything an action lists. The savings come from structure:
  references in place of bodies, and no verbose JSON by default.
- **D11 — `ask` accepts a level without pins (user ruling).** The level selects the model tier
  across the ordinary cascade, e.g. `/dispatch high: research X`.
- **D12 — Enforce terminology with a deterministic check.** A banned-synonym check is exact and
  cheap, unlike size budgets, and prevents the v0.4 drift from coming back. It is scoped to prose
  and enabled only after the rewrite, so it never fails on untouched v0.4 text or code identifiers.
- **D13 — Keep all five levels (user ruling).** Nearest-level resolution already keeps sparse
  configs cheap.
- **D14 — Two candidate tables plus per-phase policy (user ruling).** `read-delegates` and
  `write-subagents` define every model once; `phases` holds only policy and an `only` filter. This
  removes the replace-or-filter ambiguity and the triplicated platform table, at the cost of
  per-phase model choice.
- **D15 — `--phases` accepts only `from:<phase>`.** Explicit lists add combinations that skip
  gates without a use case that `from:` or a standalone verb does not cover.
- **D16 — Lightweight driver measurement after I03 (user ruling).** I03 records driver stdout bytes for one
  fixture `review code`, compared against the summed stdout of the v0.4 `prepare-review`,
  `parse-report`, `source-map`, and `check-consensus` runs for the same review (run from a
  `v0.4.0` tag worktree, since I02 removes those scripts), captured with `wc`,
  with no new harness. Contract words are measured only at AC6, because the contract rewrite lands
  in I06. If the driver is not cheaper, re-plan I04–I05 before continuing.
- **D17 — Driver-carried conditional guidance.** Branch-specific rules (for example what `--fix`
  adds) live in the actions the driver emits, not in always-loaded prose.
- **D18 — Shared delegate prompt frame, separate rubrics (user ruling, conditional on
  similarity).** The plan and code prompt templates share their frame, but about 67 of their 139
  combined lines differ (inspection scope, tags, locus); the design prompt differs more. Only the frame is merged.
  The saving is in maintenance, not host tokens, because these prompts go to delegates.

- **D19 — Phases are entry points; `from:` runs forward (review ruling).** Only verb-backed
  phases stop after themselves. `until:` and gate-stops were rejected as extra grammar with no use
  case beyond resuming.
- **D20 — First review adjudication (three providers).** 13 findings accepted into R2, R3, R9, and I01–I06. Rejected: renaming CLIs cited in Context, and applying R9 to this design's prose.
- **D21 — Second review adjudication (2026-09-21; agy, claude, opencode).** 30 findings accepted into the grammar, R1–R3, R8, the ACs, and I01–I02. User rulings: `ask` stays off the driver but keeps level and pins; `review <walkthrough.md>` keeps v0.4 scope; level-less driver verbs are classified and `ask`/uncertain inputs default to `medium`; classified levels are raised, explicit ones honored; a colon-less prefix-only input runs as that verb; `ask` pins resolve inside the runner. Rejected: blocker severity for hash drift; Paths exhaustiveness.
- **D22 — Third review adjudication (2026-09-21; agy, claude, opencode).** 15 findings accepted into R1–R3, R8, AC2, and I01–I04. User rulings: prefix-only `plan`/`design`/`implement` fail with a usage diagnostic; `implement: <plan.md>` starts at `plan-review`; `plan` writes no ledger, and a `from:` past `plan-review` without recorded approval asks for it first.
- **D23 — Fourth review adjudication (2026-09-21; agy, claude).** Accepted: phase input/output table (`baseline`, `handoff` defined); green-per-increment fixes (moved tests, `flag-parity` CLI list, `v04-phase*-contracts`, the hook's `git add` list, `generate-hashes.test.mjs`, the `dependency-direction` probe exception); nested-template integrity in `fill-template.mjs`; the D16 baseline taken from a `v0.4.0` worktree; the state-resume rule; AC3 exempts R7 deletions; `default` level source raised like `classified`; `--run` limited to driver verbs; `launch` omits `--input`; `--doctor` shows write-subagents by `--orchestrator`; `review-skill-parity` rewritten as an assembly test; `.agents/AGENTS.md` as the edit target; `skills-lock.json` dropped from I06. User rulings: D20–D22 collapsed; a review phase disabled at every level is skipped, not failed. Rejected: explicit hash-check validation in I01 (already covered by the per-increment rule).

## Risks, Security & Operations

- **Driver becomes a monolith.** Mitigation: one module per phase, each with its own tests; the
  driver entry only routes.
- **Just-in-time hints omit a rule the agent needs.** Mitigation: parity tests from AC3, plus an
  audit run against v0.4 fixtures before release.
- **The model starts `implement` unprompted (D6).** Mitigation: the approval gate before
  production writes is unchanged and driver-enforced.
- **Banned-synonym false positives.** Mitigation: the check skips code spans and fenced
  blocks, and release notes are out of scope (R9).
- **Breaking change for installed users.** Old configs are rejected with a schema diagnostic, and
  the alias skills keep the familiar slash commands working. The release notes map each old config
  field to its new one.
- **`dispatch` no longer self-triggers on intent (R5, user ruling).** A syntax-only description
  may stop the model picking `dispatch` for research or review on its own. Accepted: users invoke
  it explicitly; revisit if telemetry shows missed use.
- **Security.** The read-only runner boundary, credential stripping, attachment bounds, and
  delegate-text sanitization are unchanged. The driver restates sanitization as a hint on every
  `adjudicate`.
- **Rollback.** Each increment lands on the release branch. Reverting to the v0.4.0 tag restores
  the prior skills. No persisted format is shared across versions (D3), so release notes tell
  users to keep a copy of their v0.4 config files before upgrading.

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | Glossary, unified config, and level resolution | none | skills/dispatch/references/glossary.md, skills/dispatch/config.sample.jsonc, skills/dispatch/scripts, skills/implement-dispatch, scripts/check-terms.mjs, scripts/validate-configs.mjs, scripts/generate-hashes.mjs, .husky/pre-commit, skills/dispatch/SKILL.md, skills/dispatch/README.md, tests/skills/dispatch, tests/skills/implement-dispatch, tests/scripts, tests/integration, docs |
| I02 | 2 | Consolidate review assets and scripts under dispatch; drop legacy | I01 | skills/dispatch, skills/dispatch-plan-review, skills/dispatch-code-review, skills/dispatch-design-review, skills/implement-dispatch, scripts/generate-hashes.mjs, .husky/pre-commit, .agents/AGENTS.md, tests |
| I03 | 3 | Driver protocol and standalone review phases | I02 | skills/dispatch/scripts, skills/dispatch/references/templates, tests/skills/dispatch |
| I04 | 4 | Implement verb as composed phases | I03 | skills/dispatch/scripts, tests/skills/dispatch |
| I05 | 5 | Design verb and increment execution on the driver | I04 | skills/dispatch/scripts, tests/skills/dispatch |
| I06 | 6 | Contract rewrite, aliases, and docs | I05 | skills, README.md, .agents/AGENTS.md, tests/integration, package.json |

## Increment Details
### I01
- Outcome: A single glossary and a single config drive terminology, cascade membership, level policy, per-phase policy, and implementation subagents.
- Scope: `glossary.md`; `check-terms.mjs` with fixture tests only (not yet run on the shipped tree); new config schema (`read-delegates`, `write-subagents`, `phases`) and validation; uniform level resolution, including `ask` with a level and no pins; runner `--level` and `--pins` flags, with `--pins` resolving named/count/`all` pins and launching the wave in one invocation; `--doctor --level <level>` output; rejection of v0.4 configs; in the same increment, delete `implement-dispatch/config.sample.jsonc` (and any repo-local config) in favor of the v0.5 `dispatch/config.sample.jsonc`, and update `validate-configs.mjs` discovery and its test, so the pre-commit config validation stays green; move `resolve-flow.mjs` logic into `dispatch/scripts`, repoint the implement-dispatch contract, `validate-configs.mjs`, `docs/implement-dispatch-notes.md`, and the `flag-parity` CLI list to it, and port their tests; drop `implement-dispatch` from `HASHED_SKILLS`, the pre-commit pattern, and the hook's `git add` list, delete its `skill-hashes.json`, and update `generate-hashes.test.mjs`, because `resolve-flow.mjs` was the only verifier of its manifest; allowlist the v0.4 config probe in `dependency-direction.test.mjs` (R1); add `--level`, `--level-source`, and `--pins` to the SKILL.md and README flag tables (flag-parity); introduce the R8 per-slot runner line and port the runner tests that parse stdout.
- Non-scope: Driver, verb routing, contract prose rewrite.
- Observable behavior: `dispatch.mjs --doctor --level high` prints the resolved targets, rounds, and consensus for all three review phases (including `design-review`), plus the write-subagent fields; `dispatch.mjs --pins 3 "<prompt>"` launches the first three resolved targets in one invocation; v0.4 configs, including a v0.4 `dispatch` config with top-level `platforms`, fail with a schema diagnostic naming the key map; a seeded banned synonym fails the check-terms fixture test.
- Affected contracts: config schema (breaking); `resolve-flow` logic moves into dispatch; runner stdout (R8).
- Validation: Config and resolution suites ported and passing; doctor output snapshots; the AC5 check-terms tests.
- Rollback boundary: Restores the per-skill configs and `resolve-flow.mjs`.
- Parallel safety: Unsafe beside I02, which moves shared script paths.

### I02
- Outcome: Every template, schema, preparation, parse, and lint asset lives under `dispatch`, with legacy branches removed.
- Scope: Move and merge the plan/code/design preparation and parsers into one kind-parameterized module; move every remaining `implement-dispatch/scripts` module (ledger, ledger events, rebuttal packets, design run/amendment, implementation outcome, verification evidence, Git state) and `plan-lint.mjs`, `design-lint.mjs`, `resolve-review-range.mjs` under `dispatch/scripts`; merge the review prompt and rebuttal templates into a shared frame with per-kind blocks (R10), with `fill-template.mjs` concatenating frame and kind block before substitution, and its `resolveSkillRoot` walking up to the nearest `skill-hashes.json` so templates under `references/templates/` stay integrity-checked (with a nested-template drift test); move each moved script's tests into `tests/skills/dispatch` in the same change (ledger, ledger-events, rebuttal-packets, design-run/amendment, implementation-outcome, verification-evidence, git-state), so later increments port behavior, not paths; update every SKILL.md script path, `generate-hashes.mjs`, `.husky/pre-commit`, the `flag-parity` CLI list, and the path-bound integration tests (`dependency-direction`, `link-integrity`, `path-convention`); rewrite `review-skill-parity` as a frame-plus-kind-block assembly test; repoint the prose-asserting `*-contracts` tests (including `v04-phase0/2/5a/5b-contracts`) to `review.md` and the `verbs/` files, or retire the assertions whose source text the move deletes; repoint every `alignment.md` link in SKILL.md files and `.agents/AGENTS.md`; delete legacy decision paths and `ACTIONABLE` handling.
- Non-scope: Driver, and the skill contracts beyond path updates.
- Observable behavior: Review preparation runs from `dispatch` for all three kinds, with identical manifests apart from the removed legacy fields.
- Affected contracts: prepare-review request/manifest (legacy fields removed); resolution-log grammar (legacy statuses removed).
- Validation: Ported prepare, parse, lint, resolution-log, and moved implement-dispatch suites pass; legacy fixtures and `ACTIONABLE` cases (`check-consensus`, `resolution-log`, `review-skill-parity`) are deleted with their tests.
- Rollback boundary: Restores the per-skill script copies.
- Parallel safety: Unsafe beside I01 and I03 (shared module paths).

### I03
- Outcome: `dispatch.mjs --run review <kind>` and `--next` drive a full standalone review phase through the closed action set.
- Scope: Driver entry (`--run`/`--next`), run state file, every action schema and non-terminal reply schema (`delegate-write` is first emitted in I04), and the actions `author`, `launch`, `native-fallback`, `adjudicate`, `apply-fixes`, `verify`, `ask-user`, and `done`; consensus/rebuttal and checkpoint inside the driver; one batch `launch` per wave; branch-scoped action guidance (D17); rebuilding the state cache from artifacts; content-scaled output.
- Non-scope: Implementation, design, increments.
- Observable behavior: An ad-hoc `review plan|code|design` completes with only `dispatch.mjs` invocations; `review code` is report-only unless `--fix` is given, and `--fix` routes ambiguous findings to `ask-user`.
- Affected contracts: new driver action schema (versioned).
- Validation: Scripted-agent integration tests replay recorded delegate reports through every action, including rebuttal, fallback, cap, and drift paths; the AC4 no-truncation fixture; the D16 measurement recorded in the increment walkthrough.
- Rollback boundary: Removes the driver; I02's preparation remains directly usable.
- Parallel safety: Unsafe beside I04 (shared driver core).

### I04
- Outcome: `implement` runs the ordinary phases chained, and each phase is also runnable through `--phases from:<phase>`.
- Scope: The `plan` verb; phase modules for `plan`, `plan-review` (reusing the I03 review core), `baseline`, `implementation` (native subagent cascade, RED gate, attempt budget, clusters, v1 ledger), `code-review` (walkthrough-scoped, reusing the I03 review core), and `handoff`; the approval gate (including `ask-user` approval for a `from:` past `plan-review` with none recorded) and `delegate-write`; prefix-only usage diagnostics; `--phases from:<phase>` parsing (lists rejected); refusal when a prerequisite phase is missing, with a fixture for an unreviewed plan.
- Non-scope: Technical designs and increments.
- Observable behavior: `implement --phases from:code-review` on an approved plan and walkthrough behaves the same as the `code-review` and `handoff` phases inside a full run.
- Affected contracts: v1 ledger events unchanged; implementation-outcome envelope unchanged.
- Validation: Ported ledger, outcome, verification-evidence, and clustering suites; the AC2 parity tests.
- Rollback boundary: Removes the implement driver; the review verbs from I03 remain.
- Parallel safety: Unsafe beside I05 (shared ledger module).

### I05
- Outcome: The `design` verb and `implement <design.md>` increment execution run on the driver, with `--phases` scoped to the ledger-selected increment.
- Scope: v2 ledger fold, Next Action derivation, increment binding, amendment transactions, and the `integration` phase.
- Non-scope: Changes to design-template semantics; user selection of increments.
- Observable behavior: One increment per invocation, stopping at `design-approved-stop` or `run-complete`, the same as v0.4; `--phases from:code-review` resumes within the active increment only.
- Affected contracts: v2 ledger and design contract unchanged in substance.
- Validation: Ported design-run, design-amendment, design-graph, and design-promotion suites pass against the driver.
- Rollback boundary: Removes the design phases; ordinary implement stays working.
- Parallel safety: Safe beside I06 drafting, unsafe beside I04.

### I06
- Outcome: Lean contracts that use the glossary, and working aliases.
- Scope: Rewrite `dispatch/SKILL.md` (its description states only the invocation syntax), `review.md`, and the implement/design verb references; alias SKILL.md files, including a missing-`dispatch` diagnostic and a per-host check of `disable-model-invocation`; retire or rewrite the v0.4 prose-asserting integration tests (`phase0-contracts`, `v04-phase*-contracts`); READMEs and the root README; `.agents/AGENTS.md` architecture/dependency sections (edited at the target, keeping `.claude/CLAUDE.md` a symlink); enable `check-terms.mjs` in `npm test`; move runner flags to `--help` and port `flag-parity.test.mjs` (R8); the `--fix`-only-on-user-request rule (R6); hash regeneration and README install-table updates; release notes with the config field map and the D1–D22 rationale.
- Non-scope: Runner or driver behavior; automated size budgets.
- Observable behavior: Each alias slash command routes to the right verb; `check-terms.mjs` passes.
- Affected contracts: skill interfaces (breaking, documented).
- Validation: `npm test`; an audit-dispatch-skills run over the new layout.
- Rollback boundary: Restores the v0.4 prose on top of the new scripts.
- Parallel safety: Contract drafting is safe beside I05; the final merge is unsafe.

## Final Integration

- Run the dispatch-skills audit over the full layout.
- Execute each verb end to end against a sample repo:
  - `ask`, with and without a level and pins;
  - `plan` and `design`;
  - `review` for each of the three kinds;
  - a full `implement`;
  - `implement --phases from:code-review`;
  - one design increment, including `--phases` within it.
- Report the contract words loaded and the driver output bytes per verb (runner stdout bytes for `ask`) against the AC6 targets and the v0.4 baseline.
- Confirm that every alias routes correctly and that `npm test` is green.

## Execution Status
### Completed

| I01 | complete | Glossary, unified config, and level resolution |
| I02 | complete | Consolidate review assets and scripts under dispatch; drop legacy |
| I03 | complete | Driver protocol and standalone review phases |
| I04 | complete | Implement verb as composed phases |
| I05 | complete | Design verb and increment execution on the driver |

### Ready

| I06 | ready | Contract rewrite, aliases, and docs |

Next Action: implement:I06


## Review Findings & Resolutions
<!-- machine-managed review history; excluded from governed content -->
