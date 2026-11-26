import assert from "node:assert/strict";
import { test } from "node:test";

import { lintCitations } from "../../../skills/dispatch/scripts/toolkit/domain/citations.ts";
import { defined } from "../../helpers/guards.ts";

const repoReader =
  (files: Record<string, string | null>) => (relPath: string) => {
    const normalized = relPath.startsWith("./") ? relPath.slice(2) : relPath;

    if (Object.hasOwn(files, relPath)) {
      return defined(files[relPath]);
    }

    return Object.hasOwn(files, normalized) ? defined(files[normalized]) : null;
  };

test("lintCitations validates governed line references", () => {
  const baseFiles = {
    "src/app.ts": "line1\nline2\nline3\n",
    "src/empty.ts": "",
    "src/single-nl.ts": "\n",
    "src/two-lines.ts": "first\nsecond\n",
    LICENSE: "MIT\n",
    configure: "#!/bin/sh\n",
    customroot: "hello\n",
    "docs/Project Guide.md": "a\nb\nc\n",
    "docs/R&D Guide.md": "x\ny\n",
    "docs/Project - Guide.md": "p\nq\n",
  };

  const validPlan = [
    "# Plan",
    "",
    "> [!NOTE] See `src/app.ts:1-3` and `LICENSE:1` and `./configure:1` and `customroot:1` and `docs/Project Guide.md:1` and `docs/Project Guide.md:1-3`.",
    "> **Parent:** `src/two-lines.ts:2`",
    "",
    "Planned bare files: `src/future-module.ts` and `docs/guide.md`.",
    "Non-path tokens: `HTTP:443`, `T1:12`, `api.example.com:443`, `localhost:8080`, `127.0.0.1:8080`.",
    "URLs, commands, and digests: `http://localhost:8080`, `https://example.com:443`, `https://example.com/a.ts:10`, `curl -sf http://127.0.0.1:8080`, `curl http://localhost:3000`, `code src/app.ts:12`, `./server --listen localhost:8080`, `./server localhost:8080`, `scripts/check.sh --only src/app.ts:12`, `sha256:1234`.",
    "```npm test``` gates the merge.",
    "Single newline EOF boundary: `src/single-nl.ts:1`.",
    "",
    "```ts",
    "// `src/does-not-exist.ts:1`",
    "> `cli.ts:126`",
    "```",
    "",
    "~~~markdown",
    "`../escape.ts:1`",
    "~~~",
    "",
    "- Indented list code block:",
    "    ````ts",
    "    ```",
    "    // `src/missing.ts:1`",
    "    ````",
    "",
    "> ```ts",
    "> `src/quoted-fence-missing.ts:5`",
    "> ```",
    "",
    "> - ```ts",
    ">   // `src/missing.ts:1`",
    ">   ```",
    "",
    "<!-- `src/top-comment-missing.ts:1` -->",
    "> <!--",
    "> `src/quoted-comment-missing.ts:1`",
    "> -->",
    "",
    "## Review Findings & Resolutions",
    "Historical stale ref `src/removed-in-history.ts:99` is ignored here.",
  ].join("\n");

  assert.deepEqual(lintCitations(validPlan, "plan", repoReader(baseFiles)), []);

  const listFenceDoc = [
    "- ```ts",
    "  // `src/missing.ts:1`",
    "  ```",
    "",
    "- > ```ts",
    "  > // `src/missing.ts:1`",
    "  > ```",
    "",
    "- item",
    "  ```md",
    "  > **Parent:** `src/planned.ts:1`",
    "  ```",
    "",
    "Live `src/missing.ts:1`.",
  ].join("\n");

  assert.deepEqual(
    lintCitations(listFenceDoc, "plan", repoReader(baseFiles)).map((d) => ({
      line: d.line,
      code: d.code,
    })),
    [{ line: 14, code: "broken-citation" }]
  );

  const boundaryPlan = [
    "Empty file fail: `src/empty.ts:1`.",
    "Single-nl fail: `src/single-nl.ts:2`.",
    "Two-lines fail: `src/two-lines.ts:3`.",
  ].join("\n");

  const boundaryDefects = lintCitations(
    boundaryPlan,
    "plan",
    repoReader(baseFiles)
  );

  assert.deepEqual(
    boundaryDefects.map((d) => ({
      code: d.code,
      severity: d.severity,
      line: d.line,
    })),
    [
      { code: "broken-citation", severity: "defect", line: 1 },
      { code: "broken-citation", severity: "defect", line: 2 },
      { code: "broken-citation", severity: "defect", line: 3 },
    ]
  );

  const invalidRefsPlan = [
    "Missing: `src/missing.ts:1`.",
    "Escape: `../secret.ts:1` and `/etc/passwd:1`.",
    "Inverted: `src/app.ts:3-1` and `src/app.ts:0`.",
    "Ambiguous short: `cli.ts:126`.",
    "Out-of-range root: `LICENSE:9999`.",
    "Removed well-known root: `LICENSE:1`.",
    "Removed custom root via dot-slash: `./configure:1`.",
    "Missing spaced path: `docs/Missing Guide.md:1`.",
    "Out-of-range spaced path: `docs/Project Guide.md:99`.",
    "    ```ts",
    "Broken after top-level 4-space indented non-fence: `src/missing.ts:1`.",
    "Out-of-range R&D path: `docs/R&D Guide.md:999`.",
    "Out-of-range hyphenated spaced path: `docs/Project - Guide.md:999`.",
    "Missing R&D path: `docs/Missing R&D.md:1`.",
    "Missing hyphenated spaced path: `docs/Missing - Guide.md:1`.",
    "Missing extensionless spaced path: `docs/Project Guide:1`.",
  ].join("\n");

  const removedFiles = Object.fromEntries(
    Object.entries(baseFiles).filter(
      ([key]) => key !== "LICENSE" && key !== "configure"
    )
  );

  const invalidDefects = lintCitations(
    invalidRefsPlan,
    "plan",
    repoReader(removedFiles)
  );

  assert.deepEqual(
    invalidDefects.map((d) => d.line),
    [1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16]
  );
  assert.ok(
    invalidDefects.every(
      (d) => d.code === "broken-citation" && d.severity === "defect"
    )
  );

  const designWithSkipped = [
    "# Design",
    "## At a Glance",
    "Valid `src/app.ts:1`.",
    "## Execution Status",
    "```markdown",
    "## Example",
    "## main...origin/main",
    "Stale fenced ref inside status: `src/status-fenced.ts:10`.",
    "```",
    "Stale inside status `src/status-only.ts:10`.",
    "More status `LICENSE:9999`.",
    "## Approach",
    "> [!NOTE] Broken in visible blockquote: `src/broken-after-status.ts:4`.",
    "## Review Findings & Resolutions",
    "```md",
    "## Resolution Example",
    "Stale fenced ref inside resolutions: `src/res-fenced.ts:10`.",
    "```",
    "- ```md",
    "  ## Fake",
    "  ```",
    "Ignored resolution `src/old.ts:99`.",
    "## Final Integration",
    "Broken after resolutions: `src/broken-after-resolutions.ts:2`.",
  ].join("\n");

  const designDefects = lintCitations(
    designWithSkipped,
    "design",
    repoReader(baseFiles)
  );

  assert.deepEqual(
    designDefects.map((d) => ({ line: d.line, code: d.code })),
    [
      { line: 13, code: "broken-citation" },
      { line: 24, code: "broken-citation" },
    ]
  );

  const planWithSkipped = [
    "# Plan",
    "## Execution Status",
    "Broken status in plan: `src/broken-status.ts:1`.",
    "## Review Findings & Resolutions",
    "Ignored resolution `src/old.ts:99`.",
    "## Proposed Changes",
    "Broken after resolutions: `src/broken-plan.ts:7`.",
  ].join("\n");

  const planDefects = lintCitations(
    planWithSkipped,
    "plan",
    repoReader(baseFiles)
  );

  assert.deepEqual(
    planDefects.map((d) => d.line),
    [3, 7]
  );
});
