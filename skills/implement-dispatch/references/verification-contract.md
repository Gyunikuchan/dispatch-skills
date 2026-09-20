# Verification evidence contract

## Baseline scope and evidence

Extract every command from the settled plan's `Verification Plan / Automated Tests`; `- None:
<reason>` is unavailable, not passing. Extract approved paths from `[NEW]`, `[MODIFY]`, and
`[DELETE]` H4 headings under `## Proposed Changes` with
`scripts/verification-evidence.mjs --approved-paths <plan>`. If none parse, use every tracked and
non-ignored untracked path outside `.scratch/` and record the fallback. Before structured
criterion mappings exist, every selected command maps to the entire approved path set.

At baseline, classify approved paths as test/test support or production using host conventions and
record the split under walkthrough `## Verification & Validation`; classify later-created paths
with the same recorded rule. Record every command, exit status, stable failing identifiers, and a
bounded normalized diagnostic.

Capture Git porcelain plus dirty-path object IDs before and after every baseline command. Any
tracked mutation or new non-ignored file inside approved scope enters side-effect reconciliation:
stop for caller removal or an amended, re-reviewed plan. Prove outside-scope files irrelevant or
reconcile them. Preserve caller-owned changes. Outside Git, record `side-effect capture
unavailable` and obtain a ruling to proceed or abort.

## Result identity and freshness

A red or unavailable baseline is never green. Ask whether to proceed with the known-red baseline
or fix first; fixing amends and re-reviews the plan but remains approval-gated. Record the ruling.
A later nonzero result is `known red — unchanged` only when exit status and stable identifiers
match the accepted baseline, or exact normalized diagnostics match when identifiers are absent.
Anything else is a regression.

Evidence is fresh only when produced after the last mutation or accepted fix in the command's
mapped scope. Completion reruns every settled command. Delegate success reports do not establish
verification.

## RED boundary

When new or corrected behavior is required, allow at most one tests-only launch in addition to the
run's implementation failure budget. It changes only test/test-support paths and stops; the host
runs the mapped command and production work begins only after failure for the expected reason.
Characterization, test-only repair, and generated/snapshot exceptions require evidence and a
recorded ruling. A late test is a missed gate requiring user acceptance.

An unrelated failure or production-path mutation is invalid RED and consumes an implementation
failure. Stop after two identical implementation failures, including invalid RED and regressions.
