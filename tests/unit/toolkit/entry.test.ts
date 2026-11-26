import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  isEntry,
  main as entryMain,
} from "../../../skills/dispatch/scripts/dispatch.ts";
import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import type { DelegateRequest } from "../../../skills/dispatch/scripts/providers/types.ts";
import {
  main as toolkitMain,
  TOOL_ACTIONS,
} from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  CALL_TABLE_MAX_BYTES,
  SESSION_CONTRACTS,
  renderCallTable,
  stripGeneratedMarkers,
} from "../../../skills/dispatch/scripts/toolkit/contracts.ts";
import { KINDS } from "../../../skills/dispatch/scripts/toolkit/records.ts";
import { defined } from "../../helpers/guards.ts";
import { narrow, optional, withFields, text } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

test("dispatch entry routes sessions and toolkit operations with bounded output", async () => {
  const f = sessionFixture();
  fs.mkdirSync(path.join(f.root, ".git"));
  const deps = { ...f.deps, cwd: () => f.root };

  const invoke = async (args: string[]) => {
    f.lines.length = 0;
    const exit = await entryMain(args, deps);

    return { exit, ...f.output() };
  };

  try {
    const created = await invoke([
      "session",
      "init",
      "--objective",
      "界".repeat(2000),
      "--host",
      "claude",
    ]);

    assert.equal(created.exit, 0);
    assert.equal(created.ok, true);
    assert.ok((created.path ?? "").length > 0);
    assert.match(
      readManifest(defined(created.path)).sessionId,
      /^[0-9a-f-]{36}$/u
    );
    assert.ok(Buffer.byteLength(created.summary) <= 1024);

    const active = await invoke([
      "session",
      "reactivate",
      "--session-dir",
      defined(created.path),
      "--host",
      "claude",
    ]);

    assert.equal(active.exit, 0);
    assert.equal(active.path, created.path);
    assert.ok(Buffer.byteLength(active.summary) <= 1024);

    const status = await invoke([
      "status",
      "show",
      "--session",
      defined(created.path),
    ]);

    assert.equal(status.exit, 0);
    assert.ok(
      (status.path ?? "").length > 0 && fs.existsSync(defined(status.path))
    );

    f.lines.length = 0;

    const quota = await entryMain(
      [
        "session",
        "quota-reprobe",
        "--session-dir",
        defined(created.path),
        "--provider",
        "codex",
        "--mode",
        "cli",
      ],
      deps
    );

    assert.equal(quota, 0);
    assert.deepEqual(JSON.parse(defined(f.lines[0])), {
      v: 1,
      action: "quota-reprobe",
      key: { provider: "codex", model: null, mode: "cli" },
      appliesTo: "future-waves",
    });

    for (const args of [
      ["start", "plan"],
      ["send", "--run", "x"],
      ["checkpoint"],
      [
        "session",
        "quota-reprobe",
        "--session-dir",
        defined(created.path),
        "--provider",
        "unknown",
        "--mode",
        "cli",
      ],
      ["session", "init", "--unknown", "界".repeat(2000), "--host", "claude"],
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const invalid = await invoke(defined(args));
      assert.equal(invalid.exit, 1);
      assert.equal(invalid.reason, "usage");
      assert.ok(Buffer.byteLength(invalid.summary) <= 1024);
    }

    const broken = await invoke([
      "session",
      "reactivate",
      "--session-dir",
      path.join(f.root, "界".repeat(2000)),
      "--host",
      "claude",
    ]);

    assert.equal(broken.exit, 2);
    assert.equal(broken.reason, "fault");
    assert.ok(Buffer.byteLength(broken.summary) <= 1024);

    const explicit = await invoke([
      "session",
      "init",
      "--objective",
      "Explicit",
      "--session-id",
      "chosen",
      "--host",
      "claude",
    ]);

    assert.equal(readManifest(defined(explicit.path)).sessionId, "chosen");

    const quotaArgs = [
      "session",
      "quota-reprobe",
      "--session-dir",
      defined(explicit.path),
      "--provider",
      "codex",
      "--mode",
      "cli",
    ];

    fs.writeFileSync(
      path.join(defined(explicit.path), ".state"),
      "blocks quota directory creation"
    );
    f.lines.length = 0;
    assert.equal(await entryMain(quotaArgs, deps), 2);
    const fault = f.output();
    assert.equal(fault.reason, "fault");
    assert.equal(fault.path, null);
    assert.match(fault.summary, /ENOTDIR/u);
    fs.unlinkSync(path.join(defined(explicit.path), ".state"));

    const manifestPath = path.join(defined(explicit.path), "manifest.json");
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, repositoryRoot: "another-repository" })
    );
    f.lines.length = 0;
    assert.equal(await entryMain(quotaArgs, deps), 1);
    assert.equal(f.output().reason, "usage");
  } finally {
    f.cleanup();
  }
});

