import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { extractTemplate } from '../../skills/dispatch/scripts/fill-template.mjs';
import {
  CODE_LOCUS_PATTERN,
  CODE_TAGS,
} from '../../skills/dispatch-code-review/scripts/parse-report.mjs';
import {
  PLAN_LOCUS_PATTERN,
  PLAN_TAGS,
} from '../../skills/dispatch-plan-review/scripts/parse-report.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PLAN_REVIEW_PATH = 'skills/dispatch-plan-review/SKILL.md';
const CODE_REVIEW_PATH = 'skills/dispatch-code-review/SKILL.md';
const PLAN_PROMPT_PATH = 'skills/dispatch-plan-review/references/prompt-template.md';
const CODE_PROMPT_PATH = 'skills/dispatch-code-review/references/prompt-template.md';
const PLAN_REVIEW_README_PATH = 'skills/dispatch-plan-review/README.md';
const CODE_REVIEW_README_PATH = 'skills/dispatch-code-review/README.md';
const PLAN_SCHEMA_PATH = 'skills/dispatch-plan-review/references/report-schema.json';
const CODE_SCHEMA_PATH = 'skills/dispatch-code-review/references/report-schema.json';
const PLAN_REBUTTAL_PATH = 'skills/dispatch-plan-review/references/rebuttal-template.md';
const CODE_REBUTTAL_PATH = 'skills/dispatch-code-review/references/rebuttal-template.md';
const PLAN_REBUTTAL_SCHEMA_PATH = 'skills/dispatch-plan-review/references/rebuttal-schema.json';
const CODE_REBUTTAL_SCHEMA_PATH = 'skills/dispatch-code-review/references/rebuttal-schema.json';
const ALIGNMENT_PATH = 'skills/dispatch/references/alignment.md';
const IMPLEMENT_PATH = 'skills/implement-dispatch/SKILL.md';
const FILL_TEMPLATE_SCRIPT = path.join(REPO_ROOT, 'skills', 'dispatch', 'scripts', 'fill-template.mjs');

/**
 * Each review skill owns its delegate-facing prompt template in its own
 * `references/prompt-template.md` (not pushed into `dispatch`, which keeps skills
 * downward-independent), so an external delegate still reads one self-contained
 * prompt. This suite is the drift guard for the duplication between the two: it
 * extracts the pieces that are supposed to be identical wording and asserts they
 * match, modulo a small declared substitution map for the wording that is
 * legitimately different (plan vs. code terminology). Anything not covered by the
 * map must match verbatim.
 */

