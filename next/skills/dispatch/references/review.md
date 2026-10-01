# Review rules

The new CLI uses `start review`, `send`, and eight awaits; [the contract](..) owns that loop. Review kind is code, plan, or design; standalone review is report-only until `--fix` is requested.

Verify claims against the governing outcome and actual source. Accept demonstrated defects regardless of votes; reject unsupported claims with evidence. A user's recorded decision governs until a new defect demonstrates it must reopen. Intent conflicts require `needs-user`.

Rounds policy owns threshold, cap, uncapped MUST findings, convergence, affinity, and full/delta/disputes-only scope. Reply to every pending finding through `RULINGS`; rejected disputed findings carry their reason into the next round. Omitted prior disputes may settle by acceptance. Below-threshold closure requires host evidence. At the cap, changed accepted fixes may be reported `fixedUnreviewed`; do not claim a new review occurred.

For `--fix`, apply only accepted clusters within their bounded paths and verification. `CONSIDER` items and verified adjacent findings enter one opt-in decision after the main scope settles. Report unaccepted adjacent findings as follow-ups. Native and provider reports share one parser; missing coverage, refusal, truncation, empty output, and loose loci trigger fallback per [providers](providers.md).
