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
    // Parser layer: unknown enters at I/O boundaries; strict tsc forces narrowing before use.
    "anti-slop/no-unknown-parameters": "off",
    // Same boundary rationale: parse results legitimately start as unknown.
    "anti-slop/no-unknown-returns": "off",
    // typeof is the standard narrowing mechanism; banning it forces redesign for no safety gain.
    "anti-slop/no-runtime-typeof": "off",
    // Shape-guard vocabulary (isRecord) is this repo's core idiom, not slop.
    "anti-slop/no-shape-in-symbol-names": "off",
    // Arrow-only enforcement would rewrite every module; function declarations are the repo convention.
    "func-style": "off",
    "import/extensions": [
      "error",
      "always",
      { checkTypeImports: true, ignorePackages: true },
    ],
    // Centralized tests/ layout (AGENTS.md test layers) contradicts beside-implementation placement.
    "landmines-structure/colocated-tests": "off",
    // Rule does not recognize tests/ as a test directory; renaming it has zero value.
    "landmines-structure/test-file-names": "off",
    // Comment conventions (SECTION/NOTE/TODO) are owned by AGENTS.md, outside the rule's allow-list.
    "landmines-style/no-comments": "off",
    // Annotations pin inference; removal widened types and broke never-narrowing tree-wide.
    "landmines-types/no-explicit-return-types": "off",
    // AGENTS.md owns active TODO/FIXME markers; keep rejecting XXX and @todo.
    "no-warning-comments": [
      "error",
      { decoration: ["*"], terms: ["xxx", "@todo"] },
    ],
    // Spread-first pressure conflicts with typescript/no-misused-spread on string iteration; the safety rule wins.
    "prefer-spread": "off",
    // Contradicts unicorn/new-for-builtins on Array(n); explicit new wins.
    "unicorn/no-new-array": "off",
    // Same pair conflict as prefer-spread (suggests [...str], which typescript/no-misused-spread flags); the safety rule wins.
    "unicorn/prefer-spread": "off",
  },
});
