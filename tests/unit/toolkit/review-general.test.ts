import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  appendRecord,
  foldLedger,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import { fixture, report } from "../../helpers/review-fixture.ts";
import {
  anything,
  flag,
  jsonObject,
  listOf,
  narrow,
  numeric,
  optional,
  withFields,
  text,
} from "./helpers/json.ts";
import type { JsonObject } from "./helpers/json.ts";

// SECTION: Ceiling helpers shared with review.test.ts (duplicated for split)
type ReviewFixture = Awaited<ReturnType<typeof fixture>>;

const PLAN_REVIEW = "plan-work.plan";

const ceilingId = (review: string, ceiling: number) =>
  `ceiling:${review}:${ceiling}`;

const addRecord = async (f: ReviewFixture, record: JsonObject) =>
  await appendRecord(f.session, record, f.deps);

const openCeiling = async (f: ReviewFixture, review: string, ceiling: number) =>
  await addRecord(f, {
    kind: "escalation",
    by: "tool",
    key: ceilingId(review, ceiling),
    data: {
      id: ceilingId(review, ceiling),
      state: "open",
      summary: `ceiling ${ceiling} reached`,
    },
  });

const resolveCeiling = async (
  f: ReviewFixture,
  review: string,
  ceiling: number,
  summary: string,
  options: { by?: string; quote?: string; key?: string } = {}
) =>
  await addRecord(f, {
    kind: "escalation",
    by: options.by ?? "user",
    quote: options.quote ?? "User decision",
    key: options.key ?? `${ceilingId(review, ceiling)}:resolved`,
    data: { id: ceilingId(review, ceiling), state: "resolved", summary },
  });

test("rejected MUST remains pending beyond cap and requires source-specific explicit agreement", async () => {
  const f = await fixture();

  try {
    let phase = 0;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (_provider, request) => {
      const prompt = fs.readFileSync(request.promptPath, "utf-8");

      if (!phase) {
        return Promise.resolve({
          outcome: {
            status: "ok",
            text: report(
              "§ Work",
              "Concurrent writes overwrite captured results",
              "MUST"
            ),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        });
      }

      const ids = [...prompt.matchAll(/Request ID: `(?<g1>[^`]+)`/gu)].map(
        (m) => defined(m[1])
      );

      assert.doesNotMatch(prompt, /### Settled in earlier rounds/u);
      assert.equal(ids.length, 1);

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: JSON.stringify({
            status: "CLEAN",
            findings: [],
            confirmations: ids.map((requestId) => ({
              requestId,
              decision: "agree",
              rationale:
                "Captured implementation proves the claim does not apply",
            })),
          }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
    };

    const callResult = await f.call();

    assert.equal(callResult.exit, 0);
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "rejected",
      rationale: "The captured implementation prevents this",
    });
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "duplicate",
      rationale: "Same original claim; confirmation remains pending",
    });
    phase = 1;
    const callResult2 = await f.call();

    assert.equal(callResult2.exit, 0);
    assert.equal(
      narrow(
        f.read(2, "findings.json"),
        withFields({ confirmations: listOf(anything) })
      ).confirmations.length,
      2
    );
    const callResult3 = await f.call();

    assert.equal(callResult3.output.reason, "round-cap");
  } finally {
    f.cleanup();
  }
});

test("confirmed rejection survives ordinary target edits and a changed ruling needs fresh agreement", async () => {
  const f = await fixture();

  try {
    const configFile = path.join(f.deps.skillRoot, "config.jsonc");
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    config.phases["plan-review"].rounds.medium = 4;
    fs.writeFileSync(configFile, JSON.stringify(config));

    let expected = 0;
    let phase = 0;

    const ids: string[] = [];
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (_provider, request) => {
      const assigned = [
        ...fs
          .readFileSync(request.promptPath, "utf-8")
          .matchAll(/Request ID: `(?<g2>[^`]+)`/gu),
      ].map((m) => defined(m[1]));

      if (phase) {
        assert.equal(assigned.length, expected);
      }

      ids.push(...assigned);

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: phase
            ? JSON.stringify({
                status: "CLEAN",
                findings: [],
                confirmations: assigned.map((requestId) => ({
                  requestId,
                  decision: "agree",
                  rationale: "Verified the captured isolated writes",
                })),
              })
            : report(undefined, undefined, "MUST"),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
    };

    {
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
    }

    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "rejected",
      rationale: "Writes are isolated",
    });
    phase = 1;
    expected = 1;
    {
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
    }

    const [original] = ids;
    expected = 0;
    fs.appendFileSync(f.plan, "\n## New context\nMore detail.\n");
    {
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
    }

    {
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
    }

    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "rejected",
      rationale: "Updated rejection evidence",
    });
    expected = 1;
    {
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
    }

    assert.notEqual(ids.at(-1), original);
  } finally {
    f.cleanup();
  }
});

