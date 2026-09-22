// Delegate response schemas go to provider CLIs as --json-schema; the claude CLI rejects a
// draft 2020-12 "$schema" key, which failed every claude rebuttal launch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch/references/templates/schemas');

describe('delegate response schemas', () => {
  it('keeps ordinary driver schemas separate from provider response schemas', () => {
    const driver = path.join(dir, 'driver');
    for (const name of ['ask-user', 'delegate-write', 'delegate-write.reply', 'verify', 'verify.reply', 'done']) {
      const schema = JSON.parse(fs.readFileSync(path.join(driver, `${name}.json`), 'utf8'));
      assert.equal(schema.type, 'object');
      assert.equal(schema.additionalProperties, false);
    }
    const reply = JSON.parse(fs.readFileSync(path.join(driver, 'delegate-write.reply.json'), 'utf8'));
    assert.equal(reply.properties.raw.minLength, 1);
    assert.deepEqual(reply.properties.rejected, { const: true });
  });
  it('declare no $schema key', () => {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(files.includes('rebuttal.json'));
    for (const name of files) {
      assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), '$schema'), false, name);
    }
  });
});
