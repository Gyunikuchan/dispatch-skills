import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { assembleTemplate, extractTemplate, fillTemplate } from '../../../skills/dispatch/scripts/domain/prompt.ts';
import { REVIEW_PROMPT_INPUTS } from '../../fixtures/review-prompt-inputs.ts';

const templates = new URL('../../../skills/dispatch/references/templates/', import.meta.url);
const golden = new URL('../../fixtures/review-prompt-golden/', import.meta.url);
const read = (base: URL, name: string) => readFileSync(new URL(name, base), 'utf8');

test('prompt: fill rejects missing declared values and undeclared value names', () => {
  assert.throws(() => fillTemplate('<A> <B>', ['A', 'B'], { A: '1' }), /Missing value\(s\) for declared variable\(s\): B/);
  assert.throws(() => fillTemplate('<A>', ['A'], { A: '1', C: '3' }), /Unknown variable\(s\).*C/);
});

test('prompt: fill is single-pass and passes undeclared placeholders through', () => {
  assert.equal(fillTemplate('<A> at <file>:L<line> tag <tag>', ['A'], { A: '<A> <tag>' }), '<A> <tag> at <file>:L<line> tag <tag>');
});

test('prompt: declared variables and body are extracted from the Markdown template', () => {
  const { variables, template } = extractTemplate('# X\n\n## Prompt template\n- `<Name>` — who\n````markdown\nHi <Name>\n````\n');
  assert.deepEqual(variables, ['Name']);
  assert.equal(fillTemplate(template, variables, { Name: 'Ada' }), 'Hi Ada');
});

test('prompt: assembled frame + kind block filled with fixed inputs equals the golden per review kind', () => {
  const frame = read(templates, 'review-prompt.md');
  for (const kind of ['code', 'design', 'plan'] as const) {
    const { variables, template } = assembleTemplate(frame, read(templates, `review-prompt-${kind}.md`));
    assert.equal(`${fillTemplate(template, variables, REVIEW_PROMPT_INPUTS[kind])}\n`, read(golden, `${kind}.md`), kind);
  }
});

test('prompt: a slot without a kind section, or a section without a slot, throws', () => {
  const frame = '## Prompt template\n````markdown\n<<slot:a>>\n````\n';
  assert.throws(() => assembleTemplate(frame, '## b\ntext\n'), /no section for slot/);
  assert.throws(() => assembleTemplate(frame, '## a\nx\n## b\ny\n'), /no frame slot/);
});

// SECTION: Plan-review severity calibration

const CALIBRATION = "In plan reviews, MUST means the plan as written cannot deliver its outcome or breaks a binding constraint. A gap that the plan's own Verify gates would surface deterministically during implementation, such as a fixture update or a test assertion, is SHOULD.";
const assembled = (kind: string) => assembleTemplate(read(templates, 'review-prompt.md'), read(templates, `review-prompt-${kind}.md`)).template;

test('SC4 plan prompt calibrates MUST', () => {
  const flat = assembled('plan').replace(/\s+/g, ' ');
  assert.ok(flat.includes(`\`CONSIDER\`: optional improvement; no defect. ${CALIBRATION} In \`defect\`, state`), flat);
});

test('SC4 code and design prompts omit severity calibration', () => {
  assert.match(extractTemplate(read(templates, 'review-prompt.md')).template, /improvement; no defect\.\n<<slot:severity>>\nIn `defect`/);
  for (const kind of ['code', 'design']) {
    const template = assembled(kind);
    assert.match(template, /improvement; no defect\.\nIn `defect`/, kind);
    assert.ok(!template.includes('In plan reviews') && !template.includes('<<slot:'), kind);
  }
});

// SECTION: Grounding, tooling, and reuse rules

const flat = (kind: string) => assembled(kind).replace(/\s+/g, ' ');
const tagsBlock = (kind: string) => flat(kind).split('### Tags')[1]!.split('### Budget')[0]!;

test('review prompts: every kind grounds findings and reports a defective local convention once', () => {
  for (const kind of ['code', 'design', 'plan']) {
    const text = flat(kind);
    for (const rule of [
      'Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known vulnerability class.',
      "Preference is not a finding; between technically equivalent approaches, the author's choice stands.",
      'Simplicity findings name the cost removed: concepts, files, or code paths.',
      'A pattern that matches established local convention is not a finding; when the convention itself is defective, report it once and name the other instances in `defect`.',
    ]) assert.ok(text.includes(rule), `${kind}: ${rule}`);
  }
});

test('review prompts: only code review searches for existing equivalents and skips tool-enforced issues', () => {
  const rules = [
    'Skip issues that configured linters, formatters, or type checkers enforce.',
    'For each new exported or shared symbol, search the repository by name and behaviour for an existing equivalent; report a match as `reuse` anchored on the new symbol, and cite the existing `path:L<line>` in `defect`.',
    'Reuse searches do not count toward the target.',
  ];
  for (const rule of rules) assert.ok(flat('code').includes(rule), rule);
  for (const kind of ['design', 'plan']) for (const rule of rules) assert.ok(!flat(kind).includes(rule), `${kind}: ${rule}`);
});

test('review prompts: code and plan tag glosses name data-access and exposure risks', () => {
  for (const kind of ['code', 'plan']) {
    const tags = tagsBlock(kind);
    for (const term of ['N+1', 'unpaginated reads', /\bunindexed|without an index\b/, 'object ownership', 'sensitive data in logs']) {
      assert.ok(typeof term === 'string' ? tags.includes(term) : term.test(tags), `${kind}: ${String(term)}`);
    }
  }
});

// SECTION: Durable test bar and plan-free naming

test('review prompts: reviews hold retained tests to the durable bar', () => {
  for (const kind of ['code', 'plan']) {
    const tags = tagsBlock(kind);
    for (const term of ['the durable bar in the plan template', 'rewrite', 'demote to transient', 'delete', ...(kind === 'plan' ? ['transient-named file'] : [])]) assert.ok(tags.includes(term), `${kind}: ${term}`);
  }
  assert.ok(tagsBlock('code').includes('rewrite to meet it'));
});

test('review prompts: prompts keep plan IDs out of tests', () => {
  const tags = tagsBlock('code');
  for (const term of ['test names, describe blocks, comments, section headers, or fixture names', 'criterion, task, or finding IDs']) assert.ok(tags.includes(term), term);
});
