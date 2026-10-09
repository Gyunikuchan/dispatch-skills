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
