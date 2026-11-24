import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { generateSkillHashes } from '../../../skills/dispatch/scripts/lib/integrity.ts';
import { appendRecord } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { sessionFixture } from './helpers/session.ts';

test('doctor report resolves writers and level and reports integrity and config failures', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const config = path.join(skill, 'config.jsonc');
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'utility-subagents': { codex: { model: 'reader', 'context-limit': 300000 } },
      'write-subagents': {
        codex: { low: { model: ['first', 'second'], effort: 'low' }, high: { model: 'large', effort: 'max' } },
        claude: { high: { model: 'other' } },
      },
    }));
    const run = async (args: string[] = []) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex', ...args], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    let report = await run();
    assert.equal(report.ok, true);
    assert.equal(report.level, 'medium');
    assert.equal(report.config.path, config);
    assert.deepEqual(report.writers, {
      codex: { models: ['first', 'second'], effort: 'low', launchAs: 'launch: model first, effort low, else second' },
      claude: { models: ['other'], effort: null, launchAs: 'launch: model other, no effort set' },
    });
    await appendRecord(f.session, { kind: 'level', by: 'orchestrator', key: 'level', data: { level: 'high' } }, f.deps);
    report = await run();
    assert.equal(report.level, 'high');
    assert.deepEqual(report.writers.codex, { models: ['large'], effort: 'max', launchAs: 'launch: model large, effort max' });
    assert.equal((await run(['--level', 'low'])).level, 'low');
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'drift');
    report = await run();
    assert.equal(report.reason, 'integrity-drift');
    assert.equal(f.output().ok, false);
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    fs.writeFileSync(config, '{"unknown":true}');
    report = await run();
    assert.equal(report.reason, 'config-invalid');
    assert.ok(report.config.problems.length > 0);
    fs.writeFileSync(config, '{');
    report = await run();
    assert.equal(report.reason, 'config-invalid');
    assert.equal(report.config.path, config);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'lock')), false);
  } finally { f.cleanup(); }
});

test('doctor utility entry resolves contextLimit, reports missing host entry, and removes writer fallback', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const config = path.join(skill, 'config.jsonc');
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': { codex: { low: { model: 'writer-low', effort: 'low' } } },
      'utility-subagents': {
        codex: { model: 'fast-explorer', effort: 'low', 'context-limit': 300000 },
      },
    }));
    const run = async (args: string[] = []) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex', ...args], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };

    // Resolves contextLimit and removes explorers field
    const report = await run();
    assert.equal(report.ok, true);
    assert.equal(report.explorers, undefined);
    assert.deepEqual(report.utility.codex, { models: ['fast-explorer'], effort: 'low', contextLimit: 300000, launchAs: 'launch: model fast-explorer, effort low' });

    // Missing host entry: config has utility-subagents for claude only, but host is codex
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'utility-subagents': {
        claude: { model: 'cheap', effort: 'medium', 'context-limit': 150000 },
      },
    }));
    const missingHost = await run();
    assert.equal(missingHost.ok, false);
    assert.equal(missingHost.reason, 'config-invalid');
    assert.ok(missingHost.config.problems.some((p: string) => p.includes('utility-subagents.codex')));

    // No utility-subagents table at all
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
    }));
    const absentTable = await run();
    assert.equal(absentTable.ok, false);
    assert.equal(absentTable.reason, 'config-invalid');
    assert.ok(absentTable.config.problems.some((p: string) => p.includes('utility-subagents.codex')));

    // No writer fallback: write-subagents present for codex, but no utility-subagents
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': { codex: { low: { model: 'writer-low', effort: 'low' } } },
    }));
    const writerFallback = await run();
    assert.equal(writerFallback.utility.codex, undefined);
    assert.ok(writerFallback.config.problems.some((p: string) => p.includes('utility-subagents.codex')));
  } finally { f.cleanup(); }
});

