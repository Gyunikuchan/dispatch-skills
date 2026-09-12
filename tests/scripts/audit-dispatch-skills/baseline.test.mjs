import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  brokenLinks,
  headingSlugs,
  loc,
} from '../../../.agents/skills/audit-dispatch-skills/scripts/baseline.mjs';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-baseline-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a fixture file and returns its absolute path. */
const write = (name, contents) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
  return file;
};

describe('baseline: brokenLinks', () => {
  it('reports a link to a missing file', () => {
    const file = write('a.md', 'See [the docs](./missing.md).');
    assert.deepEqual(brokenLinks(file).map((p) => p.reason), ['missing file']);
  });

  it('accepts a link to an existing file', () => {
    write('target.md', '# Target');
    const file = write('a.md', 'See [the docs](./target.md).');
    assert.deepEqual(brokenLinks(file), []);
  });

  it('reports a missing anchor in an existing file', () => {
    write('target.md', '# Present Heading');
    const file = write('a.md', 'See [there](./target.md#absent-heading).');
    assert.deepEqual(brokenLinks(file).map((p) => p.reason), ['missing anchor']);
  });

  it('accepts an anchor that matches a heading slug', () => {
    write('target.md', '## Plan/Walkthrough Artifact Resolution');
    const file = write('a.md', 'See [there](./target.md#planwalkthrough-artifact-resolution).');
    assert.deepEqual(brokenLinks(file), []);
  });

  it('resolves a bare anchor against the file itself', () => {
    const file = write('a.md', '# Own Heading\n\nJump to [it](#own-heading).');
    assert.deepEqual(brokenLinks(file), []);
  });

  it('ignores external URLs', () => {
    const file = write('a.md', '[site](https://example.com) and [mail](mailto:a@b.c)');
    assert.deepEqual(brokenLinks(file), []);
  });

  it('ignores links inside fenced code blocks', () => {
    // A fenced example naming a path that does not exist is documentation, not a broken link.
    const file = write('a.md', '```\n[example](./nope.md)\n```\n');
    assert.deepEqual(brokenLinks(file), []);
  });

  it('reports the 1-indexed line of each problem', () => {
    const file = write('a.md', 'intro\n\n[bad](./nope.md)\n');
    assert.equal(brokenLinks(file)[0].line, 3);
  });
});

describe('baseline: headingSlugs', () => {
  it('slugifies headings GitHub-style, dropping punctuation', () => {
    const file = write('h.md', '# Hello, World!\n### Plan/Walkthrough & Co.\n');
    const slugs = headingSlugs(file);
    assert.ok(slugs.has('hello-world'));
    assert.ok(slugs.has('planwalkthrough--co'));
  });

  it('returns an empty set for a file with no headings', () => {
    assert.equal(headingSlugs(write('none.md', 'just prose')).size, 0);
  });
});

describe('baseline: loc', () => {
  it('counts only non-blank lines', () => {
    assert.equal(loc('one\n\ntwo\n   \nthree\n'), 3);
  });

  it('counts an empty string as zero', () => {
    assert.equal(loc(''), 0);
  });
});
