import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { assembleTemplate, extractDocumentLayers, extractTemplate, fillTemplate, qualityBar, qualityCriteria, qualitySections, type QualityConsumer } from '../../../../skills/dispatch/scripts/toolkit/domain/prompt.ts';
import { reviewPrompt } from '../../../../skills/dispatch/scripts/toolkit/prompts.ts';
import { REVIEW_PROMPT_INPUTS } from '../../../fixtures/review-prompt-inputs.ts';
import {settledSection, type Settled} from '../../../../skills/dispatch/scripts/toolkit/domain/prompt.ts';

test('rejected MUST prompt context settles only confirmed rejections',()=>{
 const pending={id:'R1-F001',locus:'§ Work',defect:'Unbounded writes',ruling:'rejected',reason:'Writes have a bound',severity:'MUST'};
 assert.equal(settledSection([pending]),'');
 assert.match(settledSection([{...pending,rejectionConfirmed:true}]),/Settled in earlier rounds/);
 assert.match(settledSection([{...pending,severity:'SHOULD'}]),/R1-F001/);
});

const settledRows = (section: string) => section.split('\n').filter((line) => line.startsWith('- '));

test('settled accepted rows drop rationale', () => {
  const accepted = {id: 'R3-F001', locus: '§ Tasks', defect: 'First line of the defect.\nSecond line elaborates.', ruling: 'accepted', reason: 'Applied the fix in the reworked section.'};
  assert.deepEqual(settledRows(settledSection([accepted])), ['- R3-F001 § Tasks: First line of the defect. — accepted']);
  const clipped = {...accepted, id: 'R3-F002', defect: `${'x'.repeat(130)}\nmore`};
  assert.deepEqual(settledRows(settledSection([clipped])), [`- R3-F002 § Tasks: ${'x'.repeat(119)}… — accepted`]);
  assert.match(settledSection([{...accepted, revision: 'abc1234'}], true), /— accepted \(reviewed revision abc1234\)$/m);
  const must = {...accepted, id: 'R3-F003', severity: 'MUST', defect: `${'y'.repeat(130)}\nSecond line elaborates with more detail.`};
  const mustSection = settledSection([must]);
  assert.ok(mustSection.includes('y'.repeat(130)), 'accepted MUST preserves full defect');
  assert.ok(mustSection.includes('Second line elaborates with more detail.'), 'accepted MUST preserves second line');
  assert.doesNotMatch(mustSection, /…/, 'accepted MUST is not clipped');
});

test('settled duplicate rows keep original id', () => {
  const duplicate = {id: 'R4-F002', locus: '§ Tasks', defect: 'A repeated defect.', ruling: 'duplicate', reason: 'Duplicate of R1-F004.'};
  assert.deepEqual(settledRows(settledSection([duplicate])), ['- R4-F002 § Tasks: A repeated defect. — duplicate: Duplicate of R1-F004.']);
  const clipped = {...duplicate, id: 'R4-F003', defect: `${'y'.repeat(130)}\nmore`, reason: 'z'.repeat(140)};
  assert.deepEqual(settledRows(settledSection([clipped])), [`- R4-F003 § Tasks: ${'y'.repeat(119)}… — duplicate: ${'z'.repeat(119)}…`]);
  const ownFirst = settledRows(settledSection([{id: 'R4-F004', locus: '§ Tasks', defect: 'A repeated defect.', ruling: 'duplicate', reason: `R4-F004 repeats the point. ${'z'.repeat(130)} R1-F004`}]))[0]!;
  assert.match(ownFirst, /R1-F004/);
  const labeled = settledRows(settledSection([{id: 'R4-F005', locus: '§ Tasks', defect: 'A repeated defect.', ruling: 'duplicate', reason: `${'z'.repeat(130)} Duplicate of R1-F006`}]))[0]!;
  assert.match(labeled, /R1-F006/);
  const visible = settledRows(settledSection([{id: 'R4-F007', locus: '§ Tasks', defect: 'A repeated defect.', ruling: 'duplicate', reason: `Duplicate of R1-F004. ${'z'.repeat(130)} R2-F005`}]))[0]!;
  assert.match(visible, /R1-F004/);
  assert.doesNotMatch(visible, /R2-F005/);
  const labeledOwn = settledRows(settledSection([{id: 'R4-F008', locus: '§ Tasks', defect: 'A repeated defect.', ruling: 'duplicate', reason: `Duplicate of R4-F008. ${'z'.repeat(130)} R1-F006`}]))[0]!;
  assert.match(labeledOwn, /R1-F006/);
  const nearCutoff = settledRows(settledSection([{id: 'R4-F009', locus: '§ Tasks', defect: 'A repeated defect.', ruling: 'duplicate', reason: `Duplicate of R1-F001 ${'z'.repeat(110)} R2-F009`}]))[0]!;
  assert.match(nearCutoff, /R1-F001/);
  assert.doesNotMatch(nearCutoff, /R2-F009/);
  assert.match(settledRows(settledSection([{id: 'R4-F006', locus: '§ Tasks', defect: 'A repeated defect.', ruling: 'duplicate', reason: 'No original id.'}]))[0]!, /duplicate: No original id\./);
});

