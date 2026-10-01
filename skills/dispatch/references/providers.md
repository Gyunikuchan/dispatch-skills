# Providers

Run `doctor [--level L] [--json]` before diagnosing config, executable discovery, level resolution, target order, phase policies, writers, integrity, or sandbox support. CLI, desktop, and VS Code candidates come from declarative specs; authenticate outside dispatch. Direct single-provider dispatch is `start ask --provider P`.

Read delegates use provider-specific read-only flags, credential stripping, sensitive-file guards, bounded output, and timeouts. Sandbox defaults on for supported providers. `sandbox-unsupported` fails the slot; choosing `sandbox: false` in config is the explicit opt-out. Modes and model arrays cascade within one voice; exhausted voices use unused reserves once per wave, then same-platform native fallback, or a named failure. Per-provider resume handles accompany successful captures.

For `native`, preserve each descriptor's `sourceKey`, `agentType`, `model`, `reasoningEffort`, `substitutesFor`, `cascadePosition`, `modelCascade`, prompt/output paths, and attachments. Match the host's actual native model to [native model mappings](native-model-mappings.json); report the mapping with the capture. Failed mapping availability may advance the cascade. Capture every listed slot before one `NATIVE_RESULTS` reply; the driver reconciles every target and parses native and CLI reports uniformly.

The detached internal worker publishes an exclusive claim before launching slots, then heartbeat, per-slot outcomes, and completion. Recover through `status` and eventless `send`; a live same-host claim reattaches, a dead/stale claim is fenced, and a foreign-host claim faults. See [the contract](..) for the host loop.
