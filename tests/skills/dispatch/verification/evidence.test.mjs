import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  compareFailureIdentity,
  captureRepositoryState,
  criterionMappings,
  diffRepositoryState,
  extractApprovedPathSet,
  failureIdentity,
  findingDigest,
  mapVerificationCommandsToPaths,
  normalizeDiagnostic,
  outcomeFirstPacket,
  parsePorcelainZ,
} from '../../../../skills/dispatch/scripts/verification/evidence.mjs';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// SECTION: Plan evidence mapping

describe('verification evidence', () => {
  it('extracts normalized paths from proposed change headings', () => {
    const plan = [
      '## Proposed Changes',
      '#### [MODIFY] `src/a.js`',
      '#### [NEW] ./tests/a.test.js — adds coverage',
      '#### [DELETE] src/old.js',
      '## Verification Plan',
      '#### [MODIFY] `ignored.js`',
    ].join('\n');
    assert.deepEqual(extractApprovedPathSet(plan), ['src/a.js', 'src/old.js', 'tests/a.test.js']);
  });

  it('ignores non-structural examples and rejects unsafe paths', () => {
    const plan = [
      '## Proposed Changes',
      '````markdown',
      '#### [NEW] docs/example.md',
      '```',
      '#### [NEW] still-inside-fence.md',
      '````',
      '> #### [NEW] quoted.md',
      '<!-- #### [NEW] hidden.md -->',
      '#### [NEW] src/commented.js <!-- keep -->',
      '```js',
      '<!-- sample',
      '```',
      '#### [NEW] src/after-fence.js',
      '#### [MODIFY] src/../escape.js',
      '#### [MODIFY] src\\\\windows.js',
      '#### [NEW] `src/real file.js` — annotation',
      '## Verification Plan',
    ].join('\n');
    assert.deepEqual(extractApprovedPathSet(plan), [
      'src/after-fence.js',
      'src/commented.js',
      'src/real file.js',
    ]);
  });

  it('returns the explicit fallback when no change heading parses', () => {
    assert.deepEqual(extractApprovedPathSet('# Native plan'), []);
  });

  it('maps a command to criterion paths only when every referencing criterion has Changes', () => {
    const plan = [
      '## Success Criteria',
      '- [SC1] Source.',
      '  - Changes: src/a.js',
      '  - Verify: `npm test`',
      '- [SC2] Test.',
      '  - Changes: tests/a.test.js',
      '  - Verify: `npm test`',
      '## Proposed Changes',
      '#### [MODIFY] src/a.js',
      '#### [NEW] tests/a.test.js',
      '#### [MODIFY] docs/readme.md',
    ].join('\n');
    assert.deepEqual(
      mapVerificationCommandsToPaths(plan, ['npm test'], extractApprovedPathSet(plan)),
      { 'npm test': ['src/a.js', 'tests/a.test.js'] },
    );
  });

  it('falls back to the full approved set for unmapped or incompletely mapped commands', () => {
    const plan = [
      '## Success Criteria',
      '- [SC1] Mapped.',
      '  - Changes: src/a.js',
      '  - Verify: `npm test`',
      '- [SC2] Missing paths.',
      '  - Verify: `npm test`',
      '## Proposed Changes',
      '#### [MODIFY] src/a.js',
      '#### [NEW] tests/a.test.js',
    ].join('\n');
    const approved = extractApprovedPathSet(plan);
    assert.deepEqual(mapVerificationCommandsToPaths(plan, ['npm test', 'npm run lint'], approved), {
      'npm test': approved,
      'npm run lint': approved,
    });
  });

  it('falls back when any referenced Changes path is invalid or outside approved paths', () => {
    const approved = ['src/a.js', 'tests/a.test.js'];
    for (const changedPath of ['../native-warning.js', 'native/unapproved.js']) {
      const plan = [
        '## Success Criteria',
        '- [SC1] Native-compatible warning-only mapping.',
        `  - Changes: ${changedPath}`,
        '  - Verify: `npm test`',
      ].join('\n');
      assert.deepEqual(mapVerificationCommandsToPaths(plan, ['npm test'], approved), {
        'npm test': approved,
      });
    }
  });

  it('matches Verify commands by exact trimmed string and deduplicates mapped paths', () => {
    const plan = [
      '## Success Criteria',
      '- [SC1] Exact.',
      '  - Changes: ./src/a.js, src/a.js',
      '  - Verify: ` npm test `',
      '## Proposed Changes',
      '#### [MODIFY] src/a.js',
      '#### [NEW] tests/a.test.js',
    ].join('\n');
    const approved = extractApprovedPathSet(plan);
    assert.deepEqual(mapVerificationCommandsToPaths(plan, ['npm test', 'npm test --'], approved), {
      'npm test': ['src/a.js'],
      'npm test --': approved,
    });
  });

  it('parses a [FINAL] Verify suffix into the command and finalCommands', () => {
    const plan = [
      '## Success Criteria',
      '- [SC1] Final-only suite.',
      '  - Changes: src/a.js',
      '  - Verify: `npm test` [FINAL]',
      '  - Evidence: verify',
      '- [SC2] Narrow check.',
      '  - Changes: tests/a.test.js',
      '  - Verify: `node --test tests/a.test.js`',
      '  - Evidence: red',
      '## Proposed Changes',
      '#### [MODIFY] src/a.js',
      '#### [NEW] tests/a.test.js',
    ].join('\n');
    const [final, narrow] = criterionMappings(plan);
    assert.deepEqual(final.commands, ['npm test']);
    assert.deepEqual(final.finalCommands, ['npm test']);
    assert.deepEqual(narrow.commands, ['node --test tests/a.test.js']);
    assert.deepEqual(narrow.finalCommands, []);
    assert.deepEqual(mapVerificationCommandsToPaths(plan, ['npm test', 'node --test tests/a.test.js'], extractApprovedPathSet(plan)), {
      'npm test': ['src/a.js'],
      'node --test tests/a.test.js': ['tests/a.test.js'],
    });
  });

  it('maps backticked Changes paths containing spaces', () => {
    const plan = [
      '## Success Criteria',
      '- [SC1] Spaced path.',
      '  - Changes: `src/file with spaces.js`, tests/a.test.js',
      '  - Verify: `npm test`',
      '## Proposed Changes',
      '#### [MODIFY] `src/file with spaces.js`',
      '#### [NEW] tests/a.test.js',
    ].join('\n');
    const approved = extractApprovedPathSet(plan);
    assert.deepEqual(mapVerificationCommandsToPaths(plan, ['npm test'], approved), {
      'npm test': ['src/file with spaces.js', 'tests/a.test.js'],
    });
  });

  // SECTION: Repository state evidence

  it('parses both paths in rename and copy porcelain records', () => {
    const records = parsePorcelainZ(' M src/a.js\0R  src/new.js\0src/old.js\0C  copy.js\0source.js\0?? new.txt\0');
    assert.deepEqual(records.map(({ status, paths }) => ({ status, paths })), [
      { status: ' M', paths: ['src/a.js'] },
      { status: 'R ', paths: ['src/new.js', 'src/old.js'] },
      { status: 'C ', paths: ['copy.js', 'source.js'] },
      { status: '??', paths: ['new.txt'] },
    ]);
  });

  it('reports state deltas by path and object identity', () => {
    const before = { entries: { 'a.js': { status: ' M', objectId: 'sha-a' }, 'gone.js': { status: ' D', objectId: 'absent' } } };
    const after = { entries: { 'a.js': { status: ' M', objectId: 'sha-b' }, 'new.js': { status: '??', objectId: 'sha-c' } } };
    assert.deepEqual(diffRepositoryState(before, after), {
      changed: ['a.js', 'gone.js', 'new.js'],
      added: ['new.js'],
      removed: ['gone.js'],
    });
  });

  it('captures modified, deleted, renamed, and untracked paths in a real repository', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-evidence-'));
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'modified.js'), 'before\n');
    fs.writeFileSync(path.join(repo, 'deleted.js'), 'delete\n');
    fs.writeFileSync(path.join(repo, 'old.js'), 'rename\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'modified.js'), 'after\n');
    fs.rmSync(path.join(repo, 'deleted.js'));
    fs.renameSync(path.join(repo, 'old.js'), path.join(repo, 'new.js'));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'untracked.js'), 'new\n');

    const capture = captureRepositoryState(repo);
    assert.equal(capture.available, true);
    assert.match(capture.entries['modified.js'].objectId, /^[0-9a-f]{40,64}$/);
    assert.equal(capture.entries['deleted.js'].objectId, 'absent');
    assert.equal(capture.entries['old.js'].objectId, 'absent');
    assert.match(capture.entries['new.js'].objectId, /^[0-9a-f]{40,64}$/);
    assert.match(capture.entries['untracked.js'].objectId, /^[0-9a-f]{40,64}$/);
    assert.equal(captureRepositoryState(os.tmpdir()).available, false);
  });

  it('extracts approved paths, maps commands, and captures state for one plan', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-plan-'));
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const plan = path.join(repo, 'plan.md');
    fs.writeFileSync(plan, [
      '## Success Criteria',
      '- [SC1] Covered.',
      '  - Changes: src/a.js',
      '  - Verify: `npm test`',
      '## Proposed Changes',
      '#### [NEW] src/a.js',
      '#### [NEW] docs/readme.md',
    ].join('\n'));
    const source = fs.readFileSync(plan, 'utf8');
    assert.deepEqual(extractApprovedPathSet(source), ['docs/readme.md', 'src/a.js']);
    assert.deepEqual(mapVerificationCommandsToPaths(source, ['npm test', 'npm run lint']), {
      'npm test': ['src/a.js'],
      'npm run lint': ['docs/readme.md', 'src/a.js'],
    });
    assert.equal(captureRepositoryState(repo).available, true);
  });

  it('rejects newline paths with a stable capture diagnostic', { skip: process.platform === 'win32' ? 'NTFS forbids LF in filenames, so the fixture cannot exist on win32' : false }, () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-newline-'));
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'line\nbreak.js'), 'new\n');
    assert.throws(
      () => captureRepositoryState(repo),
      /Unsupported Git path contains a newline; side-effect capture unavailable\./,
    );
  });

  // SECTION: Outcome packets and failure identity

  it('reads governingOutcome.context from the plan body after JSON frontmatter, not the frontmatter itself (SC6)', () => {
    const plan = [
      '---',
      '{"dispatch":{"schemaVersion":1,"kind":"plan","slug":"sample","contentHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}',
      '---',
      '# Sample plan',
      '',
      'This is the real context paragraph describing the change.',
      '',
      '## Proposed Changes',
      '#### [MODIFY] src/a.js',
    ].join('\n');
    const packet = outcomeFirstPacket(plan, []);
    assert.notEqual(packet.governingOutcome.context, '{', 'context must not be the frontmatter opening brace');
    assert.match(packet.governingOutcome.context, /real context paragraph/);
  });

  it('normalizes volatile diagnostics and compares stable failure identities', () => {
    const first = failureIdentity({
      exitStatus: 1,
      identifiers: ['test:alpha'],
      diagnostic: 'failed at 2026-09-20T00:00:00Z in 12.4ms /tmp/run-123/output',
    });
    const second = failureIdentity({
      exitStatus: 1,
      identifiers: ['test:alpha'],
      diagnostic: 'different prose',
    });
    assert.equal(compareFailureIdentity(first, second), true);
    assert.equal(normalizeDiagnostic('at 2026-09-20T00:00:00Z took 12.4ms /tmp/run-123/output'), 'at <timestamp> took <duration> <tmp-path>');
    assert.equal(compareFailureIdentity(first, { ...second, exitStatus: 2 }), false);
  });
});

// SECTION: Prior-finding digest

describe('prior-finding digest', () => {
  it('keeps bounded entry headlines, drops source lines, and counts omissions', () => {
    const entry = (n, extra = '') => `- **[F${n}] MUST** src/a.js:L${n} — defect ${n}${extra}`;
    const log = ['## Review Findings & Resolutions', entry(1, 'x'.repeat(400)), '  - **Sources:** code-review:R1', entry(2), ...Array.from({ length: 40 }, (_, i) => entry(i + 3, 'y'.repeat(200)))].join('\n');
    const digest = findingDigest(log).split('\n');
    assert.ok(digest[0].startsWith('- **[F1]') && digest[0].length === 240 && digest[0].endsWith('…'));
    assert.ok(!digest.some(line => line.includes('Sources')));
    assert.ok(digest.join('\n').length <= 4000 + 80);
    assert.match(digest.at(-1), /^… \d+ more in the governing plan's Review Findings/);
  });
  it('falls back to a bounded prefix when no entries parse', () => {
    assert.equal(findingDigest('free text'), 'free text');
    assert.equal(findingDigest('z'.repeat(5000)).length, 4000);
  });
});
