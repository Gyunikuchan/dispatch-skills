import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { assembleTemplate, extractTemplate, fillTemplate, qualityBar, qualityCriteria, qualitySections, type QualityConsumer } from '../../../../skills/dispatch/scripts/toolkit/domain/prompt.ts';
import { reviewPrompt } from '../../../../skills/dispatch/scripts/toolkit/prompts.ts';
import { REVIEW_PROMPT_INPUTS } from '../../../fixtures/review-prompt-inputs.ts';
import {settledSection} from '../../../../skills/dispatch/scripts/toolkit/domain/prompt.ts';

test('rejected MUST prompt context settles only confirmed rejections',()=>{
 const pending={id:'R1-F001',locus:'§ Work',defect:'Unbounded writes',ruling:'rejected',reason:'Writes have a bound',severity:'MUST'};
 assert.equal(settledSection([pending]),'');
 assert.match(settledSection([{...pending,rejectionConfirmed:true}]),/Settled in earlier rounds/);
 assert.match(settledSection([{...pending,severity:'SHOULD'}]),/R1-F001/);
});

const templates = new URL('../../../../skills/dispatch/references/templates/', import.meta.url);
const golden = new URL('../../../fixtures/review-prompt-golden/', import.meta.url);
const read = (base: URL, name: string) => readFileSync(new URL(name, base), 'utf8');
const shared = (kind: QualityConsumer) => [qualityBar(read(templates, 'quality-bar.md'), kind)];

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

