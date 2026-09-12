import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, after } from 'node:test';

import {
  parseCommonArgs,
  formatSafetyPrompt,
  extractCleanResponse,
  isPathInside,
  normalizePath,
  getAllowedBoundaryRoots,
  createSessionLogger,
  emitInitBanner,
  emitCompletionBanner,
  buildAttachmentBlock,
  findSensitiveMatch,
  isBatchLauncher,
  readAttachment,
  preparePromptForArgv,
  createBriefFile,
  classifyFailure,
  isEmptyResult,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_BUFFER_MB,
  PROJECT_ROOT,
  getArgvByteLimit,
  spawnCli,
  spawnCliSync,
  terminateProcessTree,
  SENSITIVE_FILE_PATTERNS,
  SENSITIVE_FILE_BASENAME_PATTERNS,
  SAFE_ENV_WHITELIST,
  SENSITIVE_ENV_KEY_PATTERN,
  getSanitizedEnv,
  getGitStatus,
  checkGitIntegrity,
  describeGitStatusDiff,
  dedupeTargetsByBinary,
  verifySkillIntegrity,
  generateSkillHashes,
  buildFormattedPrompt,
  scanVersionDirs,
  isExecutableFile,
  findFirstExistingFile,
  findBinary,
  existsAny,
  stripJsonComments,
  parseJsonc,
  isMainModule,
  readStdin,
  resolveRunnerExitCode,
} from '../../../skills/dispatch/scripts/common.mjs';

// ---------------------------------------------------------------------------
// SECTION: Argument Parsing & Defaults
// ---------------------------------------------------------------------------

describe('common: argument parsing', () => {
  it('parses basic flags and positional prompt', () => {
    const argv = ['node', 'dispatch.mjs', 'Review', 'simulation', 'invariants'];
    const opts = parseCommonArgs(argv);

    assert.equal(opts.prompt, 'Review simulation invariants');
    assert.equal(opts.verbose, false);
    assert.equal(opts.timeout, DEFAULT_TIMEOUT_SECONDS);
    assert.equal(opts.maxBufferMb, DEFAULT_MAX_BUFFER_MB);
    assert.deepEqual(opts.files, []);
    assert.equal(opts.json, false);
    assert.equal(opts.orchestrator, null);
    assert.equal(opts.provider, null);
  });

  it('parses explicit flags including orchestrator and provider', () => {
    const argv = [
      'node', 'dispatch.mjs',
      '-p', 'Analyze models',
      '-f', 'CONTEXT.md',
      '--artifact', 'docs/adr.md',
      '--orchestrator', 'claude',
      '--provider', 'agy',
      '-v',
      '--json',
    ];
    const opts = parseCommonArgs(argv);

    assert.equal(opts.prompt, 'Analyze models');
    assert.deepEqual(opts.files, ['CONTEXT.md', 'docs/adr.md']);
    assert.equal(opts.orchestrator, 'claude');
    assert.equal(opts.provider, 'agy');
    assert.equal(opts.verbose, true);
    assert.equal(opts.json, true);
  });

  it('accepts backward-compat flags silently', () => {
    const opts = parseCommonArgs(['node', 'dispatch.mjs', '--allow-write', '-i', '-w', 'prompt']);
    assert.equal(opts.prompt, 'prompt');
    assert.equal(opts.verbose, false);
  });

  it('parses equals-separated flags', () => {
    const opts = parseCommonArgs([
      'node', 'dispatch.mjs',
      '--file=CONTEXT.md',
      '--artifact=README.md',
      '--provider=copilot',
      '--orchestrator=claude',
      '--model=claude-opus-5',
      '--effort=high',
      '--timeout=300',
      '--max-buffer=20',
      'prompt text',
    ]);
    assert.deepEqual(opts.files, ['CONTEXT.md', 'README.md']);
    assert.equal(opts.provider, 'copilot');
    assert.equal(opts.orchestrator, 'claude');
    assert.equal(opts.model, 'claude-opus-5');
    assert.equal(opts.effort, 'high');
    assert.equal(opts.timeout, 300);
    assert.equal(opts.maxBufferMb, 20);
    assert.equal(opts.prompt, 'prompt text');
  });

  it('parses allow-same-agent and json flags', () => {
    const opts = parseCommonArgs(['node', 'd.mjs', '--allow-same-agent', '--json', 'prompt']);
    assert.equal(opts.allowSameAgent, true);
    assert.equal(opts.json, true);
  });

  it('parses help flag', () => {
    const opts = parseCommonArgs(['node', 'd.mjs', '--help']);
    assert.equal(opts.help, true);
  });

  it('parseCommonArgs rejects an unknown flag', () => {
    assert.throws(() => parseCommonArgs(['node', 'd.mjs', '--bogus', 'prompt']), /Unknown flag: --bogus/);
    // An undeclared `--name=value` form of a runner flag is still unknown to a caller that didn't declare it.
    assert.throws(() => parseCommonArgs(['node', 'd.mjs', '--claude-mode=cli', 'p']), /Unknown flag: --claude-mode=cli/);
  });

  it('rejects a value flag followed by another flag', () => {
    assert.throws(() => parseCommonArgs(['node', 'd.mjs', '-m', '--json', 'p']), /-m requires a value/);
    assert.throws(() => parseCommonArgs(['node', 'd.mjs', 'p', '--provider']), /--provider requires a value/);
    assert.throws(
      () => parseCommonArgs(['node', 'd.mjs', '--agy-mode', '--json'], { valueFlags: ['--agy-mode'] }),
      /--agy-mode requires a value/,
    );
  });

  it('accepts declared runner flags', () => {
    const opts = parseCommonArgs(
      ['node', 'claude-run.mjs', '--claude-mode', 'cli', '--test-modes', '--mode=vscode', 'the', 'prompt'],
      { valueFlags: ['--claude-mode', '--mode'], booleanFlags: ['--test-modes'] },
    );
    // The declared value is consumed, so it no longer leaks into the positional prompt.
    assert.equal(opts.prompt, 'the prompt');
  });

  it('treats everything after -- as positional prompt text', () => {
    const opts = parseCommonArgs(['node', 'd.mjs', '--', '-leading', 'dash']);
    assert.equal(opts.prompt, '-leading dash');
  });
});

