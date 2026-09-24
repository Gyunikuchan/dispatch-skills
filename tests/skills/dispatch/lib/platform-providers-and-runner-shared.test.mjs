import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, after } from 'node:test';

import {
  isPathInside,
  normalizePath,
  getAllowedBoundaryRoots,
  isBatchLauncher,
  PROJECT_ROOT,
  dedupeTargetsByBinary,
  scanVersionDirs,
  isExecutableFile,
  findFirstExistingFile,
  findBinary,
  existsAny,
  stripJsonComments,
  parseJsonc,
  isMainModule,
} from '../../../../skills/dispatch/scripts/lib/platform.mjs';
import {
  diversitySort,
  detectOrchestratorModel,
  normalizeModelId,
  isSameModel,
  validateEffortSpec,
  validateModelSpec,
  validateProviderSpec,
} from '../../../../skills/dispatch/scripts/lib/providers.mjs';
import {
  parseCommonArgs,
  parseRunnerModeArgs,
  COMMON_VALUE_FLAGS,
  FLAG_ALIASES,
  formatCliError,
  safeExitCode,
  formatSafetyPrompt,
  extractCleanResponse,
  buildAttachmentBlock,
  findSensitiveMatch,
  readAttachment,
  preparePromptForArgv,
  createBriefFile,
  removeBriefFile,
  classifyFailure,
  resolveFailureKind,
  isEmptyResult,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_BUFFER_MB,
  getArgvByteLimit,
  buildFormattedPrompt,
  readStdin,
  resolveRunnerExitCode,
  resolveModelsToTry,
  cascadeModels,
  MAX_ATTACHMENT_BYTES_PER_FILE,
  MAX_ATTACHMENT_BYTES_TOTAL,
} from '../../../../skills/dispatch/scripts/runners/shared.mjs';
import { sessionTempDir } from '../../../../skills/dispatch/scripts/lib/session-temp.mjs';

// SECTION: Diversity sort & Model comparison

describe('common: diversitySort', () => {
  const c = (platform, model) => ({ platform, model });

  it('moves repeat platforms behind every first occurrence, keeping their order', () => {
    const input = [c('agy'), c('copilot'), c('opencode', 'glm'), c('opencode', 'mistral'), c('opencode', 'qwen')];
    assert.deepEqual(diversitySort(input).map((x) => x.model ?? x.platform), ['agy', 'copilot', 'glm', 'mistral', 'qwen']);
  });

  it('interleaves a second agy model after the first occurrences of every platform', () => {
    const input = [c('agy', 'a1'), c('agy', 'a2'), c('copilot'), c('opencode', 'glm'), c('opencode', 'mistral'), c('opencode', 'qwen')];
    assert.deepEqual(diversitySort(input).map((x) => x.model ?? x.platform), ['a1', 'copilot', 'glm', 'a2', 'mistral', 'qwen']);
  });

  it('accepts a custom key and is stable for a single platform', () => {
    const input = [{ provider: 'x', n: 1 }, { provider: 'x', n: 2 }, { provider: 'x', n: 3 }];
    assert.deepEqual(diversitySort(input, (e) => e.provider).map((e) => e.n), [1, 2, 3]);
  });

  it('returns a new empty array for empty input without mutating the original', () => {
    assert.deepEqual(diversitySort([]), []);
    const input = [c('a', 1), c('a', 2), c('b', 3)];
    diversitySort(input);
    assert.deepEqual(input.map((x) => x.model), [1, 2, 3]);
  });
});

