# Verbs

| Verb | Result |
|---|---|
| ask | Independent claims |
| design | Reviewed, approved design |
| plan | Reviewed implementation plan |
| review | Verified findings; fixes when requested |
| implement | Bounded changes, criterion evidence, walkthrough |

Invoke `/dispatch [level] [(pins)] [verb:] argument`; omitted verb means ask. Start examples and prerequisites are in [usage](../../README.md). Review defaults to recording findings without applying fixes; design ends at approval, then a separate implementation invocation delivers its increments.

[Plan](../verbs/plan.md) authors the task graph and file ownership; [implement](../verbs/implement.md) runs continuous isolated writers, independently admits receipts, and records verified delivery. Design increments remain sequential; task concurrency operates within an increment.
