import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';

import * as fillTemplateModule from '../../../../skills/dispatch/scripts/review/fill-template.mjs';
const { extractTemplate, fillTemplate } = fillTemplateModule;
import { PROJECT_ROOT } from '../../../../skills/dispatch/scripts/lib/platform.mjs';

// NOTE: extraction against the real review skills' templates lives in
// tests/integration/review-skill-parity.test.mjs; frame + kind-block assembly is pinned below.

// ---------------------------------------------------------------------------
// SECTION: Extraction
// ---------------------------------------------------------------------------

describe('fill-template: extraction', () => {
  it('preserves inner fenced code blocks inside the outer 4-backtick fence', () => {
    const markdown = '## Prompt template\n\n- `<Name>` — a value.\n\n````markdown\nHello <Name>\n\n```\ninner\n```\n````\n';
    const { template } = extractTemplate(markdown);
    // The inner ``` fence surviving proves the scanner closed on the matching (>=4-backtick) fence.
    assert.ok(/```\ninner\n```/.test(template), 'expected an inner fence to survive extraction');
  });

  it('throws when the section is not found', () => {
    assert.throws(() => extractTemplate('# Some Doc\n\nNo template here.\n', 'Prompt template'), /not found/);
  });

  it('throws when no fenced block follows the heading', () => {
    const markdown = '#### Prompt template\n\n- `<Name>` — a value.\n\nNo fence follows.\n';
    assert.throws(() => extractTemplate(markdown), /No fenced block/);
  });

  it('matches any heading level 1-6', () => {
    const markdown = '## Prompt template\n\n- `<Name>` — a value.\n\n```\nHello <Name>\n```\n';
    const { variables, template } = extractTemplate(markdown);
    assert.deepEqual(variables, ['Name']);
    assert.equal(template, 'Hello <Name>');
  });

  it('normalizes CRLF line endings before matching heading and fences', () => {
    const markdown = '#### Prompt template\r\n\r\n- `<Name>` — a value.\r\n\r\n```\r\nHello <Name>\r\n```\r\n';
    const { variables, template } = extractTemplate(markdown);
    assert.deepEqual(variables, ['Name']);
    assert.equal(template, 'Hello <Name>');
  });
});

// ---------------------------------------------------------------------------
// SECTION: Fill
// ---------------------------------------------------------------------------

describe('fill-template: fillTemplate', () => {
  it('replaces every declared placeholder', () => {
    const template = 'Plan: <Plan Path>\nFocus: <User Focus Areas>';
    const filled = fillTemplate(template, ['Plan Path', 'User Focus Areas'], {
      'Plan Path': '.scratch/plan/x.md',
      'User Focus Areas': 'General review',
    });
    assert.equal(filled, 'Plan: .scratch/plan/x.md\nFocus: General review');
  });

  it('leaves ungoverned grammar placeholders untouched', () => {
    const template = 'See <file>:L<line> for <tag> on <axis> in <Section>. Path: <Plan Path>';
    const filled = fillTemplate(template, ['Plan Path'], { 'Plan Path': 'plan.md' });
    assert.equal(filled, 'See <file>:L<line> for <tag> on <axis> in <Section>. Path: plan.md');
  });

  it('does not re-substitute a supplied value that itself contains a placeholder-shaped string', () => {
    const template = 'A: <A> B: <B>';
    const filled = fillTemplate(template, ['A', 'B'], {
      A: 'refers to <B>',
      B: 'resolved-b',
    });
    assert.equal(filled, 'A: refers to <B> B: resolved-b');
  });

  it('throws on a missing declared variable', () => {
    assert.throws(
      () => fillTemplate('<A>', ['A', 'B'], { A: 'x' }),
      /Missing value.*B/,
    );
  });

  it('throws on an unknown supplied variable', () => {
    assert.throws(
      () => fillTemplate('<A>', ['A'], { A: 'x', Z: 'y' }),
      /Unknown variable.*Z/,
    );
  });

  it('returns the template unchanged when no variables are declared', () => {
    assert.equal(fillTemplate('static text', [], {}), 'static text');
  });
});

