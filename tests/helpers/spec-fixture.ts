// Shared governing-spec fixture for end-to-end sessions.

/** A spec that lints clean at every level. */
export const SPEC_SOURCE = [
  '# Fixture spec', '', '> **Status:** approved', '> **Level:** medium', '',
  '## Intent & Problem', 'Exercise the governed flow.', '',
  '## Background', 'Fixture context.', '',
  '## Requirements', '### REQ-1 — Fixture behavior', '- Acceptance: the flow settles.', '',
  '## Non-goals', '- None.', '',
  '## Constraints', '- Portable.', '',
  '## Decisions', '### DEC-1 — Fixture choice', '- Choice: keep it small.', '',
  '## Discussion Record', '- Agreed.', '',
  '## Open Questions', '- None.', '',
].join('\n');
