# Dispatch state-machine rewrite

> **TL;DR:** Rewrite every `skills/dispatch/scripts` module as strictly typed native TypeScript built around pure reducer state machines, an append-only event journal, and one closed host-await protocol; unify all reviews under the rounds policy; replace five runners with declarative provider specs; replace the test suite with fast, pure, mechanically policed tiers.
> **Parent:** user request (brainstorming session, 2026-09-29/30)
> **Decide:** spec approved 2026-09-30; next, `/dispatch xhigh design:` this spec (§21.1)
> **Risk:** high — clean-break rewrite of the whole skill, host protocol, and test suite
> **Scope:** built in `next/**` (§21.2), landing in `skills/dispatch/**`, companion aliases' CLI lines, `tests/**`, `scripts/**`, `tsconfig.json`, `package.json`, `AGENTS.md`, `docs/decisions/**`, dispatch READMEs
> **ADR:** [ADR 0006](../../../docs/decisions/0006-dispatch-state-machine.md) records the to-be architecture; ADRs 0001–0005 are updated to match.

---

## 1. Intent

### 1.1 Outcome

A `dispatch` skill whose workflow logic is readable as explicit states and transitions, verifiable by compile-time exhaustiveness and sub-second pure tests, deterministic under crash and resume, and cheaper per host turn — while preserving the product pillars in `AGENTS.md`: correctness over token efficiency over speed, native harness collaboration, claims not verdicts, structural least privilege, context hygiene, autonomous one-shot reliability, host neutrality.

### 1.2 What the user asked for (verbatim intent)

- Rewrite dispatch into a state machine to improve readability, maintainability, clarity, extensibility, robustness, testability, speed, and token efficiency.
- No backward compatibility and no legacy baggage.
- No new external dependency.
- Strict typing via `tsconfig.json` `strict: true`.
- Rewrite the tests: only high-signal, durable tests; the driver tests are too slow.
- Surface decisions that drastically cut complexity or improve outcomes.
- Start fresh; the earlier Antigravity draft (`docs/superpowers/specs/2026-09-29-dispatch-state-machine-design.md`) is inspiration only.

### 1.3 Success criteria for the rewrite

| # | Criterion | Check |
|---|---|---|
| SC1 | Every shipped script is `.ts`, runs unmodified under Node ≥ 22.18 with no flags and no build, and `tsc --strict` passes | `npm test` typecheck; runtime-version guard; e2e tier runs `node dispatch.ts` |
| SC2 | Zero runtime dependencies; `typescript` and `@types/node` remain the only type-related devDependencies | `package.json` guard |
| SC3 | `machines/`, `policy/`, `domain/` import no `node:fs`, `node:child_process`, clock, or randomness | dependency-direction/purity guard |
| SC4 | Every host-await state, event type, effect kind, and failure class is handled exhaustively (compile error when a case is missing) | `tsc` with `never` checks |
| SC5 | Any run recovers exactly by journal replay: `status` after a kill at any point yields the same pending frame or relaunches the in-flight effect whole | core tier + e2e crash/resume test |
| SC6 | `npm test` < 60 s wall-clock on the reference machine (Windows, 16 logical cores); tiers 1–5 < 5 s combined with zero child processes | test reporter budget; spawn block |
| SC7 | Frames carry no static guidance; host instructions are single-sourced per await kind in `SKILL.md` | contract guard + frame tests |
| SC8 | Behaviours listed in §17 (preserved inventory) are each covered by at least one tier-1–6 test or compile-time check | plan traceability |
| SC9 | Every legacy `.mjs` script, template, schema, and test named in §18 is deleted | layout guard |

### 1.4 Non-goals

- Backward compatibility with any existing state file, ledger, action shape, CLI flag, or resolution-log marker. Old run folders are not readable by the new driver (a `v` mismatch is refused).
- Changing the user-facing grammar `/dispatch [level] [(pins)] [verb-clause]: [argument]`.
- Changing the config file format beyond the removals listed in §14.
- New providers or new host platforms.

---

## 2. Decision log

Every decision taken in brainstorming, with rationale and rejected alternatives. `(user)` marks a choice the user made explicitly; `(spec)` marks a choice made while writing this spec, listed again in §20 for review.