test("session actions record the declared host, replace it and refuse a missing or unknown host", async () => {
  const f = sessionFixture();
  fs.mkdirSync(path.join(f.root, ".git"));
  const deps = { ...f.deps, cwd: () => f.root };

  const invoke = async (args: string[]) => {
    f.lines.length = 0;
    const exit = await entryMain(args, deps);

    return { exit, ...f.output() };
  };

  try {
    const created = await invoke([
      "session",
      "init",
      "--objective",
      "Host",
      "--session-id",
      "declared",
      "--host",
      "github-copilot",
    ]);

    assert.equal(created.exit, 0);
    assert.equal(readManifest(defined(created.path)).host, "copilot");

    const reused = await invoke([
      "session",
      "init",
      "--objective",
      "Host",
      "--session-id",
      "declared",
      "--host",
      "codex",
    ]);

    assert.equal(reused.path, created.path);
    assert.equal(readManifest(defined(created.path)).host, "codex");

    const switched = await invoke([
      "session",
      "reactivate",
      "--session-dir",
      defined(created.path),
      "--host",
      "claude",
    ]);

    assert.equal(switched.exit, 0);
    assert.equal(readManifest(defined(created.path)).host, "claude");

    const before = fs.readFileSync(
      path.join(defined(created.path), "manifest.json"),
      "utf-8"
    );

    for (const args of [
      ["session", "init", "--objective", "Host", "--session-id", "declared"],
      [
        "session",
        "init",
        "--objective",
        "Host",
        "--session-id",
        "declared",
        "--host",
        "unknown-x",
      ],
      ["session", "reactivate", "--session-dir", defined(created.path)],
      [
        "session",
        "reactivate",
        "--session-dir",
        defined(created.path),
        "--host",
        "unknown-x",
      ],
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const refused = await invoke(args);
      assert.equal(refused.exit, 1, args.join(" "));
      assert.equal(refused.reason, "usage", args.join(" "));

      if (args.includes("unknown-x")) {
        assert.match(refused.summary, /claude, agy, copilot, opencode, codex/u);
      }
    }

    assert.equal(
      fs.readFileSync(
        path.join(defined(created.path), "manifest.json"),
        "utf-8"
      ),
      before
    );
  } finally {
    f.cleanup();
  }
});

test("ambiguous session identity exposes choices without changing retained work", async () => {
  const f = sessionFixture();

  try {
    fs.mkdirSync(path.join(f.root, ".git"));

    const deps = {
      ...f.deps,
      env: { CODEX_THREAD_ID: "test" },
      cwd: () => f.root,
    };

    const init = [
      "session",
      "init",
      "--objective",
      "Resume work",
      "--host",
      "codex",
    ];

    assert.equal(await entryMain(init, deps), 0);
    assert.equal(f.output().path, f.session);
    f.lines.length = 0;

    const root = path.dirname(f.session);
    const manifest = readManifest(f.session);
    const other = path.join(root, "20261022T0000Z-earlier");
    fs.mkdirSync(other);
    fs.writeFileSync(
      path.join(other, "manifest.json"),
      JSON.stringify({ ...manifest, folderName: path.basename(other) })
    );

    const files = [f.session, other].flatMap((dir) => {
      const ledger = path.join(dir, "ledger.jsonl");
      fs.writeFileSync(ledger, "retained evidence\n");

      return [path.join(dir, "manifest.json"), ledger];
    });

    const before = files.map((file) => fs.readFileSync(file, "utf-8"));
    const entries = fs.readdirSync(root).toSorted();

    assert.equal(await entryMain(init, deps), 2);
    assert.deepEqual(fs.readdirSync(root).toSorted(), entries);
    assert.deepEqual(
      files.map((file) => fs.readFileSync(file, "utf-8")),
      before
    );

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    const failure = f.output() as ReturnType<typeof f.output> & {
      help?: string;
      candidates?: string[];
      candidateCount?: number;
      omitted?: number;
    };

    assert.equal(failure.ok, false);
    assert.equal(failure.reason, "fault");
    assert.equal(failure.path, null);
    assert.equal(failure.help, "session reactivate");
    assert.deepEqual(failure.candidates, [
      path.basename(other),
      path.basename(f.session),
    ]);
    assert.equal(failure.candidateCount, 2);
    assert.equal(failure.omitted, 0);

    f.lines.length = 0;
    const freshHost = { ...deps, env: { CODEX_THREAD_ID: "fresh" } };
    assert.equal(
      await entryMain(
        ["session", "reactivate", "--session-dir", other, "--host", "codex"],
        freshHost
      ),
      0
    );
    assert.equal(f.output().path, other);
    assert.equal(readManifest(other).sessionId, "test");
  } finally {
    f.cleanup();
  }
});

test("dispatch entry recognizes symlinked launch paths", () => {
  assert.equal(
    isEntry(
      "/linked/dispatch.ts",
      () => path.resolve("actual/dispatch.ts"),
      pathToFileURL(path.resolve("actual/dispatch.ts")).href
    ),
    true
  );
  assert.equal(
    isEntry("/other.ts", () => "/other.ts", "file:///actual/dispatch.ts"),
    false
  );
  assert.equal(
    isEntry(undefined, () => {
      throw new Error("unused");
    }),
    false
  );
});

test("session instructions always point at grounding and add diagnostics only when enabled", async () => {
  const f = sessionFixture();

  try {
    fs.mkdirSync(path.join(f.root, ".git"));
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    const deps = { ...f.deps, skillRoot: skill, cwd: () => f.root };

    const assertInstructions = (
      value: { instructions?: unknown },
      enabled: boolean
    ) => {
      const { instructions } = value;

      if (typeof instructions !== "string") {
        assert.fail("Session instructions must be present");
      }

      assert.match(
        instructions,
        /When a verb needs a new spec, run `doctor run --host <platform>` and ground under references\/grounding\.md before authoring the spec; after confirming it, ground again before design or plan authoring\. Launch explorers on doctor's `utility` entry for this platform; self-ground only when the host has no launch tool or no map survives recovery\./u
      );
      assert.doesNotMatch(
        instructions,
        /Launch explorers only when doctor reports one/u
      );

      if (enabled) {
        assert.match(
          instructions,
          /references\/diagnostics\.md.*diagnostics render/u
        );
      } else {
        assert.doesNotMatch(instructions, /references\/diagnostics\.md/u);
      }

      assert.ok(!instructions.includes(f.root));
      assert.ok(Buffer.byteLength(instructions) <= 2048);
    };

    fs.writeFileSync(
      path.join(skill, "config.jsonc"),
      JSON.stringify({ diagnostics: false })
    );
    assert.equal(
      await entryMain(
        ["session", "init", "--objective", "test-disabled", "--host", "claude"],
        deps
      ),
      0
    );
    // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
    assertInstructions(JSON.parse(defined(f.lines[0])), false);
    f.lines.length = 0;
    fs.writeFileSync(
      path.join(skill, "config.jsonc"),
      JSON.stringify({ diagnostics: true })
    );
    assert.equal(
      await entryMain(
        ["session", "init", "--objective", "test-enabled", "--host", "claude"],
        deps
      ),
      0
    );
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const enabledVal = JSON.parse(defined(f.lines[0]));
    // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
    assertInstructions(enabledVal, true);
    f.lines.length = 0;
    assert.equal(
      await entryMain(
        [
          "session",
          "reactivate",
          "--session-dir",
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          enabledVal.path,
          "--host",
          "claude",
        ],
        deps
      ),
      0
    );
    // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
    assertInstructions(JSON.parse(defined(f.lines[0])), true);
  } finally {
    f.cleanup();
  }
});

test("disabled diagnostics add neither lifecycle collection requests nor capture artifacts for OpenCode", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(
      path.join(skill, "config.jsonc"),
      JSON.stringify({ diagnostics: false })
    );
    f.deps.skillRoot = skill;
    const requests: DelegateRequest[] = [];
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (provider, request, mode) => {
      requests.push(request);

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: "answer",
          sessionId: null,
          resume: null,
        },
        invocations: [
          {
            provider,
            model: null,
            mode,
            effort: null,
            launched: true,
            outcome: "ok",
          },
        ],
      });
    };

    f.deps.handler = async ({ deps }) => {
      await deps.delegate(
        "opencode",
        {
          promptPath: path.join(f.session, "logs", "opencode[0].prompt.md"),
          model: null,
          effort: null,
          sandbox: true,
          schemaPath: null,
          resume: null,
          cwd: f.root,
          timeoutMs: 1000,
          outputCapBytes: 1024,
          attachments: [],
          logPath: path.join(f.session, "logs", "opencode[0].log"),
          briefPath: path.join(f.session, "logs", "opencode[0].brief.md"),
        },
        "cli"
      );

      return { ok: true, exit: 0, summary: "done", value: null };
    };

    assert.equal(
      await toolkitMain(
        ["ask", "run", "--session", f.session, "--host", "opencode"],
        f.deps
      ),
      0
    );
    assert.deepEqual(
      requests.map((r) => [r.collectUsage, r.collectLifecycle]),
      [[undefined, undefined]]
    );
    assert.equal(
      fs.existsSync(path.join(f.session, ".state", "diagnostics")),
      false
    );
  } finally {
    f.cleanup();
  }
});

