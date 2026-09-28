# ADR 0003: Chat session artifact governance

- **Status**: Accepted
- **Date**: 2026-09-28

## Context

Dispatch produces two audiences of files: deliverables a person reads (specs, designs, plans,
walkthroughs, review reports) and machine state that agents and scripts consume (ledgers, run
state, prompts, delegate reports, traces, telemetry). Sandboxed agents must reach all of it
during work; a person must find the deliverables at a glance afterward. A single platform chat may
run several workflows, including a pre-driver `brainstorming` spec, and several delegates in
parallel, so names must stay unique without relying on randomness.

## Decision

### One folder per chat

- Each platform chat owns one session folder, created at its first dispatch-related artifact
  write, including a pre-driver `brainstorming` spec. While work is active, its root is
  `.scratch/dispatch-skills/<timestamp>-<session-id>-<session-title>/` within the repository.
- The timestamp is UTC in a lexically sortable, filesystem-safe form. The session id is the
  platform's chat id or, when none exists, a random id generated once and persisted; unsafe or
  long ids are encoded into a safe component, with the original kept in the manifest. The title is
  a short, fixed, filesystem-safe summary of the first objective, for orientation only. The folder
  is created exclusively and never renamed; identity collisions are rejected.
- Every dispatch-owned file lives in this folder. Production source and platform-managed files stay
  with their owners; when dispatch governs a platform-native artifact, its working copy lives here.

### Audience-separated layout

```text
<session>/
├── manifest.json
├── <slug>.<type>.md          deliverables
└── .state/                   machine state
    ├── <slug>.ledger.md
    ├── deliverables.json
    ├── telemetry.jsonl
    ├── cache/
    └── runs/NNN-<kind>/      one folder per driver invocation, flat inside
        └── scratch/          orchestrator-authored helpers
```

- The root holds only the manifest and human deliverables. Deliverable types are `spec`,
  `design`, `plan`, `walkthrough`, and `report`. The ledger and every other machine file live under
  `.state/`: hidden, because people rarely need it; named `.state` because the parent already says
  dispatch.
- There is no handoff file. The handoff is the chat reply; walkthroughs are the durable per-slug
  record, so a file would duplicate both and cost tokens to read or restate.
- A run is one driver invocation, which may span many rounds and non-review phases. Its folder is
  `NNN-<kind>`: a three-digit per-session sequence, so runs sort chronologically across midnight,
  and the run kind (`ask`, `plan-review`, `code-review`, `design`, `implement`), so a listing shows
  what ran. The folder name is the run id.

### Naming grammar

- Every file follows `<scope>.<kind>.<ext>`: the part before the first dot identifies the subject,
  the rest names its type. One grammar at every level means one glob (`*.report.md`, `r2*`) works
  everywhere, and related files sort together.
- Scopes: a deliverable slug; `r<N>` for a review round, `s<N>` for an implementation stage; an
  optional `-<provider>-<slot>` for one delegate launch; an optional `-<qualifier>`
  naming sibling files such as one log per command; an optional `-a<N>` for a relaunch.
  Counters start at 1. Files describing the whole run (`state.json`, `inputs.json`) are unscoped.
- Kinds come from a closed set owned by one path module. Extensions carry format only: `.md` prose,
  `.json`/`.jsonl` data, `.log` traces.
- Names never repeat what the path already states and never carry random suffixes, PIDs, epochs, or
  tool prefixes. Slugs are kebab-case, at most 40 characters, and undated; the session folder
  carries the date.
- Folders exist only where they group a lifecycle (session, run) or isolate unstructured content
  (`cache/`, `scratch/`); never to hold a single file.

### Collision safety

- Uniqueness comes from deterministic identity plus exclusive creation, not randomness. Run
  folders are created with an exclusive `mkdir` and advance to the next sequence number on
  collision. Launch-scoped files are created with an exclusive open and advance their attempt
  suffix on collision. Single-writer files are rewritten atomically or appended.
- Collisions can only occur within a session, since each session folder is timestamped. A new
  `.state/deliverables.json` records the subject (spec path or objective) each authored name
  belongs to. The same subject reuses its file; a different subject whose `<slug>.<type>.md` is
  taken is written as `<slug>-2.<type>.md`, then `-3`, and so on, trimming the slug to stay within
  40 characters. Reviews and resumes of an existing deliverable reuse its path.

### Ownership

- One Node path module builds every name; callers never concatenate artifact paths. Central
  lifecycle commands create, locate, reactivate, and hand off a session; `brainstorming`, drivers,
  and standalone reviews use them.
- The driver names every path it expects the orchestrator to write, such as a round's rulings, and
  reads only those paths. Orchestrator-authored helpers go to the run's `scratch/`. Write
  subagents return their outcome to the path the driver names.

### Movement and handoff

- A session has one authoritative location. At a terminal handoff, after all writes and required
  verification settle, a script moves the **entire** folder to
  `<realpath(os.tmpdir())>/dispatch-skills/<same-folder-name>/`. This covers ordinary work, final
  design integration, standalone reviews, and terminal failure or manual-completion handoffs.
  Nonterminal pauses and intermediate design increments stay in `.scratch`.
- Prefer an atomic rename. Across devices, copy to a staging destination, verify the copy, publish
  the complete destination, then remove the source. Before publication, `.scratch` stays
  authoritative and any staging copy is disposable; after publication, OS temp is authoritative
  even if source cleanup fails partway, and the leftover source is reported and cleaned later. A
  failed move never erases a completed workflow or suppresses its handoff.
- The handoff reports the full path of the authoritative folder once, with the failure reason when
  the move did not happen. The OS may later purge temp data.
- New work in the same chat first reactivates the folder back into `.scratch` under the same move
  rules. If it cannot be safely found or reactivated, stop with the relevant paths and recovery
  reason; never create a second authoritative folder for the chat.

### References and recovery

- The manifest binds the platform id, safe folder id, repository, title, and lifecycle state. The
  directory and manifest are validated before reuse, and an interrupted move is reconciled against
  the actual source and destination. Explicit session binding carries a generated id across
  invocations when the platform exposes none.
- References inside the session are relative to its root; absolute paths, resume commands, and
  links are resolved from the current root when emitted, so moving the folder never strands them.
  Work resumes from deliverables, the ledger, and run evidence, including after reactivation.

## Alternatives considered

- **Copy snapshots to OS temp at each handoff:** leaves two copies whose authority diverges when the
  chat continues.
- **One folder per workflow:** fragments a multi-workflow chat and duplicates its identity and
  evidence.
- **Deliverables in an `artifacts/` subfolder:** hides the files people want behind a level that
  adds nothing.
- **Per-round or per-file folders:** deepen paths without adding grouping the round scope does not
  already provide.
- **Random or timestamped names for uniqueness:** unique but unreadable and unsortable by meaning;
  exclusive creation gives the same safety with names that describe their content.
- **A handoff file:** duplicates the chat reply and walkthroughs.

## Consequences and verification

The active folder appears in the workspace; dispatch never commits it, and users decide whether to commit deliverables. Name construction,
collision handling, and layout are tested in one place: grammar construction and rejection,
sequence allocation under concurrent creators, attempt increments, and a layout guard asserting a
simulated run produces exactly the expected tree. Lifecycle tests cover stable naming and id
fallback, multiple workflows per chat, scratch-to-temp handoff and reactivation, same- and
cross-device moves, denied temp access, interrupted copies, destination collisions, relative path
rebinding, and terminal versus nonterminal handoffs; the reported path identifies the authoritative
folder in every outcome.
