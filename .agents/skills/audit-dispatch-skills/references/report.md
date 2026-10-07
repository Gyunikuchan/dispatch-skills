# Report format

`.scratch/audits/<run>-audit.md` is self-contained: it quotes what it needs from the work directory rather than linking there. `audit-dispatch-skills-fix` parses `## 3. Findings` with `status.mjs`, so that section's grammar is exact; people read the rest.

## Sections, in order

1. `## 1. Summary`: defect counts by severity, top five fixes by impact, opportunity count, baseline test totals, one-line probe verdict, and every coverage gap by name.
2. `## 2. Dispatch platforms`: discovery table, not-found list, probe table, and the cause of each failure or skip.
3. `## 3. Findings`: verified defects only, in the grammar below.
4. `## 4. Opportunities`: improvement hypotheses as `#### O-<n>: <title>` with **Hypothesis**, **Benefit** and **Cost** bullets. Opportunities live only here and carry no `Status` line; acting on one is a separate, explicitly selected task.
5. `## 5. Coverage and budget`: scenario × scope matrix (`✓` traced, `—` n/a with reason, `✗` gap) and each scope's counters against their budgets. Write a counter you could not read as `unavailable`, never an estimate.
6. `## 6. Appendix`: `### Unverified claims`, then `### Refuted claims` (each claim with its contradicting evidence).

**Done when:** all six headings exist in this order, section 3 holds either findings in the grammar below or the sentinel alone, and every `Unverified` claim or unresolved lead has a record under `### Unverified claims`.

## Unverified claims

Every claim the verify step leaves `Unverified`, including leads cut off by an exhausted budget, goes under `### Unverified claims` in section 6, one record each; section 3 holds verified defects only. Write `None.` when there are none. Each record takes this shape, so a later run can settle it without re-tracing:

```md
- **U-<n>: <one-line claim>** · <source scope ids>
  - **Evidence so far**: what was traced and where it stopped, with `path:line` pointers.
  - **Would settle it**: the reproduction, environment or source read that confirms or refutes it.
```

List each `U-<n>` by name among section 1's coverage gaps.

## Section 3 grammar

Group findings critical → nit under a `### <Severity>` heading per group; renumber IDs `A-<n>`. Each finding takes exactly this shape:

```md
#### A-<n>: <one-line title>
- **<severity>** · <axis> · Verified · <source scope ids>
- **Status**: open
- **Location**: `path:line` (comma-separated when several)
- **Claim**: …
- **Evidence**: …
- **Proposal**: …
```

Any legend above the findings names the meta line's third field **Verification**, not "Status", which belongs to the fix line alone. Headings stay `####` (severity groups `###`), and the meta line stays a single bullet in that order. `- **Status**: open` is the fix run's state slot: `audit-dispatch-skills-fix` rewrites that one line per finding and keeps a counts blockquote under the section heading; the report stays the only state file.

With zero verified defects, section 3 holds exactly one line, `No defect findings.`, plus the counts blockquote the fix run writes. The parser rejects that sentinel beside findings, an `O-<n>` heading inside section 3, and any other non-finding content.

## Worked examples

Short static audit with one defect:

```md
## 3. Findings

### High

#### A-1: Resume reruns the baseline suite
- **high** · lifecycle · Verified · S2
- **Status**: open
- **Location**: `.agents/skills/audit-dispatch-skills/scripts/run-state.ts:88`
- **Claim**: A resumed run reruns the baseline suite although the manifest already holds its result.
- **Evidence**: static · high — line 88 starts the baseline before reading the manifest.
- **Proposal**: Read the manifest first; add test "resume reuses the baseline".
```

Clean audit with unavailable usage counters and one unmeasured opportunity:

```md
## 3. Findings

No defect findings.

## 4. Opportunities

#### O-1: Share the plan brief across reviewers
- **Hypothesis**: one brief instead of three shortens plan review.
- **Benefit**: unmeasured — compare brief tokens across two runs.
- **Cost**: reviewers lose per-slot framing.

## 5. Coverage and budget

| Scope | Scenarios | Tool calls | Minutes |
|---|---|---|---|
| S1 plan | 3/3 ✓ | 31/40 | unavailable |
```

Partial audit whose probe evidence was unavailable:

```md
## 1. Summary

**Partial**: 0 defects, 1 unverified claim (U-1); gaps: probe agy skipped (auth), U-1.

## 6. Appendix

### Unverified claims

- **U-1: agy resume drops the attachment list** · S4
  - **Evidence so far**: `skills/dispatch/scripts/providers/agy.ts` rebuilds argv on resume; the probe skipped agy, so no payload was observed.
  - **Would settle it**: an authenticated agy probe with `--resume`, checking the second request payload for the attachment.

### Refuted claims

None.
```