describe('common: normalizeModelId & isSameModel', () => {
  it('strips provider prefixes up to the last slash', () => {
    assert.equal(normalizeModelId('opencode-go/glm-5.3-flash'), 'glm-5.3-flash');
    assert.equal(normalizeModelId('anthropic/claude-3-7-sonnet'), 'claude-3-7-sonnet');
    assert.equal(normalizeModelId('openrouter/mistral/mistral-chat'), 'mistral-chat');
  });

  it('strips trailing 8-digit date suffixes', () => {
    assert.equal(normalizeModelId('claude-3-7-sonnet-20250219'), 'claude-3-7-sonnet');
    assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(normalizeModelId('qwen2.5-72b-20240101'), 'qwen2.5-72b');
    // Does not mangle non-date suffixes
    assert.equal(normalizeModelId('model-v2'), 'model-v2');
  });

  it('trims and lowercases', () => {
    assert.equal(normalizeModelId('  Claude-Opus-5  '), 'claude-opus-5');
  });

  it('returns empty string for null/undefined/non-string', () => {
    assert.equal(normalizeModelId(null), '');
    assert.equal(normalizeModelId(undefined), '');
    assert.equal(normalizeModelId(''), '');
  });

  it('isSameModel compares single strings with normalization', () => {
    assert.ok(isSameModel('claude-opus-5', 'claude-opus-5'));
    assert.ok(isSameModel('anthropic/claude-3-7-sonnet-20250219', 'claude-3-7-sonnet'));
    assert.ok(!isSameModel('claude-opus-5', 'claude-sonnet-5'));
  });

  it('isSameModel handles candidate model arrays with any-match', () => {
    assert.ok(isSameModel(['claude-opus-5', 'claude-sonnet-5'], 'claude-sonnet-5'));
    assert.ok(isSameModel(['opencode-go/glm-5.3-flash', 'mistral-small'], 'glm-5.3-flash'));
    assert.ok(!isSameModel(['claude-opus-5', 'claude-sonnet-5'], 'gemini-3.8-flash'));
  });

  it('isSameModel returns false when either argument is null/undefined/empty', () => {
    assert.ok(!isSameModel(null, 'claude-opus-5'));
    assert.ok(!isSameModel('claude-opus-5', null));
    assert.ok(!isSameModel(undefined, 'claude-opus-5'));
    assert.ok(!isSameModel('claude-opus-5', undefined));
    assert.ok(!isSameModel(null, null));
    assert.ok(!isSameModel('', ''));
  });
});

describe('common: detectOrchestratorModel', () => {
  it('detects model for agy from ANTIGRAVITY_MODEL / GEMINI_MODEL', () => {
    assert.equal(detectOrchestratorModel({ env: { ANTIGRAVITY_MODEL: 'gemini-3.8-flash' }, orchestrator: 'agy' }), 'gemini-3.8-flash');
    assert.equal(detectOrchestratorModel({ env: { GEMINI_MODEL: 'gemini-3.7-flash' }, orchestrator: 'agy' }), 'gemini-3.7-flash');
  });

  it('detects model for claude from CLAUDE_MODEL / ANTHROPIC_MODEL', () => {
    assert.equal(detectOrchestratorModel({ env: { CLAUDE_MODEL: 'claude-opus-5' }, orchestrator: 'claude' }), 'claude-opus-5');
    assert.equal(detectOrchestratorModel({ env: { ANTHROPIC_MODEL: 'claude-3-7-sonnet' }, orchestrator: 'claude' }), 'claude-3-7-sonnet');
  });

  it('detects model for copilot from COPILOT_MODEL / GITHUB_COPILOT_MODEL', () => {
    assert.equal(detectOrchestratorModel({ env: { COPILOT_MODEL: 'gpt-5.6-luna' }, orchestrator: 'copilot' }), 'gpt-5.6-luna');
    assert.equal(detectOrchestratorModel({ env: { GITHUB_COPILOT_MODEL: 'gpt-4o' }, orchestrator: 'copilot' }), 'gpt-4o');
  });

  it('detects model for opencode from OPENCODE_MODEL', () => {
    assert.equal(detectOrchestratorModel({ env: { OPENCODE_MODEL: 'glm-5.3-flash' }, orchestrator: 'opencode' }), 'glm-5.3-flash');
  });

  it('returns null when orchestrator is null or unrecognized or env has no model', () => {
    assert.equal(detectOrchestratorModel({ env: {}, orchestrator: 'claude' }), null);
    assert.equal(detectOrchestratorModel({ env: { CLAUDE_MODEL: 'opus' }, orchestrator: null }), null);
    assert.equal(detectOrchestratorModel({ env: { CLAUDE_MODEL: 'opus' }, orchestrator: 'unknown' }), null);
  });
});

// SECTION: Model cascade

