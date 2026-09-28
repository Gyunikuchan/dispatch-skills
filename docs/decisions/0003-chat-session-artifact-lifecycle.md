# ADR 0003: Chat session artifact lifecycle

- **Status**: Accepted
- **Date**: 2026-09-27

## Context

Keep dispatch-owned files accessible to sandboxed agents during work and give the user one folder
to inspect after handoff. The unit is one folder per platform chat, including files created before
and during a run. A chat may contain several workflows. A `brainstorming` session used with
`dispatch` may produce a spec before the driver starts; that spec belongs in the same folder.

## Decision

### Identity and layout

- Create the chat folder at the first dispatch-related artifact write, including a pre-driver
  `brainstorming` spec. While work is active, its root is
  `.scratch/dispatch-skills/<timestamp>-<session-id>-<session-title>/` within the repository.
- Use a UTC timestamp in a lexically sortable, filesystem-safe form such as
  `YYYYMMDDTHHMMSS.sssZ`. Keep the folder name stable for the life of the chat.
- Use the platform's chat/session ID or equivalent when available. Otherwise generate a random ID
  once and persist it. Encode an unsafe or overly long platform ID into a safe path component while
  retaining the original ID in the manifest for lookup. Create the directory exclusively and
  reject identity collisions rather than silently sharing another chat's files.
- Derive a short, filesystem-safe title from the first implementation objective and keep it fixed.
  If the first artifact is for design or review and no implementation objective is known yet, use
  that task's objective. Set the title before the first artifact write and never rename the folder
  afterward. The title is for human orientation, not identity.
- Put every dispatch-owned artifact and run file in this root: specs, designs, plans,
  walkthroughs, manifests, state, ledgers, checkpoints, telemetry, cache, logs, prompts, packets,
  reports, and verification output. Keep useful subdirectories such as `artifacts/` and
  `runs/<run-id>/`; their paths are relative to the session root. Production source files and
  platform-managed files remain where their owners require them. When dispatch governs a
  platform-native artifact, its working copy lives in the session folder.

### Movement and handoff

- A session has one authoritative location. During active work it is the workspace folder above.
  At a terminal handoff, after all writes and required verification settle, a script attempts to
  move the **entire** folder to
  `<realpath(os.tmpdir())>/dispatch-skills/<same-folder-name>/`. This applies to ordinary work,
  final design integration, standalone reviews, and terminal failure or manual-completion
  handoffs. Nonterminal pauses and intermediate design increments stay in `.scratch`.
- Prefer an atomic rename. Across devices, copy the whole folder to a staging destination, verify
  the copy, then publish the complete destination before removing the source. Before publication,
  an interrupted or denied move leaves `.scratch` authoritative and any staging copy is disposable.
  After publication, OS temp is authoritative even if source cleanup fails partway; report and
  later clean up the leftover source. A failed move does not erase a completed workflow or suppress
  its handoff.
- The handoff reports the **full path of the authoritative session folder** in chat: OS temp after
  a successful move, or `.scratch` after a failed move, with the failure reason. Report the folder
  once instead of listing every relocated file. The OS may later purge temp data.
- Before new work in the same chat, reactivate its folder by moving it from OS temp back to
  `.scratch`, using the same verified move rules. Reuse the existing scratch folder if the prior
  handoff could not move it. If the folder cannot be safely found or reactivated, stop with the
  relevant paths and recovery reason; do not create a second authoritative folder for that chat.

### Script ownership and recovery

- Central Node lifecycle commands create or locate, reactivate, and hand off a chat session.
  `brainstorming`, dispatch drivers, and standalone review flows use those commands rather than
  constructing or moving artifact paths by hand. The commands return the current absolute root
  and a machine-readable result for the caller's handoff.
- The manifest binds the platform ID, safe folder ID, repository, title, and lifecycle state.
  Validate the directory and manifest before reuse; reconcile an interrupted move against the
  actual source and destination rather than trusting a stale location field. Explicit session
  binding carries the generated ID across invocations when the platform exposes no stable ID.
- Persist references within the session relative to its root. Resolve absolute paths, resume
  commands, and handoff links from the current root when emitted, so moving the folder cannot
  leave them pointing at its former location. Preserve the ability to resume from canonical
  artifacts and evidence, including after reactivation.

## Alternatives considered

- **Copy snapshots to OS temp at each handoff:** leaves a workspace copy and a temp copy whose
  authority can diverge when the chat continues.
- **One folder per workflow:** simplifies each handoff but fragments a chat with several workflows
  and duplicates its identity and evidence.

## Consequences and verification

The active folder appears in the workspace and must be kept out of commits. The implementation
will update artifact resolution, session binding, driver and standalone handoffs, pre-driver spec
creation, and the agent-facing lifecycle contract together. Test stable naming and ID fallback;
multiple workflows in one chat; scratch-to-temp handoff and reactivation; same-device and
cross-device moves; denied temp access; interrupted copies and destination collisions; relative
path rebinding; and terminal versus nonterminal handoffs. The handoff path must identify the
authoritative folder in every tested outcome.
