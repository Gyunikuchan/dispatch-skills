# Plan

Use `plan` when the change can be delivered and verified as one coherent unit.

## What happens

Dispatch helps identify the outcomes, affected files, prerequisites, and verification steps, then applies the review policy enabled for your level. Read the plan and approve its verification commands before production changes begin.

### Flow at a glance

```mermaid
flowchart TD
    Change["One coherent change"] --> Plan["Create a plan with outcomes,<br/>prerequisites, files, and checks"]
    Plan --> Review["Apply the configured<br/>plan review policy"]
    Review --> Approval["You inspect and approve<br/>the plan and its checks"]
    Approval --> Implement["Run implement with the<br/>approved plan path"]
```

## How to use it

Describe the behavior you want, its constraints, and how you will know it is complete.

```text
/dispatch plan: Add idempotency keys to webhook delivery
/dispatch review plan: <plan path returned by Dispatch>
/dispatch implement: <approved plan path>
```

The separate review command is useful when you want another review pass. For work that needs ordered delivery increments, use [design](design.md) instead.
