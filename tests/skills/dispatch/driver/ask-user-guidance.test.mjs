import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const DRIVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../skills/dispatch/scripts/driver');

// Every ask-user handler reads `reply.answer`; guidance that shows a bare shape costs the host a rejected round trip.
describe('ask-user guidance', () => {
  for (const file of fs.readdirSync(DRIVER).filter((name) => name.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(DRIVER, file), 'utf8');
    const emits = [...source.matchAll(/emitAction\(state, 'ask-user',[\s\S]*?\]\);/g)].map(([m]) => m);
    if (!emits.length) continue;
    it(`${file} names the {"answer": …} reply wrapper`, () => {
      for (const emit of emits) assert.match(emit, /\{"answer": /, emit.slice(0, 160));
    });
  }
});
