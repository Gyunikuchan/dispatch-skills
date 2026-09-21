import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import * as fillTemplateModule from '../../skills/dispatch/scripts/fill-template.mjs';
import * as reviewKindsModule from '../../skills/dispatch/scripts/review-kinds.mjs';
import * as parseReportModule from '../../skills/dispatch/scripts/parse-report.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PLAN_REVIEW_PATH = 'skills/dispatch-plan-review/SKILL.md';
const CODE_REVIEW_PATH = 'skills/dispatch-code-review/SKILL.md';
const PLAN_REVIEW_README_PATH = 'skills/dispatch-plan-review/README.md';
const CODE_REVIEW_README_PATH = 'skills/dispatch-code-review/README.md';
const TEMPLATES_DIR = 'skills/dispatch/references/templates';
const PROMPT_FRAME_PATH = `${TEMPLATES_DIR}/review-prompt.md`;
const REBUTTAL_FRAME_PATH = `${TEMPLATES_DIR}/rebuttal.md`;
const promptKindPath = (kind) => `${TEMPLATES_DIR}/review-prompt-${kind}.md`;
const rebuttalKindPath = (kind) => `${TEMPLATES_DIR}/rebuttal-${kind}.md`;
const reportSchemaPath = (kind) => `${TEMPLATES_DIR}/schemas/report-${kind}.json`;
const REBUTTAL_SCHEMA_PATH = `${TEMPLATES_DIR}/schemas/rebuttal.json`;
const REVIEW_DOC_PATH = 'skills/dispatch/references/review.md';
const IMPLEMENT_PATH = 'skills/implement-dispatch/SKILL.md';
const REVIEW_KINDS_SCRIPT = 'skills/dispatch/scripts/review-kinds.mjs';
const PREPARE_SCRIPTS = ['skills/dispatch/scripts/prepare-review.mjs', 'skills/dispatch/scripts/prepare-code-review.mjs', 'skills/dispatch/scripts/review-preparation.mjs'];
const FILL_TEMPLATE_SCRIPT = path.join(REPO_ROOT, 'skills', 'dispatch', 'scripts', 'fill-template.mjs');

/**
 * R10: the review prompt and rebuttal for every kind assemble from one shared frame plus a per-kind
 * block under `dispatch/references/templates/`. The frame holds only text identical across kinds;
 * this suite pins that the assembled prompts keep the shared contracts, and that per-kind material
 * (tags, locus, re-review wording) stays in kind blocks and matches the parser registry and READMEs.
 */

