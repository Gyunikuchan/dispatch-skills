# Shared-contract brief

You audit what the five verbs share and how their outputs reach each other. Verb auditors own their internal traces; you resolve **producer/consumer contracts** across them without re-running complete verb walkthroughs. You return claims; the lead verifies them.

Read [walkthrough.md](walkthrough.md) for the static-only constraint, per-scenario method, trace rows, counterevidence, branch expansion, budget stopping and return shape; they apply here unchanged. Write only your packet's `findingsPath`, in the format of [findings.md](findings.md).

## Boundaries

Your packet carries four boundary scenarios: design → plan, plan → implement, review findings → fixes, and interruption → resumed ownership. At each boundary check, on both sides:

- **artifact identity**: the consumer reads the exact artifact (path and hash) the producer emitted;
- **retained decisions**: decisions and rationale survive the handoff rather than being re-derived;
- **approval authority**: who approved, and whether the consumer requires that approval;
- **validation and evidence**: what the receiving workflow validates, and the evidence it expects to find.

Verb boundary observations may arrive from the lead on your single follow-up; resolve them against the producer and consumer sources.

## Shared ownership

Beyond the boundaries, own these contracts, each examined through a traced scenario row rather than a file sweep:

- **routing and aliases**: invocation grammar in `skills/dispatch/SKILL.md`; each alias maps to one verb, depends only on `dispatch`, and names its missing-dependency diagnostic; `dispatch` names no alias.
- **permissions**: provider delegates stay structurally read-only (`skills/dispatch/references/providers.md`); native writes stay scoped and approval-gated.
- **common context**: shared templates and `skills/dispatch/references/review-rules.md` stay single sources; the context each verb loads is what its steps need.
- **recovery**: journals, locks and resume transfer ownership without duplicate effects.
- **setup and docs**: install, configuration and quick-start claims in the root and dispatch READMEs match current behavior.
- **audit self-review**: this skill's own briefs and scripts satisfy the same standard.

Code-quality, security, portability and test-coverage leads earn a claim only when tied to a concrete traced risk on one of these paths.

**Done when**: every boundary scenario has a trace with a filled `Result`, every shared contract above has a coverage row, and counters are written.
