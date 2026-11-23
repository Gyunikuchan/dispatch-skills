# Configure Dispatch

Dispatch reads its configuration from the folder containing the skill. The sample explains the available settings but is not a default configuration.

## Set up a configuration

Copy `config.sample.jsonc` to `config.local.jsonc` or `config.jsonc`, then remove providers you do not use and replace the example model names with identifiers accepted by their CLIs.

If both files exist, `config.local.jsonc` is used on its own; settings are not merged. Keep machine-specific settings in the local file.

| Setting | Needed for | What it controls |
|---|---|---|
| `diagnostics` | Optional | Retrospective `diagnostics.md` report for Dispatch maintainers |
| `write-concurrency` | Optional | Maximum number of task writers active at once; defaults to `1` |
| `read-delegates` | Questions and reviews | Provider targets and their model choices |
| `write-subagents` | Required per platform in use | Native writer models available to each host platform |
| `utility-subagents` | Required per platform in use | One native entry per platform for explorer and utility subagents, with `context-limit` (tokens) |
| `phases` | Optional | Review target counts, rounds, and provider filters |
| `read-commands` | Optional | Host read commands, such as a code-index query, that read delegates may run |
| `pricing` | Optional | Model rates that replace or extend the shipped rates behind the cost estimates in `diagnostics.md` |

The `write-concurrency` value must be a positive safe integer; omission defaults to one.

For example, a host agent running on Codex can use one configured read target and a native writer:

```jsonc
{
  "read-delegates": {
    "codex": {
      "targets": [
        { "low": { "model": "your-read-model" } }
      ]
    }
  },
  "write-subagents": {
    "codex": {
      "low": { "model": "your-writer-model" }
    }
  }
}
```

Replace the provider and model names with choices available in your environment. Start small and add more when you need additional perspectives:

- **`read-delegates`:** Prioritize strong reasoning/review models (and diverse families across providers) at `medium`+; use faster, cheaper models at `low`.
- **`write-subagents`:** Pick reliable coding models; scale from fast/mid-tier (`low`–`medium`) to your strongest coding model (`high`–`max`).
- **`utility-subagents`:** Pick a fast, cheap model with at least `medium` effort so exploration and routine tasks (such as test cleanup) stay thorough.

## Understand levels and pins

Levels are routing presets: `low`, `medium`, `high`, `xhigh`, and `max`. The level determines which configured model choices and review policy apply. If a target has no exact match, Dispatch uses its nearest configured lower level; when none exists, it uses the lowest configured higher level. Missing fields are not copied between level entries.

- `low` fits localized, routine, reversible work such as copy, documentation, isolated presentation changes, or pure tests when no runtime or domain invariant changes.
- `medium` is the normal level for bounded behavior in one feature or subsystem, such as validation, forms, flags, contained refactors, or backward-compatible integration. Use it when uncertainty is meaningful but failures remain observable and recoverable.
- `high` requires a credible consequential risk: financial or data-integrity errors, persisted-format or journal-replay invariants, security or write authority, an incompatible external contract that could materially harm callers, or cross-boundary failures that are difficult to recover. A large diff, changed external contract, finance repository, or state-machine file alone does not require high; a small rate-precision change can, while a broad reversible accessibility change may not.

- **Explicit vs. proposed level:** An explicit level stays in force. Otherwise, Dispatch proposes a level with a reason after it authors and lints a plan or design, then records it before the first review. That review uses the recorded level; you confirm the proposal with artifact approval after review.
- **Design runs & raises:** For a design, record the level before design review and carry it to its increment plans. Review or implementation may raise the level up to `high` and record the change when they find more complexity; the level never decreases mid-run.
- **Opt-in & defaults:** `xhigh` and `max` require your explicit choice. `ask` and standalone `review` resolve the level from the invocation, then the session ledger, then `medium`. A level selects your configured routing preset; it does not guarantee a fixed number of models or review rounds.

Pins affect one invocation:

| Pin | Effect |
|---|---|
| `(claude,agy)` | Use eligible targets from those providers |
| `(3)` | Select three eligible targets |
| `(all)` | Select every eligible configured target |

Each entry in a provider's `targets` list is a separate voice. A model array inside one target is a fallback list for that voice, not extra reviewers.

## Set review breadth