test("tool-only MUST rejection assigns the saved configured reviewer and fails closed without one", async () => {
  const f = await fixture();

  try {
    await f.call();

    const file = path.join(f.directory, "round-1/findings.json");

    const saved = narrow(
      f.read(1, "findings.json"),
      withFields({ findings: listOf(jsonObject) })
    );

    const first = defined(saved.findings[0]);
    saved.findings[0] = { ...first, severity: "MUST", sources: ["tool"] };
    fs.writeFileSync(file, JSON.stringify(saved));
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "rejected",
      rationale: "Tool gap is covered by retained evidence",
    });
    let assigned = 0;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (_provider, request) => {
      const ids = [
        ...fs
          .readFileSync(request.promptPath, "utf-8")
          .matchAll(/Request ID: `(?<g3>[^`]+)`/gu),
      ].map((m) => defined(m[1]));

      assigned += ids.length;

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: JSON.stringify({
            status: "CLEAN",
            findings: [],
            confirmations: ids.map((requestId) => ({
              requestId,
              decision: "agree",
              rationale: "Checked the retained RED evidence",
            })),
          }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
    };

    const callResult4 = await f.call();

    assert.equal(callResult4.exit, 0);
    assert.equal(assigned, 1);
    assert.deepEqual(
      defined(
        narrow(
          f.read(2, "round.json"),
          withFields({
            requests: listOf(withFields({ sourceSlots: listOf(text) })),
          })
        ).requests[0]
      ).sourceSlots,
      [
        defined(
          narrow(
            f.read(1, "round.json"),
            withFields({
              roster: listOf(
                withFields({ reserve: optional(flag), slot: text })
              ),
            })
          ).roster.find((slot) => slot.reserve !== true)
        ).slot,
      ]
    );

    const metadataFile = path.join(f.directory, "round-1/round.json");
    const metadata = narrow(f.read(1, "round.json"), jsonObject);

    fs.writeFileSync(metadataFile, JSON.stringify({ ...metadata, roster: [] }));
    const callResult5 = await f.call();

    assert.equal(callResult5.output.reason, "review-confirmation-required");
  } finally {
    f.cleanup();
  }
});

test("rejected MUST disagreement escalates and explicit resolution re-arms retained count", async () => {
  const f = await fixture();

  try {
    // One recorded grant keeps the rejection retry below its ceiling.
    await openCeiling(f, PLAN_REVIEW, 4);
    await resolveCeiling(
      f,
      PLAN_REVIEW,
      4,
      "re-author: allow the rejection retry"
    );

    let decision = "disagree";
    let launched = 0;
    let phase = 0;

    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();
      launched += 1;
      const prompt = fs.readFileSync(request.promptPath, "utf-8");

      const ids = [...prompt.matchAll(/Request ID: `(?<g4>[^`]+)`/gu)].map(
        (match) => defined(match[1])
      );

      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const text = phase
        ? JSON.stringify({
            status: "CLEAN",
            findings: [],
            confirmations: ids.map((requestId) => ({
              requestId,
              decision,
              rationale:
                "The captured evidence still leaves the original defect",
            })),
          })
        : report(
            "§ Work",
            "Concurrent writes overwrite captured results",
            "MUST"
          );

      return {
        outcome: { status: "ok", text, resume: null, sessionId: null },
        invocations: [],
      };
    };

    const callResult6 = await f.call();

    assert.equal(callResult6.exit, 0);
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "rejected",
      rationale: "Writes are isolated",
    });
    phase = 1;
    const callResult7 = await f.call();

    assert.equal(callResult7.exit, 0);
    const callResult8 = await f.call();

    assert.equal(callResult8.exit, 0);
    const id = "rejection:plan-work.plan:R1-F001";
    assert.equal(
      foldLedger(f.session).records.findLast((row) => row.kind === "escalation")
        ?.data["id"],
      id
    );
    fs.appendFileSync(
      f.plan,
      "\n## New evidence\nWrites use separate records.\n"
    );

    const before = launched;
    const seq = foldLedger(f.session).lastSeq;
    const callResult9 = await f.call();

    assert.equal(callResult9.output.reason, "escalation-open");
    assert.equal(launched, before);
    assert.equal(foldLedger(f.session).lastSeq, seq);
    await f.add("escalation", {
      id,
      state: "resolved",
      summary: "User decision: recheck the separate record evidence",
    });
    const callResult10 = await f.call();

    assert.equal(callResult10.exit, 0);
    assert.equal(
      foldLedger(f.session).records.findLast((row) => row.kind === "escalation")
        ?.data["state"],
      "open"
    );
    const callResult11 = await f.call();

    assert.equal(callResult11.output.reason, "escalation-open");
    await f.add("escalation", {
      id,
      state: "resolved",
      summary: "User decision: confirm isolated records",
    });
    decision = "agree";
    const callResult12 = await f.call();

    assert.equal(callResult12.exit, 0);
    const callResult13 = await f.call();

    assert.equal(callResult13.output.reason, "round-cap");
  } finally {
    f.cleanup();
  }
});

