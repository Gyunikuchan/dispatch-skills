# Drive Stop Diagnostics — Design

## Goal

Every `--drive` stop and error tells the orchestrator where the run is and what to do next, so it never has to read driver source or state files just to interpret one.

## Current behavior

- `emitAction` (`skills/dispatch/scripts/driver/actions.mjs:112`) builds every action with `v`, `action`, `stateFile`, `guidance[]`. All nine action schemas declare an optional `error: string`.
- `done` carries `outcome`, `summary`, `reason`, `nextAction`, `command`, `artifactPath`, `ledgerPath`.
- `ask-user` carries a typed `question` id (e.g. `implementation-concerns`, `failure-disposition`), a `text` that names the reply shape, and `items[].reason`.
- `launch` carries `wave {type, round}`. The drive loop (`drive.mjs`) writes `launch`/`verify` banners to stderr with log and results paths.
- `--drive` blocks until an action needs the host, so each emitted action is already a state change.

## Gaps

1. **No position.** Apart from `launch.wave`, an action doesn't say which flow, phase, step, or wave the run is in.
2. **Untyped errors.** On a failed advance, the implement flow's catch block (`implement-phase.mjs:199-203`) re-emits `state.pending` with `error: error.message`. One string covers a malformed reply, state that needs reconciliation, and an unexpected driver exception, so the host can't tell whether to fix its reply, resume, or stop.
3. **Unstructured fatal errors.** `runDriver` (`index.mjs:312-315`) prints `[dispatch driver] <message>` to stderr and exits 2, with no class, state path, or next step. About 80 `throw new Error` sites in `driver/*.mjs` reach this path or gap 2. Some embed recovery prose, others don't.

## Decisions

| Decision | Rationale |
|---|---|
| Structured JSON fields only; no prose status banner | The host reads stdout and stderr, so a banner would repeat the same facts on every stop and could drift from the JSON. The JSON fields are needed for machine use regardless. |
| No legacy support: `error` becomes an object and the string form is removed | Repo default. There is one consumer (the orchestrator contract), and the driver and its schemas ship together. |
| Contract rule against reading driver source is deferred | A rule can't fix untyped errors. Repo policy adds behavioral rules only when evidence shows they change outcomes (see Follow-up). |

## Design

### D1. `position` on every action

`emitAction` adds `position` from one `position(state)` helper in `state.mjs`:

```json
"position": { "flow": "implement", "phase": "implementation", "step": "concern-ruling", "wave": { "type": "review", "round": 2 } }
```

| Field | Source | Presence |
|---|---|---|
| `flow` | Invocation verb: `ask\|design\|plan\|review\|implement` | Always |
| `phase` | Ordinary runs: `state.ordinary.phase`. Review runs: the review kind. Design runs: the design phase | Always |
| `step` | `state.ordinary.step` or the equivalent state-machine step | Only when the flow has steps |
| `wave` | `state.adjudication.waveType` plus round | Only during review and adjudication |

`launch.wave` stays because it is launch input. The implementation plan pins the exact source for each flow and never invents a value for a flow that lacks one.

### D2. Typed errors

Every action schema replaces `error: string` with:

```json
"error": { "kind": "reply" | "state" | "fault", "message": "...", "next": "..." }
```

| `kind` | Meaning | Host's next move |
|---|---|---|
| `reply` | The host's reply failed the schema or doesn't fit the current step. State is unchanged. | Correct the reply and resend it to the same action. |
| `state` | Durable state needs reconciliation: a lock, a ledger/walkthrough mismatch, or an interrupted outcome. | Do what `next` says, then resume with `--drive --state`. |
| `fault` | The driver threw an unexpected exception. | Stop. Report `message`, `stateFile`, and log paths to the user. Don't edit or re-derive driver state. |

`next` is required for `state` and optional otherwise.

Mechanism:

- Add `DriverError(kind, message, next?)` to `actions.mjs`.
- Throw sites that already carry recovery prose become `DriverError('state', …, next)`.
- Reply-validation failures (`index.mjs:239-241` and the reply checks in `*-phase.mjs`) become `kind: 'reply'`.
- Any untyped `Error` becomes `fault`.
- The drive loop's repeat-failure guard (`drive.mjs`, "same gate failing twice") compares `action` and `error.kind`.

### D3. Structured fatal errors

The catch block in `runDriver` writes one line to stderr and still exits 2:

```
[dispatch driver] <kind>: <message> | next: <next> | state: <stateFile>
```

- `UsageError` maps to `reply`, `DriverError` keeps its kind, and anything else maps to `fault`.
- `next` and `state` are included when known.
- stdout stays empty and the persisted `pending` action is untouched. A synthetic `done` would falsely signal that the run ended.

### D4. Contract

Step 3 of `SKILL.md` gains one clause: an `error` names its `kind`; `fault` means stop and report. The wording change must be net-neutral in word count (reword rather than append), and the edit applies `writing-for-agents`.

## Non-goals

- A prose status banner, or output on unchanged polls.
- Changes to the existing `launch`/`verify` stderr banners.
- Fixes to individual driver bugs. This design only makes them surface as `fault`.

## Success criteria

- **SC1:** Every action emitted across the driver test suites has `position.flow` and `position.phase`. Review and adjudication actions also have `position.wave`. Enforced by the schemas plus an integration assertion.
- **SC2:** Every emitted `error` is an object whose `kind` is `reply`, `state`, or `fault`. No action schema accepts a string `error`.
- **SC3:**
  - An invalid reply yields `kind: "reply"` and leaves state unchanged.
  - A stale advance lock yields `kind: "state"` with `next`.
  - An injected unexpected throw yields `kind: "fault"`.
- **SC4:** `runDriver` exit-2 output matches `^\[dispatch driver\] (reply|state|fault): .+`, and includes `state: <path>` when `--state` was given.
- **SC5:** The `SKILL.md` word count does not increase. `npm test` passes and skill hashes are regenerated.

## Follow-up (evidence-gated)

After shipping, run an implement flow that hits a concerns stop and a failure-disposition stop. If the orchestrator still opens `skills/dispatch/scripts/driver/**` without a `fault`, add a `SKILL.md` rule that the action is authoritative and driver source is read only to repair a `fault`.
