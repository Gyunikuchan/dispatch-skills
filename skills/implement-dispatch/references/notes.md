# implement-dispatch Maintainer Notes

Developer documentation, test harness hooks, and internal maintainer notes. Not loaded by agents during normal execution.

---

## 1. Test Harness Environment Hooks

### Liveness Override (`IMPLEMENT_DISPATCH_LIVENESS_JSON`)

Replaces the flow resolver's real provider probing with a literal JSON map (e.g. `{ "claude": true, "agy": false, "copilot": true, "opencode": false }`), allowing integration and unit tests to simulate arbitrary provider availability without spawning external CLI processes.

- **Safety Guard**: Armed only when `IMPLEMENT_DISPATCH_TEST_MODE=1` is set alongside it. Setting the JSON map alone throws an error explicitly naming both variables to prevent accidental test-state inheritance in production runs.
- **Diagnostics**: A run using this override sets `flow.diagnostics.livenessSource: "env-override"`; real runs report `"probe"`.

---

## 2. Integrity Gate Behavior

The flow resolver verifies its own files against `skill-hashes.json` before loading configuration:
- A missing `skill-hashes.json` prints a warning and proceeds.
- A modified `SKILL.md` or script aborts execution with a list of modified files. Regenerate hashes with `npm run hashes` in development.
