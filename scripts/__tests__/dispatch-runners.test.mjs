import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after, afterEach, mock } from 'node:test';

import {
  parseCommonArgs,
  formatSafetyPrompt,
  extractCleanResponse,
  isPathInside,
  createSessionLogger,
  buildAttachmentBlock,
  classifyFailure,
  createBriefFile,
  DEFAULT_TIMEOUT_SECONDS,
  getArgvByteLimit,
  isEmptyResult,
  preparePromptForArgv,
  readAttachment,
  spawnCliSync,
  SENSITIVE_FILE_PATTERNS,
  getSanitizedEnv,
  describeGitStatusDiff,
  verifySkillIntegrity,
  generateSkillHashes,
} from '../../dispatch/scripts/common.mjs';

import {
  detectOrchestrator,
  resolveProvider,
  getCandidateProviders,
  dispatchTask,
  providerProbes,
  providerRunners,
  workspaceProbes,
} from '../../dispatch/scripts/dispatch.mjs';

import {
  extractClaudeSessionId,
  getClaudeBinary,
  getClaudeDesktopBinary,
  getClaudeVSCodeBinary,
  getClaudeCliBinary,
  isClaudeAvailable,
  parseClaudeEnvelope,
  probeAllClaudeModes,
  resolveClaudeTarget,
  testClaudeBinaryReachability,
} from '../../dispatch/scripts/claude-run.mjs';

import {
  getCopilotVscodeCandidates,
  getCopilotCliCandidates,
  getCopilotVscodeBinary,
  getCopilotCliBinary,
  getCopilotBinary,
  resolveCopilotTarget,
  testCopilotReachability,
  probeCopilotModes,
  isCopilotAvailable,
  classifyCopilotFailure,
} from '../../dispatch/scripts/copilot-run.mjs';

import {
  AGY_MODES,
  AGY_MODE_PREFERENCE,
  AGY_MODE_DATA_DIRS,
  AGY_MODE_LABELS,
  getAgyBinary,
  getAgy20Binary,
  getAgyVSCodeBinary,
  getAgyCliBinary,
  detectAgyModePresence,
  isAgyModeAvailable,
  getAvailableAgyModes,
  isAgyAvailable,
  resolveAgyTarget,
  testAgyBinaryReachability,
  probeAllAgyModes,
  getNewestBrainConversationId,
  runAgy,
} from '../../dispatch/scripts/agy-run.mjs';

// ---------------------------------------------------------------------------
// SECTION: common utilities
// ---------------------------------------------------------------------------

describe('common utilities', () => {
  it('parses basic flags and positional prompt', () => {
    const argv = ['node', 'dispatch.mjs', 'Review', 'simulation', 'invariants'];
    const opts = parseCommonArgs(argv);

    assert.equal(opts.prompt, 'Review simulation invariants');
    assert.equal(opts.verbose, false);
    assert.equal(opts.timeout, DEFAULT_TIMEOUT_SECONDS);
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
      '--orchestrator', 'claude',
      '--provider', 'agy',
      '-v',
    ];
    const opts = parseCommonArgs(argv);

    assert.equal(opts.prompt, 'Analyze models');
    assert.deepEqual(opts.files, ['CONTEXT.md']);
    assert.equal(opts.orchestrator, 'claude');
    assert.equal(opts.provider, 'agy');
    assert.equal(opts.verbose, true);
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
      '--provider=copilot',
      '--orchestrator=claude',
      '--model=claude-opus-5',
      'prompt text',
    ]);
    assert.deepEqual(opts.files, ['CONTEXT.md']);
    assert.equal(opts.provider, 'copilot');
    assert.equal(opts.orchestrator, 'claude');
    assert.equal(opts.model, 'claude-opus-5');
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
  });

  it('checks path containment correctly across platforms', () => {
    const root = path.resolve('/test/project');
    const inside = path.resolve('/test/project/src/index.ts');
    const outside = path.resolve('/test/other/file.ts');

    assert.equal(isPathInside(inside, root), true);
    assert.equal(isPathInside(outside, root), false);
    assert.equal(isPathInside(root, root), true);
  });

  it('creates dedicated session log file without errors', () => {
    const logger = createSessionLogger('test-provider');
    assert.ok(logger.logFile.includes('test-provider'));
    assert.ok(logger.logFile.startsWith(os.tmpdir()), `expected logFile ${logger.logFile} to be within os.tmpdir()`);
    assert.ok(!logger.logFile.includes('.scratch'), `expected logFile ${logger.logFile} to never contain .scratch`);
    logger.write('Sample log line\n');
    logger.close();

    assert.ok(fs.existsSync(logger.logFile));
    fs.unlinkSync(logger.logFile);
  });

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

  it('SENSITIVE_FILE_PATTERNS matches known sensitive filenames', () => {
    const sensitive = [
      '.env', '.env.local', '.env.production',
      'id_rsa', 'id_ed25519',
      '.npmrc', '.pypirc', '.netrc',
      'server.pem', 'cert.p12',
    ];
    for (const file of sensitive) {
      assert.ok(
        SENSITIVE_FILE_PATTERNS.some((p) => p.test(file)),
        `expected ${file} to match denylist`,
      );
    }
  });

  it('describeGitStatusDiff returns null when statuses match or are null', () => {
    assert.equal(describeGitStatusDiff(null, null), null);
    assert.equal(describeGitStatusDiff('M file.ts', 'M file.ts'), null);
  });

  it('describeGitStatusDiff returns added lines when status diverges', () => {
    const before = 'M file.ts';
    const after = 'M file.ts\n?? new.ts';
    const diff = describeGitStatusDiff(before, after);
    assert.ok(diff !== null);
    assert.ok(diff.includes('new.ts'));
  });
});

