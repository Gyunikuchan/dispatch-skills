# Findings format

One file per scope at `.scratch/audit-dispatch-skills/<run>/work/findings/<scope-id>.md`. Report **claims** with evidence; the orchestrator verifies and ranks. One finding per defect: identical defects across locations share one finding with several locations.

```md
# Findings: <scope-id>

## Files opened
- <every file you read, one per line>

## Findings

### <scope-id>-<n>: <one-line title>
- **Severity**: critical | high | medium | low | nit
- **Axis**: <axis key from your brief>
- **Location**: `path:line` (one per location)
- **Claim**: what is wrong, one or two sentences.
- **Evidence**: quoted lines, command plus output, or the contradicting source.
- **Proposal**: the concrete change — replacement text, test case name plus the branch it covers, code move with destination.

## Axis coverage
| Axis | Status | Notes |
|---|---|---|
| <axis key> | ✓ checked / — n/a / ✗ not reached | files covered, or the reason |

## Proposed axes & metrics
- <name>: what it would catch, and how to measure it.

## Handoff
- Observations outside your scope, one line each, for the orchestrator.
```

## Severity

- **critical**: read-only boundary or secret exposure breached, data loss, or a skill unusable on a supported platform.
- **high**: wrong behaviour on a common path, or a doc that leads a user or agent into a wrong action.
- **medium**: edge-case bug, missing test for a risky branch, material doc drift, or an agent-doc variance lever (vague completion criterion, buried step).
- **low**: minor drift, readability, redundant code or tests to prune.
- **nit**: wording and formatting.
