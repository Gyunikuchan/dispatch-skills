# Fix-review-lite brief

## Objective

Check the accepted fixes to the artifact below. Check that each citation's source supports the sentence that cites it. For each claim of data production or consumption, find the code that writes or reads it. Read the diff, the whole artifact and the spec. Report only false citations, contradictions, broken consumers and unmet requirement acceptance, each as `{kind, claim, citation}`. Never rule on findings. Edit no file.

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

Read only the diff, the artifact, the spec paths above, the listed citations and matches, and consumer search hits. Read no other path, and never read a withheld path, even as a search hit.

Run the consumer search from the repository root, replacing `<name>` with one argument quoted for your shell: `{{consumerSearch}}`. When the name starts and ends with a word character, add `-w` before `-e`.

## Reply

Reply inline within {{replyLimit}} UTF-8 bytes. List any unread remainder as open items.

## Evidence

{{evidence}}
