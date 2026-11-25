import cloudflare from '@cloudflare/oxlint-config';
import landmines from '@interfere/landmines/configs/recommended.json' with { type: 'json' };
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [cloudflare, landmines],
  env: cloudflare.env,
  ignorePatterns: cloudflare.ignorePatterns,
  options: { typeAware: true },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        // These tests exercise fresh CLI or Git invocations and process ownership.
        'landmines/no-cold-start-in-test': [
          'error',
          {
            allow: {
              'tests/e2e/audit-probe.test.ts': 4,
              'tests/e2e/opencode-lifecycle.test.ts': 5,
              'tests/e2e/toolkit-deliver.test.ts': 8,
              'tests/e2e/toolkit-diagnostics.test.ts': 1,
              'tests/e2e/toolkit-fix-review-lite.test.ts': 5,
              'tests/e2e/toolkit-flow.test.ts': 4,
              'tests/e2e/toolkit-input.test.ts': 34,
              'tests/e2e/toolkit-output-cap.test.ts': 2,
              'tests/e2e/toolkit-review.test.ts': 7,
              // The unit-test guard rejects this attempted launch before it starts.
              'tests/tooling/helpers.test.ts': 1,
            },
          },
        ],
        // The Node test runner owns the promises returned by test registration.
        'typescript/no-floating-promises': [
          'error',
          {
            allowForKnownSafeCalls: [
              { from: 'package', package: '@types/node', name: ['test', 'it', 'suite', 'describe'] },
            ],
          },
        ],
      },
    },
  ],
});
