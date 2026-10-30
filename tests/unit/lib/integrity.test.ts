import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkIntegrity, generateSkillHashes, integrityDiagnostic, MANIFEST_NAME, readVersion } from '../../../skills/dispatch/scripts/lib/integrity.ts';

test('hash drift is reported before dispatch', () => {
  const skill = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  fs.mkdirSync(path.join(skill, 'scripts'));
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n');
  fs.writeFileSync(path.join(skill, 'scripts', 'a.ts'), 'export {};\n');
  assert.equal(checkIntegrity(skill).status, 'missing-manifest');
  fs.writeFileSync(path.join(skill, MANIFEST_NAME), JSON.stringify(generateSkillHashes(skill)));
  assert.deepEqual(checkIntegrity(skill), { status: 'ok' });
  assert.equal(integrityDiagnostic({ status: 'ok' }), null);
  fs.writeFileSync(path.join(skill, 'scripts', 'a.ts'), 'export const x = 1;\n');
  const drift = checkIntegrity(skill);
  assert.deepEqual(drift, { status: 'drift', violations: ['scripts/a.ts'] });
  assert.match(integrityDiagnostic(drift) ?? '', /^INTEGRITY_VIOLATION: .*scripts\/a\.ts/);
});

test('integrity ignores the $version key and readVersion returns it', () => {
  const skill = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n');
  assert.equal(readVersion(skill), undefined);
  fs.writeFileSync(path.join(skill, MANIFEST_NAME), JSON.stringify({ $version: '1.2.3', ...generateSkillHashes(skill) }));
  assert.deepEqual(checkIntegrity(skill), { status: 'ok' });
  assert.equal(readVersion(skill), '1.2.3');
});

test('integrity accepts a skill checked out with CRLF line endings against an LF manifest', () => {
  const skill = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  fs.mkdirSync(path.join(skill, 'scripts'));
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n\nbody\n');
  fs.writeFileSync(path.join(skill, 'scripts', 'a.ts'), 'export {};\nexport const x = 1;\n');
  fs.writeFileSync(path.join(skill, MANIFEST_NAME), JSON.stringify(generateSkillHashes(skill)));
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\r\n\r\nbody\r\n');
  fs.writeFileSync(path.join(skill, 'scripts', 'a.ts'), 'export {};\r\nexport const x = 1;\r\n');
  assert.deepEqual(checkIntegrity(skill), { status: 'ok' });
});

const SKILL_FILES: Record<string, string> = {
  'SKILL.md': '# skill\n\nUse *emphasis* here.\n',
  'scripts/a.ts': 'export {};\n',
  'references/guide.md': 'Use the plan.\n\n| a | b |\n| - | - |\n| c | d |\n',
  'references/data.json': '{"b": 1, "a": [1, 2]}\n',
  'references/broken.json': '{"a": 1,}\n',
};

function skillWith(files: Record<string, string>): string {
  const skill = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(skill, relative)), { recursive: true });
    fs.writeFileSync(path.join(skill, relative), contents);
  }
  return skill;
}

test('integrity tolerates formatting-only markdown and json rewrites', () => {
  const skill = skillWith(SKILL_FILES);
  fs.writeFileSync(path.join(skill, MANIFEST_NAME), JSON.stringify(generateSkillHashes(skill)));
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '#  skill  \r\n\r\nUse _emphasis_ here.   \r\n');
  fs.writeFileSync(path.join(skill, 'references', 'guide.md'), 'Use the plan.\n\na | b\n--- | ---\nc | d\n');
  fs.writeFileSync(path.join(skill, 'references', 'data.json'), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": 1\n}\n');
  assert.deepEqual(checkIntegrity(skill), { status: 'ok' });
});

test('integrity drift reports ts whitespace and markdown or json meaning changes', () => {
  const cases: Array<[file: string, changed: string]> = [
    ['scripts/a.ts', 'export  {};\n'],
    ['references/guide.md', 'Use the plans.\n\n| a | b |\n| - | - |\n| c | d |\n'],
    ['references/data.json', '{"b": 1, "a": [1, 3]}\n'],
    ['references/broken.json', '{"a": 2,}\n'],
  ];
  const skill = skillWith(SKILL_FILES);
  fs.writeFileSync(path.join(skill, MANIFEST_NAME), JSON.stringify(generateSkillHashes(skill)));
  for (const [file, changed] of cases) {
    const target = path.join(skill, file);
    const original = SKILL_FILES[file]!;
    fs.writeFileSync(target, changed);
    assert.deepEqual(checkIntegrity(skill), { status: 'drift', violations: [file] }, file);
    fs.writeFileSync(target, original);
  }
});