describe('common: resolveModelsToTry (no hardcoded default)', () => {
  it('returns [null] for null/undefined/empty so the CLI default applies', () => {
    assert.deepEqual(resolveModelsToTry(null), [null]);
    assert.deepEqual(resolveModelsToTry(undefined), [null]);
    assert.deepEqual(resolveModelsToTry(''), [null]);
  });

  it('keeps an array in order, dropping empty entries', () => {
    assert.deepEqual(resolveModelsToTry(['claude-opus-5', '', 'bedrock.claude-opus-5']), [
      'claude-opus-5',
      'bedrock.claude-opus-5',
    ]);
  });

  it('splits a comma-separated string', () => {
    assert.deepEqual(resolveModelsToTry('a, b ,c'), ['a', 'b', 'c']);
  });

  it('wraps a single model id', () => {
    assert.deepEqual(resolveModelsToTry('claude-opus-5'), ['claude-opus-5']);
  });
});

describe('common: cascadeModels', () => {
  it('rejects an empty models list instead of resolving undefined', async () => {
    await assert.rejects(() => cascadeModels([], async () => ({ exitCode: 0 }), { label: 'X' }), /non-empty/);
  });

  /** Runs `fn` with process.stderr captured; returns `{ value, stderr }` or rethrows with `stderr` attached. */
  async function captureStderr(fn) {
    let stderr = '';
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderr += chunk;
      return true;
    };
    try {
      return { value: await fn(), stderr };
    } catch (err) {
      err.capturedStderr = stderr;
      throw err;
    } finally {
      process.stderr.write = original;
    }
  }

  const ok = (model) => ({ exitCode: 0, failureKind: null, model });
  const fail = (model, failureKind = null) => ({ exitCode: 1, failureKind, model });

  it('stops at the first model that succeeds', async () => {
    const calls = [];
    const { value, stderr } = await captureStderr(() =>
      cascadeModels(['a', 'b'], async (m) => (calls.push(m), ok(m)), { label: 'X' }),
    );
    assert.deepEqual(calls, ['a']);
    assert.equal(value.model, 'a');
    assert.equal(stderr, '');
  });

  it('advances past a non-zero exit, with the pinned notice', async () => {
    const calls = [];
    const { value, stderr } = await captureStderr(() =>
      cascadeModels(['a', 'b'], async (m) => (calls.push(m), m === 'a' ? fail(m, 'quota') : ok(m)), { label: 'X' }),
    );
    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(value.model, 'b');
    assert.equal(
      stderr,
      '[dispatch] fallback X:a -> X:b: exit 1 [quota]\n',
    );
  });

  it('advances past a thrown error, with the pinned warning', async () => {
    const calls = [];
    const { value, stderr } = await captureStderr(() =>
      cascadeModels(
        ['a', 'b'],
        async (m) => {
          calls.push(m);
          if (m === 'a') throw new Error('boom');
          return ok(m);
        },
        { label: 'X' },
      ),
    );
    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(value.model, 'b');
    assert.equal(stderr, '[dispatch] fallback X:a -> X:b: boom\n');
  });

  it('returns / throws the last model outcome unchanged', async () => {
    const last = fail('b', 'other');
    const { value } = await captureStderr(() =>
      cascadeModels(['a', 'b'], async (m) => (m === 'a' ? fail(m) : last), { label: 'X' }),
    );
    assert.equal(value, last);

    const lastErr = new Error('last');
    await assert.rejects(
      captureStderr(() =>
        cascadeModels(['a', 'b'], async (m) => { throw m === 'a' ? new Error('first') : lastErr; }, { label: 'X' }),
      ),
      (e) => e === lastErr,
    );
  });

  it('SC7 exhausts every alias in order on auth failures before giving up the target', async () => {
    // Aliases may route through different keys or endpoints, so even auth advances the cascade.
    const calls = [];
    const authErr = Object.assign(new Error('unauthorized'), { failureKind: 'auth' });
    const { value } = await captureStderr(() =>
      cascadeModels(['a', 'b', 'c'], async (m) => {
        calls.push(m);
        if (m === 'a') return fail(m, 'auth');
        if (m === 'b') throw authErr;
        return ok(m);
      }, { label: 'X' }),
    );
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.equal(value.model, 'c');
  });

  it('[null] is a single attempt with a null model', async () => {
    const calls = [];
    const failed = fail(null);
    const value = await cascadeModels([null], async (m) => (calls.push(m), failed), { label: 'X' });
    assert.deepEqual(calls, [null]);
    assert.equal(value, failed);
  });
});

