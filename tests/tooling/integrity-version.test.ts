import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { hashes } from '../../scripts/generate-hashes.ts';
import { checkIntegrity, generateSkillHashes, MANIFEST_NAME, readVersion } from '../../skills/dispatch/scripts/lib/integrity.ts';
import { tempDir } from '../helpers/fake-ports.ts';


test('SC4 integrity ignores version key', () => {
  const root = tempDir(), skill = path.join(root, 'skills/dispatch');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# skill\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.7.1' }));
  assert.deepEqual(hashes(root), []);
  const manifest = JSON.parse(fs.readFileSync(path.join(skill, MANIFEST_NAME), 'utf8')) as Record<string, string>;
  assert.deepEqual(manifest, { $version: '0.7.1', ...generateSkillHashes(skill) });
  assert.deepEqual(checkIntegrity(skill), { status: 'ok' });
  assert.equal(readVersion(skill), '0.7.1');
  assert.deepEqual(hashes(root, true), []);
});