test('doctor resolves the utility subagent per canonical platform', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const config = path.join(skill, 'config.jsonc');
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'utility-subagents': {
        'claude-code': { model: 'cheap', effort: 'medium', 'context-limit': 150000 },
        'openai-codex': { model: ['mid-a', 'mid-b'], effort: 'low', 'context-limit': 300000 },
        agy: { model: 'agy-high', 'context-limit': 300000 },
        opencode: { model: 'anthropic/claude-haiku', effort: 'low', 'context-limit': 200000 },
      },
      'write-subagents': {
        claude: { low: { model: 'writer-low', effort: 'low' } },
        'openai-codex': { medium: { model: ['mid-a', 'mid-b'], effort: 'low' }, max: { model: 'huge', effort: 'max' } },
        agy: { high: { model: 'agy-high' } },
        opencode: { max: { model: 'openai/gpt-5', effort: 'high' } },
      },
    }));
    const run = async (args: string[] = []) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex', ...args], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    const expected = {
      claude: { models: ['cheap'], effort: 'medium', contextLimit: 150000, launchAs: 'launch: model cheap, effort medium' },
      codex: { models: ['mid-a', 'mid-b'], effort: 'low', contextLimit: 300000, launchAs: 'launch: model mid-a, effort low, else mid-b' },
      agy: { models: ['agy-high'], effort: null, contextLimit: 300000, launchAs: 'launch: closest `Model` (`inherit`, `flash_lite`, `flash`, `pro`) to agy-high, no effort set' },
      opencode: { models: ['anthropic/claude-haiku'], effort: 'low', contextLimit: 200000, launchAs: 'launch: `subagent` with `model: "anthropic/claude-haiku#low"` (user-configured; set it despite the tool\'s default guidance)' },
    };
    for (const level of ['low', 'medium', 'max']) {
      const report = await run(['--level', level]);
      assert.deepEqual(report.utility, expected, level);
      assert.equal(Object.hasOwn(report.utility, 'copilot'), false);
    }
    const max = await run(['--level', 'max']);
    assert.equal(max.explorers, undefined);
    assert.deepEqual(max.writers, {
      claude: { models: ['writer-low'], effort: 'low', launchAs: 'launch: model writer-low, effort low' },
      codex: { models: ['huge'], effort: 'max', launchAs: 'launch: model huge, effort max' },
      agy: { models: ['agy-high'], effort: null, launchAs: 'launch: closest `Model` (`inherit`, `flash_lite`, `flash`, `pro`) to agy-high, no effort set' },
      opencode: { models: ['openai/gpt-5'], effort: 'high', launchAs: 'launch: `subagent` with `model: "openai/gpt-5#high"` (user-configured; set it despite the tool\'s default guidance)' },
    });
    fs.writeFileSync(config, '{"unknown":true}');
    const invalid = await run();
    assert.equal(invalid.reason, 'config-invalid');
    assert.deepEqual(invalid.utility, {});
  } finally { f.cleanup(); }
});

test('doctor reports the session host and keeps it inside the capped summary', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    const entry = (name: string) => ({ low: { model: name + '-model-with-a-long-identifier', effort: 'low' } });
    const platforms = ['claude', 'agy', 'copilot', 'opencode', 'codex'];
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': Object.fromEntries(platforms.map(name => [name, entry(name)])),
      'utility-subagents': Object.fromEntries(platforms.map(name => [name, { model: name + '-explorer-with-a-long-identifier', effort: 'low', 'context-limit': 300000 }])),
    }));
    const manifestFile = path.join(f.session, 'manifest.json');
    const run = async (host: string) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', host], { ...f.deps, skillRoot: skill }), 0);
      const out = f.output();
      return { out, value: JSON.parse(fs.readFileSync(out.path!, 'utf8')) };
    };
    fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), host: 'copilot' }));
    const declared = await run('copilot');
    assert.deepEqual(declared.value.host, { platform: 'copilot', source: 'declared' });
    assert.ok(Buffer.byteLength(JSON.stringify(declared.value)) > 1024);
    assert.ok(Buffer.byteLength(declared.out.summary) <= 1024);
    assert.ok(declared.out.summary.includes('"host":{"platform":"copilot","source":"declared"}'));
  } finally { f.cleanup(); }
});

