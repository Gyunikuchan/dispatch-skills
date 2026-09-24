import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  applyExecutionStatus,
  defaultNextAction,
  renderExecutionStatus,
  selectReadyIncrement,
  updateExecutionStatus,
} from '../../../../skills/dispatch/scripts/design/status.mjs';
import { parseIncrementGraph } from '../../../../skills/dispatch/scripts/design/graph.mjs';
import { governingHash } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';

const DESIGN_BODY = [
  '# Demo design',
  '',
  '## Architecture & Boundaries',
  'boundaries',
  '## Alternatives & Decisions',
  'choices',
  '## Risks, Security & Operations',
  'risks',
  '## Increment Dependency Graph',
  '| ID | Priority | Summary | Prerequisites | Paths |',
  '| --- | ---: | --- | --- | --- |',
  '| I01 | 1 | foundation | none | a |',
  '| I02 | 2 | switch | I01 | b |',
  '| I03 | 3 | cleanup | I02 | c |',
  '',
  '## Execution Status',
  '<!-- machine-managed; excluded from governed content -->',
  '',
  '## Review Findings & Resolutions',
  '*No reviews conducted yet.*',
].join('\n');

describe('design-run selection and status mirror', () => {
  it('selects the highest-priority ready increment with prerequisite gating', () => {
    const increments = parseGraph(DESIGN_BODY);
    const states = new Map([['I01', 'ready'], ['I02', 'pending'], ['I03', 'pending']]);
    assert.equal(selectReadyIncrement(increments, states).id, 'I01');
  });

  it('skips completed, blocked, and invalidated increments', () => {
    const increments = parseGraph(DESIGN_BODY);
    const states = new Map([['I01', 'complete'], ['I02', 'pending'], ['I03', 'pending']]);
    assert.equal(selectReadyIncrement(increments, states).id, 'I02');
    const blocked = new Map([['I01', 'complete'], ['I02', 'blocked'], ['I03', 'pending']]);
    assert.equal(selectReadyIncrement(increments, blocked), null);
    const invalidated = new Map([['I01', 'complete'], ['I02', 'invalidated'], ['I03', 'pending']]);
    assert.equal(selectReadyIncrement(increments, invalidated), null);
    const bothComplete = new Map([['I01', 'complete'], ['I02', 'complete'], ['I03', 'pending']]);
    assert.equal(selectReadyIncrement(increments, bothComplete).id, 'I03');
  });

  it('waits for incomplete prerequisites', () => {
    const increments = parseGraph(DESIGN_BODY);
    const states = new Map([['I01', 'active'], ['I02', 'pending'], ['I03', 'pending']]);
    assert.equal(selectReadyIncrement(increments, states), null);
  });

  it('renders increment rows grouped by state with one Next Action', () => {
    const increments = parseGraph(DESIGN_BODY);
    const states = new Map([['I01', 'complete'], ['I02', 'complete'], ['I03', 'ready']]);
    const rendered = renderExecutionStatus(increments, states, 'implement:I03');
    assert.match(rendered, /I01.*complete/);
    assert.match(rendered, /I02.*complete/);
    assert.match(rendered, /I03.*ready/);
    assert.equal((rendered.match(/Next Action/g) ?? []).length, 1);
    assert.match(rendered, /implement:I03/);
  });

  describe('status splice', () => {
    let designPath;

    beforeEach(() => {
      designPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'design-run-')), 'demo-design.md');
      fs.writeFileSync(designPath, `${DESIGN_BODY}\n`);
    });

    afterEach(() => {
      fs.rmSync(path.dirname(designPath), { recursive: true, force: true });
    });

    it('replaces only the Execution Status section, governed bytes identical', () => {
      const before = governingHash(DESIGN_BODY, { kind: 'design' });
      const rendered = renderExecutionStatus(
        parseGraph(DESIGN_BODY),
        new Map([['I01', 'complete'], ['I02', 'active'], ['I03', 'pending']]),
        'implement:I03',
      );
      const spliced = applyExecutionStatus(`${DESIGN_BODY}\n`, rendered);
      assert.notEqual(spliced, `${DESIGN_BODY}\n`);
      assert.equal(governingHash(spliced, { kind: 'design' }).hash, before.hash);
      assert.match(spliced, /## Architecture & Boundaries[\s\S]*boundaries[\s\S]*## Execution Status/);
      assert.match(spliced, /## Review Findings & Resolutions/);
      assert.doesNotMatch(spliced, /<!-- machine-managed; excluded from governed content -->/);
    });

    it('handles CRLF sources without perturbing other sections', () => {
      const crlf = DESIGN_BODY.split('\n').join('\r\n');
      const rendered = renderExecutionStatus(parseGraph(DESIGN_BODY), new Map([['I01', 'active']]), 'implement:I01');
      const spliced = applyExecutionStatus(crlf, rendered);
      assert.ok(spliced.includes('## Alternatives & Decisions'));
      assert.equal(governingHash(spliced, { kind: 'design' }).hash, governingHash(DESIGN_BODY, { kind: 'design' }).hash);
    });

    it('ignores a fenced Execution Status heading outside the real section', () => {
      const base = DESIGN_BODY.split('\n').slice(0, 15).join('\n');
      const fenced = [
        base,
        '## Preparation',
        '```md',
        '## Execution Status',
        'example inside a fence',
        '```',
        '## Execution Status',
        'rows',
        '```text',
        'fenced status example',
        '```',
        'more status',
        '## Review Findings & Resolutions',
        '*No reviews conducted yet.*',
      ].join('\n');
      const before = governingHash(fenced, { kind: 'design' });
      const rendered = renderExecutionStatus(parseGraph(fenced), new Map([['I01', 'complete']]), 'implement:I02');
      const spliced = applyExecutionStatus(fenced, rendered);
      assert.equal(governingHash(spliced, { kind: 'design' }).hash, before.hash);
      const realHeadings = [];
      let fence = null;
      for (const line of spliced.split('\n')) {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (marker) {
          if (!fence) fence = marker[1];
          else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        }
        if (!fence && /^##\s/.test(line)) realHeadings.push(line);
      }
      assert.equal(realHeadings.filter(h => /Execution Status/.test(h)).length, 1);
      assert.match(spliced, /## Preparation[\s\S]*example inside a fence/);
      assert.doesNotMatch(spliced, /fenced status example/);
      assert.match(spliced, /## Review Findings & Resolutions/);
    });
  });
});

function parseGraph(source) {
  return parseIncrementGraph(source).increments;
}

describe('updateExecutionStatus', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-run-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes the status mirror, derives Next Action, and preserves the governed hash', () => {
    const file = path.join(dir, 'design.md');
    fs.writeFileSync(file, DESIGN_BODY);
    const before = governingHash(DESIGN_BODY, { kind: 'design' }).hash;
    const result = updateExecutionStatus({ designPath: file, states: { I01: 'complete' } });
    assert.equal(result.nextAction, 'implement:I02');
    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /Next Action: implement:I02/);
    assert.equal(governingHash(after, { kind: 'design' }).hash, before);
    assert.deepEqual(fs.readdirSync(dir), ['design.md']);
  });

  it('derives final-integration when every increment is complete', () => {
    const increments = parseIncrementGraph(DESIGN_BODY).increments;
    const states = new Map(increments.map(increment => [increment.id, 'complete']));
    assert.equal(defaultNextAction(increments, states), 'final-integration');
  });

  it('rejects unknown increments and unclosed fences without writing', () => {
    const file = path.join(dir, 'design.md');
    fs.writeFileSync(file, DESIGN_BODY);
    assert.throws(() => updateExecutionStatus({ designPath: file, states: { I09: 'complete' } }), /Unknown increment/);
    const broken = DESIGN_BODY.replace('<!-- machine-managed; excluded from governed content -->', '```md');
    fs.writeFileSync(file, broken);
    assert.throws(() => updateExecutionStatus({ designPath: file, states: {} }), /unclosed code fence/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  });
});
