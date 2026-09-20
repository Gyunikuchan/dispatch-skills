# Implementation delegate contract

Every implementation launch receives the settled scope, attempt number, prior failure evidence,
and an explicit resolved model. When the configured model resolves to an array of model names,
the launcher attempts the first model; on availability, authentication, or quota failure, it
tries the subsequent model in the array before concluding the launch failed. Attempt 2 receives the
instruction to identify root cause before modifying code. A native launcher receives only fields its
host tool schema supports; flow resolution reports applied and ignored configured fields.

The final message contains exactly one raw or fenced JSON envelope:

```json
{
  "schemaVersion": 1,
  "status": "DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED",
  "stage": "RED_READY|COMPLETE",
  "summary": "non-empty string",
  "evidence": ["bounded path, command, or diagnostic"]
}
```

No additional fields are permitted. A fenced envelope must use the `json` language tag.
`DONE_WITH_CONCERNS` also requires non-empty `concerns`; `NEEDS_CONTEXT` requires
`missingContext`; `BLOCKED` requires `blockers`. Other status-specific arrays are omitted or empty.
Evidence is non-empty for both `DONE` statuses and may be empty otherwise. `RED_READY` is legal
only with a `DONE` status from a tests-only launch or its context continuation. A full launch and
its continuation use `COMPLETE`; a tests-only launch unable to reach RED returns `COMPLETE` with
`NEEDS_CONTEXT` or `BLOCKED`.

A `DONE_WITH_CONCERNS` transition obtains and records the concern ruling first. After resolution,
run the envelope's pending action: the RED gate for `RED_READY`, or independent verification for
`COMPLETE`.

`RED_READY` asks the host to run the RED gate; it is not verification. The authoritative
tests-only evidence and invalid-RED accounting rules are in
[verification-contract.md](verification-contract.md).

Current native implementation launches are non-resumable unless
`dispatch/references/providers.md` documents and tests a continuation operation for that launch
kind. Without one, `NEEDS_CONTEXT` consumes the attempt and replacement uses the next attempt.
At most one context-only continuation is legal in a resumable attempt.

Delegated failures use at most three attempts: primary, same-platform/same-model root-cause-first
replacement, then the next distinct configured native tier when available. No higher distinct tier
stops after Attempt 2; any Attempt 3 failure stops for user ruling. Host-platform execution allows
two attempts and no model escalation. `BLOCKED` requires changing the blocking condition; it never
authorizes an identical retry. Failed delegated work never transfers silently to the host platform.

Validate a captured final message with
`node scripts/implementation-outcome.mjs --parse <file|->`. Compute the next action with
`node scripts/implementation-outcome.mjs --transition <json-file|->`; its input is the validated
envelope plus launch kind, attempt, target kind, resumability, context-continuation state,
escalation result, continuation origin, and any host verification result. Target kind is `delegate`
for a separate CLI process or `self` for a native subagent on the host platform; `self` never means
the orchestrator implementing inline.
