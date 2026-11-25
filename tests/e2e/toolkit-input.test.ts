import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { currentHashes, foldLedger, latest } from '../../skills/dispatch/scripts/toolkit/ledger.ts';
import { fixture } from '../helpers/e2e.ts';
import { toolkitRepo } from './helpers/toolkit-repo.ts';

const CLI_ENTRY = path.resolve('skills/dispatch/scripts/toolkit/cli.ts');

function runCli(args: string[], options: { cwd: string; stdin?: string; env?: NodeJS.ProcessEnv; entry?: string }) {
  const res = spawnSync(process.execPath, [options.entry ?? CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.stdin,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(res.error, undefined, res.error?.message);
  const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `Expected 1 JSON stdout line, got:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const output = JSON.parse(lines[0]!) as {
    ok: boolean;
    summary: string;
    path: string | null;
    reason?: string;
    hint?: string;
  };
  const value = output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null;
  return { exit: res.status ?? -1, output, value, stderr: res.stderr };
}

function hasShell(cmd: string, args: string[]): boolean {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return !res.error && res.status === 0;
}

const HAS_POWERSHELL =
  process.platform === 'win32' &&
  hasShell('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
const HAS_SH = hasShell('sh', ['-c', 'true']);

describe('CLI payload matrix and shell quoting', () => {
  test('brief explorer, brief test-cleanup, brief verifier, and lint run accept file, stdin -, inline flags, and fail closed on conflicts', async () => {
    const r = await toolkitRepo();
    try {
      await r.approve();
      await r.level('low');
      const base = r.git(['rev-parse', 'HEAD']);

      // 1. brief explorer
      const expPayload = {
        objective: 'Map inputs',
        questions: ['How do inputs parse?'],
        outputPath: path.join(r.session, 'exp.context.md'),
      };
      const expFile = path.join(r.root, 'explorer.json');
      fs.writeFileSync(expFile, JSON.stringify(expPayload));
      for (const mode of ['file', 'stdin', 'inline'] as const) {
        const res =
          mode === 'file'
            ? runCli(['brief', 'explorer', expFile, '--session', r.session, '--host', 'codex'], { cwd: r.root })
            : mode === 'stdin'
              ? runCli(['brief', 'explorer', '-', '--session', r.session, '--host', 'codex'], {
                  cwd: r.root,
                  stdin: '\uFEFF' + JSON.stringify(expPayload),
                })
              : runCli(
                  [
                    'brief',
                    'explorer',
                    '--json',
                    JSON.stringify(expPayload),
                    '--session',
                    r.session,
                    '--host',
                    'codex',
                  ],
                  { cwd: r.root },
                );
        assert.equal(res.exit, 0, mode);
        assert.equal(res.output.ok, true, mode);
        assert.match(fs.readFileSync(res.value.briefPath, 'utf8'), /How do inputs parse\?/);
      }
      const expConflict = runCli(
        ['brief', 'explorer', expFile, '--json', JSON.stringify(expPayload), '--session', r.session, '--host', 'codex'],
        { cwd: r.root },
      );
      assert.equal(expConflict.exit, 1);
      assert.equal(expConflict.output.reason, 'invalid-input');

      // 2. brief test-cleanup (including --base + --integration-path)
      const tcPayload = { base, integrationPath: r.integration };
      const tcFile = path.join(r.root, 'test-cleanup.json');
      fs.writeFileSync(tcFile, JSON.stringify(tcPayload));
      for (const mode of ['file', 'stdin', 'inline', 'direct'] as const) {
        const res =
          mode === 'file'
            ? runCli(['brief', 'test-cleanup', tcFile, '--session', r.session, '--host', 'codex'], { cwd: r.root })
            : mode === 'stdin'
              ? runCli(['brief', 'test-cleanup', '-', '--session', r.session, '--host', 'codex'], {
                  cwd: r.root,
                  stdin: JSON.stringify(tcPayload),
                })
              : mode === 'inline'
                ? runCli(
                    [
                      'brief',
                      'test-cleanup',
                      '--json',
                      JSON.stringify(tcPayload),
                      '--session',
                      r.session,
                      '--host',
                      'codex',
                    ],
                    { cwd: r.root },
                  )
                : runCli(
                    [
                      'brief',
                      'test-cleanup',
                      '--base',
                      base,
                      '--integration-path',
                      r.integration,
                      '--session',
                      r.session,
                      '--host',
                      'codex',
                    ],
                    { cwd: r.root },
                  );
        assert.equal(res.exit, 0, mode);
        assert.equal(res.output.ok, true, mode);
        assert.ok(fs.readFileSync(res.value.briefPath, 'utf8').includes(base));
      }
      for (const badArgs of [
        ['brief', 'test-cleanup', '--base', base, '--session', r.session, '--host', 'codex'],
        ['brief', 'test-cleanup', '--integration-path', r.integration, '--session', r.session, '--host', 'codex'],
        [
          'brief',
          'test-cleanup',
          tcFile,
          '--base',
          base,
          '--integration-path',
          r.integration,
          '--session',
          r.session,
          '--host',
          'codex',
        ],
        [
          'brief',
          'test-cleanup',
          '--json',
          JSON.stringify(tcPayload),
          '--base',
          base,
          '--integration-path',
          r.integration,
          '--session',
          r.session,
          '--host',
          'codex',
        ],
      ]) {
        const bad = runCli(badArgs, { cwd: r.root });
        assert.equal(bad.exit, 1, badArgs.join(' '));
        assert.equal(bad.output.reason, 'invalid-input', badArgs.join(' '));
      }

      // 3. brief verifier
      const verPayload = {
        checkoutPath: r.integration,
        base,
        specPath: path.join(r.root, 'work.spec.md'),
        focus: 'Check CLI inputs',
      };
      const verFile = path.join(r.root, 'verifier.json');
      fs.writeFileSync(verFile, JSON.stringify(verPayload));
      for (const mode of ['file', 'stdin', 'inline'] as const) {
        const res =
          mode === 'file'
            ? runCli(['brief', 'verifier', verFile, '--session', r.session, '--host', 'codex'], { cwd: r.root })
            : mode === 'stdin'
              ? runCli(['brief', 'verifier', '-', '--session', r.session, '--host', 'codex'], {
                  cwd: r.root,
                  stdin: JSON.stringify(verPayload),
                })
              : runCli(
                  [
                    'brief',
                    'verifier',
                    '--json',
                    JSON.stringify(verPayload),
                    '--session',
                    r.session,
                    '--host',
                    'codex',
                  ],
                  { cwd: r.root },
                );
        assert.equal(res.exit, 0, mode);
        assert.equal(res.output.ok, true, mode);
        assert.match(fs.readFileSync(res.value.briefPath, 'utf8'), /Check CLI inputs/);
      }
      const verConflict = runCli(
        ['brief', 'verifier', verFile, '--json', JSON.stringify(verPayload), '--session', r.session, '--host', 'codex'],
        { cwd: r.root },
      );
      assert.equal(verConflict.exit, 1);
      assert.equal(verConflict.output.reason, 'invalid-input');

      // 4. lint run --edit / --json
      const planFile = path.join(r.root, 'work.plan.md');
      const initialPlanHash = currentHashes(r.root, latest(foldLedger(r.session), 'bind')).plan!;
      const editFile = path.join(r.root, 'edit.json');
      const edit1 = {
        class: 'non-intent',
        affects: ['T1'],
        rationale: 'Edit via file',
        diffRef: 'd1',
        before: initialPlanHash,
      };
      fs.writeFileSync(editFile, JSON.stringify(edit1));
      fs.writeFileSync(
        planFile,
        fs.readFileSync(planFile, 'utf8').replace('implements behavior.', 'implements behavior 1.'),
      );
      const lintFileRes = runCli(['lint', 'run', planFile, '--edit', editFile, '--session', r.session], {
        cwd: r.root,
      });
      assert.equal(lintFileRes.exit, 0);
      assert.equal(lintFileRes.value.edit.deduped, false);

      fs.writeFileSync(
        planFile,
        fs.readFileSync(planFile, 'utf8').replace('implements behavior 1.', 'implements behavior 2.'),
      );
      const edit2 = { class: 'non-intent', affects: ['T1'], rationale: 'Edit via stdin', diffRef: 'd2' };
      const lintStdinRes = runCli(['lint', 'run', planFile, '--edit', '-', '--session', r.session], {
        cwd: r.root,
        stdin: '\uFEFF' + JSON.stringify(edit2),
      });
      assert.equal(lintStdinRes.exit, 0);
      assert.equal(lintStdinRes.value.edit.deduped, false);

      fs.writeFileSync(
        planFile,
        fs.readFileSync(planFile, 'utf8').replace('implements behavior 2.', 'implements behavior 3.'),
      );
      const edit3 = { class: 'non-intent', affects: ['T1'], rationale: 'Edit via inline json', diffRef: 'd3' };
      const lintInlineRes = runCli(['lint', 'run', planFile, '--json', JSON.stringify(edit3), '--session', r.session], {
        cwd: r.root,
      });
      assert.equal(lintInlineRes.exit, 0);
      assert.equal(lintInlineRes.value.edit.deduped, false);

      const lintConflict = runCli(
        ['lint', 'run', planFile, '--edit', editFile, '--json', JSON.stringify(edit3), '--session', r.session],
        { cwd: r.root },
      );
      assert.equal(lintConflict.exit, 1);
      assert.equal(lintConflict.output.reason, 'invalid-input');
    } finally {
      r.cleanup();
    }
  });

  test('worktree commit (--review-fix, --test-cleanup) and worktree deliver accept file, stdin -, inline flags, and fail closed on conflicts', async () => {
    const planWithTest = [
      '# Work',
      '',
      '## Task Map',
      '| ID | Title | Outcome | Prerequisites | Criteria |',
      '| --- | --- | --- | --- | --- |',
      '| T1 | File | Works | none | SC1 |',
      '',
      '## Proposed Changes',
      '### T1 — File',
      '#### [MODIFY] src/file.ts',
      '- Purpose: implements behavior.',
      '',
      '## Success Criteria',
      '- [SC1] File works',
      '  - Changes: src/file.ts',
      '  - Tests: tests/step.test.ts',
      '  - Check: `node -e "process.exit(0)"`',
      '  - Evidence: check',
      '',
      '## Verification Plan',
      '### Automated Tests',
      '- `node -e "process.exit(0)"`',
      '',
    ].join('\n');
    const r = await toolkitRepo(planWithTest, { 'tests/step.test.ts': 'test();\n' });
    try {
      await r.approve();
      await r.level('low');
      assert.equal((await r.run(['check', 'run'])).exit, 0);
      assert.equal((await r.run(['worktree', 'create', 'T1'])).exit, 0);
      const wt = path.join(r.session, '.state/worktrees/T1-1');
      fs.writeFileSync(path.join(wt, 'src/file.ts'), 'updated\n');
      assert.equal((await r.run(['worktree', 'submit', 'T1'])).exit, 0);
      assert.equal((await r.run(['worktree', 'integrate', 'T1'])).exit, 0);
      const base = r.git(['rev-parse', 'HEAD'], r.integration);

      // 5. worktree commit --review-fix / --review-fix-json (file, -, inline, conflict)
      const rf1 = { review: 'code-integration', round: 1, generation: 1, findings: ['R1-F001'], from: base };
      const rfFile = path.join(r.root, 'rf.json');
      fs.writeFileSync(rfFile, JSON.stringify(rf1));
      fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'fix 1\n');
      const rfFileRes = runCli(
        ['worktree', 'commit', '--reason', 'fix 1', '--review-fix', rfFile, '--session', r.session],
        { cwd: r.root },
      );
      assert.equal(rfFileRes.exit, 0);

      fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'fix 2\n');
      const rfStdinRes = runCli(
        ['worktree', 'commit', '--reason', 'fix 2', '--review-fix', '-', '--session', r.session],
        { cwd: r.root, stdin: '\uFEFF' + JSON.stringify(rf1) },
      );
      assert.equal(rfStdinRes.exit, 0);

      fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'fix 3\n');
      const rfInlineRes = runCli(
        ['worktree', 'commit', '--reason', 'fix 3', '--review-fix-json', JSON.stringify(rf1), '--session', r.session],
        { cwd: r.root },
      );
      assert.equal(rfInlineRes.exit, 0);

      const rfConflict = runCli(
        [
          'worktree',
          'commit',
          '--reason',
          'fix 4',
          '--review-fix',
          rfFile,
          '--review-fix-json',
          JSON.stringify(rf1),
          '--session',
          r.session,
        ],
        { cwd: r.root },
      );
      assert.equal(rfConflict.exit, 1);
      assert.equal(rfConflict.output.reason, 'invalid-input');

      // Record fresh evidence on current integration tree before test-cleanup
      assert.equal((await r.run(['check', 'run'])).exit, 0);

      // 6. worktree commit --test-cleanup / --test-cleanup-json (file, -, inline, conflict)
      const tcData = { removed: ['SC1'], deleted: 1, merged: 0 };
      const tcFile = path.join(r.root, 'tc.json');
      fs.writeFileSync(tcFile, JSON.stringify(tcData));
      const tcConflict = runCli(
        [
          'worktree',
          'commit',
          '--reason',
          'cleanup',
          '--test-cleanup',
          tcFile,
          '--test-cleanup-json',
          JSON.stringify(tcData),
          '--session',
          r.session,
        ],
        { cwd: r.root },
      );
      assert.equal(tcConflict.exit, 1);
      assert.equal(tcConflict.output.reason, 'invalid-input');

      // Test stdin - and inline --test-cleanup-json across separate cleanup sessions or file/stdin/inline
      for (const mode of ['file', 'stdin', 'inline'] as const) {
        const sub = await r.second(`tc-${mode}`);
        await sub.approve();
        await sub.level('low');
        assert.equal((await sub.run(['check', 'run'])).exit, 0);
        fs.rmSync(path.join(sub.integration, 'tests/step.test.ts'));
        const args =
          mode === 'file'
            ? ['worktree', 'commit', '--reason', `cleanup ${mode}`, '--test-cleanup', tcFile, '--session', sub.session]
            : mode === 'stdin'
              ? ['worktree', 'commit', '--reason', `cleanup ${mode}`, '--test-cleanup', '-', '--session', sub.session]
              : [
                  'worktree',
                  'commit',
                  '--reason',
                  `cleanup ${mode}`,
                  '--test-cleanup-json',
                  JSON.stringify(tcData),
                  '--session',
                  sub.session,
                ];
        const res = runCli(args, { cwd: r.root, ...(mode === 'stdin' ? { stdin: JSON.stringify(tcData) } : {}) });
        assert.equal(res.exit, 0, mode);
        assert.deepEqual(res.value.removed, ['SC1'], mode);
      }

      // 7. worktree deliver --commit / --message (file, -, inline, conflict)
      const msgFile = path.join(r.root, 'commit-msg.txt');
      fs.writeFileSync(msgFile, 'feat: deliver via file\n');
      const deliverConflict = runCli(
        ['worktree', 'deliver', '--commit', msgFile, '--message', 'dup', '--session', r.session],
        { cwd: r.root },
      );
      assert.equal(deliverConflict.exit, 1);
      assert.equal(deliverConflict.output.reason, 'invalid-input');

      // Uncommitted deliver in main session, then commit via --message, and test file / stdin - concurrently in sub-repos
      assert.equal((await r.run(['worktree', 'deliver'])).exit, 0);
      const inlineDeliver = runCli(
        ['worktree', 'deliver', '--message', 'feat: deliver via inline message', '--session', r.session],
        { cwd: r.root },
      );
      assert.equal(inlineDeliver.exit, 0);
      assert.equal(r.git(['log', '-1', '--format=%B']).trim(), 'feat: deliver via inline message');

      await Promise.all(
        (['file', 'stdin'] as const).map(async (mode) => {
          const subRepo = await toolkitRepo();
          try {
            await subRepo.approve();
            await subRepo.level('low');
            assert.equal((await subRepo.run(['check', 'run'])).exit, 0);
            assert.equal((await subRepo.run(['worktree', 'create', 'T1'])).exit, 0);
            fs.writeFileSync(path.join(subRepo.session, '.state/worktrees/T1-1/src/file.ts'), `update ${mode}\n`);
            assert.equal((await subRepo.run(['worktree', 'submit', 'T1'])).exit, 0);
            assert.equal((await subRepo.run(['worktree', 'integrate', 'T1'])).exit, 0);
            assert.equal((await subRepo.run(['check', 'run'])).exit, 0);
            assert.equal((await subRepo.run(['worktree', 'deliver'])).exit, 0);
            const text = `feat: deliver via ${mode}\n`;
            const res =
              mode === 'file'
                ? runCli(['worktree', 'deliver', '--commit', msgFile, '--session', subRepo.session], {
                    cwd: subRepo.root,
                  })
                : runCli(['worktree', 'deliver', '--commit', '-', '--session', subRepo.session], {
                    cwd: subRepo.root,
                    stdin: '\uFEFF' + text,
                  });
            assert.equal(res.exit, 0, mode);
            assert.equal(
              subRepo.git(['log', '-1', '--format=%B']).trim(),
              mode === 'file' ? 'feat: deliver via file' : text.trim(),
            );
          } finally {
            subRepo.cleanup();
          }
        }),
      );
    } finally {
      r.cleanup();
    }
  });

  test('ask run accepts file, stdin -, inline --text, and rejects conflicts', async () => {
    const f = fixture({
      responses: [{ text: 'answer from file' }, { text: 'answer from stdin' }, { text: 'answer from inline' }],
    });
    try {
      const initRes = await f.launch(['session', 'init', '--objective', 'Ask payload matrix', '--host', 'codex']).done;
      assert.equal(initRes.exit, 0, initRes.stderr);
      const session = JSON.parse(initRes.stdout.trim()).path as string;
      const qFile = path.join(f.repo, 'question.md');
      fs.writeFileSync(qFile, 'Question via file');

      const binDir = path.dirname(path.join(f.dir, 'bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode'));
      const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}` };

      for (const [mode, args, stdin, expectedQ] of [
        [
          'file',
          ['ask', 'run', qFile, '--session', session, '--host', 'codex', '--level', 'low'],
          undefined,
          'Question via file',
        ],
        [
          'stdin',
          ['ask', 'run', '-', '--session', session, '--host', 'codex', '--level', 'low'],
          '\uFEFFQuestion via stdin',
          'Question via stdin',
        ],
        [
          'inline',
          ['ask', 'run', '--text', 'Question via inline', '--session', session, '--host', 'codex', '--level', 'low'],
          undefined,
          'Question via inline',
        ],
      ] as const) {
        const res = runCli([...args], { cwd: f.repo, env, entry: f.entry, ...(stdin ? { stdin } : {}) });
        assert.equal(res.exit, 0, mode);
        assert.equal(res.output.ok, true, mode);
        const digest = crypto.createHash('sha256').update(expectedQ).digest('hex').slice(0, 16);
        assert.equal(
          fs.existsSync(path.join(session, '.state', 'asks', digest, 'attempt-1', 'answers.json')),
          true,
          mode,
        );
      }

      const conflict = runCli(
        ['ask', 'run', qFile, '--text', 'dup', '--session', session, '--host', 'codex', '--level', 'low'],
        { cwd: f.repo, env, entry: f.entry },
      );
      assert.equal(conflict.exit, 1);
      assert.equal(conflict.output.reason, 'invalid-input');
    } finally {
      f.cleanup();
    }
  });

  test(
    'Windows PowerShell 5.1 non-ASCII UTF-8 stdin and inline quoting',
    { skip: !HAS_POWERSHELL ? 'powershell.exe unavailable' : false },
    async () => {
      const f = fixture({ responses: [{ text: 'ps answer' }] });
      const r = await toolkitRepo();
      try {
        // 1. PowerShell UTF-8 $OutputEncoding stdin byte-equality on worktree deliver --commit -
        await r.approve();
        await r.level('low');
        assert.equal((await r.run(['check', 'run'])).exit, 0);
        assert.equal((await r.run(['worktree', 'create', 'T1'])).exit, 0);
        fs.writeFileSync(path.join(r.session, '.state/worktrees/T1-1/src/file.ts'), 'ps utf8 change\n');
        assert.equal((await r.run(['worktree', 'submit', 'T1'])).exit, 0);
        assert.equal((await r.run(['worktree', 'integrate', 'T1'])).exit, 0);
        assert.equal((await r.run(['check', 'run'])).exit, 0);
        assert.equal((await r.run(['worktree', 'deliver'])).exit, 0);

        const utf8Msg = 'feat(ps): 日本語 café — αβγ';
        const msgB64 = Buffer.from(utf8Msg, 'utf8').toString('base64');
        const psScript = [
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
          '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
          `$msg = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${msgB64}'))`,
          `$msg | & '${process.execPath.replaceAll("'", "''")}' '${CLI_ENTRY.replaceAll("'", "''")}' worktree deliver --commit - --session '${r.session.replaceAll("'", "''")}'`,
        ].join('; ');
        const psDeliver = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
          cwd: r.root,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(psDeliver.status, 0, psDeliver.stderr || psDeliver.stdout);
        assert.equal(r.git(['log', '-1', '--format=%B']).trim(), utf8Msg);

        // 2. PowerShell inline quoting for --text (ask run) and --json (lint run) with spaces and quotes
        const initRes = await f.launch(['session', 'init', '--objective', 'PS inline quoting', '--host', 'codex']).done;
        assert.equal(initRes.exit, 0, initRes.stderr);
        const session = JSON.parse(initRes.stdout.trim()).path as string;
        const binDir = path.dirname(path.join(f.dir, 'bin', 'opencode.cmd'));
        const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}` };

        const inlineQuestion = 'Quote "check" & path/to/file?';
        const psAsk = `& '${process.execPath.replaceAll("'", "''")}' '${f.entry.replaceAll("'", "''")}' ask run --text 'Quote \\"check\\" & path/to/file?' --session '${session.replaceAll("'", "''")}' --host codex --level low`;
        // NOTE: PowerShell 5.1 passes backslashed double-quotes safely to native executables; assert exact sha256 oracle.
        const askOut = spawnSync('powershell.exe', ['-NoProfile', '-Command', psAsk], {
          cwd: f.repo,
          env,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(askOut.status, 0, askOut.stderr || askOut.stdout);
        const askDigest = crypto.createHash('sha256').update(inlineQuestion).digest('hex').slice(0, 16);
        assert.equal(fs.existsSync(path.join(session, '.state', 'asks', askDigest, 'attempt-1', 'answers.json')), true);

        const psPlanPath = path.join(r.root, 'work.plan.md');
        const beforeHash = currentHashes(r.root, latest(foldLedger(r.session), 'bind')).plan!;
        fs.writeFileSync(
          psPlanPath,
          fs.readFileSync(psPlanPath, 'utf8').replace('implements behavior.', 'implements ps inline.'),
        );
        const jsonObj = JSON.stringify({
          class: 'non-intent',
          affects: ['T1'],
          rationale: 'PowerShell "quoted" edit',
          diffRef: 'ps-diff',
          before: beforeHash,
        });
        const psEscapedJson = jsonObj.replace(/(\\*)"/g, '$1$1\\"');
        const psLint = `& '${process.execPath.replaceAll("'", "''")}' '${CLI_ENTRY.replaceAll("'", "''")}' lint run '${psPlanPath.replaceAll("'", "''")}' --% --json "${psEscapedJson}" --session "${r.session}"`;
        const lintOut = spawnSync('powershell.exe', ['-NoProfile', '-Command', psLint], {
          cwd: r.root,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(lintOut.status, 0, lintOut.stderr || lintOut.stdout);
        const lastEdit = foldLedger(r.session).records.findLast((row) => row.kind === 'edit');
        assert.equal(lastEdit?.data['rationale'], 'PowerShell "quoted" edit');
      } finally {
        f.cleanup();
        r.cleanup();
      }
    },
  );

  test('POSIX sh inline quoting', { skip: !HAS_SH ? 'sh unavailable' : false }, async () => {
    const r = await toolkitRepo();
    try {
      await r.approve();
      await r.level('low');
      assert.equal((await r.run(['check', 'run'])).exit, 0);
      assert.equal((await r.run(['worktree', 'create', 'T1'])).exit, 0);
      fs.writeFileSync(path.join(r.session, '.state/worktrees/T1-1/src/file.ts'), 'sh change\n');
      assert.equal((await r.run(['worktree', 'submit', 'T1'])).exit, 0);
      assert.equal((await r.run(['worktree', 'integrate', 'T1'])).exit, 0);
      assert.equal((await r.run(['check', 'run'])).exit, 0);
      assert.equal((await r.run(['worktree', 'deliver'])).exit, 0);

      const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const planPath = path.join(r.root, 'work.plan.md');
      const beforeHash = currentHashes(r.root, latest(foldLedger(r.session), 'bind')).plan!;
      fs.writeFileSync(
        planPath,
        fs.readFileSync(planPath, 'utf8').replace('implements behavior.', 'implements sh inline.'),
      );
      const editJson = JSON.stringify({
        class: 'non-intent',
        affects: ['T1'],
        rationale: "POSIX 'quoted' & spaced",
        diffRef: 'sh-diff',
        before: beforeHash,
      });
      const shLintCmd = `${shQuote(process.execPath)} ${shQuote(CLI_ENTRY)} lint run ${shQuote(planPath)} --json ${shQuote(editJson)} --session ${shQuote(r.session)}`;
      const shLint = spawnSync('sh', ['-c', shLintCmd], { cwd: r.root, encoding: 'utf8', windowsHide: true });
      assert.equal(shLint.status, 0, shLint.stderr || shLint.stdout);
      const lastEdit = foldLedger(r.session).records.findLast((row) => row.kind === 'edit');
      assert.equal(lastEdit?.data['rationale'], "POSIX 'quoted' & spaced");

      const msg = "feat(sh): POSIX 'quoted' message";
      const shDeliverCmd = `${shQuote(process.execPath)} ${shQuote(CLI_ENTRY)} worktree deliver --message ${shQuote(msg)} --session ${shQuote(r.session)}`;
      const shDeliver = spawnSync('sh', ['-c', shDeliverCmd], { cwd: r.root, encoding: 'utf8', windowsHide: true });
      assert.equal(shDeliver.status, 0, shDeliver.stderr || shDeliver.stdout);
      assert.equal(r.git(['log', '-1', '--format=%B']).trim(), msg);
    } finally {
      r.cleanup();
    }
  });
});