The optional `phases` setting controls how many independent targets review a change and how many review rounds they can take. The `plan-review` policy is used for both design and plan reviews; `code-review` controls code reviews. Without a policy, standalone reviews use one target and one round.

Start with the sample's defaults. Increase breadth or rounds when the work needs more scrutiny, and keep review settings proportional to the change.

## Check your setup

From the Dispatch skill folder, run:

```bash
node scripts/dispatch.ts session init --objective "Check Dispatch setup" --host <platform>
node scripts/dispatch.ts doctor run --session <returned-session-path> --host <platform> --level high
```

Every tool returns JSON with `ok`, `summary` and a result `path`. Read the result file even when the exit code is zero. Doctor checks skill integrity and configuration, resolves writer models at the selected level, and reports the `utility` entry per platform with its `contextLimit`.

If doctor blocks with `config-invalid`, check that `write-subagents` and `utility-subagents` include the host platform. A read delegate is not a substitute for a native writer. A review or ask voice on the host platform always runs as a native subagent; a native failure takes a reserve, then `failed`.

### Check providers live

Add `--probe` to the doctor command to check CLI launch and supported runtime capabilities for configured `read-delegates`, including the host when configured. OpenCode checks standalone configuration, agent discovery, and bubblewrap on Linux when available. Authentication for Claude, Codex, Copilot, and Antigravity is `unprobeable`. Dispatch keeps probe subprocess output in memory. Provider CLIs can still write their own caches.

If doctor returns `probe-failed`, read each failed provider's `failureCategory` and `remediation` in the result file.

| Failure category | Action |
| --- | --- |
| `not-found` | Install the provider CLI and make its launcher discoverable. |
| `timeout` | Check whether the CLI starts promptly, then retry the probe. |
| `unsupported-version` | Upgrade OpenCode to a release with standalone mode. |
| `sandbox-unavailable` | Check bubblewrap and OpenCode state directories. |
| `sandbox-unsupported` | Set `sandbox: false` for this provider to opt out of OS isolation, or use a platform that supports its sandbox. |
| `config-error` | Check the provider configuration and available agents. |
| `probe-error` | Check that the installed provider CLI starts successfully. |

## Sandboxing and provider details

Dispatch requests OS sandboxing by default where a provider and execution mode support it. Sandbox behavior varies by provider. An unpinned roster drops only a non-host provider whose sandbox cannot run on the host, and Doctor lists it in `sandboxRemoved`. If a run reports `sandbox-unsupported`, use the diagnostic to identify the affected provider and mode. Setting `sandbox:false` opts that provider out of OS isolation; provider-specific read-only controls may still apply, but they do not provide the same boundary.

For Node.js requirements and supported provider CLIs, see the [repository README](../../../../README.md).

## Optional settings

Use the strongest available model for the orchestrator, because cheap explorers and writers depend on a strong lead.

