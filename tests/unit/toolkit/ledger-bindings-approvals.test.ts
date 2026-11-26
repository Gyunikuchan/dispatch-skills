import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
  latest,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import type { JsonObject } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

test("ledger bindings validate paths and gate stale approvals", async () => {
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
    f.artifact("s.spec.md", "spec");
    f.artifact("p.plan.md", "plan");

    for (const spec of ["../escape", "C:/absolute", "missing"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await assert.rejects(add("bind", { spec, plan: "p.plan.md" }), {
        reason: "invalid-record",
      });
    }

    const badBind = await call({
      kind: "bind",
      key: "bad-bind",
      by: "orchestrator",
      data: { spec: "missing", plan: "p.plan.md" },
    });

    assert.equal(badBind.exit, 1);
    assert.equal(badBind.output.reason, "invalid-record");
    await assert.rejects(
      add("approval", { spec: hash, plan: hash }, { by: "user", quote: "yes" }),
      {
        reason: "invalid-record",
        message: /append a bind record/u,
      }
    );

    const binding = {
      kind: "bind",
      key: "bind",
      by: "orchestrator",
      data: { spec: "s.spec.md", plan: "p.plan.md" },
    };

    const callResult = await call(binding);

    assert.equal(callResult.exit, 0);
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), "bind"));
    await assert.rejects(
      add(
        "approval",
        { ...hashes, design: hash },
        { by: "user", quote: "yes" }
      ),
      {
        reason: "approval-stale",
      }
    );
    f.artifact("d.design.md", "design");

    const addResult = await add("bind", {
      ...binding.data,
      design: "d.design.md",
    });

    assert.ok(addResult.seq > 0);
    await assert.rejects(
      add("approval", hashes, { by: "user", quote: "yes" }),
      { reason: "approval-stale" }
    );
    const addResult2 = await add("bind", binding.data);

    assert.ok(addResult2.seq > 0);
    await assert.rejects(
      add("approval", { spec: hashes.spec }, { by: "user", quote: "yes" }),
      {
        reason: "invalid-record",
      }
    );

    const approval = {
      kind: "approval",
      key: "approval",
      by: "user",
      quote: "yes",
      data: hashes,
    };

    const approved = await call(approval);
    assert.equal(approved.exit, 0);
    f.artifact("p.plan.md", "changed");
    const callResult2 = await call(approval);

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(callResult2.value.seq, approved.value.seq);
    await assert.rejects(
      add("approval", hashes, { by: "user", quote: "yes" }),
      { reason: "approval-stale" }
    );
    f.artifact("p.plan.md", "plan");
    const callResult3 = await call({ ...approval, key: "approval-again" });

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.ok(callResult3.value.seq > approved.value.seq);
  } finally {
    f.cleanup();
  }
});
