# implement-dispatch maintainer notes

`implement-dispatch` is a user-invoked compatibility alias. It contains no workflow logic: arguments map to `dispatch ... implement:` and a missing `dispatch` produces a named diagnostic.

Maintain implementation behavior in `skills/dispatch/scripts/driver/`, the action schemas, and `skills/dispatch/references/verbs/implement.md`. Maintain design increments in `references/verbs/design.md`. The single config lives under `skills/dispatch/`; v0.4 sibling configs are rejection inputs only.
