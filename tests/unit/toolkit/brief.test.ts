import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { sessionFixture } from './helpers/session.ts';

const PLAN = `# Scoped work
Shared gated context 日本語.
## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | First | First works | none | SC1 |
| T2 | Second | Second works | T1 | SC2 |
## Proposed Changes
### T1 — First
- Constraints: Preserve the first invariant.
#### [NEW] src/first.ts
- Purpose: First implementation detail.
### T2 — Second
#### [NEW] src/second.ts
- Purpose: Private second detail.
## Success Criteria
- [SC1] First works
  - Changes: src/first.ts
  - Tests: src/first.ts
  - Verify: \`node first-check\`
  - RED: \`node first-red\`
  - Evidence: red
- [SC2] Second works
  - Changes: src/second.ts
  - Verify: \`node second-check\`
  - Evidence: verify
## Verification Plan
### Automated Tests
- \`node first-check\`
- \`node second-check\`
- \`node contract-check\`
`;

const CAPTURE_PLAN = PLAN
  .replace(
    '#### [NEW] src/first.ts\n- Purpose: First implementation detail.',
    '#### [NEW] src/first.ts\n- Purpose: First implementation detail.\n#### [NEW] `tests/with space.test.ts`\n- Purpose: Exercise command capture.',
  )
  .replace(
    '  - Changes: src/first.ts\n  - Tests: src/first.ts\n  - Verify: `node first-check`\n  - RED: `node first-red`\n',
    '  - Changes: src/first.ts, `tests/with space.test.ts`\n  - Tests: `tests/with space.test.ts`\n  - Verify: `node first-check`\n  - RED: `node first-red {files}`\n',
  );

const sharedFixture = sessionFixture();
const bindings = new Map<boolean, string>();
after(() => sharedFixture.cleanup());

async function fixture(design = false, source = PLAN) {
  const f = {...sharedFixture, cleanup: () => {}};
  // Reset scenario state while retaining the same physical session and templates.
  fs.rmSync(path.join(f.session, 'ledger.jsonl'), {force: true});
  fs.rmSync(path.join(f.session, 'ledger.torn-1.jsonl'), {force: true});
  fs.rmSync(path.join(f.root, 'strategy.design.md'), {force: true});
  delete f.deps.hook;
  f.lines.length = 0;
  f.artifact('mission.spec.md', '# Mission\n## Requirements\n### REQ-1 — Works\n');
  const planPath = f.artifact('work.plan.md', source);
  if (design) f.artifact('strategy.design.md', '# Strategy\n');
  let key = 0;
  const add = (kind: string, data: object, extra: object = {}) => appendRecord(f.session, {kind, key: 'record-' + key++, by: 'orchestrator', data, ...extra}, f.deps);
  const ledgerPath = path.join(f.session, 'ledger.jsonl');
  const binding = bindings.get(design);
  if (binding) {
    fs.writeFileSync(ledgerPath, binding);
    key = 1;
  } else {
    await add('bind', {spec: 'mission.spec.md', plan: 'work.plan.md', ...(design ? {design: 'strategy.design.md'} : {})});
    bindings.set(design, fs.readFileSync(ledgerPath, 'utf8'));
  }
  const hashes = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
  const approve = () => add('approval', hashes, {by: 'user', quote: 'Approved'});
  const launch = (task = 'T1') => add('writer', {phase: 'launched', task, path: `.state/worktrees/${task}-1`, base: {commit: 'a'.repeat(40), taskSection: 'sha256:' + 'b'.repeat(64), seq: 1}});
  let processes = 0;
  f.deps.run = async () => { processes++; throw new Error('Brief must not run Git'); };
  const call = async (level?: string, task = 'T1') => {
    f.lines.length = 0;
    const exit = await main(['brief', 'render', task, '--session', f.session, ...(level ? ['--level', level] : [])], f.deps);
    assert.equal(processes, 0);
    const output = f.output();
    return {exit, output, value: output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null};
  };
  return {...f, planPath, hashes, add, approve, launch, call};
}

