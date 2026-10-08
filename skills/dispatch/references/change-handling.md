# Change handling

## Observe and preserve

Observe Git-tracked files and non-ignored untracked files. Git decides ignore membership, including nested rules, negation, global excludes and `.git/info/exclude`. A tracked file remains observed when an ignore pattern matches it. A previously observed untracked file that becomes ignored leaves observation as a membership change. Keep actual deletion distinct. Record rule and membership changes; ignore edits wholly inside ignored untracked paths.

Ignored dependencies and secrets are outside automatic drift and hotfix observation. Required verification still runs. Explicit executable/configuration integrity checks, scoped write admission and live destination preflight remain mandatory.

Snapshots reference complete immutable `recovery-manifests/<sha256>.json` files. Recovery bytes remain in `recovery-contents/<sha256>`. Effects validate schema, digest, length and containment before use. Publish these files durably before the event that refers to them. Reuse identical verified artifacts; retain them for the run lifetime. Preserve the whole run for handoff or recovery.

Journal replay scans bounded byte chunks and folds recorded results. It does not re-observe historical checkout state. A missing or corrupt reference is an integrity error. Protocol 7 rejects older live runs; preserve those files and start a new run. This release supplies no migration, garbage collection or old-journal repair. Individual records, manifests and current machine state can still consume substantial memory.

## Resolve a notice

At a live acceptance boundary, the driver captures and records the change. A notice binds phase, parked event/effect, before/after hashes, relevance, affected evidence and an immutable raw-delta artifact. Inspect that artifact when the summary omits paths. Continue independent branches; park dependent acceptance until resolution.

Expected requires a valid scoped receipt or exact driver ownership. Irrelevant requires complete dependency coverage that proves disjointness. A path outside criterion `Changes` is insufficient proof. Unknown dependencies require fresh affected checks. Relevance never adds write authority, and caller-dirty files are still compared against their recorded bytes.

An `EVIDENCE` criterion row may record `dependencies:{inputs:[<repository-relative paths>],complete:true,rationale:<coverage evidence>}`. Complete coverage includes transitive test, command, tool and configuration inputs, including aggregate gates; never derive it from `Changes` alone. Omitted or incomplete coverage remains unknown. A changed input invalidates matching or unknown criterion evidence; proven independent evidence remains valid. Git/index/ignore-rule identity changes invalidate all criteria.

For `DECISION kind=drift`, supply `{by:"orchestrator",noticeId,afterHash,action,rationale,evidenceIds}`. Bind the current notice and account for all affected evidence:

- `preserve`: retain evidence only for established irrelevant changes.
- `refresh`: accept current content within settled intent, invalidate affected evidence and rerun dependent checks/review.
- `reconcile`: use the existing revision/rebuild flow; retain approved write scope.
- `escalate`: take changed intent or unresolved disagreement to the user.

The driver recaptures live state with a fresh effect ID before applying the answer. A second edit creates a new notice and makes the old answer obsolete. Resume the parked receipt once. Keep attempt identities, failure budgets, running handles and review caps. A refresh beyond the cap escalates with evidence retained.

## Apply at boundaries

For review, retain findings against their reviewed revision. A validated applied plan/design fix admits edits to the artifact target. All-failed or invalid receipts admit none. A later preparation, including empty scope, must pass binding comparison before acceptance. Content changes produce notices; missing or malformed bindings remain errors.

For verification, a changed observed input invalidates dependent results. Keep old evidence against old hashes and run the mandatory aggregate gates after accepted changes. A failed check remains failed.

For delivery or restore, inspect every destination, including ignored files, symlinks, modes and ancestors. Complete all-path preflight before mutation. A collision preserves caller bytes and the candidate. Rebuild/rebind before retry, then run preflight again; no drift answer permits overwrite of newer caller content.