const toolkitText = stripGeneratedMarkers(
  fs.readFileSync(
    path.resolve("skills/dispatch/references/toolkit.md"),
    "utf-8"
  )
).replaceAll("\r\n", "\n");

const sectionOf = (heading: string) => {
  const escaped = heading.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const match = new RegExp(`^(#{2,3}) ${escaped}$`, "mu").exec(toolkitText);

  if (!match) {
    throw new Error(`Missing toolkit heading: ${heading}`);
  }

  return `${defined(
    toolkitText
      .slice(match.index)
      .split(new RegExp(`\\n#{1,${defined(match[1]).length}} `, "u"))[0]
  ).trimEnd()}\n`;
};

const slugOf = (heading: string) =>
  heading
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

const markdownFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return markdownFiles(path.join(dir, entry.name));
    }

    return entry.name.endsWith(".md") ? [path.join(dir, entry.name)] : [];
  });

test("help prints exactly one section for each action, record kind, session command and the call table", async () => {
  const f = sessionFixture();

  try {
    const headings = [...toolkitText.matchAll(/^### (?<g1>.+)$/gmu)].map((m) =>
      defined(m[1])
    );

    assert.ok(headings.length >= 43);

    for (const heading of [
      ...TOOL_ACTIONS,
      ...KINDS,
      ...Object.keys(SESSION_CONTRACTS).map((action) => `session ${action}`),
      "call table",
    ]) {
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await entryMain(["help", ...heading.split(" ")], f.deps),
        0,
        heading
      );
      assert.equal(f.lines.length, 1);
      assert.doesNotMatch(defined(f.lines[0]), /<!-- (?:END )?GENERATED:/u);
      assert.equal(
        f.lines[0],
        heading === "call table" ? renderCallTable() : sectionOf(heading),
        heading
      );

      if (heading === "call table") {
        assert.ok(
          Buffer.byteLength(f.lines[0], "utf-8") <= CALL_TABLE_MAX_BYTES
        );
      }
    }
  } finally {
    f.cleanup();
  }
});

test("help prints each toolkit section linked from skill prose and nested subsections of a level-2 section", async () => {
  const headingsByAnchor = new Map(
    [...toolkitText.matchAll(/^(?<g2>#{2,3}) (?<g3>.+)$/gmu)].map((m) => [
      slugOf(defined(m[2])),
      defined(m[2]),
    ])
  );

  const anchors = new Set<string>();

  for (const file of [
    path.resolve("skills/dispatch/SKILL.md"),
    ...markdownFiles(path.resolve("skills/dispatch/references")),
  ]) {
    for (const match of fs
      .readFileSync(file, "utf-8")
      .matchAll(/toolkit\.md#(?<g4>[a-z0-9-]+)/giu)) {
      anchors.add(defined(match[1]));
    }
  }

  assert.ok(anchors.size > 0);
  assert.ok(anchors.has("session-commands"));
  const f = sessionFixture();

  try {
    for (const anchor of anchors) {
      const heading = headingsByAnchor.get(anchor);
      assert.ok((heading ?? "").length > 0, anchor);
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await entryMain(["help", ...defined(heading).split(" ")], f.deps),
        0,
        anchor
      );
      assert.equal(f.lines.length, 1);
      assert.equal(f.lines[0], sectionOf(defined(heading)), anchor);

      if (anchor === "session-commands") {
        for (const sub of Object.keys(SESSION_CONTRACTS).map(
          (action) => `### session ${action}`
        )) {
          assert.ok(f.lines[0].includes(sub), sub);
        }
      }
    }
  } finally {
    f.cleanup();
  }
});

