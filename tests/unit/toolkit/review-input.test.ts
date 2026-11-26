import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { artifactHash } from "../../../skills/dispatch/scripts/toolkit/artifacts.ts";
import { defined } from "../../helpers/guards.ts";
import { CONTEXT_MAP, fixture } from "../../helpers/review-fixture.ts";
import { narrow, numeric, withFields, text } from "./helpers/json.ts";

// SECTION: Ceiling helpers shared with review.test.ts (duplicated for split)

test("plan and design review launch without a sibling context map", async () => {
  const f = await fixture();

  try {
    const orphan = f.artifact(
      "orphan.plan.md",
      "# Orphan\n## Work\nNo grounding.\n"
    );

    const plan = await f.call("plan", orphan);
    assert.equal(plan.exit, 0, JSON.stringify(plan));
    assert.equal(f.launches.length, 2);

    for (const launch of f.launches) {
      assert.doesNotMatch(
        fs.readFileSync(launch.request.promptPath, "utf-8"),
        /Context Map/u
      );
    }

    const design = f.artifact(
      "orphan.design.md",
      "# Design\n## Boundaries\nSingle writer.\n"
    );

    const designReview = await f.call("design", design);
    assert.equal(designReview.exit, 0, JSON.stringify(designReview));
    assert.equal(f.launches.length, 4);

    for (const launch of f.launches.slice(2)) {
      assert.doesNotMatch(
        fs.readFileSync(launch.request.promptPath, "utf-8"),
        /Context Map/u
      );
    }
  } finally {
    f.cleanup();
  }
});

test("plan and design review refuse without a user confirm of the current spec at every level", async () => {
  // Unbound plan review without a spec refuses with lint-errors before zero-round skip
  {
    const f = await fixture(false, false);

    try {
      const refused = await f.call("plan", f.plan, "low");
      assert.equal(refused.exit, 4);
      assert.equal(refused.output.reason, "lint-errors");
      assert.equal(f.launches.length, 0);
    } finally {
      f.cleanup();
    }
  }

  const f = await fixture(true, false);

  try {
    for (const level of ["low", "medium"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const refused = await f.call("plan", f.plan, level);
      assert.equal(refused.exit, 4, level);
      assert.equal(refused.output.reason, "missing-confirmation", level);
    }

    const design = f.artifact(
      "work.design.md",
      "# Design\n## Boundaries\nSingle writer.\n"
    );

    const refusedDesign = await f.call("design", design, "medium");
    assert.equal(refusedDesign.exit, 4);
    assert.equal(refusedDesign.output.reason, "missing-confirmation");
    assert.equal(f.launches.length, 0);
    await f.confirm();
    const callResult = await f.call();

    assert.equal(callResult.exit, 0);
    fs.appendFileSync(
      f.spec,
      "\n## Scope\nChanged intent without a recorded edit.\n"
    );
    const stale = await f.call();
    assert.equal(stale.exit, 4);
    assert.equal(stale.output.reason, "missing-confirmation");
  } finally {
    f.cleanup();
  }
});

test("plan and design reviewers read governed text without findings history", async () => {
  const f = await fixture();

  try {
    const original = fs.readFileSync(f.plan, "utf-8");
    const result = await f.call();
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    const inputPath = path.join(f.directory, "round-1.input.md");
    assert.ok(fs.existsSync(inputPath));
    const input = fs.readFileSync(inputPath, "utf-8");
    assert.doesNotMatch(input, /Review Findings & Resolutions/u);
    assert.doesNotMatch(input, /Driver log\./u);

    const prompt = fs.readFileSync(
      defined(f.launches[0]).request.promptPath,
      "utf-8"
    );

    assert.ok(prompt.includes(inputPath));
    assert.ok(prompt.includes(`- Plan: ${inputPath}`));
    assert.equal(
      narrow(f.read(1, "round.json"), withFields({ target: text })).target,
      artifactHash("plan", original)
    );
    assert.equal(path.basename(f.directory), "plan-work.plan");
    assert.equal(
      fs.readFileSync(
        path.join(f.directory, "round-1", "target.snapshot.md"),
        "utf-8"
      ),
      original
    );

    const design = f.artifact(
      "strategy.design.md",
      "# Strategy\n## Approach\nOne boundary.\n## Execution Status\nNext Action: act.\n## Review Findings & Resolutions\nDriver notes.\n"
    );

    f.artifact("strategy.design.context.md", CONTEXT_MAP);
    const designOriginal = fs.readFileSync(design, "utf-8");
    const designResult = await f.call("design", design);
    assert.equal(designResult.exit, 0, JSON.stringify(designResult.output));

    const reviewDir = path.join(
      f.session,
      ".state/reviews/design-strategy.design"
    );

    const designInputPath = path.join(reviewDir, "round-1.input.md");
    assert.ok(fs.existsSync(designInputPath));
    const designInput = fs.readFileSync(designInputPath, "utf-8");
    assert.doesNotMatch(designInput, /Review Findings & Resolutions/u);
    assert.doesNotMatch(designInput, /Driver notes\./u);
    assert.doesNotMatch(designInput, /## Execution Status/u);

    const designPrompt = fs.readFileSync(
      defined(f.launches.at(-1)).request.promptPath,
      "utf-8"
    );

    assert.ok(designPrompt.includes(designInputPath));
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(reviewDir, "round-1/round.json"), "utf-8")
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      ).target,
      artifactHash("design", designOriginal)
    );
  } finally {
    f.cleanup();
  }
});

test("reviewer input write failure refuses the round before launch", async () => {
  const f = await fixture();

  try {
    fs.mkdirSync(f.directory, { recursive: true });
    fs.mkdirSync(path.join(f.directory, "round-1.input.md"), {
      recursive: true,
    });
    const result = await f.call();
    assert.notEqual(result.exit, 0);
    assert.equal(f.launches.length, 0);
    assert.equal(
      fs.existsSync(path.join(f.directory, "round-1", "findings.json")),
      false
    );
  } finally {
    f.cleanup();
  }
});

test("resumed round reuses the same input path and bytes", async () => {
  const f = await fixture();

  try {
    f.deps.hook = async () => {
      await Promise.resolve();
      throw new Error("Interrupted");
    };

    const hookPoint = "review:after-pending";
    const wrapped = f.deps.hook;
    f.deps.hook = async (point: string) => {
      if (point === hookPoint) {
        await wrapped(point);
      }
    };

    const callResult2 = await f.call();

    assert.equal(callResult2.exit, 2);
    const inputPath = path.join(f.directory, "round-1.input.md");
    assert.ok(fs.existsSync(inputPath));
    const before = fs.readFileSync(inputPath, "utf-8");
    assert.doesNotMatch(before, /Review Findings & Resolutions/u);
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    delete (f.deps as { hook?: unknown }).hook;
    const callsBefore = f.launches.length;
    const result = await f.call();
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    assert.equal(fs.readFileSync(inputPath, "utf-8"), before);
    assert.equal(
      narrow(f.read(1, "round.json"), withFields({ generation: numeric }))
        .generation,
      1
    );
    assert.ok(f.launches.length >= callsBefore);

    const prompt = fs.readFileSync(
      defined(f.launches.at(-1)).request.promptPath,
      "utf-8"
    );

    assert.ok(prompt.includes(inputPath));
  } finally {
    f.cleanup();
  }
});
