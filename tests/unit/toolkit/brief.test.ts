import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";

import { main as dispatchMain } from "../../../skills/dispatch/scripts/dispatch.ts";
import type { ProviderId } from "../../../skills/dispatch/scripts/providers/types.ts";
import { taskMarkdown } from "../../../skills/dispatch/scripts/toolkit/brief.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  parsePlan,
  selectTaskBrief,
} from "../../../skills/dispatch/scripts/toolkit/domain/plan.ts";
import { qualityCriteria } from "../../../skills/dispatch/scripts/toolkit/domain/prompt.ts";
import {
  currentHashes,
  foldLedger,
  latest,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import {
  anything,
  nullable,
  numeric,
  optional,
  parseJson,
  readJson,
  withFields,
  text,
} from "./helpers/json.ts";
import type { JsonObject } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

const PLAN = `# Scoped work
Shared gated context 日本語.
## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | First | First works | none | SC1 |
| T2 | Second | Second works | T1 | SC2 |
## Proposed Changes
### T1 — First
- Constraints: Preserve the first invariant.
#### [NEW] src/first.ts
- Purpose: First implementation detail.
### T2 — Second
#### [NEW] src/second.ts
- Purpose: Private second detail.
## Success Criteria
- [SC1] First works
  - Changes: src/first.ts
  - Tests: src/first.ts
  - Check: \`node first-check\`
  - RED: \`node first-red\`
  - Evidence: red
- [SC2] Second works
  - Changes: src/second.ts
  - Check: \`node second-check\`
  - Evidence: check
## Verification Plan
### Automated Tests
- \`node first-check\`
- \`node second-check\`
- \`node contract-check\`
`;

const CAPTURE_PLAN = PLAN.replace(
  "#### [NEW] src/first.ts\n- Purpose: First implementation detail.",
  "#### [NEW] src/first.ts\n- Purpose: First implementation detail.\n#### [NEW] `tests/with space.test.ts`\n- Purpose: Exercise command capture."
).replace(
  "  - Changes: src/first.ts\n  - Tests: src/first.ts\n  - Check: `node first-check`\n  - RED: `node first-red`\n",
  "  - Changes: src/first.ts, `tests/with space.test.ts`\n  - Tests: `tests/with space.test.ts`\n  - Check: `node first-check`\n  - RED: `node first-red {files}`\n"
);

const sharedFixture = sessionFixture({ memory: true });
const bindings = new Map<boolean, string>();
const cachedHashes = new Map<boolean, ReturnType<typeof currentHashes>>();
const tornPath = path.join(sharedFixture.session, "ledger.torn-1.jsonl");
const designPath = path.join(sharedFixture.root, "strategy.design.md");
const ledgerPath = path.join(sharedFixture.session, "ledger.jsonl");

sharedFixture.artifact(
  "mission.spec.md",
  "# Mission\n## Requirements\n### REQ-1 — Works\n"
);

let cachedQuality: string | null = null;

const getQuality = (root: string) =>
  (cachedQuality ??= fs.readFileSync(
    path.join(root, "references/templates/quality-bar.md"),
    "utf-8"
  ));

let cachedWriterTemplate: string | null = null;

const getWriterTemplate = (root: string) =>
  (cachedWriterTemplate ??= fs.readFileSync(
    path.join(root, "references/templates/writer-brief.md"),
    "utf-8"
  ));

after(() => {
  sharedFixture.cleanup();
});

const fixture = async (design = false, source = PLAN) => {
  const f = { ...sharedFixture, cleanup: () => {} };

  // Reset scenario state while retaining the same physical session and templates.
  if (fs.existsSync(tornPath)) {
    fs.unlinkSync(tornPath);
  }

  if (design) {
    if (!fs.existsSync(designPath)) {
      f.artifact("strategy.design.md", "# Strategy\n");
    }
  } else if (fs.existsSync(designPath)) {
    fs.unlinkSync(designPath);
  }

  delete f.deps.hook;
  f.lines.length = 0;
  const planPath = f.artifact("work.plan.md", source);
  const binding = bindings.get(design);
  let key = (binding ?? "").length > 0 ? 2 : 0;
  let lastSeq = key;

  const add = async (
    kind: string,
    data: JsonObject,
    extra: JsonObject = {}
  ) => {
    await Promise.resolve();
    lastSeq += 1;

    const record = {
      seq: lastSeq,
      at: new Date(f.deps.clock()).toISOString(),
      kind,
      key: `record-${(key += 1) - 1}`,
      by: "orchestrator",
      data,
      ...extra,
    };

    fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);

    return record;
  };

  if ((binding ?? "").length > 0) {
    fs.writeFileSync(ledgerPath, defined(binding));
    key = 2;
  } else {
    if (fs.existsSync(ledgerPath)) {
      fs.unlinkSync(ledgerPath);
    }

    await add("bind", {
      spec: "mission.spec.md",
      plan: "work.plan.md",
      ...(design && { design: "strategy.design.md" }),
    });
    await add(
      "confirm",
      { spec: currentHashes(f.root, { spec: "mission.spec.md" }).spec },
      { by: "user", quote: "Approved" }
    );
    bindings.set(design, fs.readFileSync(ledgerPath, "utf-8"));
  }

  let hashes = source === PLAN ? cachedHashes.get(design) : undefined;

  if (!hashes) {
    hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));

    if (source === PLAN) {
      cachedHashes.set(design, hashes);
    }
  }

  const approve = async () =>
    await add("approval", hashes, { by: "user", quote: "Approved" });

  const launch = async (task = "T1") =>
    await add("writer", {
      phase: "launched",
      task,
      path: `.state/worktrees/${task}-1`,
      base: {
        commit: "a".repeat(40),
        taskSection: `sha256:${"b".repeat(64)}`,
        seq: 1,
      },
    });

  let processes = 0;
  f.deps.run = async () => {
    await Promise.resolve();
    processes += 1;

    throw new Error("Brief must not run Git");
  };

  const call = async (level?: string, task = "T1") => {
    f.lines.length = 0;

    const host =
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      (f.deps.orchestrator as { platform: string } | null)?.platform ?? "codex";

    const exit = await main(
      [
        "brief",
        "render",
        task,
        "--session",
        f.session,
        "--host",
        host,
        ...((level ?? "").length > 0 ? ["--level", defined(level)] : []),
      ],
      f.deps
    );

    assert.equal(processes, 0);
    const output = f.output();

    return {
      exit,
      output,
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      value:
        (output.path ?? "").length > 0
          ? JSON.parse(fs.readFileSync(defined(output.path), "utf-8"))
          : null,
    };
  };

  return { ...f, planPath, hashes, add, approve, launch, call };
};