- **`utility-subagents`:** Configures native explorers and utility subagents for grounding, research, triage, test cleanup, and mechanical fixes.
  - Use a cheaper, fast model than the host agent (with at least `medium` effort) so token-heavy reading stays out of the orchestrator's context.
  - Define one `{ model, effort?, "context-limit": <tokens> }` entry per platform in use (level-independent; `context-limit` is a required positive integer, e.g. `150000` for `claude`, `300000` for others).
  - Without a valid entry for the host platform, Doctor reports a missing-entry blocker; when the host has no launch tool, the host agent reads the code itself. (When migrating older configs, rename the explorer table to `utility-subagents` and add `context-limit`.)
  - Independent topics can run in parallel, and the host agent can continue a subagent for a related follow-up ([routing](../../SKILL.md#routing)).

- Set `"write-concurrency"` above `1` only when your host platform can support that many native writers. It is an admission limit, not a capacity check.
- Set `"read-commands"` to host read-command prefixes, such as `["codegraph explore"]`, so read delegates can query a code index instead of reading many files. Name the read subcommand; a bare tool name also permits its write subcommands. List only commands that write at most their own cache or index: Claude delegates can still write in the working directory, even with `sandbox: true`. The host agent creates or refreshes the index before it launches delegates. Claude and Copilot add listed commands to their allowlist, except Copilot emits `shell(<entry>:*)` rules only for single-word entries and leaves multi-word entries to its approval judge; Codex, Antigravity and OpenCode do not apply `read-commands`.
- Set `"diagnostics": true` to write a shareable `diagnostics.md` retrospective at report completion or a verb's final handoff. It uses session review results and host retro notes. At each verb handoff with observations, the host agent merges its notes itself and launches no subagent. Missing measurements remain unavailable. The report is not uploaded automatically. See [Optional session diagnostics](concepts.md#optional-session-diagnostics); cost estimates use the [`pricing` override](#override-rates-for-cost-estimates).

## Override rates for cost estimates

`diagnostics.md` prices token usage with the shipped table `references/pricing.json`; rendering reads no network resource. The optional `pricing` setting adds or replaces entries. An entry you leave out keeps its shipped rate.

```jsonc
{
  "pricing": {
    "lmstudio/qwen3.8-27b-ridge": { "rates": { "input": 0.1, "output": 0.2 } },
    "lmstudio/*": { "rates": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite5m": 0, "cacheWrite1h": 0 } },
    "my-model": {
      "rates": { "input": 0.5, "output": 2, "cacheRead": 0.05 },
      "tiers": [{ "abovePromptTokens": 100000, "rates": { "input": 1, "output": 4, "cacheRead": 0.1 } }],
      "periods": [{ "from": "2026-12-01", "rates": { "input": 1, "output": 4, "cacheRead": 0.1 } }]
    }
  }
}
```

- **Key:** an exact `route/model`, a `route/*` wildcard, or a generic model id without the route prefix or version suffix. Keys match without regard to case. An override replaces the shipped key of the same name.
- **`rates`:** USD per 1M tokens. `input` and `output` are required; `cacheRead`, `cacheWrite5m` and `cacheWrite1h` are optional. Each value is a number of 0 or more. List every counter rate that the model's route reports: usage with a nonzero counter that has no rate renders unpriced. A cache write that the source does not split by lifetime needs both `cacheWrite5m` and `cacheWrite1h`. Reasoning that a source reports apart from output (OpenCode and Antigravity) always bills at the output rate.
- **`tiers`:** optional. Each tier holds `abovePromptTokens` (a positive integer, ascending across tiers) and `rates` with the same keys as the base `rates`. A request whose prompt (uncached input, cache read and cache write) is above the threshold takes that tier's rates for all its tokens.
- **`periods`:** optional array of dated rate changes (`from`: `YYYY-MM-DD` UTC, ascending and unique; `rates` and optional `tiers` with the same shape as the base entry). Base `rates` and `tiers` apply before the first `from`; the latest period with `from` on or before the run's UTC start date applies (and a period without `tiers` has no tiers).

Dispatch matches each model id in this order:

1. For a qualified id, look up the exact `route/model`, including any reported suffix.
2. If the qualified id has no exact entry, look up `route/*`.
3. For a generic lookup, strip the route if present and remove any version suffix (`[1m]`, `@<date>`, `-v<n>:<n>` or `-YYYYMMDD`). Take the longest generic key that ends the id at its start or after `.`, `/` or `:`.

Usage sources that supply a bare model id use the generic lookup. OpenCode session data can supply the provider and model together. The report labels configured model fallbacks separately from reported models.

An id with no match is unpriced. For example, `bedrock.claude-opus-5-5`, `us.anthropic.claude-opus-5-5-v1:0` and `claude-opus-5-5@20261001` use the `claude-opus-5-5` rate, and `lmstudio/qwen3.8-27b-ridge` uses its exact entry above. Other qualified `lmstudio` models use `lmstudio/*`. Add a qualified entry when the observed route has partner-specific rates.

Dispatch ignores a malformed entry (unknown key, missing `input` or `output`, negative or non-numeric rate, tiers out of order or with different keys, or invalid/non-ascending `periods`). `doctor run` lists each one in `config.warnings`; the configuration stays valid and no launch is blocked. For the cost columns, tier ranges and cost reasons, see [`diagnostics render`](../toolkit.md#diagnostics-render).

## Provider-specific settings

<details>
<summary>Advanced provider settings</summary>

- `nativeSubagentsOnly: true` skips a provider CLI and uses that platform's native subagents when it matches the host declared with `--host`. On other platforms, those targets are skipped.
- OpenCode reads its selected native configuration, including `OPENCODE_CONFIG_DIR`; Dispatch does not copy inline settings into another provider's configuration.
- Doctor reports configured writer models without launching writers; it does not establish native capacity.

</details>
