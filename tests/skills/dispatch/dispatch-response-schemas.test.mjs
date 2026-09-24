// Delegate response schemas go to provider CLIs as --json-schema; the claude CLI rejects a
// draft 2020-12 "$schema" key, which failed every claude rebuttal launch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch/references/templates/schemas');

// SECTION: Driver and provider schema boundaries

describe('delegate response schemas', () => {
  it('keeps ordinary driver schemas separate from provider response schemas', () => {
    const driver = path.join(dir, 'driver');
    for (const name of ['ask-user', 'delegate-write', 'delegate-write.reply', 'verify', 'verify.reply', 'done']) {
      const schema = JSON.parse(fs.readFileSync(path.join(driver, `${name}.json`), 'utf8'));
      // A driver-run verify gate takes no reply, so verify.reply also admits null.
      const objects = name === 'verify.reply' ? schema.anyOf.filter(branch => branch.type !== 'null') : [schema];
      for (const branch of objects) {
        assert.equal(branch.type, 'object', name);
        assert.equal(branch.additionalProperties, false, name);
      }
    }
    const reply = JSON.parse(fs.readFileSync(path.join(driver, 'delegate-write.reply.json'), 'utf8'));
    assert.equal(reply.properties.raw.minLength, 1);
    assert.deepEqual(reply.properties.rejected, { const: true });
  });

  it('declares no $schema key', () => {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(files.includes('rebuttal.json'));
    for (const name of files) {
      assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), '$schema'), false, name);
    }
  });
});