const captureSection = (brief: string) => {
  const marker = "## RED capture commands\n";
  const start = brief.indexOf(marker);
  assert.notEqual(start, -1, "brief includes the RED capture section");

  return defined(
    brief.slice(start + marker.length).split(/\n## /u, 1)[0]
  ).trim();
};

const captureCommand = (section: string) => {
  const match = /`(?<g1>node [^`]+)`/u.exec(section);
  assert.ok(match, "applicable RED criterion has a runnable capture command");

  return defined(match[1]);
};

const captureDataCheck = withFields({
  command: text,
  cwd: text,
  logDir: text,
  criterion: text,
});

const captureData = (command: string) => {
  const match = /(?<g2>[A-Za-z0-9_-]+)$/u.exec(command);
  assert.ok(match, "outer command ends with a base64url payload");
  const [, payload] = match;
  assert.ok((payload ?? "").length > 0);

  return {
    data: parseJson(
      Buffer.from(defined(payload), "base64url").toString("utf-8"),
      captureDataCheck
    ),
  };
};

/** Shared completeness properties for a rendered brief file: byte count, no placeholders, summary names the path. */
const assertCompleteBrief = (
  brief: string,
  value: { bytes: number; briefPath: string },
  summary: string,
  texts: string[]
) => {
  assert.equal(value.bytes, Buffer.byteLength(brief));
  assert.doesNotMatch(brief, /\{\{\w+\}\}/u);
  assert.doesNotMatch(brief, /\]\(/u);

  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  for (const text of texts) {
    assert.ok(brief.includes(text), text);
  }

  assert.ok(summary.includes(value.briefPath));
};

describe("writer brief", () => {
  test("approval chain and open launch govern rendering without Git", async () => {
    const f = await fixture();

    try {
      const missing = await f.call("low");
      assert.equal(missing.exit, 4);
      assert.equal(missing.output.reason, "missing-approval");
      await f.approve();
      await f.add("level", { level: "medium" });
      // oxlint-disable-next-line eslint/no-useless-call -- f.call is the fixture invocation method, not Function.prototype.call
      const unknown = await f.call(undefined, "UNKNOWN");
      assert.equal(unknown.exit, 1);
      assert.equal(unknown.output.reason, "invalid-input");
      const unopened = await f.call();
      assert.equal(unopened.exit, 4);
      assert.equal(unopened.output.reason, "no-open-launch");
      await f.launch();
      fs.appendFileSync(f.planPath, "\nChanged intent.\n");
      const refused = await f.call();
      assert.equal(refused.exit, 4);
      assert.equal(refused.output.reason, "unrecorded-change");
      fs.writeFileSync(f.planPath, PLAN);
      const callResult = await f.call();

      assert.equal(callResult.exit, 0);
      await f.add(
        "level",
        { level: "xhigh" },
        { by: "user", quote: "Use xhigh" }
      );
      const callResult2 = await f.call();

      assert.equal(callResult2.exit, 0);
    } finally {
      f.cleanup();
    }
  });

  test("low level needs no approval and design is included only when bound", async () => {
    for (const design of [false, true]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const f = await fixture(design);

      try {
        const directory = path.join(f.session, "canonical inputs");
        fs.mkdirSync(directory, { recursive: true });
        const bound: Record<string, string> = {};
        const originals: Record<string, string> = {};

        for (const [kind, name] of Object.entries({
          spec: "mission.spec.md",
          plan: "work.plan.md",
          ...(design && { design: "strategy.design.md" }),
        })) {
          originals[kind] = fs.readFileSync(path.join(f.root, name), "utf-8");
          fs.writeFileSync(path.join(directory, name), originals[kind]);
          bound[kind] = path.relative(f.root, path.join(directory, name));
        }

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.add("bind", bound);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.add("level", { level: "low" });
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.launch();
        const worktree = path.join(f.session, ".state/worktrees/T1-1");
        fs.mkdirSync(worktree, { recursive: true });
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const result = await f.call();
        assert.equal(result.exit, 0);
        // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        const brief = fs.readFileSync(result.value.path, "utf-8");

        const addresses = {
          spec: /Read the governing spec whole: `(?<g3>[^`]+)`/u.exec(
            brief
          )?.[1],
          plan: /Governing plan: `(?<g4>[^`]+)`/u.exec(brief)?.[1],
          design: design
            ? /Governing design: `(?<g5>[^`]+)`/u.exec(brief)?.[1]
            : undefined,
        };

        for (const kind of ["spec", "plan", "design"] as const) {
          if (kind === "design" && !design) {
            continue;
          }

          const address = addresses[kind];
          assert.ok((address ?? "").length > 0, `${kind} read address`);
          assert.equal(
            fs.readFileSync(path.resolve(worktree, defined(address)), "utf-8"),
            originals[kind]
          );
          const hash = f.hashes[kind];
          assert.ok((hash ?? "").length > 0);
          assert.ok(brief.includes(defined(hash)));
          const boundPath = bound[kind];
          assert.ok((boundPath ?? "").length > 0);
          assert.equal(
            fs.existsSync(path.resolve(worktree, defined(boundPath))),
            false
          );
        }

        if (design) {
          assert.ok(brief.includes("strategy.design.md"));
          assert.ok(brief.includes(defined(f.hashes.design)));
          assert.ok(
            brief.includes(`mission.spec.md\` (governed hash ${f.hashes.spec})`)
          );
          assert.ok(
            brief.includes(`work.plan.md\` (governed hash ${f.hashes.plan})`)
          );
          assert.ok(
            brief.includes(
              `strategy.design.md\` (governed hash ${f.hashes.design})`
            )
          );
          assert.match(
            brief,
            /These are canonical governed hashes from the orchestrator; raw file SHA-256 values differ\. Do not run the dispatch toolkit\./iu
          );
        } else {
          assert.doesNotMatch(brief, /Governing design:|strategy\.design\.md/u);

          for (const rule of [
            "Shared plan context",
            "Task scope",
            "Criteria",
            "Contract commands",
            "RED capture commands",
            "embedded below",
            "Read the whole plan only when",
            "Constraints:",
            "Invariants:",
          ]) {
            assert.ok(brief.includes(rule), rule);
          }
        }
      } finally {
        f.cleanup();
      }
    }
  });

  test("records a stale lock break once before rendering without caller ledger writes or Git", async () => {
    const f = await fixture();

    try {
      await f.approve();
      await f.launch();
      const before = foldLedger(f.session);
      const lock = path.join(f.session, ".state", "lock");

      const stale = JSON.stringify({
        pid: 99,
        host: f.deps.host,
        at: "old",
        tool: "interrupted",
      });

      const ledger = path.join(f.session, "ledger.jsonl");
      fs.appendFileSync(ledger, "{torn");
      fs.writeFileSync(lock, stale);
      const callResult3 = await f.call();

      assert.equal(callResult3.exit, 0);
      assert.equal(fs.existsSync(lock), false);
      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const after = foldLedger(f.session);
      assert.equal(after.torn, null);
      assert.equal(after.records.length, before.records.length + 1);
      assert.deepEqual(
        after.records.slice(0, before.records.length),
        before.records
      );
      const note = defined(after.records.at(-1));
      assert.equal(note.seq, before.lastSeq + 1);
      assert.equal(note.key, `stale-lock:${f.deps.host}:99:old`);
      assert.equal(note.kind, "note");
      assert.equal(note.by, "tool");
      assert.equal(
        note.data["text"],
        `Broke stale lock from pid 99 on ${f.deps.host}`
      );
      assert.equal(
        fs.readFileSync(path.join(f.session, "ledger.torn-1.jsonl"), "utf-8"),
        "{torn"
      );
    } finally {
      f.cleanup();
    }
  });

  test("gated snapshot supplies scoped context criteria quality and short report", async () => {
    const f = await fixture(false, CAPTURE_PLAN);

    try {
      await f.approve();
      await f.launch();
      f.deps.hook = (point) => {
        assert.equal(point, "brief:after-gate");
        fs.writeFileSync(
          f.planPath,
          CAPTURE_PLAN.replace(
            "node first-red {files}",
            "node poison-red {files}"
          )
        );
      };

      const result = await f.call();
      assert.equal(result.exit, 0);
      assert.equal(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        result.value.path,
        path.join(f.session, ".state", "briefs", "T1-1.md")
      );
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.ok(result.output.summary.includes(result.value.path));
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const brief = fs.readFileSync(result.value.path, "utf-8");
      const command = captureCommand(captureSection(brief));
      const payload = captureData(command);
      assert.match(payload.data.command, /node first-red/u);
      assert.doesNotMatch(payload.data.command, /node poison-red/u);

      const quotedPath =
        process.platform === "win32"
          ? '"tests/with space.test.ts"'
          : "'tests/with space.test.ts'";

      assert.equal(payload.data.criterion, "SC1");
      assert.equal(
        payload.data.logDir,
        path.join(f.session, ".state", "briefs", "T1-1.red")
      );
      assert.ok(payload.data.command.includes(quotedPath));
      assert.ok(
        !payload.data.command.includes("src/first.ts"),
        "Changes paths do not become {files}"
      );
      assert.ok(command.includes("capture.cjs"));
      assert.doesNotMatch(command, /[$%]/u);
      const quality = getQuality(f.deps.skillRoot);

      const specStage = fs.readFileSync(
        path.join(f.deps.skillRoot, "references/spec-stage.md"),
        "utf-8"
      );

      const writerQuality = qualityCriteria(quality, "writer", 0, specStage);
      assert.equal(brief.split(`## Quality\n\n${writerQuality}`).length - 1, 1);
      assert.ok(writerQuality.includes("Writer focus"));
      assert.doesNotMatch(writerQuality, /^- Prune:/mu);
      assert.ok(writerQuality.includes("document layers ("));
      assert.ok(
        writerQuality.includes(
          "Report host-rule/brief conflicts under concerns or limits."
        )
      );
      assert.doesNotMatch(
        writerQuality,
        /Treat settled DECs, non-goals, and prior accepted or rejected rulings/u
      );

      const codeBody = defined(
        defined(quality.split("## code\n")[1]).split("\n## ")[0]
      ).trim();

      assert.ok(writerQuality.includes(codeBody));

      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      for (const text of [
        path.resolve(f.session, ".state/worktrees/T1-1"),
        "mission.spec.md",
        defined(f.hashes.spec),
        "work.plan.md",
        defined(f.hashes.plan),
        "Shared gated context 日本語.",
        "## Task Map",
        "### T1",
        "Preserve the first invariant",
        "First implementation detail",
        "SC1",
        "node first-check",
        "node first-red",
        "src/first.ts",
        "node contract-check",
        "**intent**",
        "**correctness**",
        "DONE",
        "BLOCKED",
        "NEEDS_CONTEXT",
      ]) {
        assert.ok(brief.includes(text), text);
      }

      assert.match(brief, /read.*whole/iu);
      assert.match(brief, /failing tests/iu);
      assert.match(brief, /Git write commands/u);

      for (const forbidden of [
        "poison-red",
        "### T2",
        "Private second detail",
        "node second-check",
      ]) {
        assert.ok(!brief.includes(forbidden), forbidden);
      }

      const template = getWriterTemplate(f.deps.skillRoot);

      const reportPath = path.join(
        f.session,
        ".state",
        "briefs",
        "T1-1.report.md"
      );

      const logDir = path.join(f.session, ".state", "briefs", "T1-1.red");
      assert.ok(template.includes("{{redCapture}}"));
      assert.ok(template.includes("{{reportPath}}"));
      assert.ok(template.includes("{{redLogDir}}"));
      assert.ok(brief.includes(reportPath));
      assert.ok(brief.includes(logDir));
      assert.ok(template.includes("## Observed RED failures"));
      assert.match(template, /plain-text lines directly below the heading/iu);
      assert.match(
        template,
        /Do not add # or ## headings inside that section/iu
      );
      assert.match(
        template,
        /outside.*\{\{reportPath\}\}.*\{\{redLogDir\}\}/isu
      );
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.equal(result.value.bytes, Buffer.byteLength(brief));
    } finally {
      f.cleanup();
    }
  });

  test("RED capture commands share one bootstrap file", async () => {
    const source = CAPTURE_PLAN.replace(
      "none | SC1 |",
      "none | SC1, SC3 |"
    ).replace(
      "## Verification Plan",
      `- [SC3] Another check
  - Changes: src/first.ts
  - Tests: src/first.ts
  - Check: \`node second-check\`
  - RED: \`node second-red\`
  - Evidence: red
## Verification Plan`
    );

    const f = await fixture(false, source);

    try {
      await f.approve();
      await f.launch();
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result.output));

      const section = captureSection(
        // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        fs.readFileSync(result.value.path, "utf-8")
      );

      const commands = [...section.matchAll(/`(?<g6>node [^`]+)`/gu)].map(
        (match) => defined(match[1])
      );

      assert.equal(commands.length, 2);

      const capture = path.join(
        f.session,
        ".state",
        "briefs",
        "T1-1.red",
        "capture.cjs"
      );

      for (const command of commands) {
        assert.ok(command.includes(capture), command);
      }

      assert.doesNotMatch(section, /node -e/u);
    } finally {
      f.cleanup();
    }
  });

  test("empty test paths produce an inline diagnostic and no capture command", async () => {
    for (const item of [
      {
        source: CAPTURE_PLAN.replace(
          "  - Tests: `tests/with space.test.ts`\n",
          ""
        ),
        pattern: /no test paths/iu,
      },
      {
        source: CAPTURE_PLAN.replaceAll(
          "tests/with space.test.ts",
          "tests/bad;touch marker.test.ts"
        ),
        pattern: /tests\/bad;touch marker\.test\.ts/u,
      },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const f = await fixture(false, item.source);

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.approve();
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.launch();
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const result = await f.call();
        assert.equal(result.exit, 0);

        const section = captureSection(
          // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          fs.readFileSync(result.value.path, "utf-8")
        );

        assert.match(section, /T1/u);
        assert.match(section, /SC1/u);
        assert.match(section, item.pattern);
        assert.doesNotMatch(section, /node -e/u);
      } finally {
        f.cleanup();
      }
    }

    // Verify-only and excepted criteria leave the capture slot empty.
    for (const item of [
      { task: "T2", source: PLAN },
      {
        task: "T1",
        source: CAPTURE_PLAN.replace(
          "  - Evidence: red\n",
          "  - Evidence: red\n  - RED exception: already-satisfied\n"
        ),
      },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const f = await fixture(false, item.source);

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.approve();
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.launch(item.task);
        // oxlint-disable-next-line eslint/no-await-in-loop, eslint/no-useless-call -- sequential fixture await via the f.call invocation method, not Function.prototype.call
        const result = await f.call(undefined, item.task);
        assert.equal(result.exit, 0);
        // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        const brief = fs.readFileSync(result.value.path, "utf-8");
        assert.equal(captureSection(brief), "");
      } finally {
        f.cleanup();
      }
    }
  });
});

test("writer brief binds plan constraints, leaves routine choices to the writer and keeps review evidence with the orchestrator", async () => {
  const f = await fixture(false, PLAN);

  try {
    await f.approve();
    await f.launch();
    const rendered = await f.call();
    assert.equal(rendered.exit, 0, JSON.stringify(rendered.output));

    const brief = fs
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      .readFileSync(rendered.value.path, "utf-8")
      .replaceAll(/\s+/gu, " ");

    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    for (const text of [
      "`Constraints:`, `Overlap:`, `Invariants:` and stated exact algorithms as binding",
      "decide routine implementation choices yourself",
      "the orchestrator runs post-integration `Evidence: review` checks",
      "RED command runs as written in the platform's subprocess shell",
    ]) {
      assert.equal(brief.split(text).length - 1, 1, text);
    }

    // Collapsed plan sections still contribute task behaviour and criterion fields.
    const behaviour =
      "- First returns the validated value after retrying once.";

    const collapsed = PLAN.replace(
      "### T1 — First",
      `### T1 — First\n${behaviour}`
    )
      .replace(
        "#### [NEW] src/first.ts",
        "<details>\n<summary>First files</summary>\n\n#### [NEW] src/first.ts"
      )
      .replace("### T2 — Second", "</details>\n\n### T2 — Second")
      .replace(
        "- [SC1] First works",
        "- [SC1] First works\n  <details>\n  <summary>Checks</summary>\n"
      )
      .replace("- [SC2]", "  </details>\n\n- [SC2]");

    const g = await fixture(false, collapsed);

    try {
      await g.approve();
      await g.launch();
      const collapsedRendered = await g.call();
      assert.equal(
        collapsedRendered.exit,
        0,
        JSON.stringify(collapsedRendered.output)
      );

      const collapsedBrief = fs.readFileSync(
        // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        collapsedRendered.value.path,
        "utf-8"
      );

      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      for (const text of [
        "#### [NEW] src/first.ts",
        "- Purpose: First implementation detail.",
        "  - Changes: src/first.ts",
        "  - Tests: src/first.ts",
        "  - Check: `node first-check`",
        "  - RED: `node first-red`",
        "  - Evidence: red",
      ]) {
        assert.ok(collapsedBrief.includes(text), text);
      }

      assert.equal(collapsedBrief.split(behaviour).length - 1, 1);
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test("writer brief states explorer and utility subagent rules", async () => {
  const f = await fixture(false, PLAN);
  const { skillRoot, orchestrator } = f.deps;
  const skill = path.join(f.root, "explorer-skill");
  const templates = path.join(skill, "references", "templates");
  fs.mkdirSync(templates, { recursive: true });
  fs.writeFileSync(
    path.join(templates, "writer-brief.md"),
    getWriterTemplate(skillRoot)
  );
  fs.writeFileSync(
    path.join(templates, "quality-bar.md"),
    getQuality(skillRoot)
  );
  fs.copyFileSync(
    path.join(skillRoot, "references/spec-stage.md"),
    path.join(skill, "references", "spec-stage.md")
  );
  const config = path.join(skill, "config.jsonc");

  const valid = JSON.stringify({
    "read-delegates": { codex: { targets: [{ low: { model: "reader" } }] } },
    "utility-subagents": {
      "claude-code": {
        model: ["cheap-a", "cheap-b"],
        effort: "medium",
        "context-limit": 150_000,
      },
      "openai-codex": { model: "codex-mid", "context-limit": 300_000 },
    },
    "write-subagents": {
      claude: { low: { model: "claude-writer" } },
      "openai-codex": {
        medium: { model: "codex-mid" },
        high: { model: "codex-high", effort: "high" },
      },
    },
  });

  try {
    await f.approve();
    await f.launch();
    f.deps.skillRoot = skill;

    const render = async (host: ProviderId) => {
      f.deps.orchestrator = { platform: host, model: null };
      const result = await f.call("high");
      assert.equal(result.exit, 0, JSON.stringify(result.output));

      return (
        fs
          // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          .readFileSync(result.value.path, "utf-8")
          .replaceAll(/\s+/gu, " ")
      );
    };

    fs.writeFileSync(config, valid);
    const claudeBrief = await render("claude");
    assert.match(
      claudeBrief,
      /launch: model cheap-a, effort medium, else cheap-b/u
    );
    assert.match(claudeBrief, /token limit 150,000 tokens/u);
    assert.match(claudeBrief, /reply size limit 8,192 UTF-8 bytes/u);
    assert.match(
      claudeBrief,
      /stay read-only: no edits, no Git write commands and no toolkit/u
    );
    assert.match(claudeBrief, /read directly/u);
    assert.match(claudeBrief, /tedious, simple edits/u);
    assert.match(
      claudeBrief,
      /explicit disjoint paths inside your task paths/u
    );
    assert.match(
      claudeBrief,
      /no path shared between two running utility subagents/u
    );
    assert.match(
      claudeBrief,
      /run no Git write commands, no toolkit, and launch nothing/u
    );
    assert.match(claudeBrief, /no token limit applies to it/u);
    assert.match(
      claudeBrief,
      /inspects? its delta and run(?<g7>s)? (?<g8>the )?task verification/iu
    );
    assert.match(claudeBrief, /perform the edits yourself/u);
    assert.match(
      claudeBrief,
      /A utility subagent under a writer is not a second writer/u
    );

    const codexBrief = await render("codex");
    assert.match(codexBrief, /launch: model codex-mid, no effort set/u);
    assert.match(codexBrief, /token limit 300,000 tokens/u);

    const copilotBrief = await render("copilot");
    assert.match(
      copilotBrief,
      /utility.*not configured; the orchestrator reports a blocker/iu
    );
    assert.ok(!copilotBrief.includes("read directly"));
    assert.ok(!copilotBrief.includes("perform the edits yourself"));

    fs.writeFileSync(config, '{"unknown":true}');
    assert.match(
      await render("claude"),
      /utility.*not configured; the orchestrator reports a blocker/iu
    );
    fs.writeFileSync(config, "{");
    assert.match(
      await render("claude"),
      /utility.*not configured; the orchestrator reports a blocker/iu
    );
    fs.unlinkSync(config);
    assert.match(
      await render("claude"),
      /utility.*not configured; the orchestrator reports a blocker/iu
    );
  } finally {
    f.deps.skillRoot = skillRoot;
    f.deps.orchestrator = orchestrator;
    f.cleanup();
  }
});

/** Skill root whose claude-code utility entry has a 150,000-token limit, with the explorer templates copied in. */
const limitSkill = (skill: string, skillRoot: string) => {
  const templates = path.join(skill, "references", "templates");
  fs.mkdirSync(templates, { recursive: true });

  for (const name of ["explorer-brief.md", "context-map.md"]) {
    fs.copyFileSync(
      path.join(skillRoot, "references", "templates", name),
      path.join(templates, name)
    );
  }

  fs.writeFileSync(
    path.join(templates, "quality-bar.md"),
    getQuality(skillRoot)
  );
  fs.copyFileSync(
    path.join(skillRoot, "references/spec-stage.md"),
    path.join(skill, "references", "spec-stage.md")
  );
  fs.writeFileSync(
    path.join(skill, "config.jsonc"),
    JSON.stringify({
      "read-delegates": { codex: { targets: [{ low: { model: "reader" } }] } },
      "utility-subagents": {
        "claude-code": {
          model: ["cheap-a", "cheap-b"],
          effort: "medium",
          "context-limit": 150_000,
        },
        "openai-codex": { model: "codex-mid", "context-limit": 300_000 },
      },
    })
  );

  return skill;
};

describe("explorer brief", () => {
  test("explorer map brief renders complete with no unfilled placeholder", async () => {
    const f = await fixture();

    try {
      await f.approve();

      const values = {
        objective: "Map a shared interface change.",
        questions: "- Which callers and tests cover the interface?",
        outputPath: ".scratch/session/work.spec.context.md",
      };

      const valuesPath = path.join(f.session, "explorer-values.json");
      fs.writeFileSync(valuesPath, JSON.stringify(values));
      f.lines.length = 0;

      const exit = await main(
        [
          "brief",
          "explorer",
          valuesPath,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      );

      assert.equal(exit, 0, JSON.stringify(f.lines));
      const output = f.output();
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const value = JSON.parse(fs.readFileSync(defined(output.path), "utf-8"));
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.ok((value.briefPath ?? "") !== "");
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const brief = fs.readFileSync(value.briefPath, "utf-8");
      // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
      assertCompleteBrief(brief, value, output.summary, [
        values.objective,
        values.questions,
        values.outputPath,
        "lint run",
        "dispatch.ts",
        "16,384",
        "# Context map:",
        "## Not covered",
        "Host rule files:",
      ]);
      assert.match(
        brief,
        /^- callers and impacted tests of each changed shared helper$/mu
      );
      assert.ok(
        !brief.includes("Writer focus (task writers only"),
        "explorer quality carries no writer directive"
      );
    } finally {
      f.cleanup();
    }
  });

  test("explorer brief states the limit and nesting rules", async () => {
    const f = await fixture();
    const { skillRoot, orchestrator } = f.deps;

    const skill = limitSkill(
      path.join(f.root, "explorer-skill-sc4"),
      skillRoot
    );

    try {
      await f.approve();
      f.deps.skillRoot = skill;

      const values = {
        objective: "Map a shared interface change.",
        questions: "- Which callers and tests cover the interface?",
        outputPath: ".scratch/session/work.spec.context.md",
      };

      const valuesPath = path.join(f.session, "explorer-values-sc4.json");
      fs.writeFileSync(valuesPath, JSON.stringify(values));
      f.lines.length = 0;

      const exit = await main(
        [
          "brief",
          "explorer",
          valuesPath,
          "--session",
          f.session,
          "--host",
          "claude",
        ],
        f.deps
      );

      assert.equal(exit, 0, JSON.stringify(f.lines));

      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const value = JSON.parse(
        fs.readFileSync(defined(f.output().path), "utf-8")
      );

      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.equal(value.kind, "map");
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.equal(value.contextLimit, 150_000);
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const brief = fs.readFileSync(value.briefPath, "utf-8");

      // host limit and nested launch model and effort
      assert.match(brief, /150,000/u);
      assert.match(
        brief,
        /Launch nested explorers exactly as: launch: model cheap-a, effort medium, else cheap-b\./u
      );

      // solo and split rules with minimum size, cap and one level
      assert.match(brief, /work solo/iu);
      assert.match(
        brief,
        /split only when expected reading exceeds the split threshold/iu
      );
      assert.match(brief, /15 files or 60 KB/iu);
      assert.match(brief, /at most four/iu);
      assert.match(brief, /one level/iu);
      assert.match(brief, /nested explorer launches nothing/iu);

      // no-launch-tool fallback
      assert.match(
        brief,
        /no tool to launch a subagent.*do the work.*reply/isu
      );

      // partial-map and consolidation rules
      assert.match(brief, /partial map/iu);
      assert.match(brief, /consolidat/iu);
      assert.match(brief, /keep partial maps/iu);
      assert.match(brief, /Not covered/iu);

      // shared contract assignment
      assert.match(
        brief,
        /shared contract, schema or predicate.*assign one nested explorer.*objective and the covered paths/isu
      );

      // per-nested-explorer model and token report
      assert.match(brief, /model and tokens.*unavailable/iu);

      // Split threshold derives from the 150,000-token limit for map and research briefs.
      assert.match(brief, /Split threshold: 112,500 tokens\./u);
      assert.match(
        brief,
        /coherent single-topic work stays solo past the limit/iu
      );
      assert.match(brief, /report the expected overrun/iu);

      const splitResearchValues = path.join(
        f.session,
        "split-research-sc4.json"
      );

      fs.writeFileSync(
        splitResearchValues,
        JSON.stringify({
          objective: "Research logs.",
          questions: "- Why did step 3 fail?",
        })
      );
      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "brief",
            "explorer",
            splitResearchValues,
            "--session",
            f.session,
            "--host",
            "claude",
          ],
          f.deps
        ),
        0
      );

      const splitResearchBrief = fs.readFileSync(
        // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8"))
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          .briefPath,
        "utf-8"
      );

      assert.match(splitResearchBrief, /Split threshold: 112,500 tokens\./u);
      assert.match(splitResearchBrief, /report the expected overrun/iu);

      // Unresolved entry gives contextLimit null and states not configured
      f.lines.length = 0;

      const unresExit = await main(
        [
          "brief",
          "explorer",
          valuesPath,
          "--session",
          f.session,
          "--host",
          "copilot",
        ],
        f.deps
      );

      assert.equal(unresExit, 0);

      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const unresValue = JSON.parse(
        fs.readFileSync(defined(f.output().path), "utf-8")
      );

      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.equal(unresValue.contextLimit, null);
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const unresBrief = fs.readFileSync(unresValue.briefPath, "utf-8");
      assert.match(
        unresBrief,
        /utility.*not configured; the orchestrator reports a blocker/iu
      );
      assert.match(
        unresBrief,
        /Split threshold: utility entry not configured; the orchestrator reports a blocker\./u
      );

      // Default map brief carries the validation-gates coverage item and the map write scope.
      f.deps.skillRoot = skillRoot;

      const gatesValues = path.join(
        f.session,
        "explorer-validation-gates.json"
      );

      fs.writeFileSync(
        gatesValues,
        JSON.stringify({
          objective: "Map.",
          questions: "- Q?",
          outputPath: ".scratch/session/work.spec.context.md",
        })
      );
      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "brief",
            "explorer",
            gatesValues,
            "--session",
            f.session,
            "--host",
            "codex",
          ],
          f.deps
        ),
        0
      );

      const gatesBrief = fs.readFileSync(
        // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8"))
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          .briefPath,
        "utf-8"
      );

      assert.match(
        gatesBrief,
        /^- validation gates each new or changed input crosses$/mu
      );
      assert.match(
        gatesBrief,
        /Write only your assigned map .*\.scratch\/session\/work\.spec\.context\.md.*assigned partial maps/iu
      );
      assert.match(gatesBrief, /except host tool caches or indexes/iu);
      assert.ok(gatesBrief.includes("lint run"));
      assert.doesNotMatch(gatesBrief, /Apply the shared evidence rule below/u);

      // Research brief writes no map file and runs no context-map lint.
      const scopeResearchValues = path.join(
        f.session,
        "explorer-scope-research.json"
      );

      fs.writeFileSync(
        scopeResearchValues,
        JSON.stringify({ objective: "Research.", questions: "- Q?" })
      );
      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "brief",
            "explorer",
            scopeResearchValues,
            "--session",
            f.session,
            "--host",
            "codex",
          ],
          f.deps
        ),
        0
      );

      const scopeResearchBrief = fs.readFileSync(
        // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8"))
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          .briefPath,
        "utf-8"
      );

      assert.ok(scopeResearchBrief.includes("write no map file"));
      assert.ok(scopeResearchBrief.includes("run no context-map lint"));
      assert.doesNotMatch(
        scopeResearchBrief,
        /Apply the shared evidence rule below/u
      );
      assert.doesNotMatch(scopeResearchBrief, /partial map/u);
      f.deps.skillRoot = skill;
    } finally {
      f.deps.skillRoot = skillRoot;
      f.deps.orchestrator = orchestrator;
      f.cleanup();
    }
  });

  test("research brief renders without outputPath and handles array questions and help", async () => {
    const f = await fixture();
    const { skillRoot, orchestrator } = f.deps;

    const skill = limitSkill(
      path.join(f.root, "explorer-skill-sc5"),
      skillRoot
    );

    try {
      await f.approve();
      f.deps.skillRoot = skill;

      // 1. Research brief without outputPath
      const researchValues = {
        objective: "Research logs.",
        questions: "- Why did step 3 fail?",
      };

      const valuesPath = path.join(f.session, "research-values.json");
      fs.writeFileSync(valuesPath, JSON.stringify(researchValues));
      f.lines.length = 0;

      const exit = await main(
        [
          "brief",
          "explorer",
          valuesPath,
          "--session",
          f.session,
          "--host",
          "claude",
        ],
        f.deps
      );

      assert.equal(exit, 0, JSON.stringify(f.lines));

      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const value = JSON.parse(
        fs.readFileSync(defined(f.output().path), "utf-8")
      );

      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.equal(value.kind, "research");
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.equal(value.contextLimit, 150_000);
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const brief = fs.readFileSync(value.briefPath, "utf-8");

      // Token limit and 8,192 byte reply limit
      assert.match(brief, /150,000/u);
      assert.match(brief, /8,192 UTF-8 bytes/u);

      // Nesting rule with consolidation of nested replies into one bounded reply
      assert.match(
        brief,
        /nesting:.*nested explorer replies inline.*consolidates the nested replies into its one reply within the 8,192/isu
      );

      // Launch model and effort
      assert.match(
        brief,
        /Launch nested explorers exactly as: launch: model cheap-a, effort medium, else cheap-b\./u
      );

      // No map instructions
      assert.ok(!brief.includes("lint run"), "research brief has no lint run");
      assert.ok(
        !brief.includes("16,384"),
        "research brief has no 16,384 map budget"
      );
      assert.ok(
        !brief.includes("## Context map template"),
        "research brief has no context map template"
      );
      assert.ok(
        !brief.includes("# Context map:"),
        "research brief has no context map template text"
      );
      assert.ok(
        !brief.includes("partial map"),
        "research brief has no partial map"
      );
      assert.ok(
        !brief.includes("## Map, budget and output"),
        "research brief has no map output section"
      );
      assert.ok(
        !brief.includes("## Coverage checklist"),
        "research brief has no coverage checklist"
      );
      assert.ok(
        !brief.includes("agent type that can write files"),
        "research brief has no writable-agent requirement"
      );

      // 2. Questions as array of strings renders one per line
      const arrayValues = {
        objective: "Research array questions.",
        questions: ["- First question?", "- Second question?"],
      };

      const arrayValuesPath = path.join(f.session, "array-questions.json");
      fs.writeFileSync(arrayValuesPath, JSON.stringify(arrayValues));
      f.lines.length = 0;

      const arrayExit = await main(
        [
          "brief",
          "explorer",
          arrayValuesPath,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      );

      assert.equal(arrayExit, 0, JSON.stringify(f.lines));

      const arrayBrief = fs.readFileSync(
        // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8"))
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          .briefPath,
        "utf-8"
      );

      assert.match(arrayBrief, /- First question\?\r?\n- Second question\?/u);

      // 3. help brief explorer states both questions forms and optional outputPath
      f.deps.skillRoot = skillRoot;
      f.lines.length = 0;
      const helpExit = await dispatchMain(["help", "brief explorer"], f.deps);
      assert.equal(helpExit, 0);
      const helpText = f.lines.join("\n");
      assert.match(helpText, /questions.*string.*array of strings/iu);
      assert.match(helpText, /optional `?outputPath`?/iu);
      assert.match(helpText, /map brief.*research brief/iu);
      assert.match(helpText, /kind.*contextLimit/iu);
    } finally {
      f.deps.skillRoot = skillRoot;
      f.deps.orchestrator = orchestrator;
      f.cleanup();
    }
  });

  test("refuses missing or unknown value without writing", async () => {
    const f = await fixture();

    try {
      await f.approve();
      const briefs = path.join(f.session, ".state", "briefs");

      const before = fs.existsSync(briefs)
        ? fs.readdirSync(briefs).toSorted()
        : [];

      const cases: Record<string, string>[] = [
        { questions: "- Q?" },
        {
          objective: "Map.",
          questions: "- Q?",
          outputPath: "out.md",
          extra: "x",
        },
        { objective: "   ", questions: "- Q?", outputPath: "out.md" },
        { objective: "Map.", questions: "- Q?", outputPath: "   " },
      ];

      for (const [index, values] of cases.entries()) {
        const valuesPath = path.join(f.session, `explorer-bad-${index}.json`);
        fs.writeFileSync(valuesPath, JSON.stringify(values));
        f.lines.length = 0;

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const exit = await main(
          [
            "brief",
            "explorer",
            valuesPath,
            "--session",
            f.session,
            "--host",
            "codex",
          ],
          f.deps
        );

        assert.equal(exit, 1, JSON.stringify(values));
        assert.equal(f.output().reason, "invalid-input");
      }

      const malformed = path.join(f.session, "explorer-malformed.json");
      fs.writeFileSync(malformed, "{");
      f.lines.length = 0;
      assert.equal(
        await main(
          [
            "brief",
            "explorer",
            malformed,
            "--session",
            f.session,
            "--host",
            "codex",
          ],
          f.deps
        ),
        1
      );
      assert.equal(f.output().reason, "invalid-input");

      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const after = fs.existsSync(briefs)
        ? fs.readdirSync(briefs).toSorted()
        : [];

      assert.deepEqual(after, before);
    } finally {
      f.cleanup();
    }
  });
});

