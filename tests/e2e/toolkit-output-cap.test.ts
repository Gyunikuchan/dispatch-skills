import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { isRecord } from "../../skills/dispatch/scripts/lib/config.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import { stripGeneratedMarkers } from "../../skills/dispatch/scripts/toolkit/contracts.ts";
import {
  arrayOf,
  defined,
  isNumber,
  isString,
  maybe,
  narrow,
  objectWith,
  text,
} from "./helpers/json.ts";
import { toolkitRepo, planSource } from "./helpers/toolkit-repo.ts";

describe("summary byte cap", () => {
  test("preserves all conflict paths exceeding the summary cap in the result file", async () => {
    const paths = Array.from(
      { length: 60 },
      (_, i) => `src/conflict-${String(i).padStart(3, "0")}.ts`
    );

    const source = planSource
      .replace(
        "#### [MODIFY] src/file.ts\n- Purpose: implements behavior.",
        paths.map((p) => `#### [MODIFY] ${p}\n- Purpose: conflict.`).join("\n")
      )
      .replace("  - Changes: src/file.ts", `  - Changes: ${paths.join(", ")}`);

    const f = await toolkitRepo(
      source,
      Object.fromEntries(paths.map((p) => [p, "base\n"]))
    );

    try {
      await f.level();

      const created = await f.run(["worktree", "create", "T1"]);

      assert.equal(created.exit, 0, JSON.stringify(created));

      const { path: wtPath } = narrow(
        created.value,
        objectWith({ path: isString })
      );

      for (const p of paths) {
        fs.writeFileSync(path.resolve(f.session, wtPath, p), "writer\n");
        fs.writeFileSync(path.join(f.integration, p), "integration\n");
      }

      const submitted = await f.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const committed = await f.run([
        "worktree",
        "commit",
        "--reason",
        "conflict",
      ]);

      assert.equal(committed.exit, 0);

      const result = await f.concurrent(["worktree", "integrate", "T1"]);

      assert.equal(result.exit, 0);
      assert.equal(result.output.reason, "conflict");
      assert.deepEqual(
        narrow(
          result.value,
          objectWith({ paths: arrayOf(isString) })
        ).paths.toSorted(),
        paths.toSorted()
      );
    } finally {
      f.cleanup();
    }
  });

  test("keeps concurrent append results distinct and complete", async () => {
    const f = await toolkitRepo();

    try {
      const files = ["first", "second"].map((name) => {
        const file = path.join(f.session, `${name}.json`);

        fs.writeFileSync(
          file,
          JSON.stringify({
            kind: "note",
            by: "tool",
            key: name,
            data: { text: name },
          })
        );

        return file;
      });

      const results = await Promise.all(
        files.map(
          async (file) => await f.concurrent(["ledger", "append", file])
        )
      );

      assert.deepEqual(
        results.map((r) => r.exit),
        [0, 0]
      );
      assert.notEqual(
        defined(results[0]).output.path,
        defined(results[1]).output.path
      );

      const rows = fs
        .readFileSync(path.join(f.session, "ledger.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) =>
          narrow(
            parseJson(line),
            objectWith({ seq: isNumber, data: maybe(isRecord) })
          )
        );

      assert.deepEqual(
        results.map(
          (r) =>
            rows.find(
              (row) =>
                row.seq === narrow(r.value, objectWith({ seq: isNumber })).seq
            )?.data?.["text"]
        ),
        ["first", "second"]
      );
    } finally {
      f.cleanup();
    }
  });

  test("preserves all large verify checks and their command output", async () => {
    const criteria = Array.from(
      { length: 5 },
      (_, i) =>
        `- [SC${i + 1}] Works\n  - Changes: src/file.ts\n  - Check: \`node -e "process.stdout.write('x'.repeat(200000))"\`\n  - Evidence: check`
    ).join("\n");

    const source = planSource
      .replace(
        "| none | SC1 |",
        `| none | ${Array.from({ length: 5 }, (_, i) => `SC${i + 1}`).join(", ")} |`
      )
      .replace(
        /## Success Criteria[\s\S]*?## Verification Plan/u,
        `## Success Criteria\n${criteria}\n\n## Verification Plan`
      );

    const f = await toolkitRepo(source);

    try {
      const r = await f.concurrent(["check", "run"]);

      assert.equal(r.exit, 0, JSON.stringify(r));
      assert.equal(r.output.ok, true, JSON.stringify(r));

      const { checks } = narrow(
        r.value,
        objectWith({
          checks: arrayOf(
            objectWith({ criterion: isString, logPath: maybe(isString) })
          ),
        })
      );

      assert.equal(checks.length, 6);

      for (const check of checks.filter((c) => c.criterion !== "contract")) {
        assert.ok(fs.statSync(text(defined(check.logPath))).size >= 200_000);
      }
    } finally {
      f.cleanup();
    }
  });
});

describe("help command", () => {
  test("prints the raw section from a real process without a session and writes nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "help-"));
    const entry = path.resolve("skills/dispatch/scripts/dispatch.ts");

    const {
      NODE_OPTIONS: _dropNodeOptions,
      NODE_TEST_CONTEXT: _dropTestContext,
      ...env
    } = process.env;

    try {
      const ok = spawnSync(process.execPath, [entry, "help", "lint", "run"], {
        cwd: dir,
        env,
        encoding: "utf-8",
      });

      const doc = stripGeneratedMarkers(
        fs.readFileSync(
          path.resolve("skills/dispatch/references/toolkit.md"),
          "utf-8"
        )
      ).replaceAll("\r\n", "\n");

      const afterMarker = defined(doc.split("\n### lint run\n")[1]);
      const firstSection = defined(afterMarker.split(/\n#{1,3} /u)[0]);
      const expected = `${`### lint run\n${firstSection}`.trimEnd()}\n`;

      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(ok.stdout, expected);
      assert.doesNotMatch(ok.stdout, /<!-- (?:END )?GENERATED:/u);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs with empty stderr for each host module type", () => {
    const hosts = [
      { name: "typeless", manifest: { name: "host" } },
      { name: "commonjs", manifest: { name: "host", type: "commonjs" } },
    ] as const;

    for (const host of hosts) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-"));

      try {
        fs.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify(host.manifest)
        );
        fs.cpSync(path.resolve("skills/dispatch"), path.join(dir, "dispatch"), {
          recursive: true,
        });

        const entry = path.join(dir, "dispatch", "scripts", "dispatch.ts");

        const {
          NODE_OPTIONS: _dropNodeOptions,
          NODE_TEST_CONTEXT: _dropTestContext,
          ...env
        } = process.env;

        const result = spawnSync(
          process.execPath,
          [entry, "help", "call", "table"],
          {
            cwd: dir,
            env,
            encoding: "utf-8",
          }
        );

        assert.equal(result.status, 0, `${host.name} stderr: ${result.stderr}`);
        assert.equal(result.stderr, "", host.name);
        assert.ok(result.stdout.startsWith("### call table"), host.name);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
