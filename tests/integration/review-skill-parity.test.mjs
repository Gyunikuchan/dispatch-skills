import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { extractTemplate } from '../../skills/dispatch/scripts/fill-template.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PLAN_REVIEW_PATH = 'skills/dispatch-plan-review/SKILL.md';
const CODE_REVIEW_PATH = 'skills/dispatch-code-review/SKILL.md';
const PLAN_PROMPT_PATH = 'skills/dispatch-plan-review/references/prompt-template.md';
const CODE_PROMPT_PATH = 'skills/dispatch-code-review/references/prompt-template.md';
const PLAN_REVIEW_README_PATH = 'skills/dispatch-plan-review/README.md';
const CODE_REVIEW_README_PATH = 'skills/dispatch-code-review/README.md';
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

/** Extracts the fenced finding-grammar line following the given anchor sentence. */
function extractFindingGrammar(text) {
  const anchor = 'Write every finding as one line in this grammar:';
  const at = text.indexOf(anchor);
  assert.ok(at !== -1, 'finding-grammar anchor sentence not found');
  const after = text.slice(at + anchor.length);
  const match = after.match(/```\s*\n(.+?)\n\s*```/s);
  assert.ok(match, 'finding-grammar fenced block not found');
  return match[1].trim();
}

/** Normalizes a finding-grammar line's locus term to a shared placeholder. */
function normalizeLocus(line) {
  return line.replace('§ <Section>', '<LOCUS>').replace('<file>:L<line>', '<LOCUS>');
}

