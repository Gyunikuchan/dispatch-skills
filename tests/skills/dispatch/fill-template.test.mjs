import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';

import { extractTemplate, fillTemplate } from '../../../skills/dispatch/scripts/fill-template.mjs';
import { PROJECT_ROOT } from '../../../skills/dispatch/scripts/common.mjs';

const FILL_TEMPLATE_SCRIPT = path.join(PROJECT_ROOT, 'skills', 'dispatch', 'scripts', 'fill-template.mjs');
const PLAN_REVIEW_SKILL = path.join(PROJECT_ROOT, 'skills', 'dispatch-plan-review', 'SKILL.md');
const CODE_REVIEW_SKILL = path.join(PROJECT_ROOT, 'skills', 'dispatch-code-review', 'SKILL.md');

// ---------------------------------------------------------------------------
// SECTION: Extraction against real review SKILL.md files
// ---------------------------------------------------------------------------

describe('fill-template: extraction on real review skills', () => {
  it('extracts declared variables and an intact template from dispatch-plan-review', () => {
    const markdown = fs.readFileSync(PLAN_REVIEW_SKILL, 'utf8');
    const { variables, template } = extractTemplate(markdown);

    assert.deepEqual(variables, [
      'Plan Path',
      'Requirement',
      'User Focus Areas',
      'Review Scope',
      'Tool Turn Budget',
    ]);
    assert.ok(template.includes('<Plan Path>'));
    assert.ok(template.includes('### Context & Objective'));
  });

  it('extracts declared variables and an intact template from dispatch-code-review', () => {
    const markdown = fs.readFileSync(CODE_REVIEW_SKILL, 'utf8');
    const { variables, template } = extractTemplate(markdown);

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
    const markdown = fs.readFileSync(CODE_REVIEW_SKILL, 'utf8');
    const { template } = extractTemplate(markdown);
    // The template body should still contain at least one inner ``` fence marker, proving the
    // scanner closed on the matching (>=4-backtick) fence rather than the first ``` it saw.
    assert.ok(/```/.test(template), 'expected an inner fence to survive extraction');
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

describe('fill-template: CLI', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-template-cli-'));
  const created = [scratchDir];

  after(() => {
    for (const target of created) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  const writeFixture = (name, contents) => {
    const filePath = path.join(scratchDir, name);
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
  };

  const run = (args) => cp.spawnSync(process.execPath, [FILL_TEMPLATE_SCRIPT, ...args], { encoding: 'utf8' });

  it('--list prints declared variable names as a JSON array and exits 0', () => {
    const result = run(['--skill', CODE_REVIEW_SKILL, '--list']);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepEqual(parsed, [
      'Task Summary',
      'Walkthrough Path',
      'Plan Path',
      'User Focus Areas',
      'Review Scope',
      'Tool Turn Budget',
    ]);
  });

  it('fills via --vars JSON file supporting a multi-line value', () => {
    const skill = writeFixture(
      'FIXTURE_SKILL.md',
      '#### Prompt template\n\n- `<Plan Path>` — path.\n- `<Requirement>` — verbatim ask.\n\n```\nPlan: <Plan Path>\nAsk:\n<Requirement>\n```\n',
    );
    const varsFile = writeFixture(
      'vars.json',
      JSON.stringify({ 'Plan Path': '.scratch/plan/x.md', Requirement: 'line one\nline two' }),
    );
    const result = run(['--skill', skill, '--vars', varsFile]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('Plan: .scratch/plan/x.md'));
    assert.ok(result.stdout.includes('line one\nline two'));
  });

  it('--var wins over --vars on a name collision', () => {
    const skill = writeFixture(
      'FIXTURE_SKILL2.md',
      '#### Prompt template\n\n- `<Name>` — a value.\n\n```\nHello <Name>\n```\n',
    );
    const varsFile = writeFixture('vars2.json', JSON.stringify({ Name: 'from-vars-file' }));
    const result = run(['--skill', skill, '--vars', varsFile, '--var', 'Name=from-var-flag']);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('Hello from-var-flag'));
  });

  it('--out writes the filled prompt to a file and prints its path', () => {
    const skill = writeFixture(
      'FIXTURE_SKILL3.md',
      '#### Prompt template\n\n- `<Name>` — a value.\n\n```\nHello <Name>\n```\n',
    );
    const outFile = path.join(scratchDir, 'nested', 'out.md');
    const result = run(['--skill', skill, '--var', 'Name=World', '--out', outFile]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), outFile);
    assert.equal(fs.readFileSync(outFile, 'utf8').trim(), 'Hello World');
  });

  it('exits 1 with a stderr message when --skill is missing', () => {
    const result = run(['--list']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('--skill'));
  });

  it('exits 1 when the SKILL.md path does not exist', () => {
    const result = run(['--skill', path.join(scratchDir, 'nope.md'), '--list']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('not found'));
  });

  it('exits 1 on a malformed --var (no "=")', () => {
    const skill = writeFixture(
      'FIXTURE_SKILL4.md',
      '#### Prompt template\n\n- `<Name>` — a value.\n\n```\nHello <Name>\n```\n',
    );
    const result = run(['--skill', skill, '--var', 'NameOnly']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Malformed --var'));
  });

  it('exits 1 when --vars is not a JSON object of strings', () => {
    const skill = writeFixture(
      'FIXTURE_SKILL5.md',
      '#### Prompt template\n\n- `<Name>` — a value.\n\n```\nHello <Name>\n```\n',
    );
    const varsFile = writeFixture('bad-vars.json', JSON.stringify({ Name: 42 }));
    const result = run(['--skill', skill, '--vars', varsFile]);
    assert.equal(result.status, 1);
  });

  it('exits 1 when a declared variable is missing from the supplied values', () => {
    const skill = writeFixture(
      'FIXTURE_SKILL6.md',
      '#### Prompt template\n\n- `<Name>` — a value.\n\n```\nHello <Name>\n```\n',
    );
    const result = run(['--skill', skill]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Missing value'));
  });
});
