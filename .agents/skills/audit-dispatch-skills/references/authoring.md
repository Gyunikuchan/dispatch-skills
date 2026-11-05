# Authoring brief

You audit the agent-facing prose of this repository as a static sweep of the scenarios in your packet (`contradiction`, `rule-home`, `disclosure-flow`). You return **claims**; the lead verifies them. Zero claims is valid.

**Objective**: find where instructions an agent loads disagree, restate a rule outside its home, load more than a branch needs, or take more steps than the outcome needs.

**Targets**: agent-facing prose in `skills/dispatch/**` (`SKILL.md`, `references/**`, templates, script-emitted instructions), `AGENTS.md`, and the support skills under `.agents/skills/` (`audit-dispatch-skills`, `audit-dispatch-skills-fix`, `optimise-tests`). Vendored skills listed in `skills-lock.json` are read-only context: cite them as the standard, never as a target. Each scenario's `entries` seed the sweep; follow links and repeated terms into further target files.

**Standard**: `AGENTS.md` (Documentation Standards, Product Objective and Principles) and `.agents/skills/writing-for-agents/SKILL.md`.

**Constraints**:

- Static only: read and compare. Launching another agent is out of bounds.
- Write only your packet's `findingsPath`, in the format of [findings.md](findings.md).
- Budget: the run manifest holds the effective limits (`scopeToolCalls`, `scopeMinutes`, `branchExpansionsPerScope`). Count as you go. Search by key term across the targets before reading whole files; a whole-tree read earns nothing.

## Axes

Use these as the `Axis` key of a claim.

| Axis | Question |
|---|---|
| `contradiction` | Do two statements of one rule differ in trigger, sequence, limit, owner or exception? |
| `rule-home` | Does each rule have one canonical home, with other files linking to it? |
| `conformance` | Does the prose follow `writing-for-agents`: explicit triggers, sequence, boundaries, checkable completion criteria, and rationale only where it alters execution? |
| `disclosure` | Does always-loaded text hold only what every branch needs, with branch detail behind a link? |
| `flow` | Does each step have one next action and one completion criterion, with no repeated read, restated gate or redundant round trip? |

## Per scenario

1. **Expect first.** Write the scenario's expected outcome from the packet's `expectedOutcome` and the standard before opening the targets.
2. **Sweep by scenario class.**
   - `contradiction`: list each rule that two or more target files state (limits, gates, ownership, ordering, names, commands). Compare the statements pairwise on trigger, sequence, limit, owner and exception.
   - `rule-home`: for each repeated rule, name its canonical home (the file the standard or `AGENTS.md` designates, else the most specific owner). Record each restatement and whether it links to the home or carries a reason to stay inline, such as a rule every branch needs.
   - `disclosure-flow`: walk the load path an agent follows for a verb or support skill, entry file first. Record what loads at each step, whether the current branch needs it, and the next action and completion criterion each step gives.
3. **Record one row per compared statement or loaded step** in the trace's `Path`, with `path:line` support for each side.
4. **Seek counterevidence** before writing a claim: a link to the home, a stated scope difference, a test or script that enforces one reading, or an exception that makes both statements true refutes it.

## Evidence and classification

- A **defect** is a contradiction or a duplicate rule home. It cites **both locations**, quotes both statements in `Evidence`, and names the governing source (the canonical home, test or standard) that settles it. A demonstrated contradiction with no governing source stays a defect: state that authority or intent is unresolved and name the decision the fix needs.
- A restatement counts as a duplicate rule home when it states the rule in full and the standard gives no reason to keep it inline, such as a rule every branch needs. A link alone does not remove the duplicate; a short pointer is not one.
- An **opportunity** covers `conformance`, `disclosure` and `flow` improvements: it carries no severity and stays out of the fix run. State the scenario it would change and `Benefit` as measured (for example brief bytes from `node scripts/brief-size.ts`) or `unmeasured — <what would measure it>`.
- Calling a step redundant requires naming the decision or assurance it fails to add; repetition alone is an opportunity.
- Severity follows [findings.md](findings.md): a contradiction that sends an agent into a wrong action is `high`; one that causes friction is `medium`; a duplicate home without conflict is `low`.

**Done when**: every packet scenario has a trace whose `Result` is filled, every claim cites its support (both locations for contradictions and duplicate homes), and coverage and counters are written.

## Stopping

- A target file your key-term searches surface costs no branch expansion; inspect it within the tool-call and minute limits. A file outside the targets costs one **branch expansion**; past the limit, list it under `Handoff` as a remaining lead. Report targets left unswept as a coverage gap.
- Behaviour of a verb's runtime, routing, provider or recovery paths belongs to the verb and shared scopes: one `Handoff` line each, then continue.
- At the tool-call or minute limit, stop at the next row boundary, mark unfinished scenarios `gap — budget exhausted`, and write the file. A written partial file beats an unwritten complete one.
- A repair request from the lead (missing or malformed output) gets one pass: fix the named defect in your file only.

Return only your terminal status (`complete` or `partial`), defect and opportunity counts, gaps, and the findings path.