test('settled rejected rows keep full rationale', () => {
  const rejected = {id: 'R1-F003', locus: '§ T2', defect: 'Full defect text\nwith a second line.', ruling: 'rejected', reason: 'Full rationale that explains the rejection.'};
  const deferred = {...rejected, id: 'R1-F004', defect: 'Deferred defect.', ruling: 'deferred', reason: 'Deferred as a follow-up.'};
  const section = settledSection([rejected, deferred]);
  for (const entry of [rejected, deferred]) assert.ok(section.includes(`- ${entry.id} ${entry.locus}: ${entry.defect} — ${entry.ruling}: ${entry.reason}`), entry.id);
  assert.ok(!section.includes('…'), 'ruled rows keep the full text');
});

// Rendered size of this fixture under the pre-compaction row format, recorded before the format changed.
const SETTLED_ROUND_7_BASELINE_BYTES = 25570;

test('settled section halves round-7 fixture', () => {
  const settled = JSON.parse(readFileSync(new URL('./fixtures/settled-round-7.json', import.meta.url), 'utf8')) as Settled[];
  assert.equal(settled.length, 49, 'fixture keeps the recorded settled set');
  const bytes = Buffer.byteLength(settledSection(settled), 'utf8');
  assert.ok(bytes <= SETTLED_ROUND_7_BASELINE_BYTES / 2, `${bytes} B exceeds half of the recorded ${SETTLED_ROUND_7_BASELINE_BYTES} B baseline`);
});

const templates = new URL('../../../../skills/dispatch/references/templates/', import.meta.url);
const golden = new URL('../../../fixtures/review-prompt-golden/', import.meta.url);
const read = (base: URL, name: string) => readFileSync(new URL(name, base), 'utf8');
const specStage = read(templates, '../spec-stage.md');
const shared = (kind: QualityConsumer) => [qualityBar(read(templates, 'quality-bar.md'), kind, 0, specStage), read(templates, 'review-severity.md'), '## rereview\n'];

test('prompt fill validates declared values single-pass', () => {
  assert.throws(() => fillTemplate('<A> <B>', ['A', 'B'], { A: '1' }), /Missing value\(s\) for declared variable\(s\): B/);
  assert.throws(() => fillTemplate('<A>', ['A'], { A: '1', C: '3' }), /Unknown variable\(s\).*C/);
  assert.equal(fillTemplate('<A> at <file>:L<line> tag <tag>', ['A'], { A: '<A> <tag>' }), '<A> <tag> at <file>:L<line> tag <tag>');
});

test('prompt: declared variables and body are extracted from the Markdown template', () => {
  const { variables, template } = extractTemplate('# X\n\n## Prompt template\n- `<Name>` — who\n````markdown\nHi <Name>\n````\n');
  assert.deepEqual(variables, ['Name']);
  assert.equal(fillTemplate(template, variables, { Name: 'Ada' }), 'Hi Ada');
});

