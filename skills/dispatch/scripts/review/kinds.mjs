// @ts-check
/**
 * Single registry of review kinds: everything preparation and parsing vary by kind (tags, locus
 * rules, template and schema paths, lint, checkpoint metadata) lives here so the shared
 * prepare/parse modules stay kind-agnostic.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintDesign } from '../design/lint.mjs';
import { lintPlan } from '../plan/lint.mjs';
import { lintWalkthrough } from '../walkthrough/lint.mjs';

// SECTION: Shared kind data

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'references', 'templates');
const template = (name) => path.join(TEMPLATES_DIR, name);

export const KIND_NAMES = Object.freeze(['plan', 'code', 'design']);
export const KIND_USAGE = KIND_NAMES.join('|');

const SECTION_LOCUS_PATTERN = /^§\s+\S.*$/;

const PLAN_TAGS = new Set([
  'adjacent', 'approach', 'architecture', 'auth', 'blast-radius', 'coherence', 'compatibility',
  'correctness', 'domain-logic', 'edge-case', 'intent', 'invariant', 'migration',
  'partial-failure', 'perf', 'race', 'rollback', 'scope-creep', 'security', 'simplicity',
  'spec-gap', 'standards', 'state-machine', 'testability', 'user-gap', 'validation',
  'verification', 'yagni',
]);

const CODE_TAGS = new Set([
  'a11y', 'adjacent', 'auth', 'breaking', 'compatibility', 'correctness', 'coupling',
  'domain-logic', 'edge-case', 'intent', 'invariant', 'migration', 'partial-failure', 'perf',
  'race', 'resource-leak', 'reuse', 'root-cause', 'runtime', 'scope-creep', 'seam', 'security',
  'shallow', 'standards', 'test-gap', 'test-leak', 'type', 'ui', 'yagni',
]);

const DESIGN_TAGS = new Set([
  'architecture', 'boundaries', 'interfaces', 'data-flow', 'alternatives', 'security',
  'operations', 'migration', 'rollback', 'risk', 'graph-correctness', 'parallel-safety',
  'integration', 'compatibility', 'correctness', 'simplicity', 'verification', 'scope-creep',
  'adjacent',
]);

// SECTION: Metadata policies

/** Builds common checkpoint metadata; design adds approval continuity separately. */
function documentMetadata(kind) {
  return ({ slug, invocationId, snapshot, now }) => ({
    schemaVersion: 1,
    kind,
    slug,
    invocationId,
    contentHash: snapshot.contentHash,
    sectionHashes: snapshot.sectionHashes,
    reviewedAt: now.toISOString(),
  });
}

function designMetadata({ slug, invocationId, snapshot, previous, now }) {
  const approvalMatches = previous?.approvedContentHash === snapshot.contentHash;
  return {
    ...documentMetadata('design')({ slug, invocationId, snapshot, now }),
    approvedContentHash: approvalMatches ? previous.approvedContentHash : null,
    approvedAt: approvalMatches ? previous.approvedAt : null,
  };
}

// SECTION: Kind registry

export const REVIEW_KINDS = Object.freeze({
  plan: Object.freeze({
    kind: 'plan',
    artifactKind: 'plan',
    tags: PLAN_TAGS,
    locusPattern: SECTION_LOCUS_PATTERN,
    locusDescription: '"§ <Plan heading>"',
    promptBlock: template('review-prompt-plan.md'),
    rebuttalBlock: template('rebuttal-plan.md'),
    reportSchema: template(path.join('schemas', 'report-plan.json')),
    rebuttalSchema: template(path.join('schemas', 'rebuttal.json')),
    lint: (source) => lintPlan(source),
    lintLabel: 'Plan lint warnings',
    lintDecision: 'plan-lint',
    excludedSections: [],
    pathVariable: 'Plan Path',
    fallbackRequirement: 'Review the plan',
    acceptsDesignContext: true,
    metadata: documentMetadata('plan'),
  }),
  code: Object.freeze({
    kind: 'code',
    artifactKind: 'code',
    tags: CODE_TAGS,
    locusPattern: /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^:\\\r\n]+:L[1-9]\d*$/,
    locusDescription: '"<relative-file>:L<line>"',
    promptBlock: template('review-prompt-code.md'),
    rebuttalBlock: template('rebuttal-code.md'),
    reportSchema: template(path.join('schemas', 'report-code.json')),
    rebuttalSchema: template(path.join('schemas', 'rebuttal.json')),
    // One-argument internal consistency; completeness against plan criteria is prepareCodeReview's and the driver's.
    lint: lintWalkthrough,
    lintDecision: 'walkthrough-lint',
    acceptsDesignContext: true,
  }),
  design: Object.freeze({
    kind: 'design',
    artifactKind: 'design',
    tags: DESIGN_TAGS,
    locusPattern: SECTION_LOCUS_PATTERN,
    locusDescription: '"§ <Design heading>"',
    promptBlock: template('review-prompt-design.md'),
    rebuttalBlock: template('rebuttal-design.md'),
    reportSchema: template(path.join('schemas', 'report-design.json')),
    rebuttalSchema: template(path.join('schemas', 'rebuttal.json')),
    // design-lint reports only blocking diagnostics; normalize to the plan-lint shape.
    lint: (source) => ({ defects: lintDesign(source).diagnostics, warnings: [] }),
    lintLabel: 'Design lint warnings',
    lintDecision: 'design-lint',
    excludedSections: ['Execution Status'],
    pathVariable: 'Design Path',
    fallbackRequirement: 'Review the design',
    acceptsDesignContext: false,
    metadata: designMetadata,
  }),
});

export const PROMPT_FRAME = template('review-prompt.md');
export const REBUTTAL_FRAME = template('rebuttal.md');

/** Returns the registry entry for `name`; throws naming the supported kinds. */
export function reviewKind(name) {
  const entry = Object.hasOwn(REVIEW_KINDS, name ?? '') ? REVIEW_KINDS[name] : null;
  if (!entry) throw new Error(`--kind must be one of ${KIND_USAGE}${name ? ` (got "${name}")` : ''}.`);
  return entry;
}