// SECTION: Argument Parsing & Defaults

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

  it('parses json flag', () => {
    const opts = parseCommonArgs(['node', 'd.mjs', '--json', 'prompt']);
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
    // `--prompt=` was never a documented long form (only the `-p <value>` space form); accepting
    // it would newly admit a spelling the original parser rejected.
    assert.throws(() => parseCommonArgs(['node', 'd.mjs', '--prompt=inline', 'p']), /Unknown flag: --prompt=inline/);
  });

  it('parses a runner flag declared only in the long form', () => {
    // Declared runner flags consume their `--name=value` spelling without leaking into positionals.
    const opts = parseCommonArgs(['node', 'runners/claude.mjs', '--mode=vscode', 'the prompt'], {
      valueFlags: ['--mode'],
    });
    assert.equal(opts.prompt, 'the prompt');
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
      ['node', 'runners/claude.mjs', '--claude-mode', 'cli', '--test-modes', '--mode=vscode', 'the', 'prompt'],
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

// SECTION: Shared runner-flag scanner

describe('common: parseRunnerModeArgs (shared runner-flag scanner)', () => {
  it('FLAG_ALIASES and COMMON_VALUE_FLAGS stay in lockstep', () => {
    // A flag added to one table only would make parseCommonArgs consume (or accept) its value
    // and then assign onto options[undefined] — silently dropped. Pin the two tables to set
    // equality; the flag-parity test covers the help surface one level up.
    assert.deepEqual([...FLAG_ALIASES.keys()].sort(), [...COMMON_VALUE_FLAGS].sort());
  });

  const claudeSpec = {
    valueFlags: ['--claude-mode', '--mode'],
    booleanFlags: ['--test-modes', '--probe-modes'],
    aliases: { '--claude-mode': 'requestedMode', '--mode': 'requestedMode' },
  };

  it('collapses aliased spellings onto one canonical value, last one wins', () => {
    const { values, booleans } = parseRunnerModeArgs(
      ['--claude-mode', 'cli', '--mode=desktop', '--test-modes'],
      claudeSpec,
    );
    assert.equal(values.requestedMode, 'desktop');
    assert.equal(booleans['--test-modes'], true);
    assert.equal(booleans['--probe-modes'], false);
  });

  it('scans past a -- separator, matching the per-runner parsers it replaced', () => {
    const { values } = parseRunnerModeArgs(['--', '--mode', 'cli'], claudeSpec);
    assert.equal(values.requestedMode, 'cli');
  });

  it('an unaliased value flag maps to itself instead of a null key', () => {
    const { values } = parseRunnerModeArgs(['--custom-flag', 'v'], {
      valueFlags: ['--custom-flag'],
      aliases: { '--other': 'other' },
    });
    assert.equal(values['--custom-flag'], 'v');
    assert.equal(values.other, null);
  });

  it('a declared value flag with no following value records null, never throws', () => {
    const { values } = parseRunnerModeArgs(['--claude-mode'], {
      valueFlags: ['--claude-mode'],
      aliases: { '--claude-mode': 'requestedMode' },
    });
    assert.equal(values.requestedMode, null);
  });
});

// SECTION: --prompt-file

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

// SECTION: Prompt Formatting & Response Extraction

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

  it('resolveFailureKind lets a runner timeout outrank text matches in partial output', () => {
    assert.equal(resolveFailureKind(classifyFailure('Finding: add a rate limit to the API'), 'timeout'), 'timeout');
    assert.equal(resolveFailureKind('quota', 'buffer'), 'quota');
    assert.equal(resolveFailureKind(null, 'buffer'), 'buffer');
    assert.equal(resolveFailureKind('auth', null), 'auth');
    assert.equal(resolveFailureKind(null, null), null);
  });
});

// SECTION: Path & Boundary Utilities

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
});

