// @ts-check

import { parseIncrementGraph } from './graph.mjs';

const REQUIRED_SECTIONS = [
  'Context & Intent',
  'Goals & Requirements',
  'Architecture & Boundaries',
  'Alternatives & Decisions',
  'Risks, Security & Operations',
  'Increment Dependency Graph',
  'Increment Details',
  'Final Integration',
];
const INCREMENT_FIELDS = [
  'Outcome',
  'Scope',
  'Non-scope',
  'Observable behavior',
  'Affected contracts',
  'Validation',
  'Rollback boundary',
  'Parallel safety',
];
const INCREMENT_DETAILS_HEADING = /^##\s+Increment Details\s*$/;
const SECTION_HEADING = /^##\s/;
const INCREMENT_HEADING = /^###\s+(I\d{2})\b/;

// SECTION: Detail parsing

/**
 * Maps each increment heading to the lines in its detail block.
 * @param {string} source
 * @returns {Map<string, string[]>}
 */
function incrementDetails(source) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex(line => INCREMENT_DETAILS_HEADING.test(line));
  /** @type {Map<string, string[]>} */
  const blocks = new Map();
  if (start === -1) return blocks;

  /** @type {string | null} */
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (SECTION_HEADING.test(line)) break;
    const heading = INCREMENT_HEADING.exec(line);
    if (heading) {
      current = heading[1];
      blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current)?.push(line);
  }
  return blocks;
}

// SECTION: Public API

/**
 * Validates required sections, increment details, and the dependency graph.
 * @param {string} source
 */
export function lintDesign(source) {
  const diagnostics = [];
  for (const heading of REQUIRED_SECTIONS) {
    const escapedHeading = heading.replace(/[&]/g, '\\&');
    if (!new RegExp(`^##\\s+${escapedHeading}\\s*$`, 'm').test(source)) {
      diagnostics.push({ code: 'missing-section', heading });
    }
  }

  const graph = parseIncrementGraph(source);
  const details = incrementDetails(source);
  for (const { id } of graph.increments) {
    const block = details.get(id);
    if (!block) {
      diagnostics.push({ code: 'missing-increment-details', id });
      continue;
    }
    for (const field of INCREMENT_FIELDS) {
      const pattern = new RegExp(`^\\s*[-*]\\s+${field}:\\s*\\S`, 'i');
      if (!block.some(line => pattern.test(line))) {
        diagnostics.push({ code: 'missing-increment-field', id, field });
      }
    }
  }

  const merged = [...diagnostics, ...graph.diagnostics];
  const increments = graph.increments.map(({ id, priority, prerequisites }) => ({ id, priority, prerequisites }));
  return { valid: merged.length === 0, diagnostics: merged, increments };
}