// ---------------------------------------------------------------------------
// SECTION: --prompt-file
// ---------------------------------------------------------------------------

describe('common: --prompt-file', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-prompt-file-'));
  after(() => {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  });

  it('reads the file content into options.prompt', () => {
    const file = path.join(scratchDir, 'brief.md');
    fs.writeFileSync(file, 'Filled review prompt body', 'utf8');

    const opts = parseCommonArgs(['node', 'dispatch.mjs', '--prompt-file', file]);
    assert.equal(opts.prompt, 'Filled review prompt body');
    assert.equal(opts.promptFile, file);
  });

  it('accepts the equals-separated form', () => {
    const file = path.join(scratchDir, 'brief-eq.md');
    fs.writeFileSync(file, 'Equals form content', 'utf8');

    const opts = parseCommonArgs(['node', 'dispatch.mjs', `--prompt-file=${file}`]);
    assert.equal(opts.prompt, 'Equals form content');
  });

  it('throws when the file is missing', () => {
    const missing = path.join(scratchDir, 'does-not-exist.md');
    assert.throws(
      () => parseCommonArgs(['node', 'dispatch.mjs', '--prompt-file', missing]),
      /--prompt-file/,
    );
  });

  it('throws when combined with -p', () => {
    const file = path.join(scratchDir, 'brief-conflict.md');
    fs.writeFileSync(file, 'content', 'utf8');
    assert.throws(
      () => parseCommonArgs(['node', 'dispatch.mjs', '-p', 'inline prompt', '--prompt-file', file]),
      /--prompt-file/,
    );
  });

  it('throws when combined with a positional prompt', () => {
    const file = path.join(scratchDir, 'brief-conflict2.md');
    fs.writeFileSync(file, 'content', 'utf8');
    assert.throws(
      () => parseCommonArgs(['node', 'dispatch.mjs', '--prompt-file', file, 'positional', 'prompt']),
      /--prompt-file/,
    );
  });
});

// ---------------------------------------------------------------------------
// SECTION: Prompt Formatting & Response Extraction
// ---------------------------------------------------------------------------