test('doctor lists sandbox removals only for dropped delegates excluding the host provider', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    const targets = [{ low: { model: 'reader' } }];
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({
      'read-delegates': { opencode: { targets }, claude: { targets }, codex: { sandbox: false, targets }, copilot: { targets } },
      'write-subagents': { agy: { low: { model: 'writer' } } },
      'utility-subagents': { agy: { model: 'sub', 'context-limit': 300000 } },
    }));
    const run = async (sandboxSupported: Record<string, boolean> | undefined, liveness: Record<string, boolean>) => {
      f.lines.length = 0;
      await main(['doctor', 'run', '--session', f.session, '--host', 'agy'], { ...f.deps, skillRoot: skill, liveness, ...(sandboxSupported ? { sandboxSupported } : {}) });
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    const live = { opencode: true, claude: true, codex: true, copilot: true };
    const unsupported = { opencode: false, claude: false, codex: false, copilot: true };
    const report = await run(unsupported, live);
    assert.deepEqual(report.sandboxRemoved, ['opencode', 'claude']);
    assert.equal(report.ok, true);
    assert.equal(report.reason, undefined);
    assert.deepEqual((await run(unsupported, { ...live, opencode: false })).sandboxRemoved, ['claude']);
    assert.deepEqual((await run(undefined, live)).sandboxRemoved, []);
    const hostUnsupported = await run({ opencode: false, claude: false, codex: false, agy: false, copilot: true }, { ...live, agy: true });
    assert.ok(!hostUnsupported.sandboxRemoved.includes('agy'), 'host leaves sandboxRemoved: ' + JSON.stringify(hostUnsupported.sandboxRemoved));
    assert.ok(hostUnsupported.sandboxRemoved.includes('claude'), 'non-host stays: ' + JSON.stringify(hostUnsupported.sandboxRemoved));
  } finally { f.cleanup(); }
});

test('doctor reports configured writeConcurrency defaulting to 1 when omitted or invalid', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const config = path.join(skill, 'config.jsonc');
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': { codex: { low: { model: 'writer' } } },
      'utility-subagents': { codex: { model: 'reader', 'context-limit': 300000 } },
      'write-concurrency': 3,
    }));
    const run = async () => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex'], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    const configured = await run();
    assert.equal(configured.writeConcurrency, 3);

    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': { codex: { low: { model: 'writer' } } },
      'utility-subagents': { codex: { model: 'reader', 'context-limit': 300000 } },
    }));
    const omitted = await run();
    assert.equal(omitted.writeConcurrency, 1);

    fs.writeFileSync(config, '{"unknown":true}');
    const invalid = await run();
    assert.equal(invalid.writeConcurrency, 1);
  } finally { f.cleanup(); }
});

test('doctor pricing override problems are warnings that never fail the report', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const base = { 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, 'write-subagents': { codex: { low: { model: 'writer' } } }, 'utility-subagents': { codex: { model: 'reader', 'context-limit': 300000 } } };
    const run = async (config: string) => {
      fs.writeFileSync(path.join(skill, 'config.jsonc'), config);
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex'], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    let report = await run(JSON.stringify(base));
    assert.deepEqual([report.ok, report.config.problems, report.config.warnings], [true, [], []]);
    report = await run(JSON.stringify({ ...base, pricing: { 'house-model': { rates: { input: 1, output: 1 } }, bad: { rates: { output: 1 } }, worse: 5, legacy: { rates: { input: 1, output: 1 }, reasoning: 'output' }, badPeriod: { rates: { input: 1, output: 1 }, periods: [{ from: '2026-13-01', rates: { input: 2, output: 2 } }] } } }));
    assert.equal(report.ok, true);
    assert.equal(report.reason, undefined);
    assert.deepEqual(report.config.problems, []);
    assert.deepEqual(report.config.warnings, [
      'pricing.bad: rates.input missing',
      'pricing.worse: not an object',
      'pricing.legacy: unknown key reasoning',
      'pricing.badPeriod: periods[0].from must be a valid YYYY-MM-DD date',
    ]);
    report = await run(JSON.stringify({ ...base, pricing: 'cheap' }));
    assert.deepEqual([report.ok, report.config.warnings], [true, ['pricing: not an object']]);
    report = await run('{"unknown":true,"pricing":{"bad":1}}');
    assert.equal(report.reason, 'config-invalid');
    assert.deepEqual(report.config.warnings, ['pricing.bad: not an object'], 'warnings do not depend on other config problems');
    report = await run('{');
    assert.deepEqual([report.reason, report.config.warnings], ['config-invalid', []], 'a config that fails to load has no warnings');
  } finally { f.cleanup(); }
});

