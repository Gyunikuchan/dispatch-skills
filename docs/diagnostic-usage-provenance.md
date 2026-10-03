# Diagnostic usage fixture provenance

Extracted from existing dispatch review logs recorded on 2026-10-01. No new provider invocation was made. Each JSON fixture records the full source log's SHA-256 and the CLI version found in that log; response text, tool output, session IDs, paths, prices and account metadata were removed.

- Codex 0.156.1: final `turn.completed.usage` counters. Input includes cache-read tokens; reasoning is a subset of output. Only one completed turn is supported. Repeated identical summaries are deduplicated; distinct multi-turn scopes are unavailable.
- Claude Code 2.1.268: a failed model launch with a recorded auxiliary Haiku call. `usage` is zero for the main loop; `modelUsage` records whole-tree usage by model. Input/cache fields are disjoint. Whole-tree counters take precedence and are never added to main-loop counters. Resumed calls are unavailable because counters may include prior spend.

The [Claude usage contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking) describes main-loop versus whole-tree scope and cumulative resumed results. Fixtures preserve failures deliberately: a failed requested model is not evidence of zero token consumption.
