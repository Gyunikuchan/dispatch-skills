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

## Test Suite Structure

- `tests/skills/dispatch/check-consensus.test.mjs`: Legacy/enriched consensus parsing, structured
  output, fenced markdown handling, `evaluateConsensus`, and exit codes.