test('doctor requires an alias-normalized write-subagents entry for the host', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const config = path.join(skill, 'config.jsonc');
    const run = async (host: string) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', host], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };

    // Missing host writer entry (other host present)
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'utility-subagents': { codex: { model: 'reader', 'context-limit': 300000 } },
      'write-subagents': { claude: { low: { model: 'writer', effort: 'low' } } },
    }));
    const missing = await run('codex');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'config-invalid');
    assert.ok(missing.config.problems.some((p: string) => p.includes('write-subagents.codex')));

    // Alias key satisfies canonical host and normalizes writers key
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'utility-subagents': { claude: { model: 'reader', 'context-limit': 150000 } },
      'write-subagents': { 'claude-code': { low: { model: 'writer', effort: 'low' } } },
    }));
    const aliased = await run('claude');
    assert.equal(aliased.ok, true);
    assert.deepEqual(aliased.writers, { claude: { models: ['writer'], effort: 'low', launchAs: 'launch: model writer, effort low' } });
  } finally { f.cleanup(); }
});
test('doctorReportWithProbe preserves static doctor output and wires sandboxRequired and probe-failed', async () => {
  const { doctorReport, doctorReportWithProbe } = await import('../../../skills/dispatch/scripts/toolkit/doctor.ts');
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    const config = path.join(skill, 'config.jsonc');
    const targets = [{ low: { model: 'reader' } }];
    const base = {
      'write-subagents': { codex: { low: { model: 'writer' } } },
      'utility-subagents': { codex: { model: 'reader', 'context-limit': 300000 } },
    };
    const calls: string[] = [];
    const probe: import('../../../skills/dispatch/scripts/providers/probe.ts').ProbeDeps = {
      platform: { os: 'win32', bubblewrap: false, arch: 'x64', wsl: false, argvLimit: 10000, home: '/home/probe', path: [], pathExt: [] },
      discovery: { resolve: name => ({ status: 'path', path: name }), doctor: () => [], probes: 0 },
      spawn: async name => {
        calls.push(name);
        return { exit: 0, stdout: '1.2.3', stderr: '' };
      },
    };
    const args = [f.session, skill, 'low', 'codex', undefined, undefined, undefined] as const;
    fs.writeFileSync(config, '{"unknown":true}');
    assert.deepEqual(await doctorReportWithProbe(...args, probe), doctorReport(...args));
    assert.equal(calls.length, 0);

    fs.writeFileSync(config, JSON.stringify({ ...base, 'read-delegates': { claude: { sandbox: false, targets } } }));
    const staticReport = doctorReport(...args);
    assert.equal(staticReport.ok, true);
    assert.equal('probes' in staticReport, false);
    const passing = await doctorReportWithProbe(...args, probe);
    assert.deepEqual(calls, ['claude']);
    assert.ok('probeSummary' in passing);
    assert.deepEqual([passing.ok, passing.probeSummary], [true, { ok: 1, failed: 0, unprobeable: 1, unverified: 0 }]);

    calls.length = 0;
    fs.writeFileSync(config, JSON.stringify({ ...base, 'read-delegates': { 'openai-codex': { targets } } }));
    const failing = await doctorReportWithProbe(...args, {
      ...probe,
      discovery: {
        ...probe.discovery!,
        resolve(name) {
          calls.push(name);
          return { status: 'missing', path: null };
        },
      },
      spawn: async () => assert.fail('a missing host binary must not spawn'),
    });
    assert.ok(calls.length > 0 && calls.every(name => name === 'codex'));
    assert.ok('probeSummary' in failing);
    assert.deepEqual([failing.ok, failing.reason, failing.probeSummary], [false, 'probe-failed', { ok: 0, failed: 1, unprobeable: 0, unverified: 1 }]);
  } finally { f.cleanup(); }
});
