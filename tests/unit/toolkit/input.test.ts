import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { main, type HandlerContext } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { askRun } from '../../../skills/dispatch/scripts/toolkit/ask.ts';
import {
  renderExplorerBrief,
  renderTestCleanupBrief,
  renderVerifierBrief,
} from '../../../skills/dispatch/scripts/toolkit/brief.ts';
import { deliver } from '../../../skills/dispatch/scripts/toolkit/deliver.ts';
import { readJsonPayload, readTextPayload } from '../../../skills/dispatch/scripts/toolkit/input.ts';
import { commit } from '../../../skills/dispatch/scripts/toolkit/integrate.ts';
import { appendRecord, currentHashes, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { ToolError } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { checks as checkPlan, loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { sessionFixture } from './helpers/session.ts';

function makeContext(
  f: ReturnType<typeof sessionFixture>,
  args: string[],
  values: HandlerContext['values'] = {},
): HandlerContext {
  return {
    session: f.session,
    manifest: readManifest(f.session),
    args,
    values,
    deps: f.deps,
  };
}

function assertInvalidInput(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.exit, 1);
    assert.equal(error.reason, 'invalid-input');
    return true;
  });
}

async function assertInvalidInputAsync(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.exit, 1);
    assert.equal(error.reason, 'invalid-input');
    return true;
  });
}

