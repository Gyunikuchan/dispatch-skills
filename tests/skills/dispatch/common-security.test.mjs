import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getSanitizedEnv,
  SENSITIVE_ENV_KEY_PATTERN,
  SENSITIVE_FILE_PATTERNS,
  SENSITIVE_FILE_BASENAME_PATTERNS,
  SENSITIVE_DIR_PATTERNS,
  SAFE_ENV_WHITELIST,
} from '../../../skills/dispatch/scripts/common.mjs';

// ---------------------------------------------------------------------------
// SECTION: Environment Sanitization
// ---------------------------------------------------------------------------

describe('common: environment sanitization', () => {
  it('getSanitizedEnv strips sensitive keys and preserves safe ones', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    // Windows spells the key `Path`; the whitelist carries both spellings, so match the platform's own.
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k));
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-12345';
      const clean = getSanitizedEnv();

      assert.ok(!('ANTHROPIC_API_KEY' in clean));
      if (pathKey !== undefined) {
        assert.equal(clean[pathKey], process.env[pathKey]);
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

  it('SENSITIVE_ENV_KEY_PATTERN matches credentials and keys', () => {
    assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('AWS_SECRET_ACCESS_KEY'));
    assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('GITHUB_TOKEN'));
    assert.ok(SENSITIVE_ENV_KEY_PATTERN.test('API_KEY'));
    assert.ok(!SENSITIVE_ENV_KEY_PATTERN.test('PATH'));
    assert.ok(!SENSITIVE_ENV_KEY_PATTERN.test('NODE_ENV'));
  });
});

// ---------------------------------------------------------------------------
// SECTION: Sensitive Path Denylists
// ---------------------------------------------------------------------------

describe('common: sensitive path denylists', () => {
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

  it('SENSITIVE_DIR_PATTERNS match known credential directories', () => {
    const sensitiveDirs = [
      '/home/u/.ssh/config',
      '/home/u/.gnupg/pubring.kbx',
      '/home/u/.aws/credentials',
      '/home/u/.kube/config',
      'C:\\Users\\u\\.azure\\accessToken',
      '/Users/u/.password-store/gh.gpg',
    ];
    for (const dir of sensitiveDirs) {
      assert.ok(
        SENSITIVE_DIR_PATTERNS.some((p) => p.test(dir)),
        `expected ${dir} to match the directory denylist`,
      );
    }
  });

  it('whole-word basename patterns do not false-positive on word-embedded filenames', () => {
    const safeNames = ['tokenizer.ts', 'secretary.js', 'secretsauce.css'];
    for (const name of safeNames) {
      assert.ok(
        !SENSITIVE_FILE_BASENAME_PATTERNS.some((p) => p.test(name)),
        `expected ${name} to stay off the denylist`,
      );
    }
    // A hyphen is a word boundary, so a hyphenated "token" prefix IS caught — documented,
    // deliberate conservatism on the basename denylist.
    assert.ok(SENSITIVE_FILE_BASENAME_PATTERNS.some((p) => p.test('token-bucket.test.mjs')));
  });
});
