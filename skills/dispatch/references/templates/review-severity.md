# Review severity rubric

Shared block for `review-prompt.md` (slot `rubric`) and the orchestrator's severity rulings. The toolkit derives severity from `impact` and `trigger`; reviewers and rulings never state it directly.

## rubric

Rate each finding on two dimensions; the toolkit derives severity from them. Report `impact` and `trigger`, never `severity`.
- `impact`: `critical` — security breach or irreversible data loss; `blocks` — the promised outcome or a binding constraint fails; `degrades` — a real defect that lowers the outcome without blocking it; `minor` — a small defect with negligible effect, or an optional improvement, which is `contrived` because no failure occurs.
- `trigger`: `realistic` — normal use or one plausible fault produces it; `contrived` — it needs several independent faults, contrived input, or no failure at all.

| `impact` | `trigger: realistic` | `trigger: contrived` |
|---|---|---|
| `critical` | `MUST` | `MUST` |
| `blocks` | `MUST` | `SHOULD` |
| `degrades` | `SHOULD` | `CONSIDER` |
| `minor` | `SHOULD` | `CONSIDER` |

A `critical` finding's `defect` names the boundary crossed or the data lost.
Severity is resolution priority: resolve `MUST` first, then `SHOULD`; `CONSIDER` is optional.
