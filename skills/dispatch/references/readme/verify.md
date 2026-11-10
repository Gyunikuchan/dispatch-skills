# Verify

Use `/dispatch verify: <target>` to exercise delivered behaviour against its governing intent. Implement runs this stage after integrated checks and before test cleanup; after review settles it re-checks proved behaviour changed by accepted review fixes.

Proof and artifacts live under the session's `verification/report.md` and `verification/`; the walkthrough links them. The report records claims, methods, results, evidence and limits. When nothing runnable can be proved, a recorded no-op explains why. Missing tools are a limit; Dispatch does not install them.

The verifier completes unblocked checks before requesting approval for actions that change persistent or shared state, send messages, incur charges or use non-local environments. Declined checks remain not proved.

Add a `Verification` section to your host rule file for repository-specific guidance, for example:

```markdown
## Verification
Start the local service with the repository's documented boot command. Use the disposable test account described in the team setup guide.
```