function readSkill(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function extractJsonExamples(text) {
  return [...text.matchAll(/```json\n(.+?)\n```/gs)].map((match) => JSON.parse(match[1]));
}

/** Extracts the backtick-quoted re-review template following "On a re-review,". */
function extractReReviewTemplate(text) {
  const anchor = 'On a re-review,';
  const at = text.indexOf(anchor);
  assert.ok(at !== -1, 're-review anchor sentence not found');
  const after = text.slice(at + anchor.length);
  const match = after.match(/`([^`]+)`/);
  assert.ok(match, 're-review backtick-quoted template not found');
  return match[1];
}

/** Normalizes the re-review template's plan/code-specific locus wording to shared placeholders. */
function normalizeReReviewTemplate(template) {
  return template
    .replace('in sections changed', 'SCOPE changed')
    .replace('on lines changed', 'SCOPE changed')
    .replace('<changed sections>', '<changed SCOPE>')
    .replace('<changed paths>', '<changed SCOPE>');
}

/** Extracts the "stop at that blast radius" inspection-bound sentence. */
function extractBlastRadiusBound(text) {
  const match = text.match(/Stop at that\s+blast\s+radius\./);
  assert.ok(match, 'blast-radius bound sentence not found');
  return match[0];
}

const CONVENTIONS_LINE = /Adhere to this project's conventions\s+\(read `AGENTS\.md` \/ `CLAUDE\.md` from the workspace\)/;

/** Extracts compact `- check: `tag`, ...` groups from a prompt template. */
function extractPromptTags(text) {
  return [...text.matchAll(/^- [^:\n]+: ((?:`[^`]+`,?\s*)+)$/gm)]
    .flatMap(([, tags]) => [...tags.matchAll(/`([^`]+)`/g)].map((match) => match[1]))
    .sort();
}

/** Extracts `| **<Axis>** | \`tag\`, ... |` table rows from a README's axis table. */
function extractReadmeAxes(text) {
  return [...text.matchAll(/^\| \*\*([^*]+)\*\* \| ((?:`[^`]+`,?\s*)+)\|/gm)].map(([, axis, tags]) => ({
    axis: axis.trim(),
    tags: [...tags.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  }));
}

describe('review skill prompt template parity', () => {
  const planText = readSkill(PLAN_PROMPT_PATH);
  const codeText = readSkill(CODE_PROMPT_PATH);

  it('neither template names `.claude/CLAUDE.md` (host-agnostic convention path)', () => {
    assert.ok(!planText.includes('.claude/CLAUDE.md'), `${PLAN_PROMPT_PATH} still references .claude/CLAUDE.md`);
    assert.ok(!codeText.includes('.claude/CLAUDE.md'), `${CODE_PROMPT_PATH} still references .claude/CLAUDE.md`);
  });

  it('both templates read the same conventions line', () => {
    assert.match(planText, CONVENTIONS_LINE, `${PLAN_PROMPT_PATH} missing shared conventions line`);
    assert.match(codeText, CONVENTIONS_LINE, `${CODE_PROMPT_PATH} missing shared conventions line`);
  });

  it('shares the structured report shape modulo locus examples', () => {
    const normalize = (record) => ({
      ...record,
      findings: record.findings.map((finding) => ({ ...finding, locus: '<LOCUS>' })),
    });
    const planRecords = extractJsonExamples(planText).map(normalize);
    const codeRecords = extractJsonExamples(codeText).map(normalize);
    assert.deepEqual(planRecords, codeRecords);
    assert.deepEqual(Object.keys(planRecords[0]).sort(), ['findings', 'status']);
    assert.deepEqual(
      Object.keys(planRecords[1].findings[0]).sort(),
      ['defect', 'locus', 'requiredChange', 'severity', 'tag'],
    );
  });

  it('requires one schema-constrained object and findings only when status is FINDINGS', () => {
    for (const [rel, text] of [[PLAN_PROMPT_PATH, planText], [CODE_PROMPT_PATH, codeText]]) {
      assert.match(text, /Return only the schema-constrained JSON object/);
      assert.match(text, /Otherwise use status `FINDINGS` and one or more findings with every field/);
      assert.doesNotMatch(text, /Axis Coverage|## Verdict|Actionable Next Steps|## Shorter Path/);
      assert.equal(extractJsonExamples(text).length, 2, `${rel} must declare clean and finding examples`);
    }
  });

  it('share the re-review scope template modulo section/line wording', () => {
    const planTemplate = normalizeReReviewTemplate(extractReReviewTemplate(planText));
    const codeTemplate = normalizeReReviewTemplate(extractReReviewTemplate(codeText));
    assert.equal(planTemplate, codeTemplate);
  });

  it('carries one advisory Tool Turn Budget target', () => {
    for (const text of [planText, codeText]) {
      const { template } = extractTemplate(text);
      assert.equal(template.match(/<Tool Turn Budget>/g)?.length, 1);
      assert.match(template, /one advisory target/);
      assert.match(template, /8 \+ 2 ×/);
      assert.match(template, /Stop early/);
      assert.match(template, /Exceed it only for a\s+named in-scope risk supported by evidence/);
    }
  });

  it('both bound inspection with a parallel "stop at that blast radius" sentence', () => {
    assert.ok(extractBlastRadiusBound(planText));
    assert.ok(extractBlastRadiusBound(codeText));
  });
});

describe('review skill templates live in references/', () => {
  for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
    it(`${skillPath}: SKILL.md no longer inlines a fenced template`, () => {
      const text = readSkill(skillPath);
      assert.ok(!text.includes('````'), `${skillPath} still contains a 4-backtick template fence`);
      assert.throws(() => extractTemplate(text), /not found/);
      assert.ok(text.includes('references/prompt-template.md'), `${skillPath} does not point at references/prompt-template.md`);
    });
  }

  it('extracts declared variables and an intact template from dispatch-plan-review', () => {
    const { variables, template } = extractTemplate(readSkill(PLAN_PROMPT_PATH));
    assert.deepEqual(variables, ['Plan Path', 'Requirement', 'User Focus Areas', 'Review Scope', 'Tool Turn Budget']);
    assert.ok(template.includes('<Plan Path>'));
    assert.ok(template.includes('### Context'));
  });

  it('extracts declared variables and an intact template from dispatch-code-review', () => {
    const { variables, template } = extractTemplate(readSkill(CODE_PROMPT_PATH));
    assert.deepEqual(variables, [
      'Task Summary',
      'Walkthrough Path',
      'Plan Path',
      'User Focus Areas',
      'Review Scope',
      'Tool Turn Budget',
    ]);
    assert.ok(template.includes('<Walkthrough Path>'));
  });

  it('preserves inner fenced code blocks inside the outer 4-backtick fence', () => {
    const { template } = extractTemplate(readSkill(CODE_PROMPT_PATH));
    // An inner ``` fence surviving proves the scanner closed on the matching (>=4-backtick) fence.
    assert.ok(/```/.test(template), 'expected an inner fence to survive extraction');
  });

  // Both templates go through the spawned CLI, not just the in-process reader: --skill resolution
  // and the integrity gate that must fail closed on hash drift are only exercised on this path.
  for (const [label, templatePath, expected] of [
    [
      'code-review',
      CODE_PROMPT_PATH,
      ['Task Summary', 'Walkthrough Path', 'Plan Path', 'User Focus Areas', 'Review Scope', 'Tool Turn Budget'],
    ],
    [
      'plan-review',
      PLAN_PROMPT_PATH,
      ['Plan Path', 'Requirement', 'User Focus Areas', 'Review Scope', 'Tool Turn Budget'],
    ],
  ]) {
    it(`fill-template --list reads the ${label} references file`, () => {
      const result = cp.spawnSync(process.execPath, [FILL_TEMPLATE_SCRIPT, '--skill', path.join(REPO_ROOT, templatePath), '--list'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
    });
  }

  it('review skills use the canonical shell-safe fill-template transport', () => {
    for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      const skill = readSkill(skillPath);
      assert.match(skill, /canonical\s+stdin\/temp-output protocol/);
      assert.match(skill, /--vars - --temp-out/);
      assert.doesNotMatch(skill, /--vars <json file>.*--out <path>/s);
    }
  });

  it('review skills require their native response schema', () => {
    for (const [skillPath, schemaPath] of [
      [PLAN_REVIEW_PATH, PLAN_SCHEMA_PATH],
      [CODE_REVIEW_PATH, CODE_SCHEMA_PATH],
    ]) {
      const skill = readSkill(skillPath);
      assert.match(skill, new RegExp(`--response-schema-file \"<skills-dir>/${schemaPath.slice('skills/'.length)}\"`));
    }
  });
});

describe('review response schemas', () => {
  for (const [kind, schemaPath, tags, locusPattern] of [
    ['plan', PLAN_SCHEMA_PATH, PLAN_TAGS, PLAN_LOCUS_PATTERN],
    ['code', CODE_SCHEMA_PATH, CODE_TAGS, CODE_LOCUS_PATTERN],
  ]) {
    it(`${kind} schema matches parser tags and report fields`, () => {
      const schema = JSON.parse(readSkill(schemaPath));
      assert.deepEqual(schema.required, ['status', 'findings']);
      assert.equal(schema.additionalProperties, false);
      const finding = schema.properties.findings.items;
      assert.deepEqual(
        finding.required,
        ['severity', 'locus', 'tag', 'defect', 'requiredChange'],
      );
      assert.equal(finding.additionalProperties, false);
      assert.deepEqual([...finding.properties.tag.enum].sort(), [...tags].sort());
      assert.equal(new RegExp(finding.properties.locus.pattern).source, locusPattern.source);
      const manifestPath = `skills/dispatch-${kind}-review/skill-hashes.json`;
      const manifest = JSON.parse(readSkill(manifestPath));
      assert.ok(
        'references/report-schema.json' in manifest,
        `${manifestPath} must integrity-check its response schema`,
      );
    });
  }
});

describe('orchestrated handover contract', () => {
  it('alignment detection names targets; review skills and implement-dispatch use "targets"; implement-dispatch no longer fills templates', () => {
    const alignment = readSkill(ALIGNMENT_PATH);
    const modes = alignment.slice(alignment.indexOf('## Invocation Modes'), alignment.indexOf('## Prompt Template Filling'));
    assert.match(modes, /Detection:[^\n]*\*\*targets\*\*/, `${ALIGNMENT_PATH} § Invocation Modes detection does not name targets`);
    assert.match(modes, /`Review Mode: full\|rebuttal`/);
    assert.match(modes, /candidateId/);

    for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      assert.match(readSkill(skillPath), /\*\*targets\*\* list/, `${skillPath} mode detection does not name the targets list`);
    }

    const implement = readSkill(IMPLEMENT_PATH);
    assert.ok(implement.includes('`targets`'), `${IMPLEMENT_PATH} does not hand over targets`);
    assert.ok(!implement.includes('fill-template'), `${IMPLEMENT_PATH} still instructs fill-template`);
    assert.ok(!implement.includes('--prompt-file'), `${IMPLEMENT_PATH} still instructs --prompt-file`);
  });

  it('the handover carries consensus, and pending rebuttals are a logged form in every consumer', () => {
    const alignment = readSkill(ALIGNMENT_PATH);
    const modes = alignment.slice(alignment.indexOf('## Invocation Modes'), alignment.indexOf('## Prompt Template Filling'));
    assert.match(modes, /Detection:[^\n]*`consensus: true\|false`/, `${ALIGNMENT_PATH} detection does not hand over consensus`);
    assert.ok(!modes.includes('not already in the wave'), `${ALIGNMENT_PATH} still prefers platform diversity at substitution`);

    const adjudication = alignment.slice(alignment.indexOf('## Adjudication'), alignment.indexOf('## Resolutions Log'));
    assert.ok(
      adjudication.includes('normalized `MUST` /') &&
        adjudication.includes('`SHOULD` findings (legacy MUST-FIX / SHOULD-FIX)'),
      `${ALIGNMENT_PATH} § Finality does not map normalized severity to legacy finality`
    );
    assert.ok(
      adjudication.includes('Normalized and legacy `CONSIDER` findings are advisory and final'),
      `${ALIGNMENT_PATH} § Finality does not state CONSIDER finality`
    );

    const log = alignment.slice(alignment.indexOf('## Resolutions Log'));
    assert.ok(log.includes('**[Rejected — pending confirmation]**'), `${ALIGNMENT_PATH} Resolutions Log lacks the pending form`);
    assert.ok(log.includes('[MUST|SHOULD|CONSIDER]'), `${ALIGNMENT_PATH} Resolutions Log lacks structured severity`);
    assert.ok(log.includes('Legacy lines remain readable'), `${ALIGNMENT_PATH} lacks legacy log compatibility`);
    assert.ok(log.includes('`<tag> (CONSIDER)`'), `${ALIGNMENT_PATH} lacks legacy CONSIDER compatibility`);
    assert.ok(log.includes('`ACTIONABLE`'), `${ALIGNMENT_PATH} lacks ACTIONABLE compatibility`);

    for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      const content = readSkill(skillPath);
      assert.ok(content.includes('[Rejected — pending confirmation]'), `${skillPath} does not name the pending form`);
      assert.ok(
        content.includes('`MUST`/`SHOULD`'),
        `${skillPath} does not scope pending form to MUST/SHOULD`
      );
    }

    const implement = readSkill(IMPLEMENT_PATH);
    assert.ok(implement.includes('consensus: true|false'), `${IMPLEMENT_PATH} does not hand over consensus`);
    assert.ok(implement.includes('check-consensus.mjs'), `${IMPLEMENT_PATH} does not gate on check-consensus.mjs`);
    assert.ok(implement.includes('--exclude'), `${IMPLEMENT_PATH} does not re-resolve with --exclude`);
    assert.ok(
      implement.includes('rejection/downgrade of `MUST` or `SHOULD`'),
      `${IMPLEMENT_PATH} does not scope pending rejections to MUST/SHOULD`
    );
    assert.match(
      implement,
      /`CONSIDER`\s+follows `dispatch`'s `references\/alignment\.md` § Finality/,
      `${IMPLEMENT_PATH} does not reference alignment.md § Finality for CONSIDER findings`,
    );
  });
});

