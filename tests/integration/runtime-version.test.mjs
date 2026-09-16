import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Node runtime requirement', () => {
  it('keeps package and repository guidance on Node 22+', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const guide = fs.readFileSync(path.join(root, '.agents', 'AGENTS.md'), 'utf8');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.equal(pkg.engines.node, '>=22');
    assert.match(guide, /Shipped skills and development tooling require Node 22\+/);
    assert.match(readme, /Node\.js `>=22`/);
    assert.doesNotMatch(guide, /Node 18/);
  });
});