| # | Decision | Rationale | Rejected |
|---|---|---|---|
| D1 (user) | Scope is the **whole skill**: driver, CLI, runners, review preparation/parsing, ledger, config loader, session lifecycle, contracts, tests | Strict typing touches every module anyway; most runner/review code exists to serve the old protocol | Engine-only rewrite; phased sub-projects with separate specs |
| D2 (user) | **Native `.ts` source**, executed by Node type stripping; engines `>=22.18`; `tsc --strict` for checking only; no build, no `dist` | Keeps "copy files and run" portability; real TS syntax for readability; strictness without JSDoc verbosity | `.mjs` + strict JSDoc (verbose, hurts readability); `.ts` compiled to committed `.mjs` (build step, duplicated tree, hash drift) |
| D3 (user) | Node ≥ 22.18 is the one host prerequisite; `doctor` and a tiny entry guard report older Node with an actionable message | Type stripping is unflagged from 22.18; verified on 24.19 with no warning | Supporting 22.0–22.17 via a loader or compile step |
| D4 (user) | **Event journal is the authority**: one append-only `events.jsonl` per run; state = `fold(events)`; recovery = replay | Deterministic, testable recovery; deletes artifact re-parsing, HTML-comment markers, ledger, hydrator | Snapshot + artifact re-parsing (current model); snapshot only (no audit trail, a corrupt write loses the run) |
| D5 (user) | Driver-rendered Markdown (walkthrough, review logs, reports) is **write-only**; host-authored inputs (plan, design) are parsed once at submission and the parse result is stored in the event | Replay never re-reads mutable files; no parse-back drift | Parsing rendered artifacts back on recovery |
| D6 (user) | Hand edits to rendered artifacts are not read back; the host changes a run only by sending events; a lost journal restarts the run (artifacts and code remain) | Direct consequence of D4/D5, accepted trade-off | — |
| D7 (user) | **One review loop for every review kind** (plan, design, code; fix or report-only): the rounds policy of ADR 0005 | One engine, one policy object; reviewer confirmation already covered by rounds (ADR 0005 D5/D9) | Keeping rebuttal/consensus waves as a second policy |
| D8 (user) | Mitigations adopted with D7: **disputes-only round scope** when nothing was fixed; **affinity as a roster rule** (each pending rejection is shown to its source slot or that slot's substitute); **`intent` finding category** that the orchestrator must rule `needs-user` | Keeps rebuttal-wave cost, source affinity, and intent disputes without a second wave type | Dropping those properties |
| D9 (user) | Accepted loss: after the cap, `SHOULD` rejections on plans/designs are orchestrator-final (same as code under ADR 0005) | Consistency; bounded review spend | Per-kind thresholds |
| D10 (user) | **Keep bundle discovery** (CLI → desktop → VS Code per provider), expressed as per-OS candidate globs in each `ProviderSpec`, one generic scanner; fallback chain is modes then models | Zero-config for users with only desktop/VS Code installs | PATH plus a `binary` config override |
| D11 | One generic runner plus declarative `ProviderSpec` per provider; per-runner standalone CLIs removed; `doctor` covers reachability | ~7k lines of five near-identical runners collapse to ~1.2k | Porting five runners |
| D12 (user) | **Failure disposition has three options**: `hotfix`, `retry`, `stop`. `manual-complete` exists only as an explicit user ruling at `stop`. The driver never reverts on disposition | Removes re-verify, red-ruling, keep-and-inspect, revert-with-patch branches; reverting is the user's own git action | Porting the seven-way disposition |
| D13 (user) | **Drop cross-run verify reuse** (24 h cache); keep within-run reuse when the tree fingerprint is unchanged | Removes cache invalidation code; costs one `npm test` on consecutive identical-tree runs | Keeping the cache |
| D14 (user) | **Drop `--phases from:<phase>`**; resume is journal replay; `implement: <settled plan path>` skips plan and plan review | No phase-selection grammar | Keeping phase selection |
| D15 (user) | **Replace design amendments with one `REVISE` mechanism** for plans and designs: host- or writer-triggered, delta-scoped review, then rebind that keeps verified evidence for unchanged criteria | Keeps mid-implementation flexibility with one mechanism at both levels; small changes cost one narrow round | Dropping mid-flight changes; revision without review; revision with mandatory user approval |
| D16 (user) | **Engine = typed reducers over discriminated unions**: each machine is a pure `step(state, event) → { state, effects }` with exhaustive `switch`; sub-machines nest as fields; a small exported `transitions` table per machine feeds docs/diagrams and is test-checked against the reducer | Strongest strict typing, least machinery, JSON-serializable state, natural backward jumps for `REVISE` | Generic statechart engine (weak typing, engine to own); durable coroutines (opaque state, awkward rebind) |
| D17 (user) | **One CLI invocation runs automatic work until judgment is needed**: `send` folds, validates, appends, runs effects in a loop, prints one frame | Removes `--next`/`--drive`/`--verify` split and `drive.mjs` | Per-step processes |
| D18 (user) | **Closed set of 8 host-await kinds**: `author`, `native`, `rule`, `fix`, `write`, `evidence`, `decide`, `done`; `launch` and `verify` are driver-internal | Fewer, sharper host decisions | 9 legacy actions |
| D19 (user) | **No guidance in frames**; one short `SKILL.md` section per await kind; frames carry projected decision data, a reply template, and a one-line `at` breadcrumb | 75%+ fewer per-turn tokens; single-sourced instructions | Guidance arrays per action |
| D20 (user) | Event validators are TS type guards; driver reply JSON schemas are deleted; delegate report schemas stay (provider CLIs consume them) | Single source for reply shapes | Maintaining JSON schema twins |
| D21 (user) | **Progress visibility**: stderr milestone lines at effect start and per sub-milestone with breadcrumb and expected duration; live `progress.json` with 30 s heartbeat; lock-free read-only `status` with stall hints; journal `EFFECT_STARTED`; `at` in every frame | Host can tell working from hung and answer the user without polling cost | End-of-effect banners only |
| D22 (user) | Three failure tiers: bad event (re-emit frame + error, append nothing), domain failure (result event, machine decides), engine fault (exit 2, fault frame, nothing appended) | Clear contract for every failure | — |
| D23 (user) | **One drift rule**: every await records a working-tree fingerprint; the next `send` classifies changes against the await's permitted paths; out-of-permission changes enter `decide:drift` (`adopt`/`stop` per path) | Replaces per-phase drift checks, write-scope rulings, and checkpoint-drift restarts | Per-phase checks |
| D24 (user) | Tests rewritten from scratch in six tiers asserting the public protocol; `npm test` < 60 s; tiers 1–5 < 5 s with zero processes | Current suite ~320 s dominated by per-step process spawns | Porting the harness |
| D25 (user) | **Test rules enforced mechanically**; the judgment-only remainder lives in `AGENTS.md`; no `tests/README.md` | Agents reliably read only always-loaded files; guards cannot be skipped | A tests README |
| D26 (user) | Delivery in nine ordered increments I01–I09 (§19; the implement machine spans I05–I06). I01–I08 build the complete new tree, including contracts, tooling, and tests, in a `next/` overlay that mirrors the repository root; I09 swaps the trees | Each increment leaves `npm test` green; the legacy tree, tooling, and tests are never touched mid-delivery; the swap is mechanical and Git records renames; the largest step is split to fit one run | Big-bang replacement; one-shot rewrite; additive in-place edits beside the legacy tree (needed two root tsconfigs, path-scoped preloads, and no-shadowing rules, and deferred all contracts to cutover) |
| D27 (user) | Bootstrapping (§21): `/dispatch design` of this spec, then the current driver implements I01–I08 one increment per invocation in fresh chats, writing only under `next/**`; I09 runs in a manual session; commit per increment; the new driver's `max (all)` branch review is the acceptance gate | The running driver is the tree being replaced (the skill is symlinked), so the overlay keeps it stable; cutover deletes the running driver | Running cutover through the old driver; a frozen worktree copy of the old skill |
| D28 (user) | **Strict sandbox**: with `sandbox: true` (the default), a provider that rejects or cannot activate its sandbox fails that slot with `sandbox-unsupported`; the cascade moves to reserves or native fallback; nothing reruns unsandboxed. Running without isolation requires an explicit `sandbox: false` for that provider | Least privilege is structural, not best-effort; an unsandboxed run is always a visible config decision | Visible downgrade (rerun once unsandboxed with a warning) |
| D29 (user) | **`design` stops at an approved design; `implement: <design path>` executes it**: all ready increments in dependency order without pausing, then integration, in one run | Mirrors `plan` → `implement: <plan path>`; `design` never writes production code; one run delivers the whole design with no babysitting | `design` running increments itself; one increment per invocation |

---

## 3. Architecture

### 3.1 Layers

```text
skills/dispatch/scripts/
  dispatch.ts          CLI entry: start | send | status | doctor | session; Node version guard
  core/                run types, journal, interpreter, frame projection, event validation, lock, progress
  machines/            pure step() reducers: root, ask, review, implement, design, revision
  policy/              pure rules: rounds + convergence, cascade, hotfix budget, roster/level/pins, drift permission
  domain/              pure parsers, linters, renderers: plan, design, walkthrough, report, prompt, fix clustering, sanitize
  effects/             I/O handlers returning result events: wave, verify, git, artifacts, brief, restore, handoff
  providers/           ProviderSpec type, generic runner, discovery scanner, one spec per provider
  lib/                 config loader/validator, platform + orchestrator detection, session paths/lifecycle, integrity, fs helpers
```

Dependency direction (enforced by `tests/integration/dependency-direction`):

```text
dispatch.ts → core → machines → policy → domain
                  ↘ effects → providers → lib
machines, policy, domain: no node:fs, node:child_process, node:os, Date, Math.random, process.env
effects, providers, lib: may do I/O; never import machines
```

`core/interpreter.ts` is the only module that imports both `machines/` and `effects/`.

### 3.2 Why reducers, not an engine

Six machines do not justify a generic statechart engine. A discriminated union narrows per-state data, a `switch` with a `never` default turns every missing transition into a compile error, state stays plain JSON for journal snapshots and tests, and `REVISE` can return any target state directly. Diagrams come from each machine's exported `transitions` table (§5.9).

### 3.3 Tooling

`tsconfig.json` (single config, whole repository):

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["skills/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
}
```

- Erasable syntax only: no `enum`, `namespace`, parameter properties, decorators. Closed sets use union literals and `as const` objects.
- Relative imports carry `.ts`. Type-only imports use `import type` (required by `verbatimModuleSyntax`, which type stripping needs).
- Tests and repository tooling (`scripts/`) are `.ts` too (§20 S1): one toolchain, one strict config.
- During delivery (I01–I08, §21.2) this config lives at `next/tsconfig.json` in the overlay, and the legacy root config stays untouched. I09 moves it to the root; the end state has one config.
- `npm test`: `tsc -p .` → hashes check → terms check → `node --test` over `tests/**/*.test.ts` with the isolated-temp preload and the reporter.
- `package.json` `engines.node` = `>=22.18`.
- `dispatch.ts` begins with a version guard that runs before any other import is evaluated: it lives in a sibling `guard.mjs` (plain JS, parsed by any Node) imported first; on Node < 22.18 it prints `dispatch requires Node >= 22.18 (found vX); upgrade Node` and exits 1. This is the only `.mjs` file in the skill.
- On Node 22.18–22.x the first `.ts` load prints one `ExperimentalWarning` line to stderr; stdout (the protocol channel) stays clean. Node 24+ prints nothing.
- Type stripping refuses files under `node_modules`; skills install to `.claude/skills/`, `.agents/skills/`, and similar, never `node_modules`.

---

## 4. Core

### 4.1 Journal

- Path: `<session>/.state/runs/NNN-<kind>/events.jsonl` (ADR 0003 layout).
- Line: `{ "seq": n, "v": 1, "at": "<ISO-8601 ms Z>", "type": "<EventType>", "data": { … } }`.
- Append = `open(a)` + write + `fsync`. `seq` is contiguous from 1.
- Read: a torn **last** line (unparseable, or missing trailing newline) is dropped and logged to stderr; the effect it would have recorded is re-executed. A bad line **mid-file**, a `seq` gap, or `v ≠ 1` is an engine fault.
- `at` is assigned by the interpreter at append time; reducers read time only from events.
- The journal is the ledger: there is no separate ledger file, telemetry file, evidence file, or `state.json`.
- An optional in-run snapshot cache (`fold.json`: `{ seq, state }`) may be written after each `send` to skip replay; it is a pure cache, validated by `seq` and discarded on any mismatch. Replay of a few hundred events is sub-millisecond, so the cache is added only if profiling shows need (§20 S2).

### 4.2 Event taxonomy

```ts
type Event = HostEvent | ResultEvent | LifecycleEvent;

type LifecycleEvent =
  | { type: 'RUN_STARTED'; verb: Verb; argument: string; level: Level; levelSource: 'explicit' | 'classified';
      pins: Pins | null; fix: boolean; orchestrator: Platform; orchestratorModel: string | null;
      overrides: Overrides; config: ResolvedConfig; repo: RepoIdentity }
  | { type: 'EFFECT_STARTED'; effectId: string; kind: EffectKind; pid?: number }
  | { type: 'LOCK_BROKEN'; stalePid: number };

type HostEvent =
  | { type: 'AUTHORED'; path: string }
  | { type: 'NATIVE_RESULTS'; slots: NativeSlotResult[] }
  | { type: 'RULINGS'; rulings: Record<FindingId, Ruling> }
  | { type: 'FIXES_APPLIED'; clusters: FixClusterResult[] }
  | { type: 'WRITE_ENVELOPE'; envelopePath: string }
  | { type: 'WRITE_FAILED'; model: string; kind: WriterFailureKind; reason: string }   // launcher cascade
  | { type: 'EVIDENCE'; criteria: Record<CriterionId, CriterionEvidence> }
  | { type: 'DECISION'; kind: DecideKind; answer: DecisionAnswer }
  | { type: 'REVISE'; artifact: 'plan' | 'design'; reason: string; evidence: string };

type ResultEvent =
  | { type: 'ARTIFACT_PARSED'; effectId: string; kind: 'plan' | 'design'; hash: string; parsed: ParsedPlan | ParsedDesign; defects: LintDefect[] }
  | { type: 'REVIEW_PREPARED'; effectId: string; scope: ReviewScope; promptPaths: Record<SlotId, string> }
  | { type: 'WAVE_PROGRESS'; effectId: string; slot: SlotId; status: SlotStatus }        // early native-fallback need
  | { type: 'WAVE_DONE'; effectId: string; round: number; slots: SlotOutcome[]; findings: Finding[] }
  | { type: 'VERIFY_DONE'; effectId: string; purpose: VerifyPurpose; results: CommandResult[]; fingerprint: TreeFingerprint }
  | { type: 'BRIEF_READY'; effectId: string; stage: WriteStage; path: string; sha256: string; envelopePath: string }
  | { type: 'ENVELOPE_CHECKED'; effectId: string; envelope: WriteEnvelope | null; defects: string[]; diff: PathDiff }
  | { type: 'SNAPSHOT'; effectId: string; fingerprint: TreeFingerprint; diff: PathDiff }
  | { type: 'RESTORED'; effectId: string; paths: string[]; patchPath: string }
  | { type: 'HANDOFF_DONE'; effectId: string; destination: string; warning: string | null }
  | { type: 'EFFECT_FAILED'; effectId: string; cls: EffectFailureClass; detail: string };
```

Every host event is validated against the current await before it is appended (§4.5). Result events are produced only by effect handlers.

### 4.3 Effects

```ts
type Effect =
  | { kind: 'parse-artifact'; id: string; path: string; artifact: 'plan' | 'design' }
  | { kind: 'prepare-review'; id: string; review: ReviewSpec; round: number; scope: ScopeRequest }
  | { kind: 'wave'; id: string; round: number; roster: RosterSlot[]; timeoutMs: number }
  | { kind: 'verify'; id: string; purpose: VerifyPurpose; commands: VerifyCommand[] }
  | { kind: 'write-brief'; id: string; stage: WriteStage; input: BriefInput }
  | { kind: 'check-envelope'; id: string; envelopePath: string; permitted: PathSet }
  | { kind: 'snapshot'; id: string; since: TreeFingerprint | null }
  | { kind: 'restore'; id: string; paths: string[]; to: TreeFingerprint }        // §8.7 only
  | { kind: 'handoff'; id: string; terminal: boolean };
```

- Effect ids are deterministic (`<machine-path>:<kind>:<n>`), so replay matches results to effects.
- Rendering artifacts is not an effect: after each `send` the interpreter renders all driver-owned Markdown from the final state (idempotent overwrite).
- Handlers receive a `Ports` object (`fs`, `spawn`, `git`, `clock`, `env`) so the core tier can inject fakes.

### 4.4 Interpreter

```text
send(runDir, rawEvent):
  lock(runDir)                                  // §4.7
  events  = journal.read(runDir)
  state   = events.reduce(stepRoot, initial)
  pending = inFlightEffect(events)              // EFFECT_STARTED without a matching result
  if rawEvent:
     ev = validate(state, rawEvent)             // bad → frame(state, error), exit 0, nothing appended
     append(ev); state = step(state, ev)        // reducer parks ev in a `checking` sub-state and emits `snapshot` (§9)
  loop:
     effects = pending ? [pending] : state.effects
     if effects empty: break
     for e in effects (sequential; wave is internally concurrent):
        append(EFFECT_STARTED)
        result = handlers[e.kind](e, ports, progress)     // may yield early for native slots (§6.5)
        append(result); state = step(state, result)
  renderArtifacts(state)
  print(frame(state))                           // stdout, one JSON line
  unlock
```

- `state.effects` is the effect list returned by the last `step`; reducers never execute anything.
- `MAX_STEPS = 200` per `send` guards a reducer bug from looping forever; exceeding it is an engine fault.
- `start` creates the run folder (exclusive `mkdir`, ADR 0003), appends `RUN_STARTED`, and enters the same loop.

### 4.5 Validation

- One type guard per host event type in `core/validate.ts`, hand-written with a tiny combinator set (`obj`, `str`, `num`, `lit`, `arr`, `rec`, `opt`, `oneOf`) — no dependency.
- Validation checks shape **and** context: the event type must be one the current await accepts; referenced ids (findings, clusters, criteria, slots, decision kinds) must exist; paths must be inside the repository or the session.
- Rejection: nothing appended; the same frame is re-emitted with `"error": "<one line naming the field and the expected value>"`; exit 0.
- `send --dry-run` runs validation (and for `WRITE_ENVELOPE`, the envelope check) without appending or running effects. The write subagent uses it as its self-check (replaces `--check-envelope`).

### 4.6 Frames

```jsonc
{
  "v": 1,
  "run": "<run dir, relative to repo root>",
  "at": "implement › code-review R2/3 › rule",
  "await": "rule",                      // one of the 8 kinds
  "data": { … },                        // projection for this await only (§11.2)
  "reply": "<exact send command template>",
  "error": "<optional, one line>"
}
```

- stdout carries exactly one frame per invocation, as one JSON line. Nothing else is ever written to stdout.
- Bulk content (delegate reports, briefs, logs, full diffs) is referenced by path, never inlined.
- `done` frames carry `outcome` ∈ `complete | failed | stopped | fault | no-reviewable-changes | lint-defects | skipped`, the completion summary (§8.9), and `handoff.destinations[0]` plus `handoff.warning` (ADR 0003).

### 4.7 Lock

- `<run>/lock` holds `{ pid, startedAt, host }`, created exclusively.
- A lock whose pid is not alive (same host) is broken automatically; `LOCK_BROKEN` is appended.
- A live lock makes `send` fail with exit 3 and a message naming the pid (the host must not run two `send`s concurrently).
- `status` never takes the lock.

### 4.8 Progress

- `<run>/progress.json` rewritten atomically at each milestone and every 30 s while an effect runs: `{ at, effect: { id, kind, startedAt, expectedMs }, slots?: [{ slot, provider, pid, state, startedAt, lastOutputAt, logPath }], command?: { argv, pid, startedAt, lastOutputAt, logPath } }`.
- stderr milestone lines (never the heartbeat), prefixed `[dispatch]`:

```text
[dispatch] implement › task › verify scoped: npm test (last 4m50s, timeout 15m)
[dispatch] implement › code-review R2/3 › wave: 3 slots claude[0] agy[0] copilot[1]; timeout 20m
[dispatch]   agy[0] failed: quota → reserve codex[0]
[dispatch]   claude[0] ok 1m52s, 4 findings
[dispatch] wave R2 done 3m41s; next: rule (5 findings)
```

- `expectedMs` is the duration of the last run of the same command (verify) or wave kind, read from the journal of the current session's runs; absent on first run.
- Stall hint: a slot or command with no output for longer than `STALL_HINT_MS = 5 min` is flagged in `status` as `no output 6m, pid 4412 alive|dead`. Hints never kill anything; timeouts do (§6.3).

### 4.9 `status`

Read-only, lock-free: folds the journal, reads `progress.json`, and prints the current frame plus, when an effect is in flight, a `progress` object (breadcrumb, effect, per-slot state, elapsed vs expected, stall hints). After any interruption, `status` returns the exact pending frame; if an effect was in flight and its worker is dead, the frame is the one that `send` (no event) will resume by relaunching it.

---

## 5. Machines

### 5.1 Shape

```ts
type Step<S, E> = (state: S, event: E) => { state: S; effects: Effect[] };
```

- Each machine exports `initial(input)`, `step`, `awaitOf(state): Await | null`, `project(state): FrameData`, and `transitions` (§5.9).
- A parent state embeds a child state as a field (e.g. `{ tag: 'implement.code-review'; review: ReviewState }`). The parent's `step` forwards events to the child and maps child terminal tags (`settled`, `escalated`, `failed`) to its own transitions.
- `REVISE` is handled by a wrapper around `implement` and `design` steps (§5.7): it saves the current parent state as `resume` and enters `revision`.

### 5.2 Host-await kinds

| Await | Host does | Reply event | Accepted in |
|---|---|---|---|
| `author` | Write or revise the plan/design at `data.path` (brainstorming first for new work) | `AUTHORED` | plan, design, revision |
| `native` | Launch every listed native-subagent slot (targets served natively and native fallbacks) in one parallel round; capture outputs at `outputPath` | `NATIVE_RESULTS` | any wave |
| `rule` | Verify every finding at its locus; rule `accept`, `reject`, `downgrade`, `needs-user`; rule `intent` findings `needs-user` | `RULINGS` | review |
| `fix` | Apply accepted fix clusters (write subagent, or directly when trivial); for plan/design reviews, revise the document | `FIXES_APPLIED` | review in fix mode |
| `write` | Launch the configured write subagent with the brief at `data.briefPath`; relay the envelope path | `WRITE_ENVELOPE` / `WRITE_FAILED` | implement |
| `evidence` | Judge each criterion from the driver-run verify summary | `EVIDENCE` | implement |
| `decide` | Relay a typed decision; user-owned kinds need `{by, quote}` from chat | `DECISION` | all |
| `done` | Report the outcome and handoff root | — | all |

`DecideKind` = `approval | baseline | failure | concerns | escalation | needs-user | opt-in | drift`.

| Kind | Options | Owner |
|---|---|---|
| `approval` | `approve` / `reject(reason)` for a settled plan or design | user (`{by, quote}`) |
| `baseline` | `accept-known-red(ids)` / `hotfix` / `stop` | host (pre-approved gates allowed) |
| `failure` | `hotfix` / `retry(context?)` / `stop` (+ optional `manual-complete` with per-criterion evidence, user only) | host; `manual-complete` user |
| `concerns` | per writer concern: `accept` / `retry(context)` | host |
| `escalation` | `stop` only (convergence halt, §7.5) | user informed; host answers `stop` |
| `needs-user` | per finding: user ruling text | user |
| `opt-in` | select adjacent findings / pending-user `CONSIDER` items to apply | user |
| `drift` | per path: `adopt` / `stop` | host |

### 5.3 Root

`root.step` selects by `RUN_STARTED.verb`: `ask`, `plan`, `review`, `implement`, `design`. `implement` dispatches on its argument: a plain-language requirement → plan flow; a plan path → plan flow entering at plan review or, if settled, baseline; a design path → design delivery (§5.8). Terminal child states map to `done` with outcome. The root owns handoff: on any terminal state it emits `handoff { terminal: true }` and renders the final frame after `HANDOFF_DONE`.

### 5.4 ask

`preparing → wave → [native] → done{claims, failed}`.

- The prompt bounds objective, evidence, stop condition, and output shape (templates in `references/templates/`).
- `done` carries `claims` (each with source slot) and `failed` (slots with failure class). The host treats every claim as untrusted (SKILL.md).

### 5.5 review (reusable sub-machine)

Input: `ReviewSpec = { kind: 'plan' | 'design' | 'code'; mode: 'fix' | 'report'; target; cap; breadth; context }`.

```text
prepare ──REVIEW_PREPARED──▶ wave ──WAVE_DONE──▶ rule ──RULINGS──▶ ┬─(fix mode, accepted fixes)──▶ fix ──FIXES_APPLIED──▶ fix-verify ──VERIFY_DONE / ARTIFACT_PARSED──▶ next?
   ▲                          │ (native slots)                     │                                                                                       │
   │                          ▼                                    └─(no fixes)──────────────────────────────────────────────────────────────────────────▶ next?
   │                        native ──NATIVE_RESULTS──▶ (wave completes)                                                                                     │
   └──────────────────────────────────────────────── next round (full | delta | disputes-only) ◀───────────────────────────────────────────────────────────┤
                                                                                              settled ◀──────────────────────────────────────────────────────┤
                                                                                              decide:escalation ◀─ convergence failure ──────────────────────┤
                                                                                              decide:needs-user / decide:opt-in ◀─ pending items ───────────┘
```

- `prepare` resolves scope: code reviews compute the range/diff (plan-less code review fills `context` from the chat); plan/design reviews use the parsed artifact and, for increment plans, a bounded excerpt of the approved design.
- `fix-verify`: code fixes run the scoped verify gate for affected criteria; plan/design fixes re-parse and lint the document (`parse-artifact`); lint defects return to `fix`.
- `next?` is `policy/rounds.ts` (§7).
- `needs-user` rulings enter `decide:needs-user` before `next?`.
- `opt-in` is asked once after the main scope settles, listing verified adjacent findings and bounded pending-user `CONSIDER` items (`--fix` only); accepted items are applied and verified without another review wave.
- Rounds = 0 (disabled by level config) → `skipped` immediately; the parent records the skip.

### 5.6 implement

```text
plan? ─▶ plan-review ─▶ baseline ─▶ decide:approval ─▶ implementation ─▶ code-review ─▶ final-verify ─▶ handoff ─▶ done
```

- `plan?`: if the argument is a plan already settled (parsed, lint-clean, review settled or review disabled), skip to `baseline`; otherwise `author` then `plan-review` (review machine, kind plan, mode fix).
- `baseline` (§8.2), `implementation` (§8.3–8.7), `code-review` (review machine, kind code, mode fix), `final-verify` (§8.8), completion (§8.9).

### 5.7 revision

Triggered by `REVISE` at any await inside `implement` or `design` except while a `write` is outstanding (the envelope must arrive first), or by a writer envelope concern of kind `blocked-by-plan`, which makes the next frame offer `REVISE`.

```text
author (working copy of the artifact) ─▶ review(kind = artifact, mode = fix, scope = artifact diff only) ─▶ rebind ─▶ resume parent
```

Rebind rules:

- **Plan**: criteria unchanged in content and mapping keep status and evidence; changed and new criteria become pending; removed criteria are dropped and recorded as deviations in the walkthrough. Approval is re-requested only if approved paths or commands grew.
- **Design**: unstarted increments rebind silently; a completed increment whose acceptance criteria changed is reopened; integration's baseline moves to the new revision.
- A revision that changes the objective (plan TL;DR goal or design outcome) is refused with an error naming the field: that is a new run.
- Journal: `REVISE`, `AUTHORED`, `ARTIFACT_PARSED` (after-hash), then the delta review's events. Rebind is a pure reducer computation on review settlement, so replay reproduces it without a dedicated event. State keeps `revisions: { artifact, reason, beforeHash, afterHash, rebind }[]`, from which the walkthrough renders a revision log.

### 5.8 design

Two entry points, mirroring `plan` and `implement: <plan path>` (D29):

```text
/dispatch design: <objective>        author ─▶ design-review ─▶ decide:approval ─▶ done (approved design; no production writes)
/dispatch implement: <design.md>     [design-review + approval if not yet approved] ─▶ for each ready increment (dependency order): implement(bound) ─▶ integration ─▶ done
```

- Approval is explicit and user-attributed, bound to the governed hash (the driver-owned review section excluded; any other edit clears approval).
- Increment selection: highest-priority ready increment from the parsed dependency graph, in the reducer (no filename or user selection).
- Each increment runs the `implement` machine with plan authoring bound to the approved design revision (Technical-Design Traceability section), approval derived from the design approval, and its own walkthrough.
- An `implement: <design.md>` run continues from one increment to the next without a pause (D29); the host can stop at any await and resume later by replay. Re-running `implement: <design.md>` in the same session resumes the unfinished run bound to that design's governed hash (journal replay) instead of starting a new one; a finished run reports its outcome. Increment progress lives only in that run's journal; the design file carries no execution status, and each increment's walkthrough reports its outcome.
- `integration`: code review restricted to the union of increment-owned paths from the recorded design baseline through the current tree; a non-ancestor baseline, unreconstructable ownership, or empty owned intersection fails closed. A defect inside an increment reopens it; a changed shared contract enters `REVISE` on the design.

### 5.9 `transitions` tables

Each machine exports `transitions: readonly { from: Tag; on: EventType; to: Tag | readonly Tag[] }[]`. A tier-1 test drives every row through `step` and asserts the resulting tag; `scripts/diagram.ts` renders Mermaid from the tables into `docs/dispatch-notes.md`. A table row without a reducer case, or a reducer transition not in the table, fails the test.

---

## 6. Providers and delegate execution

### 6.1 `ProviderSpec`

```ts
type ProviderSpec = {
  id: ProviderId;                                    // 'claude' | 'agy' | 'copilot' | 'opencode' | 'codex'
  modes: readonly ModeSpec[];                        // discovery order: cli → desktop → vscode
  argv(req: DelegateRequest, mode: ModeId): Launch;  // argv, stdin, env, cwd; read-only flags always included
  parse(out: ProcessResult): RunOutcome;             // ok { text, sessionId, resume } | fail { cls, detail }
  sandbox?: { flags: readonly string[]; inactive: RegExp; supported(env: PlatformEnv): boolean };  // unsupported or inactive → sandbox-unsupported
  schema?: true;                                     // supports provider-native structured output
  native?: Platform;                                 // host platform whose subagents can serve its targets
  prepare?(req: DelegateRequest, ports: Ports): Promise<Prelaunch>;   // e.g. OpenCode loopback preflight, GPU lock, WAN trap
};
type ModeSpec = { id: ModeId; candidates: (env: PlatformEnv) => readonly string[] };  // per-OS globs
```

Provider specifics carried as spec data (from `references/providers.md`):

- **claude**: `--permission-mode plan`, read-tool allowlist, write-tool denylist; sandbox via `--settings {"sandbox":{"enabled":true}}`; native Windows (sandbox inactive) → `sandbox-unsupported` unless `sandbox: false`; `--json-schema` structured output; resume `claude --resume <id>`.
- **agy**: `--print --output-format json --mode plan --dangerously-skip-permissions`; mode cascade on token/subscription/execution failures; brief-file spill through `--add-dir`; resume `conversation://<id>`.
- **copilot**: `--mode plan`; sandbox `--experimental --sandbox`; quota may move to next mode, auth does not; resume `copilot --resume <id>`.
- **opencode**: v2-only argv `run --auto [--agent] [-m model[#effort]] [--format json] -- <prompt>`; `Variant unavailable` reruns once without effort; loopback `/models` preflight, GPU concurrency lock, WAN proxy trap; Bubblewrap sandbox on Linux; elsewhere, or without Bubblewrap, `sandbox-unsupported` unless `sandbox: false`; remote skips preflight/trap.
- **codex**: `exec --json --sandbox read-only` with approvals disabled; final assistant message from JSONL; sandbox rejection → `sandbox-unsupported`; only `sandbox: false` selects `danger-full-access`; resume `codex exec resume <id>`.

### 6.2 Shared runner (`providers/runner.ts`)

- Strips credentials from the delegate environment; applies the sensitive-file prompt guardrail; writes the prompt to a file when argv would exceed platform limits.
- Spawns with timeout (default 1800 s, overridable), output cap (default 10 MB), streams stdout/stderr to the slot log, updates `progress.json`.
- Kills the whole process tree on timeout (`taskkill /T /F` on Windows, process group on POSIX).
- Returns `ProcessResult { exit, signal, stdoutPath, stderrTail, durationMs, timedOut, truncated }`.

### 6.3 Discovery (`providers/discovery.ts`)

Expands each mode's candidate globs for the current OS, checks executability, probes once per invocation, and caches in memory. `doctor` prints the probe table (provider × mode → path | missing | unlaunchable).

### 6.4 Cascade (`policy/cascade.ts`, pure)

`FailureClass` = `quota | context-overflow | auth | model-not-found | cli-outdated | model-not-loaded | sandbox-unsupported | not-found | timeout | buffer | empty-output | refusal | truncated | integrity | config`.

`next(cls, position) → next-model | next-mode | reserve | native-fallback | terminal`:

- A model array is a cascade inside one voice (ADR 0001): every failure tries the next alias, including auth.
- Mode cascade applies to provider-declared classes (agy: token/subscription/execution; copilot: quota).
- `sandbox-unsupported` (with `sandbox: true`) fails the slot without trying other models or modes of that provider, since the sandbox gap is a property of the provider on this host; the slot moves straight to reserves or native fallback (D28). `sandbox: false` passes no sandbox flags and never produces this class. `supported(env)` lets `doctor` predict the failure before any run.
- `timeout`/`buffer` preserve partial output; the report parser decides whether it is sufficient.
- Exhausted voice → the next unused ordered reserve (at most once per wave, recorded `<failed> → <reserve>: <reason>`), or `native-fallback` when the failed target's platform is the orchestrator's; otherwise the slot is a named failure.
- `integrity` and `config` are terminal for the run.

### 6.5 Wave effect (`effects/wave.ts`)

1. **Roster** (`policy/roster.ts`): level → phase policy (`targets`, `only`) → pins → diversity sort (every platform's first candidate before any second; orchestrator platform last; orchestrator model last within it) → `-m`/`-e` overrides collapse a platform to one target → affinity: every pending rejection is assigned to its source slot or that slot's substitute → reserves.
2. **Launch**: CLI slots run in a detached **wave worker** process (`dispatch.ts wave-worker --run <dir> --effect <id>`, internal) that writes per-slot outcome files and `progress.json`. The interpreter waits on it, streaming milestone lines.
3. **Native slots**: targets with `nativeSubagentsOnly` on the orchestrator platform, and failed same-platform slots needing native fallback, are yielded as a `native` frame immediately (early fallbacks keep the worker running). The host launches them in one parallel round and replies once; the next `send` appends `NATIVE_RESULTS`, waits for the worker, then appends `WAVE_DONE`.
4. **Native fallback descriptors** are closed: `{ sourceKey, agentType, model, reasoningEffort, substitutesFor, cascadePosition, modelCascade, promptPath, outputPath, attachments }`. Model mapping uses `references/native-model-mappings.json`; the driver independently checks a reported `mapping`. A repeated mismatch records `availability`; empty early captures retry post-wave at position 0; a confirmed mapping rejection resumes at position 1.
5. **Reconciliation**: every roster slot ends as direct success, reserve substitution, native capture, or a named failure before `WAVE_DONE`. All reports go through one parse path (`domain/report.ts`); refusal, truncation, empty output, missing scope coverage, or loose loci count as failures requiring fallback.
6. **Crash**: on resume, a live worker pid is reattached; a dead worker without complete outcomes relaunches the whole wave.

---

## 7. Review policy (all kinds)

Implemented in `policy/rounds.ts`; the contract lives in `references/review.md`; rationale in ADR 0005.

### 7.1 Threshold and cap

- `cap` = configured rounds for the phase at the run level (`phases.plan-review.rounds` for plan and design reviews; `phases.code-review.rounds` for code). No phase policy → standalone reviews use one target and one round. `0` disables the review at that level.
- Threshold after round N: `SHOULD` while N < cap, `MUST` once N ≥ cap. `MUST` rounds are uncapped.

### 7.2 Resolution before round decisions

Every finding is resolved (fixed or `pending-rejection`) before deciding on another round. In fix mode accepted in-scope `MUST`/`SHOULD` and bounded `CONSIDER` are applied immediately; in report mode acceptance is recorded without edits.

### 7.3 Next-round trigger and scope

- Another round runs when any finding at or above the threshold was fixed this round or is pending rejection.
- Scope: rounds ≤ cap review the full target plus all open pending rejections; rounds > cap review only fixes applied since the previous round plus open `MUST` pending rejections; a round in which nothing was fixed reviews **disputes only** (the pending rejections and their loci).
- Plan/design fix rounds review the revised document; the delta scope is the document diff.

### 7.4 Disputes

- A rejected in-scope `MUST`/`SHOULD` becomes `pending-rejection` and rides the next round as context to its affinity slot.
- The reviewer accepts by omission (closed by reviewer) or re-raises it as a regular finding with new evidence; the host rules a re-raise as a new finding answering that evidence.
- Below the threshold the driver closes pending rejections (closed by orchestrator); at or above it only the reviewer closes them.
- Findings with category `intent` (the governing plan/design itself is wrong) must be ruled `needs-user`; the user's answer may trigger `REVISE`.
- A finding contradicting a recorded decision in the governing artifact is rejected unless it cites evidence the recorded rationale did not weigh, in which case it is `needs-user`.

### 7.5 Convergence

A re-raise of an applied fix (regression), or a second re-raise of a pending rejection (deadlock), matched by location + category with loose text similarity, halts the loop with `decide:escalation`; the host answers `stop`; the finding is never finalized.

### 7.6 Exit

When no trigger fires, the loop exits. Fixes no later round reviewed pass through the final gate and are listed in completion as `fixedUnreviewed` with their round; completion also lists rejections, round count, and cap status.

### 7.7 Findings

`Finding = { id, severity: 'MUST' | 'SHOULD' | 'CONSIDER', category, locus, defect, requiredChange, sources: SlotId[], scope: 'in' | 'adjacent', fix?: { paths, dependencies, verification } }`. Duplicates keep the first id and record `dupOf`. Only reporting sources are cited. Delegate text is sanitized before relay or rendering.

---

## 8. Implementation behaviour

### 8.1 Plan inputs

Parsed once at `AUTHORED`/`REVISE` by `domain/plan.ts` and stored in `ARTIFACT_PARSED`: summary box, Key Decisions, Success Criteria (`SC<n>` with `Changes`, `Verify`, `Evidence: red|verify|review`, `Pre-existing`, `RED exception`, `Test rationale`, `Review`, `Enforcement infeasibility`), Proposed Changes (`[NEW]`, `[MODIFY]`, `[DELETE]`, `[GENERATED]` with `Command`), Verification Plan commands, `[FINAL]` markers, Technical-Design Traceability for increment plans. Approved paths, commands, criterion mappings, and generated paths derive from it. The plan's governed hash excludes the driver-owned trailing section `## Review Findings & Resolutions` (§10.2).

### 8.2 Baseline

- Runs every approved command once (`verify` purpose `baseline`) before approval and records results and failure identities.
- Nonzero results enter `decide:baseline`: `accept-known-red(ids)` (later identical failures are `known red — unchanged`), `hotfix` (host-only, §8.6; listed in the approval question), or `stop`.
- Baseline side effects on the tree are reconciled via `snapshot` before approval.

### 8.3 Stages

```text
[tests stage: write(tests-only) → red-verify] → production stage: write(production) → scoped-verify → evidence → (concerns?) → done
```

- **Tests stage** runs only when red criteria exist. The tests-only writer receives only the red criteria manifest, approved test paths, mapped commands, expected failures, and the envelope schema. No production edits are allowed; a production edit from a tests-only write always fails.
- **RED gate**: runs only red-mapped commands, narrowing covering suites to red test files. Exactly one valid matrix row per red criterion is admitted; the driver observes the expected failure before production work. A baseline-red collision is admitted only for `Pre-existing: yes`. A quality defect (including a test file that fails to load) permits one bounded same-model repair; another defect enters `decide:failure`. `RED exception` criteria take the no-failing-state ruling path. No read review gates RED; code review covers test quality.
- **Production stage**: writer receives the governing outcome, settled scope, criteria, repository rules, prior findings, and evidence (labelled as evidence), via a brief file (`write-brief`, sha256 recorded). The host relays the path, not the brief.
- **Scoped verify** per attempt and fix round reruns changed-scope commands, deferring criteria that only `[FINAL]` commands carry.
- **Evidence**: the host judges criteria from the verify summary (the driver already ran the commands; the host never reruns them). Evidence must postdate the last mapped mutation.
- **Concerns** in the envelope enter `decide:concerns`.

### 8.4 Write subagent and launcher cascade

- `write` frame: `{ stage, briefPath, briefSha256, envelopePath, models: string[], effort, paths }`.
- The host launches the configured native write subagent (or writes directly when trivial); the writer saves and self-checks the envelope with `send --dry-run`, then returns status, one-line summary, concerns, and the path.
- A model array is a launch cascade inside one attempt: `WRITE_FAILED { model, kind, reason }` (unsupported identifier → `rejected`; launched and failed → availability/auth/quota/…) advances to the next model without consuming an attempt. Terminal kinds (`sandbox-unsupported`, `integrity`) or an exhausted cascade end the run `failed`.
- Use exact configured model ids or a verified host-to-config mapping; record the actual launched id.
- Attempt bound: `MAX_WRITE_ATTEMPTS = 3` per stage (`retry` consumes one; hotfix never does).

### 8.5 Failure disposition

Verify failure, writer `blocked`, or writer `missing-context` enters `decide:failure` with `hotfix | retry(context?) | stop`. The tree is preserved and fingerprinted first.

- `retry`: new write attempt, root-cause-first brief including the failure evidence and supplied context.
- `hotfix`: §8.6.
- `stop`: run ends `stopped`; tree preserved; the user may revert with git themselves. `manual-complete` is accepted only here, only with `{by, quote}` from chat and per-criterion evidence.

### 8.6 Hotfix (ADR 0004)

- Mode by size: host inline (the host edits, then answers `DECISION { kind: failure|baseline, answer: { hotfix: { mode: 'inline', external?: {path, reason}[] } } }`), or `mode: 'writer'`, which makes the driver emit a `write` await with the hotfix brief (`write-brief-hotfix.md`) for one single-shot writer; its `WRITE_ENVELOPE` completes the hotfix.
- A violation re-emits the same `decide` frame with the violation in `data.items`.
- The driver judges the diff: budget ≤ 10 files and ≤ 150 changed lines (excluding `external` paths, each with a reason); hard limits — no paths outside the repository, no `.git/`, no secret paths, no deletion of task-start files, no git writes (enforced via HEAD, index, and stash fingerprints).
- A violation re-asks the hotfix; it never reverts.
- The stalled check re-runs immediately; hot-fixed paths join `finalFocus` for the code review.
- No-progress check: a hotfix is withdrawn for the stage when the failure it targeted survives unchanged.
- Before RED validates, a hotfix may not edit production paths.
- Offered at every stall: `decide:failure`, `decide:baseline` (host only).
- Journal: `DECISION{failure: hotfix}` → `SNAPSHOT` → `VERIFY_DONE`.

### 8.7 Out-of-scope writer changes

- After each write, `check-envelope` diffs the tree against the stage's permitted paths.
- A **successful** write that changed other paths enters `decide:drift` per path (`adopt` extends approved paths and joins `finalFocus`; `stop` ends the run). The nearest `skill-hashes.json` above an approved path is auto-adopted when it verifies.
- A **failed** writer attempt inside the model cascade: before the next model launches, its changes are saved as a patch under the run folder and those paths are restored to the pre-attempt fingerprint (`restore` effect). A patch that cannot be saved stops the restore and the run (ADR 0004 D10). This is the only tree mutation the driver ever performs (§20 S5).

### 8.8 Final verify

Reruns `[GENERATED]` commands, then every stale or uncovered command including `[FINAL]` ones (a covering `npm test` carries its file commands' criteria), mapping observable behaviour to owning production paths. Within-run reuse: a command whose inputs fingerprint is unchanged since a passing run is not rerun. The post-review scoped gate is skipped when the final gate reruns its stale commands. Nonzero results regress unless they match an accepted baseline identity.

### 8.9 Completion

Complete only when every criterion has delivered behaviour, fresh mapped evidence, reconciled ownership, and recorded limitations; every finding has a ruling; verification is current; the walkthrough renders. The `done` frame lists `fixedUnreviewed`, rejections, rounds, cap status, deviations, revisions, and the handoff root.

---

## 9. Drift

- Every await records the tree fingerprint (HEAD, index hash, working-tree content id) in its effect result.
- On the next `send`, a `snapshot` diffs against it. Permitted paths per await: `fix`, `write` → the stage's approved paths (plus test paths for tests-only); `author` → the artifact path; `native` → nothing in the repository (outputs go to the session); `rule`, `evidence`, `decide` → nothing.
- Order: the validated host event is appended first; the reducer parks it in a `checking` sub-state and emits `snapshot`. On `SNAPSHOT` with no out-of-permission change, the parked event is applied. Otherwise the state enters `decide:drift` with the parked event retained; after the decision (`adopt` for every path) the parked event is applied, and `stop` ends the run. Everything is in the journal, so replay reproduces it.
- Caller-dirty paths present at run start are recorded and never classified as drift.

---

## 10. Artifacts and session

### 10.1 Session layout (ADR 0003, updated)

```text
<session>/
├── manifest.json
├── <slug>.<type>.md                 deliverables: spec, design, plan, walkthrough, report
└── .state/
    ├── deliverables.json
    └── runs/NNN-<kind>/             kind ∈ ask | plan | design | implement | plan-review | design-review | code-review
        ├── events.jsonl             authority
        ├── lock
        ├── progress.json
        ├── <scope>.<kind>.<ext>     prompts, reports, briefs, envelopes, verify logs, patches
        └── scratch/
```

Handoff, reactivation, naming grammar, collision safety, and the move to `<realpath(os.tmpdir())>/dispatch-skills/<folder>/` are unchanged from ADR 0003.

### 10.2 Rendered sections

- Walkthrough: rendered from the first `send` after plan settlement, so it exists before baseline verification; fully rendered from state (minimum contract: H1 + summary box, `## Context` when Parent is user request, `## Changes Made`, `## Verification` table `| SC | Outcome | Evidence |` + `Final gate:` line, `## Deviations & Follow-ups`, `## Review Findings & Resolutions`, plus a revision log when revisions occurred).
- Plan/design: host-authored; the driver owns only the trailing `## Review Findings & Resolutions` section, located by that exact heading and replaced wholesale on each render. Nothing inside it is parsed. The governed hash excludes it.
- Standalone review: `<slug>.report.md`, fully rendered.
- Resolution entries render round headers, reviewers, failed targets, and each finding with status; no HTML comment markers.

---

## 11. Protocol and CLI

### 11.1 CLI

```text
dispatch.ts start <verb> --session-dir <dir> --orchestrator <platform>
                  [--level L --level-source explicit|classified] [--pins P] [--fix] [--kind plan|design|code]
                  [--provider P] [--model M] [--effort E] [--timeout S] [--orchestrator-model M] [--verbose]
                  -- <argument>
dispatch.ts send   --run <dir> [--event <json|@file>] [--dry-run]
dispatch.ts status --run <dir>
dispatch.ts doctor [--level L] [--json]
dispatch.ts session init --objective <text> | reactivate | handoff
```

- `send` without `--event` resumes pending automatic work (or re-prints the frame).
- `doctor` reports Node version, config validation (replaces `--validate-only`), effective membership and target order (replaces `--list-platforms`/`--list-targets`), level resolution, phase policy, write subagents, provider discovery table, predicted sandbox support per provider on this OS (with the `sandbox: false` fix when unsupported), integrity.
- `/dispatch design: <objective>` ends at the approved design; `/dispatch implement: <design path>` executes it.
- Removed: `--run/--next/--drive/--verify/--state/--input/--check-envelope/--phases/--batch-file/--prompt*/--file/--agent/--max-buffer/--no-config/--json/--output-file/--round/--response-schema-file/--candidate-index/--list-*/--validate-only`, and every per-runner flag (§20 S6). Direct single-provider dispatch is `start ask --provider P`.
- Exit codes: 0 frame printed (including rejection and `done`), 1 usage/Node version, 2 engine fault (fault frame printed), 3 lock held.

### 11.2 Frame data by await

| Await | `data` |
|---|---|
| `author` | `{ artifact, path, template, defects?: LintDefect[], revision?: { reason } }` |
| `native` | `{ round, slots: NativeDescriptor[] }` |
| `rule` | `{ round, cap, threshold, findings: Finding[] (compact), pending: {id, severity, status}[], reportPaths }` |
| `fix` | `{ round, clusters: { clusterId, findingIds, affectedPaths, verification }[] }` |
| `write` | `{ stage, attempt, briefPath, briefSha256, envelopePath, models, effort, paths }` |
| `evidence` | `{ purpose, summary: { command, exit, logPath, diagnostic? }[], criteria: { id, outcome, evidenceClass }[] }` |
| `decide` | `{ kind, question (one line), options, items? }` |
| `done` | `{ outcome, summary, claims? , completion?, handoff }` |

### 11.3 SKILL.md contract shape

Grammar (unchanged); run loop (`session init` → `start` → background `send` → act on `await` → repeat until `done`; `status` for progress and recovery); one section per await kind stating only the host judgment it needs; write boundaries; recovery (journal is authority; run `status`). Level classification rule (user-written level → explicit; else classify `low|medium|high`; `xhigh`/`max` only when the user selects them) and pin mapping stay.

---

## 12. Error handling

| Tier | Examples | Handling |
|---|---|---|
| Bad event | wrong type for the await, unknown id, malformed JSON, path outside repo | nothing appended; same frame + one-line `error`; exit 0 |
| Domain failure | red verify, slot quota, writer out of scope, hotfix over budget, lint defects | result event; machine decides (cascade, `decide:*`, `author` with defects) |
| Engine fault | invariant breach, unhandled exception, mid-file journal corruption, `MAX_STEPS` exceeded | exit 2; `done` frame with `outcome: fault`, `error`, `run`; nothing appended past the last good event |

- Idempotent effects: renders overwrite; verify reruns; waves relaunch whole; parse is pure over file content + hash; handoff reconciles an interrupted move (ADR 0003).
- Integrity: `skill-hashes.json` verification failure is terminal (`INTEGRITY_VIOLATION`).
- Config, membership, and integrity errors are reported verbatim and are terminal.
- Safety invariants: read delegates are structurally read-only; delegate text is data; production writes require recorded approval; the driver never edits production code and never reverts on disposition; Git publication is the user's.

---

## 13. Speed

- One process per host turn; all automatic effects run in-process (verify, prepare, parse) or in the wave worker.
- Git reads go through `effects/git.ts` with the ADR 0002 caching rules (successful toplevel lookups cached per process; index entries cached by index content hash; no caching of working-tree-dependent reads).
- Within-run verify reuse by fingerprint (§8.8).
- Journal replay instead of artifact parsing on every step.

---

## 14. Configuration

- File format per ADR 0001 is unchanged: `read-delegates`, `write-subagents`, `phases` (`plan-review`, `code-review`) with `targets`, `rounds`, `only`.
- Removed keys: none beyond ADR 0005's `consensus` removal. No new keys.
- `phases.plan-review` governs plan and design reviews under the rounds policy.
- Validation stays exhaustive and strict (unknown keys rejected with a pointer to `config.sample.jsonc`).

---

## 15. Testing

### 15.1 Tiers

| Tier | Location | What | How | Budget |
|---|---|---|---|---|
| 1 Machines | `tests/unit/machines/` | transitions per machine; each `decide` branch; `REVISE`/rebind; nesting hand-off; `transitions` table parity | `play(machine, events) → frames[]`; assert frames only | — |
| 2 Policy | `tests/unit/policy/` | rounds + convergence, cascade, hotfix budget, roster/level/pins/affinity, drift permission | table-driven; one row per ADR 0001/0004/0005 clause | — |
| 3 Domain | `tests/unit/domain/` | plan/design parse + lint, report parse, fix clustering, renderers, prompt fill | small inline fixtures; review-prompt golden files are the only snapshots | — |
| 4 Core | `tests/unit/core/` | loop stops at await; append/replay; torn tail; `v` refusal; stale lock; bad event re-emits frame; dry-run appends nothing | real fs in isolated temp; fake handlers; no git | — |
| 5 Providers | `tests/unit/providers/` | read-only invariant (provider × mode × sandbox); `parse` on recorded outputs; discovery on a fake fs table | pure | tiers 1–5 < 5 s total, zero processes |
| 6 E2E | `tests/e2e/` | (a) `implement` happy path; (b) `review code --fix` with a dispute + kill + `status` resume; (c) `doctor` | real CLI, temp git repo, stub provider script on PATH | ≤ 3 files |
| Guards | `tests/integration/` | dependency direction + purity, path convention, link integrity, skill contracts, runtime version (`>=22.18`), CLI/alias parity, layout, test-rule guards | static scans | — |

### 15.2 Mechanical enforcement

| Rule | Guard |
|---|---|
| Tiers 1–5 spawn nothing (incl. git) | `tests/helpers/isolated-temp.ts` preload patches `child_process` spawn/exec/fork/execFile(Sync) to throw outside `tests/e2e/` |
| No sleeps or timing assertions | guard scans non-e2e tests for `setTimeout`, `setInterval`, `sleep`, `Date.now`/`performance.now` in assertions; `tests/allow-timing.json` lists justified exceptions |
| No full-file snapshots | guard confines `*.snap`, `*.golden.*`, and expected-output `.md` fixtures to `tests/fixtures/review-prompt-golden/` |
| Pure layers stay pure | dependency-direction guard (§3.1) |
| Suite stays fast | `scripts/test-reporter.ts` prints the slowest files and fails any non-e2e file over 1 s |
| E2E stays small | guard caps `tests/e2e/` at 3 files; raising it is an explicit edit |

Each guard's failure message states the rule and the fix.

### 15.3 Judgment rules (in `AGENTS.md` → Execution & Handoff → Verify, replacing words, net-neutral)

> Tests assert observable protocol (frames, events, rendered sections), never internal state shape or private helpers; one behavior per test, named as that behavior. Git or subprocess needs mean `tests/e2e/` or a design smell.

### 15.4 Compile-time coverage

Exhaustive `never` checks over `Await`, `DecideKind`, `Event['type']`, `Effect['kind']`, `FailureClass`, and every machine's state tags replace tests for "unhandled case" behaviour.

---

## 16. Contracts and documentation

| File | Change |
|---|---|
| `skills/dispatch/SKILL.md` | rewritten per §11.3; net word count lower |
| `references/review.md` | rounds policy for all kinds (§7), finding shape, rendered resolution log, session lifecycle; rebuttal/consensus/marker rules removed |
| `references/verbs/implement.md` | stages, RED, write cascade, failure disposition, hotfix, drift, revision; ledger/recovery prose → "journal is authority; `status` recovers" |
| `references/verbs/design.md` | approval, increments, revision, integration |
| `references/providers.md` | runner flags → spec behaviour; probe via `doctor`; failure classes; native fallback descriptors |
| `references/glossary.md` | add Frame, Await, Event, Journal, Revision; drop Settlement (consensus exit), Rebuttal; redefine Affinity as roster rule; Run = one `start` and its journal |
| `references/templates/` | delete `rebuttal*.md`, `schemas/rebuttal.json`, `schemas/driver/*`; keep review prompts, report schemas, plan/design/walkthrough, write briefs |
| Aliases (`dispatch-*-review`, `dispatch-implement`) | same shape; mapped CLI line → `start` |
| `README.md`, `skills/dispatch/README.md`, `references/readme/*` | Node ≥ 22.18, new CLI, progress/status, troubleshooting |
| `docs/dispatch-notes.md` | machine map, generated transition diagrams, maintainer notes |
| `docs/decisions/0006-*.md` | new ADR (to-be architecture) |
| `docs/decisions/0001–0005` | updated to the new implementation |
| `AGENTS.md` | Node 22.18 requirement, `.ts` conventions (replacing `// @ts-check` / JSDoc rules), test rules (§15.3), verify command shape |
| `skill-hashes.json`, `scripts/generate-hashes.ts` | cover `.ts` |
| `scripts/check-terms.ts` | glossary-driven banned synonyms unchanged in mechanism |

---

## 17. Preserved behaviour inventory

Each item must map to a test or compile-time check in the plan (SC8).

**Grammar and routing**: verb grammar and default `ask`; prefix-only `design`/`plan`/`implement` require an argument; `review` infers kind and scope; `--fix` opt-in; level classification rules; pins `(a,b)`/`(3)`/`(all)`; `only` provider filter; diversity sort; orchestrator platform/model demotion and detection markers; `-m`/`-e` override collapse; `nativeSubagentsOnly`; positional target identity `<provider>[<index>]`; sparse level maps with nearest-lower-then-lowest-higher resolution.

**Delegates**: structural read-only per provider; credential stripping; sensitive-file guardrail; sandbox default on, and unavailable isolation fails the slot instead of downgrading; per-provider resume handles; failure classes; model-array cascade within a voice; mode cascade; reserves once per wave; native fallback descriptors and mapping verification; early fallbacks; every roster slot reconciled; one report parse path for all sources; refusal/truncation/empty/uncovered/loose-locus → fallback; integrity check before dispatch.

**Review**: rounds policy (§7) incl. threshold, cap, uncapped MUST, full/delta/disputes-only scope, affinity, accept-by-omission, orchestrator closure below threshold, convergence escalation, `fixedUnreviewed`; `intent` → needs-user; recorded-decision rule; standalone report-only default; `--fix` `CONSIDER` handling and single opt-in ask; adjacent findings as follow-ups; fix clustering with bounded attempts; dedup with `dupOf`; sanitization.

**Implement**: plan lint; settled-plan skip; baseline with known-red acceptance; approval with `{by, quote}`; tests-only stage and RED gate rules (one row per red criterion, pre-existing collisions, one quality repair, RED exceptions, narrowing); production brief contents and hash; envelope self-check; writer launcher cascade; attempt bound; evidence postdates mutation; `[FINAL]` deferral; `[GENERATED]` rerun; final gate coverage; within-run reuse; failure disposition (3); hotfix budget, hard limits, no-progress, finalFocus, pre-RED restriction, stall coverage; out-of-scope handling; completion rules.

**Design**: `design` stops at approval; `implement: <design path>` delivers all increments then integration; approval bound to governed hash; increment selection by graph priority; derived approvals; traceability section; integration ownership and fail-closed rules; reopen on defect; revision.

**Session**: ADR 0003 lifecycle unchanged (folder identity, layout, naming grammar, collision safety, handoff move, reactivation, relative references).

**Walkthrough**: minimum contract (§10.2).

---

## 18. Removed

- Code: `driver/*`, `ledger/*`, `review/consensus.mjs`, `review/rebuttal-packets.mjs`, `review/resolution-log.mjs` (parser), `design/amendment.mjs`, `design/status.mjs`, `runners/*` (replaced), `session.mjs` (folded into `dispatch.ts session`), all `.mjs` except `guard.mjs`.
- Behaviour: sandbox downgrade reruns; rebuttal/consensus waves and `CONFIRM`/`REBUT`/`INTENT-DISPUTE`; cap extend/stop gate; `--phases`; day-long verify reuse; amendment lifecycle states; seven-way failure disposition and driver revert; artifact re-parsing recovery; HTML comment markers; `state.json`, `.ledger.md`, `.evidence.json`, `telemetry.jsonl`, `.state/cache/`; guidance arrays; driver reply JSON schemas; per-runner CLIs and flags; one-increment-per-invocation design execution.
- Docs: `docs/superpowers/specs/2026-09-29-dispatch-state-machine-design.md` (already deleted by the user).
- Tests: the entire current `tests/skills/dispatch/**`, `tests/helpers/*` fixtures and `driver-harness`, and integration guards superseded by §15.

---

## 19. Delivery order

Nine increments, executed per §21. Each ends with `npm test` green and a commit. I01–I08 build the complete new tree, including contracts, tooling, and tests, inside the `next/` overlay (§21.2). The legacy tree, its tooling, and its tests stay untouched until I09 swaps the trees. Paths below are relative to the overlay root. Because `next/` mirrors the repository root, they are also the final paths.

| ID | Increment | Depends on | Contents |
|---|---|---|---|
| I01 | Foundations | — | `next/tsconfig.json` (§3.3); root `package.json` gains `test:next`, and `test` runs it last; `guard.mjs`; `core/` (types, journal, interpreter, frame, validation, lock, progress); `tests/helpers/` (isolated-temp and spawn-blocking preloads, `play`); `scripts/test-reporter.ts` with budgets; purity, timing, and snapshot guards |
| I02 | Pure logic | I01 | `policy/` (rounds and convergence, cascade, hotfix budget, roster/level/pins/affinity, drift permission) and `domain/` (plan/design parse and lint, report parse, fix clustering, renderers, prompt fill, sanitize), ported from the existing pure modules |
| I03 | Providers | I02 | `ProviderSpec` and the five specs, discovery, runner, wave effect and worker; `lib/` config, platform, and session |
| I04 | Machines I | I03 | `root`, `review`, `ask`, `plan` and `review` verbs; remaining `effects/` (git, verify, artifacts, brief, snapshot, handoff) |
| I05 | Machines IIa: implement core | I04 | `implement`: plan entry, baseline, approval, tests-only stage and RED gate, production stage, write cascade, scoped verify, evidence, concerns, final verify, completion |
| I06 | Machines IIb: recovery and change | I05 | Failure disposition, hotfix (budget, hard limits, no-progress), failed-attempt restore, drift rule, `revision` for plans |
| I07 | Machines III: design | I06 | `design` to approval; `implement: <design.md>` increments and integration; `revision` for designs |
| I08 | CLI, contracts, tooling | I07 | `dispatch.ts` CLI; `SKILL.next.md`, references, glossary, templates, alias skills, dispatch README, generated diagrams; `scripts/*.ts` (hashes, check-terms, validate-configs, diagrams), each taking a root so `test:next` checks the overlay; e2e tier |
| I09 | Cutover | I08 | The swap in §21.3 |

---

## 20. Decisions made while writing this spec (review these)

| # | Decision | Why | Alternative |
|---|---|---|---|
| S1 (user-confirmed) | Tests and `scripts/` tooling also move to `.ts` under the same strict config | One toolchain; strict typing for tests' fixtures and helpers | Keep tooling/tests as `.mjs` under a second non-strict config |
| S2 | No persisted fold snapshot initially; replay each `send` | Replay is sub-millisecond for hundreds of events; one less cache | Always write `fold.json` |
| S3 | Confirmed by the user as D29 | — | — |
| S4 | Resolved by the user as D28 (strict terminal sandbox); ADR 0001 updated | — | — |
| S5 (user-confirmed) | The failed-writer cascade restore (patch then restore out-of-scope paths) is kept as the driver's only tree mutation | Keeps automatic model failover lossless (ADR 0004 D10); "driver never reverts" applies to disposition | Route failed-attempt changes to `decide:drift` (no driver mutation, but a host stop per failover) |
| S6 (user-confirmed) | Low-level flags (`--prompt-file`, `--file`, `--agent`, `--response-schema-file`, `--output-file`, `--batch-file`, `--no-config`, …) are removed; `ask` covers direct dispatch; attachments come from the argument | Minimal CLI surface; everything goes through one protocol | Keeping a raw single-dispatch mode |
| S7 | `telemetry.jsonl` and `.state/cache/` are removed; durations and usage derive from the journal | Journal already records effect timing | Keeping telemetry |
| S8 | Writer concerns get their own `decide:concerns`; blocked/missing-context join `decide:failure` | Concerns are not failures; stalls share the hotfix/retry/stop options (ADR 0004 D18) | Folding concerns into failure |
| S9 | `MAX_WRITE_ATTEMPTS = 3` per stage and `STALL_HINT_MS = 5 min` are constants, not config | No new config keys (§14) | Configurable |
| S10 | Run kind for review runs is `<kind>-review`; verb runs use the verb | Listing shows what ran (ADR 0003) | Verb only |
| S11 | Implementation is modelled as ordered **stages** (tests-only → RED → production → scoped verify → evidence), not one task per criterion group as sketched while presenting Section 2 | Matches the existing RED-gate semantics (one tests-only stage covering all red criteria, then one production stage); per-criterion tasks would change RED independence | Per-criterion-group tasks |
| S12 | The earlier draft spec has been deleted by the user | — | — |

---

## 21. Execution constraints

These constraints govern how the rewrite itself is delivered (D26, D27). The design carries them into every increment plan as invariants; reviewers treat a violation as `MUST`.

### 21.1 Workflow

1. `/dispatch xhigh design: <this spec>` produces the technical design with increments I01–I09 (§19), reviewed at `xhigh`.
2. `/dispatch high implement: <design.md>` under the **current** driver runs I01–I08, one increment per invocation. Start each increment in a fresh chat that resumes the same session folder.
3. The user commits after each increment, so each has a clean rollback point.
4. I09 runs without the old driver (§21.3).
5. Acceptance: after I09, the **new** driver runs `/dispatch max (all) review code` over the whole rewrite branch. This also exercises the new protocol end to end.

| Role | Model | Effort / level |
|---|---|---|
| Orchestrator | Opus 5.5 | `high`; `xhigh` for the design session |
| Write subagents | Opus 5.5 via `dispatch-writer-<effort>` | From the action |
| Reviews | Configured providers | `xhigh` design; `high` I01–I08; `max (all)` acceptance |

### 21.2 Overlay invariant (I01–I08)

`.claude/skills/dispatch` and `.agents/skills/dispatch` link to `skills/dispatch/`, so the running driver is the tree being replaced, and each driver call re-imports its scripts from disk. The new tree is therefore built in a separate overlay:

- **Write only under `next/**`**, plus two script entries (`test:next`, and `test` calling it) in the root `package.json`. Each increment plan's approved paths are `next/**` (and `package.json` for I01), so the driver's write-scope check enforces the invariant.
- **`next/` mirrors the repository root**: `next/skills/dispatch/**`, `next/skills/<alias>/**`, `next/scripts/**`, `next/tests/**`, `next/tsconfig.json`. Relative imports and paths are written for their final location and stay valid after the swap.
- **No import crosses the boundary.** Overlay code never imports anything outside `next/` except Node built-ins; ports copy logic.
- **Skill contracts in the overlay are named `SKILL.next.md`**, so no harness or installer discovers a second `dispatch` skill. I09 renames them.
- **Root-level shared files** (`AGENTS.md`, root `README.md`, `docs/**`) change only in I09. They are few and mostly prose, and a nested `next/AGENTS.md` would be loaded as live rules by some harnesses.
- **`test:next`** runs `tsc -p next`, then the overlay's term and config checks against `next/skills`, then `node --test` over `next/tests/**/*.test.ts` with the overlay's own preloads and reporter. Hashes are not checked in the overlay; I09 generates them.

| Risk | Safeguard |
|---|---|
| Edits change the running driver mid-run | Overlay; nothing outside `next/` changes except two `package.json` scripts |
| Strict typecheck meets legacy `.mjs` | Separate configs: root `tsconfig.json` untouched, `next/tsconfig.json` strict |
| New preloads or budgets break legacy tests | Overlay tests use their own `next/tests/helpers/` and reporter |
| Skill integrity check trips | Hashing and integrity scan `skills/` only |
| Duplicate skill discovery | `SKILL.next.md` until I09 |
| Bad increment is hard to undo | Commit per increment |
| Legacy suite (~320 s) slows gates | Accepted until I09 |

### 21.3 Cutover (I09)

I09 deletes the running driver, so it must not run under the old driver. Execute it in an ordinary Claude Code session, in this order:

1. Delete everything in §18, the legacy `skills/dispatch/**` and alias files that the overlay replaces, the legacy `scripts/*.mjs` and `tests/**`, and the root `tsconfig.json`.
2. Move the overlay into place with `git mv` (so Git records renames); rename each `SKILL.next.md` to `SKILL.md`; remove the empty `next/`.
3. Update root `package.json` (`test` becomes the §3.3 pipeline; drop `test:next`; `engines.node` `>=22.18`), `AGENTS.md`, root `README.md`, and the ADR paths that name moved files.
4. Run `npm run hashes`, then `npm test` (SC6 budget).
5. Run `dispatch.ts doctor`. Set `"sandbox": false` in the local config for any provider it reports as unable to sandbox (D28).
6. Commit, then run the §21.1 acceptance review.

Steps 1–3 are mechanical. A native write subagent (`dispatch-writer-high`) may do the prose updates in step 3.