describe('rebuttal contract parity', () => {
  it('uses the same response envelope, variables, and schema in both review skills', () => {
    const plan = readSkill(PLAN_REBUTTAL_PATH);
    const code = readSkill(CODE_REBUTTAL_PATH);
    const planExample = extractJsonExamples(plan)[0];
    const codeExample = extractJsonExamples(code)[0];
    assert.deepEqual(planExample, codeExample);
    assert.deepEqual(Object.keys(planExample), ['responses']);
    assert.deepEqual(
      Object.keys(planExample.responses[0]).sort(),
      ['evidence', 'key', 'type', 'verdict'],
    );
    for (const template of [plan, code]) {
      assert.match(template, /<Finding Packet Path>/);
      assert.match(template, /CONFIRM\|REBUT\|INTENT-DISPUTE/);
    }
    const planSchema = JSON.parse(readSkill(PLAN_REBUTTAL_SCHEMA_PATH));
    const codeSchema = JSON.parse(readSkill(CODE_REBUTTAL_SCHEMA_PATH));
    assert.deepEqual(planSchema, codeSchema);
    assert.deepEqual(planSchema.required, ['responses']);
    assert.equal(planSchema.additionalProperties, false);
    assert.deepEqual(
      planSchema.properties.responses.items.properties.verdict.enum,
      ['CONFIRM', 'REBUT', 'INTENT-DISPUTE'],
    );
  });
});