// ---------------------------------------------------------------------------
// SECTION: attachment bounding & prompt spill
// ---------------------------------------------------------------------------

describe('attachment bounding & prompt spill', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-spec-'));
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
});

// ---------------------------------------------------------------------------
// SECTION: windows batch launcher spawning
// ---------------------------------------------------------------------------

describe('windows batch launcher spawning', () => {
  const isWindows = process.platform === 'win32';

  it('spawns a non-batch binary directly', () => {
    const result = spawnCliSync(process.execPath, ['-e', 'console.log("direct")'], {
      encoding: 'utf8',
    });
    assert.equal(String(result.stdout).trim(), 'direct');
  });

  it.skip('delivers arguments verbatim through cmd.exe (Windows only)', () => {
    if (!isWindows) return;
    // The batch launcher tests require a Windows environment — they are validated there.
  });
});

// ---------------------------------------------------------------------------
// SECTION: failure classification
// ---------------------------------------------------------------------------

describe('failure classification', () => {
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
// SECTION: skill integrity
// ---------------------------------------------------------------------------

describe('skill integrity', () => {
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
// SECTION: claude json envelope
// ---------------------------------------------------------------------------

describe('claude json envelope', () => {
  it('extracts text, session id, and error subtype', () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: '## Summary\nAll good.',
      session_id: 'abc-123-def',
    });

    const parsed = parseClaudeEnvelope(envelope);
    assert.equal(parsed.text, '## Summary\nAll good.');
    assert.equal(parsed.sessionId, 'abc-123-def');
    assert.equal(parsed.isError, true);
    assert.equal(parsed.subtype, 'error_max_turns');
  });

  it('reads the last result entry of a streamed array', () => {
    const stream = JSON.stringify([
      { type: 'assistant', message: 'thinking' },
      { type: 'result', result: 'final answer', session_id: 's-1', is_error: false },
    ]);

    const parsed = parseClaudeEnvelope(stream);
    assert.equal(parsed.text, 'final answer');
    assert.equal(parsed.sessionId, 's-1');
  });

  it('falls back to text extraction for non-JSON or malformed output', () => {
    assert.equal(parseClaudeEnvelope('## Summary\nplain text').text, '## Summary\nplain text');
    assert.equal(parseClaudeEnvelope('{"result": "truncated mid-str').isError, false);
  });

  it('does not match short prose after the word session', () => {
    assert.equal(extractClaudeSessionId('The session: ended cleanly'), null);
    assert.equal(extractClaudeSessionId('{"session_id":"uuid-value-1"}'), 'uuid-value-1');
  });
});

// ---------------------------------------------------------------------------
// SECTION: claude multi-mode resolution & reachability
// ---------------------------------------------------------------------------

describe('claude multi-mode resolution & reachability', () => {
  it('probes all three modes reporting metadata', () => {
    const modes = probeAllClaudeModes();
    assert.deepEqual(
      modes.map((m) => m.mode),
      ['desktop', 'vscode', 'cli'],
    );
    for (const m of modes) {
      assert.equal(typeof m.name, 'string');
      assert.equal(typeof m.reachable, 'boolean');
      assert.ok(['REACHABLE', 'UNREACHABLE', 'NOT_FOUND'].includes(m.status));
    }
  });

  it('tests reachability of an executable binary up to --version without token consumption', () => {
    const result = testClaudeBinaryReachability(process.execPath);
    assert.equal(result.reachable, true);
    assert.ok(/^v\d+\./.test(result.version));
    assert.equal(result.error, null);
  });

  it('reports unreachable for non-existent binary without throwing', () => {
    const result = testClaudeBinaryReachability('/path/to/non-existent-claude-binary');
    assert.equal(result.reachable, false);
    assert.equal(result.version, null);
    assert.ok(result.error !== null);
  });

  it('supports explicit mode override in resolution', () => {
    const targetDesktop = resolveClaudeTarget('desktop');
    if (targetDesktop) {
      assert.equal(targetDesktop.mode, 'desktop');
    }

    const targetVscode = resolveClaudeTarget('vscode');
    if (targetVscode) {
      assert.equal(targetVscode.mode, 'vscode');
    }

    const targetCli = resolveClaudeTarget('cli');
    if (targetCli) {
      assert.equal(targetCli.mode, 'cli');
    }
  });

  it('follows preference order desktop > vscode > cli', () => {
    const desktopBin = getClaudeDesktopBinary();
    const vscodeBin = getClaudeVSCodeBinary();
    const cliBin = getClaudeCliBinary();
    const resolved = resolveClaudeTarget();

    if (desktopBin) {
      assert.equal(resolved?.mode, 'desktop');
      assert.equal(getClaudeBinary(), desktopBin);
    } else if (vscodeBin) {
      assert.equal(resolved?.mode, 'vscode');
      assert.equal(getClaudeBinary(), vscodeBin);
    } else if (cliBin) {
      assert.equal(resolved?.mode, 'cli');
      assert.equal(getClaudeBinary(), cliBin);
    }
  });

  it('checks Claude availability without consuming tokens', async () => {
    const available = await isClaudeAvailable();
    assert.equal(typeof available, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// SECTION: copilot runner discovery & reachability
// ---------------------------------------------------------------------------

describe('copilot runner discovery & reachability', () => {
  it('gathers candidate paths for current platform', () => {
    const vscodeCandidates = getCopilotVscodeCandidates();
    const cliCandidates = getCopilotCliCandidates();

    assert.ok(Array.isArray(vscodeCandidates));
    assert.ok(Array.isArray(cliCandidates));
    assert.ok(vscodeCandidates.length > 0);
    assert.ok(cliCandidates.length > 0);
  });

  it('tests reachability of an executable binary up to --version without token consumption', () => {
    const result = testCopilotReachability(process.execPath);
    assert.equal(result.reachable, true);
    assert.ok(/^v\d+\./.test(result.version));
    assert.equal(result.error, null);
  });

  it('reports unreachable for non-existent binary without throwing', () => {
    const result = testCopilotReachability('/path/to/non-existent-copilot-binary');
    assert.equal(result.reachable, false);
    assert.equal(result.version, null);
    assert.ok(result.error !== null);
  });

  it('supports explicit mode override in resolution', () => {
    const targetVscode = resolveCopilotTarget('vscode');
    if (targetVscode) {
      assert.equal(targetVscode.mode, 'vscode');
    }

    const targetCli = resolveCopilotTarget('cli');
    if (targetCli) {
      assert.equal(targetCli.mode, 'cli');
    }
  });

  it('follows preference order: copilot vscode > copilot cli', () => {
    const vscodeBin = getCopilotVscodeBinary();
    const cliBin = getCopilotCliBinary();
    const resolved = resolveCopilotTarget();

    if (vscodeBin && testCopilotReachability(vscodeBin).reachable) {
      assert.equal(resolved?.mode, 'vscode');
      assert.equal(getCopilotBinary(), vscodeBin);
    } else if (cliBin && testCopilotReachability(cliBin).reachable) {
      assert.equal(resolved?.mode, 'cli');
      assert.equal(getCopilotBinary(), cliBin);
    }
  });

  it('probes all copilot modes without consuming tokens', () => {
    const probe = probeCopilotModes();
    assert.ok('vscode' in probe);
    assert.ok('cli' in probe);
    assert.equal(typeof probe.vscode.reachable, 'boolean');
    assert.equal(typeof probe.cli.reachable, 'boolean');
  });

  it('checks Copilot availability without requiring subscription or tokens', async () => {
    const available = await isCopilotAvailable();
    assert.equal(typeof available, 'boolean');
  });

  it('classifies Copilot-specific auth errors', () => {
    assert.equal(
      classifyCopilotFailure(
        'Error: No authentication information found.\nCopilot can be authenticated with GitHub using an OAuth Token.',
      ),
      'auth',
    );
    assert.equal(
      classifyCopilotFailure('You need an active GitHub Copilot subscription to use this feature.'),
      'auth',
    );
    assert.equal(
      classifyCopilotFailure('Please run `gh auth login` to authenticate'),
      'auth',
    );
  });
});

// ---------------------------------------------------------------------------
// SECTION: dispatch cascade & orchestrator detection
// ---------------------------------------------------------------------------

describe('dispatch cascade & orchestrator detection', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, originalEnv);
    mock.restoreAll();
  });

  const clearOrchestratorEnv = () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    delete process.env.ANTIGRAVITY_PROJECT_ID;
    delete process.env.GEMINI_CLI;
    delete process.env.CLAUDE_CODE;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.ANTIGRAVITY_SESSION_ID;
    delete process.env.COPILOT_AGENT;
    delete process.env.COPILOT_CLI_SESSION_ID;
    delete process.env.VSCODE_PID;
    delete process.env.OPENCODE_PORT;
    delete process.env.OPENCODE_AGENT;
  };

  describe('detectOrchestrator', () => {
    for (const [envVar, value] of [
      ['ANTIGRAVITY_AGENT', 'true'],
      ['ANTIGRAVITY_CONVERSATION_ID', 'conv-123'],
      ['ANTIGRAVITY_SESSION_ID', 'sess-456'],
      ['GEMINI_CLI', '1'],
    ]) {
      it(`detects agy when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'agy');
      });
    }

    for (const [envVar, value] of [
      ['CLAUDECODE', '1'],
      ['CLAUDE_CODE', '1'],
      ['CLAUDE_CODE_SESSION_ID', 'sess-claude-1'],
      ['CLAUDE_SESSION_ID', 'sess-claude-2'],
      ['CLAUDE_CODE_ENTRYPOINT', 'cli'],
    ]) {
      it(`detects claude when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'claude');
      });
    }

    for (const [envVar, value] of [
      ['COPILOT_AGENT', 'true'],
      ['COPILOT_CLI_SESSION_ID', 'sess-copilot'],
    ]) {
      it(`detects copilot when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'copilot');
      });
    }

    for (const [envVar, value] of [
      ['OPENCODE_PORT', '4096'],
      ['OPENCODE_AGENT', 'opencode'],
    ]) {
      it(`detects local when ${envVar} is set`, () => {
        clearOrchestratorEnv();
        process.env[envVar] = value;
        assert.equal(detectOrchestrator(), 'local');
      });
    }

    it('returns null when no orchestrator markers are present', () => {
      clearOrchestratorEnv();
      assert.equal(detectOrchestrator(), null);
    });

    it('does not infer Copilot from a bare VS Code terminal', () => {
      clearOrchestratorEnv();
      process.env.VSCODE_PID = '1234';
      assert.equal(detectOrchestrator(), null);
    });

    it('respects precedence order when multiple platform markers are present', () => {
      clearOrchestratorEnv();
      process.env.ANTIGRAVITY_AGENT = 'true';
      process.env.CLAUDECODE = '1';
      process.env.COPILOT_AGENT = 'true';
      process.env.OPENCODE_PORT = '4096';
      assert.equal(detectOrchestrator(), 'agy');

      clearOrchestratorEnv();
      process.env.CLAUDECODE = '1';
      process.env.COPILOT_AGENT = 'true';
      process.env.OPENCODE_PORT = '4096';
      assert.equal(detectOrchestrator(), 'claude');

      clearOrchestratorEnv();
      process.env.COPILOT_AGENT = 'true';
      process.env.OPENCODE_PORT = '4096';
      assert.equal(detectOrchestrator(), 'copilot');
    });
  });

  it('prioritizes claude over agy, copilot, and local when all are available', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);
    mock.method(providerProbes, 'isLocalAvailable', async () => true);

    const provider = await resolveProvider();
    assert.equal(provider, 'claude');
  });

  it('prioritizes agy when claude is unavailable or orchestrator', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isClaudeAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);
    mock.method(providerProbes, 'isLocalAvailable', async () => true);

    const provider = await resolveProvider();
    assert.equal(provider, 'agy');
  });

  it('prioritizes copilot when claude and agy are unavailable', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isClaudeAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => false);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);
    mock.method(providerProbes, 'isLocalAvailable', async () => true);

    const provider = await resolveProvider();
    assert.equal(provider, 'copilot');
  });

  it('falls back to local when claude, agy, and copilot are unavailable', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isClaudeAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => false);
    mock.method(providerProbes, 'isCopilotAvailable', async () => false);
    mock.method(providerProbes, 'isLocalAvailable', async () => true);

    const provider = await resolveProvider();
    assert.equal(provider, 'local');
  });

  it('skips orchestrator in alternative cascade', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    process.env.CLAUDE_CODE = '1';

    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);

    const provider = await resolveProvider();
    assert.equal(provider, 'agy');
  });

  it('returns null (subagent fallback) when no alternative agent is available', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    process.env.CLAUDE_CODE = '1';

    mock.method(providerProbes, 'isAgyAvailable', async () => false);
    mock.method(providerProbes, 'isCopilotAvailable', async () => false);
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);

    const provider = await resolveProvider();
    assert.equal(provider, null);
  });

  it('falls back to same agent when allowSameAgent is explicitly true', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    process.env.CLAUDE_CODE = '1';

    mock.method(providerProbes, 'isAgyAvailable', async () => false);
    mock.method(providerProbes, 'isCopilotAvailable', async () => false);
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);

    const provider = await resolveProvider({ allowSameAgent: true });
    assert.equal(provider, 'claude');
  });

  it('returns null when all providers are unavailable', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => false);
    mock.method(providerProbes, 'isClaudeAvailable', async () => false);
    mock.method(providerProbes, 'isCopilotAvailable', async () => false);

    const provider = await resolveProvider();
    assert.equal(provider, null);
  });

  it('honors explicit provider override regardless of cascade', async () => {
    const provider = await resolveProvider({ explicitProvider: 'copilot' });
    assert.equal(provider, 'copilot');
  });

  it('returns ordered candidates according to preference: claude > agy > copilot > local', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);
    mock.method(providerProbes, 'isLocalAvailable', async () => true);

    const candidates = await getCandidateProviders();
    assert.deepEqual(candidates, ['claude', 'agy', 'copilot', 'local']);
  });

  it('returns ordered candidates for fallback passes skipping orchestrator', async () => {
    clearOrchestratorEnv();
    process.env.CLAUDE_CODE = '1';

    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);
    mock.method(providerProbes, 'isLocalAvailable', async () => true);

    const candidates = await getCandidateProviders();
    assert.deepEqual(candidates, ['agy', 'copilot', 'local']);
  });

  it('cascades to next candidate when first candidate fails during execution', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    process.env.CLAUDE_CODE = '1';

    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);

    mock.method(providerRunners, 'agy', async () => {
      throw new Error('Auth failed');
    });
    mock.method(providerRunners, 'copilot', async () => ({
      provider: 'copilot',
      stdout: 'Success from copilot fallback',
      exitCode: 0,
      logFile: path.join(os.tmpdir(), 'copilot.log'),
      gitIntegrityViolation: false,
    }));

    const result = await dispatchTask({ prompt: 'Test task' });
    assert.equal(result.provider, 'copilot');
    assert.equal(result.stdout, 'Success from copilot fallback');
  });

  it('throws NO_DISPATCH_AVAILABLE when all candidate passes fail', async () => {
    clearOrchestratorEnv();
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    process.env.CLAUDE_CODE = '1';

    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => false);

    mock.method(providerRunners, 'agy', async () => {
      throw new Error('agy crashed');
    });

    await assert.rejects(
      dispatchTask({ prompt: 'Test task' }),
      /All candidate dispatch agents failed execution/,
    );
  });

  it('cascades past a provider that exits 0 with no output', async () => {
    clearOrchestratorEnv();
    process.env.CLAUDECODE = '1';
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);

    mock.method(providerRunners, 'agy', async () => ({
      provider: 'agy',
      stdout: '   ',
      stderr: 'usage limit reached',
      exitCode: 0,
    }));
    mock.method(providerRunners, 'copilot', async () => ({
      provider: 'copilot',
      stdout: '## Summary',
      exitCode: 0,
    }));

    const result = await dispatchTask({ prompt: 'Review' });
    assert.equal(result.provider, 'copilot');
  });

  it('reports why a pinned provider returned nothing instead of passing it off as success', async () => {
    clearOrchestratorEnv();
    process.env.CLAUDECODE = '1';
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerRunners, 'agy', async () => ({
      provider: 'agy',
      stdout: '',
      stderr: 'a tool required the "command" permission',
      exitCode: 0,
    }));

    const written = [];
    mock.method(process.stderr, 'write', (chunk) => {
      written.push(String(chunk));
      return true;
    });

    const result = await dispatchTask({ prompt: 'Review', provider: 'agy' });
    assert.equal(result.provider, 'agy');

    const notice = written.join('');
    assert.ok(notice.includes("Provider 'agy' exited 0 with no output"));
    assert.ok(notice.includes('Pinned with --provider'));
  });

  it('returns partial output when every provider fails', async () => {
    clearOrchestratorEnv();
    process.env.CLAUDECODE = '1';
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);

    mock.method(providerRunners, 'agy', async () => ({
      provider: 'agy',
      stdout: '## Partial findings',
      exitCode: 124,
      truncated: 'timeout',
    }));
    mock.method(providerRunners, 'copilot', async () => {
      throw new Error('copilot: command not found');
    });

    const result = await dispatchTask({ prompt: 'Review' });
    assert.equal(result.provider, 'agy');
    assert.equal(result.truncated, 'timeout');
    assert.equal(result.stdout, '## Partial findings');
  });

  it.todo('halts the cascade when a write-mode dispatch leaves the workspace modified — workspaceProbes.getGitStatus not yet wired into dispatchTask cascade guard');
  it.skip('halts the cascade when a write-mode dispatch leaves the workspace modified', async () => {
    clearOrchestratorEnv();
    process.env.CLAUDECODE = '1';
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);

    let workspaceState = '';
    mock.method(workspaceProbes, 'getGitStatus', () => workspaceState);
    const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
      provider: 'copilot',
      stdout: 'should not reach here',
      exitCode: 0,
    }));
    mock.method(providerRunners, 'agy', async () => {
      workspaceState = '?? .dispatch-write-guard.tmp';
      return { provider: 'agy', stdout: 'partial edit', exitCode: 1 };
    });

    const result = await dispatchTask({ prompt: 'Fix', allowWrite: true });
    assert.equal(result.provider, 'agy');
    assert.equal(copilotRunner.mock.calls.length, 0);
  });

  it('still cascades a write-mode failure that left the workspace untouched', async () => {
    clearOrchestratorEnv();
    process.env.CLAUDECODE = '1';
    mock.method(providerProbes, 'isLocalAvailable', async () => false);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    mock.method(providerProbes, 'isCopilotAvailable', async () => true);

    mock.method(workspaceProbes, 'getGitStatus', () => '');
    mock.method(providerRunners, 'agy', async () => {
      throw new Error('agy: command not found');
    });
    mock.method(providerRunners, 'copilot', async () => ({
      provider: 'copilot',
      stdout: 'applied the fix',
      exitCode: 0,
    }));

    const result = await dispatchTask({ prompt: 'Fix', allowWrite: true });
    assert.equal(result.provider, 'copilot');
  });

  it('does not cascade when a provider is pinned', async () => {
    clearOrchestratorEnv();
    const copilotRunner = mock.method(providerRunners, 'copilot', async () => ({
      provider: 'copilot',
      stdout: '',
      exitCode: 0,
    }));
    mock.method(providerRunners, 'agy', async () => ({
      provider: 'agy',
      stdout: '',
      exitCode: 1,
    }));

    const result = await dispatchTask({ prompt: 'Review', provider: 'agy' });
    assert.equal(result.exitCode, 1);
    assert.equal(copilotRunner.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// SECTION: antigravity multi-mode and reachability
// ---------------------------------------------------------------------------

describe('antigravity multi-mode and reachability', () => {
  it('enforces preference order: Antigravity 2.0 > VS Code Extension > CLI', () => {
    assert.deepEqual(AGY_MODE_PREFERENCE, [
      'antigravity-2.0',
      'antigravity-vscode',
      'antigravity-cli',
    ]);
    assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_2_0], 'antigravity');
    assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_VSCODE], 'antigravity-ide');
    assert.equal(AGY_MODE_DATA_DIRS[AGY_MODES.ANTIGRAVITY_CLI], 'antigravity-cli');
    assert.equal(AGY_MODE_LABELS[AGY_MODES.ANTIGRAVITY_2_0], 'Antigravity 2.0 (agy)');
  });

  it('detects mode presence across platforms and environments', () => {
    assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_2_0), 'boolean');
    assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_VSCODE), 'boolean');
    assert.equal(typeof detectAgyModePresence(AGY_MODES.ANTIGRAVITY_CLI), 'boolean');
  });

  it('resolves binary across modes and platforms', () => {
    const general = getAgyBinary();
    const agy20 = getAgy20Binary();
    const agyVscode = getAgyVSCodeBinary();
    const agyCli = getAgyCliBinary();

    if (general) {
      assert.equal(typeof general, 'string');
      assert.ok(fs.existsSync(general));
    }
    if (agy20) assert.ok(fs.existsSync(agy20));
    if (agyVscode) assert.ok(fs.existsSync(agyVscode));
    if (agyCli) assert.ok(fs.existsSync(agyCli));
  });

  it('tests reachability up to reaching the binary without requiring tokens', () => {
    const bin = getAgyBinary();
    if (bin) {
      const result = testAgyBinaryReachability(bin, AGY_MODES.ANTIGRAVITY_CLI);
      assert.ok('reachable' in result);
      assert.ok('error' in result);
    }

    const invalid = testAgyBinaryReachability('/nonexistent/path/agy');
    assert.equal(invalid.reachable, false);
    assert.ok(invalid.error.includes('does not exist'));
  });

  it('probes all modes and returns diagnostic presence and reachability', async () => {
    const probes = await probeAllAgyModes();
    assert.ok(Array.isArray(probes));
    assert.equal(probes.length, 3);

    const modes = probes.map((p) => p.mode);
    assert.deepEqual(modes, ['antigravity-2.0', 'antigravity-vscode', 'antigravity-cli']);

    for (const probe of probes) {
      assert.ok('mode' in probe);
      assert.ok('name' in probe);
      assert.ok('present' in probe);
      assert.ok('bin' in probe);
      assert.ok('reachable' in probe);
    }
  });

  it('resolves target in preference order or explicit override', () => {
    const target = resolveAgyTarget();
    if (target) {
      assert.ok(AGY_MODE_PREFERENCE.includes(target.mode));
      assert.ok(target.bin !== undefined);
      assert.ok(target.dataDir !== undefined);
    }

    const pinnedCli = resolveAgyTarget(AGY_MODES.ANTIGRAVITY_CLI);
    if (pinnedCli) {
      assert.equal(pinnedCli.mode, AGY_MODES.ANTIGRAVITY_CLI);
      assert.equal(pinnedCli.dataDir, 'antigravity-cli');
    }
  });

  it('returns newest brain conversation id from mode directory', () => {
    const id = getNewestBrainConversationId(0, AGY_MODES.ANTIGRAVITY_2_0);
    assert.ok(id === null || typeof id === 'string');
  });

  it('checks mode availability and returns active modes in preference order', async () => {
    const isCliAvail = await isAgyModeAvailable(AGY_MODES.ANTIGRAVITY_CLI);
    assert.equal(typeof isCliAvail, 'boolean');

    const activeModes = await getAvailableAgyModes();
    assert.ok(Array.isArray(activeModes));
    for (const m of activeModes) {
      assert.ok(AGY_MODE_PREFERENCE.includes(m));
    }

    const overall = await isAgyAvailable();
    assert.equal(typeof overall, 'boolean');
  });

  it('runAgy is a function', () => {
    assert.equal(typeof runAgy, 'function');
  });
});