// ---------------------------------------------------------------------------
// SECTION: CLI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SECTION: Frame + kind-block assembly (R10)
// ---------------------------------------------------------------------------

describe('fill-template: assembly', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-template-assembly-'));
  after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));
  const assemble = (...args) => {
    assert.equal(typeof fillTemplateModule.assembleTemplate, 'function', 'review/fill-template.mjs exports assembleTemplate');
    return fillTemplateModule.assembleTemplate(...args);
  };
  const write = (name, contents) => {
    const filePath = path.join(scratchDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
  };
  const FRAME = [
    '## Prompt template',
    '',
    '- `<Name>` — a shared value.',
    '',
    '````markdown',
    '<<slot:opener>>',
    'Hello <Name>',
    '<<slot:closing>>',
    '````',
    '',
  ].join('\n');
  const KIND = [
    '# Kind block',
    '',
    '- `<Kind>` — a kind value.',
    '',
    '## opener',
    '',
    'Review the <Kind> artifact.',
    '',
    '## closing',
    '',
    'Done.',
    '',
  ].join('\n');

  it('replaces every slot with its kind-block section and unions both variable lists', () => {
    const { template, variables } = assemble(write('frame.md', FRAME), write('kind.md', KIND));
    assert.equal(template.replace(/\s+/g, ' ').trim(), 'Review the <Kind> artifact. Hello <Name> Done.');
    assert.deepEqual([...variables].sort(), ['Kind', 'Name']);
    assert.equal(
      fillTemplate(template, variables, { Name: 'World', Kind: 'plan' }).replace(/\s+/g, ' ').trim(),
      'Review the plan artifact. Hello World Done.',
    );
  });

  it('throws on a slot with no kind-block section', () => {
    const kind = KIND.replace('## closing\n\nDone.\n', '');
    assert.throws(() => assemble(write('frame-missing.md', FRAME), write('kind-missing.md', kind)), /closing/);
  });

  it('throws on a kind-block section with no slot', () => {
    const kind = `${KIND}\n## extra\n\nUnused.\n`;
    assert.throws(() => assemble(write('frame-unused.md', FRAME), write('kind-unused.md', kind)), /extra/);
  });

  const TEMPLATES = path.join(PROJECT_ROOT, 'skills', 'dispatch', 'references', 'templates');
  const GOLDEN = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'review-prompt-golden');
  const normalize = (text) => text.replace(/\s+/g, ' ').trim();

  for (const kind of ['plan', 'code', 'design']) {
    it(`assembles the ${kind} review prompt to its whitespace-normalized golden`, () => {
      const assembled = assemble(path.join(TEMPLATES, 'review-prompt.md'), path.join(TEMPLATES, `review-prompt-${kind}.md`));
      const golden = extractTemplate(fs.readFileSync(path.join(GOLDEN, `review-prompt-${kind}.md`), 'utf8'));
      assert.equal(normalize(assembled.template), normalize(golden.template));
      assert.deepEqual([...assembled.variables].sort(), [...golden.variables].sort());
    });
  }

  for (const kind of ['plan', 'code', 'design']) {
    it(`assembles the ${kind} rebuttal from the shared frame with no unresolved slots`, () => {
      const assembled = assemble(path.join(TEMPLATES, 'rebuttal.md'), path.join(TEMPLATES, `rebuttal-${kind}.md`));
      assert.doesNotMatch(assembled.template, /<<slot:/);
      assert.match(assembled.template, /CONFIRM/);
      assert.match(assembled.template, /INTENT-DISPUTE/);
      assert.ok(assembled.variables.length > 0, `${kind} rebuttal declares variables`);
    });
  }

  it('design review prompt assembles with the shared reply contract', () => {
    const assembled = assemble(path.join(TEMPLATES, 'review-prompt.md'), path.join(TEMPLATES, 'review-prompt-design.md'));
    assert.doesNotMatch(assembled.template, /<<slot:/);
    assert.match(assembled.template, /"status":"CLEAN","findings":\[\]/);
  });
});