/** Extracts the bullet-heading tokens under "Structure your review as:", excluding the final (intentionally divergent) bullet. */
function extractSkeletonHeadings(text) {
  const anchor = 'Structure your review as:';
  const at = text.indexOf(anchor);
  assert.ok(at !== -1, 'report-skeleton anchor not found');
  const after = text.slice(at + anchor.length, at + anchor.length + 2000);
  const headings = [...after.matchAll(/^- `(## [^`]+)`:/gm)].map(m => m[1]);
  assert.ok(headings.length >= 6, `expected at least 6 skeleton bullets, found ${headings.length}`);
  // Drop the final bullet (`## Shorter Path` / `## Actionable Next Steps`): an
  // intentional divergence called out in the plan, not part of shared skeleton.
  return headings.slice(0, 5);
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

/** Extracts the "Tool Turn Budget counts ... Then emit the report immediately." budget sentence. */
function extractToolTurnBudget(text) {
  const anchor = 'Tool Turn Budget counts every tool call';
  const at = text.indexOf(anchor);
  assert.ok(at !== -1, 'tool-turn budget anchor not found');
  const end = text.indexOf('Then emit the report immediately.', at);
  assert.ok(end !== -1, 'tool-turn budget sentence end not found');
  return text.slice(at, end + 'Then emit the report immediately.'.length);
}

/** Normalizes the per-skill review unit and the code-only verification clause to shared placeholders. */
function normalizeToolTurnBudget(sentence) {
  return sentence
    .replace('Complete grounding within it', 'Complete ACTION within it')
    .replace('Complete inspection within it', 'Complete ACTION within it')
    .replace(', verification runs included', '')
    .replace(/Complete (?:grounding|inspection) within it/, 'Complete WORK within it')
    .replace(/`6 \+ <[^>]+>`/, '`6 + <UNIT>`')
    .replace(/counting only [^.]+ since the previous round/, 'counting only UNITs since the previous round');
}

/** Extracts the "stop at that blast radius" inspection-bound sentence. */
function extractBlastRadiusBound(text) {
  const match = text.match(/Read ([^.]*?); stop at that blast radius\./);
  assert.ok(match, 'blast-radius bound sentence not found');
  return match[0];
}

const CONVENTIONS_LINE = "Adhere to this project's conventions (read `AGENTS.md` / `CLAUDE.md` from the workspace)";

/** Extracts `- **<Axis>** (\`tag\`, ...)` bullets from a prompt template's axis list. */
function extractSkillAxes(text) {
  return [...text.matchAll(/^- \*\*([^*]+)\*\* \(((?:`[^`]+`,?\s*)+)\):/gm)].map(([, axis, tags]) => ({
    axis: axis.trim(),
    tags: [...tags.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  }));
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
    assert.ok(planText.includes(CONVENTIONS_LINE), `${PLAN_PROMPT_PATH} missing shared conventions line`);
    assert.ok(codeText.includes(CONVENTIONS_LINE), `${CODE_PROMPT_PATH} missing shared conventions line`);
  });

  it('share the finding-grammar shape modulo the locus term', () => {
    const planGrammar = normalizeLocus(extractFindingGrammar(planText));
    const codeGrammar = normalizeLocus(extractFindingGrammar(codeText));
    assert.equal(planGrammar, codeGrammar);
  });

  it('share the same five report-skeleton headings, in order', () => {
    const planHeadings = extractSkeletonHeadings(planText);
    const codeHeadings = extractSkeletonHeadings(codeText);
    assert.deepEqual(planHeadings, codeHeadings);
  });

  it('share the re-review scope template modulo section/line wording', () => {
    const planTemplate = normalizeReReviewTemplate(extractReReviewTemplate(planText));
    const codeTemplate = normalizeReReviewTemplate(extractReReviewTemplate(codeText));
    assert.equal(planTemplate, codeTemplate);
  });

  it('share the default tool-turn budget sentence modulo scope wording', () => {
    const planBudget = normalizeToolTurnBudget(extractToolTurnBudget(planText));
    const codeBudget = normalizeToolTurnBudget(extractToolTurnBudget(codeText));
    assert.equal(planBudget, codeBudget);
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
    assert.ok(template.includes('### Context & Objective'));
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
});

describe('orchestrated handover contract', () => {
  it('alignment detection names targets; review skills and implement-dispatch use "targets"; implement-dispatch no longer fills templates', () => {
    const alignment = readSkill(ALIGNMENT_PATH);
    const modes = alignment.slice(alignment.indexOf('## Invocation Modes'), alignment.indexOf('## Prompt Template Filling'));
    assert.match(modes, /Detection:[^\n]*\*\*targets\*\*/, `${ALIGNMENT_PATH} § Invocation Modes detection does not name targets`);

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

    const log = alignment.slice(alignment.indexOf('## Resolutions Log'));
    assert.ok(log.includes('**[Rejected — pending confirmation]**'), `${ALIGNMENT_PATH} Resolutions Log lacks the pending form`);

    for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      assert.ok(readSkill(skillPath).includes('[Rejected — pending confirmation]'), `${skillPath} does not name the pending form`);
    }

    const implement = readSkill(IMPLEMENT_PATH);
    assert.ok(implement.includes('consensus: true|false'), `${IMPLEMENT_PATH} does not hand over consensus`);
    assert.ok(implement.includes('check-consensus.mjs'), `${IMPLEMENT_PATH} does not gate on check-consensus.mjs`);
    assert.ok(implement.includes('--exclude'), `${IMPLEMENT_PATH} does not re-resolve with --exclude`);
  });
});

describe('review skill axis/tag parity: prompt template vs README.md', () => {
  it('dispatch-plan-review: template axes match README.md table rows, same names, tags, and order', () => {
    const skillAxes = extractSkillAxes(readSkill(PLAN_PROMPT_PATH));
    const readmeAxes = extractReadmeAxes(readSkill(PLAN_REVIEW_README_PATH));
    assert.ok(skillAxes.length > 0, `${PLAN_PROMPT_PATH} defines no axis bullets`);
    assert.deepEqual(readmeAxes, skillAxes);
  });

  it('dispatch-code-review: template axes match README.md table rows, same names, tags, and order', () => {
    const skillAxes = extractSkillAxes(readSkill(CODE_PROMPT_PATH));
    const readmeAxes = extractReadmeAxes(readSkill(CODE_REVIEW_README_PATH));
    assert.ok(skillAxes.length > 0, `${CODE_PROMPT_PATH} defines no axis bullets`);
    assert.deepEqual(readmeAxes, skillAxes);
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

/** Spells out a small cardinal number the way the prose does. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

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

  it('each prompt template axis count word matches the axes it actually declares', () => {
    for (const rel of [PLAN_PROMPT_PATH, CODE_PROMPT_PATH]) {
      const text = readSkill(rel);
      const declared = extractSkillAxes(text).length;
      const word = NUMBER_WORDS[declared];
      assert.ok(word, `unexpected axis count ${declared} in ${rel}`);

      // Both the opening line and the evaluation heading spell the count out.
      const heading = new RegExp(`#### 2\\. ${word}-Axis Evaluation`, 'i');
      assert.match(text, heading, `${rel} evaluation heading disagrees with its ${declared} axes`);
      assert.match(
        extractTemplate(text).template,
        new RegExp(`across ${word} axes`, 'i'),
        `${rel} opening line disagrees with its ${declared} axes`,
      );
    }
  });

  it('the code-review skill description axis count matches its prompt template', () => {
    const declared = extractSkillAxes(readSkill(CODE_PROMPT_PATH)).length;
    const description = readSkill(CODE_REVIEW_PATH).split('\n').find((l) => l.startsWith('description:'));
    assert.ok(description, 'dispatch-code-review frontmatter has no description');
    const stated = description.match(/across (\d+) axes/);
    if (stated) {
      assert.equal(
        Number(stated[1]),
        declared,
        'dispatch-code-review description axis count disagrees with its prompt template',
      );
    }
  });
});