test('prompt assembly equals the golden per review kind', () => {
  const frame = read(templates, 'review-prompt.md');
  const standardsRule = 'Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.';
  const specRouting = 'Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.';
  const reuseCitation = 'Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`';
  const codeSpecCitation = 'Anchor a code `spec` finding on the changed code line and cite `§ Spec: <heading>` in `defect`';
  for (const kind of ['code', 'design', 'plan'] as const) {
    const { variables, template } = assembleTemplate(frame, read(templates, `review-prompt-${kind}.md`), undefined, shared(kind));
    assert.equal(`${fillTemplate(template, variables, REVIEW_PROMPT_INPUTS[kind])}\n`, read(golden, `${kind}.md`), kind);
    const prompt = fillTemplate(template, variables, REVIEW_PROMPT_INPUTS[kind]);
    assert.match(prompt, /Read the whole spec/);
    assert.ok(prompt.includes(REVIEW_PROMPT_INPUTS[kind]['Spec Hash']!));
    assert.doesNotMatch(prompt, /`intent-gap`|`spec-gap`/, kind);
    assert.equal(prompt.split(standardsRule).length - 1, 1, `${kind}: standards rule`);
    if (kind === 'code') {
      const against = read(templates, 'review-prompt-code.md').split(/^## against$/m)[1]!.split(/^## inspection$/m)[0]!;
      assert.ok(against.includes(reuseCitation));
      assert.ok(against.includes(codeSpecCitation));
      assert.ok(prompt.includes(reuseCitation));
      assert.ok(prompt.includes(codeSpecCitation));
    } else {
      assert.ok(prompt.includes(specRouting), kind);
      assert.match(prompt, /§ Spec: <heading>/);
    }
  }
});

const reviewKinds = ['code', 'plan', 'design'] as const;
const familyOrder = {
  shared: ['intent', 'maintainability'],
  spec: ['spec', 'usability'],
  code: ['spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'operability', 'testing', 'usability'],
  plan: ['intent', 'architecture', 'decomposition', 'testing'],
  design: ['intent', 'architecture', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'operability', 'testing', 'usability', 'decomposition'],
} as const;
const tagOrder = {
  code: ['intent', 'spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'maintainability', 'operability', 'testing', 'usability', 'standards', 'adjacent'],
  plan: ['intent', 'spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'maintainability', 'architecture', 'decomposition', 'operability', 'testing', 'usability', 'standards', 'adjacent'],
  design: ['intent', 'spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'maintainability', 'architecture', 'decomposition', 'operability', 'testing', 'usability', 'standards', 'adjacent'],
} as const;
const rotateExpected = <T,>(items: readonly T[], by: number): T[] => {
  const shift = items.length ? ((by % items.length) + items.length) % items.length : 0;
  return [...items.slice(shift), ...items.slice(0, shift)];
};
const reviewContext = (kind: typeof reviewKinds[number], rotation = 0) => ({
  skillRoot: path.resolve('skills/dispatch'),
  spec: {path: REVIEW_PROMPT_INPUTS[kind]['Spec Path']!, hash: REVIEW_PROMPT_INPUTS[kind]['Spec Hash']!},
  artifact: REVIEW_PROMPT_INPUTS[kind][kind === 'design' ? 'Design Path' : 'Plan Path']!,
  ...(kind === 'code' ? {planPath: REVIEW_PROMPT_INPUTS.code['Plan Path']!, taskSummary: REVIEW_PROMPT_INPUTS.code['Task Summary']!} : {}),
  scope: REVIEW_PROMPT_INPUTS[kind]['Review Scope']!,
  rotation,
});
const sectionBullets = (prompt: string, heading: string): string[] => {
  const lines = prompt.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading} section`);
  const body: string[] = [];
  for (let index = start + 1; index < lines.length && !/^#{1,6}\s/.test(lines[index]!); index++) {
    if (/^- `[^`]+`$/.test(lines[index]!)) body.push(lines[index]!.match(/`([^`]+)`/)![1]!);
  }
  return body;
};
const familyBullets = (prompt: string): string[] => [...prompt.matchAll(/^- \*\*([^*]+)\*\* —/gm)].map((match) => match[1]!);
const linePositions = (prompt: string, marker: string): number[] => prompt.split('\n').flatMap((line, index) => line.includes(marker) ? [index] : []);

test('review voices receive identical guidance in rotated axis order', () => {
  const sharedFixedLines = [
    'Precedence: Applicable host rule files govern first.',
    'Host rules override only this bar.',
  ];
  for (const kind of reviewKinds) {
    const base = reviewPrompt(kind, reviewContext(kind));
    const fixedLines = [
      ...sharedFixedLines,
      ...(kind === 'code' || kind === 'plan' ? ['- Tooling: skip issues that configured linters, formatters, or type checkers enforce.'] : []),
      ...(kind === 'plan' ? ['- Code criteria: apply the code section to proposed changes and touched interfaces at planning altitude; do not require written implementation.'] : []),
      ...(kind === 'plan' || kind === 'design' ? ['### Visual-aid bar', '| Components and boundaries | Architecture diagram |'] : []),
    ];
    const familySections = qualitySections[kind] as readonly (keyof typeof familyOrder)[];
    const familyCounts = familySections.map((section) => familyOrder[section].length);
    const cycle = [tagOrder[kind].length, ...familyCounts].reduce((left, right) => left / gcd(left, right) * right, 1);
    for (const rotation of [0, 1, 2, cycle]) {
      const prompt = reviewPrompt(kind, reviewContext(kind, rotation));
      assert.deepEqual(sectionBullets(prompt, '### Tags'), rotateExpected(tagOrder[kind], rotation), `${kind}: tags at rotation ${rotation}`);
      const actualFamilies = familyBullets(prompt);
      let offset = 0;
      for (let index = 0; index < familySections.length; index++) {
        const section = familySections[index]!;
        const count = familyCounts[index]!;
        assert.deepEqual(actualFamilies.slice(offset, offset + count), rotateExpected(familyOrder[section], rotation), `${kind}: ${section} at rotation ${rotation}`);
        offset += count;
      }
      assert.deepEqual([...prompt.split('\n')].sort(), [...base.split('\n')].sort(), `${kind}: line multiset at rotation ${rotation}`);
      for (const marker of fixedLines) {
        const positions = linePositions(base, marker);
        assert.ok(positions.length, `${kind}: missing fixed line ${marker}`);
        assert.deepEqual(linePositions(prompt, marker), positions, `${kind}: fixed line ${marker}`);
      }
      if (rotation === cycle) assert.equal(prompt, base, `${kind}: wraparound`);
    }
  }
});

test('rotation zero matches the golden prompt', () => {
  for (const kind of reviewKinds) assert.equal(`${reviewPrompt(kind, reviewContext(kind))}\n`, read(golden, `${kind}.md`), kind);
});

function gcd(left: number, right: number): number {
  while (right) [left, right] = [right, left % right];
  return left;
}

test('prompt: a slot without a kind section, or a section without a slot, throws', () => {
  const frame = '## Prompt template\n````markdown\n<<slot:a>>\n````\n';
  assert.throws(() => assembleTemplate(frame, '## b\ntext\n'), /no section for slot/);
  assert.throws(() => assembleTemplate(frame, '## a\nx\n## b\ny\n'), /no frame slot/);
});

test('prompt: a shared kind block fills its frame slot and adds its declared variables', () => {
  const frame = '## Prompt template\n- `<A>` — frame\n````markdown\n<<slot:a>> <<slot:b>>\n````\n';
  const { variables, template } = assembleTemplate(frame, '## a\nkind\n', undefined, ['- `<S>` — shared\n\n## b\nshared <S>\n']);
  assert.equal(template, 'kind shared <S>');
  assert.deepEqual(variables, ['A', 'S']);
});

test('prompt: a section declared in both a kind and a shared kind block throws', () => {
  const frame = '## Prompt template\n````markdown\n<<slot:a>> <<slot:b>>\n````\n';
  assert.throws(() => assembleTemplate(frame, '## a\nx\n## b\ny\n', undefined, ['## b\nz\n']), /declares section "b" twice/);
  assert.throws(() => assembleTemplate(frame, '## a\nx\n', undefined, ['## b\ny\n', '## b\nz\n']), /declares section "b" twice/);
});

// SECTION: Plan-review severity calibration

const CALIBRATION = "In plan reviews, MUST means the plan as written cannot deliver its outcome or breaks a binding constraint. A gap that the plan's own Verify gates would surface deterministically during implementation, such as a fixture update or a test assertion, is SHOULD.";
const assembled = (kind: QualityConsumer) => assembleTemplate(read(templates, 'review-prompt.md'), read(templates, `review-prompt-${kind}.md`), undefined, shared(kind)).template;

test('plan prompt calibrates MUST', () => {
  const flat = assembled('plan').replace(/\s+/g, ' ');
  assert.ok(flat.includes(`\`CONSIDER\`: optional improvement; no defect. ${CALIBRATION} In \`defect\`, state`), flat);
});

test('code and design prompts omit severity calibration', () => {
  assert.match(extractTemplate(read(templates, 'review-prompt.md')).template, /improvement; no defect\.\n<<slot:severity>>\nIn `defect`/);
  for (const kind of ['code', 'design'] as const) {
    const template = assembled(kind);
    assert.match(template, /improvement; no defect\.\nIn `defect`/, kind);
    assert.ok(!template.includes('In plan reviews') && !template.includes('<<slot:'), kind);
  }
});

// SECTION: Grounding, tooling, and reuse rules

const flat = (kind: QualityConsumer) => assembled(kind).replace(/\s+/g, ' ');

test('review prompts: every kind grounds findings and reports a defective local convention once', () => {
  for (const kind of ['code', 'design', 'plan'] as const) {
    const text = flat(kind);
    for (const rule of [
      'Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known vulnerability class.',
      "Preference is not a finding; between technically equivalent approaches, the author's choice stands.",
      'Simplicity findings name the cost removed: concepts, files, or code paths.',
      'A pattern that matches established local convention is not a finding; when the convention itself is defective, report it once and name the other instances in `defect`.',
    ]) assert.ok(text.includes(rule), `${kind}: ${rule}`);
  }
});

test('quality selection: reuse applies to every consumer and code tooling applies to code and plan', () => {
  for (const kind of ['code', 'plan', 'design'] as const) {
    assert.ok(flat(kind).includes('search the repository by name and behaviour for an existing equivalent'));
    assert.equal(flat(kind).includes('skip issues that configured linters, formatters, or type checkers enforce.'), kind !== 'design');
    assert.equal(flat(kind).includes('Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`'), kind === 'code');
    assert.equal(flat(kind).includes('Reuse searches do not count toward the target.'), kind === 'code');
  }
});

const ruleText = (kind: QualityConsumer) => qualityBar(read(templates, 'quality-bar.md'), kind).replace(/\s+/g, ' ');

test('quality selection: code and plan reviews name data-access and exposure risks', () => {
  for (const kind of ['code', 'plan'] as const) {
    for (const term of ['N+1', 'unpaginated reads', 'index new filter or sort columns', 'object ownership', 'sensitive data in logs']) assert.ok(ruleText(kind).includes(term), `${kind}: ${term}`);
  }
});

// SECTION: Quality bar and host-rule precedence

test('quality selection: every review contains each selected rule once and excludes other sections', () => {
  const bar = read(templates, 'quality-bar.md');
  const sectionMarkers = [
    ['shared', 'gold-plating'],
    ['spec', 'IEEE 29148 quality'],
    ['code', 'OWASP/CWE'],
    ['plan', 'INVEST task sizing'],
    ['design', 'Weigh alternatives'],
  ] as const;
  for (const kind of ['code', 'plan', 'design'] as const) {
    const prompt = assembled(kind);
    const quality = qualityBar(bar, kind).split('## quality\n\n')[1]!;
    assert.equal(prompt.split(quality).length, 2, kind);
    for (const [section, marker] of sectionMarkers) {
      assert.equal(prompt.split(marker).length - 1, (qualitySections[kind] as readonly string[]).includes(section) ? 1 : 0, `${kind}: ${section}`);
    }
  }
});

test('quality selection rejects missing, empty, duplicate sections and invalid consumers', () => {
  const expected = { code: ['shared', 'code'], writer: ['shared', 'code'], plan: ['shared', 'spec', 'plan', 'code'], design: ['shared', 'spec', 'design'] };
  assert.deepEqual(qualitySections, expected);
  const sections = ['shared', 'spec', 'code', 'plan', 'design'];
  const bar = sections.map((section) => `## ${section}\n${section} rule`).join('\n');
  for (const [consumer, selected] of Object.entries(expected)) {
    assert.equal(qualityBar(bar, consumer as QualityConsumer), `## quality\n\n${selected.map((section) => `${section} rule`).join('\n\n')}`);
    for (const section of selected) {
      assert.throws(() => qualityBar(bar.replace(`## ${section}\n${section} rule`, ''), consumer as QualityConsumer), { message: `Missing quality section: ${section}` });
      assert.throws(() => qualityBar(bar.replace(`${section} rule`, '  \n\t'), consumer as QualityConsumer), { message: `Empty quality section: ${section}` });
    }
  }
  assert.throws(() => qualityBar(bar + '\n## shared\nagain', 'code'), /declares section "shared" twice/);
  for (const consumer of ['ask', '__proto__', 'toString']) assert.throws(() => qualityBar(bar, consumer as QualityConsumer), { message: `Unknown quality consumer: ${consumer}` });
  assert.equal(qualityBar('## shared\nshared\n```markdown\n## code\nfenced\n```\n## code\nreal', 'code'), '## quality\n\nshared\n```markdown\n## code\nfenced\n```\n\nreal');
});

test('review prompts: host rules take precedence over dispatch defaults in every kind', () => {
  const bar = read(templates, 'quality-bar.md');
  const discoveryRule = 'before judging or editing, find every file that sets conventions for in-scope paths';
  for (const kind of ['code', 'design', 'plan'] as const) {
    const text = flat(kind);
    assert.equal(text.split('Applicable host rule files govern first.').length, 2, kind);
    assert.equal(text.split('This bar supplements host rules where they are silent and yields where they conflict.').length, 2, kind);
    assert.equal(text.split(discoveryRule).length - 1, 1, `${kind}: host-rule discovery`);
  }
  assert.equal(qualityCriteria(bar, 'writer').split(discoveryRule).length - 1, 1, 'writer: host-rule discovery');
  const inspection = read(templates, 'review-prompt.md').split(/^### Inspection\s*$/m)[1]!.split(/^### /m)[0]!;
  assert.doesNotMatch(inspection, /AGENTS\.md/);
});

// SECTION: Durable test bar and plan-free naming

test('quality selection: reviews hold retained tests to the durable bar', () => {
  for (const kind of ['code', 'plan'] as const) {
    const text = ruleText(kind);
    assert.ok(text.includes('Apply one behavioral bar to new, changed, and retained tests.'), kind);
    if (kind === 'plan') {
      for (const term of ["code section's test policy", 'repair the rationale or test', 'demote the criterion to transient', 'remove it when redundant']) assert.ok(text.includes(term), `${kind}: ${term}`);
      const prompt = flat(kind);
      for (const term of [
        '`<skills-dir>/dispatch/references/templates/plan.md#field-notes`',
        'test selectors and named-test matching',
        '`[FINAL]` gate classification',
        'transient-test placement',
        'treat any violation as a defect',
      ]) assert.ok(prompt.includes(term), `${kind}: ${term}`);
    }
  }
  assert.ok(ruleText('code').includes('classify intermediate step, helper and branch-permutation checks as transient for removal after review'));
});

test('review prompts: prompts keep plan IDs out of tests', () => {
  const text = flat('code');
  for (const term of ['name tests, describe blocks, test files, comments, section headers, and fixtures for behavior', 'never reference plan artifacts such as criterion, task, or finding IDs, plan paths, or session paths']) assert.ok(text.includes(term), term);
});

test('quality selection keeps artifact finding loci in review kind blocks', () => {
  const bar = read(templates, 'quality-bar.md');
  for (const consumer of ['code', 'writer', 'plan', 'design'] as const) assert.doesNotMatch(qualityBar(bar, consumer), /Adjacent findings|nearest plan|nearest design/);
  for (const consumer of ['plan', 'design'] as const) {
    const kindBlock = read(templates, `review-prompt-${consumer}.md`);
    assert.match(kindBlock, new RegExp(`nearest ${consumer} heading as locus`));
    assert.doesNotMatch(kindBlock, new RegExp(`nearest ${consumer === 'plan' ? 'design' : 'plan'} heading`));
  }
});