function readSkill(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function assemble(framePath, kindPath) {
  assert.equal(typeof fillTemplateModule.assembleTemplate, 'function', 'fill-template.mjs exports assembleTemplate');
  return fillTemplateModule.assembleTemplate(path.join(REPO_ROOT, framePath), path.join(REPO_ROOT, kindPath));
}

/** Raw frame + kind-block source: prose checks that span variable bullets read both files. */
const promptSource = (kind) => `${readSkill(PROMPT_FRAME_PATH)}\n${readSkill(promptKindPath(kind))}`;
const rebuttalSource = (kind) => `${readSkill(REBUTTAL_FRAME_PATH)}\n${readSkill(rebuttalKindPath(kind))}`;

function reviewKind(kind) {
  assert.ok(reviewKindsModule.REVIEW_KINDS, 'review-kinds.mjs exports REVIEW_KINDS');
  const entry = reviewKindsModule.REVIEW_KINDS[kind];
  assert.ok(entry, `REVIEW_KINDS lacks ${kind}`);
  return entry;
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

/** Normalizes the produced re-review scope string's plan/code-specific wording to shared placeholders. */
function normalizeReReviewTemplate(template) {
  return template
    .replace('changed sections: <changed sections>', 'changed SCOPE: <changed SCOPE>')
    .replace('changed paths: <changed paths>; <range>', 'changed SCOPE: <changed SCOPE>');
}

const CONVENTIONS_LINE =
  /Adhere to this project's conventions: read\s+`AGENTS\.md` \/ `CLAUDE\.md`, including nested ones\s+on reviewed paths,\s+and flag violations as\s+`standards`\./;
const ADJACENT_LINE = /^- out of scope: `adjacent` — /m;
const RE_REVIEW_RULE =
  /When\s+Scope\s+names\s+changed\s+(?:paths|sections),\s+raise\s+new\s+in-scope\s+findings\s+only\s+there;\s+`adjacent`\s+findings\s+may\s+cite\s+any\s+locus\./;

/** Extracts `- group: `tag`, ... — gloss` tag lists; text after the first ` — ` is gloss, not tags. */
function extractPromptTags(text) {
  return [...text.matchAll(/^- [^:\n]+: (`[^\n]*)$/gm)]
    .map(([, line]) => line.split(' — ')[0])
    .filter((tags) => /^(?:`[^`]+`,?\s*)+$/.test(tags))
    .flatMap((tags) => [...tags.matchAll(/`([^`]+)`/g)].map((match) => match[1]))
    .sort();
}

/** Extracts `| **<Axis>** | \`tag\`, ... |` table rows from a README's axis table. */
function extractReadmeAxes(text) {
  return [...text.matchAll(/^\| \*\*([^*]+)\*\* \| ((?:`[^`]+`,?\s*)+)\|/gm)].map(([, axis, tags]) => ({
    axis: axis.trim(),
    tags: [...tags.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  }));
}

const PLAN_VARIABLES = ['Plan Path', 'Requirement', 'User Focus Areas', 'Review Scope', 'Tool Turn Budget'];
const CODE_VARIABLES = ['Task Summary', 'Walkthrough Path', 'Plan Path', 'User Focus Areas', 'Review Scope', 'Tool Turn Budget'];
const sorted = (list) => [...list].sort();

describe('review prompt assembly (frame + kind block)', () => {
  it('every kind assembles its prompt and rebuttal with no unresolved slots', () => {
    for (const kind of ['plan', 'code', 'design']) {
      for (const [frame, block] of [[PROMPT_FRAME_PATH, promptKindPath(kind)], [REBUTTAL_FRAME_PATH, rebuttalKindPath(kind)]]) {
        const { template, variables } = assemble(frame, block);
        assert.doesNotMatch(template, /<<slot:/, `${block} leaves a slot unresolved`);
        assert.ok(variables.length > 0, `${block} assembles no variables`);
      }
    }
  });

  it('design review exposes architecture-specific prompt material and parses as design', () => {
    const { template } = assemble(PROMPT_FRAME_PATH, promptKindPath('design'));
    assert.match(template, /architecture|dependency graph|boundaries/i);
    assert.equal(parseReportModule.parseReport('design', JSON.stringify({ status: 'CLEAN', findings: [] })).reportKind, 'design');
  });

  it('no template names `.claude/CLAUDE.md` (host-agnostic convention path)', () => {
    for (const kind of ['plan', 'code', 'design']) {
      assert.ok(!promptSource(kind).includes('.claude/CLAUDE.md'), `${kind} prompt still references .claude/CLAUDE.md`);
    }
  });

  it('plan and code prompts read the same conventions line', () => {
    for (const kind of ['plan', 'code']) {
      assert.match(assemble(PROMPT_FRAME_PATH, promptKindPath(kind)).template, CONVENTIONS_LINE, `${kind} prompt missing shared conventions line`);
    }
  });

  it('plan and code prompts review adversarially and invite adjacent findings', () => {
    for (const kind of ['plan', 'code']) {
      const { template } = assemble(PROMPT_FRAME_PATH, promptKindPath(kind));
      assert.match(template, /adversarially/, `${kind} lacks the adversarial opening`);
      assert.match(template, ADJACENT_LINE, `${kind} lacks the adjacent tag group`);
      assert.match(template, RE_REVIEW_RULE, `${kind} lacks the conditioned re-review rule`);
      assert.match(template, /Every finding needs a verifiable claim/, `${kind} lacks the verifiable-claim rule`);
      assert.doesNotMatch(template, /findings outside scope/, `${kind} still forbids out-of-scope findings`);
    }
    assert.match(assemble(PROMPT_FRAME_PATH, promptKindPath('code')).template, /^- standards: `standards` — /m, 'code lacks the standards tag group');
  });

  it('every tag-group line carries a gloss on one physical line', () => {
    for (const kind of ['plan', 'code']) {
      const groups = [...readSkill(promptKindPath(kind)).matchAll(/^- [^:\n]+: `.*$/gm)].map(([line]) => line);
      assert.ok(groups.length > 0, `${kind} kind block defines no tag groups`);
      for (const line of groups) assert.match(line, / — \S/, `${kind}: tag group lacks a gloss: ${line}`);
    }
  });

  it('shares the structured report shape modulo locus examples', () => {
    const normalize = (record) => ({
      ...record,
      findings: record.findings.map((finding) => ({ ...finding, locus: '<LOCUS>' })),
    });
    const [planRecords, codeRecords, designRecords] = ['plan', 'code', 'design'].map((kind) =>
      extractJsonExamples(assemble(PROMPT_FRAME_PATH, promptKindPath(kind)).template).map(normalize));
    assert.deepEqual(planRecords, codeRecords);
    assert.deepEqual(designRecords, planRecords, 'design adopts the shared reply contract');
    assert.deepEqual(Object.keys(planRecords[0]).sort(), ['findings', 'status']);
    assert.deepEqual(
      Object.keys(planRecords[1].findings[0]).sort(),
      ['defect', 'locus', 'requiredChange', 'severity', 'tag'],
    );
  });

  it('requires one closing JSON object and findings only when status is FINDINGS', () => {
    for (const kind of ['plan', 'code', 'design']) {
      const { template } = assemble(PROMPT_FRAME_PATH, promptKindPath(kind));
      assert.match(template, /Run commands in the foreground; reply once the review is complete\./);
      assert.match(template, /End your reply with one JSON object holding every finding\./);
      assert.match(template, /Otherwise use status `FINDINGS` and one or more findings with every field/);
      assert.doesNotMatch(template, /Axis Coverage|## Verdict|Actionable Next Steps|## Shorter Path/);
      assert.equal(extractJsonExamples(template).length, 2, `${kind} must declare clean and finding examples`);
    }
  });

  // Only claude receives the schema natively, so every template states one positive, provider-neutral
  // output target; a prose or schema-only branch is one the delegate cannot evaluate.
  it('states one provider-neutral output target in every review and rebuttal template', () => {
    for (const kind of ['plan', 'code', 'design']) {
      assert.doesNotMatch(promptSource(kind), /schema-constrained|Without JSON|cannot emit/, kind);
      assert.doesNotMatch(rebuttalSource(kind), /schema-constrained|Without JSON|cannot emit/, kind);
      assert.match(assemble(REBUTTAL_FRAME_PATH, rebuttalKindPath(kind)).template, /End your reply with one JSON object holding every response:/, kind);
    }
  });

  it('share the re-review scope template modulo section/line wording', () => {
    assert.equal(
      normalizeReReviewTemplate(extractReReviewTemplate(promptSource('plan'))),
      normalizeReReviewTemplate(extractReReviewTemplate(promptSource('code'))),
    );
  });

  it('documents lint warnings as an optional Review Scope suffix without adding variables', () => {
    const { variables: promptVariables } = assemble(PROMPT_FRAME_PATH, promptKindPath('plan'));
    const { variables: rebuttalVariables, template: rebuttal } = assemble(REBUTTAL_FRAME_PATH, rebuttalKindPath('plan'));
    assert.deepEqual(sorted(promptVariables), sorted(PLAN_VARIABLES));
    assert.deepEqual(sorted(rebuttalVariables), sorted(['Plan Path', 'Finding Packet Path', 'Review Scope', 'Tool Turn Budget']));
    assert.match(promptSource('plan'), /lint warnings.*Review Scope|Review Scope.*lint warnings/is);
    assert.match(rebuttal, /lint warnings|plan-lint warnings/i);
    assert.match(rebuttal, /Finding keys only|supplied finding keys/i);
  });

  it('carries one advisory Tool Turn Budget target', () => {
    for (const kind of ['plan', 'code']) {
      const { template } = assemble(PROMPT_FRAME_PATH, promptKindPath(kind));
      assert.equal(template.match(/<Tool Turn Budget>/g)?.length, 1);
      assert.match(template, /one advisory target/);
      assert.match(template, /8 \+ 2 ×/);
      assert.match(template, /Stop early/);
      assert.match(template, /Exceed it only for a\s+named in-scope risk supported by evidence/);
    }
  });

  it('both bound inspection with a parallel "stop at that blast radius" sentence', () => {
    for (const kind of ['plan', 'code']) {
      assert.match(assemble(PROMPT_FRAME_PATH, promptKindPath(kind)).template, /Stop at that\s+blast\s+radius\./);
    }
  });
});

describe('review templates live in dispatch/references/templates', () => {
  for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
    it(`${skillPath}: SKILL.md no longer inlines a fenced template`, () => {
      const text = readSkill(skillPath);
      assert.ok(!text.includes('````'), `${skillPath} still contains a 4-backtick template fence`);
      assert.throws(() => fillTemplateModule.extractTemplate(text), /not found/);
      assert.ok(text.includes('dispatch/scripts/prepare-review.mjs'), `${skillPath} does not point at dispatch preparation`);
    });
  }

  it('assembles declared variables and an intact plan template', () => {
    const { variables, template } = assemble(PROMPT_FRAME_PATH, promptKindPath('plan'));
    assert.deepEqual(sorted(variables), sorted(PLAN_VARIABLES));
    assert.ok(template.includes('<Plan Path>'));
    assert.ok(template.includes('### Context'));
  });

  it('assembles declared variables and an intact code template, preserving inner fences', () => {
    const { variables, template } = assemble(PROMPT_FRAME_PATH, promptKindPath('code'));
    assert.deepEqual(sorted(variables), sorted(CODE_VARIABLES));
    assert.ok(template.includes('<Walkthrough Path>'));
    assert.ok(/```/.test(template), 'expected an inner fence to survive assembly');
  });

  // The spawned CLI exercises --skill resolution and the nested-template integrity gate.
  for (const [kind, expected] of [['code', CODE_VARIABLES], ['plan', PLAN_VARIABLES]]) {
    it(`fill-template --list reads the assembled ${kind} prompt`, () => {
      const result = cp.spawnSync(process.execPath, [
        FILL_TEMPLATE_SCRIPT,
        '--skill', path.join(REPO_ROOT, PROMPT_FRAME_PATH),
        '--kind-block', path.join(REPO_ROOT, promptKindPath(kind)),
        '--list',
      ], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(sorted(JSON.parse(result.stdout.trim())), sorted(expected));
      assert.doesNotMatch(result.stderr, /WARNING|not listed/);
    });
  }

  it('review skills use the kind-parameterized JSON request preparation transport', () => {
    for (const [skillPath, kind] of [[PLAN_REVIEW_PATH, 'plan'], [CODE_REVIEW_PATH, 'code']]) {
      const skill = readSkill(skillPath);
      assert.match(skill, new RegExp(`prepare-review\\.mjs --kind ${kind} --request <json-file\\|->`));
      assert.match(skill, /execute only `dispatch\.argv`/i);
    }
  });

  it('the kind registry names each native response schema', () => {
    const registry = readSkill(REVIEW_KINDS_SCRIPT);
    for (const kind of ['plan', 'code', 'design']) {
      assert.match(registry, new RegExp(`report-${kind}\\.json`));
      assert.ok(readSkill(reportSchemaPath(kind)));
    }
    assert.match(registry, /rebuttal\.json/);
  });
});

describe('review response schemas', () => {
  for (const kind of ['plan', 'code']) {
    it(`${kind} schema matches registry tags and report fields`, () => {
      const { tags, locusPattern } = reviewKind(kind);
      const schema = JSON.parse(readSkill(reportSchemaPath(kind)));
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
      const manifest = JSON.parse(readSkill('skills/dispatch/skill-hashes.json'));
      assert.ok(
        `references/templates/schemas/report-${kind}.json` in manifest,
        'dispatch manifest must integrity-check the response schema',
      );
    });
  }
});

describe('orchestrated handover contract', () => {
  it('preparation owns targets and modes; implement-dispatch no longer fills templates', () => {
    const script = PREPARE_SCRIPTS.map(readSkill).join('\n');
    assert.match(script, /mode === 'orchestrated' && targets\.length === 0/);
    assert.match(script, /\['full', 'rebuttal'\]/);
    assert.match(script, /candidateId\.split\(':'\)\[1\] !== entry\.platform/);
    const implement = readSkill(IMPLEMENT_PATH);
    assert.ok(implement.includes('targets/reserves'), `${IMPLEMENT_PATH} does not hand over targets`);
    assert.ok(!implement.includes('fill-template'), `${IMPLEMENT_PATH} still instructs fill-template`);
    assert.ok(!implement.includes('--prompt-file'), `${IMPLEMENT_PATH} still instructs --prompt-file`);
  });

  it('reports are read as schema JSON or prose, not discarded', () => {
    const review = readSkill(REVIEW_DOC_PATH);
    assert.match(review, /Reports\s+arrive\s+as\s+schema\s+JSON\s+or\s+prose\./, `${REVIEW_DOC_PATH} lacks the prose-report rule`);
    assert.match(review, /restate\s+a\s+rebuttal\s+as\s+one\s+verdict\s+per\s+packet\s+key/, `${REVIEW_DOC_PATH} lacks the prose-rebuttal rule`);
    assert.match(review, /Refusal,\s+truncation,\s+empty\s+output/, `${REVIEW_DOC_PATH} lets failed prose count as clean`);
    assert.match(review, /schema-mismatched\s+JSON\)/, `${REVIEW_DOC_PATH} discards schema-mismatched JSON instead of restating it`);
    assert.doesNotMatch(review, /RESPONSE_SCHEMA_PROVIDERS/, `${REVIEW_DOC_PATH} still depends on script internals`);
    for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      const content = readSkill(skillPath);
      assert.match(content, /Exit\s+`3`:\s+read\s+the\s+prose\s+report\s+per\s+(?:alignment|review)/, `${skillPath} does not route prose reports`);
      assert.match(content, /exit\s+`1`\s+is\s+an\s+empty\s+report/, `${skillPath} does not route empty reports`);
    }
  });

  it('adjacent findings are final, deferred, and offered to the user before checkpoint', () => {
    const review = readSkill(REVIEW_DOC_PATH);
    assert.match(review, /`adjacent` finding/, `${REVIEW_DOC_PATH} lacks the adjacent finality rule`);
    assert.match(review, /never pending/, `${REVIEW_DOC_PATH} does not keep adjacent out of consensus`);
    for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      const content = readSkill(skillPath);
      assert.match(content, /`adjacent`/, `${skillPath} does not route adjacent findings`);
      assert.match(content, /before (?:the )?checkpoint/i, `${skillPath} does not ask before checkpoint`);
    }
    const implement = readSkill(IMPLEMENT_PATH);
    assert.match(implement, /`adjacent`/, `${IMPLEMENT_PATH} does not offer adjacent follow-ups`);
  });

  it('the handover carries consensus, and pending rebuttals are a logged form in every consumer', () => {
    const review = readSkill(REVIEW_DOC_PATH);
    assert.match(review, /rejecting or\s+downgrading `MUST`\/`SHOULD`/);
    assert.match(review, /`CONSIDER`\s+is advisory and final/);
    const log = review.slice(review.indexOf('## Resolution log'));
    assert.ok(review.includes('[Rejected — pending confirmation]'), `${REVIEW_DOC_PATH} lacks the pending form`);
    assert.ok(log.includes('[MUST|SHOULD|CONSIDER]'), `${REVIEW_DOC_PATH} Resolutions Log lacks structured severity`);
    // R7: legacy log compatibility and ACTIONABLE are removed, not merely unmentioned.
    assert.ok(!log.includes('Legacy lines remain readable'), `${REVIEW_DOC_PATH} still documents legacy log compatibility`);
    assert.ok(!review.includes('ACTIONABLE'), `${REVIEW_DOC_PATH} still documents ACTIONABLE`);

    for (const skillPath of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      const content = readSkill(skillPath);
      assert.match(content, /\[`review\.md`\]\(\.\.\/dispatch\/references\/review\.md\)/);
      assert.match(content, /sanitize/i);
    }

    const implement = readSkill(IMPLEMENT_PATH);
    assert.match(implement, /targets\/reserves, round, consensus/);
    assert.ok(implement.includes('check-consensus.mjs'), `${IMPLEMENT_PATH} does not gate on check-consensus.mjs`);
    assert.ok(implement.includes('--exclude'), `${IMPLEMENT_PATH} does not re-resolve with --exclude`);
  });
});

describe('rebuttal contract parity', () => {
  it('every kind assembles the same response envelope from the shared frame and one shared schema', () => {
    const examples = ['plan', 'code', 'design'].map((kind) => {
      const { template, variables } = assemble(REBUTTAL_FRAME_PATH, rebuttalKindPath(kind));
      assert.match(template, /<Finding Packet Path>/);
      assert.match(template, /CONFIRM\|REBUT\|INTENT-DISPUTE/);
      assert.ok(variables.includes('Finding Packet Path'), `${kind} rebuttal lacks the packet variable`);
      return extractJsonExamples(template)[0];
    });
    assert.deepEqual(examples[1], examples[0]);
    assert.deepEqual(examples[2], examples[0]);
    assert.deepEqual(Object.keys(examples[0]), ['responses']);
    assert.deepEqual(
      Object.keys(examples[0].responses[0]).sort(),
      ['evidence', 'key', 'type', 'verdict'],
    );
    const schema = JSON.parse(readSkill(REBUTTAL_SCHEMA_PATH));
    assert.deepEqual(schema.required, ['responses']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      schema.properties.responses.items.properties.verdict.enum,
      ['CONFIRM', 'REBUT', 'INTENT-DISPUTE'],
    );
  });
});

describe('review axis/tag parity: kind block vs README.md vs registry', () => {
  for (const [kind, readmePath] of [['plan', PLAN_REVIEW_README_PATH], ['code', CODE_REVIEW_README_PATH]]) {
    it(`${kind}: compact prompt tags match the disclosed README rubric and parser registry`, () => {
      const promptTags = extractPromptTags(readSkill(promptKindPath(kind)));
      const readmeTags = extractReadmeAxes(readSkill(readmePath)).flatMap(({ tags }) => tags).sort();
      assert.ok(promptTags.length > 0, `${promptKindPath(kind)} defines no review tags`);
      assert.deepEqual(readmeTags, promptTags);
      assert.deepEqual([...reviewKind(kind).tags].sort(), promptTags);
    });
  }
});

// ---------------------------------------------------------------------------
// SECTION: Cross-skill prose contracts
//
// These headings and counts are duplicated across skills as prose, so nothing but
// a test stops them drifting apart. Each case below pins one such duplication.
// ---------------------------------------------------------------------------

const PLAN_TEMPLATE_PATH = `${TEMPLATES_DIR}/plan.md`;
const WALKTHROUGH_TEMPLATE_PATH = `${TEMPLATES_DIR}/walkthrough.md`;

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
  it('applies the shared delegate-text sanitization contract to both fold steps', () => {
    assert.match(readSkill(REVIEW_DOC_PATH), /Sanitize delegate text/);
    for (const rel of [PLAN_REVIEW_PATH, CODE_REVIEW_PATH]) {
      assert.match(readSkill(rel), /sanitiz/i);
    }
  });

  it('every plan section dispatch-plan-review names is a plan-template heading', () => {
    const headings = extractTemplateHeadings(PLAN_TEMPLATE_PATH);
    const section = readSkill(PLAN_REVIEW_PATH);

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
