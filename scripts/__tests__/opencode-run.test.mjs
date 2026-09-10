import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach, mock } from 'node:test';

import {
  DEFAULT_MAX_BUFFER_MB,
  DEFAULT_TIMEOUT_SECONDS,
  extractCleanResponse,
  formatSafetyPrompt,
  isPathInside,
  normalizePath,
  parseCommonArgs,
  PROJECT_ROOT,
  SENSITIVE_ENV_KEY_PATTERN,
  SENSITIVE_FILE_PATTERNS,
} from '../../dispatch/scripts/common.mjs';
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_FALLBACK_AGENT,
  DEFAULT_LM_STUDIO_HOST,
  DEFAULT_LM_STUDIO_PORT,
  DEFAULT_OUTPUT_LIMIT,
  GPU_LOCK_FILE_NAME,
  buildCommand,
  getAllowedBoundaryRoots,
  getLMStudioEndpoint,
  getOpencodeEnv,
  isOpencodeAvailable,
  preflightLMStudioCheck,
  readOpencodeConfig,
  resolveContextFiles,
  resolveDefaultAgent,
  resolveDefaultModel,
  resolveOpencodeSettings,
  runOpencode,
  stripJsonComments,
} from '../../dispatch/scripts/opencode-run.mjs';

describe('opencode-run', () => {
  describe('parseCommonArgs', () => {
    it('parses basic flags and positional prompt with silent default', () => {
      const opts = parseCommonArgs(['node', 'opencode-run.mjs', 'Review', 'this', 'diff']);

      assert.equal(opts.prompt, 'Review this diff');
      assert.equal(opts.agent, null);
      assert.equal(opts.json, false);
      assert.equal(opts.verbose, false);
      assert.equal(opts.timeout, DEFAULT_TIMEOUT_SECONDS);
      assert.equal(opts.maxBufferMb, DEFAULT_MAX_BUFFER_MB);
      assert.deepEqual(opts.files, []);
    });

    it('parses explicit prompt flag, files, agent, and verbose flag', () => {
      const opts = parseCommonArgs([
        'node', 'opencode-run.mjs',
        '-p', 'Custom prompt',
        '-f', 'CONTEXT.md',
        '--artifact', 'docs/adr/001.md',
        '-a', 'local',
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
      const opts = parseCommonArgs([
        'node', 'opencode-run.mjs',
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
      const opts = parseCommonArgs(['node', 'opencode-run.mjs', '--help']);
      assert.equal(opts.help, true);
    });
  });

  describe('extractCleanResponse', () => {
    it('returns raw text unmodified when there are no tool traces', () => {
      const input = '# Review Findings\nAll tests pass cleanly.';
      assert.equal(extractCleanResponse(input), input);
    });

    it('strips [dispatch]-tagged trace lines and extracts assistant markdown response', () => {
      const input = `[dispatch] Provider: OpenCode (LM Studio)
[dispatch] Done: OpenCode (LM Studio) | Exit: 0
> build · qwen3.8-27b@iq4_xs
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

      assert.equal(extractCleanResponse(input), expected);
    });

    it('handles empty or non-string inputs safely', () => {
      assert.equal(extractCleanResponse(''), '');
      assert.equal(extractCleanResponse(null), '');
    });
  });

  describe('formatSafetyPrompt', () => {
    it('prepends read-only safety guardrails by default', () => {
      const prompt = 'Check for bugs in domain logic';
      const formatted = formatSafetyPrompt(prompt);

      assert.ok(formatted.includes('[SECURITY GUARDRAIL - READ-ONLY CONSTRAINTS]'));
      assert.ok(formatted.includes('strict READ-ONLY analysis mode'));
      assert.ok(formatted.includes('MUST NOT edit, overwrite, create, or delete any files'));
      assert.ok(formatted.includes(prompt));
    });

    it('frames workspace and attachment scope when opts are supplied', () => {
      const formatted = formatSafetyPrompt('Review the diff', {
        workspaceRoot: PROJECT_ROOT,
        attachedFiles: ['walkthrough.md', 'plan.md'],
      });

      assert.ok(formatted.includes(`[PRIMARY WORKSPACE]: ${PROJECT_ROOT}`));
      assert.ok(formatted.includes('[ATTACHED FILES]: walkthrough.md, plan.md'));
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
      const normalized = normalizePath(p);

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

    it('rejects an existing sensitive file inside an allowed boundary', () => {
      // The file must exist and sit inside PROJECT_ROOT, otherwise the existence or boundary
      // check would reject it first and the denylist would never be exercised.
      const sensitivePath = path.join(PROJECT_ROOT, '.env.opencode-run-test');
      fs.writeFileSync(sensitivePath, 'SECRET=1\n');
      try {
        assert.throws(
          () => resolveContextFiles([sensitivePath]),
          /matches sensitive denylist pattern/,
        );
      } finally {
        fs.unlinkSync(sensitivePath);
      }
    });

    it('covers the documented sensitive filename shapes', () => {
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

  describe('getOpencodeEnv & WAN Network Confinement', () => {
    it('whitelists safe variables and purges sensitive tokens/keys', () => {
      const oldEnv = { ...process.env };
      try {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test-12345';
        process.env.OPENAI_API_KEY = 'sk-proj-test-67890';
        process.env.GITHUB_TOKEN = 'ghp_testtoken';
        process.env.AWS_SECRET_ACCESS_KEY = 'test-aws-secret';
        process.env.MY_SECRET_PASSWORD = 'password123';

        const cleanEnv = getOpencodeEnv();

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

    it('admits only exactly-allowlisted OPENCODE_ keys, dropping unknown ones', () => {
      const oldEnv = process.env;
      try {
        process.env = { ...oldEnv };
        // Both allowlists are exact-name, not prefix-matched: the OPENCODE_ prefix alone
        // grants nothing.
        process.env.OPENCODE_CONFIG_DIR = '/tmp/opencode-config';
        process.env.OPENCODE_API_KEY = 'should-not-survive';
        process.env.OPENCODE_UNKNOWN_SETTING = 'should-not-survive';

        const env = getOpencodeEnv();

        assert.equal(env.OPENCODE_CONFIG_DIR, '/tmp/opencode-config');
        assert.equal(env.OPENCODE_API_KEY, undefined);
        assert.equal(env.OPENCODE_UNKNOWN_SETTING, undefined);
      } finally {
        process.env = oldEnv;
      }
    });

    it('never emits a key matching SENSITIVE_ENV_KEY_PATTERN', () => {
      const oldEnv = process.env;
      try {
        process.env = { ...oldEnv };
        process.env.AWS_SECRET_ACCESS_KEY = 'should-not-survive';
        process.env.GITHUB_TOKEN = 'should-not-survive';
        process.env.OPENCODE_API_KEY = 'should-not-survive';

        const env = getOpencodeEnv();

        // NOTE: the sensitive-key conjunct in getOpencodeEnv is defence in depth and is
        // currently unreachable — no name in either exact-match allowlist matches the pattern,
        // so the allowlist rejects these first. This asserts the resulting invariant, which
        // holds however a future allowlist addition shifts which layer does the rejecting.
        for (const key of Object.keys(env)) {
          assert.ok(
            !SENSITIVE_ENV_KEY_PATTERN.test(key),
            `sanitized env must not carry sensitive key ${key}`,
          );
        }
      } finally {
        process.env = oldEnv;
      }
    });

    it('proxy NO_PROXY includes the resolved endpoint port', () => {
      const settings = resolveOpencodeSettings(null);
      const env = getOpencodeEnv(settings);
      assert.ok(env.NO_PROXY.includes(String(settings.port)));
    });

    it('keeps OPENCODE_* entries that are not sensitive', () => {
      const oldEnv = { ...process.env };
      try {
        process.env.OPENCODE_PORT = '4096';
        process.env.OPENCODE_DISABLE_UPDATE_CHECK = '1';

        const env = getOpencodeEnv();
        assert.equal(env.OPENCODE_PORT, '4096');
        assert.equal(env.OPENCODE_DISABLE_UPDATE_CHECK, '1');
      } finally {
        process.env = oldEnv;
      }
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
      const config = readOpencodeConfig(os.tmpdir());
      assert.equal(config, null);
    });

    it('resolves LM Studio endpoint defaults when no config is present', () => {
      const endpoint = getLMStudioEndpoint(resolveOpencodeSettings(null));
      assert.equal(endpoint.host, '127.0.0.1');
      assert.equal(endpoint.port, 1234);
      assert.equal(endpoint.pathname, '/v1');
    });

    it('reads the real repo opencode.jsonc that the runner names a prerequisite', () => {
      // Passing null bypasses the file read and yields only the DEFAULT_* fallbacks, so read
      // the prerequisite config explicitly and assert the values it actually declares.
      const config = readOpencodeConfig(PROJECT_ROOT);
      assert.ok(config, 'repo-root opencode.jsonc must be readable — the runner requires it');

      const oldEnv = process.env;
      try {
        // LM_STUDIO_URL overrides the config baseURL, so clear it — otherwise a developer with
        // that variable exported fails the suite for the wrong reason.
        process.env = { ...oldEnv };
        delete process.env.LM_STUDIO_URL;

        const settings = resolveOpencodeSettings(config);
        assert.equal(settings.contextLimit, 73728);
        assert.equal(settings.outputLimit, 8192);
        assert.equal(settings.host, '127.0.0.1');
        assert.equal(settings.port, 1234);
      } finally {
        process.env = oldEnv;
      }
    });

    it('falls back to DEFAULT_* limits when no config is available', () => {
      const settings = resolveOpencodeSettings(null);
      assert.equal(settings.contextLimit, DEFAULT_CONTEXT_LIMIT);
      assert.equal(settings.outputLimit, DEFAULT_OUTPUT_LIMIT);
      assert.equal(settings.host, DEFAULT_LM_STUDIO_HOST);
      assert.equal(settings.port, DEFAULT_LM_STUDIO_PORT);
    });
  });

  describe('buildCommand', () => {
    it('builds proper command and args for OpenCode execution with default delegate agent', () => {
      const res = buildCommand({
        prompt: 'Analyze invariants',
        files: [path.resolve('CONTEXT.md')],
        model: 'lmstudio/qwen3.8-27b@iq4_xs',
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

    it('isOpencodeAvailable returns false when preflight fails', async () => {
      mock.method(http, 'get', () => {
        const emitter = new EventEmitter();
        Object.assign(emitter, { destroy: mock.fn() });
        process.nextTick(() => emitter.emit('error', new Error('ECONNREFUSED')));
        return emitter;
      });

      const available = await isOpencodeAvailable();
      assert.equal(available, false);
    });

    it('runOpencode rejects with SERVER_OFFLINE naming host and port when LM Studio is offline', async () => {
      mock.method(http, 'get', () => {
        const emitter = new EventEmitter();
        Object.assign(emitter, { destroy: mock.fn() });
        process.nextTick(() => emitter.emit('error', new Error('ECONNREFUSED')));
        return emitter;
      });

      await assert.rejects(
        runOpencode({ prompt: 'Test prompt when offline' }),
        (err) => {
          assert.ok(err.message.includes('LM Studio local server is not reachable'));
          assert.ok(err.message.includes('127.0.0.1'));
          assert.ok(err.message.includes('1234'));
          assert.equal(err.code, 'SERVER_OFFLINE');
          return true;
        },
      );
    });

    it('runOpencode rejects with CONTEXT_BUDGET_EXCEEDED and leaves no lockfile', async () => {
      mock.method(http, 'get', (...args) => {
        const callback = typeof args[1] === 'function' ? args[1] : args[2];
        const emitter = new EventEmitter();
        Object.assign(emitter, { destroy: mock.fn() });
        process.nextTick(() => {
          if (callback) callback({ statusCode: 200 });
        });
        return emitter;
      });

      const settings = resolveOpencodeSettings(null);
      const hugeBudget = (settings.contextLimit - settings.outputLimit) * 3.5 + 1;
      const hugePrompt = 'x'.repeat(Math.ceil(hugeBudget));

      const lockFile = path.join(os.tmpdir(), GPU_LOCK_FILE_NAME);

      await assert.rejects(
        runOpencode({ prompt: hugePrompt }),
        (err) => {
          assert.equal(err.code, 'CONTEXT_BUDGET_EXCEEDED');
          return true;
        },
      );

      // Lock must have been released
      assert.ok(!fs.existsSync(lockFile) || fs.readFileSync(lockFile, 'utf8').trim() !== String(process.pid));
    });

    it('runOpencode releases the lock when an attachment hits the denylist', async () => {
      mock.method(http, 'get', (...args) => {
        const callback = typeof args[1] === 'function' ? args[1] : args[2];
        const emitter = new EventEmitter();
        Object.assign(emitter, { destroy: mock.fn() });
        process.nextTick(() => {
          if (callback) callback({ statusCode: 200 });
        });
        return emitter;
      });

      const sensitivePath = path.join(PROJECT_ROOT, '.env.opencode-lock-test');
      fs.writeFileSync(sensitivePath, 'SECRET=1\n');
      const lockFile = path.join(os.tmpdir(), GPU_LOCK_FILE_NAME);

      try {
        await assert.rejects(
          runOpencode({ prompt: 'Review this', files: [sensitivePath] }),
          /matches sensitive denylist pattern/,
        );

        assert.ok(
          !fs.existsSync(lockFile) ||
            fs.readFileSync(lockFile, 'utf8').trim() !== String(process.pid),
          'lock must be released when resolveContextFiles throws',
        );
      } finally {
        fs.unlinkSync(sensitivePath);
      }
    });

    it('runOpencode rejects an empty prompt before any preflight or lock side effect', async () => {
      // A lockfile-absence assertion cannot detect this ordering: it passes trivially, and it
      // would also pass with the guard placed after acquireLock, because releaseOnce releases
      // on that path anyway. Preflight sits between the guard and the lock, so asserting the
      // health check never fired proves the guard ran before both.
      const httpGet = mock.method(http, 'get', () => {
        throw new Error('preflight must not run for an empty prompt');
      });

      await assert.rejects(runOpencode({ prompt: '   ' }), /No prompt provided/);

      assert.equal(httpGet.mock.callCount(), 0);
    });
  });
});
