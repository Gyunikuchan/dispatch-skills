# Fix-review-lite brief

## Objective

Judge each accepted fix to the artifact below against its finding's defect and governing requirement, not its proposed fix. Check that each citation's source supports its sentence. For each claim of data production or consumption, find the code that writes or reads it. Search consumers for each qualifier, branch or field the diff deletes or narrows; report a consumer that relied on it as a broken consumer. Report only false citations, contradictions, broken consumers and unmet requirement acceptance, each as `{kind, claim, citation}`. Never rule on findings. Edit no file.

## Accepted findings

{{questions}}

## Inputs

- Repository root: `{{repositoryRoot}}`. Relative paths resolve against this root.
- Diff from the reviewed round input to the current text: `{{diffPath}}`.
- Artifact, read whole: `{{artifact}}`.
- {{spec}}
- Citations from the diff's added lines. Read each with its enclosing section or symbol:

{{citations}}

- Unresolved citations. You may read their listed matches:

{{unresolved}}

- Withheld paths. Do not read them:

{{withheld}}

## Reading bound

Read only the diff, the artifact, the spec paths above, the listed citations and matches, and consumer search hits; never read a withheld path, even as a search hit.

Run the consumer search from the repository root, replacing `<name>` with one argument quoted for your shell: `{{consumerSearch}}`. When the name starts and ends with a word character, add `-w` before `-e`.

## Reply

Reply inline within {{replyLimit}} UTF-8 bytes. List any unread remainder as open items.

## Evidence

{{evidence}}
