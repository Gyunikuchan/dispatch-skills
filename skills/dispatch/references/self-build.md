# Fixed-controller self-build

Use this procedure when Dispatch changes its own skill.

1. Unless another revision is specified, use the candidate checkout's current committed revision (`HEAD`) at the start of the run as the stable controller source. Resolve and record its commit SHA once; keep that revision fixed for the full run.
2. Use `<session>/controller/<commit-sha>/` as the controller destination, where `<session>` is the run's session directory and `<commit-sha>` is the recorded source revision. Resolve and record the absolute destination before capture; require it to be session-owned and outside all writer-owned paths. Validate destination containment and linked ancestors before copying. Capture a complete controller copy from the recorded revision, including its scripts, configuration, references, templates, schemas and integrity hashes, and record its inventory. Preserve unrelated scratch and worktrees.
3. Run `doctor run` through the copy and require integrity ok. The copy is the frozen controller; the checkout being changed is the candidate.
4. Run every Dispatch tool call through `<recorded-absolute-destination>/scripts/dispatch.ts` while working against the candidate. Keep active commands, provider configuration, prompts and evidence bound to that same controller; never replace controller bytes with candidate bytes during a run.
5. Verify the candidate separately with its own `npm test` and every plan check. Controller integrity proves the controller's identity, not candidate correctness. Retain failed checks and their logs.
6. Recover with `status show` through the frozen controller. Inspect recorded effects, worktrees and retained handles before resuming; preserve uncertain results.
7. Use bounded manual repair only after a demonstrated controller defect prevents normal execution and recovery. Preserve the blocked run, verify the defect and obtain a bounded approved repair plan before editing. Keep scope, review and verification requirements.
8. After report completion, use `worktree cleanup` through the controller and inspect retained paths. Preserve session evidence and any work needed for recovery; account for every owned worktree.

The [toolkit contract](toolkit.md) owns action syntax. The [cleanup reference](worktree-cleanup.md) owns preservation and host lifecycle rules.