function captureSection(brief: string): string {
  const marker = '## RED capture commands\n';
  const start = brief.indexOf(marker);
  assert.notEqual(start, -1, 'brief includes the RED capture section');
  return brief.slice(start + marker.length).split(/\n## /, 1)[0]!.trim();
}

function captureCommand(section: string): string {
  const match = /`(node -e [^`]+)`/.exec(section);
  assert.ok(match, 'applicable RED criterion has a runnable node -e command');
  return match[1]!;
}

function captureData(command: string): { bootstrap: string; data: { command: string; cwd: string; logDir: string; criterion: string } } {
  const match = /([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)$/.exec(command);
  assert.ok(match, 'outer command ends with two base64url arguments');
  return {
    bootstrap: Buffer.from(match[1]!, 'base64url').toString('utf8'),
    data: JSON.parse(Buffer.from(match[2]!, 'base64url').toString('utf8')) as { command: string; cwd: string; logDir: string; criterion: string },
  };
}

describe('writer brief', () => {
  test('approval chain and open launch govern rendering without Git', async () => {
    const f = await fixture();
    try {
      const missing = await f.call('low');
      assert.equal(missing.exit, 4);
      assert.equal(missing.output.reason, 'missing-approval');
      await f.add('level', {level: 'xhigh'}, {by: 'user', quote: 'Use xhigh'});
      const level = await f.call('low');
      assert.equal(level.exit, 4);
      assert.equal(level.output.reason, 'missing-approval');
      await f.approve();
      await f.add('level', {level: 'medium'});
      const unknown = await f.call(undefined, 'UNKNOWN');
      assert.equal(unknown.exit, 1);
      assert.equal(unknown.output.reason, 'invalid-input');
      const unopened = await f.call();
      assert.equal(unopened.exit, 4);
      assert.equal(unopened.output.reason, 'no-open-launch');
      await f.launch();
      fs.appendFileSync(f.planPath, '\nChanged intent.\n');
      const refused = await f.call();
      assert.equal(refused.exit, 4);
      assert.equal(refused.output.reason, 'unrecorded-change');
      fs.writeFileSync(f.planPath, PLAN);
      assert.equal((await f.call()).exit, 0);
      await f.add('level', {level: 'xhigh'}, {by: 'user', quote: 'Use xhigh'});
      assert.equal((await f.call()).exit, 0);
    } finally { f.cleanup(); }
  });

  test('low level needs no approval and design is included only when bound', async () => {
    for (const design of [false, true]) {
      const f = await fixture(design);
      try {
        await f.add('level', {level: 'low'});
        await f.launch();
        const result = await f.call();
        assert.equal(result.exit, 0);
        const brief = fs.readFileSync(result.value.path, 'utf8');
        if (design) {
          assert.ok(brief.includes('strategy.design.md'));
          assert.ok(brief.includes(f.hashes.design!));
        } else assert.doesNotMatch(brief, /Governing design:|strategy\.design\.md/);
      } finally { f.cleanup(); }
    }
  });

  test('records a stale lock break once before rendering without caller ledger writes or Git', async () => {
    const f = await fixture();
    try {
      await f.approve(); await f.launch();
      const before = foldLedger(f.session);
      const lock = path.join(f.session, '.state', 'lock');
      const stale = JSON.stringify({pid: 99, host: f.deps.host, at: 'old', tool: 'interrupted'});
      const ledger = path.join(f.session, 'ledger.jsonl');
      fs.appendFileSync(ledger, '{torn');
      for (let attempt = 0; attempt < 2; attempt++) {
        fs.writeFileSync(lock, stale);
        assert.equal((await f.call()).exit, 0);
        assert.equal(fs.existsSync(lock), false);
        const after = foldLedger(f.session);
        assert.equal(after.torn, null);
        assert.equal(after.records.length, before.records.length + 1);
        assert.deepEqual(after.records.slice(0, before.records.length), before.records);
        const note = after.records.at(-1)!;
        assert.equal(note.seq, before.lastSeq + 1);
        assert.equal(note.key, 'stale-lock:' + f.deps.host + ':99:old');
        assert.equal(note.kind, 'note'); assert.equal(note.by, 'tool');
        assert.equal(note.data['text'], 'Broke stale lock from pid 99 on ' + f.deps.host);
      }
      assert.equal(fs.readFileSync(path.join(f.session, 'ledger.torn-1.jsonl'), 'utf8'), '{torn');
    } finally { f.cleanup(); }
  });

  test('gated snapshot supplies scoped context criteria quality and short report', async () => {
    const f = await fixture(false, CAPTURE_PLAN);
    try {
      await f.approve(); await f.launch();
      f.deps.hook = point => {
        assert.equal(point, 'brief:after-gate');
        fs.writeFileSync(f.planPath, CAPTURE_PLAN.replace('node first-red {files}', 'node poison-red {files}'));
      };
      const result = await f.call();
      assert.equal(result.exit, 0);
      assert.equal(result.value.path, path.join(f.session, '.state', 'briefs', 'T1-1.md'));
      assert.ok(result.output.summary.includes(result.value.path));
      const brief = fs.readFileSync(result.value.path, 'utf8');
      const payload = captureData(captureCommand(captureSection(brief)));
      assert.match(payload.data.command, /node first-red/);
      assert.doesNotMatch(payload.data.command, /node poison-red/);
      const quality = fs.readFileSync(path.join(f.deps.skillRoot, 'references/templates/quality-bar.md'), 'utf8');
      for (const name of ['shared', 'code']) {
        const body = quality.split('## ' + name + '\n')[1]!.split('\n## ')[0]!.trim();
        assert.ok(brief.includes(name === 'shared' ? body.replace('the outcome envelope and verification protocol', 'verification requirements') : body));
      }
      for (const text of [path.resolve(f.session, '.state/worktrees/T1-1'), 'mission.spec.md', f.hashes.spec!, 'work.plan.md', f.hashes.plan!, 'Shared gated context 日本語.', '## Task Map', '### T1', 'Preserve the first invariant', 'First implementation detail', 'SC1', 'node first-check', 'node first-red', 'src/first.ts', 'node contract-check', '**intent**', '**correctness**', 'DONE', 'BLOCKED', 'NEEDS_CONTEXT']) assert.ok(brief.includes(text), text);
      assert.match(brief, /read.*whole/i);
      assert.match(brief, /failing tests/i);
      assert.match(brief, /Git write commands/);
      for (const forbidden of ['poison-red', '### T2', 'Private second detail', 'node second-check', 'envelope', 'RED-MATRIX', 'briefHash', 'receipt']) assert.ok(!brief.includes(forbidden), forbidden);
      assert.equal(result.value.bytes, Buffer.byteLength(brief));
    } finally { f.cleanup(); }
  });

  test('capture command expands only declared test paths and quotes for the child shell', async () => {
    const f = await fixture(false, CAPTURE_PLAN);
    try {
      await f.approve(); await f.launch();
      const result = await f.call();
      assert.equal(result.exit, 0);
      const brief = fs.readFileSync(result.value.path, 'utf8');
      const command = captureCommand(captureSection(brief));
      const payload = captureData(command);
      const quotedPath = process.platform === 'win32' ? '"tests/with space.test.ts"' : "'tests/with space.test.ts'";
      assert.equal(payload.data.criterion, 'SC1');
      assert.equal(payload.data.logDir, path.join(f.session, '.state', 'briefs', 'T1-1.red'));
      assert.ok(payload.data.command.includes(quotedPath));
      assert.ok(!payload.data.command.includes('src/first.ts'), 'Changes paths do not become {files}');
      assert.match(command, /^node -e ".*" [A-Za-z0-9_-]+ [A-Za-z0-9_-]+$/);
      assert.doesNotMatch(command, /[$%]/);
    } finally { f.cleanup(); }
  });

  test('capture slot is empty for verify-only and excepted criteria', async () => {
    const cases: { task: string; source: string }[] = [
      {task: 'T2', source: PLAN},
      {task: 'T1', source: CAPTURE_PLAN.replace('  - Evidence: red\n', '  - Evidence: red\n  - RED exception: already-satisfied\n')},
    ];
    for (const item of cases) {
      const f = await fixture(false, item.source);
      try {
        await f.approve(); await f.launch(item.task);
        const result = await f.call(undefined, item.task);
        assert.equal(result.exit, 0);
        const brief = fs.readFileSync(result.value.path, 'utf8');
        assert.equal(captureSection(brief), '');
      } finally { f.cleanup(); }
    }
  });

  test('empty test paths produce an inline diagnostic and no capture command', async () => {
    const source = CAPTURE_PLAN.replace('  - Tests: `tests/with space.test.ts`\n', '');
    const f = await fixture(false, source);
    try {
      await f.approve(); await f.launch();
      const result = await f.call();
      assert.equal(result.exit, 0);
      const section = captureSection(fs.readFileSync(result.value.path, 'utf8'));
      assert.match(section, /T1/);
      assert.match(section, /SC1/);
      assert.match(section, /no test paths/i);
      assert.doesNotMatch(section, /node -e/);
    } finally { f.cleanup(); }
  });

  test('unsafe test paths produce an inline diagnostic and no capture command', async () => {
    const unsafePath = 'tests/bad;touch marker.test.ts';
    const source = CAPTURE_PLAN.replaceAll('tests/with space.test.ts', unsafePath);
    const f = await fixture(false, source);
    try {
      await f.approve(); await f.launch();
      const result = await f.call();
      assert.equal(result.exit, 0);
      const section = captureSection(fs.readFileSync(result.value.path, 'utf8'));
      assert.match(section, /T1/);
      assert.match(section, /SC1/);
      assert.ok(section.includes(unsafePath));
      assert.doesNotMatch(section, /node -e/);
    } finally { f.cleanup(); }
  });

  test('writer instructions save the report in the path redGaps consumes', async () => {
    const f = await fixture(false, CAPTURE_PLAN);
    try {
      await f.approve(); await f.launch();
      const result = await f.call();
      assert.equal(result.exit, 0);
      const brief = fs.readFileSync(result.value.path, 'utf8');
      const template = fs.readFileSync(path.join(f.deps.skillRoot, 'references', 'templates', 'writer-brief.md'), 'utf8');
      const reportPath = path.join(f.session, '.state', 'briefs', 'T1-1.report.md');
      const logDir = path.join(f.session, '.state', 'briefs', 'T1-1.red');
      assert.ok(template.includes('{{redCapture}}'));
      assert.ok(template.includes('{{reportPath}}'));
      assert.ok(template.includes('{{redLogDir}}'));
      assert.ok(brief.includes(reportPath));
      assert.ok(brief.includes(logDir));
      assert.ok(template.includes('## Observed RED failures'));
      assert.match(template, /plain-text lines directly below the heading/i);
      assert.match(template, /Do not add # or ## headings inside that section/i);
      assert.match(template, /outside.*{{reportPath}}.*{{redLogDir}}/is);
    } finally { f.cleanup(); }
  });
});
