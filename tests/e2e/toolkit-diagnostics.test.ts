import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { toolkitRepo } from './helpers/toolkit-repo.ts';
import { ORCHESTRATOR_MARKERS } from '../../skills/dispatch/scripts/lib/platform.ts';

test('diagnostics stay observational across CLI recovery and report completion', async () => {
  const enabled = true;
  const f = await toolkitRepo();
  try {
    await f.level('low');
      const skill = path.join(f.session, 'private-skill');
      fs.cpSync(f.deps.skillRoot, skill, { recursive: true });
      const configPath = path.join(skill, 'config.local.jsonc');
      fs.writeFileSync(configPath, JSON.stringify({ diagnostics: enabled,
        'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native' } }] } },
        'write-subagents': { codex: { low: { model: 'native', effort: 'low' } } },
        phases: { ask: { targets: { low: 1 }, rounds: { low: 1 } } },
      }));
      const env = { ...process.env };
      for (const marker of Object.values(ORCHESTRATOR_MARKERS)) for (const key of [...marker.platform, ...marker.model]) delete env[key];
      for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[key];
      env['CODEX_CLI'] = '1';
      const entry = path.join(skill, 'scripts/dispatch.ts');
      const run = (args: string[], expected = 0) => {
        const child = f.spawned(args, entry, env);
        assert.equal(child.status, expected, child.stderr + child.stdout);
        const lines = child.stdout.trim().split(/\r?\n/);
        assert.equal(lines.length, 1);
        const output = JSON.parse(lines[0]!);
        assert.ok(Buffer.byteLength(output.summary) <= 1024);
        return { output, value: output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null };
      };
      assert.equal(run(['doctor', 'run']).value.config.path, configPath);
      const question = path.join(f.session, 'question.md');
      fs.writeFileSync(question, 'Explain the fixture behavior');
      const pending = run(['ask', 'run', question], 4);
      assert.equal(pending.output.reason, 'native-pending');
      assert.equal(pending.value.native.length, 1);
      const reply = pending.value.native[0].replyPath;
      fs.writeFileSync(reply, 'Retained native answer');
      const captures = path.join(f.session, '.state/diagnostics');
      if (enabled) {
        assert.ok(fs.readdirSync(captures).length > 0);
        // An interrupted optional collection must survive process readback as partial evidence.
        fs.writeFileSync(path.join(captures, 'interrupted.json'), JSON.stringify({ phases: [], invocations: [], reviews: [], capture: { state: 'opened', start: 1 } }));
      } else assert.equal(fs.existsSync(captures), false);
      const answered = run(['ask', 'run', question]);
      assert.deepEqual(answered.value.answers.map((answer: {text: string}) => answer.text), ['Retained native answer']);
      assert.equal(fs.readFileSync(reply, 'utf8'), 'Retained native answer');
      fs.writeFileSync(path.join(f.session, '.state/retro.json'), '[]');
      const rendered = run(['report', 'render']);
      assert.ok(fs.existsSync(path.resolve(f.session, rendered.value.path)));
      assert.equal('diagnostics' in rendered.value, enabled);
      if (enabled) {
        const report = fs.readFileSync(path.resolve(f.session, rendered.value.diagnostics), 'utf8');
        assert.match(report, /incomplete 1/i);
        assert.match(report, /completed/i);
        assert.doesNotMatch(report, /Explain the fixture behavior|Retained native answer/);
      }
      const writer = run(['worktree', 'create', 'T1']);
      fs.writeFileSync(path.resolve(f.session, writer.value.path, 'src/file.ts'), 'delivered\n');
      run(['worktree', 'submit', 'T1']); run(['worktree', 'integrate', 'T1']);
      run(['verify', 'run']); run(['worktree', 'deliver']);
      const complete = run(['report', 'complete']);
      assert.ok(fs.existsSync(path.resolve(f.session, complete.value.path)));
      assert.equal('diagnostics' in complete.value, enabled);
      assert.equal(fs.readFileSync(path.join(f.root, 'src/file.ts'), 'utf8'), 'delivered\n');
      run(['worktree', 'cleanup']);
  } finally { f.cleanup(); }
});
