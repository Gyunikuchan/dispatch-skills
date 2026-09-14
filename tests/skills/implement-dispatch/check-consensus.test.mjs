import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { findUnsettled } from '../../../skills/implement-dispatch/scripts/check-consensus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'skills/implement-dispatch/scripts/check-consensus.mjs');

const doc = (...resolutionLines) =>
  ['# Plan', '', '## Proposed Changes', '- stuff', '', '## Review Findings & Resolutions', '### Round 1 — agy, 2026-09-14', ...resolutionLines].join('\n');

describe('findUnsettled', () => {
  it('returns [] when every line is settled', () => {
    const md = doc(
      '- **[Accepted]** § A — tag: x → y',
      '- **[Resolved Dispute]** § B — tag: x → ruling',
      '- **[Rejected / Downgraded]** § C — tag: x → rationale',
    );
    assert.deepEqual(findUnsettled(md), []);
  });

  it('returns [] when the section is absent', () => {
    assert.deepEqual(findUnsettled('# Plan\n\n- **[Disputed]** § A — tag: x → y\n'), []);
  });

  it('flags [Disputed] and pending lines with em-dash, en-dash and hyphen, section ending at EOF', () => {
    const md = doc(
      '- **[Disputed]** § A — tag: x → y',
      '- **[Rejected — pending confirmation]** § B — tag: x → z',
      '- **[Rejected – pending confirmation]** § C — tag: x → z',
      '- **[Rejected - pending confirmation]** § D — tag: x → z',
      '- **[Accepted]** § E — tag: x → y',
    );
    const found = findUnsettled(md);
    assert.equal(found.length, 4);
    assert.match(found[0], /§ A/);
    assert.match(found[3], /§ D/);
  });

  it('handles CRLF input, indented bullets, and case-insensitive tags', () => {
    const md = doc('  - **[disputed]** § A — tag: x → y', '- **[REJECTED — Pending Confirmation]** § B — tag').replace(/\n/g, '\r\n');
    const found = findUnsettled(md);
    assert.equal(found.length, 2);
    assert.ok(found.every((l) => !l.includes('\r')));
  });

  it('tolerates heading case and trailing text', () => {
    const md = '# P\n\n## review findings & resolutions (round log)\n- **[Rejected — pending confirmation]** § A — tag\n';
    assert.equal(findUnsettled(md).length, 1);
  });

  it('flags `*` bullets', () => {
    assert.equal(findUnsettled(doc('* **[Disputed]** § A — tag: x → y')).length, 1);
  });

  it('does not end the section at a `## ` line inside a fenced block', () => {
    const md = doc('```markdown', '## Not a heading', '```', '~~~', '## Also not', '~~~', '- **[Disputed]** § A — tag');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('closes a fence only on its own marker', () => {
    // A ~~~ line inside a ``` block must not close it, and vice versa.
    const tildeInBacktick = doc('```', '~~~', '- **[Disputed]** fenced', '```', '- **[Accepted]** real');
    assert.deepEqual(findUnsettled(tildeInBacktick), []);
    const backtickInTilde = doc('~~~', '```', '~~~', '- **[Disputed]** real');
    assert.equal(findUnsettled(backtickInTilde).length, 1);
  });

  it('fails closed on an unterminated fence', () => {
    const md = ['# P', 'stray ``` below', '```', '## Review Findings & Resolutions', '- **[Disputed]** § A — tag'].join('\n');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('fails closed on an unterminated fence that holds a fake findings section', () => {
    const md = [
      '# P',
      '~~~',
      '## Review Findings & Resolutions',
      '- **[Accepted]** fake',
      '## Proposed Changes',
      'x',
      '## Review Findings & Resolutions',
      '- **[Rejected - pending confirmation]** real',
    ].join('\n');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('does not treat a backtick opener with backticks in its info string as a fence', () => {
    const md = ['``` a```', '## Review Findings & Resolutions', '- **[Disputed]** real', '```'].join('\n');
    assert.deepEqual(findUnsettled(md), ['- **[Disputed]** real']);
  });

  it('still opens a tilde fence whose info string contains a backtick', () => {
    const md = doc('~~~ x`y', '- **[Disputed]** fenced', '~~~', '- **[Accepted]** real');
    assert.deepEqual(findUnsettled(md), []);
  });

  it('checks every unfenced findings section', () => {
    const md = [
      '## Review Findings & Resolutions',
      '- **[Accepted]** a',
      '## Out of Scope',
      'x',
      '## Review Findings & Resolutions',
      '- **[Disputed]** b',
    ].join('\n');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('counts identical unsettled lines by occurrence', () => {
    assert.equal(findUnsettled(doc('- **[Disputed]** same', '- **[Disputed]** same')).length, 2);
    // Also through the fail-closed merge, which must not double-count or collapse them.
    const open = ['```', '## Review Findings & Resolutions', '- **[Disputed]** same', '- **[Disputed]** same'].join('\n');
    assert.equal(findUnsettled(open).length, 2);
  });

  it('ignores a fenced fake heading and bullets above the real section', () => {
    const md = [
      '# P',
      '```',
      '## Review Findings & Resolutions',
      '- **[Disputed]** fake',
      '```',
      '## Proposed Changes',
      '- **[Disputed]** outside',
      '## Review Findings & Resolutions',
      '- **[Accepted]** § A — tag',
    ].join('\n');
    assert.deepEqual(findUnsettled(md), []);
  });

  it('ignores matching text in a later ## section', () => {
    const md = `${doc('- **[Accepted]** § A — tag: x → y')}\n\n## Out of Scope\n- **[Disputed]** not a resolution\n`;
    assert.deepEqual(findUnsettled(md), []);
  });
});

describe('check-consensus CLI', () => {
  const runOn = (content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-consensus-'));
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, content);
    try {
      return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits 0 and prints "Consensus: settled" when nothing is unsettled', () => {
    const res = runOn(doc('- **[Accepted]** § A — tag: x → y'));
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Consensus: settled/);
  });

  it('exits 1 listing each unsettled line', () => {
    const res = runOn(doc('- **[Disputed]** § A — tag: x → y', '- **[Rejected — pending confirmation]** § B — tag'));
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /§ A/);
    assert.match(res.stdout + res.stderr, /§ B/);
  });

  it('exits 2 on a missing file or missing argument', () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'no-such-plan-xyz.md')], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  });
});
