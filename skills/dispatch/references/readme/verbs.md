# Choose a Dispatch verb

Start with the smallest verb that matches the work you have. These are entry points, not mandatory steps: use what you already have and skip phases you do not need.

## Contents

- [What each verb does](#what-each-verb-does)
- [How to invoke a verb](#how-to-invoke-a-verb)
- [Use each verb](#use-each-verb)
- [Choose where to start](#choose-where-to-start)

## What each verb does

| Verb | Choose it when… | Result |
|---|---|---|
| `ask` | You have a focused question about the repository | Independent analysis that the host checks against the code |
| `design` | The change crosses boundaries, needs a migration, or should ship in several increments | A design and ordered delivery outline, with reviews set by configuration |
| `plan` | The change is one coherent unit of work | A plan with scope and verification steps, with reviews set by configuration |
| `review` | A design, plan, or code change already exists | Cited findings, with fixes only when requested |
| `implement` | You want an approved requirement or artifact carried through delivery | Planning, approval, changes, verification, review, and handoff |

## How to invoke a verb

```text
/dispatch [level] [(pins)] [verb:] <argument>
```

The verb is optional; without one, Dispatch uses `ask`. Levels route to the models and review policy in your configuration. Pins choose providers, a target count, or all eligible configured targets.

```text
/dispatch: Trace how expired sessions are removed
/dispatch high (all): Could concurrent refreshes issue two valid tokens?
```

## Use each verb

### `ask`: investigate a focused question

Use a bounded question that names a decision, uncertainty, or relevant area. The delegates provide independent claims; the host checks their evidence and answers. An ask does not make repository changes.

```text
/dispatch: Compare the retry strategies in src/queue/
```

### `design`: organize a larger change

Use design when the work has shared interfaces, migration or rollback concerns, or several ordered increments. Dispatch creates a design and applies the configured plan-review policy. A later implementation invocation uses the approved design to deliver its increments.

Design increments remain sequential; independent tasks inside an increment can run concurrently when configured.

```text
/dispatch design: Migrate billing from mutable balances to a ledger
/dispatch implement: <approved design path>
```

### `plan`: prepare one unit of work

Use plan when the change can be delivered and verified as one coherent unit. Describe the behavior, constraints, and success criteria. Dispatch identifies affected files and checks, then reviews the plan according to your configuration.

```text
/dispatch high (claude,agy) plan: Add idempotency keys to webhook delivery
/dispatch review plan: <plan path returned by Dispatch>
```

### `review`: check work that already exists

Review a design, plan, working tree, or Git range:

```text
/dispatch review design: <design path>
/dispatch review plan: <plan path>
/dispatch review code
/dispatch review code: main..HEAD
```

With no range, code review covers uncommitted changes only. A clean working tree has nothing to review; name a range to include committed work. Reviews are report-only by default. Add `--fix` when you want accepted, safe findings applied and verified:

```text
/dispatch review code --fix
```

The host evaluates cited findings against the code and the work's intended outcome. Reviewers do not settle findings by vote.

### `implement`: deliver a requirement or approved artifact

A plain-language requirement starts with planning. An approved plan or design path resumes from that artifact. Dispatch pauses for your approval before production changes, then runs the approved checks and configured code review.

```text
/dispatch implement: Add CSV export to the transactions page
/dispatch implement: <approved plan path>
```

Implementation respects the artifact's prerequisites and recorded decisions. It does not skip required review or verification when resumed.

## Choose where to start

| You have… | Start with… |
|---|---|
| A repository question or uncertain behavior | `ask` |
| A change with several dependent parts | `design` |
| One change ready to scope and verify | `plan` |
| An existing design, plan, diff, or branch | `review` |
| A requirement or approved artifact to deliver | `implement` |

If you are unsure between design and plan, ask whether the change can ship as one independently verified unit. If yes, use plan; if it needs ordered delivery steps, use design.

For approval, artifacts, and verification details, see [Workspaces and results](concepts.md).
