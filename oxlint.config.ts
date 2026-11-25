import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: {
    ...core.env,
    node: true,
  },
  extends: [core, antiSlop],
  ignorePatterns: core.ignorePatterns,
  options: { typeAware: true },
  rules: {
    // Node 22+ native TypeScript execution requires explicit file extensions on relative imports.
    "import/extensions": [
      "error",
      "always",
      { checkTypeImports: true, ignorePackages: true },
    ],
  },
  overrides: [
    {
      files: ["tests/**/*.ts"],
      rules: {
        // The Node test runner owns the promises returned by test registration.
        "typescript/no-floating-promises": [
          "error",
          {
            allowForKnownSafeCalls: [
              {
                from: "package",
                name: ["test", "it", "suite", "describe"],
                package: "@types/node",
              },
            ],
          },
        ],
      },
    },
  ],
});