describe('common: prompt formatting & response extraction', () => {
  it('formats safety prompt in read-only mode', () => {
    const raw = 'Delete all temp files';
    const readOnly = formatSafetyPrompt(raw, {});
    assert.ok(readOnly.includes('[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]'));
    assert.ok(readOnly.includes('You are running in strict READ-ONLY analysis mode.'));
    assert.ok(readOnly.includes(raw));
  });

  it('includes workspace and attached files in safety prompt when provided', () => {
    const formatted = formatSafetyPrompt('Check the code', {
      workspaceRoot: '/my/repo',
      attachedFiles: ['CONTEXT.md'],
    });
    assert.ok(formatted.includes('[PRIMARY WORKSPACE]: /my/repo'));
    assert.ok(formatted.includes('[ATTACHED FILES]: CONTEXT.md'));
  });

  it('buildFormattedPrompt formats prompt with safety constraints and optional attachments', () => {
    const promptOnly = buildFormattedPrompt('Perform analysis');
    assert.ok(promptOnly.includes('[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]'));
    assert.ok(promptOnly.includes('Perform analysis'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-attach-'));
    try {
      const attachPath = path.join(tmpDir, 'context.md');
      fs.writeFileSync(attachPath, 'Sample attached content');
      const withFiles = buildFormattedPrompt('Perform analysis', [attachPath]);
      assert.ok(withFiles.includes('[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]'));
      assert.ok(withFiles.includes('[ATTACHED FILES]:'));
      assert.ok(withFiles.includes('Sample attached content'));
      assert.ok(withFiles.includes('Perform analysis'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts clean assistant response suppressing tool traces', () => {
    const noisyOutput = [
      '[dispatch] Provider: Antigravity 2.0 (agy)',
      '→ Skill reading codebase',
      '→ Read src/domain/models.ts',
      '$ git status',
      '✱ Analyzing patterns',
      '## Final Analysis',
      'Here is the extracted summary of the domain models.',
    ].join('\n');

    const extracted = extractCleanResponse(noisyOutput);
    assert.ok(extracted.includes('## Final Analysis'));
    assert.ok(extracted.includes('Here is the extracted summary of the domain models.'));
    assert.ok(!extracted.includes('→ Skill reading codebase'));
    assert.ok(!extracted.includes('→ Read src/domain/models.ts'));
  });

  it('returns empty string for non-string or empty extractCleanResponse input', () => {
    assert.equal(extractCleanResponse(''), '');
    assert.equal(extractCleanResponse(null), '');
    assert.equal(extractCleanResponse(undefined), '');
  });

  it('keeps body content when a "$ " example appears mid-answer', () => {
    const output = [
      '## Summary',
      'Tests were run with:',
      '$ npm test',
      'and all passed.',
    ].join('\n');
    assert.equal(extractCleanResponse(output), output);
  });

  it('trace, blank, plain answer paragraph with later "$ " example keeps the whole paragraph', () => {
    const output = [
      '→ Read src/a.mjs',
      '',
      'The loop is correct.',
      '$ node --test',
      'Confirms it.',
    ].join('\n');
    assert.equal(
      extractCleanResponse(output),
      ['The loop is correct.', '$ node --test', 'Confirms it.'].join('\n'),
    );
  });

  it('classifyFailure detects "No models loaded"', () => {
    assert.equal(classifyFailure('Error: No models loaded. Please load a model in LM Studio.'), 'model-not-loaded');
    assert.equal(classifyFailure('model is not loaded'), 'model-not-loaded');
    assert.equal(classifyFailure('ENOENT: no such file or directory'), 'not-found');
  });
});

// ---------------------------------------------------------------------------
// SECTION: Path & Boundary Utilities
// ---------------------------------------------------------------------------

describe('common: path & boundary utilities', () => {
  it('checks path containment correctly across platforms', () => {
    const root = path.resolve('/test/project');
    const inside = path.resolve('/test/project/src/index.ts');
    const outside = path.resolve('/test/other/file.ts');

    assert.equal(isPathInside(inside, root), true);
    assert.equal(isPathInside(outside, root), false);
    assert.equal(isPathInside(root, root), true);
  });

  it('normalizes path comparison across platforms', () => {
    const p = path.resolve('CONTEXT.md');
    const normalized = normalizePath(p);
    if (process.platform === 'win32') {
      assert.equal(normalized, p.toLowerCase());
    } else {
      assert.equal(normalized, p);
    }
  });

  it('getAllowedBoundaryRoots includes PROJECT_ROOT, tmpdir, and user homedirs', () => {
    const roots = getAllowedBoundaryRoots();
    assert.ok(roots.includes(PROJECT_ROOT));
    assert.ok(roots.includes(os.tmpdir()));
  });

  it('scanVersionDirs returns directories sorted newest-first and handles non-existent dirs', () => {
    assert.deepEqual(scanVersionDirs('/path/that/does/not/exist/at/all'), []);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-scan-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'v1.0.0'));
      fs.mkdirSync(path.join(tmpDir, 'v2.1.0'));
      fs.mkdirSync(path.join(tmpDir, 'v1.10.0'));
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');

      const versions = scanVersionDirs(tmpDir);
      assert.deepEqual(versions, ['v2.1.0', 'v1.10.0', 'v1.0.0']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('isExecutableFile validates executable regular files and rejects invalid paths', () => {
    assert.equal(isExecutableFile(null), false);
    assert.equal(isExecutableFile(''), false);
    assert.equal(isExecutableFile('/nonexistent/path/binary'), false);
    assert.equal(isExecutableFile(os.tmpdir()), false);
    assert.equal(isExecutableFile(process.execPath), true);
  });

  it('findFirstExistingFile resolves the first existing file', () => {
    assert.equal(findFirstExistingFile([]), null);
    assert.equal(findFirstExistingFile(['/nonexistent/a', '/nonexistent/b']), null);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-exist-'));
    try {
      const fileB = path.join(tmpDir, 'existing.txt');
      fs.writeFileSync(fileB, 'content');
      const found = findFirstExistingFile(['/nonexistent/file', fileB, '/another/ghost']);
      assert.equal(found, fileB);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('existsAny verifies existence of multiple candidate paths', () => {
    assert.equal(existsAny(), false);
    assert.equal(existsAny(null, undefined, ''), false);
    assert.equal(existsAny('/nonexistent/1', '/nonexistent/2'), false);
    assert.equal(existsAny('/nonexistent/1', process.execPath, '/nonexistent/2'), true);
  });

  it('findBinary finds system binaries on PATH', () => {
    const nodeBin = findBinary('node');
    assert.ok(nodeBin !== null);
    assert.equal(findBinary('definitely-nonexistent-binary-xyz'), null);
  });

  it('findBinary accepts an array of names, resolving the first PATH match in order', () => {
    const resolved = findBinary(['definitely-nonexistent-binary-xyz', 'node']);
    assert.ok(resolved !== null);
    assert.equal(resolved, findBinary('node'));
  });
});

// ---------------------------------------------------------------------------
// SECTION: Attachments, Brief Files & Spill
// ---------------------------------------------------------------------------

describe('common: attachments, brief files & spill', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-attach-'));
  const created = [scratchDir];

  const scratchFile = (name, contents) => {
    const filePath = path.join(scratchDir, name);
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
  };

  after(() => {
    for (const target of created) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  it('reads a small attachment whole', () => {
    const file = scratchFile('small.md', 'line one\nline two\n');
    const result = readAttachment(file);
    assert.ok(result !== null);
    assert.equal(result.truncated, false);
    assert.equal(result.content, 'line one\nline two\n');
  });

  it('caps an oversized attachment on a line boundary', () => {
    const file = scratchFile('big.md', `${'x'.repeat(50)}\n`.repeat(200));
    const result = readAttachment(file, 512);
    assert.ok(result !== null);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= 512);
    assert.ok(result.content.endsWith('x'));
  });

  it('returns null for a missing file or a directory instead of throwing', () => {
    assert.equal(readAttachment(path.join(scratchDir, 'nope.md')), null);
    assert.equal(readAttachment(scratchDir), null);
  });

  it('labels every attachment with its path', () => {
    const a = scratchFile('a.ts', 'export const a = 1;');
    const b = scratchFile('b.ts', 'export const b = 2;');
    const result = buildAttachmentBlock([a, b]);

    assert.ok(result.text.includes(`[Attached Context File: ${a}]`));
    assert.ok(result.text.includes('export const b = 2;'));
  });

  it('enforces the total budget across files', () => {
    const a = scratchFile('big-a.md', 'a'.repeat(4096));
    const b = scratchFile('big-b.md', 'b'.repeat(4096));
    const result = buildAttachmentBlock([a, b], { perFile: 4096, total: 4096 });

    assert.ok(result.usedBytes <= 4096);
    assert.ok(result.notes.some((n) => n.startsWith('skipped')));
  });

  it('notes an unreadable attachment instead of failing the run', () => {
    const result = buildAttachmentBlock([path.join(scratchDir, 'ghost.md')]);
    assert.equal(result.text, '');
    assert.ok(result.notes.some((n) => n.startsWith('unreadable')));
  });

  it('leaves a small prompt on argv', () => {
    const { prompt, briefFile } = preparePromptForArgv('review this diff', 'claude');
    assert.equal(prompt, 'review this diff');
    assert.equal(briefFile, null);
  });

  it('spills an oversized prompt to a brief file holding the full text', () => {
    const huge = 'y'.repeat(getArgvByteLimit() + 1);
    const { prompt, briefFile } = preparePromptForArgv(huge, 'claude');
    assert.ok(briefFile !== null);
    created.push(briefFile);

    assert.ok(Buffer.byteLength(prompt, 'utf8') < getArgvByteLimit());
    assert.equal(fs.readFileSync(briefFile, 'utf8'), huge);
  });

  it('writes brief paths with forward slashes on every platform', () => {
    const { pointerPrompt, briefFile } = createBriefFile('brief body', 'agy');
    created.push(briefFile);

    const quotedPath = pointerPrompt.split('Brief file: ')[1].trim();
    assert.ok(!quotedPath.includes('\\'));
    assert.ok(fs.existsSync(briefFile));
  });

  it('pointer prompt is single-line', () => {
    const { pointerPrompt, briefFile } = createBriefFile('line one\nline two', 'claude');
    created.push(briefFile);
    assert.ok(!/[\r\n]/.test(pointerPrompt), 'pointer must survive a batch launcher argv');
    assert.ok(!pointerPrompt.slice(0, pointerPrompt.indexOf('Brief file: ')).includes('%'));
  });

  it('preparePromptForArgv spills a multi-line prompt for a .cmd binary on win32', { skip: process.platform !== 'win32' }, () => {
    assert.equal(isBatchLauncher('C:\\npm\\claude.cmd'), true);
    const multi = preparePromptForArgv('line one\nline two', 'claude', { binary: 'C:\\npm\\claude.cmd' });
    assert.ok(multi.briefFile !== null);
    created.push(multi.briefFile);
    assert.equal(fs.readFileSync(multi.briefFile, 'utf8'), 'line one\nline two');

    const percent = preparePromptForArgv('uses %PATH% literally', 'claude', { binary: 'x.bat' });
    assert.ok(percent.briefFile !== null);
    created.push(percent.briefFile);

    const big = preparePromptForArgv('z'.repeat(8001), 'claude', { binary: 'x.cmd' });
    assert.ok(big.briefFile !== null);
    created.push(big.briefFile);

    const exe = preparePromptForArgv('line one\nline two', 'claude', { binary: 'C:\\bin\\claude.exe' });
    assert.equal(exe.briefFile, null);
  });

  it('readAttachment rejects a symlink targeting a denylisted file', (t) => {
    const target = scratchFile('id_ed25519', 'PRIVATE KEY');
    const link = path.join(scratchDir, 'innocent-notes.md');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (err) {
      if (err.code === 'EPERM') return t.skip('symlink creation needs elevated rights here');
      throw err;
    }
    try {
      assert.equal(findSensitiveMatch(link), 'file');
      assert.equal(readAttachment(link), null);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('rejects sensitive files matching SENSITIVE_FILE_PATTERNS in buildAttachmentBlock', () => {
    const tokenFile = scratchFile('token.txt', 'secret-token-value');
    const safeFile = scratchFile('safe.txt', 'safe content');

    const result = buildAttachmentBlock([tokenFile, safeFile]);
    assert.ok(!result.text.includes('secret-token-value'));
    assert.ok(result.text.includes('safe content'));
    assert.ok(result.notes.some((n) => n.includes('token.txt')));
  });
});

// ---------------------------------------------------------------------------
// SECTION: Session Logging & Process Utilities
// ---------------------------------------------------------------------------

describe('common: session logging & process spawning', () => {
  it('creates dedicated session log file without errors', () => {
    const logger = createSessionLogger('test-provider');
    assert.ok(logger.logFile.includes('test-provider'));
    assert.ok(logger.logFile.startsWith(os.tmpdir()));
    assert.ok(!logger.logFile.includes('.scratch'));
    logger.write('Sample log line\n');
    logger.close();

    assert.ok(fs.existsSync(logger.logFile));
    fs.unlinkSync(logger.logFile);
  });

  it('spawns a binary directly with spawnCliSync', () => {
    const result = spawnCliSync(process.execPath, ['-e', 'console.log("direct")'], {
      encoding: 'utf8',
    });
    assert.equal(String(result.stdout).trim(), 'direct');
  });

  it('spawns a process with spawnCli and handles lifecycle', (t, done) => {
    const child = spawnCli(process.execPath, ['-e', 'console.log("async")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      assert.equal(code, 0);
      assert.equal(out.trim(), 'async');
      done();
    });
  });

  it('createSessionLogger: write after close does not throw or emit', async () => {
    const logger = createSessionLogger('test-after-close');
    logger.write('before-close\n');
    logger.close();
    assert.doesNotThrow(() => logger.write('after-close\n'));
    assert.doesNotThrow(() => logger.close());

    // The stream flushes asynchronously; wait for the pre-close line before asserting.
    let content = '';
    for (let i = 0; i < 50 && !content.includes('before-close'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      content = fs.readFileSync(logger.logFile, 'utf8');
    }
    assert.ok(content.includes('before-close'));
    assert.ok(!content.includes('after-close'));
    fs.unlinkSync(logger.logFile);
  });

  it('spawnCli rejects a newline argument for a .cmd launcher', { skip: process.platform !== 'win32' }, () => {
    assert.throws(
      () => spawnCli('C:\\fake\\tool.cmd', ['line1\nline2', 'after']),
      /batch launcher argument contains a newline/,
    );
    assert.throws(
      () => spawnCliSync('C:\\fake\\tool.cmd', ['a\rb']),
      /batch launcher argument contains a newline/,
    );
  });

  it('round-trips a single-line metacharacter argument through a real .cmd launcher', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cmd-echo-'));
    try {
      fs.writeFileSync(path.join(dir, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      const launcher = path.join(dir, 'echo.cmd');
      fs.writeFileSync(launcher, `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
      const arg = 'a & b " c ^ d <e> | f (g) !h!';
      const res = spawnCliSync(launcher, [arg, 'second'], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), [arg, 'second']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emitInitBanner formats standard banner with provider, model, effort, session, mode, and log', () => {
    let captured = '';
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      emitInitBanner({
        provider: 'Claude Code [desktop] (claude)',
        model: 'claude-3-7-sonnet',
        effort: 'high',
        sessionLink: 'https://example.com/session',
        mode: 'READ-ONLY',
        logFile: '/tmp/test.log',
      });
      assert.equal(
        captured,
        '[dispatch] Provider: Claude Code [desktop] (claude) | Model: claude-3-7-sonnet | Effort: high | Session: https://example.com/session | Mode: READ-ONLY | Log: /tmp/test.log\n',
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('emitInitBanner formats array model and omits null/undefined fields', () => {
    let captured = '';
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      emitInitBanner({
        provider: 'Antigravity 2.0 (agy)',
        model: ['gemini-3.8-flash', 'gemini-3.7-flash'],
        effort: null,
        logFile: '/tmp/test.log',
        mode: 'READ-ONLY',
      });
      assert.equal(
        captured,
        '[dispatch] Provider: Antigravity 2.0 (agy) | Model: gemini-3.8-flash, gemini-3.7-flash | Mode: READ-ONLY | Log: /tmp/test.log\n',
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('emitCompletionBanner formats completion banner with provider, resume, exitCode, and truncated', () => {
    let captured = '';
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      emitCompletionBanner({
        provider: 'OpenCode (LM Studio)',
        sessionLink: 'http://127.0.0.1:1234/v1',
        exitCode: 0,
        truncated: 'timeout',
      });
      assert.equal(
        captured,
        '[dispatch] Done: OpenCode (LM Studio) | Exit: 0 | Resume: http://127.0.0.1:1234/v1 | Truncated: timeout\n',
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('terminateProcessTree safely handles null or dead child', () => {
    assert.doesNotThrow(() => terminateProcessTree(null));
    assert.doesNotThrow(() => terminateProcessTree({ pid: 99999999 }));
  });

  it(
    'terminateProcessTree kills a grandchild, not just the direct child',
    { skip: process.platform === 'win32' ? 'POSIX process groups only' : false },
    async () => {
      // The defect: killing only the direct child left the real delegate CLI running, still
      // consuming tokens after the timeout fired.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-tree-'));
      try {
        const grandchild = path.join(dir, 'grandchild.js');
        fs.writeFileSync(grandchild, 'setInterval(() => {}, 1000);');
        const parent = path.join(dir, 'parent.js');
        fs.writeFileSync(
          parent,
          `const cp = require('node:child_process');
const kid = cp.spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });
process.stdout.write(String(kid.pid));
setInterval(() => {}, 1000);`,
        );

        const child = spawnCli(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'ignore'] });
        const grandchildPid = await new Promise((resolve) => {
          let buf = '';
          child.stdout.on('data', (c) => {
            buf += c.toString();
            if (buf.trim()) resolve(Number(buf.trim()));
          });
        });

        const alive = (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        assert.ok(alive(grandchildPid), 'the grandchild started');

        terminateProcessTree(child);
        // SIGKILL follows SIGTERM after 1s; allow for it plus scheduling slack.
        for (let i = 0; i < 40 && alive(grandchildPid); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(alive(grandchildPid), false, 'the grandchild was terminated with the group');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// SECTION: Security, Sanitization & Git Integrity
// ---------------------------------------------------------------------------

describe('common: security & git integrity', () => {
  it('getSanitizedEnv strips sensitive keys and preserves safe ones', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    const origPath = process.env.PATH;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-12345';
      const clean = getSanitizedEnv();

      assert.ok(!('ANTHROPIC_API_KEY' in clean));
      if (origPath !== undefined) {
        assert.equal(clean.PATH, origPath);
      }
    } finally {
      if (origKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origKey;
      }
    }
  });

  it('getSanitizedEnv passes non-secret proxy, CA and config-dir vars through', () => {
    const oldEnv = process.env;
    try {
      process.env = { ...oldEnv };
      process.env.HTTPS_PROXY = 'http://corp-proxy:8080';
      process.env.NO_PROXY = 'localhost';
      process.env.NODE_EXTRA_CA_CERTS = '/etc/ssl/corp.pem';
      process.env.XDG_CONFIG_HOME = '/home/u/.config';
      process.env.CLAUDE_CONFIG_DIR = '/home/u/.claude';
      process.env.TZ = 'Europe/Berlin';

      const clean = getSanitizedEnv();

      assert.equal(clean.HTTPS_PROXY, 'http://corp-proxy:8080');
      assert.equal(clean.NO_PROXY, 'localhost');
      assert.equal(clean.NODE_EXTRA_CA_CERTS, '/etc/ssl/corp.pem');
      assert.equal(clean.XDG_CONFIG_HOME, '/home/u/.config');
      assert.equal(clean.CLAUDE_CONFIG_DIR, '/home/u/.claude');
      assert.equal(clean.TZ, 'Europe/Berlin');
    } finally {
      process.env = oldEnv;
    }
  });

  it('every SAFE_ENV_WHITELIST entry survives SENSITIVE_ENV_KEY_PATTERN', () => {
    for (const key of SAFE_ENV_WHITELIST) {
      assert.ok(
        !SENSITIVE_ENV_KEY_PATTERN.test(key),
        `whitelisted ${key} is credential-shaped and would be stripped`,
      );
    }
  });

  it('SENSITIVE_FILE_PATTERNS and SENSITIVE_FILE_BASENAME_PATTERNS match known sensitive filenames', () => {
    const sensitive = [
      '.env', '.env.local', '.env.production',
      'id_rsa', 'id_ed25519',
      '.npmrc', '.pypirc', '.netrc',
      'server.pem', 'cert.p12',
    ];
    for (const file of sensitive) {
      assert.ok(
        SENSITIVE_FILE_PATTERNS.some((p) => p.test(file)) ||
        SENSITIVE_FILE_BASENAME_PATTERNS.some((p) => p.test(file)),
        `expected ${file} to match denylist`,
      );
    }
  });

  it('SENSITIVE_ENV_KEY_PATTERN matches credentials and keys', () => {
    assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('AWS_SECRET_ACCESS_KEY'));
    assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('GITHUB_TOKEN'));
    assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('API_KEY'));
    assert.ok(!SENSITIVE_ENV_KEY_PATTERN.test('PATH'));
    assert.ok(!SENSITIVE_ENV_KEY_PATTERN.test('NODE_ENV'));
  });

  it('describeGitStatusDiff returns null when statuses match or are null', () => {
    assert.equal(describeGitStatusDiff(null, null), null);
    assert.equal(describeGitStatusDiff('M file.ts', 'M file.ts'), null);
  });

  it('describeGitStatusDiff returns added lines when status diverges', () => {
    const before = ' M abc123 file.ts';
    const after = ' M abc123 file.ts\n?? def456 new.ts';
    const diff = describeGitStatusDiff(before, after);
    assert.ok(diff !== null);
    assert.ok(diff.includes('new.ts'));
  });

  it('describeGitStatusDiff reports a removed entry, not just added ones', () => {
    // Deleting an untracked file is a workspace mutation; it used to report violation with no detail.
    const before = ' M abc123 file.ts\n?? def456 scratch.ts';
    const after = ' M abc123 file.ts';
    const diff = describeGitStatusDiff(before, after);
    assert.ok(diff !== null);
    assert.ok(diff.includes('scratch.ts'));
  });

  it('describeGitStatusDiff reports a re-modified file once, not twice', () => {
    // The same path occupies a record in both snapshots under different hashes — one change.
    const diff = describeGitStatusDiff(' M aaa file.ts', ' M bbb file.ts');
    assert.equal(diff, 'M file.ts');
  });

  it('describeGitStatusDiff strips the hash column from displayed entries', () => {
    const diff = describeGitStatusDiff('', '?? deadbeef new.ts');
    assert.equal(diff, '?? new.ts');
  });

  it('checkGitIntegrity treats a null baseline as no violation', () => {
    assert.equal(checkGitIntegrity(null).violation, false);
  });

  describe('dedupeTargetsByBinary', () => {
    it('collapses modes resolving to the same binary, keeping the first', () => {
      // Three copilot modes routinely answer with one PATH executable; retrying it is pure latency.
      const targets = [
        { mode: 'desktop', bin: '/usr/local/bin/copilot' },
        { mode: 'vscode', bin: '/usr/local/bin/copilot' },
        { mode: 'cli', bin: '/opt/copilot/bin/copilot' },
      ];
      const deduped = dedupeTargetsByBinary(targets, (t) => t.bin);
      assert.deepEqual(
        deduped.map((t) => t.mode),
        ['desktop', 'cli'],
      );
    });

    it('preserves targets with no resolved binary', () => {
      const targets = [{ mode: 'a', bin: null }, { mode: 'b', bin: null }];
      assert.equal(dedupeTargetsByBinary(targets, (t) => t.bin).length, 2);
    });

    it('treats path spellings that normalize alike as one binary', () => {
      const targets = [
        { mode: 'a', bin: path.join(os.tmpdir(), 'cli') },
        { mode: 'b', bin: path.join(os.tmpdir(), '.', 'cli') },
      ];
      assert.equal(dedupeTargetsByBinary(targets, (t) => t.bin).length, 1);
    });
  });

  describe('getGitStatus content fingerprints', () => {
    /** Builds a throwaway git repo so the fingerprint can be observed against real git output. */
    const makeRepo = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-git-'));
      const git = (...args) => cp.spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      return { dir, git };
    };

    it('flags a content change to an already-modified file', () => {
      // The defect this replaced: both snapshots read ` M tracked.txt`, so a second edit by a
      // delegate was invisible to a status-line comparison.
      const { dir } = makeRepo();
      try {
        const file = path.join(dir, 'tracked.txt');
        fs.writeFileSync(file, 'two\n');
        const before = getGitStatus(dir);
        fs.writeFileSync(file, 'three\n');
        const after = getGitStatus(dir);

        assert.ok(before && after, 'both snapshots resolve inside a real repo');
        assert.notEqual(before, after);
        assert.equal(describeGitStatusDiff(before, after), 'M tracked.txt');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records a deleted file with a tombstone instead of failing', () => {
      const { dir } = makeRepo();
      try {
        fs.rmSync(path.join(dir, 'tracked.txt'));
        const status = getGitStatus(dir);
        assert.ok(status, 'a deletion still produces a snapshot');
        assert.match(status, /tracked\.txt$/m);
        assert.match(status, /^.D - tracked\.txt$/m);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('lists new files individually under an untracked directory', () => {
      // Without -uall these collapse into one `?? sub/` line, hiding per-file writes.
      const { dir } = makeRepo();
      try {
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.writeFileSync(path.join(dir, 'sub/a.txt'), 'a');
        fs.writeFileSync(path.join(dir, 'sub/b.txt'), 'b');
        const status = getGitStatus(dir);
        assert.match(status, /sub\/a\.txt$/m);
        assert.match(status, /sub\/b\.txt$/m);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fingerprints the destination of a rename without consuming the next entry', () => {
      // `-z` emits a rename as two NUL-terminated tokens; mis-parsing shifts every later entry.
      const { dir, git } = makeRepo();
      try {
        git('mv', 'tracked.txt', 'renamed.txt');
        fs.writeFileSync(path.join(dir, 'later.txt'), 'later');
        const status = getGitStatus(dir);
        assert.match(status, /renamed\.txt$/m);
        assert.match(status, /later\.txt$/m);
        assert.ok(!status.includes('tracked.txt'), 'the rename origin is not a separate entry');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null outside a git repository', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-nogit-'));
      try {
        assert.equal(getGitStatus(dir), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// SECTION: Failure Classification
// ---------------------------------------------------------------------------

describe('common: failure classification', () => {
  const cases = [
    ['Claude usage limit reached; resets at 4pm', 'quota'],
    ['HTTP 429 Too Many Requests', 'quota'],
    ['Your credit balance is too low', 'quota'],
    ['prompt is too long: 250000 tokens > 200000 maximum', 'context-overflow'],
    ['context_length_exceeded', 'context-overflow'],
    ['Error: Invalid API key provided', 'auth'],
    ['copilot: command not found', 'not-found'],
    ['Execution timed out after 1800s', 'timeout'],
    ['## Summary\nNo issues found in the diff.', null],
    ['', null],
  ];

  for (const [text, expected] of cases) {
    it(`classifies "${text.slice(0, 40)}" as ${expected}`, () => {
      assert.equal(classifyFailure(text), expected);
    });
  }

  it('tolerates non-string input', () => {
    assert.equal(classifyFailure(null), null);
    assert.equal(classifyFailure(undefined), null);
  });

  it('treats a clean exit with no output as empty', () => {
    assert.equal(isEmptyResult({ stdout: '   \n' }), true);
    assert.equal(isEmptyResult({}), true);
    assert.equal(isEmptyResult(null), true);
    assert.equal(isEmptyResult({ stdout: '## Summary' }), false);
  });
});

// ---------------------------------------------------------------------------
// SECTION: Skill Integrity & Hashes
// ---------------------------------------------------------------------------

describe('common: skill integrity & hashes', () => {
  it('verifySkillIntegrity returns missing:true when no manifest exists', () => {
    const result = verifySkillIntegrity(os.tmpdir(), 'nonexistent-manifest.json');
    assert.equal(result.missing, true);
    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
  });

  it('generateSkillHashes lists SKILL.md and .mjs scripts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-hash-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Skill', 'utf8');
      const scriptsDir = path.join(tmpDir, 'scripts');
      fs.mkdirSync(scriptsDir);
      fs.writeFileSync(path.join(scriptsDir, 'runner.mjs'), '// runner', 'utf8');

      const manifest = generateSkillHashes(tmpDir);
      assert.ok('SKILL.md' in manifest);
      assert.ok('scripts/runner.mjs' in manifest);
      assert.ok(typeof manifest['SKILL.md'] === 'string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generateSkillHashes hashes references/*.md and excludes config files', () => {
    const manifest = generateSkillHashes(path.join(PROJECT_ROOT, 'skills', 'dispatch'));
    assert.ok('references/alignment.md' in manifest);
    assert.ok(!Object.keys(manifest).some((k) => k.startsWith('config')));
    assert.deepEqual(Object.keys(manifest), [...Object.keys(manifest)].sort());
  });

  it('verifySkillIntegrity detects a tampered file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-tamper-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Skill', 'utf8');
      const manifest = generateSkillHashes(tmpDir);
      const manifestPath = path.join(tmpDir, 'skill-hashes.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

      // Tamper with the file
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Tampered', 'utf8');

      const result = verifySkillIntegrity(tmpDir);
      assert.equal(result.valid, false);
      assert.ok(result.violations.includes('SKILL.md'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifySkillIntegrity passes when all hashes match', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ok-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), '# Skill', 'utf8');
      const manifest = generateSkillHashes(tmpDir);
      const manifestPath = path.join(tmpDir, 'skill-hashes.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

      const result = verifySkillIntegrity(tmpDir);
      assert.equal(result.valid, true);
      assert.deepEqual(result.violations, []);
      assert.equal(result.missing, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SECTION: JSONC & Module Helpers
// ---------------------------------------------------------------------------

describe('common: jsonc & module helpers', () => {
  it('stripJsonComments removes comments and trailing commas while preserving strings', () => {
    assert.equal(stripJsonComments(''), '');
    assert.equal(stripJsonComments(null), '');

    const jsonc = `
      {
        // Line comment
        "url": "https://example.com/api",
        /* Multi-line
           comment */
        "key": "value // not a comment",
        "trailing": true,
      }
    `;
    const stripped = stripJsonComments(jsonc);
    assert.ok(!stripped.includes('// Line comment'));
    assert.ok(!stripped.includes('/* Multi-line'));
    assert.ok(stripped.includes('"url": "https://example.com/api"'));
    assert.ok(stripped.includes('"key": "value // not a comment"'));
    const parsed = JSON.parse(stripped);
    assert.equal(parsed.url, 'https://example.com/api');
    assert.equal(parsed.key, 'value // not a comment');
    assert.equal(parsed.trailing, true);

    const withCommasInString = '{"text": "val, } more, ]", "trailing": 1,}';
    const parsedWithCommas = JSON.parse(stripJsonComments(withCommasInString));
    assert.equal(parsedWithCommas.text, 'val, } more, ]');
    assert.equal(parsedWithCommas.trailing, 1);
  });

  it('parseJsonc parses JSONC strings with comments and trailing commas', () => {
    const input = '{\n  // comment\n  "enabled": true,\n  "count": 42,\n}';
    const res = parseJsonc(input);
    assert.deepEqual(res, { enabled: true, count: 42 });
  });

  it('isMainModule detects module execution entry point correctly including symlinks', () => {
    assert.equal(isMainModule(null), false);
    assert.equal(isMainModule(''), false);
    if (process.argv[1]) {
      const currentUrl = pathToFileURL(path.resolve(process.argv[1])).href;
      assert.equal(isMainModule(currentUrl), true);
    }
    assert.equal(isMainModule('file:///fake/path/definitely_not_main.mjs'), false);
  });

  describe('readStdin with piped input', () => {
    /** Runs readStdin in a child process, since stdin is a TTY (or closed) in the test runner. */
    const pipeToReadStdin = (input) => {
      const script = `import { readStdin } from ${JSON.stringify(
        pathToFileURL(path.join(PROJECT_ROOT, 'skills/dispatch/scripts/common.mjs')).href,
      )};
process.stdout.write(JSON.stringify(await readStdin()));`;
      const res = cp.spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        input,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    };

    it('returns the prompt field from piped JSON', () => {
      assert.equal(pipeToReadStdin('{"prompt":"Review the diff"}'), 'Review the diff');
    });

    it('falls back to the content field', () => {
      assert.equal(pipeToReadStdin('{"content":"Body text"}'), 'Body text');
    });

    it('returns plain piped text unchanged', () => {
      assert.equal(pipeToReadStdin('just a plain prompt'), 'just a plain prompt');
    });

    it('returns the raw text when JSON carries neither field', () => {
      assert.equal(pipeToReadStdin('{"other":1}'), '{"other":1}');
    });

    it('returns null for empty input', () => {
      assert.equal(pipeToReadStdin('   '), null);
    });
  });

  it('readStdin returns null when stdin is a TTY', async () => {
    const origIsTTY = process.stdin.isTTY;
    try {
      process.stdin.isTTY = true;
      const res = await readStdin();
      assert.equal(res, null);
    } finally {
      process.stdin.isTTY = origIsTTY;
    }
  });

  describe('resolveRunnerExitCode', () => {
    it('preserves exit code 0 when clean stdout is non-empty', () => {
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: '## Verdict\nAll good.' }), 0);
    });

    it('preserves exit code 0 when stdout mentions failure keywords like timeout or rate limit', () => {
      assert.equal(
        resolveRunnerExitCode({
          code: 0,
          cleanStdout: 'Code review: found a timeout bug in rate limit handler',
        }),
        0,
      );
    });

    it('forces exit code 1 when code is 0 but cleanStdout is empty', () => {
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: '' }), 1);
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: '   \n  \t' }), 1);
      assert.equal(resolveRunnerExitCode({ code: 0, cleanStdout: null }), 1);
    });

    it('forces exit code 1 when isError flag is true despite exit code 0', () => {
      assert.equal(
        resolveRunnerExitCode({ code: 0, cleanStdout: 'Some error message', isError: true }),
        1,
      );
    });

    it('maps timeout truncation to 124', () => {
      assert.equal(
        resolveRunnerExitCode({ code: 0, truncated: 'timeout', cleanStdout: 'partial output' }),
        124,
      );
    });

    it('maps buffer truncation to 137', () => {
      assert.equal(
        resolveRunnerExitCode({ code: 0, truncated: 'buffer', cleanStdout: 'partial output' }),
        137,
      );
    });

    it('preserves non-zero exit codes', () => {
      assert.equal(resolveRunnerExitCode({ code: 2, cleanStdout: 'Usage error' }), 2);
      assert.equal(resolveRunnerExitCode({ code: null, signal: 'SIGTERM' }), 1);
    });
  });
});