test("help resolves headings regardless of letter case and trailing flags", async () => {
  const f = sessionFixture();

  try {
    const cases: [string[], string][] = [
      [["native-slot", "replies"], "Native-slot replies"],
      [["LEDGER", "APPEND"], "ledger append"],
      [["ledger", "append", "--session", "x"], "ledger append"],
      [["native-slot", "replies", "--json"], "Native-slot replies"],
    ];

    for (const [args, heading] of cases) {
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await entryMain(["help", ...args], f.deps),
        0,
        args.join(" ")
      );
      assert.equal(f.lines.length, 1);
      assert.equal(f.lines[0], sectionOf(heading), args.join(" "));
    }
  } finally {
    f.cleanup();
  }
});

test("help refuses an unknown or empty heading with the valid headings inside the summary cap", async () => {
  const f = sessionFixture();

  try {
    for (const args of [
      ["help"],
      ["help", "no", "such", "heading"],
      ["help", "Toolkit", "CLI", "contract"],
    ]) {
      f.lines.length = 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      assert.equal(await entryMain(args, f.deps), 1);
      const out = f.output();
      assert.equal(out.ok, false);
      assert.equal(out.reason, "usage");
      assert.equal(out.path, null);
      assert.ok(Buffer.byteLength(out.summary) <= 1024);
      assert.match(
        out.summary,
        /Index, call table, Tool actions.*Native-slot replies, Session commands.*session quota-reprobe/u
      );
    }
  } finally {
    f.cleanup();
  }
});

