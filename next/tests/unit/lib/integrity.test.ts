import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkIntegrity, generateSkillHashes, integrityDiagnostic, MANIFEST_NAME } from '../../../skills/dispatch/scripts/lib/integrity.ts';

test('delegates-integrity-check: hash drift is reported before dispatch', () => {
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
