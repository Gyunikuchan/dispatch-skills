# dispatch Maintainer Notes

Maintainer context for `skills/dispatch` scripts shared by the review skills. Not shipped.

## Consensus Gate

`skills/dispatch/scripts/check-consensus.mjs`

Validates whether an artifact's `## Review Findings & Resolutions` section has converged on clean consensus.

- **CLI Usage**:
  ```bash
  node skills/dispatch/scripts/check-consensus.mjs [--json] <artifact path>
  ```
- **Exit Codes**:
  - `0`: Settled (`Consensus: settled`) — no unsettled lines found, or `## Review Findings & Resolutions` section absent.
  - `1`: Unsettled (`Consensus: <n> unsettled line(s)`) — lists active `[Disputed]` or `[Rejected — pending confirmation]` lines.
  - `2`: Usage error, missing arguments, unreadable artifact file, or invalid resolution log
    (strict parse failure in both output modes).
- **JSON Mode**: Returns `{ settled, unsettled }`; each unsettled record has a durable or
  invocation-local key, nullable ID, severity, source keys, status, line number, and original line.
- **Shared evaluator**: `evaluateConsensus(markdown)` returns `{ exit, unsettled, unsettledItems, error? }`
  from the same strict scan; both `prepare-review.mjs` `checkpoint-preview` actions call it so a
  preview can never report settled where the gate would not.
- **Parsing Invariants**:
  - CommonMark-compliant fenced code block skipping (prevents example templates from triggering false positives).
  - Unclosed fence detection triggers fail-closed scan across the entire file.
  - Regex accepts em-dash, en-dash, and hyphens in `[Rejected — pending confirmation]`.

## Config Module (`scripts/config.mjs`)

Single loader and validator for the v0.5 config: `read-delegates` (required), `write-subagents`
and `phases` (optional; absent tables normalize to `{}`). Level keys resolve exact, then nearest
lower, then lowest higher; flat entry fields stand in for levels below the lowest override.

- **v0.4 rejection**: top-level `platforms`, `plan-review`, `code-review`, `design-review`, or
  `implementation`, or a sibling `implement-dispatch/config[.local].jsonc`, raises
  `LEGACY_DISPATCH_CONFIG`. Full v0.4 → v0.5 key map:
  - `dispatch` top-level `platforms` → `read-delegates`;
  - `implement-dispatch` `plan-review`/`code-review` sections → `phases.<phase>` (and new
    `phases.design-review`, which v0.4 took from plan-review policy);
  - `targetCount` → `targets`; `maxRounds` → `rounds`; `consensus` → `consensus`;
  - per-section `platforms` → `only` (membership) plus `read-delegates` (models; per-phase model
    choice is dropped);
  - `implementation.platforms` → `write-subagents`;
  - `implement-dispatch/config[.local].jsonc` is retired.
- **Probe exception**: the retired sibling directory name appears once in shipped code, on the line
  marked `v0.4 config probe`, so the dependency-direction test stays exact.
- **Flow resolver**: `scripts/resolve-flow.mjs` moved here from the workflow skill; it reads
  `phases` and `write-subagents` from the same file.

## Waves and Slot Lines

- **`--pins`**: builds an `ask:R1` wave in-process. Named pins are provider-pinned cascades with
  no reserves; a count or `all` follows `--list-targets` order, clamping an over-large count with a
  stderr diagnostic.
- **R8 slot line**: each terminal slot prints one stdout JSON line
  `{slot,platform,status,exit,session,output}`; `output` is an owner-only (0600) OS-temp report
  file inside one `dispatch-slots-*` OS-temp directory per run. The runner never deletes it: the
  caller owns it, reads each `output`, and removes the directory (like dispatch logs, it is
  otherwise left to OS temp cleanup). The `--output-file` envelope is unchanged.
- One `[dispatch] level=<l> source=<s>` stderr line is written per run.

## Test Suite Structure

- `tests/skills/dispatch/check-consensus.test.mjs`: Legacy/enriched consensus parsing, structured
  output, fenced markdown handling, `evaluateConsensus`, and exit codes.
