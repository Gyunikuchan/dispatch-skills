import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture, CLEAN, until } from '../helpers/e2e.ts';
import { hashes } from '../../scripts/generate-hashes.ts';
import { specHash } from '../helpers/spec-fixture.ts';
import { publishQuotaFailure, readQuotaState } from '../../skills/dispatch/scripts/lib/quota-store.ts';
import { H } from '../../skills/dispatch/scripts/policy/quota.ts';

function artifact(kind: 'plan' | 'design'): string {
  const lead = `# Bounded value\n\n> **TL;DR:** Preserve the value.\n> **Parent:** \`governing.spec.md\` · ${specHash()}\n> **Decide:** none\n> **Risk:** low — one value\n`;
  return kind === 'plan' ? lead + `> **Scope:** src/a.ts

## Key Decisions & Context
- Preserve the value.
## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Preserve value | Value remains valid. | none | SC1 |
## Proposed Changes
### T1 — Preserve value
#### [MODIFY] src/a.ts
- Preserve the value.
## Success Criteria
- [SC1] Value remains valid
  - Satisfies: REQ-1
  - Changes: src/a.ts
  - Verify: \`node -e "process.exit(0)"\`
  - Evidence: verify
  - Test rationale: Check the fixture delivery.
## Verification Plan
### Automated Tests
- None: Criterion Verify covers delivery.
` : lead + `> **Increments:** 1
## Approach
- I01 delivers REQ-1.
## Alternatives & Decisions
- AD-1: Preserve the value.
## Risks, Security & Operations
- Preserve caller state.
## Architecture & Boundaries
- One value.
## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | Preserve value | none | src/a.ts |
## Increment Details
### I01
- Outcome: Value remains valid.
- Scope: src/a.ts
- Non-scope: Other files.
- Observable behavior: Value remains valid.
- Affected contracts: Value.
- Validation: node --test
- Rollback boundary: Restore value.
- Parallel safety: One owner.
## Final Integration
- Verify value.
`;
}