test("unanswered source in past-cap rejection rounds escalate across edits and resolution grants a bounded retry", async () => {
  const f = await fixture();

  try {
    // Three recorded grants keep the no-response retry below its ceiling.
    for (const ceiling of [4, 6, 8]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await openCeiling(f, PLAN_REVIEW, ceiling);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await resolveCeiling(
        f,
        PLAN_REVIEW,
        ceiling,
        "model-effort: retry the missing source"
      );
    }

    let launches = 0;
    let phase = "finding";

    f.deps.delegate = async (provider, request) => {
      await Promise.resolve();
      launches += 1;

      const ids = [
        ...fs
          .readFileSync(request.promptPath, "utf-8")
          .matchAll(/Request ID: `(?<g5>[^`]+)`/gu),
      ].map((m) => defined(m[1]));

      if (phase === "finding") {
        return {
          outcome: {
            status: "ok",
            text: report(undefined, undefined, "MUST"),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      }

      if (ids.length && phase === "missing" && provider === "claude") {
        return {
          outcome: {
            status: "fail",
            cls: "auth",
            detail: "Source credentials unavailable",
          },
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: JSON.stringify({
            status: "CLEAN",
            findings: [],
            confirmations: ids.map((requestId) => ({
              requestId,
              decision: provider === "agy" ? "agree" : phase,
              rationale: "Checked the captured evidence",
            })),
          }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    const callResult14 = await f.call();

    assert.equal(callResult14.exit, 0);
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "rejected",
      rationale: "Writes are isolated",
    });
    phase = "missing";
    const callResult15 = await f.call();

    assert.equal(callResult15.exit, 0);
    const callResult16 = await f.call();

    assert.equal(callResult16.exit, 0);
    const id = "rejection:plan-work.plan:R1-F001";
    assert.equal(
      foldLedger(f.session).records.some(
        (row) => row.kind === "escalation" && row.data["id"] === id
      ),
      false
    );
    fs.appendFileSync(f.plan, "\n## New evidence\nCaptured isolation.\n");
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "rejected",
      rationale: "New evidence for isolation",
    });
    const callResult17 = await f.call();

    assert.equal(callResult17.exit, 0);
    assert.equal(
      foldLedger(f.session).records.findLast((row) => row.kind === "escalation")
        ?.data["id"],
      id
    );

    const before = launches;
    const seq = foldLedger(f.session).lastSeq;
    const callResult18 = await f.call();

    assert.equal(callResult18.output.reason, "escalation-open");
    assert.equal(launches, before);
    assert.equal(foldLedger(f.session).lastSeq, seq);
    await f.add("escalation", {
      id,
      state: "resolved",
      summary: "User decision: retry source credentials",
    });
    const callResult19 = await f.call();

    assert.equal(callResult19.exit, 0);
    phase = "disagree";
    const callResult20 = await f.call();

    assert.equal(callResult20.exit, 0);
    phase = "missing";
    const callResult21 = await f.call();

    assert.equal(callResult21.exit, 0);
    assert.equal(
      foldLedger(f.session).records.findLast((row) => row.kind === "escalation")
        ?.data["state"],
      "resolved"
    );
    const callResult22 = await f.call();

    assert.equal(callResult22.exit, 0);
    assert.equal(
      foldLedger(f.session).records.findLast((row) => row.kind === "escalation")
        ?.data["state"],
      "open"
    );
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "accepted",
      fix: "proposed",
      rationale: "Repair the original finding",
    });
    phase = "agree";
    const callResult23 = await f.call();

    assert.equal(callResult23.exit, 0);
  } finally {
    f.cleanup();
  }
});

test("rejected MUST saved confirmation generation survives crashes and supersedes relevant rulings only", async () => {
  for (const changed of [false, true]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const f = await fixture();

    try {
      // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
      f.deps.delegate = () =>
        Promise.resolve({
          outcome: {
            status: "ok",
            text: report(
              "§ Work",
              "Concurrent writes overwrite captured results",
              "MUST"
            ),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        });
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await f.call();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await f.add("ruling", {
        subject: "review:plan-work.plan:R1-F001",
        ruling: "rejected",
        rationale: "Isolated writes",
      });
      let launches = 0;
      // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
      f.deps.delegate = (_provider, request) => {
        launches += 1;
        const prompt = fs.readFileSync(request.promptPath, "utf-8");

        const ids = [...prompt.matchAll(/Request ID: `(?<g6>[^`]+)`/gu)].map(
          (m) => defined(m[1])
        );

        return Promise.resolve({
          outcome: {
            status: "ok",
            text: JSON.stringify({
              status: "CLEAN",
              findings: [],
              confirmations: ids.map((requestId) => ({
                requestId,
                decision: "agree",
                rationale: "Checked the isolated writes",
              })),
            }),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        });
      };

      f.deps.hook = (point) => {
        if (point === "review:after-pending") {
          throw new Error("crash");
        }
      };

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const callResult24 = await f.call();

      assert.equal(callResult24.exit, 2);
      delete f.deps.hook;

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await (changed
        ? f.add("ruling", {
            subject: "review:plan-work.plan:R1-F001",
            ruling: "rejected",
            rationale: "New evidence for isolated writes",
          })
        : f.add("note", { text: "Unrelated observation" }));

      const before = launches;
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const result = await f.call();
      assert.equal(result.exit, changed ? 4 : 0);
      assert.equal(launches, before);

      if (changed) {
        assert.equal(result.output.reason, "target-moved");
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const callResult25 = await f.call();

        assert.equal(callResult25.exit, 0);
        assert.ok(launches > before);
        assert.equal(
          narrow(f.read(2, "round.json"), withFields({ generation: numeric }))
            .generation,
          2
        );
      } else {
        assert.equal(
          narrow(f.read(2, "round.json"), withFields({ generation: numeric }))
            .generation,
          1
        );
      }
    } finally {
      f.cleanup();
    }
  }
});

