# ADR 0003: Chat session artifact governance

- **Status**: Accepted; updated for [ADR 0006](0006-dispatch-state-machine.md)
- **Date**: 2026-09-28

> Recovery execution policy is superseded by the [current checkpoint/continuation contract](../../skills/dispatch/references/change-handling.md#checkpoints-and-runtime-continuation). Historical rationale below is retained.

## Context

Dispatch produces two audiences of files: deliverables a person reads (specs, designs, plans,
walkthroughs, review reports) and machine state that agents and scripts consume (run
journals, prompts, delegate reports, briefs, traces). Sandboxed agents must reach all of it
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
├── diagnostics.md           optional diagnostics deliverable
└── .state/                   machine state
    ├── deliverables.json
    ├── scratch/              pre-run and shared working files
    └── runs/NNN-<kind>/      one folder per run, flat inside
        ├── events.jsonl      the run journal: sole authority for run state
        ├── progress.json     live progress of the in-flight effect
        ├── lock              held while a `send` runs
        └── scratch/          run-specific agent working files
```

- The root holds only the manifest and human deliverables. Deliverable types are `spec`,
  `design`, `plan`, `walkthrough`, and `report`; optional `diagnostics.md` is also a human deliverable with its fixed filename. The run journals and every other machine file live under
  `.state/`: hidden, because people rarely need it; named `.state` because the parent already says
  dispatch.
- Agent-created helpers, manually captured logs, intermediate data, and backups use run scratch;
  pre-run and shared work uses `.state/scratch/`. Purpose determines placement: a backup such as
  `before-rewrite.plan.md` is a working file. Native writers isolate concurrent actions under
  `<run>/scratch/<envelope-dir-name>/`, copying the supplied envelope's parent directory name exactly.
  Working directories are created only when needed; existing sessions and evidence remain intact.
- There is no handoff file. The handoff is the chat reply; walkthroughs are the durable per-slug
  record, so a file would duplicate both and cost tokens to read or restate.
- A run is one `start` and its journal, which may span many `send` invocations, rounds, and phases. Its folder is
  `NNN-<kind>`: a three-digit per-session sequence, so runs sort chronologically across midnight,
  and the run kind (`ask`, `plan`, `design`, `implement`, `plan-review`, `design-review`, `code-review`), so a listing shows
  what ran. The folder name is the run id.

### Naming grammar

- Every file follows `<scope>.<kind>.<ext>`: the part before the first dot identifies the subject,
  the rest names its type. One grammar at every level means one glob (`*.report.md`, `r2*`) works
  everywhere, and related files sort together.
- Scopes: a deliverable slug; `r<N>` for a review round, `s<N>` for an implementation stage; an
  optional `-<provider>-<slot>` for one delegate launch; an optional `-<qualifier>`
  naming sibling files such as one log per command; an optional `-a<N>` for a relaunch.
  Counters start at 1. Files describing the whole run (`events.jsonl`, `progress.json`, `lock`) are unscoped.
- Kinds come from a closed set owned by one path module. Extensions carry format only: `.md` prose,
  `.json`/`.jsonl` data, `.log` traces.
- Names never repeat what the path already states and never carry random suffixes, PIDs, epochs, or
  tool prefixes. Slugs are kebab-case, at most 40 characters, and undated; the session folder
  carries the date.
- Folders exist only where they group a lifecycle (session, run) or isolate unstructured content
  (`scratch/`); never to hold a single file.

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
  lifecycle commands (`dispatch.ts session`) create, locate, reactivate, and hand off a session;
  `brainstorming`, runs, and standalone reviews use them.
- Host decisions reach the driver as journaled events. For file outputs (native captures, write
  envelopes, authored plans and designs) the driver names every path it expects and reads only
  those paths. Agent working-file placement follows the layout above; driver-owned outputs retain
  their emitted paths and production files retain their scoped repository paths. Write
  subagents return their outcome to the path the driver names.

### Canonical intent

One resolved canonical spec governs the work. New specs use the session root; an existing explicitly resolved or Parent-pinned owner retains its path. Other planning skills redirect their spec/design discussion into that owner. Merge material content and decisions before stray cleanup, preserve merge evidence, and obtain user approval before deleting a tracked stray. [ADR 0010](0010-canonical-session-intent.md) records this choice and [ADR 0011](0011-layered-governing-documents.md) separates the document layers.

### Movement and handoff

The earlier unconditional move to OS temp at terminal handoff is superseded. Delivered sessions remain in their workspace location at handoff, retaining deliverables and machine evidence together. The handoff identifies the authoritative folder. Existing lifecycle movement and reactivation support does not require moving every completed session. Current [session governance](../../skills/dispatch/SKILL.md#write-boundaries-and-recovery) owns placement and recovery.

The historical temp policy sought one authoritative copy and portable relative references. Workspace retention preserves those aims while keeping recovery evidence reachable with the checkout; it also requires deliberate cleanup rather than reliance on OS temp purging.

### References and recovery

- The manifest binds the platform id, safe folder id, repository, title, and lifecycle state. The
  directory and manifest are validated before reuse, and an interrupted move is reconciled against
  the actual source and destination. Explicit session binding carries a generated id across
  invocations when the platform exposes none.
- References inside the session are relative to its root; absolute paths, resume commands, and
  links are resolved from the current root when emitted, so moving the folder never strands them.
  Work resumes by replaying the run journal, including after any supported reactivation.

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
simulated run produces exactly the expected tree. Lifecycle tests cover naming, identity, retained handoff and supported movement/recovery. Historical scratch-to-temp movement remains recovery context rather than a mandatory terminal action. The reported path identifies the authoritative folder.