describe("test-cleanup brief", () => {
  test("test-cleanup brief renders complete with no unfilled placeholder", async () => {
    const f = await fixture();

    try {
      await f.approve();
      const base = "a".repeat(40);
      const integrationPath = ".scratch/worktrees/integration";
      const valuesPath = path.join(f.session, "cleanup-values.json");
      fs.writeFileSync(valuesPath, JSON.stringify({ base, integrationPath }));
      f.lines.length = 0;

      const exit = await main(
        [
          "brief",
          "test-cleanup",
          valuesPath,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      );

      assert.equal(exit, 0, JSON.stringify(f.lines));
      const output = f.output();
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const value = JSON.parse(fs.readFileSync(defined(output.path), "utf-8"));
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.ok((value.briefPath ?? "") !== "");
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      const brief = fs.readFileSync(value.briefPath, "utf-8");
      // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
      assertCompleteBrief(brief, value, output.summary, [
        base,
        integrationPath,
        "work.plan.md",
        "Run no Git write commands",
        "- Prune:",
        '{"removed": ["SC1"], "deleted": 0, "merged": 0}',
      ]);
      assert.ok(
        !brief.includes("Writer focus (task writers only"),
        "cleanup quality carries no writer directive"
      );
      const match = /`(?<g9>[^`]*work\.plan\.md)`/u.exec(brief);
      assert.ok(match, "bound plan path");
      assert.equal(
        fs.readFileSync(path.resolve(defined(match[1])), "utf-8"),
        fs.readFileSync(f.planPath, "utf-8")
      );
    } finally {
      f.cleanup();
    }
  });

  test("refuses missing, unknown or unbound plan without writing", async () => {
    const f = await fixture();

    try {
      await f.approve();
      const briefs = path.join(f.session, ".state", "briefs");

      const before = fs.existsSync(briefs)
        ? fs.readdirSync(briefs).toSorted()
        : [];

      const cases: Record<string, string>[] = [
        { integrationPath: "integration" },
        { base: "a".repeat(40), integrationPath: "integration", extra: "x" },
        { base: "", integrationPath: "integration" },
      ];

      for (const [index, values] of cases.entries()) {
        const valuesPath = path.join(f.session, `cleanup-bad-${index}.json`);
        fs.writeFileSync(valuesPath, JSON.stringify(values));
        f.lines.length = 0;

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const exit = await main(
          [
            "brief",
            "test-cleanup",
            valuesPath,
            "--session",
            f.session,
            "--host",
            "codex",
          ],
          f.deps
        );

        assert.equal(exit, 1, JSON.stringify(values));
        assert.equal(f.output().reason, "invalid-input");
      }

      const g = sessionFixture({ memory: true });

      try {
        const valuesPath = path.join(g.session, "cleanup-values.json");
        fs.writeFileSync(
          valuesPath,
          JSON.stringify({
            base: "a".repeat(40),
            integrationPath: "integration",
          })
        );

        const exit = await main(
          [
            "brief",
            "test-cleanup",
            valuesPath,
            "--session",
            g.session,
            "--host",
            "codex",
          ],
          g.deps
        );

        assert.equal(exit, 4);
        assert.equal(g.output().reason, "lint-errors");
        assert.equal(
          fs.existsSync(path.join(g.session, ".state", "briefs")),
          false
        );
      } finally {
        g.cleanup();
      }

      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const after = fs.existsSync(briefs)
        ? fs.readdirSync(briefs).toSorted()
        : [];

      assert.deepEqual(after, before);
    } finally {
      f.cleanup();
    }
  });
});

test("brief results name the host model and effort", async () => {
  const f = await fixture(false, PLAN);
  const { skillRoot, orchestrator } = f.deps;
  const skill = path.join(f.root, "launch-skill");
  const templates = path.join(skill, "references", "templates");
  fs.mkdirSync(templates, { recursive: true });

  for (const name of [
    "writer-brief.md",
    "explorer-brief.md",
    "test-cleanup-brief.md",
    "verifier-brief.md",
    "quality-bar.md",
    "context-map.md",
  ]) {
    fs.copyFileSync(
      path.join(skillRoot, "references", "templates", name),
      path.join(templates, name)
    );
  }

  fs.copyFileSync(
    path.join(skillRoot, "references/spec-stage.md"),
    path.join(skill, "references", "spec-stage.md")
  );
  const configPath = path.join(skill, "config.jsonc");

  const writeConfig = () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        "read-delegates": {
          codex: { targets: [{ low: { model: "reader" } }] },
          opencode: { targets: [{ low: { model: "reader" } }] },
          copilot: { targets: [{ low: { model: "reader" } }] },
          agy: { targets: [{ low: { model: "reader" } }] },
        },
        "write-subagents": {
          codex: {
            low: { model: "codex-low", effort: "low-eff" },
            high: {
              model: ["codex-high-a", "codex-high-b"],
              effort: "high-eff",
            },
          },
          opencode: {
            low: { model: "prov/model", effort: "my-eff" },
            high: { model: "prov/plain" },
          },
          agy: { low: { model: "agy-low", effort: "low" } },
          claude: { low: { model: "claude-haiku-5-5", effort: "medium" } },
        },
        "utility-subagents": {
          opencode: {
            model: "exp/model",
            effort: "exp-eff",
            "context-limit": 300_000,
          },
          codex: { model: "codex-exp", "context-limit": 300_000 },
          claude: {
            model: "claude-haiku-5-5",
            effort: "medium",
            "context-limit": 300_000,
          },
        },
      })
    );
  };

  try {
    await f.approve();
    await f.launch();
    f.deps.skillRoot = skill;

    const writerCheck = withFields({
      path: text,
      launch: numeric,
      model: anything,
      effort: anything,
      launchAs: nullable(text),
      subagentModels: optional(anything),
    });

    const writerValue = async (host: ProviderId, level: string) => {
      await f.add(
        "level",
        { level },
        { by: level === "low" ? "orchestrator" : "orchestrator" }
      );
      f.deps.orchestrator = { platform: host, model: null };
      f.lines.length = 0;

      const exit = await main(
        ["brief", "render", "T1", "--session", f.session, "--host", host],
        f.deps
      );

      assert.equal(exit, 0, JSON.stringify(f.lines));
      const out = f.output();
      assert.ok((out.path ?? "").length > 0);

      return {
        summary: out.summary,
        ...readJson(defined(out.path), writerCheck),
      };
    };

    writeConfig();
    // Two distinct levels for the same host.
    const writerValueResult = await writerValue("codex", "low");

    assert.deepEqual(writerValueResult.model, ["codex-low"]);
    const writerValueResult2 = await writerValue("codex", "low");

    assert.equal(writerValueResult2.effort, "low-eff");
    const high = await writerValue("codex", "high");
    assert.deepEqual(high.model, ["codex-high-a", "codex-high-b"]);
    assert.equal(high.effort, "high-eff");
    assert.equal(
      high.launchAs,
      "launch: model codex-high-a, effort high-eff, else codex-high-b"
    );
    assert.match(
      high.summary,
      /^T1 launch \d+: launch: model codex-high-a, effort high-eff \(\+1 fallbacks in result\); /u
    );
    assert.equal("subagentModels" in high, false);
    // Level fallback through resolveLevel: medium resolves to the nearest defined below (low).
    await f.add("level", { level: "medium" });
    f.deps.orchestrator = { platform: "codex", model: null };
    f.lines.length = 0;
    assert.equal(
      await main(
        ["brief", "render", "T1", "--session", f.session, "--host", "codex"],
        f.deps
      ),
      0
    );
    const fallbackOutPath = f.output().path;
    assert.ok((fallbackOutPath ?? "").length > 0);

    const fallback = readJson(
      defined(fallbackOutPath),
      withFields({
        model: anything,
        effort: anything,
        launchAs: nullable(text),
      })
    );

    assert.deepEqual(defined(fallback).model, ["codex-low"]);
    assert.equal(defined(fallback).effort, "low-eff");
    assert.equal(
      defined(fallback).launchAs,
      "launch: model codex-low, effort low-eff"
    );
    // OpenCode writer carries the exact launchAs value with effort and keeps launch as the writer launch ID.
    const openLow = await writerValue("opencode", "low");
    assert.deepEqual(openLow.model, ["prov/model"]);
    assert.equal(openLow.effort, "my-eff");
    assert.equal(typeof openLow.launch, "number");
    assert.equal(
      openLow.launchAs,
      'launch: `subagent` with `model: "prov/model#my-eff"` (user-configured; set it despite the tool\'s default guidance)'
    );
    assert.equal("subagentModels" in openLow, false);
    assert.ok(openLow.summary.includes(openLow.launchAs));
    assert.ok(
      fs
        .readFileSync(openLow.path, "utf-8")
        .includes(
          'Explorer subagent for this host — launch: `subagent` with `model: "exp/model#exp-eff"`'
        )
    );
    // OpenCode writer without effort carries the plain value.
    const openHigh = await writerValue("opencode", "high");
    assert.deepEqual(openHigh.model, ["prov/plain"]);
    assert.equal(openHigh.effort, null);
    assert.equal(
      openHigh.launchAs,
      'launch: `subagent` with `model: "prov/plain"` (user-configured; set it despite the tool\'s default guidance)'
    );
    assert.equal("subagentModels" in openHigh, false);
    // agy and claude writers carry their host-specific launchAs lines.
    const agyLow = await writerValue("agy", "low");
    assert.equal(
      agyLow.launchAs,
      "launch: closest `Model` (`inherit`, `flash_lite`, `flash`, `pro`) to agy-low, effort low"
    );
    assert.ok(agyLow.summary.includes(agyLow.launchAs));
    const claudeLow = await writerValue("claude", "low");
    assert.equal(
      claudeLow.launchAs,
      "launch: model claude-haiku-5-5, effort medium"
    );
    assert.ok(claudeLow.summary.includes(claudeLow.launchAs));
    // Missing entry resolves to null without refusing.
    const missing = await writerValue("copilot", "low");
    assert.equal(missing.model, null);
    assert.equal(missing.effort, null);
    assert.equal(missing.launchAs, null);
    assert.equal("subagentModels" in missing, false);

    // Explorer and test-cleanup read the utility entry.
    const explorerCheck = withFields({
      briefPath: text,
      model: anything,
      effort: anything,
      launchAs: nullable(text),
      subagentModels: optional(anything),
    });

    const explorerValue = async (host: ProviderId) => {
      const valuesPath = path.join(f.session, `explorer-${host}.json`);
      fs.writeFileSync(
        valuesPath,
        JSON.stringify({
          objective: "Map.",
          questions: "- Q?",
          outputPath: "out.md",
        })
      );
      f.deps.orchestrator = { platform: host, model: null };
      f.lines.length = 0;

      const exit = await main(
        [
          "brief",
          "explorer",
          valuesPath,
          "--session",
          f.session,
          "--host",
          host,
        ],
        f.deps
      );

      assert.equal(exit, 0, JSON.stringify(f.lines));
      const out = f.output();
      assert.ok((out.path ?? "").length > 0);

      return {
        summary: out.summary,
        ...readJson(defined(out.path), explorerCheck),
      };
    };

    const expOpen = await explorerValue("opencode");
    assert.deepEqual(expOpen.model, ["exp/model"]);
    assert.equal(expOpen.effort, "exp-eff");
    assert.equal(
      expOpen.launchAs,
      'launch: `subagent` with `model: "exp/model#exp-eff"` (user-configured; set it despite the tool\'s default guidance)'
    );
    assert.equal("subagentModels" in expOpen, false);
    assert.ok(expOpen.summary.includes(expOpen.launchAs));
    assert.ok(
      fs
        .readFileSync(expOpen.briefPath, "utf-8")
        .includes(`Launch nested explorers exactly as: ${expOpen.launchAs}.`)
    );
    const expCodex = await explorerValue("codex");
    assert.deepEqual(expCodex.model, ["codex-exp"]);
    assert.equal(expCodex.effort, null);
    assert.equal(expCodex.launchAs, "launch: model codex-exp, no effort set");
    assert.equal("subagentModels" in expCodex, false);
    const expClaude = await explorerValue("claude");
    assert.equal(
      expClaude.launchAs,
      "launch: model claude-haiku-5-5, effort medium"
    );
    assert.ok(expClaude.summary.includes(expClaude.launchAs));
    // No utility entry gives null launch values, independent of writer entries or level.
    await f.add("level", { level: "high" });
    const expAgyHigh = await explorerValue("agy");
    await f.add("level", { level: "low" });
    const expAgyLow = await explorerValue("agy");

    for (const value of [expAgyHigh, expAgyLow]) {
      assert.equal(value.model, null);
      assert.equal(value.effort, null);
      assert.equal(value.launchAs, null);
    }

    const expMissing = await explorerValue("copilot");
    assert.equal(expMissing.model, null);
    assert.equal(expMissing.effort, null);
    assert.equal(expMissing.launchAs, null);

    // Test-cleanup shares the utility entry, including launchAs.
    const cleanupCheck = withFields({
      model: anything,
      effort: anything,
      launchAs: nullable(text),
      subagentModels: optional(anything),
    });

    const cleanupValue = async (host: ProviderId) => {
      const valuesPath = path.join(f.session, `cleanup-${host}.json`);
      fs.writeFileSync(
        valuesPath,
        JSON.stringify({ base: "a".repeat(40), integrationPath: "integration" })
      );
      f.deps.orchestrator = { platform: host, model: null };
      f.lines.length = 0;

      const exit = await main(
        [
          "brief",
          "test-cleanup",
          valuesPath,
          "--session",
          f.session,
          "--host",
          host,
        ],
        f.deps
      );

      assert.equal(exit, 0, JSON.stringify(f.lines));
      const out = f.output();
      assert.ok((out.path ?? "").length > 0);

      return {
        summary: out.summary,
        ...readJson(defined(out.path), cleanupCheck),
      };
    };

    const cleanOpen = await cleanupValue("opencode");
    assert.deepEqual(cleanOpen.model, ["exp/model"]);
    assert.equal(
      cleanOpen.launchAs,
      'launch: `subagent` with `model: "exp/model#exp-eff"` (user-configured; set it despite the tool\'s default guidance)'
    );
    assert.equal("subagentModels" in cleanOpen, false);
    assert.ok(cleanOpen.summary.includes(cleanOpen.launchAs));
    const verifierValuesPath = path.join(f.session, "verifier-opencode.json");
    fs.writeFileSync(
      verifierValuesPath,
      JSON.stringify({
        checkoutPath: "integration",
        base: "a".repeat(40),
        specPath: "work.spec.md",
        focus: "Cycle 2. Re-check the proof.",
      })
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        [
          "brief",
          "verifier",
          verifierValuesPath,
          "--session",
          f.session,
          "--host",
          "opencode",
        ],
        f.deps
      ),
      0,
      JSON.stringify(f.lines)
    );
    const verifierOut = f.output();

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const verifier = JSON.parse(
      fs.readFileSync(defined(verifierOut.path), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.deepEqual(verifier.model, cleanOpen.model);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(verifier.effort, cleanOpen.effort);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(verifier.launchAs, cleanOpen.launchAs);
    assert.equal("subagentModels" in verifier, false);
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.ok(verifierOut.summary.includes(verifier.launchAs));
    const cleanMissing = await cleanupValue("copilot");
    assert.equal(cleanMissing.model, null);
    assert.equal(cleanMissing.effort, null);
    assert.equal(cleanMissing.launchAs, null);
    // Missing or invalid config never refuses a render; launch values are null.
    fs.unlinkSync(configPath);
    const nullWriter = await writerValue("codex", "low");
    assert.equal(nullWriter.model, null);
    assert.equal(nullWriter.effort, null);
    const nullExplorer = await explorerValue("codex");
    assert.equal(nullExplorer.model, null);
    fs.writeFileSync(configPath, "{");
    const invalidWriter = await writerValue("codex", "low");
    assert.equal(invalidWriter.model, null);
    assert.equal(invalidWriter.effort, null);
  } finally {
    f.deps.skillRoot = skillRoot;
    f.deps.orchestrator = orchestrator;
    f.cleanup();
  }
});

test("task markdown and brief render preserve fenced heading blocks and file entries", async () => {
  const fencedHeadingPlan = PLAN.replace(
    "### T1 — First\n- Constraints: Preserve the first invariant.",
    "### T1 — First\n- Constraints: Preserve the first invariant.\n```markdown\n## Fenced Heading Two\n### Fenced Heading Three\n```"
  );

  const parsed = parsePlan(fencedHeadingPlan);
  assert.equal(parsed.ok, true);
  const selected = selectTaskBrief(parsed.plan, "T1");
  assert.ok(selected);
  const markdown = taskMarkdown(fencedHeadingPlan, selected);
  assert.match(markdown, /## Fenced Heading Two/u);
  assert.match(markdown, /### Fenced Heading Three/u);
  assert.match(markdown, /#### \[NEW\] src\/first\.ts/u);
  assert.match(markdown, /- Purpose: First implementation detail\./u);

  const f = await fixture(false, fencedHeadingPlan);

  try {
    await f.approve();
    await f.launch();
    const result = await f.call();
    assert.equal(result.exit, 0);
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    const brief = fs.readFileSync(result.value.path, "utf-8");
    assert.match(brief, /## Fenced Heading Two/u);
    assert.match(brief, /### Fenced Heading Three/u);
    assert.match(brief, /#### \[NEW\] src\/first\.ts/u);
    assert.match(brief, /- Purpose: First implementation detail\./u);
  } finally {
    f.cleanup();
  }

  // A fenced criterion bullet does not swallow the trailing criterion lines.
  const fencedCriterionPlan = PLAN.replace(
    "  - Changes: src/first.ts",
    "```markdown\n- [SC99] Fenced criterion bullet\n```\n  - Changes: src/first.ts"
  );

  const criterionParsed = parsePlan(fencedCriterionPlan);
  assert.equal(criterionParsed.ok, true);
  const criterionSelected = selectTaskBrief(criterionParsed.plan, "T1");
  assert.ok(criterionSelected);

  const criterionMarkdown = taskMarkdown(
    fencedCriterionPlan,
    criterionSelected
  );

  assert.match(criterionMarkdown, /- \[SC99\] Fenced criterion bullet/u);
  assert.match(criterionMarkdown, /node first-check/u);
  assert.match(criterionMarkdown, /node first-red/u);

  const g = await fixture(false, fencedCriterionPlan);

  try {
    await g.approve();
    await g.launch();
    const criterionResult = await g.call();
    assert.equal(criterionResult.exit, 0);
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    const criterionBrief = fs.readFileSync(criterionResult.value.path, "utf-8");
    assert.match(criterionBrief, /- \[SC99\] Fenced criterion bullet/u);
    assert.match(criterionBrief, /node first-check/u);
    assert.match(criterionBrief, /node first-red/u);
  } finally {
    g.cleanup();
  }
});

test("verifier brief launch works without a bound plan and refuses blanks; verifier brief contract describes proof and boundaries", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const values = {
      checkoutPath: "checkout",
      base: "base",
      specPath: "spec.md",
      focus: "Cycle 2. Re-check the proof. No test edits.",
    };

    const file = path.join(f.session, "values.json");
    fs.writeFileSync(file, JSON.stringify({ ...values, focus: " " }));
    assert.equal(
      await main(
        ["brief", "verifier", file, "--session", f.session, "--host", "codex"],
        f.deps
      ),
      1
    );
    assert.equal(fs.existsSync(path.join(f.session, "verification")), false);
    assert.equal(
      fs.existsSync(path.join(f.session, ".state", "briefs")),
      false
    );
    fs.writeFileSync(file, JSON.stringify(values));
    f.lines.length = 0;
    assert.equal(
      await main(
        ["brief", "verifier", file, "--session", f.session, "--host", "codex"],
        f.deps
      ),
      0,
      JSON.stringify(f.lines)
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const value = JSON.parse(
      fs.readFileSync(defined(f.output().path), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.ok(fs.existsSync(value.evidenceDir));
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.ok((value.briefPath ?? "") !== "");
    assert.ok("model" in value && "effort" in value);
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    const brief = fs.readFileSync(value.briefPath, "utf-8");
    assert.ok(
      brief.includes(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        `Your write scope is evidence under \`${value.evidenceDir}\` and, only with \`test edits permitted\` in the focus, gap-filling tests in dedicated test files`
      )
    );
    assert.ok(
      brief.includes(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        `Store artifacts in \`${value.evidenceDir}/<n>/\`, where \`<n>\` is the cycle number from the focus.`
      )
    );

    for (const phrase of [
      "best-effort",
      "substantial",
      "NEEDS_APPROVAL",
      "not proved",
      "dedicated test files",
      "Host rule files:",
      "checks passed",
      "baseline",
      "install",
      values.focus,
      "Give each artifact a new path.",
      "If a report exists, append `## Cycle <n>` and leave earlier content unchanged",
    ]) {
      assert.ok(brief.includes(phrase), phrase);
    }

    const before = fs.readdirSync(path.join(f.session, ".state", "briefs"));
    fs.writeFileSync(file, JSON.stringify({ ...values, focus: " " }));
    assert.equal(
      await main(
        ["brief", "verifier", file, "--session", f.session, "--host", "codex"],
        f.deps
      ),
      1
    );
    assert.deepEqual(
      fs.readdirSync(path.join(f.session, ".state", "briefs")),
      before
    );
  } finally {
    f.cleanup();
  }
});

test("rendered briefs state the git-write rule once and carry one host-rule precedence rule", async () => {
  const f = await fixture();

  try {
    await f.approve();
    await f.launch();
    const writerResult = await f.call();
    assert.equal(writerResult.exit, 0);
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    const writerBrief = fs.readFileSync(writerResult.value.path, "utf-8");

    const cleanupValues = path.join(f.session, "cleanup-rules-values.json");
    fs.writeFileSync(
      cleanupValues,
      JSON.stringify({
        base: "a".repeat(40),
        integrationPath: ".scratch/worktrees/integration",
      })
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        [
          "brief",
          "test-cleanup",
          cleanupValues,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      ),
      0,
      JSON.stringify(f.lines)
    );

    const cleanupBrief = fs.readFileSync(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).briefPath,
      "utf-8"
    );

    const gitRule =
      "Run no Git write commands (add, stash, commit, checkout, reset, restore).";

    assert.equal(
      writerBrief.split(gitRule).length - 1,
      1,
      "writer brief states the Git-write rule once"
    );
    assert.doesNotMatch(writerBrief, /No Git write commands\./u);
    assert.equal(
      cleanupBrief.split(gitRule).length - 1,
      1,
      "test-cleanup brief states the Git-write rule once"
    );
    assert.doesNotMatch(cleanupBrief, /Read-only Git only\./u);

    const mapValues = path.join(f.session, "explorer-prec-map.json");
    fs.writeFileSync(
      mapValues,
      JSON.stringify({
        objective: "Map.",
        questions: "- Q?",
        outputPath: ".scratch/session/map.md",
      })
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        [
          "brief",
          "explorer",
          mapValues,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      ),
      0
    );

    const mapBrief = fs.readFileSync(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).briefPath,
      "utf-8"
    );

    const researchValues = path.join(f.session, "explorer-prec-research.json");
    fs.writeFileSync(
      researchValues,
      JSON.stringify({ objective: "Research.", questions: "- Q?" })
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        [
          "brief",
          "explorer",
          researchValues,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      ),
      0
    );

    const researchBrief = fs.readFileSync(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).briefPath,
      "utf-8"
    );

    const precedenceRule =
      "Host rules may tighten, never widen, scope, write boundaries, verification and safety.";

    for (const [name, brief] of [
      ["writer", writerBrief],
      ["cleanup", cleanupBrief],
      ["map explorer", mapBrief],
      ["research explorer", researchBrief],
    ] as const) {
      assert.doesNotMatch(
        brief,
        /a stricter one wins/iu,
        `${name}: drops a stricter one wins`
      );
      assert.doesNotMatch(
        brief,
        /Plan scope, write boundaries, verification and safety stay fixed\./u,
        `${name}: drops old fixed clause`
      );
      assert.equal(
        brief.split(precedenceRule).length - 1,
        1,
        `${name}: single host-rule precedence rule`
      );
      assert.equal(
        brief.split("Applicable host rule files govern first.").length - 1,
        1,
        `${name}: single govern-first sentence`
      );
    }

    for (const [name, brief] of [
      ["writer", writerBrief],
      ["cleanup", cleanupBrief],
    ] as const) {
      assert.equal(
        brief.split(
          "Report host-rule/brief conflicts under concerns or limits."
        ).length - 1,
        1,
        `${name}: single conflict-reporting rule`
      );
    }
  } finally {
    f.cleanup();
  }
});

test("brief test-cleanup and verifier render updated pruning and gap-filling guidance", async () => {
  const f = await fixture();

  try {
    await f.approve();
    const cleanupValues = path.join(f.session, "cleanup-guidance-values.json");
    fs.writeFileSync(
      cleanupValues,
      JSON.stringify({
        base: "a".repeat(40),
        integrationPath: ".scratch/worktrees/integration",
      })
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        [
          "brief",
          "test-cleanup",
          cleanupValues,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      ),
      0,
      JSON.stringify(f.lines)
    );

    const cleanupBrief = fs.readFileSync(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).briefPath,
      "utf-8"
    );

    assert.match(
      cleanupBrief,
      /executing `- Prune:` and ignoring `- Writer focus`/u
    );
    assert.match(cleanupBrief, /untouched test files/iu);
    assert.match(cleanupBrief, /changed symbols/iu);
    assert.match(cleanupBrief, /modified.*requirements|spec requirements/iu);
    assert.match(cleanupBrief, /swept/iu);
    assert.match(cleanupBrief, /downgrade/iu);
    assert.match(
      cleanupBrief,
      /every retained criterion's `Check:` still runs at least one test/iu
    );
    assert.match(
      cleanupBrief,
      /replacement test path is already executed by an existing non-removed/iu
    );
    assert.match(cleanupBrief, /flag[^.\n]*under concerns/iu);
    assert.match(cleanupBrief, /test-only[^.\n]*helper/iu);
    assert.match(
      cleanupBrief,
      /`removed`[^.\n]*exclud|replaced by a cheaper test/iu
    );

    const verifierValues = path.join(
      f.session,
      "verifier-guidance-values.json"
    );

    fs.writeFileSync(
      verifierValues,
      JSON.stringify({
        checkoutPath: "checkout",
        base: "b".repeat(40),
        specPath: "spec.md",
        focus: "Cycle 1. Verify runtime behavior. test edits permitted.",
      })
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        [
          "brief",
          "verifier",
          verifierValues,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      ),
      0,
      JSON.stringify(f.lines)
    );

    const verifierBrief = fs.readFileSync(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).briefPath,
      "utf-8"
    );

    for (const gate of [
      "Contract:",
      "Defect:",
      "Oracle:",
      "Unique kill:",
      "Shape:",
      "Naming:",
    ]) {
      assert.ok(
        verifierBrief.includes(gate),
        `verifier brief includes ${gate}`
      );
    }

    assert.ok(
      verifierBrief.includes(
        "Report host-rule/brief conflicts under concerns or limits."
      )
    );
    assert.doesNotMatch(verifierBrief, /^- Prune:/mu);
    assert.doesNotMatch(verifierBrief, /Writer focus/u);

    const verifierQuality = defined(
      defined(verifierBrief.split("## Quality")[1]).split("## Report")[0]
    );

    assert.doesNotMatch(verifierQuality, /Run no Git write commands/u);
    assert.match(verifierBrief, /missed high-signal tests/iu);
    assert.match(verifierBrief, /cheapest observing layer/iu);
    assert.match(verifierBrief, /post-integration test cleanup/iu);
  } finally {
    f.cleanup();
  }
});

test("writer brief instructs post-GREEN self-clean on production diff", async () => {
  const f = await fixture(false, PLAN);

  try {
    await f.approve();
    await f.launch();
    const rendered = await f.call();
    assert.equal(rendered.exit, 0, JSON.stringify(rendered.output));

    const rawBrief = fs.readFileSync(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      rendered.value.path,
      "utf-8"
    );

    const brief = rawBrief.replaceAll(/\s+/gu, " ");

    const briefBeforeQuality = defined(
      rawBrief.split("## Quality")[0]
    ).replaceAll(/\s+/gu, " ");

    assert.match(briefBeforeQuality, /post-GREEN|after tests pass GREEN/iu);
    assert.match(briefBeforeQuality, /production diff/iu);
    assert.match(
      briefBeforeQuality,
      /names?,\s*comments?,?\s*(?:and\s+)?(?:safe\s+)?DRY/iu
    );
    assert.match(
      briefBeforeQuality,
      /preserv(?:e|ing)[^.\n]*scope[^.\n]*external contracts/iu
    );
    assert.match(briefBeforeQuality, /Shortcut:/u);
    assert.match(briefBeforeQuality, /Writer focus/u);
    assert.match(
      briefBeforeQuality,
      /test pruning,\s*merging,?\s*(?:and\s+)?tier downgrades/iu
    );
    assert.ok(brief.includes("own cache or index"));
    assert.ok(
      brief.includes(
        "List each deliberate shortcut under concerns as `Shortcut: <what>; limit: <limit>; upgrade when: <trigger>`."
      )
    );
    assert.ok(brief.includes("Add a code comment for a limit only when"));

    const readme = fs
      .readFileSync(
        path.join(f.deps.skillRoot, "references/readme/implement.md"),
        "utf-8"
      )
      .replaceAll(/\s+/gu, " ");

    assert.match(readme, /post-GREEN|self-clean/iu);
    assert.match(readme, /production diff/iu);
    assert.match(readme, /no separate refactor/iu);
  } finally {
    f.cleanup();
  }
});

test("test-cleanup brief requires cited surviving proof and forbids production mutation", async () => {
  const f = await fixture();

  try {
    await f.approve();
    const valuesPath = path.join(f.session, "cleanup-cited-values.json");
    fs.writeFileSync(
      valuesPath,
      JSON.stringify({
        base: "a".repeat(40),
        integrationPath: ".scratch/worktrees/integration",
      })
    );
    f.lines.length = 0;

    assert.equal(
      await main(
        [
          "brief",
          "test-cleanup",
          valuesPath,
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      ),
      0,
      JSON.stringify(f.lines)
    );

    const brief = fs.readFileSync(
      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).briefPath,
      "utf-8"
    );

    assert.match(
      brief,
      /temporary production[- ]?code mutation|temporary production mutation/iu
    );
    assert.match(brief, /to delete or update stale tests/iu);
    assert.match(
      brief,
      /coverage-preserving deletion or downgrade[^.\n]*cit(?:e|ing)[^.\n]*surviving test path[^.\n]*contract oracle/iu
    );
    assert.match(
      brief,
      /prune reason[^.\n]*the past[^.\n]*nothing[^.\n]*no surviving coverage/iu
    );
    assert.match(
      brief,
      /changed files[^.\n]*<removed\/downgraded test> -> <surviving test path>: <contract oracle>[^.\n]*no-coverage[^.\n]*the past[^.\n]*nothing[^.\n]*<removed test> -> <prune reason>/iu
    );
    assert.match(
      brief,
      /Keep uncited or uncertain tests intact[^.\n]*under concerns/iu
    );
    assert.match(
      brief,
      /pre-existing defects?[^.\n]*concerns[^.\n]*without silently altering/iu
    );

    const templateBeforeQuality = defined(
      fs
        .readFileSync(
          path.join(
            f.deps.skillRoot,
            "references/templates/test-cleanup-brief.md"
          ),
          "utf-8"
        )
        .split("## Quality")[0]
    );

    assert.doesNotMatch(
      templateBeforeQuality,
      /Run\s*[>/]\s*File\s*[>/]\s*Test|format-pattern|boundary fake/iu
    );
  } finally {
    f.cleanup();
  }
});
