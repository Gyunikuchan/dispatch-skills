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
