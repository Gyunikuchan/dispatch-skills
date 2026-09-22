// Delegate response schemas go to provider CLIs as --json-schema; the claude CLI rejects a
// draft 2020-12 "$schema" key, which failed every claude rebuttal launch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch/references/templates/schemas');

describe('delegate response schemas', () => {
  it('declare no $schema key', () => {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(files.includes('rebuttal.json'));
    for (const name of files) {
      assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), '$schema'), false, name);
    }
  });
});