// SECTION: Attachments, Brief Files & Spill

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

  it('raises the attachment caps to 512 KB per file and 2 MB total (SC2)', () => {
    assert.equal(MAX_ATTACHMENT_BYTES_PER_FILE, 512 * 1024);
    assert.equal(MAX_ATTACHMENT_BYTES_TOTAL, 2 * 1024 * 1024);
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
    created.push(path.dirname(briefFile));

    assert.ok(Buffer.byteLength(prompt, 'utf8') < getArgvByteLimit());
    assert.equal(fs.readFileSync(briefFile, 'utf8'), huge);
  });

  it('writes brief paths with forward slashes on every platform', () => {
    const { pointerPrompt, briefFile } = createBriefFile('brief body', 'agy');
    created.push(path.dirname(briefFile));

    const quotedPath = pointerPrompt.split('Brief file: ')[1].trim();
    assert.ok(!quotedPath.includes('\\'));
    assert.ok(fs.existsSync(briefFile));
  });

  it('pointer prompt is single-line', () => {
    const { pointerPrompt, briefFile } = createBriefFile('line one\nline two', 'claude');
    created.push(path.dirname(briefFile));
    assert.ok(!/[\r\n]/.test(pointerPrompt), 'pointer must survive a batch launcher argv');
    assert.ok(!pointerPrompt.slice(0, pointerPrompt.indexOf('Brief file: ')).includes('%'));
  });

  it('preparePromptForArgv spills a multi-line prompt for a .cmd binary on win32', { skip: process.platform !== 'win32' }, () => {
    assert.equal(isBatchLauncher('C:\\npm\\claude.cmd'), true);
    const multi = preparePromptForArgv('line one\nline two', 'claude', { binary: 'C:\\npm\\claude.cmd' });
    assert.ok(multi.briefFile !== null);
    created.push(path.dirname(multi.briefFile));
    assert.equal(fs.readFileSync(multi.briefFile, 'utf8'), 'line one\nline two');

    const percent = preparePromptForArgv('uses %PATH% literally', 'claude', { binary: 'x.bat' });
    assert.ok(percent.briefFile !== null);
    created.push(path.dirname(percent.briefFile));

    const big = preparePromptForArgv('z'.repeat(8001), 'claude', { binary: 'x.cmd' });
    assert.ok(big.briefFile !== null);
    created.push(path.dirname(big.briefFile));

    const exe = preparePromptForArgv('line one\nline two', 'claude', { binary: 'C:\\bin\\claude.exe' });
    assert.equal(exe.briefFile, null);
  });

  it('preparePromptForArgv counts the caller\'s fixed args against the batch ceiling', { skip: process.platform !== 'win32' }, () => {
    // A prompt just under the bare 8000-byte batch limit fits on its own...
    const nearLimit = 'z'.repeat(7900);
    const bare = preparePromptForArgv(nearLimit, 'claude', { binary: 'x.cmd' });
    assert.equal(bare.briefFile, null);
    // ...but not once the runner's own arguments are counted, which is what cmd.exe actually
    // measures. Without reservedBytes this passed the check and was then truncated.
    const reserved = preparePromptForArgv(nearLimit, 'claude', { binary: 'x.cmd', reservedBytes: 1200 });
    assert.ok(reserved.briefFile !== null, 'fixed args must consume the same budget as the prompt');
    created.push(path.dirname(reserved.briefFile));
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

// SECTION: Brief File Cleanup

describe('common: removeBriefFile', () => {
  const leftovers = [];
  const makeBriefDir = (providerName = 'claude') => {
    const dir = sessionTempDir(`dispatch-brief-${providerName}-`);
    leftovers.push(dir);
    const briefFile = path.join(dir, 'brief.md');
    fs.writeFileSync(briefFile, 'body', 'utf8');
    return { dir, briefFile };
  };

  after(() => {
    for (const dir of leftovers) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('deletes the brief directory for a valid brief file', () => {
    const { dir, briefFile } = makeBriefDir();
    removeBriefFile(briefFile);
    assert.equal(fs.existsSync(dir), false);
  });

  it('is a no-op for null or undefined', () => {
    assert.doesNotThrow(() => removeBriefFile(null));
    assert.doesNotThrow(() => removeBriefFile(undefined));
  });

  it('refuses a relative path', () => {
    const { dir } = makeBriefDir();
    removeBriefFile(path.join('dispatch-brief-claude-xxx', 'brief.md'));
    assert.equal(fs.existsSync(dir), true);
  });

  it('refuses a directory whose basename does not start with dispatch-brief-', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-brief-dir-'));
    leftovers.push(dir);
    const briefFile = path.join(dir, 'brief.md');
    fs.writeFileSync(briefFile, 'body', 'utf8');
    removeBriefFile(briefFile);
    assert.equal(fs.existsSync(dir), true);
  });

  it('refuses a brief directory outside a session directory', () => {
    const outerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-outside-'));
    leftovers.push(outerRoot);
    const dir = path.join(outerRoot, 'dispatch-brief-claude-fake');
    fs.mkdirSync(dir);
    const briefFile = path.join(dir, 'brief.md');
    fs.writeFileSync(briefFile, 'body', 'utf8');
    removeBriefFile(briefFile);
    assert.equal(fs.existsSync(dir), true);
  });

  it('refuses a symlink standing in for the brief directory', (t) => {
    const { dir: realDir } = makeBriefDir();
    const linkDir = path.join(os.tmpdir(), `dispatch-brief-claude-link-${process.pid}`);
    try {
      fs.symlinkSync(realDir, linkDir, 'junction');
    } catch (err) {
      if (err.code === 'EPERM') return t.skip('symlink creation needs elevated rights here');
      throw err;
    }
    leftovers.push(linkDir);
    try {
      removeBriefFile(path.join(linkDir, 'brief.md'));
      assert.equal(fs.existsSync(realDir), true, 'the real directory behind the symlink must survive');
    } finally {
      try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch {}
    }
  });

});

// SECTION: Failure Classification

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

// SECTION: JSONC & Module Helpers

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
        pathToFileURL(path.join(PROJECT_ROOT, 'skills/dispatch/scripts/runners/shared.mjs')).href,
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

describe('common: formatCliError', () => {
  it('renders each terminal dispatch sentinel as a bracketed code', () => {
    for (const code of [
      'NO_DISPATCH_AVAILABLE',
      'INVALID_DISPATCH_CONFIG',
      'INTEGRITY_VIOLATION',
      'NO_CONFIG_REQUIRES_PROVIDER',
    ]) {
      const err = new Error('boom');
      err.code = code;
      assert.equal(formatCliError(err), `\n[dispatch] ERROR: [${code}] boom`);
    }
  });

  it('falls back to [ERROR] for a missing code and for a numeric forwarded exit code', () => {
    assert.equal(formatCliError(new Error('plain')), '\n[dispatch] ERROR: [ERROR] plain');
    const numeric = new Error('forwarded');
    numeric.code = 2;
    assert.equal(formatCliError(numeric), '\n[dispatch] ERROR: [ERROR] forwarded');
  });

  it('prints a non-sentinel string code verbatim (documented consequence: Node system errors)', () => {
    const err = new Error('no such file');
    err.code = 'ENOENT';
    assert.equal(formatCliError(err), '\n[dispatch] ERROR: [ENOENT] no such file');
  });

  it('handles a non-Error throw and a multi-line message without throwing', () => {
    assert.equal(formatCliError('bare string'), '\n[dispatch] ERROR: [ERROR] bare string');
    assert.equal(formatCliError(null), '\n[dispatch] ERROR: [ERROR] null');
    const multi = new Error('line one\n- line two');
    multi.code = 'INVALID_DISPATCH_CONFIG';
    assert.equal(
      formatCliError(multi),
      '\n[dispatch] ERROR: [INVALID_DISPATCH_CONFIG] line one\n- line two',
    );
  });

  // Totality against the throws that a bare `String(err)` / property read cannot survive: these are
  // what make the catch in the implementation load-bearing rather than defensive decoration.
  it('stays total for a null-prototype object, throwing getters, and a symbol', () => {
    const noProto = Object.create(null);
    assert.equal(formatCliError(noProto), '\n[dispatch] ERROR: [ERROR] [object Object]');

    const throwingMessage = {
      code: 'INTEGRITY_VIOLATION',
      get message() {
        throw new Error('getter exploded');
      },
    };
    assert.equal(
      formatCliError(throwingMessage),
      '\n[dispatch] ERROR: [INTEGRITY_VIOLATION] [object Object]',
    );

    const throwingCode = {
      message: 'readable',
      get code() {
        throw new Error('getter exploded');
      },
    };
    assert.equal(formatCliError(throwingCode), '\n[dispatch] ERROR: [ERROR] readable');

    assert.equal(formatCliError(Symbol('x')), '\n[dispatch] ERROR: [ERROR] Symbol(x)');
  });

  // The fallback itself is throwable: `Object.prototype.toString` fails on these three, so the
  // nested guard is what makes the "total" claim true rather than nearly true.
  it('stays total when Object.prototype.toString itself throws', () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const hostile = [
      revocable.proxy,
      new Proxy(
        {},
        {
          get() {
            throw new Error('trap exploded');
          },
        },
      ),
      {
        get [Symbol.toStringTag]() {
          throw new Error('tag exploded');
        },
      },
    ];
    for (const err of hostile) {
      assert.equal(formatCliError(err), '\n[dispatch] ERROR: [ERROR] [unprintable error]');
    }

    // The `.code` guard's own path: the read throws, the message is still printable.
    const throwingCodeGetter = {
      message: 'm',
      get code() {
        throw new Error('c');
      },
    };
    assert.equal(formatCliError(throwingCodeGetter), '\n[dispatch] ERROR: [ERROR] m');
  });

  it('derives a total exit code: numeric code forwarded, everything else 1', () => {
    const forwarded = new Error('delegate failed');
    forwarded.code = 42;
    assert.equal(safeExitCode(forwarded), 42);

    const sentinel = new Error('no delegate');
    sentinel.code = 'NO_DISPATCH_AVAILABLE';
    assert.equal(safeExitCode(sentinel), 1);

    assert.equal(safeExitCode(null), 1);
    assert.equal(
      safeExitCode({
        get code() {
          throw new Error('c');
        },
      }),
      1,
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    assert.equal(safeExitCode(revocable.proxy), 1);
  });

  describe('validateModelSpec, validateEffortSpec, validateProviderSpec', () => {
    it('accepts valid model specs and null/undefined', () => {
      assert.doesNotThrow(() => validateModelSpec(null));
      assert.doesNotThrow(() => validateModelSpec(undefined));
      assert.doesNotThrow(() => validateModelSpec('claude-opus-5'));
      assert.doesNotThrow(() => validateModelSpec(['claude-opus-5', 'claude-sonnet-5']));
    });

    it('rejects empty, whitespace-only, and colon-suffixed models', () => {
      assert.throws(() => validateModelSpec(''), /cannot be empty/);
      assert.throws(() => validateModelSpec('   '), /cannot be empty/);
      assert.throws(() => validateModelSpec('claude:'), /end with a colon/);
      assert.throws(() => validateModelSpec([]), /cannot be empty/);
      assert.throws(() => validateModelSpec(['   ']), /cannot be empty/);
      assert.throws(() => validateModelSpec(['valid', 'claude:']), /end with a colon/);
      assert.throws(() => validateModelSpec('valid, claude:'), /colon/);
      assert.throws(() => validateModelSpec('sonnet,,'), /empty or colon-suffixed/);
      assert.throws(() => validateModelSpec(','), /empty or colon-suffixed/);
      assert.throws(() => validateModelSpec(123), /must be a string/);
    });

    it('accepts valid effort specs and null/undefined', () => {
      assert.doesNotThrow(() => validateEffortSpec(null));
      assert.doesNotThrow(() => validateEffortSpec(undefined));
      assert.doesNotThrow(() => validateEffortSpec('medium'));
    });

    it('rejects empty, whitespace-only, or non-string effort', () => {
      assert.throws(() => validateEffortSpec(''), /cannot be empty/);
      assert.throws(() => validateEffortSpec('   '), /cannot be empty/);
      assert.throws(() => validateEffortSpec(123), /cannot be empty/);
    });

    it('accepts valid provider specs and normalizes aliases', () => {
      assert.equal(validateProviderSpec(null), null);
      assert.equal(validateProviderSpec(undefined), null);
      assert.equal(validateProviderSpec('claude'), 'claude');
      assert.equal(validateProviderSpec('claudecode'), 'claude');
      assert.equal(validateProviderSpec('antigravity'), 'agy');
      assert.equal(validateProviderSpec('github-copilot'), 'copilot');
    });

    it('rejects empty, whitespace-only, colon-suffixed, or unknown providers', () => {
      assert.throws(() => validateProviderSpec(''), /cannot be empty/);
      assert.throws(() => validateProviderSpec('   '), /cannot be empty/);
      assert.throws(() => validateProviderSpec('claude:'), /end with a colon/);
      assert.throws(() => validateProviderSpec('unknown-provider'), /Unknown provider specified/);
    });
  });
});
