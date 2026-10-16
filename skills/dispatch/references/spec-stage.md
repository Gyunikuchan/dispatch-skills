# Governing spec operation

Use this reference for `design`, `plan`, `implement` and every `review` kind. `ask` has no spec stage. The [spec template](templates/spec.md) owns format and level-specific sections; [verb references](verbs/) own commands. Review intent rulings belong in [review rules](review-rules.md#intent-and-findings).

## Resolve and author

1. For a supplied plan/design target, follow its Parent to the spec; an increment plan follows its governing design's Parent. An explicit `--spec <path>` must agree with that chain. Otherwise reuse the single session-root `.spec.md`. Resolve `ambiguous-spec` by identifying the intended file and passing `--spec`; resolve `spec-conflict` against the governing Parent, and `spec-not-found` by restoring the artifact at its pinned path. A replacement with changed bytes or a changed path is an explicit spec revision: follow the revision protocol, obtain new approval where applicable, and apply the stale-spec recovery for the owning artifact. Never silently rebind downstream pins. Never choose among multiple candidates silently.
2. If no candidate exists, follow the emitted author frame at `data.path` with `data.template` (`data.artifact: spec`). Write from the full chat: preserve material constraints, alternatives, rejected options and user decisions. For standalone review, also inspect the diff; mark inferred requirements `(inferred)` and record user decisions only with evidence. Follow the template's required sections for `data.level`.
3. Send `AUTHORED` with `path: data.path`. The driver reads, lints and hashes the bytes before proceeding. Resolve emitted defects in that file and repeat. There is no separate delegated spec review; design/plan review checks intent against the spec.

Keep one resolved canonical spec. New/session-authored specs use `<session>/<slug>.spec.md`. A candidate resolved through Parent pins or an explicit path retains that path and its pins, including across sessions; do not copy, move or rebind it merely to normalize placement. While Dispatch is active, redirect any other planning skill's spec or design output, including brainstorming discussion, into that resolved canonical owner in Dispatch format. Merge a stray spec's material content and decisions before removing it. Preserve evidence of the merge; obtain user approval before deleting a tracked stray. Do not edit skills managed by `npx skills` to implement the redirect.

## Approval

At `medium` and above, design or plan authoring waits for approval of the settled spec hash. This includes plans authored inside implementation and nested increment plans. At `low`, proceed and show the spec in the handoff. Spec settlement also applies to standalone review, but settlement alone does not add an approval gate to standalone code review.

At the emitted `decide` frame with `data.kind: spec-approval`, show `data.path` and `data.hash` to the user. Send `DECISION` with `kind: spec-approval` and `answer: { by: "user", quote: <non-empty user words>, hash: <data.hash> }`, or `answer: "stop"`. Approval binds that content hash, not the filename. Existing approval of the same hash can be reused by the driver. Design approval and production-write approval remain separate authorizations.

## Readers and document layers

The spec owns why/what, REQ acceptance and intent/user decisions (DEC). Design owns strategy, architecture and architectural decisions (AD). Plan owns tactics, task ownership, criteria and checks. Keep each meaning in its owning layer; cite upstream IDs. Ordinary design/plan authoring never rewrites the spec.

Every downstream author and reviewer reads the whole governing spec. Native writers read it in full plus the plan's shared range through Task Map and their own task, assigned criteria and Verification Plan rows. Honor emitted paths and hashes. Before drafting a design or plan, read every `data.read` entry and its named sections. The quality-bar reader map in the [contract](../SKILL.md#await-author) applies to standalone and nested authoring; emitted read sections are required input, not optional background.

## Revision protocol

1. Confirm the intent change with the user; record a new DEC when the answer changes intent. Ordinary authoring changes only its own design/plan layer.
2. Reach quiescence before sending a revision. Read each pending effect's immutable result/receipt and reconcile uncertain completion through [checkpoint recovery](change-handling.md#checkpoints-and-runtime-continuation). Never blindly replay an effect whose result is uncertain. Resolve live writers through an already-authorized receipt or stop path in [implementation](verbs/implement.md#writer-receipts). A revision instruction grants no authority to stop a writer; keep its handle and wait for its terminal receipt. Finish any outstanding delegate wave and admitted result handling.
3. Revise the canonical spec and send `SPEC_REVISED` with its `path` only at an admitted `author`, `rule`, `evidence` or `decide` boundary. The path must identify the governing spec. At the spec stage itself only its approval boundary accepts revision; finish spec authoring with `AUTHORED`. A live writer, pending effect or non-author design-revision step must finish through its owning contract before revision admission. Broad Await acceptance never bypasses these state-specific checks.
4. Root re-reads, lints and hashes the new bytes. Obtain approval for the new hash at `medium`+ wherever the authoring gate applies; an old-hash approval never authorizes the new hash. Root alone synthesizes internal `SPEC_SETTLED { path, hash }` to resume the owner. The host must never send that internal event.
5. Follow the owning child's transition below. Preserve completed work, review history and logs; re-settlement does not authorize replay of accepted work or an in-place rewrite of a governing design by another owner.

### Recovery owners

| Owner and artifact | Required recovery |
| --- | --- |
| Design-governed delivery | Suspend increment execution. Revise and approve the design before dependent increment-plan authoring, review or delivery resumes. Before initial design approval, return to design authoring. |
| Standalone plan authoring | Return to plan authoring against the new spec. |
| Standalone review or implement targeting an increment plan with a stale transitive design pin | Halt with `stale-design-spec`; name the governing design and direct design revision first. These owners do not revise that design in place. |
| Standalone review of a standalone plan or design | Halt with `stale-spec`; direct re-planning or design revision first. |
| Standalone implement of a standalone plan | Halt with `stale-spec` and direct re-planning. A plan authored in this run may return to authoring only before task initialization; after task initialization preserve work and halt. |

A standalone code review supersedes pending unruled findings and re-prepares a full review against the new spec identity, retaining earlier rulings and history. Artifact review first follows the stale-pin recovery above. Resume only through the emitted owner transition; a plan amendment cannot repair a stale governing intent pin.
