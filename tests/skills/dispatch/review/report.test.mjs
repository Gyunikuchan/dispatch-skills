import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractJsonText, normalizeLocus } from '../../../../skills/dispatch/scripts/review/report.mjs';

const REPORT = { status: 'FINDINGS', findings: [{ severity: 'MUST', locus: 'a.js:L1' }] };

describe('extractJsonText', () => {
  it('returns a whole-string JSON object unchanged', () => {
    const text = JSON.stringify(REPORT);
    assert.equal(extractJsonText(text), text);
  });

  it('prefers the last fenced JSON block over earlier fenced examples', () => {
    const text = [
      'Example config:',
      '```json',
      '{"example": true}',
      '```',
      'Report:',
      '```json',
      JSON.stringify(REPORT, null, 2),
      '```',
    ].join('\n');
    assert.deepEqual(JSON.parse(extractJsonText(text)), REPORT);
  });

  it('extracts prose followed by an unfenced report with trailing notes', () => {
    const text = `provider banner\n${JSON.stringify(REPORT, null, 2)}\nHope this helps!`;
    assert.deepEqual(JSON.parse(extractJsonText(text)), REPORT);
  });

  it('never lets a nested line-initial object win over its container', () => {
    const unindented = '{\n"status": "FINDINGS",\n"findings": [\n{\n"severity": "MUST",\n"locus": "a.js:L1"\n}\n]\n}';
    assert.deepEqual(JSON.parse(extractJsonText(`notes\n${unindented}`)), REPORT);
  });

  it('picks the trailing report over an earlier cited snippet', () => {
    const text = `The config reads:\n{"cited": "snippet with } brace"}\nReport:\n${JSON.stringify(REPORT)}`;
    assert.deepEqual(JSON.parse(extractJsonText(text)), REPORT);
  });

  it('picks a bare trailing report over an earlier fenced example', () => {
    const text = `Example:\n\`\`\`json\n{"example": true}\n\`\`\`\nReport:\n${JSON.stringify(REPORT)}`;
    assert.deepEqual(JSON.parse(extractJsonText(text)), REPORT);
  });

  it('skips an unparseable fenced block when a later bare report parses', () => {
    const text = `\`\`\`json\n{broken}\n\`\`\`\n${JSON.stringify(REPORT)}`;
    assert.deepEqual(JSON.parse(extractJsonText(text)), REPORT);
  });

  it('surfaces a malformed trailing fenced report instead of an earlier example', () => {
    const text = 'Example:\n```json\n{"example": true}\n```\nReport:\n```json\n{"status": "CLEAN",}\n```';
    assert.equal(extractJsonText(text), '{"status": "CLEAN",}');
  });

  it('returns prose unchanged when no candidate parses', () => {
    const text = 'banner\n{broken: json\nno report here';
    assert.equal(extractJsonText(text), text);
  });
});

describe('normalizeLocus', () => {
  it('rewrites code line prefixes and plan heading spacing only', () => {
    for (const [kind, input, expected] of [
      ['code', 'a.js:12', 'a.js:L12'],
      ['code', 'a.js#L12', 'a.js:L12'],
      ['code', ' a.js:L12 ', 'a.js:L12'],
      ['code', 'a.js:L12-L14', 'a.js:L12-L14'],
      ['code', 'a.js:12:5', 'a.js:12:5'],
      ['code', 'a.js', 'a.js'],
      ['code', '10:30', '10:30'],
      ['code', '2.5:1', '2.5:1'],
      ['code', 'Makefile#L3', 'Makefile:L3'],
      ['plan', '§Verification Plan', '§ Verification Plan'],
      ['plan', '§ Verification Plan', '§ Verification Plan'],
    ]) {
      assert.equal(normalizeLocus(kind, input), expected, input);
    }
  });
});
