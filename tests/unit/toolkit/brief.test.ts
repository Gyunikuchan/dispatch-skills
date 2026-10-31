import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { qualityCriteria } from '../../../skills/dispatch/scripts/toolkit/domain/prompt.ts';
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

const sharedFixture = sessionFixture({ memory: true });
const bindings = new Map<boolean, string>();
const cachedHashes = new Map<boolean, ReturnType<typeof currentHashes>>();
const tornPath = path.join(sharedFixture.session, 'ledger.torn-1.jsonl');
const designPath = path.join(sharedFixture.root, 'strategy.design.md');
const ledgerPath = path.join(sharedFixture.session, 'ledger.jsonl');
sharedFixture.artifact('mission.spec.md', '# Mission\n## Requirements\n### REQ-1 — Works\n');
let cachedQuality: string | null = null;
const getQuality = (root: string) => cachedQuality ??= fs.readFileSync(path.join(root, 'references/templates/quality-bar.md'), 'utf8');
let cachedWriterTemplate: string | null = null;
const getWriterTemplate = (root: string) => cachedWriterTemplate ??= fs.readFileSync(path.join(root, 'references/templates/writer-brief.md'), 'utf8');
after(() => sharedFixture.cleanup());

async function fixture(design = false, source = PLAN) {
  const f = {...sharedFixture, cleanup: () => {}};
  // Reset scenario state while retaining the same physical session and templates.
  if (fs.existsSync(tornPath)) fs.unlinkSync(tornPath);
  if (design) {
    if (!fs.existsSync(designPath)) f.artifact('strategy.design.md', '# Strategy\n');
  } else if (fs.existsSync(designPath)) {
    fs.unlinkSync(designPath);
  }
  delete f.deps.hook;
  f.lines.length = 0;
  const planPath = f.artifact('work.plan.md', source);
  const binding = bindings.get(design);
  let key = binding ? 2 : 0;
  let lastSeq = key;
  const add = async (kind: string, data: object, extra: object = {}) => {
    lastSeq++;
    const record = {
      seq: lastSeq,
      at: new Date(f.deps.clock()).toISOString(),
      kind,
      key: 'record-' + key++,
      by: 'orchestrator',
      data,
      ...extra,
    };
    fs.appendFileSync(ledgerPath, JSON.stringify(record) + '\n');
    return record;
  };
  if (binding) {
    fs.writeFileSync(ledgerPath, binding);
    key = 2;
  } else {
    if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
    await add('bind', {spec: 'mission.spec.md', plan: 'work.plan.md', ...(design ? {design: 'strategy.design.md'} : {})});
    await add('confirm', {spec: currentHashes(f.root, {spec: 'mission.spec.md'}).spec}, {by: 'user', quote: 'Approved'});
    bindings.set(design, fs.readFileSync(ledgerPath, 'utf8'));
  }
  let hashes = source === PLAN ? cachedHashes.get(design) : undefined;
  if (!hashes) {
    hashes = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    if (source === PLAN) cachedHashes.set(design, hashes);
  }
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
        const directory = path.join(f.session, 'canonical inputs');
        fs.mkdirSync(directory, {recursive: true});
        const bound: Record<string, string> = {};
        const originals: Record<string, string> = {};
        for (const [kind, name] of Object.entries({spec: 'mission.spec.md', plan: 'work.plan.md', ...(design ? {design: 'strategy.design.md'} : {})})) {
          originals[kind] = fs.readFileSync(path.join(f.root, name), 'utf8');
          fs.writeFileSync(path.join(directory, name), originals[kind]!);
          bound[kind] = path.relative(f.root, path.join(directory, name));
        }
        await f.add('bind', bound);
        await f.add('level', {level: 'low'});
        await f.launch();
        const worktree = path.join(f.session, '.state/worktrees/T1-1');
        fs.mkdirSync(worktree, {recursive: true});
        const result = await f.call();
        assert.equal(result.exit, 0);
        const brief = fs.readFileSync(result.value.path, 'utf8');
        const addresses = {
          spec: /Read the governing spec whole: `([^`]+)`/.exec(brief)?.[1],
          plan: /Governing plan: `([^`]+)`/.exec(brief)?.[1],
          ...(design ? {design: /Governing design: `([^`]+)`/.exec(brief)?.[1]} : {}),
        };
        for (const [kind, address] of Object.entries(addresses)) {
          assert.ok(address, kind + ' read address');
          assert.equal(fs.readFileSync(path.resolve(worktree, address), 'utf8'), originals[kind]);
          assert.ok(brief.includes(f.hashes[kind as keyof typeof f.hashes]!));
          assert.equal(fs.existsSync(path.resolve(worktree, bound[kind]!)), false);
        }
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
      const command = captureCommand(captureSection(brief));
      const payload = captureData(command);
      assert.match(payload.data.command, /node first-red/);
      assert.doesNotMatch(payload.data.command, /node poison-red/);
      const quotedPath = process.platform === 'win32' ? '"tests/with space.test.ts"' : "'tests/with space.test.ts'";
      assert.equal(payload.data.criterion, 'SC1');
      assert.equal(payload.data.logDir, path.join(f.session, '.state', 'briefs', 'T1-1.red'));
      assert.ok(payload.data.command.includes(quotedPath));
      assert.ok(!payload.data.command.includes('src/first.ts'), 'Changes paths do not become {files}');
      assert.match(command, /^node -e ".*" [A-Za-z0-9_-]+ [A-Za-z0-9_-]+$/);
      assert.doesNotMatch(command, /[$%]/);
      const quality = getQuality(f.deps.skillRoot);
      assert.equal(brief.split('## Quality\n\n' + qualityCriteria(quality, 'writer')).length - 1, 1);
      for (const name of ['shared', 'code']) {
        const body = quality.split('## ' + name + '\n')[1]!.split('\n## ')[0]!.trim();
        assert.ok(brief.includes(body));
      }
      for (const text of [path.resolve(f.session, '.state/worktrees/T1-1'), 'mission.spec.md', f.hashes.spec!, 'work.plan.md', f.hashes.plan!, 'Shared gated context 日本語.', '## Task Map', '### T1', 'Preserve the first invariant', 'First implementation detail', 'SC1', 'node first-check', 'node first-red', 'src/first.ts', 'node contract-check', '**intent**', '**correctness**', 'DONE', 'BLOCKED', 'NEEDS_CONTEXT']) assert.ok(brief.includes(text), text);
      assert.match(brief, /read.*whole/i);
      assert.match(brief, /failing tests/i);
      assert.match(brief, /Git write commands/);
      for (const forbidden of ['poison-red', '### T2', 'Private second detail', 'node second-check']) assert.ok(!brief.includes(forbidden), forbidden);
      assert.equal(result.value.bytes, Buffer.byteLength(brief));
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
      const template = getWriterTemplate(f.deps.skillRoot);
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

test('writer brief keeps task behaviour and criterion fields from collapsed plan sections', async () => {
  const behaviour = '- First returns the validated value after retrying once.';
  const source = PLAN.replace('### T1 — First', `### T1 — First\n${behaviour}`).replace('#### [NEW] src/first.ts', '<details>\n<summary>First files</summary>\n\n#### [NEW] src/first.ts').replace('### T2 — Second', '</details>\n\n### T2 — Second').replace('- [SC1] First works', '- [SC1] First works\n  <details>\n  <summary>Checks</summary>\n').replace('- [SC2]', '  </details>\n\n- [SC2]');
  const f = await fixture(false, source);
  try {
    await f.approve(); await f.launch();
    const rendered = await f.call();
    assert.equal(rendered.exit, 0, JSON.stringify(rendered.output));
    const markdown = fs.readFileSync(rendered.value.path, 'utf8');
    for (const text of ['#### [NEW] src/first.ts', '- Purpose: First implementation detail.', '  - Changes: src/first.ts', '  - Tests: src/first.ts', '  - Verify: `node first-check`', '  - RED: `node first-red`', '  - Evidence: red']) assert.ok(markdown.includes(text), text);
    assert.equal(markdown.split(behaviour).length - 1, 1);
  } finally { f.cleanup(); }
});

test('brief labels governed hashes and names lint for comparison', async () => {
  const f = await fixture(true);
  try {
    await f.approve(); await f.launch();
    const rendered = await f.call();
    assert.equal(rendered.exit, 0, JSON.stringify(rendered.output));
    const markdown = fs.readFileSync(rendered.value.path, 'utf8');
    assert.ok(markdown.includes(`mission.spec.md\` (governed hash ${f.hashes.spec})`));
    assert.ok(markdown.includes(`work.plan.md\` (governed hash ${f.hashes.plan})`));
    assert.ok(markdown.includes(`strategy.design.md\` (governed hash ${f.hashes.design})`));
    assert.match(markdown, /These are canonical governed hashes from the orchestrator; raw file SHA-256 values differ\. Do not run the dispatch toolkit\./i);
  } finally { f.cleanup(); }
});
