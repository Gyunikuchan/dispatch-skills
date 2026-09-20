# implement-dispatch

Run a feature or fix through a plan, implementation, verification, and review loop when a single
agent pass is not enough. It coordinates optional plan and code review skills around
[`dispatch`](../dispatch/README.md).

```mermaid
flowchart TD
    User(["👤 User Request"]) --> Plan["📝 Draft Plan"]
    Plan --> Scope["⚙️ Initial Change Scope & Flow"]
    Scope --> PlanReview["⚡ Plan Review"]
    PlanReview --> FinalScope["⚙️ Final Change Scope & Level Check"]
    Scope -.->|review skipped| FinalScope
    FinalScope --> Baseline["🧪 Baseline Verification"]
    Baseline --> Gate{"🛑 Implementation Approval"}
    Gate --> Implementation["💻 Test-First Implementation"]
    Implementation --> CodeReview["⚡ Code Review"]
    CodeReview --> Fix["🔧 Apply Fixes & Verify"]
    Fix --> Consensus{"🔄 Consensus?"}
    Consensus -->|Findings remain| CodeReview
    Consensus -->|Settled| Handoff["📦 Handoff & Cleanup"]
    Consensus -->|Cap or deadlock| User
```

## Prerequisites & Installation

### Requirements

`dispatch` is required. Install `dispatch-plan-review` to review the plan before implementation
and `dispatch-code-review` to review the resulting changes. See [`dispatch`'s prerequisites and
installation guide](../dispatch/README.md#prerequisites--installation) for Node.js, provider
setup, installation scopes, and shared runner behavior.

### Install

Install the workflow with its required dependency:

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch --skill implement-dispatch
```

Add `-g` to install globally, or `-s '*'` to install the complete suite:

> [!NOTE]
> Install companion skills in the same installation scope: keep them all project-local or all global so sibling
> scripts and templates can resolve one another.

## How to Use

Run `/implement-dispatch` and describe the feature or fix.

Resume an interrupted ordinary run from its canonical plan:

```text
/implement-dispatch .scratch/plan/2026-09-20-auth-v2.md
```

Resume reads the durable per-user ledger in OS temp, verifies completed task state against the
working tree, re-resolves the current flow, and asks before dispatching. A missing ledger triggers
explicit best-effort reconstruction; malformed events, hash drift, or an invalid plan path require
reconciliation rather than automatic redispatch. Native plan paths must first be represented by a
canonical scratch plan and explicit slug.

### Basic examples

Use automatic change-scope selection for a typical feature:

```text
/implement-dispatch Add a CSV export button to the transactions table
```

Choose a lighter pass for a small, mechanical change:

```text
/implement-dispatch low: Rename Household.owner to primaryHolder
```

Request deeper review for a cross-cutting change:

```text
/implement-dispatch high: Refactor the payment webhook idempotency handler
```

### Choose a review level

The level is optional. If omitted, the skill selects `low`, `medium`, or `high` from the request's change scope.

| Level | Use for |
|---|---|
| `low` | Small, mechanical, or low-risk changes |
| `medium` | Typical features, fixes, and bounded refactors |
| `high` | Cross-cutting changes, complex refactors, or public contracts |
| `xhigh` | Security-sensitive or invariant-heavy work |
| `max` | Critical migrations or subsystem overhauls |

`medium` is the usual choice. Request `xhigh` or `max` explicitly when the change warrants it.

> [!NOTE]
> In `config.sample.jsonc`, `low` skips plan review but still runs one code-review round. An
> uninstalled optional companion skips its phase entirely.

### Choose providers or reviewer count

Use the same provider-pin syntax as [`dispatch`](../dispatch/README.md#choose-a-provider), or
replace the configured reviewer count for both review phases:

```text
/implement-dispatch (all): Implement the OAuth2 PKCE authorization flow
/implement-dispatch (claude,copilot): Compare two approaches to the cache invalidation change
/implement-dispatch high (3): Refactor the payment webhook idempotency handler
```

Named platforms all run when configured. A number such as `(3)` requests up to three reviewers
for each enabled review phase; `(all)` uses every configured review target. Count and `all`
selection preserve configured order, moving the current platform behind alternatives and an exact
current platform/model match to the end.

> [!NOTE]
> Provider pins select review delegates. The implementation subagent is selected separately in
> this skill's configuration, and every review provider must also be enabled in `dispatch`.

## Configuration

Create `config.local.jsonc` or `config.jsonc` beside this skill and use
[`config.sample.jsonc`](config.sample.jsonc) as the schema reference. Provider credentials,
models, fallback, and shared runner settings remain in `dispatch`.

Inspect the resolved policy before a run with:

```bash
node scripts/resolve-flow.mjs --show-effective --platform copilot --level high
```

The workflow matrix intentionally differs from `dispatch`'s standalone defaults: this skill
chooses phase- and level-specific reviewers plus a native implementation model; `dispatch` owns
general cascade membership and provider defaults. A level key resolves by exact match, otherwise
the nearest lower key, otherwise the lowest higher key. With `{ medium: A, max: B }`, `low` uses
`medium`, `high` uses `medium`, and `max` uses `max`.

> [!NOTE]
> Configuration files replace one another rather than merge. Copy `config.sample.jsonc` to
> `config.jsonc` (or `config.local.jsonc`) and keep every review provider enabled in `dispatch` as
> well.

Every implementation platform entry must resolve an explicit `model` (a string or fallback model
array like `["gpt-5.6-luna", "bedrock.gpt-5.6-luna"]`); a missing model stops flow resolution with
the exact configuration key to update. Implementation entries are objects, not review candidate
arrays. Higher level keys provide native-only escalation tiers when their launcher-supported model
or effort differs; flat entries and `max` cannot escalate. Launchers try array models in order upon
quota or availability failure.

## What to expect

1. The skill prepares an initial draft plan.
2. It scopes the draft and resolves the execution flow.
3. It reviews the plan when `dispatch-plan-review` is installed and enabled.
4. It creates the walkthrough and runs the plan's automated verification commands as a baseline.
5. It asks for implementation approval after baseline reconciliation, then implements test-first
   and reruns fresh verification. Implementation launches return typed outcomes; delegated work
   has at most three native-platform attempts and `self` execution (a subagent on the host platform)
   has at most two.
6. It reviews and fixes the changes when `dispatch-code-review` is installed and enabled,
   repeating the review until findings are settled or the configured limit is reached.
7. Review-owned preparation manifests carry artifact freshness, bounded views, and dispatch argv;
   settled reviews checkpoint metadata for the next invocation.
8. It reports unresolved disagreements or configuration problems instead of silently ignoring them.
9. Approved runs append fsynced execution events to a private, repository-isolated ledger so a
   fresh session can avoid redispatching work already proven complete.

`dispatch` appends content-free telemetry to `<tmp>/dispatch-telemetry-<username>/telemetry.jsonl`;
disable it with `DISPATCH_TELEMETRY=0`.

> [!NOTE]
> The workflow writes no production code before implementation approval. Before that approval it
> may ask whether to proceed with a known-red baseline, reconcile a baseline command's file side
> effects, or proceed when Git side-effect capture is unavailable.

The skill changes the working tree but does not commit, push, create branches, or open pull
requests.

The ledger is not a review artifact and is not moved during handoff. Its exact path and canonical
resume command are reported because OS temp cleanup, including Windows Storage Sense, can remove it.

## Nuances, Quirks & Troubleshooting

- **A review phase is missing:** Install the corresponding companion skill, or install the complete
  suite with `npx skills add Gyunikuchan/dispatch-skills -s '*'`.
- **A provider is unavailable:** Configure and authenticate it through `dispatch`; see
  [`dispatch`'s troubleshooting guide](../dispatch/README.md#nuances-quirks--troubleshooting).
- **You need a different review depth:** Pass a level such as `low` or `high`, or adjust the
  level-specific settings in `config.local.jsonc`.
