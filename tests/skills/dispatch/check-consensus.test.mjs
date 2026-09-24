import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { evaluateConsensus } from '../../../skills/dispatch/scripts/check-consensus.mjs';
import { findUnsettledResolutionLines as findUnsettled } from '../../../skills/dispatch/scripts/resolution-log.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'skills/dispatch/scripts/check-consensus.mjs');

const SOURCES = `- **Sources:** ${JSON.stringify({
  'plan-review:R1:claude:0': {
    provider: 'claude', candidateIndex: 0, model: 'opus', effort: null, status: 'target', session: null, substitutesFor: null,
  },
})}`;
const docNoSources = (...resolutionLines) =>
  ['# Plan', '', '## Proposed Changes', '- stuff', '', '## Review Findings & Resolutions', '### Round 1 — agy, 2026-09-14', ...resolutionLines].join('\n');
const doc = (...resolutionLines) => docNoSources(SOURCES, ...resolutionLines);

describe('findUnsettled', () => {
  it('returns [] when every line is settled', () => {
    const md = doc(
      '- **[Accepted]** [R1-F001] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y',
      '- **[Resolved Dispute]** [R1-F002] [MUST] [sources=plan-review:R1:claude:0] § B — tag: x → ruling',
      '- **[Rejected / Downgraded]** [R1-F003] [MUST] [sources=plan-review:R1:claude:0] § C — tag: x → rationale',
    );
    assert.deepEqual(findUnsettled(md), []);
  });

  it('returns [] when the section is absent', () => {
    assert.deepEqual(findUnsettled('# Plan\n\n- **[Disputed]** [R1-F004] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y\n'), []);
  });

  it('flags [Disputed] and pending lines with em-dash, en-dash and hyphen, section ending at EOF', () => {
    const md = doc(
      '- **[Disputed]** [R1-F005] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y',
      '- **[Rejected — pending confirmation]** [R1-F006] [MUST] [sources=plan-review:R1:claude:0] § B — tag: x → z',
      '- **[Rejected – pending confirmation]** [R1-F007] [MUST] [sources=plan-review:R1:claude:0] § C — tag: x → z',
      '- **[Rejected - pending confirmation]** [R1-F008] [MUST] [sources=plan-review:R1:claude:0] § D — tag: x → z',
      '- **[Accepted]** [R1-F009] [MUST] [sources=plan-review:R1:claude:0] § E — tag: x → y',
    );
    const found = findUnsettled(md);
    assert.equal(found.length, 4);
    assert.match(found[0], /§ A/);
    assert.match(found[3], /§ D/);
  });

  it('handles CRLF input, indented bullets, and case-insensitive tags', () => {
    const md = doc('  - **[disputed]** [R1-F010] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y', '- **[REJECTED — Pending Confirmation]** [R1-F011] [MUST] [sources=plan-review:R1:claude:0] § B — tag').replace(/\n/g, '\r\n');
    const found = findUnsettled(md);
    assert.equal(found.length, 2);
    assert.ok(found.every((l) => !l.includes('\r')));
  });

  it('tolerates heading case and trailing text', () => {
    const md = '# P\n\n## review findings & resolutions (round log)\n- **[Rejected — pending confirmation]** [R1-F012] [MUST] [sources=plan-review:R1:claude:0] § A — tag\n';
    assert.equal(findUnsettled(md).length, 1);
  });

  it('flags `*` bullets', () => {
    assert.equal(findUnsettled(doc('* **[Disputed]** [R1-F013] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y')).length, 1);
  });

  it('does not end the section at a `## ` line inside a fenced block', () => {
    const md = doc('```markdown', '## Not a heading', '```', '~~~', '## Also not', '~~~', '- **[Disputed]** [R1-F014] [MUST] [sources=plan-review:R1:claude:0] § A — tag');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('closes a fence only on its own marker', () => {
    // A ~~~ line inside a ``` block must not close it, and vice versa.
    const tildeInBacktick = doc('```', '~~~', '- **[Disputed]** [R1-F015] [MUST] [sources=plan-review:R1:claude:0] fenced', '```', '- **[Accepted]** [R1-F016] [MUST] [sources=plan-review:R1:claude:0] real');
    assert.deepEqual(findUnsettled(tildeInBacktick), []);
    const backtickInTilde = doc('~~~', '```', '~~~', '- **[Disputed]** [R1-F017] [MUST] [sources=plan-review:R1:claude:0] real');
    assert.equal(findUnsettled(backtickInTilde).length, 1);
  });

  it('fails closed on an unterminated fence', () => {
    const md = ['# P', 'stray ``` below', '```', '## Review Findings & Resolutions', '- **[Disputed]** [R1-F018] [MUST] [sources=plan-review:R1:claude:0] § A — tag'].join('\n');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('fails closed on an unterminated fence that holds a fake findings section', () => {
    const md = [
      '# P',
      '~~~',
      '## Review Findings & Resolutions',
      '- **[Accepted]** [R1-F019] [MUST] [sources=plan-review:R1:claude:0] fake',
      '## Proposed Changes',
      'x',
      '## Review Findings & Resolutions',
      '- **[Rejected - pending confirmation]** [R1-F020] [MUST] [sources=plan-review:R1:claude:0] real',
    ].join('\n');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('does not treat a backtick opener with backticks in its info string as a fence', () => {
    const md = ['``` a```', '## Review Findings & Resolutions', '- **[Disputed]** [R1-F021] [MUST] [sources=plan-review:R1:claude:0] real', '```'].join('\n');
    assert.deepEqual(findUnsettled(md), ['- **[Disputed]** [R1-F021] [MUST] [sources=plan-review:R1:claude:0] real']);
  });

  it('still opens a tilde fence whose info string contains a backtick', () => {
    const md = doc('~~~ x`y', '- **[Disputed]** [R1-F023] [MUST] [sources=plan-review:R1:claude:0] fenced', '~~~', '- **[Accepted]** [R1-F024] [MUST] [sources=plan-review:R1:claude:0] real');
    assert.deepEqual(findUnsettled(md), []);
  });

  it('checks every unfenced findings section', () => {
    const md = [
      '## Review Findings & Resolutions',
      '- **[Accepted]** [R1-F025] [MUST] [sources=plan-review:R1:claude:0] a',
      '## Out of Scope',
      'x',
      '## Review Findings & Resolutions',
      '- **[Disputed]** [R1-F026] [MUST] [sources=plan-review:R1:claude:0] b',
    ].join('\n');
    assert.equal(findUnsettled(md).length, 1);
  });

  it('counts identical unsettled lines by occurrence', () => {
    assert.equal(findUnsettled(doc('- **[Disputed]** [R1-F900] [MUST] [sources=plan-review:R1:claude:0] same', '- **[Disputed]** [R1-F900] [MUST] [sources=plan-review:R1:claude:0] same')).length, 2);
    // Also through the fail-closed merge, which must not double-count or collapse them.
    const open = ['```', '## Review Findings & Resolutions', '- **[Disputed]** [R1-F900] [MUST] [sources=plan-review:R1:claude:0] same', '- **[Disputed]** [R1-F900] [MUST] [sources=plan-review:R1:claude:0] same'].join('\n');
    assert.equal(findUnsettled(open).length, 2);
  });

  it('ignores a fenced fake heading and bullets above the real section', () => {
    const md = [
      '# P',
      '```',
      '## Review Findings & Resolutions',
      '- **[Disputed]** [R1-F031] [MUST] [sources=plan-review:R1:claude:0] fake',
      '```',
      '## Proposed Changes',
      '- **[Disputed]** [R1-F032] [MUST] [sources=plan-review:R1:claude:0] outside',
      '## Review Findings & Resolutions',
      '- **[Accepted]** [R1-F033] [MUST] [sources=plan-review:R1:claude:0] § A — tag',
    ].join('\n');
    assert.deepEqual(findUnsettled(md), []);
  });

  it('ignores matching text in a later ## section', () => {
    const md = `${doc('- **[Accepted]** [R1-F034] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y')}\n\n## Out of Scope\n- **[Disputed]** [R1-F035] [MUST] [sources=plan-review:R1:claude:0] not a resolution\n`;
    assert.deepEqual(findUnsettled(md), []);
  });
});

describe('check-consensus CLI', () => {
  const runOn = (content, args = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-consensus-'));
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, content);
    try {
      return spawnSync(process.execPath, [SCRIPT, ...args, file], { encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits 0 and prints "Consensus: settled" when nothing is unsettled', () => {
    const res = runOn(doc('- **[Accepted]** [R1-F036] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y'));
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Consensus: settled/);
  });

  it('exits 1 listing each unsettled line', () => {
    const res = runOn(doc('- **[Disputed]** [R1-F037] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y', '- **[Rejected — pending confirmation]** [R1-F038] [MUST] [sources=plan-review:R1:claude:0] § B — tag'));
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /§ A/);
    assert.match(res.stdout + res.stderr, /§ B/);
  });

  it('exits 2 on a missing file or missing argument', () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'no-such-plan-xyz.md')], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  });

  it('returns structured enriched findings and rejects non-enriched bullets', () => {
    const sourceMap = JSON.stringify({
      'plan-review:R1:claude:0': {
        provider: 'claude',
        candidateIndex: 0,
        model: 'opus',
        effort: null,
        status: 'target',
        session: 'abc',
        substitutesFor: null,
      },
    });
    const enriched = runOn([
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 1 — Claude',
      `- **Sources:** ${sourceMap}`,
      '- **[Rejected — pending confirmation]** [R1-F001] [SHOULD] [sources=plan-review:R1:claude:0] § A — tag: x → y',
    ].join('\n'), ['--json']);
    assert.equal(enriched.status, 1, enriched.stderr);
    assert.deepEqual(JSON.parse(enriched.stdout), {
      settled: false,
      unsettled: [{
        key: 'R1-F001',
        id: 'R1-F001',
        severity: 'SHOULD',
        sourceKeys: ['plan-review:R1:claude:0'],
        status: 'pendingConfirmation',
        lineNumber: 5,
        originalLine: '- **[Rejected — pending confirmation]** [R1-F001] [SHOULD] [sources=plan-review:R1:claude:0] § A — tag: x → y',
      }],
    });

    const bare = runOn(doc('- **[Disputed]** § A — tag: x → y'), ['--json']);
    assert.equal(bare.status, 2, 'non-enriched bullets are rejected by the strict gate');
  });

  it('uses exit 2 for malformed enriched state in JSON mode', () => {
    const malformed = runOn(docNoSources(
      '- **[Disputed]** [R1-F001] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y',
    ), ['--json']);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /structured source map/);
  });

  it('uses exit 2 for unpadded finding IDs in both output modes', () => {
    const unpadded = doc('- **[Accepted]** [R1-F1] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y');
    for (const args of [[], ['--json']]) {
      const result = runOn(unpadded, args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /malformed enriched finding prefix/);
    }
  });
});

describe('evaluateConsensus', () => {
  it('reports settled, live, and strict-invalid logs with the gate exit codes', () => {
    assert.deepEqual(evaluateConsensus(doc('- **[Accepted]** [R1-F040] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y')), {
      exit: 0, unsettled: [], unsettledItems: [],
    });

    const live = evaluateConsensus(doc('- **[Disputed]** [R1-F041] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y'));
    assert.equal(live.exit, 1);
    assert.deepEqual(live.unsettled, ['- **[Disputed]** [R1-F041] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y']);
    assert.equal(live.unsettledItems[0].status, 'disputed');

    // Settled under the lenient scan, but the strict gate rejects the unpadded ID.
    const invalid = evaluateConsensus(doc('- **[Accepted]** [R1-F1] [MUST] [sources=plan-review:R1:claude:0] § A — tag: x → y'));
    assert.equal(invalid.exit, 2);
    assert.deepEqual([invalid.unsettled, invalid.unsettledItems], [[], []]);
    assert.match(invalid.error, /malformed enriched finding prefix/);
  });
});