describe('review skill axis/tag parity: prompt template vs README.md', () => {
  it('dispatch-plan-review: compact prompt tags match the disclosed README rubric', () => {
    const promptTags = extractPromptTags(readSkill(PLAN_PROMPT_PATH));
    const readmeTags = extractReadmeAxes(readSkill(PLAN_REVIEW_README_PATH)).flatMap(({ tags }) => tags).sort();
    assert.ok(promptTags.length > 0, `${PLAN_PROMPT_PATH} defines no review tags`);
    assert.deepEqual(readmeTags, promptTags);
    assert.deepEqual([...PLAN_TAGS].sort(), promptTags);
  });

  it('dispatch-code-review: compact prompt tags match the disclosed README rubric', () => {
    const promptTags = extractPromptTags(readSkill(CODE_PROMPT_PATH));
    const readmeTags = extractReadmeAxes(readSkill(CODE_REVIEW_README_PATH)).flatMap(({ tags }) => tags).sort();
    assert.ok(promptTags.length > 0, `${CODE_PROMPT_PATH} defines no review tags`);
    assert.deepEqual(readmeTags, promptTags);
    assert.deepEqual([...CODE_TAGS].sort(), promptTags);
  });
});

// ---------------------------------------------------------------------------
// SECTION: Cross-skill prose contracts
//
// These headings and counts are duplicated across skills as prose, so nothing but
// a test stops them drifting apart. Each case below pins one such duplication.
// ---------------------------------------------------------------------------

