import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach, mock } from 'node:test';

import { SENSITIVE_FILE_PATTERNS, formatSafetyPrompt } from '../../dispatch/scripts/common.mjs';
import {
  DEFAULT_FALLBACK_AGENT,
  DEFAULT_MAX_BUFFER_MB,
  DEFAULT_TIMEOUT_SECONDS,
  PROJECT_ROOT,
  SENSITIVE_ENV_KEY_PATTERN,
  buildCommand,
  getAllowedBoundaryRoots,
  getLMStudioEndpoint,
  getSanitizedEnv,
  isPathInside,
  normalizePathForComparison,
  parseArgs,
  preflightLMStudioCheck,
  readOpencodeConfig,
  resolveContextFiles,
  resolveDefaultAgent,
  resolveDefaultModel,
  runLocalAgent,
  stripJsonComments,
  extractAssistantResponse,
} from '../../dispatch/scripts/local-llm-run.mjs';

describe('local-llm-run', () => {
  describe('parseArgs', () => {
    it('parses basic flags and positional prompt with silent default', () => {
      const opts = parseArgs(['node', 'local-llm-run.mjs', 'Review', 'this', 'diff']);

      assert.equal(opts.prompt, 'Review this diff');
      assert.equal(opts.agent, null);
      assert.equal(opts.json, false);
      assert.equal(opts.verbose, false);
      assert.equal(opts.timeout, DEFAULT_TIMEOUT_SECONDS);
      assert.equal(opts.maxBufferMb, DEFAULT_MAX_BUFFER_MB);
      assert.deepEqual(opts.files, []);
    });

    it('parses explicit prompt flag, files, agent, and verbose flag', () => {
      const opts = parseArgs([
        'node', 'local-llm-run.mjs',
        '-p', 'Custom prompt',
        '-f', 'CONTEXT.md',
        '--artifact', 'docs/adr/001.md',
        '-a', 'local',
        '--allow-write',
        '--json',
        '-v',
      ]);

      assert.equal(opts.prompt, 'Custom prompt');
      assert.deepEqual(opts.files, ['CONTEXT.md', 'docs/adr/001.md']);
      assert.equal(opts.agent, 'local');
      assert.equal(opts.json, true);
      assert.equal(opts.verbose, true);
    });

    it('parses equals-separated arguments and custom numbers', () => {
      const opts = parseArgs([
        'node', 'local-llm-run.mjs',
        '--file=CONTEXT.md',
        '--artifact=README.md',
        '--agent=local',
        '--model=custom-provider/custom-model',
        '--timeout=120',
        '--max-buffer=25',
        '--verbose',
        'Explain architecture',
      ]);

      assert.deepEqual(opts.files, ['CONTEXT.md', 'README.md']);
      assert.equal(opts.agent, 'local');
      assert.equal(opts.model, 'custom-provider/custom-model');
      assert.equal(opts.timeout, 120);
      assert.equal(opts.maxBufferMb, 25);
      assert.equal(opts.verbose, true);
      assert.equal(opts.prompt, 'Explain architecture');
    });

    it('parses help flag', () => {
      const opts = parseArgs(['node', 'local-llm-run.mjs', '--help']);
      assert.equal(opts.help, true);
    });
  });

  describe('extractAssistantResponse', () => {
    it('returns raw text unmodified when there are no tool traces', () => {
      const input = '# Review Findings\nAll tests pass cleanly.';
      assert.equal(extractAssistantResponse(input), input);
    });

    it('strips leading opencode tool logs and extracts assistant markdown response', () => {
      const input = `> build · qwen3.8-27b@iq4_xs
→ Skill "code-review"
$ git status --short
A file.ts
✱ Grep "test" · 5 matches
→ Read file.ts

# Multi-Axis Review
## Summary
Everything looks great.`;

      const expected = `# Multi-Axis Review
## Summary
Everything looks great.`;

      assert.equal(extractAssistantResponse(input), expected);
    });

    it('handles empty or non-string inputs safely', () => {
      assert.equal(extractAssistantResponse(''), '');
      assert.equal(extractAssistantResponse(null), '');
    });
  });

  describe('formatSafetyPrompt', () => {
    it('prepends read-only safety guardrails by default', () => {
      const prompt = 'Check for bugs in domain logic';
      const formatted = formatSafetyPrompt(prompt, false);

      assert.ok(formatted.includes('[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]'));
      assert.ok(formatted.includes('strict READ-ONLY analysis mode'));
      assert.ok(formatted.includes('MUST NOT edit, overwrite, create, or delete any files'));
      assert.ok(formatted.includes(prompt));
    });

    it('always includes the prompt text in the output', () => {
      const prompt = 'Add unit tests in src/test.ts';
      const formatted = formatSafetyPrompt(prompt);

      assert.ok(formatted.includes(prompt));
    });
  });

  describe('Path & Boundary Utilities', () => {
    it('correctly determines whether a path is inside a directory', () => {
      const parent = path.resolve('/test/workspace');
      const child = path.resolve('/test/workspace/src/domain/model.ts');
      const siblingCollision = path.resolve('/test/workspace-malicious/evil.ts');

      assert.equal(isPathInside(child, parent), true);
      assert.equal(isPathInside(parent, parent), true);
      assert.equal(isPathInside(siblingCollision, parent), false);
    });

    it('normalizes path comparison across platforms', () => {
      const p = path.resolve('CONTEXT.md');
      const normalized = normalizePathForComparison(p);

      if (process.platform === 'win32') {
        assert.equal(normalized, p.toLowerCase());
      } else {
        assert.equal(normalized, p);
      }
    });

    it('includes workspace, Antigravity brain, agent dirs, and temp in allowed roots', () => {
      const roots = getAllowedBoundaryRoots();

      assert.ok(roots.includes(PROJECT_ROOT));
      assert.ok(roots.includes(os.tmpdir()));
      assert.ok(roots.some((r) => r.includes('antigravity')));
    });
  });

  describe('resolveContextFiles & Denylist Security', () => {
    it('resolves valid files within PROJECT_ROOT', () => {
      const resolved = resolveContextFiles(['package.json', 'README.md']);

      assert.equal(resolved.length, 2);
      assert.equal(resolved[0], path.resolve('package.json'));
      assert.equal(resolved[1], path.resolve('README.md'));
    });

    it('rejects non-existent files', () => {
      assert.throws(() => {
        resolveContextFiles(['non-existent-file-xyz.md']);
      }, /does not exist/);
    });

    it('rejects sensitive files matching denylist patterns', () => {
      const sensitiveFiles = [
        '.env', '.env.local', '.env.production',
        'secret.key', 'id_rsa', 'id_ed25519',
        '.npmrc', '.pypirc', '.netrc',
        'server.pem', 'cert.p12', 'auth.token',
      ];

      for (const file of sensitiveFiles) {
        const matches = SENSITIVE_FILE_PATTERNS.some((p) => p.test(file));
        assert.ok(matches, `Expected ${file} to match sensitive file pattern`);
      }
    });

    it('rejects files outside allowed boundaries', () => {
      const outOfBoundsPath =
        process.platform === 'win32'
          ? 'C:\\Windows\\system32\\drivers\\etc\\hosts'
          : '/etc/hosts';

      if (fs.existsSync(outOfBoundsPath)) {
        assert.throws(() => {
          resolveContextFiles([outOfBoundsPath]);
        }, /Access denied to path outside workspace/);
      }
    });
  });

  describe('getSanitizedEnv & WAN Network Confinement', () => {
    it('whitelists safe variables and purges sensitive tokens/keys', () => {
      const oldEnv = { ...process.env };
      try {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test-12345';
        process.env.OPENAI_API_KEY = 'sk-proj-test-67890';
        process.env.GITHUB_TOKEN = 'ghp_testtoken';
        process.env.AWS_SECRET_ACCESS_KEY = 'test-aws-secret';
        process.env.MY_SECRET_PASSWORD = 'password123';

        const cleanEnv = getSanitizedEnv();

        assert.ok(!('ANTHROPIC_API_KEY' in cleanEnv));
        assert.ok(!('OPENAI_API_KEY' in cleanEnv));
        assert.ok(!('GITHUB_TOKEN' in cleanEnv));
        assert.ok(!('AWS_SECRET_ACCESS_KEY' in cleanEnv));
        assert.ok(!('MY_SECRET_PASSWORD' in cleanEnv));

        assert.equal(cleanEnv.HTTP_PROXY, 'http://127.0.0.1:0');
        assert.equal(cleanEnv.HTTPS_PROXY, 'http://127.0.0.1:0');
        assert.ok(cleanEnv.NO_PROXY.includes('127.0.0.1'));
        assert.ok(cleanEnv.NO_PROXY.includes('localhost'));
      } finally {
        process.env = oldEnv;
      }
    });

    it('strictly checks SENSITIVE_ENV_KEY_PATTERN', () => {
      assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('API_KEY'));
      assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('SECRET_VAL'));
      assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('AUTH_TOKEN'));
      assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('PRIVATE_KEY'));
    });
  });

  describe('stripJsonComments', () => {
    it('strips single-line and multi-line comments but preserves strings with slashes', () => {
      const input = `{
        // Single line comment
        "url": "https://opencode.ai/config.json",
        /* Multi-line
           comment */
        "key": "value" // inline comment
      }`;
      const parsed = JSON.parse(stripJsonComments(input));

      assert.equal(parsed.url, 'https://opencode.ai/config.json');
      assert.equal(parsed.key, 'value');
    });

    it('returns empty string for null or non-string input', () => {
      assert.equal(stripJsonComments(''), '');
      assert.equal(stripJsonComments(null), '');
    });
  });

  describe('resolveDefaultModel, resolveDefaultAgent & LM Studio Endpoint', () => {
    it('returns fallback model when no opencode config is present', () => {
      const model = resolveDefaultModel();
      assert.equal(typeof model, 'string');
      assert.ok(model.length > 0);
    });

    it('returns fallback agent when no opencode config is present', () => {
      assert.equal(DEFAULT_FALLBACK_AGENT, 'delegate');
      const agent = resolveDefaultAgent();
      assert.equal(agent, DEFAULT_FALLBACK_AGENT);
    });

    it('returns null from readOpencodeConfig when no config file exists', () => {
      const config = readOpencodeConfig();
      assert.equal(config, null);
    });

    it('resolves LM Studio endpoint defaults when no config is present', () => {
      const endpoint = getLMStudioEndpoint();
      assert.equal(endpoint.host, '127.0.0.1');
      assert.equal(endpoint.port, 1234);
      assert.equal(endpoint.pathname, '/v1');
    });
  });

  describe('buildCommand', () => {
    it('builds proper command and args for OpenCode execution with default delegate agent', () => {
      const res = buildCommand({
        prompt: 'Analyze invariants',
        files: [path.resolve('CONTEXT.md')],
        model: 'lmstudio/qwen3.8-27b@iq4_xs',
        allowWrite: false,
        json: true,
      });

      assert.equal(typeof res.command, 'string');
      assert.ok(res.args.includes('run'));
      assert.ok(res.args.includes('--auto'));
      assert.ok(res.args.includes('--pure'));
      assert.ok(res.args.includes('--agent'));
      assert.ok(res.args.includes('delegate'));
      assert.ok(res.args.includes('-m'));
      assert.ok(res.args.includes('lmstudio/qwen3.8-27b@iq4_xs'));
      assert.ok(res.args.includes('--format'));
      assert.ok(res.args.includes('json'));
      assert.ok(res.args.some((a) => a.startsWith('--file=')));
      assert.ok(res.args.includes('--'));
      assert.ok(res.args[res.args.length - 1].includes('[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]'));
      assert.ok(res.args[res.args.length - 1].includes('Analyze invariants'));
    });

    it('builds proper command with custom agent override', () => {
      const res = buildCommand({
        prompt: 'Analyze invariants',
        files: [],
        agent: 'custom-agent',
        allowWrite: true,
        json: false,
      });

      assert.ok(res.args.includes('--agent'));
      assert.ok(res.args.includes('custom-agent'));
    });
  });

  describe('Offline Resilience & Health Check Mocking', () => {
    afterEach(() => {
      mock.restoreAll();
    });

    it('preflightLMStudioCheck returns false gracefully on network failure or offline server', async () => {
      mock.method(http, 'get', () => {
        const emitter = new EventEmitter();
        Object.assign(emitter, { destroy: mock.fn() });
        process.nextTick(() => emitter.emit('error', new Error('ECONNREFUSED')));
        return emitter;
      });

      const isReady = await preflightLMStudioCheck(100);
      assert.equal(isReady, false);
    });

    it('preflightLMStudioCheck returns true when server responds with 200', async () => {
      mock.method(http, 'get', (...args) => {
        const callback = typeof args[1] === 'function' ? args[1] : args[2];
        const emitter = new EventEmitter();
        Object.assign(emitter, { destroy: mock.fn() });
        process.nextTick(() => {
          if (callback) callback({ statusCode: 200 });
        });
        return emitter;
      });

      const isReady = await preflightLMStudioCheck(100);
      assert.equal(isReady, true);
    });

    it('runLocalAgent rejects with clear instructions when LM Studio is offline', async () => {
      mock.method(http, 'get', () => {
        const emitter = new EventEmitter();
        Object.assign(emitter, { destroy: mock.fn() });
        process.nextTick(() => emitter.emit('error', new Error('ECONNREFUSED')));
        return emitter;
      });

      await assert.rejects(
        runLocalAgent({ prompt: 'Test prompt when offline' }),
        /LM Studio local server is not reachable/,
      );
    });
  });
});
