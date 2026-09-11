import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PLAN_REVIEW_PATH = 'skills/dispatch-plan-review/SKILL.md';
const CODE_REVIEW_PATH = 'skills/dispatch-code-review/SKILL.md';

/**
 * The two review skills' delegate-facing prompt templates stay inline (not
 * pushed into `dispatch`'s shared alignment.md) so an external delegate reads
 * a single self-contained prompt with no cross-file lookup. This suite is the
 * drift guard for that duplication: it extracts the pieces that are supposed
 * to be identical wording and asserts they match, modulo a small declared
 * substitution map for the wording that is legitimately different (plan vs.
 * code terminology). Anything not covered by the map must match verbatim.
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
  return line.replace('## <Section>', '<LOCUS>').replace('<file>:L<line>', '<LOCUS>');
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

/** Extracts the "otherwise spend ... Then emit the report immediately." tool-turn budget sentence. */
function extractToolTurnBudget(text) {
  const anchor = 'otherwise spend 3';
  const at = text.indexOf(anchor);
  assert.ok(at !== -1, 'tool-turn budget anchor not found');
  const end = text.indexOf('Then emit the report immediately.', at);
  assert.ok(end !== -1, 'tool-turn budget sentence end not found');
  return text.slice(at, end + 'Then emit the report immediately.'.length);
}

/** Normalizes the "cross-cutting migrations" / "cross-cutting changes" wording to a shared placeholder. */
function normalizeToolTurnBudget(sentence) {
  return sentence.replace(/cross-cutting \w+/, 'cross-cutting SCOPE');
}

const CONVENTIONS_LINE = "Adhere to this project's conventions (read `AGENTS.md` / `CLAUDE.md` from the workspace)";

describe('review skill prompt template parity', () => {
  const planText = readSkill(PLAN_REVIEW_PATH);
  const codeText = readSkill(CODE_REVIEW_PATH);

  it('neither template names `.claude/CLAUDE.md` (host-agnostic convention path)', () => {
    assert.ok(!planText.includes('.claude/CLAUDE.md'), `${PLAN_REVIEW_PATH} still references .claude/CLAUDE.md`);
    assert.ok(!codeText.includes('.claude/CLAUDE.md'), `${CODE_REVIEW_PATH} still references .claude/CLAUDE.md`);
  });

  it('both templates read the same conventions line', () => {
    assert.ok(planText.includes(CONVENTIONS_LINE), `${PLAN_REVIEW_PATH} missing shared conventions line`);
    assert.ok(codeText.includes(CONVENTIONS_LINE), `${CODE_REVIEW_PATH} missing shared conventions line`);
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
});
