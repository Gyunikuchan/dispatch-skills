import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { KINDS } from '../../skills/dispatch/scripts/toolkit/records.ts';
import {
  BASELINE, MANIFEST, SKILL_LINKS, checkGrowth, formatReport, measure, sectionOf, slug,
  type Figures, type PathManifest, type PathName,
} from '../../scripts/path-bytes.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skillDir = path.join(root, 'skills/dispatch');
const readFile = (rel: string) => fs.readFileSync(path.join(skillDir, rel), 'utf8');
const toolkit = readFile('references/toolkit.md');

// SECTION: Guide link extraction (test-local; the production measure takes classes from the manifest)

type Occurrence = { target: string; stepText: string | null; sentence: string; line: string };

function guideOccurrences(name: string): Occurrence[] {
  const text = readFile(`references/verbs/${name}.md`);
  const stepStart = text.indexOf('## Step reads');
  const found: Occurrence[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const inSteps = stepStart >= 0 && offset > stepStart;
    const isRow = inSteps && line.startsWith('| ') && !line.startsWith('| Step') && !line.startsWith('| ---');
    const stepText = isRow ? line.split('|')[1]!.trim() : null;
    const pieces: { start: number; end: number }[] = [];
    let from = 0;
    for (const match of line.matchAll(/\.\s+/g)) { pieces.push({ start: from, end: match.index! + 1 }); from = match.index! + match[0].length; }
    pieces.push({ start: from, end: line.length });
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = match[1]!;
      if (/^(https?:|mailto:|<)/.test(raw)) continue;
      const [file, anchor] = raw.split('#');
      const resolved = path.posix.normalize(path.posix.join('references/verbs', file!));
      const piece = pieces.find(candidate => match.index! >= candidate.start && match.index! < candidate.end)!;
      found.push({
        target: resolved + (anchor ? `#${anchor}` : ''),
        stepText,
        sentence: line.slice(piece.start, piece.end),
        line,
      });
    }
    offset += line.length + 1;
  }
  return found;
}

