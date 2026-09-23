import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  buildDoctorReport,
  formatDoctorReport,
  providerProbes,
} from '../../../skills/dispatch/scripts/dispatch.mjs';

const CONFIG = {
  'read-delegates': {
    claude: { model: 'claude-opus-5', effort: 'low', high: { model: 'claude-fable-5.1' } },
    agy: { model: 'gemini-3.7-flash', effort: 'medium', high: { model: 'gemini-3.8-flash' } },
    opencode: [{ model: 'opencode-go/glm-5.3-flash', effort: 'max' }],
  },
  'write-subagents': {
    claude: { model: 'claude-sonnet-5', effort: 'medium', high: { model: 'claude-opus-5', effort: 'low' } },
    copilot: { model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'], effort: 'max' },
  },
  phases: {
    'plan-review': { rounds: { low: 0, medium: 2, high: 3 }, targets: { low: 0, medium: 1, high: 2 }, consensus: { low: false, medium: true } },
    'design-review': { rounds: { medium: 2 }, targets: { medium: 1 }, consensus: { medium: true } },
    'code-review': { rounds: { low: 1, medium: 3 }, targets: { low: 1, high: 'all' }, consensus: { low: false, medium: true } },
  },
};

const ASK_ONLY = { 'read-delegates': { claude: { model: 'claude-opus-5', effort: 'medium' }, agy: { model: 'gemini-3.8-flash', effort: 'medium' } } };

function mockProbes(live = {}) {
  for (const [name, provider] of [
    ['isClaudeAvailable', 'claude'],
    ['isAgyAvailable', 'agy'],
    ['isCopilotAvailable', 'copilot'],
    ['isOpencodeAvailable', 'opencode'],
  ]) {
    mock.method(providerProbes, name, async () => live[provider] ?? true);
  }
}

afterEach(() => mock.restoreAll());

const platforms = (list) => list.map((t) => t.platform);

describe('dispatch doctor (v0.4 behaviour carried over)', () => {
  it('reports effective candidates, sandbox support, and corrective commands', async () => {
    mockProbes({ agy: false });
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc');
    assert.equal(report.configPath, '/tmp/config.jsonc');
    assert.deepEqual(platforms(report.targets), ['claude', 'agy', 'opencode']);
    const byPlatform = Object.fromEntries(report.health.map((h) => [h.platform, h]));
    assert.equal(byPlatform.claude.sandboxSupported, true);
    assert.match(byPlatform.agy.correctiveCommand, /agy/);
  });

  it('respects orchestrator candidate demotion', async () => {
    mockProbes();
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc', { orchestrator: 'claude' });
    assert.deepEqual(platforms(report.targets), ['agy', 'opencode', 'claude']);
  });
});

describe('dispatch doctor --level high (R1)', () => {
  it('reports level, source, level-resolved candidates, all three review phases, and the orchestrator write subagent', async () => {
    mockProbes();
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc', {
      level: 'high',
      levelSource: 'explicit',
      orchestrator: 'claude',
    });

    assert.equal(report.level, 'high');
    assert.equal(report.levelSource, 'explicit');
    assert.deepEqual(
      report.targets.map((t) => `${t.platform}:${t.model}`),
      ['agy:gemini-3.8-flash', 'opencode:opencode-go/glm-5.3-flash', 'claude:claude-fable-5.1'],
    );

    const phase = (name) => report.phases[name];
    assert.deepEqual(Object.keys(report.phases), ['plan-review', 'design-review', 'code-review']);
    assert.deepEqual(
      [platforms(phase('plan-review').targets), platforms(phase('plan-review').reserves), phase('plan-review').rounds, phase('plan-review').consensus],
      [['agy', 'opencode'], ['claude'], 3, true],
    );
    assert.deepEqual(
      [platforms(phase('design-review').targets), platforms(phase('design-review').reserves), phase('design-review').rounds, phase('design-review').consensus],
      [['agy'], ['opencode', 'claude'], 2, true],
    );
    assert.deepEqual(
      [platforms(phase('code-review').targets), platforms(phase('code-review').reserves), phase('code-review').rounds, phase('code-review').consensus],
      [['agy', 'opencode', 'claude'], [], 3, true],
    );

    // --orchestrator narrows write-subagents to that entry.
    assert.deepEqual(Object.keys(report.writeSubagents), ['claude']);
    assert.equal(report.writeSubagents.claude.model, 'claude-opus-5');
    assert.equal(report.writeSubagents.claude.effort, 'low');

    const text = formatDoctorReport(report);
    assert.equal(typeof text, 'string');
    assert.match(text, /^Effective config: \/tmp\/config\.jsonc$/m);
    assert.match(text, /level=high/);
    assert.match(text, /source=explicit/);
    assert.match(text, /agy\[0\] model=gemini-3\.8-flash/);
    for (const [name, rounds] of [['plan-review', 3], ['design-review', 2], ['code-review', 3]]) {
      const line = text.split('\n').find((l) => l.trim().startsWith(`${name}:`));
      assert.ok(line, `${name} line present`);
      assert.match(line, new RegExp(`rounds=${rounds}`));
      assert.match(line, /consensus=true/);
      assert.match(line, /targets=/);
      assert.match(line, /reserves=/);
    }
    assert.match(text, /claude: model=claude-opus-5 effort=low/);
    assert.doesNotMatch(text, /copilot: model=/);
  });

  it('shows every write-subagent entry when no orchestrator is given', async () => {
    mockProbes();
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc', { level: 'high', levelSource: 'explicit' });
    assert.deepEqual(Object.keys(report.writeSubagents), ['claude', 'copilot']);
    assert.deepEqual(report.writeSubagents.copilot.model, ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna']);
    const text = formatDoctorReport(report);
    assert.match(text, /claude: model=claude-opus-5/);
    assert.match(text, /copilot: model=gpt-5\.6-luna/);
  });

  it('defaults to level medium with source default', async () => {
    mockProbes();
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc');
    assert.equal(report.level, 'medium');
    assert.equal(report.levelSource, 'default');
    assert.equal(report.phases['plan-review'].rounds, 2);
    assert.match(formatDoctorReport(report), /level=medium/);
    assert.match(formatDoctorReport(report), /source=default/);
  });

  it('feeds probe results into phase resolution as liveness', async () => {
    mockProbes({ agy: false });
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc', { level: 'high', orchestrator: 'claude' });
    assert.deepEqual(platforms(report.phases['plan-review'].targets), ['opencode', 'claude']);
  });

  it('renders an ask-only config: phases off and write-subagents not configured', async () => {
    mockProbes();
    const report = await buildDoctorReport(ASK_ONLY, '/tmp/ask.jsonc', { level: 'high', levelSource: 'explicit', orchestrator: 'claude' });
    for (const name of ['plan-review', 'design-review', 'code-review']) {
      assert.equal(report.phases[name].configured, false, name);
      assert.equal(report.phases[name].rounds, 0, name);
      assert.deepEqual(report.phases[name].targets, [], name);
    }
    assert.deepEqual(report.writeSubagents, { claude: { configured: false } });
    const text = formatDoctorReport(report);
    for (const name of ['plan-review', 'design-review', 'code-review']) {
      assert.match(text, new RegExp(`${name}: off \\(not configured\\)`));
    }
    assert.match(text, /claude: not configured/);
  });

  it('renders an ask-only config without an orchestrator as write-subagents not configured', async () => {
    mockProbes();
    const report = await buildDoctorReport(ASK_ONLY, '/tmp/ask.jsonc', { level: 'low' });
    assert.deepEqual(report.writeSubagents, {});
    assert.match(formatDoctorReport(report), /write-subagents: not configured/i);
  });
});
