# Fixed-controller self-build

Use this procedure when Dispatch changes its own skill.

1. Select a stable controller from a committed revision. While that stable controller predates v0.8.0, follow that controller's own `self-build.md` for the full run; the toolkit controls self-build only after v0.8.0 is released.
2. Capture a complete controller copy outside writer scope, including its scripts, configuration, references, templates, schemas and integrity hashes. Record its source revision and inventory. Validate destination containment and linked ancestors before copying. Preserve unrelated scratch and worktrees.
3. Run `doctor run` through the copy and require integrity ok. The copy is the frozen controller; the checkout being changed is the candidate.
4. Run every tool call through the copy's absolute `scripts/dispatch.ts` entrypoint while working against the candidate. Keep active commands, provider configuration, prompts and evidence bound to that same controller; never replace controller bytes with candidate bytes during a run.
5. Verify the candidate separately with its own `npm test` and every plan check. Controller integrity proves the controller's identity, not candidate correctness. Retain failed checks and their logs.
6. Recover with `status show` through the frozen controller. Inspect recorded effects, worktrees and retained handles before resuming; preserve uncertain results.
7. Use bounded manual repair only after a demonstrated controller defect prevents normal execution and recovery. Preserve the blocked run, verify the defect and obtain a bounded approved repair plan before editing. Keep scope, review and verification requirements.
8. After report completion, use `worktree cleanup` through the controller and inspect retained paths. Preserve session evidence and any work needed for recovery; account for every owned worktree.

The [toolkit contract](toolkit.md) owns action syntax. The [cleanup reference](worktree-cleanup.md) owns preservation and host lifecycle rules.
