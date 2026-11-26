import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { defined } from "../../helpers/guards.ts";
import type { JsonObject } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

test("ledger bind suffixes match their keys while prior retries stay write-free", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const input = f.artifact("record.json", "");
    f.artifact("s.spec.md", "spec");
    f.artifact("p.plan.md", "plan");
    f.artifact("d.design.md", "design");

    const append = async (record: JsonObject) => {
      f.lines.length = 0;
      fs.writeFileSync(input, JSON.stringify(record));

      return await main(
        ["ledger", "append", "--session", f.session, input],
        f.deps
      );
    };

    const bind = {
      kind: "bind",
      key: "bind",
      by: "orchestrator",
      data: { spec: "s.spec.md", plan: "p.plan.md", design: "d.design.md" },
    };

    const ledger = path.join(f.session, "ledger.jsonl");

    for (const [kind, file] of [
      ["spec", "p.plan.md"],
      ["plan", "s.spec.md"],
      ["design", "p.plan.md"],
    ]) {
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await append({
          ...bind,
          data: { ...bind.data, [defined(kind)]: file },
        }),
        1
      );
      assert.equal(f.output().reason, "invalid-record");
      assert.match(
        f.output().summary,
        new RegExp(String.raw`data\.` + kind, "u")
      );
      assert.equal(fs.existsSync(ledger), false);
    }

    assert.equal(await append(bind), 0);
    const bytes = fs.readFileSync(ledger, "utf-8");
    fs.unlinkSync(path.join(f.root, "s.spec.md"));
    assert.equal(await append(bind), 0);
    assert.equal(fs.readFileSync(ledger, "utf-8"), bytes);

    const legacy = {
      ...bind,
      key: "legacy",
      data: { spec: "p.plan.md", plan: "p.plan.md" },
    };

    const prior = `${bytes + JSON.stringify({ ...legacy, seq: 2, at: "now" })}\n`;
    fs.writeFileSync(ledger, prior);
    assert.equal(await append(legacy), 0);
    assert.equal(
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      JSON.parse(fs.readFileSync(defined(f.output().path), "utf-8")).deduped,
      true
    );
    assert.equal(fs.readFileSync(ledger, "utf-8"), prior);
  } finally {
    f.cleanup();
  }
});

test("ledger records reject escaping links and allow contained links", async () => {
  const f = sessionFixture();
  const outside = sessionFixture();

  try {
    const input = f.artifact("record.json", "");
    const linked = path.join(f.root, "linked");
    // Junctions permit a linked-directory case on Windows without elevation.
    fs.symlinkSync(
      f.session,
      linked,
      process.platform === "win32" ? "junction" : "dir"
    );
    fs.writeFileSync(path.join(f.session, "s.spec.md"), "spec");
    f.artifact("p.plan.md", "plan");

    const append = async (key: string) => {
      f.lines.length = 0;
      fs.writeFileSync(
        input,
        JSON.stringify({
          kind: "bind",
          key,
          by: "orchestrator",
          data: { spec: "linked/s.spec.md", plan: "p.plan.md" },
        })
      );

      return await main(
        ["ledger", "append", "--session", f.session, input],
        f.deps
      );
    };

    assert.equal(await append("contained"), 0);
    outside.artifact("s.spec.md", "outside spec");
    fs.unlinkSync(linked);
    fs.symlinkSync(
      outside.root,
      linked,
      process.platform === "win32" ? "junction" : "dir"
    );
    assert.equal(await append("escaped"), 1);
    assert.equal(f.output().reason, "invalid-record");
    assert.match(f.output().summary, /data.spec/u);
    fs.unlinkSync(linked);
  } finally {
    f.cleanup();
    outside.cleanup();
  }
});
