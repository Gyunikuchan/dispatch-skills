import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import landmines from "ultracite/oxlint/landmines";

export default defineConfig({
  env: {
    ...core.env,
    node: true,
  },
  extends: [core, antiSlop, landmines],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: landmines.jsPlugins,
  options: { typeAware: true },
  overrides: [
    {
      files: ["tests/**/*.ts"],
      rules: {
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
  rules: {
    "import/extensions": [
      "error",
      "always",
      { checkTypeImports: true, ignorePackages: true },
    ],
    "landmines-structure/colocated-tests": "off",
    "landmines-structure/test-file-names": "off",
  },
});
