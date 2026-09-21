import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { parseRebuttal, parseReport } from '../../../skills/dispatch/scripts/parse-report.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const cli = path.join(root, 'skills', 'dispatch', 'scripts', 'parse-report.mjs');

describe('design review report parsing', () => {
  it('accepts design tags and section loci', () => {
    const parsed = parseReport('design', JSON.stringify({ status: 'CLEAN', findings: [] }));
    assert.equal(parsed.reportKind, 'design');
    const findings = parseReport('design', JSON.stringify({
      status: 'FINDINGS',
      findings: [{ severity: 'MUST', locus: '§ Architecture & Boundaries', tag: 'graph-correctness', defect: 'd', requiredChange: 'r' }],
    }));
    assert.equal(findings.findings.length, 1);
  });

  it('parses a design rebuttal', () => {
    const parsed = parseRebuttal('design', JSON.stringify({
      responses: [{ type: 'rebuttal', key: 'R1-F001', verdict: 'CONFIRM', evidence: '§ Architecture & Boundaries covers it.' }],
    }), ['R1-F001']);
    assert.equal(parsed.mode, 'rebuttal');
    assert.equal(parsed.responses[0].verdict, 'CONFIRM');
  });

  it('parses a design rebuttal via parse-report --kind design --rebuttal-packet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-rebuttal-'));
    try {
      const packet = path.join(dir, 'packet.json');
      fs.writeFileSync(packet, JSON.stringify({ findings: [{ key: 'R1-F001' }] }));
      const res = spawnSync(process.execPath, [cli, '--kind', 'design', '--rebuttal-packet', packet], {
        cwd: root,
        encoding: 'utf8',
        input: JSON.stringify({ responses: [{ type: 'rebuttal', key: 'R1-F001', verdict: 'CONFIRM', evidence: '§ Architecture & Boundaries covers it.' }] }),
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(JSON.parse(res.stdout).responses[0].key, 'R1-F001');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with a usage diagnostic naming the three kinds for a missing or unknown --kind', () => {
    for (const args of [[], ['--kind', 'essay']]) {
      const res = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', input: '{}' });
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, /plan\|code\|design/);
    }
  });
});
