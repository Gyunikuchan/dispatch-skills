// Sections and per-increment details that design-lint requires beyond the dependency graph.
const FIELDS = ['Outcome', 'Scope', 'Non-scope', 'Observable behavior', 'Affected contracts', 'Validation', 'Rollback boundary', 'Parallel safety'];

export function designExtras(ids) {
  const details = ids.map(id => [`### ${id}`, ...FIELDS.map(field => `- ${field}: x`)].join('\n')).join('\n');
  return `\n## Context & Intent\nx\n## Goals & Requirements\nx\n## Increment Details\n${details}\n## Final Integration\nx\n`;
}
