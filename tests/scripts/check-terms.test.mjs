import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { findBannedTerms, parseBannedTerms, runCli } from '../../scripts/check-terms.mjs';

// SECTION: Test support

const captureCli = (args) => {
  let stdout = '';
  let stderr = '';
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    return { status: runCli(args), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
};

// SECTION: Glossary contract

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

// SECTION: Library behavior

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

// SECTION: CLI behavior

describe('check-terms CLI', () => {
  it('reports only seeded prose and returns the clean/found exit codes', () => {
    const clean = captureCli(['--glossary', GLOSSARY, CLEAN]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);

    const seeded = captureCli(['--glossary', GLOSSARY, SEEDED]);
    assert.equal(seeded.status, 1);
    const hits = seeded.stdout.split(/\r?\n/).filter((line) => /seeded\.md:\d+:/.test(line));
    assert.equal(hits.length, 1, seeded.stdout + seeded.stderr);
    assert.match(hits[0], /seeded\.md:4: reviewer \(use .+\)/);
  });

  it('never scans the glossary itself', () => {
    const res = captureCli(['--glossary', GLOSSARY, GLOSSARY, CLEAN]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  it('returns usage errors for a missing glossary and an unknown flag', () => {
    const missing = captureCli(['--glossary', path.join(os.tmpdir(), 'no-such-glossary.md'), CLEAN]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /cannot read glossary/);

    const unknown = captureCli(['--bogus']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown flag --bogus/);
  });

  it('prints usage on --help through the executable entry point', () => {
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
  });
});
