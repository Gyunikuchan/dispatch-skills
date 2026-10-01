# Configuration

Copy `config.sample.jsonc` at the skill root to `config.local.jsonc` or `config.jsonc`. The first existing candidate loads wholly, without merging; sample config is a validation reference. `read-delegates` defines provider target level maps, `write-subagents` defines native writers, and `phases` defines target breadth and round caps.

Sparse levels use the nearest defined lower level, then the lowest higher level. Pins override breadth; model/effort overrides collapse each provider to its first target. Use `doctor --json` to inspect effective membership, order, resolution, writers, config errors, and predicted sandbox support. See [providers](../providers.md) for explicit sandbox opt-outs and native mapping.