const PLAN_TEMPLATE_PATH = 'skills/dispatch-plan-review/references/plan-template.md';
const WALKTHROUGH_TEMPLATE_PATH = 'skills/dispatch-code-review/references/walkthrough-template.md';

/** Returns the fenced example block of a plan/walkthrough template file. */
function templateBody(rel) {
  const match = readSkill(rel).match(/^````+markdown\n(.*?)\n````+/ms);
  assert.ok(match, `${rel} has no fenced template block`);
  return match[1];
}

/** Collects the `## ` headings declared inside a template file's fenced example block. */
function extractTemplateHeadings(rel) {
  return [...templateBody(rel).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}

describe('cross-skill prose contracts', () => {
  it('every plan section dispatch-plan-review Step 3 names is a plan-template heading', () => {
    const headings = extractTemplateHeadings(PLAN_TEMPLATE_PATH);
    const step3 = readSkill(PLAN_REVIEW_PATH);
    const at = step3.indexOf('### 3. Fold findings into the plan');
    assert.ok(at !== -1, 'plan-review Step 3 heading not found');
    const section = step3.slice(at);

    // Step 3 folds accepted findings into named sections; a name the template lacks folds nowhere.
    for (const named of ['Proposed Changes', 'Verification Plan', 'Rollback & Blast Radius', 'Out of Scope', 'Review Findings & Resolutions']) {
      if (!section.includes(named)) continue;
      assert.ok(
        headings.includes(named),
        `plan-review Step 3 folds into "${named}", absent from ${PLAN_TEMPLATE_PATH}`,
      );
    }
  });

  it('walkthrough headings named by the review skills exist in the walkthrough template', () => {
    const headings = extractTemplateHeadings(WALKTHROUGH_TEMPLATE_PATH);
    const codeReview = readSkill(CODE_REVIEW_PATH);

    for (const named of ['Changes Made', 'Verification & Validation', 'Review Findings & Resolutions', 'Follow-ups']) {
      if (!codeReview.includes(named)) continue;
      assert.ok(
        headings.includes(named),
        `dispatch-code-review names "${named}", absent from ${WALKTHROUGH_TEMPLATE_PATH}`,
      );
    }
  });

  it('the walkthrough template declares every tag its own Changes Made example uses', () => {
    const body = templateBody(WALKTHROUGH_TEMPLATE_PATH);
    for (const tag of ['[NEW]', '[MODIFY]', '[DELETE]']) {
      assert.ok(body.includes(tag), `${WALKTHROUGH_TEMPLATE_PATH} omits the ${tag} tag`);
    }
  });

  it('review skill descriptions do not cache removed axis counts', () => {
    for (const rel of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      const description = readSkill(rel).split('\n').find((line) => line.startsWith('description:'));
      assert.ok(description, `${rel} frontmatter has no description`);
      assert.doesNotMatch(description, /across \d+ axes/);
    }
  });
});
