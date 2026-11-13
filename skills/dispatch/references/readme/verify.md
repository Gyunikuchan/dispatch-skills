# Verify

Use `/dispatch verify: <target>` to run deterministic checks and exercise delivered behaviour at runtime against its governing intent. The stage runs in two layers: checks first (`check run` when a bound plan and session integration exist, or the repository's own test command as a baseline), then runtime verification by the verifier subagent. Implement runs this stage after integrated checks and before test cleanup; after review settles it re-checks proved behaviour changed by accepted review fixes.

Proof and artifacts live under the session's `verification/report.md` and `verification/`; the walkthrough links them. The report records claims (including any baseline row), methods, results, evidence and limits. When nothing runnable can be proved, a recorded no-op explains why. Missing tools are a limit; Dispatch does not install them.

For approval rules on actions that change persistent or shared state, send messages, incur charges or use non-local environments, see [the verify guide](../verbs/verify.md).

Optionally, add a `## Verification` section to your host rule file for repository-specific guidance covering launch, health check, drive, evidence and cleanup, for example:

```markdown
## Verification
- **Launch:** Start the local service with the repository's documented boot command and wait until it accepts requests.
- **Health check:** Query the read-only status endpoint before driving any scenario.
- **Drive:** Exercise the documented user workflow using the disposable test account from the setup guide.
- **Evidence:** Save logs and captured responses in the session's verification directory.
- **Cleanup:** Stop only the instance started for this run while keeping captured evidence intact.
```
