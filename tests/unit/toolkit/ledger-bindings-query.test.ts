import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  appendRecord,
  foldLedger,
  latest,
  queryLedger,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { KINDS } from "../../../skills/dispatch/scripts/toolkit/records.ts";
import { defined } from "../../helpers/guards.ts";
import type { JsonObject } from "./helpers/json.ts";
import { narrow, refusal } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

test("ledger bindings preserve rulings queries and input validation", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const input = f.artifact("record.json", "");
    let n = 0;

    const call = async (record: unknown) => {
      f.lines.length = 0;
      fs.writeFileSync(input, JSON.stringify(record));

      const exit = await main(
        ["ledger", "append", "--session", f.session, input],
        f.deps
      );

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

    const add = async (
      kind: string,
      data: JsonObject,
      extra: JsonObject = {}
    ) =>
      await appendRecord(
        f.session,
        { kind, data, by: "orchestrator", key: `k${(n += 1) - 1}`, ...extra },
        f.deps
      );

    const hash = `sha256:${"a".repeat(64)}`;
    const git = "a".repeat(40);

    f.artifact("s.spec.md", "spec");
    f.artifact("p.plan.md", "plan");

    const binding = {
      kind: "bind",
      key: "bind",
      by: "orchestrator",
      data: { spec: "s.spec.md", plan: "p.plan.md" },
    };

    const callResult = await call(binding);

    assert.equal(callResult.exit, 0);

    for (const ruling of ["X", "Y", "X"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const addResult = await add("ruling", {
        subject: "s",
        ruling,
        rationale: "r",
      });

      assert.ok(addResult.seq > 0);
    }

    for (const state of ["open", "resolved", "open"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const addResult2 = await add("escalation", {
        id: "e",
        state,
        summary: "s",
      });

      assert.ok(addResult2.seq > 0);
    }

    assert.equal(
      latest(foldLedger(f.session), "escalation")?.data["state"],
      "open"
    );
    assert.equal(
      foldLedger(f.session).records.filter((r) => r.kind === "ruling").length,
      3
    );
    await assert.rejects(
      add("edit", {
        artifact: "design",
        before: hash,
        after: hash,
        class: "non-intent",
        affects: [],
        rationale: "r",
        diffRef: "d",
      }),
      (error: unknown) => {
        const failure = narrow(error, refusal);
        assert.equal(failure.reason, "invalid-record");
        assert.match(
          failure.message ?? "",
          /append a bind record that includes it first/iu
        );
        assert.match(
          failure.message ?? "",
          /currently bound artifact kinds:.*\bplan\b.*\bspec\b/iu
        );

        return true;
      }
    );
    fs.unlinkSync(path.join(f.root, "s.spec.md"));
    const callResult2 = await call(binding);

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(callResult2.value.deduped, true);

    for (const phase of ["deliver-started", "delivered"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const callResult3 = await call({
        kind: "integrate",
        key: phase,
        by: "tool",
        data: {
          phase,
          mode: "uncommitted",
          dest: { branch: "b", path: "p" },
          from: git,
          source: git,
        },
      });

      assert.equal(callResult3.exit, 0);
    }

    assert.equal(
      foldLedger(f.session).records.filter(
        (r) => r.kind === "integrate" && r.data["mode"] === "uncommitted"
      ).length,
      2
    );
    f.lines.length = 0;
    assert.equal(
      await main(
        ["ledger", "query", "--session", f.session, "--kind", "integrate"],
        f.deps
      ),
      0
    );
    assert.equal(
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).length,
      2
    );
    const folded = foldLedger(f.session);
    assert.equal(
      queryLedger(folded, { kind: "integrate", since: "0" }).length,
      2
    );
    assert.equal(
      queryLedger(folded, { since: defined(folded.records[0]).seq }).length,
      folded.records.length - 1
    );
    assert.equal(
      queryLedger(folded, { key: defined(folded.records[0]).key }).length,
      1
    );

    for (const filter of [{ kind: "bad" }, { since: "-1" }, { since: "wat" }]) {
      assert.throws(
        () => queryLedger(folded, filter),
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- assert.throws validator must stay synchronous; an async rewrite would change the assertion contract
        (error: unknown) => {
          const failure = narrow(error, refusal);
          assert.equal(failure.reason, "invalid-input");

          if (filter.kind === "bad") {
            assert.equal(
              failure.message,
              `filter.kind must be one of: ${KINDS.join(", ")}.`
            );
          } else {
            assert.equal(
              failure.message,
              "filter.since must be a nonnegative safe integer."
            );
          }

          return true;
        }
      );
    }

    f.lines.length = 0;
    assert.equal(
      await main(
        ["ledger", "query", "--session", f.session, "--kind", "bad"],
        f.deps
      ),
      1
    );
    assert.equal(f.output().reason, "invalid-input");

    for (const file of ["missing", f.root]) {
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(["ledger", "append", "--session", f.session, file], f.deps),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
      assert.equal(
        f.output().summary,
        `Cannot read record file ${path.resolve(file)}`
      );
    }

    for (const extra of [[], [input, input]]) {
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(
          ["ledger", "append", "--session", f.session, ...extra],
          f.deps
        ),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
      assert.match(f.output().summary, /ledger append <record\.json\|->/u);
    }

    fs.writeFileSync(input, "bad");
    f.lines.length = 0;
    assert.equal(
      await main(["ledger", "append", "--session", f.session, input], f.deps),
      1
    );
    assert.equal(f.output().reason, "invalid-input");
    assert.ok(
      f
        .output()
        .summary.startsWith(
          `Record file ${path.resolve(input)} is not valid JSON: `
        )
    );
    const ledger = path.join(f.session, "ledger.jsonl");
    const bytes = fs.readFileSync(ledger, "utf-8");
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const first = JSON.parse(defined(bytes.split("\n")[0]));
    fs.appendFileSync(ledger, `${JSON.stringify(first)}\n`);
    const corrupt = fs.readFileSync(ledger, "utf-8");
    await assert.rejects(add("note", { text: "n" }), {
      reason: "ledger-corrupt",
    });
    assert.equal(fs.readFileSync(ledger, "utf-8"), corrupt);
  } finally {
    f.cleanup();
  }
});

const run = async (text: string) => {
  const f = sessionFixture({ memory: true });

  try {
    const exit = await main(["ledger", "append", "--session", f.session, "-"], {
      ...f.deps,
      readStdin: () => text,
    });

    const output = f.output();

    return {
      exit,
      reason: output.reason,
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      value:
        (output.path ?? "").length > 0
          ? JSON.parse(fs.readFileSync(defined(output.path), "utf-8"))
          : null,
      records: foldLedger(f.session).records,
    };
  } finally {
    f.cleanup();
  }
};

test("stdin ledger appends validate records and preserve atomic batches", async () => {
  const single = JSON.stringify({
    kind: "note",
    by: "orchestrator",
    key: "one",
    data: { text: "one" },
  });

  const batch = JSON.stringify([
    { kind: "note", by: "orchestrator", key: "one", data: { text: "one" } },
    { kind: "note", by: "orchestrator", key: "two", data: { text: "two" } },
  ]);

  const invalidBatch = JSON.stringify([
    { kind: "note", by: "orchestrator", key: "one", data: { text: "one" } },
    { kind: "invalid" },
  ]);

  // Valid single, batch and BOM-prefixed batch append atomically.
  for (const text of [single, batch, `\uFEFF${batch}`]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const r = await run(text);
    assert.equal(r.exit, 0, text);
    assert.equal(r.records.length, text === single ? 1 : 2, text);
  }

  // Malformed stdin (including empty input) is invalid-input with no records.
  for (const text of ["bad", ""]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const r = await run(text);
    assert.equal(r.exit, 1, JSON.stringify(text));
    assert.equal(r.reason, "invalid-input");
    // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.match(r.value.message, /^Records from stdin are not valid JSON: /u);
    assert.deepEqual(r.records, []);
  }

  // Invalid records (including an empty batch) fail atomically with no records.
  for (const text of [invalidBatch, "[]"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const r = await run(text);
    assert.equal(r.reason, "invalid-record", text);
    assert.deepEqual(r.records, [], text);
  }

  // Unreadable stdin fails before validation.
  for (const readStdin of [
    undefined,
    () => {
      throw new Error("read failed");
    },
  ]) {
    const f = sessionFixture({ memory: true });

    try {
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(["ledger", "append", "--session", f.session, "-"], {
          ...f.deps,
          ...(readStdin && { readStdin }),
        }),
        1
      );
      assert.equal(f.output().reason, "invalid-input");
      assert.equal(f.output().summary, "Cannot read records from stdin");
      assert.deepEqual(foldLedger(f.session).records, []);
    } finally {
      f.cleanup();
    }
  }
});

test("ledger file appends match stdin validation results", async () => {
  const single = JSON.stringify({
    kind: "note",
    by: "orchestrator",
    key: "one",
    data: { text: "one" },
  });

  const batch = JSON.stringify([
    { kind: "note", by: "orchestrator", key: "one", data: { text: "one" } },
    { kind: "note", by: "orchestrator", key: "two", data: { text: "two" } },
  ]);

  const invalidBatch = JSON.stringify([
    { kind: "note", by: "orchestrator", key: "one", data: { text: "one" } },
    { kind: "invalid" },
  ]);

  for (const text of [single, batch, invalidBatch]) {
    const results = [];

    for (const stdin of [false, true]) {
      const f = sessionFixture({ memory: true });

      try {
        const file = f.artifact("record.json", text);

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const exit = await main(
          ["ledger", "append", "--session", f.session, stdin ? "-" : file],
          {
            ...f.deps,
            ...(stdin && { readStdin: () => text }),
          }
        );

        const output = f.output();
        results.push({
          exit,
          reason: output.reason,
          // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
          value:
            (output.path ?? "").length > 0
              ? JSON.parse(fs.readFileSync(defined(output.path), "utf-8"))
              : null,
          records: foldLedger(f.session).records,
        });
      } finally {
        f.cleanup();
      }
    }

    assert.deepEqual(results[1], results[0], text);
  }
});
