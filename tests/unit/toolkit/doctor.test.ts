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
    assert.deepEqual(report.writers, { codex: { models: ['first', 'second'], effort: 'low' }, claude: { models: ['other'], effort: null } });
    await appendRecord(f.session, { kind: 'level', by: 'orchestrator', key: 'level', data: { level: 'high' } }, f.deps);
    report = await run();
    assert.equal(report.level, 'high');
    assert.deepEqual(report.writers.codex, { models: ['large'], effort: 'max' });
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

test('doctor reports explorers independent of level', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const config = path.join(skill, 'config.jsonc');
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } },
      'explore-subagents': {
        codex: { model: 'fast-explorer', effort: 'low' },
      },
    }));
    const run = async (args: string[] = []) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex', ...args], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };

    const high = await run(['--level', 'high']);
    assert.deepEqual(high.explorers, { codex: { models: ['fast-explorer'], effort: 'low' } });
    const low = await run(['--level', 'low']);
    assert.deepEqual(low.explorers, high.explorers);

    fs.writeFileSync(config, JSON.stringify({ 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } } }));
    const absent = await run();
    assert.deepEqual(absent.explorers, {});
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
      'explore-subagents': { 'claude-code': { model: 'cheap', effort: 'medium' } },
      'write-subagents': {
        claude: { low: { model: 'writer-low', effort: 'low' } },
        'openai-codex': { medium: { model: ['mid-a', 'mid-b'], effort: 'low' }, max: { model: 'huge', effort: 'max' } },
        agy: { high: { model: 'agy-high' } },
      },
    }));
    const run = async (args: string[] = []) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'codex', ...args], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    const expected = {
      claude: { models: ['cheap'], effort: 'medium' },
      codex: { models: ['mid-a', 'mid-b'], effort: 'low' },
      agy: { models: ['agy-high'], effort: null },
    };
    for (const level of ['low', 'medium', 'max']) {
      const report = await run(['--level', level]);
      assert.deepEqual(report.utility, expected, level);
      assert.equal(Object.hasOwn(report.utility, 'copilot'), false);
    }
    const max = await run(['--level', 'max']);
    assert.deepEqual(max.explorers, { 'claude-code': { models: ['cheap'], effort: 'medium' } });
    assert.deepEqual(max.writers, {
      claude: { models: ['writer-low'], effort: 'low' },
      'openai-codex': { models: ['huge'], effort: 'max' },
      agy: { models: ['agy-high'], effort: null },
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
      'explore-subagents': Object.fromEntries(platforms.map(name => [name, { model: name + '-explorer-with-a-long-identifier', effort: 'low' }])),
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

test('doctor lists sandbox removals only for delegates the live roster drops', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    const targets = [{ low: { model: 'reader' } }];
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({
      'read-delegates': { opencode: { targets }, claude: { targets }, codex: { sandbox: false, targets }, copilot: { targets } },
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
  } finally { f.cleanup(); }
});

test('doctor sandboxRemoved excludes the host provider', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    const targets = [{ low: { model: 'reader' } }];
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({
      'read-delegates': { claude: { targets }, codex: { targets } },
    }));
    const run = async () => {
      f.lines.length = 0;
      const { doctorReport } = await import('../../../skills/dispatch/scripts/toolkit/doctor.ts');
      return doctorReport(f.session, skill, undefined, 'claude', { claude: true, codex: true }, { claude: false, codex: false });
    };
    const report = await run();
    assert.ok(!report.sandboxRemoved.includes('claude'), 'host leaves sandboxRemoved: ' + JSON.stringify(report.sandboxRemoved));
    assert.ok(report.sandboxRemoved.includes('codex'), 'non-host stays: ' + JSON.stringify(report.sandboxRemoved));
  } finally { f.cleanup(); }
});

test('doctor utility names the opencode subagent model value', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'test');
    fs.writeFileSync(path.join(skill, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skill)));
    const config = path.join(skill, 'config.jsonc');
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { opencode: { targets: [{ low: { model: 'reader' } }] }, codex: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': { opencode: { low: { model: 'prov/model', effort: 'my-eff' } } },
      'explore-subagents': { opencode: { model: 'prov/model', effort: 'my-eff' }, codex: { model: 'plain', effort: 'low' } },
    }));
    const run = async (args: string[] = []) => {
      f.lines.length = 0;
      assert.equal(await main(['doctor', 'run', '--session', f.session, '--host', 'opencode', ...args], { ...f.deps, skillRoot: skill }), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    const report = await run();
    assert.deepEqual(report.utility.opencode.models, ['prov/model']);
    assert.equal(report.utility.opencode.effort, 'my-eff');
    assert.deepEqual(report.utility.opencode.subagentModels, ['prov/model#my-eff']);
    assert.equal('subagentModels' in report.utility.codex, false);
    fs.writeFileSync(config, JSON.stringify({
      'read-delegates': { opencode: { targets: [{ low: { model: 'reader' } }] } },
      'write-subagents': { opencode: { low: { model: 'prov/plain' } } },
    }));
    const plain = await run();
    assert.deepEqual(plain.utility.opencode.subagentModels, ['prov/plain']);
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
    }));
    const omitted = await run();
    assert.equal(omitted.writeConcurrency, 1);

    fs.writeFileSync(config, '{"unknown":true}');
    const invalid = await run();
    assert.equal(invalid.writeConcurrency, 1);
  } finally { f.cleanup(); }
});