type Heading = { title: string; group: string };
function toolkitHeadings(): Map<string, Heading> {
  const map = new Map<string, Heading>();
  let group = '';
  for (const line of toolkit.split('\n')) {
    const match = /^(#{2,3})\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === '##') group = match[2]!;
    else map.set(slug(match[2]!), { title: match[2]!, group });
  }
  return map;
}

const GUIDES = ['plan', 'implement'] as const;

// SECTION: Manifest completeness and classes

for (const name of GUIDES) {
  test(`${name} path manifest classifies exactly the links of its guide`, () => {
    const links = MANIFEST[name].links;
    const found = new Set(guideOccurrences(name).map(item => item.target));
    assert.deepEqual([...found].filter(target => !(target in links)).sort(), [], `${name} guide links missing from the manifest`);
    assert.deepEqual(Object.keys(links).filter(target => !found.has(target)).sort(), [], `${name} manifest lists links the guide no longer has`);
  });

  test(`${name} path link classes follow the step text and the stated conditions`, () => {
    const links = MANIFEST[name].links;
    const occurrences = guideOccurrences(name);
    for (const [target, entry] of Object.entries(links)) {
      const own = occurrences.filter(item => item.target === target);
      if (target === 'references/toolkit.md') { assert.equal(entry.class, 'owner', 'an anchorless toolkit link names the contract owner'); continue; }
      assert.notEqual(entry.class, 'owner', `${target} is not an owner link`);
      const rows = own.filter(item => item.stepText !== null);
      if (rows.length) {
        const derived = rows.some(item => !/\b(when|only)\b/i.test(item.stepText!)) ? 'unconditional' : 'conditional';
        assert.equal(entry.class, derived, `${target} class follows its Step reads text`);
      }
      if (entry.class === 'conditional') {
        assert.ok(entry.when, `${target} states its condition`);
        for (const item of own.filter(candidate => candidate.stepText === null && !rows.some(row => !/\b(when|only)\b/i.test(row.stepText!)))) {
          assert.ok(item.line.toLowerCase().includes(entry.when!.toLowerCase()), `${target} paragraph carries its condition "${entry.when}": ${item.line}`);
        }
      } else if (!rows.length) {
        for (const item of own) assert.doesNotMatch(item.sentence, /^\W*(when|if|for)\b|\bonly (on|when|if|for)\b/i, `${target} is unconditional but its sentence states a condition: ${item.sentence}`);
      }
    }
  });

  test(`${name} path call sequence covers every toolkit anchor of its guide`, () => {
    const { links, calls } = MANIFEST[name];
    const headings = toolkitHeadings();
    for (const [target, entry] of Object.entries(links)) {
      const anchor = /^references\/toolkit\.md#(.+)$/.exec(target)?.[1];
      if (!anchor) continue;
      const heading = headings.get(anchor);
      assert.ok(heading, `${target} resolves to a toolkit heading`);
      const call = heading.group === 'Ledger records'
        ? calls.find(item => item.action === 'ledger append' && item.kind === heading.title)
        : calls.find(item => item.action === heading.title && item.kind === undefined);
      assert.ok(call, `${target} is in the ${name} call sequence`);
      if (entry.class === 'conditional') assert.equal(call.count, 0, `${target} is conditional, so it counts 0`);
      else assert.ok(call.count > 0, `${target} is unconditional, so it counts at least 1`);
    }
  });

  test(`${name} path ledger calls name a record kind and other calls name a tool action`, () => {
    const headings = toolkitHeadings();
    for (const call of MANIFEST[name].calls) {
      if (call.action === 'ledger append') {
        assert.ok(call.kind && (KINDS as readonly string[]).includes(call.kind), `ledger append names a record kind: ${call.kind}`);
        assert.equal(headings.get(slug(call.kind))?.group, 'Ledger records');
      } else {
        assert.equal(call.kind, undefined, `${call.action} takes no record kind`);
        assert.equal(headings.get(slug(call.action))?.group, 'Tool actions', `${call.action} is a tool action`);
      }
    }
  });
}

// SECTION: Measure formulas

function file(...sections: [string, number][]): string {
  return sections.map(([title, size]) => `### ${title}\n${'x'.repeat(size)}`).join('\n') + '\n';
}
const sectionSize = (title: string, size: number) => `### ${title}`.length + 1 + size;

test('measure counts each section per call before and once per run after', () => {
  const files: Record<string, string> = {
    'SKILL.md': 'S'.repeat(100),
    'references/verbs/p.md': 'G'.repeat(200),
    'references/a.md': 'A'.repeat(300),
    'references/templates/quality-bar.md': file(['plan', 50]),
    'references/toolkit.md': file(['call table', 10], ['do it', 20], ['ledger append', 30], ['k', 40], ['unused', 99]),
  };
  const manifest: Record<'p', PathManifest> = {
    p: {
      guide: 'references/verbs/p.md',
      links: {
        'references/a.md': { class: 'unconditional' },
        'references/skipped.md': { class: 'conditional', when: 'x' },
        'references/templates/quality-bar.md#plan': { class: 'unconditional' },
        'references/toolkit.md#do-it': { class: 'unconditional' },
        'references/toolkit.md': { class: 'owner' },
      },
      calls: [
        { action: 'do it', count: 3 },
        { action: 'ledger append', kind: 'k', count: 2 },
        { action: 'unused', count: 0 },
      ],
    },
  };
  const reads = 100 + 200 + 300 + sectionSize('plan', 50);
  const doIt = sectionSize('do it', 20), append = sectionSize('ledger append', 30), kind = sectionSize('k', 40), table = sectionSize('call table', 10);
  const read = (rel: string) => files[rel] ?? assert.fail(`unexpected read ${rel}`);

  const before = measure(read, 'before', manifest).p;
  assert.equal(before.distinct, reads + doIt + append + kind);
  assert.equal(before.workload, reads + 3 * doIt + 2 * append + 2 * kind);
  assert.equal(before.editableDistinct, before.distinct - sectionSize('plan', 50));
  assert.equal(before.editableWorkload, before.workload - sectionSize('plan', 50));

  const after = measure(read, 'after', manifest).p;
  assert.equal(after.distinct, reads + table + doIt + append + kind);
  assert.equal(after.workload, after.distinct);
  assert.equal(after.editableWorkload, after.workload - sectionSize('plan', 50));
});

test('measure counts a section once when its whole file is already read', () => {
  const read = (rel: string) => ({ 'SKILL.md': 'S', 'references/verbs/p.md': 'G', 'references/a.md': file(['one', 5], ['two', 7]), 'references/toolkit.md': file(['call table', 1]) })[rel] ?? '';
  const manifest = { p: { guide: 'references/verbs/p.md', calls: [], links: { 'references/a.md': { class: 'unconditional' }, 'references/a.md#one': { class: 'unconditional' }, 'SKILL.md#routing': { class: 'unconditional' } } } } as const;
  const figures = measure(read, 'before', manifest as unknown as Record<'p', PathManifest>).p;
  assert.equal(figures.distinct, 1 + 1 + Buffer.byteLength(file(["one", 5], ["two", 7])));
});

// SECTION: Growth against the baseline

test('growth above the baseline fails and a smaller figure passes', () => {
  const same = { plan: { ...BASELINE.plan }, implement: { ...BASELINE.implement } };
  assert.deepEqual(checkGrowth(same), []);
  const smaller = { plan: { ...BASELINE.plan, workload: BASELINE.plan.workload - 1 }, implement: { ...BASELINE.implement } };
  assert.deepEqual(checkGrowth(smaller), []);
  const grown: Record<PathName, Figures> = { plan: { ...BASELINE.plan }, implement: { ...BASELINE.implement, workload: BASELINE.implement.workload + 1 } };
  const errors = checkGrowth(grown);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /implement.*workload/);
});

