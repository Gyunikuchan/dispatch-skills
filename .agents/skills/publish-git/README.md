# publish-git

Prepare and publish a GitHub release from your current project. `publish-git` works independently of Dispatch and needs no Dispatch configuration or Node runtime. It needs Git and authenticated GitHub capabilities through your agent's available connector or CLI.

## Use and portability

This repository keeps the skill in `.agents/skills/publish-git`. To use it in another project, copy the complete `publish-git` folder into that project's agent skill directory. The workflow uses the target project's conventions and available tools.

Ask your agent to publish:

```text
Use publish-git to publish version 0.8.0 of this project.
```

You can also request publication from a branch named exactly `release/v0.8.0` or `v0.8.0`. An explicit version overrides the branch version. Otherwise the agent recommends a version and asks you to choose. Before 1.0, features and breaking changes suggest a minor bump; fixes suggest a patch. From 1.0, breaking changes suggest major, features minor, and fixes patch. A first release suggests `0.1.0` and asks. Prereleases and multiple release lines need clarification.

## Authority and results

A publishing request authorizes the full workflow: include inspected release-related pending changes, update version metadata and the changelog, run required checks, commit, integrate into the remote default branch, push, tag, and create the release. The agent preserves unrelated staged, unstaged, and scratch content and asks about uncertain ownership. A request for advice alone does not authorize publication.

Changelog entries describe concise end-user outcomes. The GitHub release title and tag use `vX.Y.Z`; its body contains only links to the tagged changelog section and tagged commit history. No package-registry publication or custom release assets are included.

Failed or unrun required checks block publication. If branch rules require a PR, the agent creates a release PR and reports the remaining gate; tagging and release creation wait for verified integration and checks. The skill does not bypass branch rules or install missing dependencies.

If publication stops partway, repeat the publishing request. The agent checks actual state, reuses matching completed work, and performs missing steps. A conflicting tag stops recovery without moving the tag or rewriting shared history. The result reports the release URL and checks, or completed operations and the exact blocker.

See [SKILL.md](SKILL.md) for the canonical agent workflow.
