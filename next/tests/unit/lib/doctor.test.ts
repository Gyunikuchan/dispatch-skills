import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctorReport, formatDoctor } from '../../../skills/dispatch/scripts/lib/doctor.ts';
test('doctor preserves injected config, Node, policy, integrity and discovery probes', () => {
  const input = { node: 'v22.18.0', configPath: 'fixture/config.local.jsonc', problems: ['bad phase'], integrity: { status: 'ok' }, level: 'low', roster: ['codex[0]'], phases: { rounds: 1 }, writers: ['native'], probes: [{ provider: 'opencode', mode: 'cli', status: 'path', path: '/fixture/opencode', sandbox: false }, { provider: 'agy', mode: 'cli', status: 'missing', path: null, sandbox: null }] };
  const report = doctorReport(input), output = formatDoctor(report);
  assert.equal(report.node, input.node); assert.deepEqual(report.roster, input.roster); assert.deepEqual(input.problems, ['bad phase']);
  assert.match(output, /Node v22.18.0/); assert.match(output, /opencode\tcli\tpath\tunsupported/);
  assert.match(output, /sandbox-unsupported; set sandbox: false/); assert.match(output, /bad phase/); assert.match(output, /agy\tcli\tmissing\tn\/a/);
  const repeated = doctorReport({ ...input, probes: [...input.probes, { ...input.probes[0]!, mode: 'desktop' }, { ...input.probes[0]!, mode: 'vscode' }] });
  assert.deepEqual(repeated.diagnostics, ['bad phase', 'opencode: sandbox-unsupported; set sandbox: false in config.local.jsonc']);
  assert.equal(repeated.probes.length, 4);
});