test('assembles prompt matching golden per review kind', () => {
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
    assert.doesNotMatch(prompt, /\]\(quality-bar\.md/, kind);
    assert.ok(prompt.includes(REVIEW_PROMPT_INPUTS[kind]['Spec Hash']!));
    assert.equal(prompt.split(standardsRule).length - 1, 1, `${kind}: standards rule`);
    assert.match(prompt, /A reviewer may run a host read tool that creates or updates only its own cache or index/);
    assert.doesNotMatch(prompt, /A native reviewer/);
    assert.equal(prompt.split('Read directly; launch no subagents.').length - 1, 1, `${kind}: reviewer subagent bar`);
    assert.doesNotMatch(prompt, /delegation already permitted/, kind);
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
  shared: ['intent', 'maintainability', 'correctness', 'reliability', 'security', 'performance', 'compatibility', 'operability', 'usability'],
  spec: ['spec'],
  code: ['spec'],
  testing: ['testing'],
  plan: ['architecture', 'decomposition'],
  design: ['architecture', 'testing', 'decomposition'],
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
  turnTarget: 10,
  rotation,
  round: 1,
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
      ...(kind === 'plan' ? ['- Shared criteria: apply the shared section to proposed changes and touched interfaces at planning altitude; do not require written implementation.'] : []),
      ...(kind === 'plan' || kind === 'design' ? ['- Visuals, summaries, and callouts:'] : []),
    ];
    const familySections = qualitySections[kind] as readonly (keyof typeof familyOrder)[];
    const familyCounts = familySections.map((section) => familyOrder[section].length);
    const cycle = [tagOrder[kind].length, ...familyCounts].reduce<number>((left, right) => left / gcd(left, right) * right, 1);
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

function gcd(left: number, right: number): number {
  while (right) [left, right] = [right, left % right];
  return left;
}

test('assembleTemplate binds slots and rejects mismatches', () => {
  const frame = '## Prompt template\n````markdown\n<<slot:a>> <<slot:b>>\n````\n';
  const single = '## Prompt template\n````markdown\n<<slot:a>>\n````\n';
  assert.throws(() => assembleTemplate(single, '## b\ntext\n'), /no section for slot/);
  assert.throws(() => assembleTemplate(single, '## a\nx\n## b\ny\n'), /no frame slot/);
  assert.throws(() => assembleTemplate(frame, '## a\nx\n## b\ny\n', undefined, ['## b\nz\n']), /declares section "b" twice/);
  assert.throws(() => assembleTemplate(frame, '## a\nx\n', undefined, ['## b\ny\n', '## b\nz\n']), /declares section "b" twice/);
  const { variables, template } = assembleTemplate('## Prompt template\n- `<A>` — frame\n````markdown\n<<slot:a>> <<slot:b>>\n````\n', '## a\nkind\n', undefined, ['- `<S>` — shared\n\n## b\nshared <S>\n']);
  assert.equal(template, 'kind shared <S>');
  assert.deepEqual(variables, ['A', 'S']);
});

// SECTION: Severity rubric

const CALIBRATION = "In plan reviews, `blocks` means the plan as written cannot deliver its outcome or breaks a binding constraint. A gap that the plan's own Verify gates would surface deterministically during implementation, such as a fixture update or a test assertion, is `degrades`, not `blocks`.";
const assembled = (kind: QualityConsumer) => assembleTemplate(read(templates, 'review-prompt.md'), read(templates, `review-prompt-${kind}.md`), undefined, shared(kind)).template;
const rubricBody = () => read(templates, 'review-severity.md').split(/^## rubric$/m)[1]!.trim();

test('all kinds share an identical severity rubric', () => {
  const rubric = rubricBody();
  for (const kind of ['code', 'design', 'plan'] as const) {
    const prompt = readFileSync(new URL(`${kind}.md`, golden), 'utf8');
    assert.ok(prompt.includes(rubric), `${kind}: rubric text`);
    const reply = prompt.split('\n').find((line) => line.startsWith('{"status":"FINDINGS"'))!;
    assert.ok(reply.includes('"findings":[{"impact":"critical|blocks|degrades|minor","trigger":"realistic|contrived","locus"'), kind);
    assert.doesNotMatch(reply, /"severity"/, kind);
  }
  assert.ok(flat('plan').includes(CALIBRATION));
  for (const kind of ['code', 'design'] as const) {
    const template = assembled(kind);
    assert.ok(!template.includes('Verify gates') && !template.includes('<<slot:'), kind);
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

const ruleText = (kind: QualityConsumer) => qualityBar(read(templates, 'quality-bar.md'), kind, 0, specStage).replace(/\s+/g, ' ');

test('quality selection: reuse applies to every consumer and code tooling applies to code and plan', () => {
  for (const kind of ['code', 'plan', 'design'] as const) {
    assert.ok(flat(kind).includes('search the repository by name and behaviour for an existing equivalent'));
    assert.equal(flat(kind).includes('skip issues that configured linters, formatters, or type checkers enforce.'), kind !== 'design');
    assert.equal(flat(kind).includes('Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`'), kind === 'code');
    assert.equal(flat(kind).includes('Reuse searches do not count toward the target.'), kind === 'code');
  }
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
    ['code', 'Treat ambiguous or contradictory governing text'],
    ['testing', 'Unique kill'],
    ['plan', 'INVEST task sizing'],
    ['design', 'Weigh alternatives'],
  ] as const;
  for (const kind of ['code', 'plan', 'design'] as const) {
    const prompt = assembled(kind);
    const quality = qualityBar(bar, kind, 0, specStage).split('## quality\n\n')[1]!;
    assert.equal(prompt.split(quality).length, 2, kind);
    for (const [section, marker] of sectionMarkers) {
      assert.equal(prompt.split(marker).length - 1, (qualitySections[kind] as readonly string[]).includes(section) ? 1 : 0, `${kind}: ${section}`);
    }
  }
});

test('quality selection rejects missing, empty, duplicate sections and invalid consumers', () => {
  const expected = { code: ['shared', 'code', 'testing'], writer: ['shared', 'code', 'testing'], plan: ['shared', 'spec', 'plan', 'testing'], design: ['shared', 'spec', 'design'], cleanup: ['shared', 'testing'], explorer: ['shared'] };
  assert.deepEqual(qualitySections, expected);
  const bar = compliantBar();
  for (const [consumer] of Object.entries(expected)) {
    const rendered = qualityBar(bar, consumer as QualityConsumer, 0, specStage);
    assert.doesNotMatch(rendered, /for:/, `${consumer}: no audience tag leaks`);
    assert.doesNotMatch(rendered, /<!--/, `${consumer}: no comment leaks`);
  }
  for (const consumer of Object.keys(expected)) {
    for (const section of (expected as Record<string, readonly string[]>)[consumer]!) {
      const missingBar = removeSection(bar, section);
      assert.throws(() => qualityBar(missingBar, consumer as QualityConsumer, 0, specStage), { message: `Missing quality section: ${section}` });
      const emptyBar = emptySection(bar, section);
      assert.throws(() => qualityBar(emptyBar, consumer as QualityConsumer, 0, specStage), /Empty quality section|Tagged bullet count/);
    }
  }
  assert.throws(() => qualityBar(bar + '\n## shared\nagain', 'code', 0, specStage), /declares section "shared" twice/);
  for (const consumer of ['ask', '__proto__', 'toString']) assert.throws(() => qualityBar(bar, consumer as QualityConsumer, 0, specStage), { message: `Unknown quality consumer: ${consumer}` });
  assert.ok(qualityBar(fencedBar(), 'code', 0, specStage).includes('real'), 'fenced heading does not split sections');
});

test('audience tags select bullets per consumer and hide tags and author text', () => {
  const bar = compliantBar();
  for (const consumer of ['code', 'writer', 'plan', 'design', 'cleanup', 'explorer'] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.doesNotMatch(criteria, /<!--/, `${consumer}: no tag comment leaks`);
    assert.doesNotMatch(criteria, /for:/, `${consumer}: no tag text leaks`);
    assert.doesNotMatch(criteria, /Author-only/, `${consumer}: author text never renders`);
  }
  const writer = qualityCriteria(bar, 'writer', 0, specStage);
  assert.ok(writer.includes('Report host-rule/brief conflicts under concerns.'), 'writer report clause');
  assert.ok(writer.includes('No Git write commands.'), 'writer git rule');
  assert.ok(writer.includes('Writer focus'), 'writer focus');
  assert.doesNotMatch(writer, /Exclude host-rule\/brief conflicts from findings\./, 'writer no reviewer clause');
  assert.doesNotMatch(writer, /^- Prune:/m, 'writer no prune');
  for (const consumer of ['code', 'plan', 'design'] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.ok(criteria.includes('Exclude host-rule/brief conflicts from findings.'), `${consumer} reviewer clause`);
    assert.doesNotMatch(criteria, /Report host-rule\/brief conflicts under concerns\./, `${consumer} no writer clause`);
  }
  assert.ok(qualityCriteria(bar, 'code', 0, specStage).includes('Prune:'), 'code prune');
  assert.ok(qualityCriteria(bar, 'cleanup', 0, specStage).includes('Run no Git write commands'), 'cleanup git rule');
  assert.ok(qualityCriteria(bar, 'cleanup', 0, specStage).includes('Prune:'), 'cleanup prune');
  assert.ok(qualityCriteria(bar, 'cleanup', 0, specStage).includes('Report host-rule/brief conflicts under concerns.'), 'cleanup report clause');
  const explorer = qualityCriteria(bar, 'explorer', 0, specStage);
  assert.ok(explorer.includes('Host rule files'), 'explorer host rules');
  assert.ok(explorer.includes('Precedence'), 'explorer precedence');
  assert.ok(explorer.includes('Evidence'), 'explorer evidence');
  assert.doesNotMatch(explorer, /Untagged shared/, 'explorer drops untagged');
  assert.doesNotMatch(explorer, /Report host-rule/, 'explorer drops writer clause');
  assert.doesNotMatch(explorer, /Exclude host-rule/, 'explorer drops reviewer clause');
  const realBar = read(templates, 'quality-bar.md');
  for (const consumer of ['code', 'writer', 'plan', 'design', 'cleanup', 'explorer'] as const) {
    assert.doesNotMatch(qualityCriteria(realBar, consumer, 0, specStage), /<!--/, `${consumer}: real bar hides tags`);
  }
  assert.ok(qualityCriteria(realBar, 'writer', 0, specStage).includes('No Git write commands.'), 'real writer git');
  assert.ok(qualityCriteria(realBar, 'cleanup', 0, specStage).includes('Run no Git write commands'), 'real cleanup git');
});

test('audience selection fails closed on unknown consumers tags counts layers and empty renders', () => {
  const bar = compliantBar();
  for (const consumer of ['ask', 'bogus', '__proto__'] as const) {
    assert.throws(() => qualityCriteria(bar, consumer as QualityConsumer, 0, specStage), /Unknown quality consumer/);
  }
  assert.throws(() => qualityCriteria(bar.replace('<!-- for: all -->', '<!-- for: bogus -->'), 'code', 0, specStage), /Unknown audience tag/);
  assert.throws(() => qualityCriteria('## shared\n<!-- for: writer -->\n- Only writer.\n## code\n- Code.\n## testing\n- Testing.', 'code', 0, specStage), /Empty quality section|Tagged bullet count/);
  assert.throws(() => qualityCriteria('## shared\n- shared without layers link\n## code\n- Code.\n## testing\n- Testing.', 'code', 0, specStage), /document layers|Tagged bullet count/);
  const noLayers = bar.replace('[document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers.', 'document layers missing.');
  assert.throws(() => qualityCriteria(noLayers, 'code', 0, specStage), /document layers/);
  const dangling = bar.replace('<!-- for: writer -->\n- No Git write commands.', '<!-- for: writer -->');
  assert.throws(() => qualityCriteria(dangling, 'writer', 0, specStage), /Audience tag|Tagged bullet count|Empty quality section/);
  assert.throws(() => qualityCriteria(bar.replace('<!-- for: code,plan,design,cleanup -->\n- Prune: prune.', '- Prune: prune.'), 'code', 0, specStage), /Tagged bullet count/);
  assert.throws(() => qualityCriteria(bar.replace('<!-- for: all -->\n- Evidence: evidence.', '- Evidence: evidence.'), 'explorer', 0, specStage), /Tagged bullet count/);
});

function compliantBar(): string {
  return [
    '## shared',
    '<!-- for: all -->',
    '- Host rule files: host rules.',
    '<!-- for: all -->',
    '- Precedence: precedence.',
    '<!-- for: all -->',
    '- Evidence: evidence.',
    '<!-- for: writer,cleanup -->',
    '- Host rules override only this bar. Report host-rule/brief conflicts under concerns.',
    '<!-- for: code,plan,design -->',
    '- Host rules override only this bar. Exclude host-rule/brief conflicts from findings.',
    '<!-- for: writer -->',
    '- No Git write commands.',
    '<!-- for: cleanup -->',
    '- Run no Git write commands (add, stash, commit, checkout, reset, restore).',
    '- Untagged shared. Check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers. tail.',
    '<!-- for: author -->',
    '- Author-only: never rendered.',
    '## spec',
    '- Spec rule.',
    '## code',
    '- Code rule.',
    '## testing',
    '<!-- for: writer -->',
    '- Writer focus.',
    '<!-- for: code,plan,design,cleanup -->',
    '- Prune: prune.',
    '- Untagged testing.',
    '## plan',
    '- Plan rule.',
    '## design',
    '- Design rule.',
  ].join('\n');
}

function removeSection(bar: string, section: string): string {
  const lines = bar.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^##\s+(\S.*?)\s*$/.exec(line)?.[1];
    if (heading) skipping = heading === section;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function emptySection(bar: string, section: string): string {
  const lines = bar.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const heading = /^##\s+(\S.*?)\s*$/.exec(line)?.[1];
    if (heading) {
      inside = heading === section;
      out.push(line);
      continue;
    }
    if (inside) continue;
    out.push(line);
  }
  return out.join('\n');
}

function fencedBar(): string {
  return [
    '## shared',
    '<!-- for: all -->',
    '- Host rule files: host rules.',
    '<!-- for: all -->',
    '- Precedence: precedence.',
    '<!-- for: all -->',
    '- Evidence: evidence.',
    '<!-- for: writer,cleanup -->',
    '- Host rules override only this bar. Report host-rule/brief conflicts under concerns.',
    '<!-- for: code,plan,design -->',
    '- Host rules override only this bar. Exclude host-rule/brief conflicts from findings.',
    '<!-- for: writer -->',
    '- No Git write commands.',
    '<!-- for: cleanup -->',
    '- Run no Git write commands (add, stash, commit, checkout, reset, restore).',
    '- Untagged shared. Check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers. tail.',
    '## code',
    '```markdown',
    '## code',
    'fenced',
    '```',
    'real',
    '## testing',
    '<!-- for: writer -->',
    '- Writer focus.',
    '<!-- for: code,plan,design,cleanup -->',
    '- Prune: prune.',
    '- Untagged testing.',
  ].join('\n');
}

test('review prompts: host rules take precedence over dispatch defaults in every kind', () => {
  const bar = read(templates, 'quality-bar.md');
  const discoveryRule = 'before judging or editing, find every file that sets conventions for in-scope paths';
  for (const kind of ['code', 'design', 'plan'] as const) {
    const text = flat(kind);
    assert.equal(text.split('Applicable host rule files govern first.').length, 2, kind);
    assert.equal(text.split('This bar supplements host rules where they are silent and yields where they conflict.').length, 2, kind);
    assert.equal(text.split(discoveryRule).length - 1, 1, `${kind}: host-rule discovery`);
  }
  assert.equal(qualityCriteria(bar, 'writer', 0, specStage).split(discoveryRule).length - 1, 1, 'writer: host-rule discovery');
  const inspection = read(templates, 'review-prompt.md').split(/^### Inspection\s*$/m)[1]!.split(/^### /m)[0]!;
  assert.doesNotMatch(inspection, /AGENTS\.md/);
});

// SECTION: Durable test bar and plan-free naming

test('quality selection keeps artifact finding loci in review kind blocks', () => {
  const bar = read(templates, 'quality-bar.md');
  for (const consumer of ['code', 'writer', 'plan', 'design'] as const) assert.doesNotMatch(qualityBar(bar, consumer, 0, specStage), /Adjacent findings|nearest plan|nearest design/);
  for (const consumer of ['plan', 'design'] as const) {
    const kindBlock = read(templates, `review-prompt-${consumer}.md`);
    assert.match(kindBlock, new RegExp(`nearest ${consumer} heading as locus`));
    assert.doesNotMatch(kindBlock, new RegExp(`nearest ${consumer === 'plan' ? 'design' : 'plan'} heading`));
  }
});

test('plan authors and reviewers share the binding decision standard', () => {
  const bar = read(templates, 'quality-bar.md');
  const planSection = bar.split(/^## plan$/m)[1]!.split(/^## design$/m)[0]!;
  const standards = planSection.split('\n').filter((line) => line.startsWith('- Plan standard:'));
  assert.equal(standards.length, 1, 'one canonical plan standard');
  const standard = standards[0]!.replace(/\s+/g, ' ');
  for (const term of ['observable outcomes', 'binding interfaces and invariants', 'ownership', 'dependencies', 'failure behavior', 'verification', 'exact algorithm']) assert.ok(standard.includes(term), term);
  // Reviewers receive the standard once; other kinds do not.
  assert.equal(flat('plan').split(standard).length - 1, 1, 'plan review prompt');
  for (const kind of ['code', 'design'] as const) assert.ok(!flat(kind).includes(standard), kind);
  // Authors read it through pointers, without a second copy.
  for (const name of ['plan.md', '../verbs/plan.md']) {
    const author = read(templates, name);
    assert.ok(author.includes('quality-bar.md#plan'), `${name}: points to the canonical plan standard`);
    assert.ok(!author.includes('exact algorithm'), `${name}: no restated standard`);
  }
  // Reviewers separate a decision that blocks safe implementation from a routine writer choice.
  const reviewer = flat('plan');
  assert.match(reviewer, /missing decision that prevents safe implementation/);
  assert.match(reviewer, /routine writer choice[^.]*only with a concrete consequence/);
});

// SECTION: Computed turn target and context map

 


test('writer quality criteria omit prune directive while code and plan keep it', () => {
  const bar = read(templates, 'quality-bar.md');
  const cleanup = read(templates, 'test-cleanup-brief.md');
  const writer = qualityCriteria(bar, 'writer', 0, specStage);
  for (const gate of ['Contract:', 'Defect:', 'Oracle:', 'Unique kill:']) assert.ok(writer.includes(gate), `writer: ${gate}`);
  assert.ok(writer.includes('Shape:'), 'writer: Shape');
  assert.ok(writer.includes('Naming:'), 'writer: Naming');
  assert.ok(writer.includes('Writer focus'), 'writer: Writer focus');
  assert.doesNotMatch(writer, /^- Prune:/m);
  assert.doesNotMatch(writer, /disposable/);
  for (const consumer of ['code', 'plan'] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.match(criteria, /^- Prune:/m, `${consumer}: Prune`);
    assert.doesNotMatch(criteria, /Writer focus/, `${consumer}: Writer focus`);
  }
  assert.match(cleanup, /executing `- Prune:` and ignoring `- Writer focus`/);
});

test('reviewPrompt renders MUST rejection confirmation instructions only when requests are assigned', () => {
  for (const kind of reviewKinds) {
    for (const context of [reviewContext(kind), {...reviewContext(kind), requests: []}]) assert.doesNotMatch(reviewPrompt(kind, context), /Pending MUST rejection confirmation|confirmations/);
    const request = {requestId: 'R1-F001', finding: 'F001', claim: {locus: 'src/api.ts:L1', defect: 'Unbounded writes', requiredChange: 'Bound writes'}, rationale: 'The caller supplies the bound'};
    const prompt = reviewPrompt(kind, {...reviewContext(kind), requests: [request as unknown as NonNullable<Parameters<typeof reviewPrompt>[1]['requests']>[number]]});
    for (const rule of ['Pending MUST rejection confirmation', 'confirmations', 'requestId', 'decision', 'agree|disagree', 'rationale', 'nonblank evidence-backed', 'Answer every assigned request exactly once', 'Keep ordinary `status` and `findings`', 'A pending MUST rejection is open until explicit agreement', 'omission is not confirmation', request.requestId, request.claim.defect, request.claim.requiredChange, request.rationale]) assert.ok(prompt.includes(rule), `${kind}: ${rule}`);
  }
});

test('extractDocumentLayers inlines spec-stage layers and qualityCriteria filters reviewer rules', () => {
  const bar = read(templates, 'quality-bar.md');
  const specStage = read(templates, '../spec-stage.md');
  const layers = extractDocumentLayers(specStage);
  assert.ok(layers.startsWith('Spec owns intent'), 'layers paragraph');
  assert.ok(layers.includes('Cite upstream IDs instead of restating their layer.'), 'layers tail');
  const modified = specStage.replace('Spec owns intent', 'Spec owns purpose');
  assert.ok(extractDocumentLayers(modified).startsWith('Spec owns purpose'), 'reflects input without hardcoded fallback');
  const dollar = specStage.replace('Spec owns intent', () => 'Spec owns intent ($&, $\', $$)');
  const dollarLayers = extractDocumentLayers(dollar);
  assert.ok(dollarLayers.includes('Spec owns intent ($&, $\', $$)'), 'layers keep $ tokens');
  assert.ok(qualityCriteria(bar, 'code', 0, dollar).includes(`document layers (${dollarLayers})`), 'code: $ tokens preserved verbatim');
  assert.throws(() => extractDocumentLayers('no heading here'), /Readers and document layers|heading/i);
  for (const kind of ['code', 'plan', 'design'] as const) {
    const criteria = qualityCriteria(bar, kind, 0, specStage);
    assert.ok(criteria.includes(`document layers (${layers})`), `${kind}: inlined layers`);
    assert.doesNotMatch(criteria, /\.\.\//, `${kind}: no relative link`);
    assert.doesNotMatch(criteria, /\(templates\//, `${kind}: no templates link`);
    assert.doesNotMatch(criteria, /Treat settled DECs, non-goals, and prior accepted or rejected rulings/, `${kind}: no settled-ruling text`);
    if (kind === 'code') {
      assert.ok(criteria.includes('Exclude host-rule/brief conflicts from findings.'), 'code reviewer filter');
      assert.doesNotMatch(criteria, /Writers report host-rule\/brief conflicts/, 'code no writer clause');
    } else {
      assert.ok(criteria.includes('Exclude host-rule/brief conflicts from findings.'), `${kind}: reviewer filter`);
    }
  }
  {
    const writer = qualityCriteria(bar, 'writer', 0, specStage);
    assert.ok(writer.includes('Report host-rule/brief conflicts under concerns.'), 'writer filter');
    assert.ok(writer.includes(`document layers (${layers})`), 'writer inlined layers');
    assert.doesNotMatch(writer, /Treat settled DECs, non-goals, and prior accepted or rejected rulings/, 'writer no settled text');
  }
  for (const kind of ['plan', 'design'] as const) {
    const criteria = qualityCriteria(bar, kind, 0, specStage);
    assert.ok(criteria.includes('- Visuals, summaries, and callouts:'), `${kind}: reviewer visual check`);
    assert.ok(criteria.includes('stale'), `${kind}: stale`);
    assert.ok(criteria.includes('contradicts'), `${kind}: contradictory`);
    assert.ok(criteria.includes('decorative'), `${kind}: decorative`);
    assert.ok(criteria.includes('duplicate'), `${kind}: duplicate`);
    assert.ok(criteria.includes('[!NOTE]'), `${kind}: NOTE definition`);
    assert.ok(criteria.includes('[!IMPORTANT]'), `${kind}: IMPORTANT definition`);
    assert.ok(criteria.includes('misused') || criteria.includes('misuse'), `${kind}: misuse`);
    assert.doesNotMatch(criteria, /- Artifact layout:/, `${kind}: no authoring layout`);
    assert.doesNotMatch(criteria, /### Visual-aid bar/, `${kind}: no visual-aid bar`);
  }
  for (const kind of reviewKinds) {
    const prompt = reviewPrompt(kind, {...reviewContext(kind), round: 1});
    assert.doesNotMatch(prompt, /\(\.\.\//, `${kind}: compiled prompt has no relative link`);
    assert.doesNotMatch(prompt, /\(templates\//, `${kind}: compiled prompt has no templates link`);
    assert.ok(prompt.includes('When all requirements, invariants, and boundaries hold, return `CLEAN`'), `${kind}: CLEAN calibration`);
  }
});

test('reviewPrompt omits re-review block on round 1 and includes it once on later rounds and reruns', () => {
  for (const kind of reviewKinds) {
    const first = reviewPrompt(kind, {...reviewContext(kind), round: 1, scope: 'Full review'});
    assert.doesNotMatch(first, /On re-review,/, `${kind} round 1: no re-review`);
    assert.doesNotMatch(first, /Settled in earlier rounds/, `${kind} round 1: no settled section`);
    const narrowed = reviewPrompt(kind, {...reviewContext(kind), round: 2, scope: 'Re-review round 2 (narrowed) — changed: New work; comparison: a..b'});
    assert.equal(narrowed.split('On re-review,').length - 1, 1, `${kind} round 2 narrowed: single re-review block`);
    assert.ok(narrowed.includes('Settled in earlier rounds'), `${kind} round 2 narrowed settles earlier rounds`);
    const rerun = reviewPrompt(kind, {...reviewContext(kind), round: 2, scope: 'Full review — changed paths: src/a.ts; comparison: a..b', settled: []});
    assert.equal(rerun.split('On re-review,').length - 1, 1, `${kind} round 2 rerun: single re-review block`);
    assert.doesNotMatch(rerun, /Read the full review history/, `${kind} rerun: no external log instruction`);
    const withSettled = reviewPrompt(kind, {...reviewContext(kind), round: 1, scope: 'Full review', settled: [{id: 'R1-F001', locus: '§ Work', defect: 'Defect text', ruling: 'accepted', reason: 'Fixed'}]});
    assert.equal(withSettled.split('On re-review,').length - 1, 1, `${kind} round 1 with settled: single re-review block`);
  }
});