describe('unified payload input reader and handlers', () => {
  test('readTextPayload reads file, stdin -, and inline flags with UTF-8 BOM stripping and fail-closed conflicts', () => {
    const f = sessionFixture({ memory: true });
    try {
      const file = f.artifact('question.txt', '\uFEFFWhy does 日本語 work?');
      assert.equal(
        readTextPayload(makeContext(f, [file]), { positional: 'question', inlineFlag: 'text', label: 'question' }),
        'Why does 日本語 work?',
      );

      f.deps.readStdin = () => '\uFEFFCommit via stdin 日本語\n';
      assert.equal(
        readTextPayload(makeContext(f, [], { commit: '-' }), {
          fileFlag: 'commit',
          inlineFlag: 'message',
          label: 'commit message',
        }),
        'Commit via stdin 日本語\n',
      );

      assert.equal(
        readTextPayload(makeContext(f, [], { text: 'Inline question' }), {
          positional: 'question',
          inlineFlag: 'text',
          label: 'question',
        }),
        'Inline question',
      );

      assertInvalidInput(() =>
        readTextPayload(makeContext(f, []), { positional: 'question', inlineFlag: 'text', label: 'question' }),
      );
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, [file], { text: 'dup' }), {
          positional: 'question',
          inlineFlag: 'text',
          label: 'question',
        }),
      );
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, ['a', 'b']), { positional: 'question', inlineFlag: 'text', label: 'question' }),
      );
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, [], { commit: file, message: 'dup' }), {
          fileFlag: 'commit',
          inlineFlag: 'message',
          label: 'commit message',
        }),
      );
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, [], { text: '   \n' }), {
          positional: 'question',
          inlineFlag: 'text',
          label: 'question',
        }),
      );

      const blankFile = f.artifact('blank.txt', '\uFEFF  \n');
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, [blankFile]), { positional: 'question', inlineFlag: 'text', label: 'question' }),
      );
      f.deps.readStdin = () => '\uFEFF  ';
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, ['-']), { positional: 'question', inlineFlag: 'text', label: 'question' }),
      );
      delete f.deps.readStdin;
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, ['-']), { positional: 'question', inlineFlag: 'text', label: 'question' }),
      );
      assertInvalidInput(() =>
        readTextPayload(makeContext(f, [path.join(f.root, 'missing.txt')]), {
          positional: 'question',
          inlineFlag: 'text',
          label: 'question',
        }),
      );
    } finally {
      f.cleanup();
    }
  });

  test('readJsonPayload supports file, stdin -, inline json, co-required direct flags, optionality, and conflicts', () => {
    const f = sessionFixture({ memory: true });
    try {
      const file = f.artifact('values.json', '\uFEFF{"base":"abc","integrationPath":"int"}');
      assert.deepEqual(
        readJsonPayload(makeContext(f, [file]), { positional: 'values', inlineFlag: 'json', label: 'values' }),
        { base: 'abc', integrationPath: 'int' },
      );

      f.deps.readStdin = () => '\uFEFF{"objective":"Map","questions":["- Q?"]}';
      assert.deepEqual(
        readJsonPayload(makeContext(f, ['-']), { positional: 'values', inlineFlag: 'json', label: 'values' }),
        { objective: 'Map', questions: ['- Q?'] },
      );

      assert.deepEqual(
        readJsonPayload(makeContext(f, [], { json: '{"k":1}' }), {
          positional: 'values',
          inlineFlag: 'json',
          label: 'values',
        }),
        { k: 1 },
      );

      const directSpec = {
        positional: 'values',
        inlineFlag: 'json',
        direct: [
          { flag: 'base', key: 'base' },
          { flag: 'integration-path', key: 'integrationPath' },
        ] as const,
        label: 'test-cleanup values',
      };
      assert.deepEqual(
        readJsonPayload(makeContext(f, [], { base: 'deadbeef', 'integration-path': '.state/int' }), directSpec),
        { base: 'deadbeef', integrationPath: '.state/int' },
      );

      assert.equal(
        readJsonPayload(makeContext(f, []), {
          fileFlag: 'review-fix',
          inlineFlag: 'review-fix-json',
          optional: true,
          label: 'review-fix',
        }),
        undefined,
      );

      // Conflicts and partial direct flags fail closed with invalid-input.
      assertInvalidInput(() => readJsonPayload(makeContext(f, [file], { json: '{}' }), directSpec));
      assertInvalidInput(() =>
        readJsonPayload(makeContext(f, [file], { base: 'a', 'integration-path': 'b' }), directSpec),
      );
      assertInvalidInput(() =>
        readJsonPayload(makeContext(f, [], { json: '{}', base: 'a', 'integration-path': 'b' }), directSpec),
      );
      assertInvalidInput(() => readJsonPayload(makeContext(f, [], { base: 'a' }), directSpec));
      assertInvalidInput(() => readJsonPayload(makeContext(f, [], { 'integration-path': 'b' }), directSpec));
      assertInvalidInput(() =>
        readJsonPayload(makeContext(f, [], { base: '  ', 'integration-path': 'b' }), directSpec),
      );
      assertInvalidInput(() =>
        readJsonPayload(makeContext(f, [], { base: true, 'integration-path': 'b' }), directSpec),
      );
      assertInvalidInput(() =>
        readJsonPayload(makeContext(f, [], { 'review-fix': file, 'review-fix-json': '{}' }), {
          fileFlag: 'review-fix',
          inlineFlag: 'review-fix-json',
          optional: true,
          label: 'review-fix',
        }),
      );
      assertInvalidInput(() => readJsonPayload(makeContext(f, [], { json: '{broken' }), directSpec));
    } finally {
      f.cleanup();
    }
  });

  test('askRun accepts stdin - with BOM and inline --text while rejecting conflicts and blanks', async () => {
    const f = sessionFixture({ memory: true });
    try {
      const skill = path.join(f.root, 'skill');
      fs.mkdirSync(skill);
      fs.writeFileSync(
        path.join(skill, 'config.jsonc'),
        JSON.stringify({
          'read-delegates': { codex: { targets: [{ medium: { model: 'answer' } }] } },
        }),
      );
      f.deps.skillRoot = skill;
      f.deps.orchestrator = { platform: 'opencode', model: null };
      f.script('codex', 'answer', 'Answer from delegate');

      f.deps.readStdin = () => '\uFEFFQuestion from stdin?';
      const stdinResult = await askRun(makeContext(f, ['-']));
      assert.equal(stdinResult.ok, true);
      assert.match(fs.readFileSync(f.launches[0]!.request.promptPath, 'utf8'), /Question from stdin\?/);

      const inlineResult = await askRun(makeContext(f, [], { text: 'Inline ask question?' }));
      assert.equal(inlineResult.ok, true);
      assert.match(fs.readFileSync(f.launches[1]!.request.promptPath, 'utf8'), /Inline ask question\?/);

      const qFile = f.artifact('q.md', 'File question?');
      await assertInvalidInputAsync(() => askRun(makeContext(f, [qFile], { text: 'Conflict' })));
      await assertInvalidInputAsync(() => askRun(makeContext(f, [], { text: '   ' })));
    } finally {
      f.cleanup();
    }
  });

  test('brief handlers accept stdin -, inline --json, and test-cleanup co-required direct flags', async () => {
    const f = sessionFixture({ memory: true });
    try {
      f.artifact('mission.spec.md', '# Mission\n');
      f.artifact('work.plan.md', '# Work\n');
      await appendRecord(
        f.session,
        {
          kind: 'bind',
          key: 'bind-brief',
          by: 'orchestrator',
          data: { spec: 'mission.spec.md', plan: 'work.plan.md' },
        },
        f.deps,
      );
      f.deps.orchestrator = { platform: 'codex', model: null };

      // explorer via stdin - (BOM) and --json
      f.deps.readStdin = () => '\uFEFF{"objective":"Explore","questions":["- How?"]}';
      const expStdin = await renderExplorerBrief(makeContext(f, ['-']));
      assert.equal(expStdin.ok, true);
      const expInline = await renderExplorerBrief(
        makeContext(f, [], { json: '{"objective":"Explore","questions":["- How?"]}' }),
      );
      assert.equal(expInline.ok, true);
      assert.equal(
        fs.readFileSync((expStdin.value as { briefPath: string }).briefPath, 'utf8'),
        fs.readFileSync((expInline.value as { briefPath: string }).briefPath, 'utf8'),
      );
      await assertInvalidInputAsync(() => renderExplorerBrief(makeContext(f, ['-'], { json: '{}' })));
      await assertInvalidInputAsync(() => renderExplorerBrief(makeContext(f, [], { json: '[]' })));
      await assertInvalidInputAsync(() =>
        renderExplorerBrief(makeContext(f, [], { json: '{"objective":"Explore","questions":"- How?","extra":"x"}' })),
      );

      // verifier via stdin - and --json
      f.deps.readStdin = () =>
        '\uFEFF{"checkoutPath":"chk","base":"abc","specPath":"mission.spec.md","focus":"Check SC1"}';
      const verStdin = await renderVerifierBrief(makeContext(f, ['-']));
      assert.equal(verStdin.ok, true);
      const verInline = await renderVerifierBrief(
        makeContext(f, [], {
          json: '{"checkoutPath":"chk","base":"abc","specPath":"mission.spec.md","focus":"Check SC1"}',
        }),
      );
      assert.equal(verInline.ok, true);
      assert.equal(
        fs.readFileSync((verStdin.value as { briefPath: string }).briefPath, 'utf8'),
        fs.readFileSync((verInline.value as { briefPath: string }).briefPath, 'utf8'),
      );

      // test-cleanup via --json, stdin -, and co-required --base + --integration-path
      const base = 'a'.repeat(40);
      const integrationPath = '.state/worktrees/integration';
      const cleanJson = await renderTestCleanupBrief(
        makeContext(f, [], { json: JSON.stringify({ base, integrationPath }) }),
      );
      const cleanDirect = await renderTestCleanupBrief(
        makeContext(f, [], { base, 'integration-path': integrationPath }),
      );
      assert.equal(cleanJson.ok, true);
      assert.equal(cleanDirect.ok, true);
      assert.equal(
        fs.readFileSync((cleanJson.value as { briefPath: string }).briefPath, 'utf8'),
        fs.readFileSync((cleanDirect.value as { briefPath: string }).briefPath, 'utf8'),
      );
      await assertInvalidInputAsync(() => renderTestCleanupBrief(makeContext(f, [], { base })));
      await assertInvalidInputAsync(() =>
        renderTestCleanupBrief(makeContext(f, [], { 'integration-path': integrationPath })),
      );
      await assertInvalidInputAsync(() =>
        renderTestCleanupBrief(makeContext(f, ['-'], { base, 'integration-path': integrationPath })),
      );
      await assertInvalidInputAsync(() =>
        renderTestCleanupBrief(makeContext(f, [], { json: '{}', base, 'integration-path': integrationPath })),
      );
    } finally {
      f.cleanup();
    }
  });

  test('integrate commit supports stdin - and inline json flags while rejecting conflicts before stdin read', async () => {
    const f = sessionFixture({ memory: true });
    try {
      const from = 'a'.repeat(40),
        to = 'b'.repeat(40),
        tree = 'c'.repeat(40);
      fs.mkdirSync(path.join(f.session, '.state/worktrees/integration'), { recursive: true });
      f.artifact('mission.spec.md', '# Mission\n');
      f.artifact(
        'work.plan.md',
        [
          '# Work',
          '## Task Map',
          '| ID | Title | Outcome | Prerequisites | Criteria |',
          '| --- | --- | --- | --- | --- |',
          '| T1 | Tests | Tests pass | none | SC1 |',
          '## Proposed Changes',
          '### T1 — Tests',
          '#### [MODIFY] tests/step.ts',
          '- Purpose: Tests behavior.',
          '## Success Criteria',
          '- [SC1] Tests pass',
          '  - Changes: tests/step.ts',
          '  - Tests: tests/step.ts',
          '  - Check: `node --version`',
          '  - Evidence: check',
          '## Verification Plan',
          '### Automated Tests',
          '- `node --version`',
        ].join('\n'),
      );
      await appendRecord(
        f.session,
        {
          kind: 'bind',
          key: 'bind-brief',
          by: 'orchestrator',
          data: { spec: 'mission.spec.md', plan: 'work.plan.md' },
        },
        f.deps,
      );
      await appendRecord(
        f.session,
        {
          kind: 'integrate',
          key: 'opened-1',
          by: 'tool',
          data: {
            phase: 'opened',
            path: '.state/worktrees/integration',
            branch: 'dispatch/test/integration',
            base: from,
            dest: { path: f.root, branch: 'main' },
          },
        },
        f.deps,
      );
      const check = checkPlan(loadPlan(f.session, readManifest(f.session))).find((row) => row.criterion === 'SC1')!;
      await appendRecord(
        f.session,
        {
          kind: 'evidence',
          key: 'ev-1',
          by: 'tool',
          data: {
            criterion: 'SC1',
            commandDigest: check.commandDigest,
            tree,
            before: tree,
            after: tree,
            clean: true,
            exit: 0,
            path: '.state/evidence/test.json',
          },
        },
        f.deps,
      );

      let head = from;
      f.deps.run = async (argv) => {
        const args = argv.slice(1);
        if (args[0] === 'rev-parse')
          return { exit: 0, stdout: args[1] === 'HEAD' ? head : args[1] === 'HEAD^' ? from : tree, stderr: '' };
        if (args[0] === 'diff') return { exit: 0, stdout: 'tests/step.ts\0', stderr: '' };
        if (args[0] === 'commit') {
          head = to;
          return { exit: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'ls-files' || args[0] === 'add' || args[0] === 'log')
          return { exit: 0, stdout: '', stderr: '' };
        throw new Error('Unexpected Git call: ' + JSON.stringify(argv));
      };

      const reviewFix = { review: 'code-integration', round: 1, generation: 1, findings: ['R1-F001'], from };
      const inlineFix = await commit(
        makeContext(f, [], { reason: 'apply review fix', 'review-fix-json': JSON.stringify(reviewFix) }),
      );
      assert.equal(inlineFix.ok, true);
      assert.equal(
        foldLedger(f.session).records.findLast((r) => r.data['phase'] === 'fix')?.data['reviewFix'].review,
        'code-integration',
      );

      f.deps.readStdin = () => '\uFEFF' + JSON.stringify({ removed: ['SC1'], deleted: 1, merged: 0 });
      const stdinCleanup = await commit(makeContext(f, [], { reason: 'cleanup', 'test-cleanup': '-' }));
      assert.equal(stdinCleanup.ok, true);
      assert.equal(
        foldLedger(f.session).records.findLast((r) => r.data['phase'] === 'test-cleanup')?.data['deleted'],
        1,
      );

      let stdinReads = 0;
      f.deps.readStdin = () => {
        stdinReads++;
        return '{}';
      };
      await assertInvalidInputAsync(() =>
        commit(
          makeContext(f, [], {
            reason: 'x',
            'review-fix': '-',
            'test-cleanup-json': '{"removed":["SC1"],"deleted":1,"merged":0}',
          }),
        ),
      );
      assert.equal(stdinReads, 0, 'cross-group conflict fails before reading stdin');
      await assertInvalidInputAsync(() =>
        commit(makeContext(f, [], { reason: 'x', 'review-fix': '-', 'review-fix-json': JSON.stringify(reviewFix) })),
      );
      await assertInvalidInputAsync(() =>
        commit(
          makeContext(f, [], {
            reason: 'x',
            'test-cleanup': '-',
            'test-cleanup-json': '{"removed":["SC1"],"deleted":1,"merged":0}',
          }),
        ),
      );

      // Preserves test-cleanup-empty refusal (exit 4) and invalid-record from validateReviewFix.
      await assert.rejects(
        () => commit(makeContext(f, [], { reason: 'x', 'test-cleanup-json': '{"removed":[],"deleted":0,"merged":0}' })),
        (error: unknown) => error instanceof ToolError && error.exit === 4 && error.reason === 'test-cleanup-empty',
      );
      await assert.rejects(
        () => commit(makeContext(f, [], { reason: 'x', 'review-fix-json': '{"review":"code-integration"}' })),
        (error: unknown) => error instanceof ToolError && error.exit === 1 && error.reason === 'invalid-record',
      );
    } finally {
      f.cleanup();
    }
  });

  test('deliver routes --message-only to commitDelivered, accepts --commit - with BOM, and rejects conflicts or blanks', async () => {
    const f = sessionFixture({ memory: true });
    try {
      const from = 'a'.repeat(40),
        source = 'b'.repeat(40),
        committed = 'c'.repeat(40);
      await appendRecord(
        f.session,
        {
          kind: 'integrate',
          key: 'delivered-1',
          by: 'tool',
          data: { phase: 'delivered', mode: 'uncommitted', dest: { path: f.root, branch: 'main' }, from, source },
        },
        f.deps,
      );

      let head = from;
      let base = from;
      const recordedMessages: string[] = [];
      f.deps.run = async (argv, options) => {
        const args = argv.slice(1);
        if (args[0] === 'symbolic-ref') return { exit: 0, stdout: 'main\n', stderr: '' };
        if (args[0] === 'rev-parse') return { exit: 0, stdout: args[1] === 'HEAD' ? head : 'tree', stderr: '' };
        if (args[0] === 'diff') return { exit: 0, stdout: '', stderr: '' };
        if (args[0] === 'ls-files' || args[0] === 'read-tree' || args[0] === 'update-index' || args[0] === 'merge-base')
          return { exit: 0, stdout: '', stderr: '' };
        if (args[0] === 'rev-list') return { exit: 0, stdout: `${head} ${base}\n`, stderr: '' };
        if (args[0] === 'write-tree') return { exit: 0, stdout: 'idxtree\n', stderr: '' };
        if (args[0] === 'commit') {
          recordedMessages.push(options.stdin ?? '');
          base = head;
          head = committed;
          return { exit: 0, stdout: '', stderr: '' };
        }
        throw new Error('Unexpected Git call: ' + JSON.stringify(argv));
      };

      const msgResult = await deliver(makeContext(f, [], { message: 'feat: deliver via inline message' }));
      assert.equal(msgResult.ok, true);
      assert.equal((msgResult.value as { committed: boolean; commit: string }).committed, true);
      assert.equal(recordedMessages[0], 'feat: deliver via inline message');

      // Reset to a fresh delivered record to test --commit - with BOM stripping.
      await appendRecord(
        f.session,
        {
          kind: 'integrate',
          key: 'delivered-2',
          by: 'tool',
          data: {
            phase: 'delivered',
            mode: 'uncommitted',
            dest: { path: f.root, branch: 'main' },
            from: committed,
            source: 'd'.repeat(40),
          },
        },
        f.deps,
      );
      f.deps.readStdin = () => '\uFEFFfeat: deliver via stdin';
      const stdinResult = await deliver(makeContext(f, [], { commit: '-' }));
      assert.equal(stdinResult.ok, true);
      assert.equal(recordedMessages[1], 'feat: deliver via stdin');

      await assertInvalidInputAsync(() => deliver(makeContext(f, [], { commit: '-', message: 'conflict' })));
      await assertInvalidInputAsync(() => deliver(makeContext(f, [], { message: '   \n' })));
      f.deps.readStdin = () => '\uFEFF  ';
      await assertInvalidInputAsync(() => deliver(makeContext(f, [], { commit: '-' })));
      // Neither --commit nor --message stays on uncommitted delivery path (no-integration without opened record).
      await assert.rejects(
        () => deliver(makeContext(f, [])),
        (error: unknown) => error instanceof ToolError && error.exit === 4 && error.reason === 'no-integration',
      );
    } finally {
      f.cleanup();
    }
  });

  test('cli action-scoping rejects payload flags on unrelated actions', async () => {
    const f = sessionFixture({ memory: true });
    try {
      for (const scopedArgs of [
        ['status', 'show', '--json', '{}', '--session', f.session],
        ['status', 'show', '--text', 'hi', '--session', f.session],
        ['status', 'show', '--message', 'hi', '--session', f.session],
        ['status', 'show', '--base', 'a'.repeat(40), '--session', f.session],
        ['status', 'show', '--integration-path', '.state/worktrees/integration', '--session', f.session],
        ['status', 'show', '--review-fix-json', '{}', '--session', f.session],
        ['status', 'show', '--test-cleanup-json', '{}', '--session', f.session],
      ]) {
        f.lines.length = 0;
        assert.equal(await main(scopedArgs, f.deps), 1, scopedArgs.join(' '));
        assert.equal(f.output().reason, 'invalid-input', scopedArgs.join(' '));
      }
    } finally {
      f.cleanup();
    }
  });
});
