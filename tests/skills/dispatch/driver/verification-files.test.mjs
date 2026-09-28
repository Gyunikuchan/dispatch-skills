// Verification-command file checks and review-log escaping used by review --fix adjudication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { findPlaceholders } from '../../../../skills/dispatch/scripts/lib/summary-box.mjs';
import { escapeLogText, setEntryResolution } from '../../../../skills/dispatch/scripts/driver/review-artifact.mjs';
import { formatApplicationRecord } from '../../../../skills/dispatch/scripts/review/resolution-log.mjs';
import { missingVerificationFiles } from '../../../../skills/dispatch/scripts/driver/review-phase.mjs';

describe('missingVerificationFiles', () => {
  let repo;
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-files-'));
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'tests', 'sample.test.mjs'), '');
  });
  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('flags missing script arguments regardless of test naming', () => {
    assert.deepEqual(missingVerificationFiles(repo, 'node --test tests/missing.mjs'), ['tests/missing.mjs']);
    assert.deepEqual(missingVerificationFiles(repo, 'pytest tests/check_api.py'), ['tests/check_api.py']);
  });

  it('accepts existing files, Windows separators, quoted and ./ paths', () => {
    assert.deepEqual(missingVerificationFiles(repo, 'node --test tests\\sample.test.mjs'), []);
    assert.deepEqual(missingVerificationFiles(repo, 'node --test "./tests/sample.test.mjs"'), []);
  });

  it('keeps quoted paths with spaces whole and stops unquoted paths at shell separators', () => {
    fs.writeFileSync(path.join(repo, 'tests', 'sample file.test.mjs'), '');
    assert.deepEqual(missingVerificationFiles(repo, 'node --test "tests/sample file.test.mjs"'), []);
    assert.deepEqual(missingVerificationFiles(repo, 'node --test tests/missing.mjs; echo ok'), ['tests/missing.mjs']);
    assert.deepEqual(missingVerificationFiles(repo, 'node --test tests/missing.mjs&&echo ok'), ['tests/missing.mjs']);
    assert.deepEqual(missingVerificationFiles(repo, 'node --test tests/sample\\ file.test.mjs'), []);
  });

  it('treats quoted option values as part of their option, not file arguments', () => {
    assert.deepEqual(missingVerificationFiles(repo, 'node --test --test-name-pattern="example.test.mjs" tests/sample.test.mjs'), []);
    assert.deepEqual(missingVerificationFiles(repo, 'node --test --test-name-pattern "example.test.mjs" tests/sample.test.mjs'), []);
    assert.deepEqual(missingVerificationFiles(repo, 'pytest -k test_x.py tests/check_api.py'), ['tests/check_api.py']);
  });

  it('checks file paths that contain = like any other path', () => {
    assert.deepEqual(missingVerificationFiles(repo, 'node --test tests/a=b.test.mjs'), ['tests/a=b.test.mjs']);
  });

  it('skips globs, flags, and files the fix itself creates', () => {
    assert.deepEqual(missingVerificationFiles(repo, 'node --test "tests/**/*.test.mjs" --import=./x.mjs'), []);
    assert.deepEqual(missingVerificationFiles(repo, 'node --test tests/new.test.mjs', ['tests/new.test.mjs']), []);
  });
});

describe('review-log escaping', () => {
  it('escapes template tokens idempotently', () => {
    assert.equal(escapeLogText('use <key>'), 'use &lt;key>');
    assert.equal(escapeLogText(escapeLogText('use <key>')), 'use &lt;key>');
  });

  it('setEntryResolution escapes replacement text so placeholder lint stays clean', () => {
    const markdown = '- **[Accepted]** [R1-F001] [MUST] [sources=a] plan.md:L1 — intent: Defect. → Old.\n';
    const updated = setEntryResolution(markdown, 'R1-F001', 'Replace <key> and <command>.');
    assert.match(updated, /→ Replace &lt;key> and &lt;command>\./);
    assert.deepEqual(findPlaceholders(updated), []);
  });

  it('application records escape template tokens yet round-trip as the same JSON', () => {
    const record = { v: 1, findingId: 'R1-F001', state: 'unapplied', scope: 'in-scope', affectedPaths: ['src/a.js'], dependsOn: [], verification: [], reason: 'apply failed: missing <key>' };
    const line = formatApplicationRecord(record);
    assert.deepEqual(findPlaceholders(`- entry\n${line}\n`), []);
    assert.equal(JSON.parse(/<!-- dispatch-application (.*) -->/.exec(line)[1]).reason, record.reason);
  });
});
