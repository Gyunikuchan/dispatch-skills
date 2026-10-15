---
name: publish-git
description: Prepare and publish a GitHub release when the user requests release publication, including version selection, changelog, integration, and recovery.
---

# Publish Git

Publish the current project's GitHub release with available Git and authenticated GitHub tools. This skill is standalone. A user request to publish authorizes release preparation, scoped commits, integration, push, tag, and release creation without routine confirmations. Automatic discovery, a request for advice, or creating this skill supplies no publication authority. Obtain a publishing request before writes.

## Discover and select

Inspect repository instructions, current branch, intended GitHub remote, remote default branch, working changes (including the index), tags, releases, and authoritative version files. Confirm the required Git and authenticated GitHub read/write capabilities before mutation. A missing or unauthenticated required capability blocks all edits, commits, and publication: report the exact missing capability and stop. Ask about ambiguous repository or remote selection; retain local work while waiting. Use available tools without installing tools or dependencies or changing access rules.

Select a stable version in this order:

1. Use the explicit user version, overriding a version in the branch name.
2. Otherwise use an exact branch name `release/vX.Y.Z` or `vX.Y.Z`, where X, Y, and Z are nonnegative integers with no leading zeros except zero itself. Other branch names supply no version.
3. Otherwise inspect history since the latest release tag reachable from HEAD in this project's release lineage, plus relevant pending changes. Ignore unrelated component tags. Ask if component ownership or the applicable lineage is unclear. Recommend a version, explain the user-visible reason briefly, and ask the user to choose before mutation.

Before 1.0, recommend a minor bump for features or breaking changes, and a patch bump for fixes. From 1.0, recommend major for breaking changes, minor for features, and patch for fixes. With no release tag, inspect history from the beginning, recommend `0.1.0`, and ask. Ask for intent for prereleases, multiple independent release lines, or contradictory release requests. Normalize the selected title and tag to `vX.Y.Z`.

## Prepare and check

For every selected version, use the latest release tag reachable from HEAD in this project's release lineage as the changelog and history baseline; with no release tag, inspect history from the beginning. Inspect committed history and pending changes that will enter the release. Include release-related pending changes; ask about uncertain ownership before including them. Record unrelated staged, unstaged, untracked, and scratch content so it can be preserved.

Update authoritative version files and their associated lockfiles or generated metadata using project conventions. Reconcile conflicting current-version metadata to the selected version; preserve historical references.

Create or update the target section in `CHANGELOG.md` using the project's format and release date. Describe very high-level end-user outcomes, rather than commits, internal refactors, or routine test changes. Incorporate applicable unreleased notes once, without duplicate outcomes, and preserve prior release entries. If there are no end-user changes, state that plainly.

Run repository-required checks after the final preparation changes. Failed or unrun required checks block publication. Commit only inspected release changes. Preserve unrelated index entries as well as worktree content: use a selective commit or an isolated index/worktree when paths contain mixed ownership. Verify the candidate commit's complete diff and the remaining index/worktree against the recorded state. A broad staging or commit operation must not absorb unrelated content.

## Integrate and publish

1. Refresh remote state, confirm the default branch, and inspect its protection and PR rules before any publication push. Integrate the prepared release through a normal merge or fast-forward under those rules. If already on that branch, use its verified release commit. Preserve unrelated local content during branch operations; use an isolated worktree when needed. Stop on merge conflicts or changed release scope that requires user judgment.
2. Verify the resulting release commit and run required checks against that integrated result. Refresh remote state before publication. If the default branch advanced, integrate its new state and rerun required checks against the resulting release commit, or stop on conflict. Checks on an earlier candidate do not verify a changed integrated result.
3. If rules require a PR, push only the release branch and create or reuse a matching release PR; report its URL and remaining reviews/checks. Stop at that gate until its merge is verified on the remote default branch and required checks pass. Otherwise, push the default branch only when its rules permit, then verify the remote contains the checked release commit. A PR gate blocks tag and release creation; never use an administrative bypass.
4. Create and push `vX.Y.Z` at the verified release commit on the default branch. Verify the remote tag resolves to that commit, including dereferencing an annotated tag.
5. Create a published GitHub release titled `vX.Y.Z` bound to that verified tag. Use exactly the following two Markdown links, each on its own line, as the entire body:

   ```text
   [Changelog](https://github.com/OWNER/REPO/blob/vX.Y.Z/CHANGELOG.md#VERIFIED-SECTION-ANCHOR)
   [Commits](https://github.com/OWNER/REPO/commits/vX.Y.Z)
   ```

   Substitute the intended repository and selected tag. Derive the anchor from the actual changelog version heading, and verify that the tagged file contains that heading and the link resolves to its section. Use GitHub's automatic source archives; add no custom assets or package-registry publication.

## Recover and report

Before retrying any commit, merge, push, tag, or release, inspect the actual local and remote outcome. A lost response can follow a successful write. Reuse matching completed operations and perform only missing work: for example, a correct pushed tag with no release needs only release creation once its checked default-branch commit is verified.

Inspect existing release PRs before creating one on retry. Reuse a matching open PR and report its remaining gate instead of creating a duplicate. Continue publication only after its merge is verified on the remote default branch and required checks pass.

Compare any existing local or remote tag and release with the intended release commit and payload. Stop on a conflicting tag target, release binding, merge conflict, or state that cannot be reconciled safely. Preserve completed effects and evidence. Recovery must not move published tags, force-push shared history, delete releases, or reset unrelated work. Report a mismatched existing release body for a user decision instead of silently replacing it.

Completion requires the verified release commit on the remote default branch, matching remote tag, and published GitHub release with the two-link body. Report version, commit, tag, release URL, checks, and remaining unrelated local changes. For partial publication, name each completed operation and the exact blocker or PR gate so the next attempt can resume.
