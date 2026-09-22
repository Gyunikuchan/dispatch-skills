import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { findBannedTerms, parseBannedTerms } from '../../scripts/check-terms.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-terms.mjs');
const GLOSSARY = path.join(REPO_ROOT, 'skills', 'dispatch', 'references', 'glossary.md');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'check-terms');
const CLEAN = path.join(FIXTURES, 'clean.md');
const SEEDED = path.join(FIXTURES, 'seeded.md');

/** Banned-synonym column of the design's Ubiquitous-language table (R9). */
const EXPECTED_BANNED = ['implementer', 'iteration', 'milestone', 'reviewer', 'stage', 'verdict'];

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
const glossaryText = () => fs.readFileSync(GLOSSARY, 'utf8');
const words = (terms) => [...new Set(terms.map((t) => t.word.toLowerCase()))].sort();

describe('glossary', () => {
  it('is single-sourced in dispatch/references/glossary.md with a Banned synonym column', () => {
    const text = glossaryText();
    assert.match(text, /\|\s*Term\s*\|\s*Meaning\s*\|\s*Banned synonym\s*\|\s*Distinct from\s*\|/);
    assert.match(text, /\|\s*Phase\s*\|\s*Requires\s*\|\s*Produces\s*\|/);
    assert.match(text, /RED gate/);
  });

  it('names no downstream skill', () => {
    const text = glossaryText();
    assert.doesNotMatch(text, /\b(implement-dispatch|dispatch-plan-review|dispatch-code-review|dispatch-design-review)\b/);
  });
});

describe('parseBannedTerms', () => {
  it('returns the banned-synonym set from the real glossary, never a glossary term or config key', () => {
    const banned = parseBannedTerms(glossaryText());
    assert.deepEqual(words(banned), EXPECTED_BANNED);
    for (const term of banned) assert.equal(typeof term.term, 'string');
    for (const neverBanned of ['phase', 'increment', 'effort', 'session', 'mode', 'command', 'task']) {
      assert.ok(!words(banned).includes(neverBanned), `${neverBanned} must never be banned`);
    }
  });

  it('splits comma- and slash-separated cells and skips blank cells', () => {
    const table = [
      '| Term | Meaning | Banned synonym | Distinct from |',
      '|---|---|---|---|',
      '| **Alpha** | a | foo, bar | x |',
      '| **Beta** | b | baz / qux | |',
      '| **Gamma** | c | | y |',
    ].join('\n');
    assert.deepEqual(words(parseBannedTerms(table)), ['bar', 'baz', 'foo', 'qux']);
  });
});

describe('findBannedTerms', () => {
  const banned = [{ word: 'reviewer', term: 'Read delegate' }];

  it('matches case-insensitive whole words with an optional plural s', () => {
    const hits = findBannedTerms('One Reviewer.\nTwo reviewers.\nreviewership and prereviewer are fine.', banned);
    assert.deepEqual(hits.map((h) => h.line), [1, 2]);
  });

  it('skips inline code spans and fenced blocks, including nested shorter markers', () => {
    assert.deepEqual(findBannedTerms('Use `reviewer` here.\n```\nreviewer\n```\n~~~\nreviewer\n~~~', banned), []);
    assert.deepEqual(findBannedTerms('````markdown\n```json\n{"reviewer":true}\n```\nreviewer\n````', banned), []);
  });
});

describe('check-terms CLI', () => {
  it('exits 0 on the clean fixture', () => {
    const res = run('--glossary', GLOSSARY, CLEAN);
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  it('exits 1 listing path:line: word (use term) for the seeded prose only', () => {
    const res = run('--glossary', GLOSSARY, SEEDED);
    assert.equal(res.status, 1);
    const out = `${res.stdout}${res.stderr}`;
    const hits = out.split(/\r?\n/).filter((l) => /seeded\.md:\d+:/.test(l));
    assert.equal(hits.length, 1, out);
    assert.match(hits[0], /seeded\.md:4: reviewer \(use .+\)/);
  });

  it('never scans the glossary itself', () => {
    const res = run('--glossary', GLOSSARY, GLOSSARY, CLEAN);
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  it('exits 2 on a missing glossary or unknown flag, and prints Usage on --help', () => {
    const missing = run('--glossary', path.join(os.tmpdir(), 'no-such-glossary.md'), CLEAN);
    assert.equal(missing.status, 2);
    assert.equal(run('--bogus').status, 2);
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
  });
});