test('quota routing survives cross-run continuation', async (t) => {
  for (const diagnostics of [false, true]) await t.test(`successive review runs bypass quota with diagnostics ${diagnostics}`, async () => {
    const f = fixture({ responses: ['usage limit exceeded', CLEAN] });
    try {
      const wrapper = path.join(f.dir, 'quota-provider.mjs');
      const stub = pathToFileURL(path.resolve('tests/helpers/stub-provider.ts')).href;
      fs.writeFileSync(wrapper, `import { stub, recordedLaunches } from ${JSON.stringify(stub)}; const file=process.argv[2]; await stub(file,process.argv.slice(3)); if(process.argv[3]!=='debug' && recordedLaunches(file).length===1) process.exitCode=1;`);
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      const shim = process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${wrapper}" "${f.scenarioPath}" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(wrapper)} ${quote(f.scenarioPath)} "$@"\n`;
      fs.writeFileSync(path.join(f.dir, 'bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode'), shim, { mode: 0o700 });
      fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, diagnostics, 'read-delegates': { opencode: { sandbox: false, targets: [{ low: { model: ['exhausted', 'available'] } }] } } }));
      hashes(f.overlay);
      const session = await f.initialize();
      fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 2;\n');
      const settle = async (frame: Awaited<ReturnType<typeof f.begin>>) => frame.await === 'retro' ? f.reply(f.absoluteRun(frame.run), { type: 'RETRO', observations: [] }) : frame;
      const first = await settle(await f.begin('review', session, '', ['--kind', 'code']));
      assert.equal(first.await, 'done', JSON.stringify(first));
      assert.equal(f.launches().length, 2);
      const current = String(first.data['handoff'] ?? session);
      const second = await settle(await f.begin('review', current, '', ['--kind', 'code']));
      assert.equal(second.await, 'done', JSON.stringify(second));
      assert.equal(f.launches().length, 3);
      const journal = fs.readFileSync(path.join(f.absoluteRun(second.run), 'events.jsonl'), 'utf8');
      assert.equal(journal.includes('skipped-quota'), true);
      assert.equal((journal.match(/"type":"WAVE_DONE"/g) ?? []).length, 1);
      await f.cli(['session', 'quota-reprobe', '--session-dir', String(second.data['handoff'] ?? current), '--provider', 'opencode', '--mode', 'cli', '--model', 'exhausted']);
      const third = await settle(await f.begin('review', String(second.data['handoff'] ?? current), '', ['--kind', 'code']));
      assert.equal(third.await, 'done', JSON.stringify(third));
      assert.equal(f.launches().length, 4);
    } finally { f.cleanup(); }
  });
  for (const flow of ['ask', 'plan', 'design', 'implement'] as const) await t.test(`${flow} parent preserves a suppressed reviewer and required slot`, async () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, 'read-delegates': { opencode: { sandbox: false, targets: [{ low: { model: ['exhausted', 'available'] } }] } } }));
      hashes(f.overlay);
      const session = await f.initialize();
      const key = { provider: 'opencode', model: 'exhausted', mode: 'cli' };
      const options = { sessionDir: session, repositoryRoot: f.repo, bucketWidth: H };
      const now = Date.now(), state = readQuotaState(options, [key], now);
      assert.equal(state.warnings.length, 0);
      assert.equal(publishQuotaFailure(options, key, state.generations[0]!.generation, now).published, true);
      const target = path.join(f.repo, flow === 'design' ? 'value.design.md' : 'value.plan.md');
      if (flow !== 'ask') fs.writeFileSync(target, artifact(flow === 'design' ? 'design' : 'plan'));
      let frame = await f.begin(flow, session, flow === 'ask' ? 'Explain the value' : target, flow === 'ask' ? [] : ['--spec', path.join(f.repo, 'governing.spec.md')]);
      if (frame.await === 'author') {
        const authored = path.resolve(f.repo, String(frame.data['path']));
        fs.writeFileSync(authored, artifact(flow === 'design' ? 'design' : 'plan'));
        frame = await f.reply(f.absoluteRun(frame.run), { type: 'AUTHORED', path: authored });
      }
      assert.equal(frame.error, undefined, JSON.stringify(frame));
      assert.equal(f.launches().length, 1, JSON.stringify(frame));
      const journal = fs.readFileSync(path.join(f.absoluteRun(frame.run), 'events.jsonl'), 'utf8');
      assert.equal(journal.includes('skipped-quota'), true);
      const waves = journal.trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.type === 'WAVE_DONE');
      assert.equal(waves.length, 1);
      assert.equal(waves[0].data.slots.length, 1);
      assert.equal(waves[0].data.slots[0].model, 'available');
    } finally { f.cleanup(); }
  });
  await t.test('interrupted host continuation rejects moved sessions and retains owned input without quota sidecars', async () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, phases: { ...f.config.phases, 'code-review': { rounds: { low: 2 }, targets: { low: 2 } } }, 'read-delegates': { opencode: { sandbox: false, targets: [{ low: { model: ['exhausted', 'available'] } }] }, codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native-stub', effort: 'low' } }] } } }));
      hashes(f.overlay);
      const session = await f.initialize(), key = { provider: 'opencode', model: 'exhausted', mode: 'cli' };
      const options = { sessionDir: session, repositoryRoot: f.repo, bucketWidth: H };
      const now = Date.now(), generation = readQuotaState(options, [key], now).generations[0]!.generation;
      publishQuotaFailure(options, key, generation, now);
      fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 2;\n');
      const frame = await f.begin('review', session, '', ['--kind', 'code']);
      assert.equal(frame.await, 'native', JSON.stringify(frame));
      const run = f.absoluteRun(frame.run), inputPath = path.join(run, 'review.wave.1', 'input.json');
      const input = fs.readFileSync(inputPath, 'utf8');
      assert.equal(JSON.parse(input).quota.decisions.find((row: { key: { model: string } }) => row.key.model === 'exhausted').skipped, true);
      await until(() => fs.existsSync(path.join(run, 'review.wave.1', 'done.json')));
      fs.rmSync(path.join(session, '.state', 'quota'), { recursive: true });
      const moved = path.join(f.dir, path.basename(session)); fs.renameSync(session, moved);
      const rejected = await f.launch(['session', 'reactivate', '--session-dir', moved]).done;
      assert.equal(rejected.exit, 1);
      assert.match(rejected.stderr, /outside the workspace session root/);
      fs.renameSync(moved, session);
      const active = await f.cli(['session', 'reactivate', '--session-dir', session]);
      assert.equal(active.sessionDir, session);
      assert.equal(fs.readFileSync(inputPath, 'utf8'), input);
      const receipt = structuredClone(frame.events!.find((event) => event.type === 'NATIVE_RESULTS')!);
      if (receipt.type !== 'NATIVE_RESULTS') assert.fail('native receipt missing');
      for (const slot of receipt.slots) fs.writeFileSync(String(slot['outputPath']), JSON.stringify(CLEAN));
      const completed = await f.reply(run, receipt);
      assert.equal(completed.await, 'done', JSON.stringify(completed));
      assert.equal(f.launches().length, 1);
      const journal = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
      assert.equal((journal.match(/"type":"WAVE_DONE"/g) ?? []).length, 1);
      assert.equal(journal.includes('skipped-quota'), true);
      const replay = await f.cli(['send', '--run', run]);
      assert.equal(replay.await, 'done');
      assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), journal);
      assert.equal(f.launches().length, 1);
    } finally { f.cleanup(); }
  });
});
