# Findings format

One file per scope at `.scratch/audits/<run>-work/findings/<scope-id>.md`. You return **claims** with evidence; the lead verifies each independently and ranks. Zero claims is a valid result when every traced decision held. One claim per defect: identical defects across locations share one claim with several locations.

```md
# Findings: <scope-id>

## Scenario traces
### <scenario-id>: <one-line scenario>
- **Path**: the decisions traced, in order, each as `path:line` → outcome.
- **Examined**: every file opened for this scenario, one per line.
- **Result**: held | defect <scope-id>-<n> | opportunity <scope-id>-O<n> | gap — <what blocked the trace>

## Defects

### <scope-id>-<n>: <one-line title>
- **Severity**: critical | high | medium | low | nit
- **Axis**: <axis key from your brief>
- **Scenario**: <scenario-id> and the traced decision that fails
- **Location**: `path:line` (one per location)
- **Claim**: what is wrong, one or two sentences.
- **Evidence**: <static | reproduced | observed | inferred> · <high | medium | low> — quoted lines, command plus output, or the contradicting source.
- **Proposal**: the concrete change — replacement text, test case name plus the branch it covers, code move with destination.

## Opportunities

### <scope-id>-O<n>: <one-line title>
- **Hypothesis**: the improvement, and which scenario it would change.
- **Benefit**: measured value with its source, or `unmeasured — <what would measure it>`.
- **Cost**: what it adds or risks.

## Scope coverage
| Scenario or axis | Status | Notes |
|---|---|---|
| <id> | ✓ traced / — n/a / ✗ gap | examined files, or the reason |

## Counters
- Inspection tool calls: <used>/<budget> · minutes: <used>/<budget> · branch expansions: <used>/<budget>
- Name each counter you could not read as `unavailable`, never an estimate.

## Handoff
- Observations outside your scope, one line each, for the lead.
```

**Done when:** every assigned scenario has a trace with a filled `Result`, every traced decision cites the file it was read from, and every counter is a number or `unavailable`.

## Defect or opportunity

A **defect** is behaviour that contradicts a governing source (contract, test, documented intent) on a traced path: cite that source. Anything else that would make a scenario cheaper, faster or clearer is an **opportunity**: it carries no severity and stays out of the fix run. When the governing source is ambiguous, record an opportunity that names the ambiguity.

## Evidence type and confidence

- **static**: read from source on the traced path. **reproduced**: a command you ran shows it. **observed**: a production diagnostic or log shows it. **inferred**: reasoned across sources without a direct read.
- **high**: the evidence shows the failure directly. **medium**: shown on a close variant. **low**: inferred; the lead reproduces or refutes it before reporting.

A trace you could not finish is a **gap**: record what blocked it in the trace and in coverage, in place of a guessed result.

## Severity

- **critical**: read-only boundary or secret exposure breached, data loss, or a skill unusable on a supported platform.
- **high**: wrong behaviour on a common path, a broken skill flow or unachievable objective, or a doc that leads a user or agent into a wrong action.
- **medium**: edge-case bug, missing test for a risky branch, material doc drift, friction in step transitions, or an agent-doc variance lever (vague completion criterion, buried step).
- **low**: minor drift, readability, redundant code, comments, or tests to prune.
- **nit**: wording and formatting.