test('the report prints distinct, workload and editable bytes with reductions for both paths', () => {
  const result = measure(readFile, 'after');
  const report = formatReport(result);
  for (const name of GUIDES) {
    const figures = result[name];
    for (const [label, key] of [['distinct', 'distinct'], ['workload', 'workload'], ['editable distinct', 'editableDistinct'], ['editable workload', 'editableWorkload']] as const) {
      assert.match(report, new RegExp(`${name} ${label}: ${figures[key]} bytes \\(baseline \\d+, -?\\d+(\\.\\d)?%\\)`));
    }
  }
});

test('SKILL_LINKS classifies exactly the relative links of SKILL.md', () => {
  const found = new Set([...readFile('SKILL.md').matchAll(/\]\((references\/[^)]+)\)/g)].map(match => match[1]!));
  assert.deepEqual([...found].filter(target => !(target in SKILL_LINKS)).sort(), []);
  assert.deepEqual(Object.keys(SKILL_LINKS).filter(target => !found.has(target)).sort(), []);
});

test('a read that SKILL.md mandates counts once on each path that makes it', () => {
  const pad = 'x'.repeat(10);
  const grow = (rel: string, marker: string) => (name: string) => {
    const text = readFile(name);
    return name === rel ? text.replace(marker, marker + pad) : text;
  };
  const base = measure(readFile, 'after');
  const native = measure(grow('references/toolkit.md', '## Native-slot replies\n'), 'after');
  assert.equal(native.plan.workload - base.plan.workload, 10);
  assert.equal(native.implement.workload - base.implement.workload, 10);
  const cleanup = measure(grow('references/worktree-cleanup.md', '# '), 'after');
  assert.equal(cleanup.plan.workload - base.plan.workload, 0);
  assert.equal(cleanup.implement.workload - base.implement.workload, 10);
  const gate = measure(grow('references/decision-frame.md', '## User Gate Boundaries\n'), 'after');
  assert.equal(gate.plan.workload - base.plan.workload, 10);
  assert.equal(gate.implement.workload - base.implement.workload, 10);
  const outside = measure(grow('references/decision-frame.md', '# '), 'after');
  assert.equal(outside.plan.workload - base.plan.workload, 10);
  assert.equal(outside.implement.workload - base.implement.workload, 0);
});

test('the report derives each reduction and the target state from the baseline', () => {
  const baseline: Record<PathName, Figures> = {
    plan: { distinct: 100, workload: 200, editableDistinct: 50, editableWorkload: 100 },
    implement: { distinct: 100, workload: 200, editableDistinct: 50, editableWorkload: 100 },
  };
  const result: Record<PathName, Figures> = {
    plan: { distinct: 90, workload: 150, editableDistinct: 40, editableWorkload: 90 },
    implement: { distinct: 110, workload: 151, editableDistinct: 50, editableWorkload: 100 },
  };
  assert.equal(formatReport(result, baseline), [
    'plan distinct: 90 bytes (baseline 100, 10.0%)',
    'plan workload: 150 bytes (baseline 200, 25.0%)',
    'plan editable distinct: 40 bytes (baseline 50, 20.0%)',
    'plan editable workload: 90 bytes (baseline 100, 10.0%)',
    'plan workload 25% target: met (reported only)',
    'implement distinct: 110 bytes (baseline 100, -10.0%)',
    'implement workload: 151 bytes (baseline 200, 24.5%)',
    'implement editable distinct: 50 bytes (baseline 50, 0.0%)',
    'implement editable workload: 100 bytes (baseline 100, 0.0%)',
    'implement workload 25% target: not met (reported only)',
    '',
  ].join('\n'));
});

test('sectionOf ends a section at the next heading of the same or a higher level', () => {
  const text = '# T\n### a\nline\n#### inner\nmore\n### b\nother\n';
  assert.equal(sectionOf(text, 'a'), '### a\nline\n#### inner\nmore');
  assert.equal(sectionOf(text, 'b'), '### b\nother');
  assert.equal(sectionOf(text, 'missing'), null);
});