test("help refuses an unreadable toolkit contract as a fault", async () => {
  const f = sessionFixture();

  try {
    assert.equal(
      await entryMain(["help", "doctor", "run"], {
        ...f.deps,
        skillRoot: path.join(f.root, "missing"),
      }),
      2
    );
    const out = f.output();
    assert.equal(out.reason, "fault");
    assert.equal(out.path, null);
  } finally {
    f.cleanup();
  }
});

test("session refusals name the section to read", async () => {
  const f = sessionFixture();
  fs.mkdirSync(path.join(f.root, ".git"));
  const deps = { ...f.deps, cwd: () => f.root };

  try {
    const cases: [string[], number, string][] = [
      [
        ["session", "init", "--unknown", "x", "--host", "claude"],
        1,
        "session init",
      ],
      [
        [
          "session",
          "reactivate",
          "--session-dir",
          path.join(f.root, "missing"),
          "--host",
          "claude",
        ],
        2,
        "session reactivate",
      ],
      [
        [
          "session",
          "quota-reprobe",
          "--session-dir",
          f.session,
          "--provider",
          "unknown",
          "--mode",
          "cli",
        ],
        1,
        "session quota-reprobe",
      ],
      [["session", "bogus"], 1, "call table"],
    ];

    for (const [args, exit, help] of cases) {
      f.lines.length = 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      assert.equal(await entryMain(args, deps), exit, args.join(" "));
      assert.equal(
        narrow(f.output(), withFields({ help: optional(text) })).help,
        help,
        args.join(" ")
      );
    }

    f.lines.length = 0;
    assert.equal(
      await entryMain(
        ["session", "init", "--objective", "ok", "--host", "claude"],
        deps
      ),
      0
    );
    assert.equal("help" in f.output(), false);
  } finally {
    f.cleanup();
  }
});
