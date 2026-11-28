import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { defined } from "../../helpers/guards.ts";
import { jsonObject, narrow, readJson, text } from "./helpers/json.ts";
import type { JsonObject } from "./helpers/json.ts";
import { sessionFixture, useMemoryAtomicWrite } from "./helpers/session.ts";

describe("toolkit CLI rulings contract", () => {
  test("plan and design ruling appends update only the matching findings section", async () => {
    const f = sessionFixture({ memory: true });
    const restoreAtomicWrite = useMemoryAtomicWrite();

    try {
      const spec = f.artifact(
        "mission.spec.md",
        "# Mission\n## Intent & Problem\nKeep work recoverable.\n"
      );

      const plan = f.artifact(
        "work.plan.md",
        "# Work\n\n## Review Findings & Resolutions\nPlan driver note.\n\n## Next\nPlan stays intact.\n"
      );

      const design = f.artifact(
        "strategy.design.md",
        "# Strategy\n\n## Review Findings & Resolutions\nDesign driver note.\n\n## Next\nDesign stays intact.\n"
      );

      const append = async (name: string, record: JsonObject) => {
        const file = path.join(f.root, `${name}.json`);
        fs.writeFileSync(file, JSON.stringify(record));
        f.lines.length = 0;

        const exit = await main(
          ["ledger", "append", file, "--session", f.session],
          f.deps
        );

        const output = f.output();

        return {
          exit,
          output,
          value: readJson(defined(output.path), jsonObject),
        };
      };

      const relative = (file: string) =>
        path.relative(f.root, file).split(path.sep).join("/");

      await append("bind", {
        kind: "bind",
        by: "orchestrator",
        key: "bind",
        data: {
          spec: relative(spec),
          plan: relative(plan),
          design: relative(design),
        },
      });

      const seedRound = (review: string) => {
        const directory = path.join(
          f.session,
          ".state",
          "reviews",
          review,
          "round-1"
        );

        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "round.json"),
          JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [] })
        );
        fs.writeFileSync(
          path.join(directory, "findings.json"),
          JSON.stringify({
            review,
            round: 1,
            findings: [{ id: "R1-F001", severity: "SHOULD" }],
          })
        );
      };

      const planReview = "plan-work.plan";
      seedRound(planReview);
      const designBefore = fs.readFileSync(design, "utf-8");

      const planResult = await append("plan-ruling", {
        kind: "ruling",
        by: "orchestrator",
        key: "plan-ruling",
        data: {
          subject: `review:${planReview}:R1-F001`,
          ruling: "accepted",
          fix: "proposed",
          rationale: "Plan fix applied",
        },
      });

      assert.equal(planResult.exit, 0);
      assert.equal(
        planResult.value["findingsSection"],
        "updated",
        JSON.stringify(planResult.value)
      );
      assert.match(
        fs.readFileSync(plan, "utf-8"),
        /Round 1 \(plan-work\.plan\): 1 findings/u
      );
      assert.equal(fs.readFileSync(design, "utf-8"), designBefore);

      const planAfter = fs.readFileSync(plan, "utf-8");
      const designReview = "design-strategy.design";
      seedRound(designReview);

      const designResult = await append("design-ruling", {
        kind: "ruling",
        by: "orchestrator",
        key: "design-ruling",
        data: {
          subject: `review:${designReview}:R1-F001`,
          ruling: "deferred",
          rationale: "Design needs follow-up",
        },
      });

      assert.equal(designResult.exit, 0);
      assert.equal(designResult.value["findingsSection"], "updated");
      assert.match(
        fs.readFileSync(design, "utf-8"),
        /Round 1 \(design-strategy\.design\): 1 findings/u
      );
      assert.equal(fs.readFileSync(plan, "utf-8"), planAfter);
    } finally {
      restoreAtomicWrite();
      f.cleanup();
    }
  });

  test("deduped ruling retry refreshes a skipped findings section", async () => {
    const f = sessionFixture({ memory: true });
    const restoreAtomicWrite = useMemoryAtomicWrite();

    try {
      const spec = f.artifact(
        "mission.spec.md",
        "# Mission\n## Intent & Problem\nKeep work recoverable.\n"
      );

      const plan = f.artifact(
        "work.plan.md",
        "# Work\n\n## Review Findings & Resolutions\nDriver note.\n"
      );

      const append = async (record: JsonObject) => {
        const file = path.join(f.root, "ruling.json");
        fs.writeFileSync(file, JSON.stringify(record));
        f.lines.length = 0;

        const exit = await main(
          ["ledger", "append", file, "--session", f.session],
          f.deps
        );

        const output = f.output();

        return {
          exit,
          output,
          value: readJson(defined(output.path), jsonObject),
        };
      };

      const relative = (file: string) =>
        path.relative(f.root, file).split(path.sep).join("/");

      await append({
        kind: "bind",
        by: "orchestrator",
        key: "bind",
        data: { spec: relative(spec), plan: relative(plan) },
      });
      const review = "plan-work.plan";

      const directory = path.join(
        f.session,
        ".state",
        "reviews",
        review,
        "round-1"
      );

      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "round.json"),
        JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [] })
      );
      fs.writeFileSync(
        path.join(directory, "findings.json"),
        JSON.stringify({
          review,
          round: 1,
          findings: [{ id: "R1-F001", severity: "SHOULD" }],
        })
      );

      const ruling = {
        kind: "ruling",
        by: "orchestrator",
        key: "retry-ruling",
        data: {
          subject: `review:${review}:R1-F001`,
          ruling: "accepted",
          fix: "proposed",
          rationale: "Repair completed",
        },
      };

      fs.rmSync(plan);
      const skipped = await append(ruling);
      assert.equal(skipped.exit, 0);
      assert.equal(skipped.value["findingsSection"], "skipped");
      assert.match(
        narrow(skipped.value["findingsSectionReason"], text),
        /read|missing|bound|ENOENT/iu
      );

      fs.writeFileSync(
        plan,
        "# Work\n\n## Review Findings & Resolutions\nDriver note.\n"
      );
      const retried = await append(ruling);
      assert.equal(retried.exit, 0);
      assert.equal(retried.value["deduped"], true);
      assert.equal(retried.value["findingsSection"], "updated");
      assert.match(
        fs.readFileSync(plan, "utf-8"),
        /Round 1 \(plan-work\.plan\): 1 findings/u
      );
    } finally {
      restoreAtomicWrite();
      f.cleanup();
    }
  });

  test("bind renders findings only after a completed review", async () => {
    // bind after a completed review renders its findings section
    {
      const f = sessionFixture({ memory: true });
      const restoreAtomicWrite = useMemoryAtomicWrite();

      try {
        f.artifact("mission.spec.md", "# Mission\n");

        const plan = f.artifact(
          "work.plan.md",
          "# Work\n\n## Review Findings & Resolutions\n*No reviews conducted yet.*\n"
        );

        const directory = path.join(
          f.session,
          ".state",
          "reviews",
          "plan-work.plan",
          "round-1"
        );

        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "round.json"),
          JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [] })
        );
        fs.writeFileSync(
          path.join(directory, "findings.json"),
          JSON.stringify({
            review: "plan-work.plan",
            round: 1,
            findings: [{ id: "R1-F001", severity: "SHOULD" }],
          })
        );
        const file = path.join(f.root, "bind.json");
        fs.writeFileSync(
          file,
          JSON.stringify({
            kind: "bind",
            by: "orchestrator",
            key: "bind",
            data: { spec: "mission.spec.md", plan: "work.plan.md" },
          })
        );
        assert.equal(
          await main(
            ["ledger", "append", file, "--session", f.session],
            f.deps
          ),
          0
        );
        const value = readJson(defined(f.output().path), jsonObject);
        assert.equal(
          value["findingsSection"],
          "updated",
          JSON.stringify(value)
        );
        assert.match(
          fs.readFileSync(plan, "utf-8"),
          /Round 1 \(plan-work\.plan\): 1 findings/u
        );
      } finally {
        restoreAtomicWrite();
        f.cleanup();
      }
    }

    // bind before any review leaves the artifact unchanged
    {
      const f = sessionFixture({ memory: true });

      try {
        f.artifact("mission.spec.md", "# Mission\n");
        const source = "# Work\n\nNo findings section yet.\n";
        const plan = f.artifact("work.plan.md", source);
        const file = path.join(f.root, "bind.json");
        fs.writeFileSync(
          file,
          JSON.stringify({
            kind: "bind",
            by: "orchestrator",
            key: "bind",
            data: { spec: "mission.spec.md", plan: "work.plan.md" },
          })
        );
        assert.equal(
          await main(
            ["ledger", "append", file, "--session", f.session],
            f.deps
          ),
          0
        );
        const value = readJson(defined(f.output().path), jsonObject);
        assert.equal("findingsSection" in value, false);
        assert.equal(fs.readFileSync(plan, "utf-8"), source);
      } finally {
        f.cleanup();
      }
    }
  });
});
