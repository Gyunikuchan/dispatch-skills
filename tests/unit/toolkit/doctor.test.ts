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
      assert.equal(await main(['doctor', 'run', '--session', f.session, ...args], { ...f.deps, skillRoot: skill }), 0);
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
      assert.equal(await main(['doctor', 'run', '--session', f.session, ...args], { ...f.deps, skillRoot: skill }), 0);
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
      assert.equal(await main(['doctor', 'run', '--session', f.session, ...args], { ...f.deps, skillRoot: skill }), 0);
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
