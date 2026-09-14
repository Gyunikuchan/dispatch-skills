import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_FALLBACK_AGENT,
  DEFAULT_LM_STUDIO_HOST,
  DEFAULT_LM_STUDIO_PORT,
  DEFAULT_OUTPUT_LIMIT,
  getLMStudioEndpoint,
  isLocalEndpointHost,
  loadConfigFile,
  mergeConfigDeep,
  readOpencodeConfig,
  resolveDefaultAgent,
  resolveDefaultModel,
  resolveManagedConfigDir,
  resolveOpencodeSettings,
} from '../../../skills/dispatch/scripts/opencode-run.mjs';

// Config resolution exercises every tier of opencode's own precedence order; every fixture
// isolates its tiers from the real machine (parameterized root/homeDir/env/managedConfigDir).

describe('opencode-run config resolution', () => {
  describe('isLocalEndpointHost', () => {
    it('recognizes localhost, the full 127.0.0.0/8 loopback block, ::1, and 0.0.0.0', () => {
      assert.equal(isLocalEndpointHost('127.0.0.1'), true);
      assert.equal(isLocalEndpointHost('127.0.0.53'), true);
      assert.equal(isLocalEndpointHost('127.255.255.255'), true);
      assert.equal(isLocalEndpointHost('localhost'), true);
      assert.equal(isLocalEndpointHost('::1'), true);
      assert.equal(isLocalEndpointHost('0.0.0.0'), true);
    });

    it('rejects an arbitrary remote host and empty/nullish input', () => {
      assert.equal(isLocalEndpointHost('api.anthropic.com'), false);
      assert.equal(isLocalEndpointHost('192.168.1.5'), false);
      assert.equal(isLocalEndpointHost(''), false);
      assert.equal(isLocalEndpointHost(null), false);
      assert.equal(isLocalEndpointHost(undefined), false);
    });

    it('recognizes a bracketed IPv6 loopback literal as produced by new URL(...).hostname', () => {
      assert.equal(isLocalEndpointHost('[::1]'), true);
    });

    it('does not treat a domain name merely starting with "127." as loopback', () => {
      assert.equal(isLocalEndpointHost('127.example.com'), false);
    });
  });

  describe('resolveOpencodeSettings — dropped unconsumed fields', () => {
    it('returns no apiKey, temperature or agentPrompt key, and leaks no LM_STUDIO_API_KEY', () => {
      const oldEnv = process.env;
      process.env = { ...oldEnv, LM_STUDIO_API_KEY: 'sk-should-never-surface' };
      try {
        const settings = resolveOpencodeSettings({
          model: 'lmstudio/qwen3.8-27b-ridge',
          agent: { delegate: { temperature: 0.7, prompt: 'be brief' } },
        });
        for (const key of ['apiKey', 'temperature', 'agentPrompt']) {
          assert.ok(!(key in settings), `settings must not carry "${key}"`);
        }
        assert.ok(
          !JSON.stringify(settings).includes('sk-should-never-surface'),
          'LM_STUDIO_API_KEY must not appear anywhere in the returned settings',
        );
      } finally {
        process.env = oldEnv;
      }
    });

    it('preserves every other returned field, protocol included', () => {
      const settings = resolveOpencodeSettings({ model: 'lmstudio/qwen3.8-27b-ridge' });
      for (const key of [
        'rawModel',
        'modelId',
        'providerName',
        'baseURL',
        'contextLimit',
        'outputLimit',
        'reasoningEffort',
        'agentKey',
        'host',
        'port',
        'pathname',
        'protocol',
        'isLocal',
      ]) {
        assert.ok(key in settings, `settings must still carry "${key}"`);
      }
      assert.equal(settings.protocol, 'http:');
    });
  });

  describe('resolveOpencodeSettings — isLocal / explicitBaseURL branching', () => {
    it('never assumes LM Studio with zero config (no shipped DEFAULT_FALLBACK_MODEL)', () => {
      const settings = resolveOpencodeSettings(null);
      assert.equal(settings.isLocal, false);
      assert.equal(settings.providerName, null);
      assert.equal(settings.host, null);
      assert.equal(settings.port, null);
    });

    it('resolves the local LM Studio endpoint (isLocal: true) when a bare lmstudio model is configured', () => {
      const settings = resolveOpencodeSettings({ model: 'lmstudio/qwen3.8-27b-ridge' });
      assert.equal(settings.isLocal, true);
      assert.equal(settings.host, DEFAULT_LM_STUDIO_HOST);
      assert.equal(settings.port, DEFAULT_LM_STUDIO_PORT);
    });

    it('treats an explicit loopback baseURL under any provider name as local, not just "lmstudio"', () => {
      const settings = resolveOpencodeSettings({
        model: 'selfhosted/some-model',
        provider: { selfhosted: { options: { baseURL: 'http://127.0.0.1:8080/v1' } } },
      });
      assert.equal(settings.providerName, 'selfhosted');
      assert.equal(settings.isLocal, true);
      assert.equal(settings.host, '127.0.0.1');
      assert.equal(settings.port, 8080);
    });

    it('treats an explicit non-loopback baseURL under the "lmstudio" provider key as remote', () => {
      const settings = resolveOpencodeSettings({
        model: 'lmstudio/some-model',
        provider: { lmstudio: { options: { baseURL: 'https://remote-lmstudio.example.com/v1' } } },
      });
      assert.equal(settings.isLocal, false);
      assert.equal(settings.host, 'remote-lmstudio.example.com');
    });

    it('leaves host/port/pathname null and isLocal false for a cloud provider with no explicit baseURL', () => {
      const settings = resolveOpencodeSettings({ model: 'anthropic/claude-opus-5' });
      assert.equal(settings.providerName, 'anthropic');
      assert.equal(settings.modelId, 'claude-opus-5');
      assert.equal(settings.isLocal, false);
      assert.equal(settings.host, null);
      assert.equal(settings.port, null);
      assert.equal(settings.pathname, null);
    });

    it('LM_STUDIO_URL env override counts as an explicit baseURL, classified by its own host', () => {
      const oldEnv = process.env;
      try {
        process.env = { ...oldEnv, LM_STUDIO_URL: 'https://cloud-lmstudio.example.com/v1' };
        const settings = resolveOpencodeSettings({ model: 'lmstudio/some-model' });
        assert.equal(settings.isLocal, false);
        assert.equal(settings.host, 'cloud-lmstudio.example.com');
      } finally {
        process.env = oldEnv;
      }
    });

    it('treats a bracketed IPv6 loopback baseURL as local', () => {
      const settings = resolveOpencodeSettings({
        model: 'selfhosted/some-model',
        provider: { selfhosted: { options: { baseURL: 'http://[::1]:1234/v1' } } },
      });
      assert.equal(settings.isLocal, true);
    });

    it('defaults port to the scheme standard (443) for an explicit remote HTTPS baseURL with no port', () => {
      const settings = resolveOpencodeSettings({
        model: 'openaicompat/some-model',
        provider: { openaicompat: { options: { baseURL: 'https://api.example.com/v1' } } },
      });
      assert.equal(settings.isLocal, false);
      assert.equal(settings.protocol, 'https:');
      assert.equal(settings.port, 443);
    });
  });

  describe('readOpencodeConfig & the 7-tier merge', () => {
    it('returns the configured model when opencode.jsonc sets one', () => {
      const model = resolveDefaultModel({ model: 'lmstudio/qwen3.8-27b-ridge' });
      assert.equal(model, 'lmstudio/qwen3.8-27b-ridge');
    });

    it('returns fallback agent when no opencode config is present', () => {
      assert.equal(DEFAULT_FALLBACK_AGENT, 'plan');
      assert.equal(resolveDefaultAgent(null), DEFAULT_FALLBACK_AGENT);
      assert.equal(resolveDefaultAgent({}), DEFAULT_FALLBACK_AGENT);
    });

    it('resolves agent according to cascade: plan, primary mode, first key, fallback', () => {
      assert.equal(resolveDefaultAgent({ agent: { plan: {} } }), 'plan');
      assert.equal(resolveDefaultAgent({ agent: { plan: {}, custom: { mode: 'primary' } } }), 'plan');
      assert.equal(resolveDefaultAgent({ agent: { plan: false, custom: { mode: 'primary' } } }), 'custom');
      assert.equal(resolveDefaultAgent({ agent: { custom: { mode: 'primary' }, other: {} } }), 'custom');
      assert.equal(resolveDefaultAgent({ agent: { explore: {}, other: {} } }), 'explore');
      assert.equal(resolveDefaultAgent({ agent: {} }), 'plan');
      assert.equal(resolveDefaultAgent({ agent: 'invalid' }), 'plan');
      assert.equal(resolveDefaultAgent(null), 'plan');
    });

    it('returns null from readOpencodeConfig when no config file exists', () => {
      const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-empty-'));
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-empty-home-'));
      try {
        const config = readOpencodeConfig(isolatedRoot, {
          env: {},
          homeDir: isolatedHome,
        });
        assert.equal(config, null);
      } finally {
        fs.rmSync(isolatedRoot, { recursive: true, force: true });
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it('resolves LM Studio endpoint defaults when a bare lmstudio model is configured', () => {
      const endpoint = getLMStudioEndpoint(resolveOpencodeSettings({ model: 'lmstudio/qwen3.8-27b-ridge' }));
      assert.equal(endpoint.host, '127.0.0.1');
      assert.equal(endpoint.port, 1234);
      assert.equal(endpoint.pathname, '/v1');
      // Default stays plain http, so every existing local install is unaffected by the scheme work.
      assert.equal(endpoint.protocol, 'http:');
    });

    it('carries an https baseURL scheme onto the endpoint instead of flattening it to http', () => {
      // A self-hosted TLS backend on loopback is still classified local, so it reaches the
      // preflight; dropping its scheme made a working provider read as offline.
      const settings = resolveOpencodeSettings({
        model: 'lmstudio/qwen3.8-27b-ridge',
        provider: { lmstudio: { options: { baseURL: 'https://127.0.0.1:1234/v1' } } },
      });
      const endpoint = getLMStudioEndpoint(settings);
      assert.equal(endpoint.protocol, 'https:');
      assert.equal(endpoint.host, '127.0.0.1');
    });

    it('the LM_STUDIO_HOST/PORT env override reports http, the only scheme it can mean', () => {
      const saved = { h: process.env.LM_STUDIO_HOST, p: process.env.LM_STUDIO_PORT };
      process.env.LM_STUDIO_HOST = '127.0.0.1';
      process.env.LM_STUDIO_PORT = '4321';
      try {
        assert.equal(getLMStudioEndpoint().protocol, 'http:');
      } finally {
        if (saved.h === undefined) delete process.env.LM_STUDIO_HOST;
        else process.env.LM_STUDIO_HOST = saved.h;
        if (saved.p === undefined) delete process.env.LM_STUDIO_PORT;
        else process.env.LM_STUDIO_PORT = saved.p;
      }
    });

    it('no model configured anywhere: settings target neither LM Studio nor any provider', () => {
      // Behaviour change (this run): no shipped DEFAULT_FALLBACK_MODEL means dispatch never
      // assumes LM Studio when nothing is configured — opencode's own CLI default applies.
      const settings = resolveOpencodeSettings(null);
      assert.equal(settings.providerName, null);
      assert.equal(settings.modelId, null);
      assert.equal(settings.isLocal, false);
      assert.equal(settings.host, null);
      assert.equal(settings.port, null);
    });

    it('reads a project .opencode/opencode.jsonc and resolves its model limits and local endpoint', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-project-home-'));
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-project-'));
      try {
        fs.mkdirSync(path.join(projectRoot, '.opencode'));
        fs.writeFileSync(
          path.join(projectRoot, '.opencode', 'opencode.jsonc'),
          JSON.stringify({
            model: 'lmstudio/fixture-model',
            provider: {
              lmstudio: {
                options: { baseURL: 'http://127.0.0.1:1234/v1' },
                models: { 'fixture-model': { limit: { context: 73728, output: 8192 } } },
              },
            },
          }),
        );
        const config = readOpencodeConfig(projectRoot, {
          env: {},
          homeDir: isolatedHome,
          managedConfigDir: isolatedHome,
        });
        assert.ok(config, 'project .opencode/opencode.jsonc must be readable');

        const oldEnv = process.env;
        try {
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
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('falls back to DEFAULT_* context/output limits when no config is available', () => {
      const settings = resolveOpencodeSettings(null);
      assert.equal(settings.contextLimit, DEFAULT_CONTEXT_LIMIT);
      assert.equal(settings.outputLimit, DEFAULT_OUTPUT_LIMIT);
    });

    it('prefers .opencode/opencode.jsonc over a repository-root config, matching opencode precedence', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-precedence-'));
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-precedence-home-'));
      try {
        fs.writeFileSync(path.join(tmpRoot, 'opencode.jsonc'), JSON.stringify({ model: 'root/model' }));
        fs.mkdirSync(path.join(tmpRoot, '.opencode'));
        fs.writeFileSync(
          path.join(tmpRoot, '.opencode', 'opencode.jsonc'),
          JSON.stringify({ model: 'dotopencode/model' }),
        );

        const config = readOpencodeConfig(tmpRoot, { env: {}, homeDir: isolatedHome });
        assert.equal(config.model, 'dotopencode/model');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it('falls back to a repository-root config when .opencode has none', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-fallback-'));
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-fallback-home-'));
      try {
        fs.writeFileSync(path.join(tmpRoot, 'opencode.json'), JSON.stringify({ model: 'root/model' }));

        const config = readOpencodeConfig(tmpRoot, { env: {}, homeDir: isolatedHome });
        assert.equal(config.model, 'root/model');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it('reads global config from <homeDir>/.config/opencode when nothing else is present', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-global-home-'));
      try {
        const globalDir = path.join(isolatedHome, '.config', 'opencode');
        fs.mkdirSync(globalDir, { recursive: true });
        fs.writeFileSync(path.join(globalDir, 'opencode.jsonc'), JSON.stringify({ model: 'global/model' }));

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-global-root-'));
        try {
          const config = readOpencodeConfig(tmpRoot, { env: {}, homeDir: isolatedHome });
          assert.equal(config.model, 'global/model');
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it('honors XDG_CONFIG_HOME for the global config tier', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-xdg-home-'));
      const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-xdg-'));
      try {
        const globalDir = path.join(xdgDir, 'opencode');
        fs.mkdirSync(globalDir, { recursive: true });
        fs.writeFileSync(path.join(globalDir, 'opencode.jsonc'), JSON.stringify({ model: 'xdg/model' }));

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-xdg-root-'));
        try {
          const config = readOpencodeConfig(tmpRoot, {
            env: { XDG_CONFIG_HOME: xdgDir },
            homeDir: isolatedHome,
          });
          assert.equal(config.model, 'xdg/model');
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
        fs.rmSync(xdgDir, { recursive: true, force: true });
      }
    });

    it('reads OPENCODE_CONFIG above global but below project, per documented precedence', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-custom-home-'));
      const customConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-custom-'));
      try {
        const globalDir = path.join(isolatedHome, '.config', 'opencode');
        fs.mkdirSync(globalDir, { recursive: true });
        fs.writeFileSync(path.join(globalDir, 'opencode.jsonc'), JSON.stringify({ model: 'global/model' }));

        const customConfigPath = path.join(customConfigDir, 'custom.jsonc');
        fs.writeFileSync(customConfigPath, JSON.stringify({ model: 'custom/model' }));

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-custom-root-'));
        try {
          const withoutProject = readOpencodeConfig(tmpRoot, {
            env: { OPENCODE_CONFIG: customConfigPath },
            homeDir: isolatedHome,
          });
          assert.equal(withoutProject.model, 'custom/model');

          fs.writeFileSync(path.join(tmpRoot, 'opencode.jsonc'), JSON.stringify({ model: 'project/model' }));
          const withProject = readOpencodeConfig(tmpRoot, {
            env: { OPENCODE_CONFIG: customConfigPath },
            homeDir: isolatedHome,
          });
          assert.equal(withProject.model, 'project/model');
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
        fs.rmSync(customConfigDir, { recursive: true, force: true });
      }
    });

    it('rejects an OPENCODE_CONFIG path matching SENSITIVE_FILE_PATTERNS, treating it as absent', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-sensitive-home-'));
      const sensitiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-sensitive-'));
      try {
        const sensitivePath = path.join(sensitiveDir, '.env');
        fs.writeFileSync(sensitivePath, JSON.stringify({ model: 'should-not-load' }));

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-sensitive-root-'));
        try {
          const config = readOpencodeConfig(tmpRoot, {
            env: { OPENCODE_CONFIG: sensitivePath },
            homeDir: isolatedHome,
          });
          assert.equal(config, null);
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
        fs.rmSync(sensitiveDir, { recursive: true, force: true });
      }
    });

    it('folds OPENCODE_CONFIG_CONTENT above file-based tiers but below managed admin config', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-inline-home-'));
      try {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-inline-root-'));
        try {
          fs.writeFileSync(path.join(tmpRoot, 'opencode.jsonc'), JSON.stringify({ model: 'project/model' }));

          const inlineOnly = readOpencodeConfig(tmpRoot, {
            env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'inline/model' }) },
            homeDir: isolatedHome,
          });
          assert.equal(inlineOnly.model, 'inline/model', 'inline config must override project config');

          const managedDir = path.join(tmpRoot, 'managed');
          fs.mkdirSync(managedDir, { recursive: true });
          fs.writeFileSync(path.join(managedDir, 'opencode.json'), JSON.stringify({ model: 'managed/model' }));

          const withManaged = readOpencodeConfig(tmpRoot, {
            env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'inline/model' }) },
            homeDir: isolatedHome,
            managedConfigDir: managedDir,
          });
          assert.equal(withManaged.model, 'managed/model', 'managed config must override inline config');
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it('deep-merges provider blocks across two sources instead of one replacing the other', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-mergeprov-home-'));
      try {
        const globalDir = path.join(isolatedHome, '.config', 'opencode');
        fs.mkdirSync(globalDir, { recursive: true });
        fs.writeFileSync(
          path.join(globalDir, 'opencode.jsonc'),
          JSON.stringify({ provider: { lmstudio: { baseURL: 'http://global-lmstudio' } } }),
        );

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-mergeprov-root-'));
        try {
          fs.writeFileSync(
            path.join(tmpRoot, 'opencode.jsonc'),
            JSON.stringify({ provider: { anthropic: { baseURL: 'http://project-anthropic' } } }),
          );

          const config = readOpencodeConfig(tmpRoot, { env: {}, homeDir: isolatedHome });
          assert.equal(config.provider.lmstudio.baseURL, 'http://global-lmstudio');
          assert.equal(config.provider.anthropic.baseURL, 'http://project-anthropic');
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it('mergeConfigDeep drops __proto__/constructor/prototype keys instead of repointing the prototype', () => {
      const base = { model: 'base/model' };
      const malicious = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "prototype": "y", "model": "overlay/model"}');

      const merged = mergeConfigDeep(base, malicious);

      assert.equal(merged.model, 'overlay/model');
      assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
      assert.equal(Object.getPrototypeOf(merged), Object.prototype);
      assert.equal(merged.constructor, Object, 'constructor must remain the inherited one, not the string "x"');
    });

    it('loadConfigFile rejects a top-level array or primitive instead of corrupting the merge', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-nonobject-'));
      try {
        const arrayPath = path.join(tmpDir, 'array.json');
        fs.writeFileSync(arrayPath, JSON.stringify(['not', 'an', 'object']));
        assert.equal(loadConfigFile(arrayPath), null);

        const primitivePath = path.join(tmpDir, 'primitive.json');
        fs.writeFileSync(primitivePath, JSON.stringify(true));
        assert.equal(loadConfigFile(primitivePath), null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('ignores a non-object OPENCODE_CONFIG_CONTENT instead of corrupting the merge', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-inlinebad-home-'));
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-inlinebad-root-'));
      try {
        fs.writeFileSync(path.join(tmpRoot, 'opencode.jsonc'), JSON.stringify({ model: 'project/model' }));

        const config = readOpencodeConfig(tmpRoot, {
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(['not', 'an', 'object']) },
          homeDir: isolatedHome,
        });
        assert.equal(config.model, 'project/model');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it('resolveManagedConfigDir resolves per parameterized platform/env, not the real machine', () => {
      assert.equal(resolveManagedConfigDir({ platform: 'darwin', env: {} }), '/Library/Application Support/opencode');
      assert.equal(resolveManagedConfigDir({ platform: 'linux', env: {} }), '/etc/opencode');
      assert.equal(
        resolveManagedConfigDir({ platform: 'win32', env: { ProgramData: 'C:\\Fixture\\ProgramData' } }),
        path.join('C:\\Fixture\\ProgramData', 'opencode'),
      );
      assert.equal(
        resolveManagedConfigDir({ platform: 'win32', env: {} }),
        path.join('C:\\ProgramData', 'opencode'),
      );
    });

    it('does not throw when the managed config directory is missing or unreadable', () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-nomanaged-home-'));
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-nomanaged-root-'));
      try {
        fs.writeFileSync(path.join(tmpRoot, 'opencode.jsonc'), JSON.stringify({ model: 'project/model' }));

        assert.doesNotThrow(() => {
          const config = readOpencodeConfig(tmpRoot, { env: {}, homeDir: isolatedHome });
          assert.equal(config.model, 'project/model');
        });
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });
  });
});