test("accepted MUST fixes extend the round cap until a round has none", async () => {
  const f = await fixture();

  try {
    let severity = "MUST";
    let step = 0;

    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (provider, request, mode) => {
      f.launches.push({ provider, request, mode });

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: report("§ Work", `Defect ${step}`, severity),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
    };

    const round = async (ruling: string) => {
      step += 1;
      const callResult26 = await f.call();

      assert.equal(callResult26.exit, 0);

      if (step === 3) {
        // The third round repeats a hot unit, so its rulings need a step-back outcome.
        await f.add("ruling", {
          subject: "step-back:plan-work.plan:3",
          ruling: "patch",
          rationale: "The cause is local to one section",
        });
      }

      await f.add("ruling", {
        subject: `review:plan-work.plan:R${step}-F001`,
        ruling,
        rationale: "Resolution",
        fix: ruling === "accepted" ? "proposed" : "",
      });
      fs.appendFileSync(f.plan, `\n## Fix ${step}\nChanged.\n`);
    };

    await round("accepted");
    await round("deferred");
    const callResult27 = await f.call();

    assert.equal(callResult27.output.reason, "round-cap");
    await f.add("ruling", {
      subject: "review:plan-work.plan:R2-F001",
      ruling: "accepted",
      fix: "proposed",
      rationale: "Fixed after all",
    });
    severity = "SHOULD";
    await round("accepted");
    assert.match(f.output().summary, /round 3\/2/u);
    const callResult28 = await f.call();

    assert.equal(callResult28.output.reason, "round-cap");
  } finally {
    f.cleanup();
  }
});
