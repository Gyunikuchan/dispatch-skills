import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  buildRebuttalPackets,
  writeRebuttalPackets,
} from '../../../../skills/dispatch/scripts/review/rebuttal-packets.mjs';
import { scanResolutionLog } from '../../../../skills/dispatch/scripts/review/resolution-log.mjs';

const sourceMap = {
  'code-review:R1:claude:0': {
    provider: 'claude',
    candidateIndex: 0,
    model: 'opus',
    effort: 'medium',
    status: 'target',
    session: 'session-1',
    substitutesFor: null,
  },
  'code-review:R1:copilot:0': {
    provider: 'copilot',
    candidateIndex: 0,
    model: 'gpt',
    effort: 'high',
    status: 'replacement',
    session: null,
    substitutesFor: 'code-review:R1:agy:0',
  },
};

const artifact = [
  '# Walkthrough',
  '## Changes Made',
  '- Kept.',
  '## Review Findings & Resolutions',
  '### Round 1 — Claude and Copilot',
  `- **Sources:** ${JSON.stringify(sourceMap)}`,
  '- **[Rejected — pending confirmation]** [R1-F001] [SHOULD] [sources=code-review:R1:claude:0,code-review:R1:copilot:0] src/a.mjs:L4 — runtime: x → y',
  '- **[Accepted]** [R1-F002] [CONSIDER] [sources=code-review:R1:claude:0] src/b.mjs:L2 — tests: x → y',
].join('\n');

const context = {
  findings: [{
    key: 'R1-F001',
    orchestratorVerdict: 'reject',
    counterEvidence: 'src/a.mjs:L4 guards the value.',
    changedExcerpts: ['src/a.mjs:L4: if (value)'],
  }],
};

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('rebuttal packet builder', () => {
  it('round hash includes failed target record', () => {
    const original = buildRebuttalPackets(artifact, context);
    const changed = artifact.replace(`- **Sources:** ${JSON.stringify(sourceMap)}`, `- **Sources:** ${JSON.stringify(sourceMap)}\n- failed-targets: [{"sourceKey":"code-review:R1:agy:0","kind":"quota"}]`);
    const updated = buildRebuttalPackets(changed, context);
    assert.notEqual(updated[0].packet.canonicalLogHash, original[0].packet.canonicalLogHash);
    assert.notEqual(scanResolutionLog(changed).rounds[0].hash, scanResolutionLog(artifact).rounds[0].hash);
  });

  it('groups only live findings by every citing source', () => {
    const packets = buildRebuttalPackets(artifact, context);
    assert.equal(packets.length, 2);
    assert.deepEqual(packets.map((packet) => packet.sourceKey), [
      'code-review:R1:claude:0',
      'code-review:R1:copilot:0',
    ]);
    assert.ok(packets.every((packet) => packet.packet.findings.length === 1));
    assert.equal(packets[0].packet.findings[0].key, 'R1-F001');
    assert.equal(packets[1].source.status, 'replacement');
    assert.equal(JSON.stringify(packets).includes('R1-F002'), false);
    assert.equal(Object.hasOwn(packets[0].packet, 'source'), false);
  });

  it('rejects non-enriched bullets', () => {
    const bare = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 3 — Claude and Copilot, 2026-09-17',
      '- **[Disputed]** § A — intent: x → y',
    ].join('\n');
    assert.throws(() => buildRebuttalPackets(bare, { findings: [] }));
  });

  it('rejects incomplete or unknown context keys', () => {
    assert.throws(() => buildRebuttalPackets(artifact, { findings: [] }), /missing finding key/);
    assert.throws(() => buildRebuttalPackets(artifact, {
      findings: [{ ...context.findings[0], key: 'R1-F999' }],
    }), /unknown finding key/);
  });

  it('writes private OS-temp packet files and returns cleanup paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuttal-builder-test-'));
    tempDirs.push(dir);
    const artifactPath = path.join(dir, 'walkthrough.md');
    const contextPath = path.join(dir, 'context.json');
    fs.writeFileSync(artifactPath, artifact);
    fs.writeFileSync(contextPath, JSON.stringify(context));
    const result = writeRebuttalPackets({ artifact: artifactPath, context: contextPath });
    tempDirs.push(...result.cleanupPaths);
    assert.equal(result.packets.length, 2);
    assert.ok(result.packets.every((packet) => fs.existsSync(packet.packetPath)));
    assert.deepEqual(result.packets[0].keys, ['R1-F001']);
  });
});
