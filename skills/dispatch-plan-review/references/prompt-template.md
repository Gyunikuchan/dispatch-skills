# dispatch-plan-review delegate prompt

Filled by preparation via `fill-template.mjs`; `--list` reads the variable bullets below.

## Prompt template

Populate the template variables:
- `<Plan Path>` — path to the attached plan.
- `<Requirement>` — original user ask, verbatim.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed sections: <changed sections>`.
- `<Tool Turn Budget>` — orchestrator-supplied advisory target, or `Unspecified`.

````markdown
Review the plan adversarially: challenge the requirement, its premise, and the plan. No code has
been written yet.

### Context
- Plan: <Plan Path>
- Requirement: <Requirement>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

Inspect the supplied scope and its direct contracts. Adhere to this project's conventions: read
`AGENTS.md` / `CLAUDE.md`, including nested ones on reviewed paths, and flag violations as
`standards`. Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
On re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat
earlier settled sections as closed. When Scope names changed sections, raise new in-scope findings
only there; `adjacent` findings may cite any locus. Stop at that blast radius.

Check these tags:
- intent: `intent`, `traceability`, `user-gap`, `scope`, `scope-creep` — requirement-to-change traceability; unstated assumptions; flawed premises, XY problems, conflicting constraints, missing prerequisites; gold-plating
- domain invariants: `correctness`, `domain-logic`, `invariant`, `state-machine` — project and domain rules; sign and unit conventions (debit/credit, monthly/annual); invariants across multi-step mutations; valid transitions and reachable states
- architecture: `architecture`, `coherence`, `approach`, `standards` — producer/consumer contract mismatches; step order; self-contradiction; boundary leaks; host rule files and specs
- trust boundaries: `security`, `auth`, `validation` — credential exposure, isolation, authorization, input validation, injection, traversal
- compatibility: `compatibility`, `blast-radius`, `migration`, `compat`, `rollback` — affected callers; persisted schemas; multi-version compatibility; graceful degradation; rollback paths
- verification: `verification`, `testability`, `spec-gap` — a named test or concrete step per criterion; pass/fail definitions; edge expectations
- simpler path: `simplicity`, `yagni`, `edge-case` — delete, reuse, stdlib, then new code; empty, zero, and boundary inputs; partial failure; races; fallbacks
- out of scope: `adjacent` — a concrete existing-code defect you meet outside Scope while inspecting; nearest plan heading as locus, code cited in the defect; spend no extra turns hunting

Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
If unspecified, target `8 + 2 × proposed-change entries`; on re-review count changed entries only.

Run commands in the foreground; reply once the review is complete.
End your reply with one JSON object holding every finding. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Plan heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a verifiable claim and a `§ <Plan heading>` locus. Cite existing code as
`path/to/file:L<line>` inside `defect`. Use only the tags above. Omit praise, summaries,
and next steps.
````
