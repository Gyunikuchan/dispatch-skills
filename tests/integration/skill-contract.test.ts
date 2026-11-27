import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { maintain, renderContractRegions } from "../../scripts/maintain.ts";
import { TOOL_ACTIONS } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  ACTION_CONTRACTS,
  SESSION_CONTRACTS,
  renderCallTable,
  stripGeneratedMarkers,
} from "../../skills/dispatch/scripts/toolkit/contracts.ts";
import { qualitySections } from "../../skills/dispatch/scripts/toolkit/domain/prompt.ts";
import {
  KINDS,
  recordSchemas,
} from "../../skills/dispatch/scripts/toolkit/records.ts";
import type { RecordSchema } from "../../skills/dispatch/scripts/toolkit/records.ts";
import { defined } from "../helpers/guards.ts";
import { OVERLAY_ROOT } from "./scan.ts";

const root = "skills/dispatch/";

/** The ordering of a comparator-less `sort()`: UTF-16 code units of each value's string form. */
const byDefaultOrder = (a: unknown, b: unknown) => {
  const left = String(a);
  const right = String(b);

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

const read = (file: string) =>
  fs.readFileSync(path.join(OVERLAY_ROOT, file), "utf-8");

const refs = [
  "toolkit",
  "spec-stage",
  "review-rules",
  "decision-frame",
  "providers",
  "worktree-cleanup",
  "diagnostics",
  "glossary",
  "self-build",
  ...["ask", "design", "plan", "implement", "review", "verify"].map(
    (v) => `verbs/${v}`
  ),
];

const scanned = ["SKILL.md", ...refs.map((v) => `references/${v}.md`)];

const links = (text: string) =>
  [...text.matchAll(/\[[^\]]+\]\((?<g1>[^)]+)\)/gu)].map((m) => defined(m[1]));

const markdown = (dir: string): string[] =>
  fs
    .readdirSync(path.join(OVERLAY_ROOT, dir), { withFileTypes: true })
    .flatMap((e) =>
      // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
      e.isDirectory()
        ? markdown(`${dir}/${e.name}`)
        : e.name.endsWith(".md")
          ? [`${dir}/${e.name}`]
          : []
    );

const section = (text: string, heading: string) =>
  text.split(`### ${heading}\n`)[1]?.split(/\n#{1,3} /u)[0] ?? "";

const backgroundStart = (command: string) =>
  `Always start \`${
    command
  }\` as a background command when the host supports one. Wait for its completion notice without polling ([launch and continue](../SKILL.md#launch-and-continue)).`;

test("maintain detects contract block drift without writing", () => {
  const source = path.join(OVERLAY_ROOT, root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintain-"));

  try {
    fs.cpSync(path.join(source, "references"), path.join(dir, "references"), {
      recursive: true,
    });
    fs.copyFileSync(path.join(source, "SKILL.md"), path.join(dir, "SKILL.md"));
    const toolkitFile = path.join(dir, "references/toolkit.md");

    const original = fs
      .readFileSync(toolkitFile, "utf-8")
      .replaceAll(/\r?\n/gu, "\r\n");

    const current = original.replace(
      "<!-- GENERATED: action:ask-run -->`ask run",
      "<!-- GENERATED: action:ask-run -->`stale run"
    );

    const skillFile = path.join(dir, "SKILL.md");
    const skill = fs.readFileSync(skillFile, "utf-8");

    fs.writeFileSync(toolkitFile, current);
    fs.utimesSync(toolkitFile, new Date(0), new Date(0));
    const driftedMtime = fs.statSync(toolkitFile).mtimeMs;
    assert.deepEqual(maintain(dir, true), [
      "references/toolkit.md: ### ask run: generated content differs",
    ]);
    assert.equal(fs.statSync(toolkitFile).mtimeMs, driftedMtime);
    assert.equal(fs.readFileSync(toolkitFile, "utf-8"), current);

    const brokenSkill = `${skill}\n[Missing](references/absent.md)\n`;
    fs.writeFileSync(skillFile, brokenSkill);

    for (const check of [true, false]) {
      const errors = maintain(dir, check);
      assert.ok(
        errors.includes("SKILL.md: undeclared link references/absent.md")
      );
      assert.ok(
        errors.includes("SKILL.md: missing link file references/absent.md")
      );
      assert.equal(fs.readFileSync(skillFile, "utf-8"), brokenSkill);
      assert.equal(fs.readFileSync(toolkitFile, "utf-8"), current);
    }

    fs.writeFileSync(skillFile, skill);
    assert.deepEqual(maintain(dir, false), []);
    assert.equal(fs.readFileSync(toolkitFile, "utf-8"), original);
    const past = new Date(0);
    fs.utimesSync(toolkitFile, past, past);
    const mtime = fs.statSync(toolkitFile).mtimeMs;
    assert.deepEqual(maintain(dir, false), []);
    assert.deepEqual(maintain(dir, true), []);
    assert.equal(fs.statSync(toolkitFile).mtimeMs, mtime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("contract regeneration preserves surrounding prose and fails closed on misplaced or invalid delimiters", () => {
  const original = read(`${root}references/toolkit.md`).replaceAll(
    "\r\n",
    "\n"
  );

  assert.equal(
    stripGeneratedMarkers(
      "A\r\n\r\n<!-- GENERATED: call-table -->\r\n\r\n" +
        "before<!-- END GENERATED: call-table -->after\n<!-- authored -->\n<!-- GENERATED:keep -->"
    ),
    "A\r\n\r\n\r\nbeforeafter\n<!-- authored -->\n<!-- GENERATED:keep -->"
  );
  const opening = "<!-- GENERATED: action:ask-run -->";
  const closing = "<!-- END GENERATED: action:ask-run -->";

  const customized = original.replace(
    `${closing}. Pass the question`,
    `${closing} and keep this authored note. Pass the question`
  );

  const stale = customized
    .replace(`${opening}\`ask run`, `${opening}\`old run`)
    .replace(
      "| Type | Heading | Arguments |",
      "| Type | Obsolete | Arguments |"
    );

  assert.deepEqual(renderContractRegions(stale), {
    text: customized,
    errors: [],
    drift: [
      "references/toolkit.md: ### call table: generated content differs",
      "references/toolkit.md: ### ask run: generated content differs",
    ],
  });

  for (const [broken, error] of [
    [original.replace(opening, ""), /missing opening marker/u],
    [original.replace(closing, ""), /opening marker before closing marker/u],
    [original.replace(opening, opening + opening), /duplicate opening marker/u],
    [original.replace(closing, closing + closing), /unmatched closing marker/u],
    [
      `${original}\n<!-- GENERATED: extra -->\n<!-- END GENERATED: extra -->\n`,
      /unknown generated marker/u,
    ],
    [
      original.replace(`Arguments: ${opening}`, `${opening}Arguments: `),
      /wrong boundary/u,
    ],
    [
      original.replace(
        "<!-- GENERATED: session:init -->\n",
        "<!-- GENERATED: session:init -->"
      ),
      /wrong boundary/u,
    ],
  ] as const) {
    const result = renderContractRegions(broken);
    assert.equal(result.text, broken);
    assert.match(result.errors.join("\n"), error);
  }
});

test("decision records resolve local links and headings", () => {
  for (const file of markdown("docs/decisions")) {
    for (const target of links(read(file))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|<)/iu.test(target)) {
        continue;
      }

      const [local, fragment] = target.split("#");

      const resolved = path.resolve(
        OVERLAY_ROOT,
        path.dirname(file),
        local === undefined || local === "" ? path.basename(file) : local
      );

      const label = `${file} -> ${target}`;
      assert.ok(fs.existsSync(resolved), label);

      if (
        fragment !== undefined &&
        fragment !== null &&
        fragment !== "" &&
        resolved.endsWith(".md")
      ) {
        const headings =
          fs.readFileSync(resolved, "utf-8").match(/^#{1,6}\s+.+$/gmu) ?? [];

        const slugs = headings.map((heading) =>
          heading
            .replace(/^#{1,6}\s+/u, "")
            .toLowerCase()
            .replaceAll(/[^\p{L}\p{N}\s_-]/gu, "")
            .replaceAll(/\s/gu, "-")
        );

        assert.ok(slugs.includes(decodeURIComponent(fragment)), label);
      }
    }
  }
});

// eslint-disable-next-line eslint/complexity -- scenario matrix test keeps all cases in one place.
test("skill contract keeps router entries and resolving reference links", () => {
  const skill = read(`${root}SKILL.md`);
  assert.match(
    skill,
    /Recommend `plan` or `design` after intent refinement under \[spec stage\]\(references\/spec-stage\.md\)\./u
  );
  assert.match(
    skill,
    /Keep `ask`, `review`, `verify` and `implement` on their requested verb/u
  );
  const readPhase = skill.indexOf("Read the phase first");
  assert.ok(readPhase !== -1 && readPhase < skill.indexOf("## Tool loop"));
  assert.match(skill, /Ask needs no spec, plan or approval/u);
  assert.ok(links(skill).includes("references/verbs/review.md"));
  assert.match(
    read(`${root}references/verbs/review.md`),
    /Standalone review needs no bound plan and adds no approval gate/u
  );

  for (const file of refs.filter(
    (v) => v !== "glossary" && v !== "diagnostics"
  )) {
    assert.ok(links(skill).includes(`references/${file}.md`), file);
  }

  for (const file of [`${root}SKILL.md`, ...markdown(`${root}references`)]) {
    for (const target of links(read(file))) {
      const local = defined(target.split("#")[0]);

      if (!local || /^(?<g1>https?:|mailto:|<)/u.test(local)) {
        continue;
      }

      assert.ok(
        fs.existsSync(path.resolve(OVERLAY_ROOT, path.dirname(file), local)),
        `${file} -> ${target}`
      );
    }
  }

  // Tool actions syntax documentation
  const toolkit = read(`${root}references/toolkit.md`);

  const actions =
    toolkit.split("## Tool actions\n")[1]?.split("\n## ")[0] ?? "";

  assert.deepEqual(
    [...actions.matchAll(/^### (?<g1>.+)$/gmu)]
      .map((m) => defined(m[1]))
      .toSorted(),
    [...TOOL_ACTIONS].toSorted((a, b) => a.localeCompare(b))
  );

  for (const action of TOOL_ACTIONS) {
    for (const label of ["Arguments:", "Result path:", "Refusals:"]) {
      assert.ok(section(actions, action).includes(label), `${action} ${label}`);
    }
  }

  assert.ok(
    toolkit.indexOf("## Session commands") > toolkit.indexOf("## Tool actions")
  );

  for (const file of scanned) {
    const text = read(root + file);

    const matches = TOOL_ACTIONS.filter((action) =>
      text
        .split(/\r?\n/u)
        .some(
          (line) =>
            new RegExp(
              String.raw`\b` +
                action.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`) +
                String.raw`\b`,
              "u"
            ).test(line) && /--session\b/u.test(line)
        )
    );

    if (file !== "references/toolkit.md") {
      // eslint-disable-next-line typescript/restrict-template-expressions -- fixture value is a validated string at runtime.
      assert.ok(matches.length <= 1, `${file} ${matches}`);
    }

    if (file === "SKILL.md") {
      assert.deepEqual(matches, []);
      assert.ok(text.includes("<tool> <action>"));
    }
  }

  // Ledger help retains authored field meanings and authority for every kind.
  const ledger =
    toolkit.split("## Ledger records\n")[1]?.split("\n## ")[0] ?? "";

  assert.deepEqual(
    [...ledger.matchAll(/^### (?<g1>.+)$/gmu)]
      .map((m) => defined(m[1]))
      .toSorted(),
    [...KINDS].toSorted()
  );
  const quoted = new Set(["approval", "confirm", "waiver", "manual-complete"]);

  // SAFETY: recordSchemas() builds phased writer/integrate entries with phases and flat entries without; the inferred type widens phased to boolean, so assert the declared union for narrowing.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inferred type widens phased to boolean; values match the declared union.
  for (const schema of recordSchemas() as RecordSchema[]) {
    const body = section(ledger, schema.kind);

    const fields = schema.phased
      ? [
          "phase",
          ...schema.phases.flatMap((phase) => [
            phase.phase,
            ...phase.required,
            ...phase.optional,
          ]),
        ]
      : [...schema.required, ...schema.optional];

    if (schema.kind === "ruling") {
      assert.ok(body.includes("optional `impact`, `trigger` and `paths`"));
    }

    for (const field of new Set(fields)) {
      assert.ok(body.includes(field), `${schema.kind} ${field}`);
    }

    assert.match(body, /data/iu);
    assert.match(body, /Allowed by: user/u);

    if (quoted.has(schema.kind)) {
      assert.match(body, /user only with a nonblank quote/u);
    } else {
      assert.match(body, /orchestrator/u);

      if (schema.kind !== "focus") {
        assert.match(body, /tool/u);
      }
    }
  }

  assert.match(section(ledger, "ruling"), /verification:<cycle>:V<n>/u);
  assert.match(section(ledger, "writer"), /commit, taskSection, seq/u);

  for (const term of ["native-pending", "promptPath", "replyPath", "rerun"]) {
    assert.ok(toolkit.includes(term), term);
  }

  const sessions = toolkit.split("## Session commands\n")[1] ?? "";
  assert.deepEqual(
    [...sessions.matchAll(/^### session (?<g1>.+)$/gmu)]
      .map((m) => defined(m[1]))
      .toSorted(),
    Object.keys(SESSION_CONTRACTS).toSorted()
  );

  for (const term of [
    "ok",
    "summary",
    "path",
    "appliesTo",
    "action:'quota-reprobe'",
    "v:1",
  ]) {
    assert.ok(sessions.includes(term), term);
  }
});

const referenceDoc = (name: string) => read(`${root}references/${name}.md`);

test("phase prose places each workflow rule in its canonical home", () => {
  assert.ok(links(referenceDoc("verbs/ask")).includes("../toolkit.md#ask-run"));
  assert.match(referenceDoc("spec-stage"), /intent.*user quote/iu);
  assert.match(referenceDoc("spec-stage"), /continue.*unaffected writers/iu);
  assert.ok(referenceDoc("review-rules").includes("review:<review>:<finding>"));
  assert.match(referenceDoc("review-rules"), /ruling/u);

  for (const term of ["doctor run", "native-pending"]) {
    assert.ok(referenceDoc("providers").includes(term), term);
  }

  // Authoring carry-over and review round roster rules
  const plan = referenceDoc("verbs/plan");
  const design = referenceDoc("verbs/design");
  const rules = referenceDoc("review-rules");
  assert.match(plan, /existing test seams and helpers[^.]*`Seams:`/u);
  assert.match(
    plan,
    /unchanged consumers and callers[^.]*`Rollback & Blast Radius`/u
  );
  assert.match(plan, /parallel implementations[^.]*`Invariants:`/u);
  assert.match(
    design,
    /unchanged consumers and parallel implementations[^.]*`Architecture & Boundaries`[^.]*`Affected contracts`/u
  );
  assert.match(
    rules,
    /launches the full configured roster when the previous completed round has an accepted MUST/u
  );
  assert.match(
    rules,
    /or an accepted SHOULD from a round below the saved round-1 cap/u
  );
  assert.match(
    rules,
    /launches one target: the first non-reserve slot of the previous round's saved roster/u
  );
  assert.match(rules, /pending MUST rejection requests stay assigned/u);
  assert.match(
    rules,
    /Plan and design review prompts also name the session context map as a pre-change locator, not a completeness claim, when it exists/u
  );
  assert.match(rules, /code review prompts never receive it/u);

  // Review continuation and ceiling rules: one canonical home
  for (const name of ["decision-frame", "toolkit"]) {
    assert.doesNotMatch(
      referenceDoc(name),
      /round-1 cap plus 2|each grant 2 rounds/u,
      name
    );
    assert.ok(
      links(referenceDoc(name)).includes(
        "review-rules.md#review-provenance-and-applicability"
      ),
      name
    );
  }

  assert.ok(rules.includes("the round-1 cap + 2 + 2 per user-resolved grant"));

  // Implement post-cleanup checks and review timing
  const implementText = referenceDoc("verbs/implement");
  assert.match(
    implementText,
    /start[^\n]*checks[^\n]*code review[^\n]*same[^\n]*HEAD[^\n]*together/iu
  );
  assert.match(implementText, /checks fail[^\n]*repair[^\n]*review/iu);

  // Scope round single canonical home
  const canonical = referenceDoc("grounding");
  assert.match(
    canonical,
    /## Scope round\s+After `confirm` and before authoring a standalone plan or any design/iu
  );

  for (const [file, link] of [
    ["spec-stage.md", "grounding.md#scope-round"],
    ["verbs/plan.md", "../grounding.md#scope-round"],
    ["verbs/design.md", "../grounding.md#scope-round"],
    ["verbs/implement.md", "../grounding.md#scope-round"],
  ] as const) {
    const text = read(`${root}references/${file}`);
    assert.ok(links(text).includes(link), file);
    assert.doesNotMatch(
      text,
      /(?:After `confirm`|after confirming the spec)[^\n]*scope round|scope round[^\n]*after `confirm`/iu,
      file
    );
  }

  assert.ok(
    links(implementText).includes(
      "../spec-stage.md#readers-and-document-layers"
    )
  );

  // Severity rubric reference and no table restatement
  assert.ok(links(rules).includes("templates/review-severity.md"));
  assert.doesNotMatch(
    rules,
    /^\s*\|.*\b(?<g1>critical|blocks|degrades|minor)\b.*\b(?<g2>MUST|SHOULD|CONSIDER)\b/imu
  );
});

const stageParts = () => {
  const stage = read(`${root}references/spec-authoring.md`);

  return {
    refine:
      stage
        .split("2. **Critique and refine.**")[1]
        ?.split("\n3. **Author.**")[0] ?? "",
    author:
      stage.split("3. **Author.**")[1]?.split("\n4. **Confirm.**")[0] ?? "",
    confirm: stage.split("4. **Confirm.**")[1]?.split("\n\n## ")[0] ?? "",
  };
};

test("spec stage critiques the request premise before confirmation", () => {
  const stage = read(`${root}references/spec-authoring.md`);
  const groundStep = stage.indexOf("1. **Ground.**");
  const refineStep = stage.indexOf("2. **Critique and refine.**");
  const authorStep = stage.indexOf("3. **Author.**");
  const confirmStep = stage.indexOf("4. **Confirm.**");
  const { refine, author, confirm } = stageParts();

  assert.ok(
    groundStep !== -1 &&
      refineStep > groundStep &&
      authorStep > refineStep &&
      confirmStep > authorStep,
    "ground, critique, author and confirm in order"
  );
  assert.match(
    refine,
    /problem, scope and cost-and-risk[^.]*materially better/iu
  );
  assert.match(refine, /not worse on intent/iu);
  assert.match(refine, /in one line that the premise holds, with the reason/iu);
  assert.match(refine, /after grounding[\s\S]*first-round/iu);
  assert.match(refine, /each with a recommended answer/iu);
  assert.match(
    refine,
    /For `plan`, `design`, or an `implement` that authors its plan or design/iu
  );
  assert.match(refine, /skip[^.]*`review` without a spec/iu);
  assert.match(refine, /add no other clarification round/iu);

  assert.match(
    author,
    /DEC[\s\S]*Options[\s\S]*Rejected[\s\S]*user's actual quote/iu
  );
  assert.match(author, /user's choice governs/iu);
  assert.match(author, /critique alone never blocks progress/iu);

  assert.match(
    confirm,
    /when `grilling` was unavailable[\s\S]*Confirm exchange/iu
  );
  assert.match(
    confirm,
    /If the reply settles a presented alternative in this fallback/iu
  );
  const update = confirm.indexOf("first update the canonical spec and its DEC");
  const lint = confirm.indexOf("lint the updated spec", update);

  const recordText =
    "Record the user's reply as a `confirm` ledger record with the spec hash";

  const record = confirm.indexOf(recordText, lint);
  assert.ok(
    update !== -1 && lint > update && record > lint,
    "update and lint the fallback spec before recording confirm"
  );
  assert.equal(
    (
      confirm.match(
        /Record the user's reply as a `confirm` ledger record with the spec hash/gu
      ) ?? []
    ).length,
    1
  );
  assert.match(
    confirm,
    /once, using the resulting hash if this fallback update ran, or the current spec hash otherwise/iu
  );
  assert.match(confirm, /reply is both the decision and confirmation/iu);
  assert.match(confirm, /no extra exchange/iu);
  assert.match(confirm, /revision protocol/iu);
  assert.match(
    refine,
    /replaces grilling's closing shared-understanding confirmation, so ask no separate one/u
  );
  assert.match(
    confirm,
    /record no `edit` or `confirm` until the user accepts the repeated exchange/u
  );
});

test("spec stage critique lays out grounded approaches with simplicity and question admission", () => {
  const { refine, author } = stageParts();
  assert.match(
    refine,
    /two or three grounded approaches with trade-offs and one recommendation/iu
  );
  assert.match(
    refine,
    /drop approaches that work against the user's why or that existing work rules out/iu
  );
  assert.match(
    refine,
    /when one approach remains, say so and state why the others do not fit/iu
  );
  assert.match(refine, /differ in what the user sees[^.]*text sketch/iu);
  assert.match(
    refine,
    /raises the approach or asks about trade-offs[^.]*grilling question/iu
  );
  assert.match(
    refine,
    /only outcomes[^.]*stated default[^.]*override[^.]*Confirm/iu
  );
  assert.match(author, /approach set[\s\S]*DEC[\s\S]*Options[\s\S]*Rejected/iu);
  assert.match(
    author,
    /delegated default[^.]*`\(assumption\)`[^.]*no user quote/iu
  );
  assert.match(
    author,
    /override[^.]*updates that DEC with the user's actual quote/iu
  );
  const template = read(`${root}references/templates/spec.md`);
  assert.match(template, /verbatim user quote[^.\n]*`\(user\)`/iu);
  assert.match(
    refine,
    /simplest approach with a reasonable trade-off worth considering/iu
  );
  assert.match(
    refine,
    /\[simplicity order\]\(templates\/quality-bar\.md#shared\)/u
  );
  assert.match(refine, /never a strawman/iu);
  assert.match(refine, /already that option[^.]*say so/iu);
  assert.match(refine, /trade-off, limitation and risk/iu);
  assert.match(
    refine,
    /recommend the simplest presented approach that meets intent and the simplicity floor[^.]*heavier[^.]*reason/iu
  );
  assert.match(template, /<option: trade-off, limitation, risk>/u);
  assert.doesNotMatch(template, /<option and trade-off>/u);
  assert.match(
    refine,
    /only decisions that change scope, behavior or risk and that grounding cannot answer/iu
  );
  assert.match(refine, /other calls[^.]*`\(assumption\)`/iu);
  assert.match(refine, /never questions, and never ask process steps/iu);
  assert.match(refine, /A material unanswered question still blocks approval/u);
  assert.match(refine, /states no why and grounding cannot infer it/iu);
  assert.match(
    refine,
    /why[^.]*alone[^.]*first grilling round[^.]*no recommended answer/iu
  );
  assert.match(
    refine,
    /override[^.]*per-question recommendation[^.]*that one question/iu
  );
  assert.match(
    refine,
    /rest of the frontier, including approach options, follows in the next round/iu
  );
  assert.match(refine, /inferred why[^.]*`\(assumption\)`/iu);
  assert.match(
    refine,
    /each question.*states what its answer (?:would )?change/iu
  );
});

test("spec stage short path and self-check", () => {
  const { refine, author, confirm } = stageParts();
  assert.match(
    refine,
    /open the first user exchange[^.]*with a short restatement of the request[\s\S]*current behavior[\s\S]*what the change touches[\s\S]*verified Surprises/iu
  );
  assert.match(refine, /leaves no user decision open[^.]*no grilling round/iu);
  assert.match(
    refine,
    /at every level, except when the critique leaves no user decision open/iu
  );
  assert.match(
    refine,
    /Confirm carries the critique result, any approach default, stated and assumed intent and the verb recommendation/iu
  );
  assert.match(confirm, /when `grilling` was unavailable or asked no round/iu);
  assert.match(
    confirm,
    /approach default, a self-check answer or a corrected assumption/iu
  );
  assert.match(
    confirm,
    /opens a new decision in this fallback, follow the \[revision protocol\]\(spec-stage\.md#revision-protocol\) \(for a new decision, resume `grilling` for its branch first when the host provides it\), which records the new confirmation; otherwise:/iu
  );
  const lint = author.indexOf("Lint");
  const check = author.search(/self-check/iu);
  const relint = author.search(/lint (?:again|passes again)/iu);
  assert.ok(
    lint !== -1 && check > lint && relint > check,
    "self-check after lint, re-lint after it"
  );
  assert.match(author, /plan author/iu);
  assert.match(
    author,
    /answered by chat or grounding \(fill in\)[\s\S]*minor[^.]*`\(assumption\)`[\s\S]*ask[^.]*in Confirm, most important first/iu
  );
  assert.match(author, /before Confirm/iu);
});

test("spec stage docs describe approach options", () => {
  const stage = read(`${root}references/spec-authoring.md`);

  const docs = {
    readme: read(`${root}README.md`),
    concepts: read(`${root}references/readme/concepts.md`),
    adr: read(
      "docs/decisions/0014-ground-first-intent-and-evidence-based-level.md"
    ),
  };

  for (const [name, text] of Object.entries({ ...docs, stage })) {
    if (name !== "stage") {
      assert.match(
        text,
        /approach options?[^.]*recommend|recommend[^.]*approach options?/iu,
        name
      );
    }

    for (const sentence of text
      .split(/\.\s/u)
      .filter((s) => /alternative only when[^.]*materially better/iu.test(s))) {
      assert.match(
        sentence,
        /problem, scope and cost|other lenses/iu,
        `${name}: materially-better filter names its lenses`
      );
    }
  }

  for (const [name, text] of Object.entries(docs)) {
    assert.match(
      text,
      /simplest[^.]*worth considering/iu,
      `${name}: simplest worthwhile option`
    );
    assert.match(
      text,
      /trade-off, limitation and risk/iu,
      `${name}: per-option cost`
    );
  }

  assert.match(
    docs.adr,
    /brainstorming[^.]*rejected as a whole[\s\S]*adopts[^.]*approach options[^.]*question admission[^.]*short path[^.]*self-check/iu
  );
});

test("aliases preserve entry mappings", () => {
  const mapping = {
    "dispatch-plan": "plan",
    "dispatch-implement": "implement",
    "dispatch-code-review": "review --kind code",
    "dispatch-verify": "verify",
  };

  for (const [name, verb] of Object.entries(mapping)) {
    const text = read(`skills/${name}/SKILL.md`);
    assert.ok(text.includes(`\`${verb}\``), name);
    assert.ok(
      text.includes(`Missing dependency: dispatch is required by ${name}`)
    );
    assert.match(text, new RegExp(`name: ${name}`, "u"));
    assert.ok(
      fs.existsSync(
        path.join(OVERLAY_ROOT, ".agents/skills", name, "SKILL.md")
      ),
      `${name}: host link`
    );
  }

  const review = read("skills/dispatch-code-review/SKILL.md");
  assert.ok(review.includes("--spec"));

  for (const file of [`${root}SKILL.md`, ...markdown(`${root}references`)]) {
    assert.doesNotMatch(
      read(file),
      /\b(?:dispatch-plan|dispatch-implement|dispatch-code-review|dispatch-verify)\b/u,
      file
    );
  }
});

test("human manuals retain portable links and current operational guidance", () => {
  for (const file of markdown("skills")) {
    const text = read(file);
    assert.doesNotMatch(text, /file:\/\/|[A-Z]:\\Users\\/u, file);

    for (const target of links(text)) {
      const local = defined(target.split("#")[0]);

      if (!local || /^(?<g1>https?:|mailto:|<)/u.test(local)) {
        continue;
      }

      assert.ok(
        fs.existsSync(path.resolve(OVERLAY_ROOT, path.dirname(file), local)),
        `${file} -> ${target}`
      );
    }
  }

  const config = read(`${root}references/readme/configuration.md`);

  for (const term of [
    "after it authors and lints a plan or design",
    "records it before the first review",
    "confirm the proposal with artifact approval after review",
    "failures remain observable and recoverable",
    "financial or data-integrity errors",
    "a small rate-precision change can",
    "A large diff, changed external contract, finance repository, or state-machine file alone does not require high",
    "`ask` and standalone `review` resolve the level from the invocation, then the session ledger, then `medium`",
    "the level never decreases mid-run",
    "nativeSubagentsOnly",
    "write-subagents",
    "OPENCODE_CONFIG_DIR",
    "sandbox:false",
    "positive safe integer",
    "omission defaults to one",
  ]) {
    assert.ok(config.includes(term), term);
  }

  read("README.md");
  assert.match(
    read(`${root}references/templates/plan.md`),
    /retaining the session in the workspace/u
  );
  read(`${root}references/readme/concepts.md`);
  assert.match(read(`${root}README.md`), /task summaries/u);
  assert.match(
    read(`${root}references/readme/design.md`),
    /increments in order/u
  );
});

test("worktree deliver commit and uncommitted contracts", () => {
  const toolkit = read(`${root}references/toolkit.md`);
  const deliver = section(toolkit, "worktree deliver");
  assert.ok(
    toolkit.includes(
      "`worktree deliver --session <session> [--commit <message-file\\|-> \\| --message <text>]`"
    ),
    "call table"
  );
  assert.ok(
    deliver.includes(
      "`worktree deliver --session <session> [--commit <message-file|-> | --message <text>]`"
    ),
    "deliver arguments"
  );

  for (const term of [
    "--commit",
    "recordOnly",
    "committed",
    "differing",
    "warning",
    "not-delivered",
    "staged-changes",
    "delivered-content-changed",
    "commit-failed",
    "head-not-descendant",
    "delivered-uncommitted",
    "caller-moved",
  ]) {
    assert.ok(deliver.includes(term), term);
  }

  assert.ok(
    section(toolkit, "lint run").includes("outside-increment"),
    "lint run warning"
  );

  const approval =
    read(`${root}references/spec-stage.md`)
      .split("## Approval\n")[1]
      ?.split(/\n## /u)[0] ?? "";

  assert.match(approval, /approve all increments/u);
  assert.match(approval, /user-quoted `note`/u);
  assert.match(approval, /tuple with that quote/u);

  const frame = section(
    read(`${root}references/decision-frame.md`),
    "Plan or design approval"
  );

  assert.match(frame, /all increments/u);
  assert.ok(
    links(frame).some((link) => link.includes("spec-stage.md#approval")),
    "opt-in link"
  );

  for (const term of [
    "delivered-source",
    "caller-dirty",
    "recovery-blocked",
    "unsupported-sparse",
    "unsupported-entry",
    "git restore --source",
    "??",
  ]) {
    assert.ok(deliver.includes(term), term);
  }

  for (const name of [
    "verbs/implement",
    "worktree-cleanup",
    "readme/implement",
  ]) {
    assert.ok(
      links(read(`${root}references/${name}.md`)).some((link) =>
        link.endsWith("toolkit.md#worktree-deliver")
      ),
      name
    );
  }

  const concepts = read(`${root}references/readme/concepts.md`);
  assert.match(concepts, /delivered-source/u);
  assert.match(concepts, /git restore --source/u);
});

test("grounding contracts carry conventions host tools and follow-up guidance", () => {
  const grounding = read(`${root}references/grounding.md`);
  const explorer = read(`${root}references/templates/explorer-brief.md`);
  const contextMap = read(`${root}references/templates/context-map.md`);
  const providers = read(`${root}references/providers.md`);
  const reviewPrompt = read(`${root}references/templates/review-prompt.md`);
  const writerBrief = read(`${root}references/templates/writer-brief.md`);

  assert.match(grounding, /landscape/iu);
  assert.match(grounding, /load-bearing/iu);
  assert.match(grounding, /live explorer/iu);
  assert.match(grounding, /each design increment plan/iu);
  assert.match(grounding, /cited range/iu);
  assert.ok(grounding.includes("providers.md#native-slots"));
  assert.ok(grounding.includes("## Scope round"));
  assert.ok(grounding.includes("Launch one map explorer per grounding phase"));
  assert.ok(
    grounding.includes(
      "launch research explorers in parallel, one per independent topic"
    )
  );
  assert.ok(grounding.includes("writes no map"));
  assert.ok(grounding.includes("../SKILL.md#context-guard"));
  assert.ok(
    read(`${root}references/verbs/plan.md`).includes(
      "../grounding.md#scope-round"
    )
  );
  assert.ok(
    read(`${root}references/verbs/design.md`).includes(
      "../grounding.md#scope-round"
    )
  );
  assert.ok(explorer.includes("<slug>.spec.context.md"));
  assert.ok(explorer.includes("<slug>.plan.context.md"));

  for (const [name, text] of [
    ["grounding.md", grounding],
    ["explorer-brief.md", explorer],
  ] as const) {
    assert.ok(
      !text.includes("<slug>.context.md"),
      `${name} uses an unphased map path`
    );
  }

  assert.ok(explorer.includes("## Host rules and tools"));
  assert.ok(explorer.includes("{{quality}}"));
  assert.match(explorer, /native slots/u);
  assert.doesNotMatch(explorer, /\]\(/u);
  assert.match(explorer, /Conventions/u);
  assert.match(explorer, /parallel:/u);
  assert.match(explorer, /Surprises/u);
  assert.ok(contextMap.includes("## Conventions"));
  assert.ok(contextMap.includes("parallel:"));

  assert.match(providers, /own cache or index/iu);
  assert.match(providers, /create or update only/iu);
  assert.match(reviewPrompt, /own cache or index/iu);
  assert.match(
    reviewPrompt,
    /A reviewer may run a host read tool that creates or updates only its own cache or index/u
  );
  assert.doesNotMatch(reviewPrompt, /A native reviewer/u);
  assert.match(writerBrief, /own cache or index/iu);
  const skill = read(`${root}SKILL.md`);
  assert.ok(skill.includes("references/providers.md#native-slots"));
  assert.doesNotMatch(skill, /write its output to .replyPath/u);
});

test("root skill routes work and guards orchestrator context", () => {
  const skill = read(`${root}SKILL.md`);

  const definition = skill.indexOf(
    "You are the orchestrator: the user's deputy, who middle-manages dispatched agents, whether native subagents or provider delegates"
  );

  assert.ok(
    definition !== -1 && definition < skill.indexOf("## Tool loop"),
    "orchestrator definition precedes the tool loop"
  );

  const block = (heading: string) =>
    skill.split(`## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

  const routing = block("Routing");
  const workTable = routing.split(/\n\| Role \|/u)[0] ?? routing;

  const rows = workTable
    .split("\n")
    // NOTE: oxfmt pads the delimiter row (`| --- |`), so exclude it structurally.
    .filter(
      (line) =>
        line.startsWith("| ") &&
        !line.startsWith("| Work") &&
        !/^\|(?:\s*:?-+:?\s*\|)+$/u.test(line)
    )
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
    );

  const route = (work: string) =>
    rows.find(([cell]) => defined(cell).includes(work))?.[1];

  for (const [work, target] of [
    ["log and verify triage", "Explorer subagent"],
    ["grounding maps", "Explorer subagent"],
    ["Test cleanup", "Utility subagent"],
    ["mechanical fixes", "Utility subagent"],
    ["Plan tasks", "Writer at run level"],
    ["Differentiated review or ask voices", "Delegate or native slot"],
    ["Decisions, rulings, ledger, user gates", "Orchestrator"],
    ["submitted-change inspection", "Orchestrator"],
  ] as const) {
    assert.equal(route(work), target, work);
  }

  assert.equal(route("retro"), undefined);
  assert.equal(rows.length, 6, "six routes");
  assert.ok(links(routing).includes("references/toolkit.md#doctor-run"));

  for (const phrase of [
    "from the `utility-subagents` entry",
    "edits only assigned paths and runs no Git write commands and no toolkit",
    "Reviewers read directly and launch no explorers",
  ]) {
    assert.ok(routing.includes(phrase), phrase);
  }

  const guard = block("Context guard");

  for (const phrase of [
    "Every verb",
    "files, logs, web, command output, result files, diffs",
    "has a launch cost",
    "known file, cited range, index query or small read",
    "about 5 files or 20 KB (~5k tokens)",
    "estimate, not a measured check",
    "one explorer per independent topic in parallel",
    "distilled, cited reply",
    "verify load-bearing claims at source",
    "Orchestrator-row work stays with the orchestrator at any size",
    "including `ask`",
    "Run `ask` only on user request",
  ]) {
    assert.ok(guard.includes(phrase), phrase);
  }

  assert.ok(!guard.includes("500 lines"));
  const launch = block("Launch and continue");

  for (const phrase of [
    "Request fresh context without parent history",
    "report that once in the final handoff",
    "objective, decisions, constraints, current state, next action and required evidence",
    "grant no write authority",
    "Retain handles until run end or host drop",
    "it keeps its model, write boundary and launch deliverable reply rules",
    "Follow-ups return inline without files",
    "never rewrite `replyPath`, `reportPath` or an existing map",
    "Launch fresh for an unrelated topic or when the host cannot continue",
    "Never replace or duplicate work only for fresh context",
    "Two writers never share a worktree",
    "exactly as the result's `launchAs` line states",
    "report a blocker with retained evidence; do not launch without",
  ]) {
    assert.ok(launch.includes(phrase), phrase);
  }

  assert.ok(
    skill.indexOf("## Launch and continue") <
      skill.indexOf("## Invariants and recovery")
  );
  assert.doesNotMatch(
    skill,
    /`(?:Task|Agent|spawn_agent|runSubagent)`/u,
    "no host-specific subagent tool"
  );
  const glossary = read(`${root}references/glossary.md`);
  assert.match(
    glossary,
    /^\| utility subagent \|[^\n]*\| lowest subagent \|$/mu
  );
});

test("references keep branch detail and use the utility entry", () => {
  const skill = read(`${root}SKILL.md`);

  for (const heading of ["## Routing", "## Launch and continue"]) {
    assert.match(skill, new RegExp(`^${heading}$`, "mu"), heading);
  }

  const grounding = referenceDoc("grounding");
  assert.doesNotMatch(grounding, /^## Follow-up explorers$/mu);
  assert.ok(links(grounding).includes("../SKILL.md#routing"));
  assert.match(grounding, /`utility`/u);

  for (const file of ["grounding", "spec-stage"]) {
    assert.doesNotMatch(referenceDoc(file), /follow-up explorers/iu, file);
  }

  const providers = referenceDoc("providers");
  assert.doesNotMatch(providers, /^## Subagent context$/mu);
  assert.ok(links(providers).includes("../SKILL.md#launch-and-continue"));
  assert.ok(
    links(referenceDoc("verbs/ask")).includes("../../SKILL.md#routing")
  );

  const step6 =
    referenceDoc("verbs/implement")
      .split("7. Apply [shared]")[1]
      ?.split("8. Review")[0] ?? "";

  assert.doesNotMatch(step6, /--level low/u);
  assert.match(
    step6,
    /utility subagent \(\[routing\]\(\.\.\/\.\.\/SKILL\.md#routing\)\) on the `brief test-cleanup` result/u
  );
  assert.ok(
    links(referenceDoc("verbs/implement")).includes(
      "../templates/test-cleanup-brief.md"
    )
  );
});

test("native voice launch order failure reports and change rules are documented", () => {
  const providers = read(`${root}references/providers.md`);

  for (const term of [
    '`cliWave: "pending"`',
    "no retained handle",
    "every retained handle finished or was reported",
    "Stop a timed-out handle",
    "30-minute",
    "--native-failed",
    "takes its reserve or saves `failed`",
    "work in `cwd`",
  ]) {
    assert.ok(providers.includes(term), term);
  }

  const coverage = read(`${root}references/review-coverage.md`);

  for (const term of [
    "repositoryChanges",
    "unproven",
    "repository-changes:",
    "repository-rerun:",
    "Decision Frame",
  ]) {
    assert.ok(coverage.includes(term), term);
  }

  const rules = read(`${root}references/review-rules.md`);
  assert.ok(
    links(rules).includes(
      "review-coverage.md#repository-changes-from-native-voices"
    )
  );
  assert.doesNotMatch(
    rules,
    /repository-changes:|repository-rerun:|keeps the legacy round-level meaning/u
  );
  const toolkit = read(`${root}references/toolkit.md`);

  for (const term of [
    "--native-failed",
    "cliWave",
    "repositoryChanges",
    "openRepositoryChanges",
    "checkout-report.json",
  ]) {
    assert.ok(toolkit.includes(term), term);
  }

  const ask = read(`${root}references/verbs/ask.md`);
  assert.ok(ask.includes("--native-failed"));
  assert.ok(links(ask).includes("../providers.md#native-slots"));

  const nativeSlotReplies =
    toolkit.split("## Native-slot replies")[1]?.split("\n## ")[0] ?? "";

  assert.ok(links(nativeSlotReplies).includes("providers.md#native-slots"));
  const reviewRun = section(toolkit, "review run");
  const askRun = section(toolkit, "ask run");

  const nativeSlots =
    providers.split("## Native slots")[1]?.split("\n## ")[0] ?? "";

  for (const [name, text] of [
    ["toolkit review run", reviewRun],
    ["toolkit ask run", askRun],
    ["providers native slots", nativeSlots],
  ] as const) {
    assert.ok(
      text.toLowerCase().includes("cliwave"),
      `${name}: mentions cliWave`
    );
    const sentences = text.split(/(?<=[.!?])\s+/u);

    const pendings = sentences.filter((sentence) => {
      const lower = sentence.toLowerCase();

      return (
        lower.includes("rerun") &&
        (lower.includes("pending") ||
          lower.includes("cliwave") ||
          lower.includes("backgrounded rerun") ||
          lower.includes("cli wave"))
      );
    });

    assert.ok(pendings.length > 0, `${name}: pending rerun instruction`);

    for (const pending of pendings) {
      const lower = pending.toLowerCase();
      assert.ok(
        lower.includes("launch") && lower.includes("rerun"),
        `${name}: pending sentence names launch and rerun`
      );
      const rerunAtOnce = lower.search(/rerun at once/u);
      const rerunIdx = rerunAtOnce >= 0 ? rerunAtOnce : lower.indexOf("rerun");
      const launchEvery = lower.search(/launch every native slot/u);
      assert.ok(
        launchEvery >= 0 && launchEvery < rerunIdx,
        `${name}: native-slot launch precedes pending rerun`
      );
      assert.ok(
        lower.search(/retain/u) >= 0 && lower.search(/retain/u) < rerunIdx,
        `${name}: handle retained before pending rerun`
      );
      assert.ok(
        lower.search(/handle/u) >= 0 && lower.search(/handle/u) < rerunIdx,
        `${name}: handle retained before pending rerun`
      );
      assert.match(
        pending,
        /every native slot/iu,
        `${name}: every native slot launches`
      );

      for (const match of pending.matchAll(/rerun at once/giu)) {
        const before = pending.slice(0, match.index ?? 0).toLowerCase();
        assert.ok(
          before.includes("launch every native slot"),
          `${name}: rerun at once follows native-slot launch`
        );
      }
    }
  }

  assert.match(
    nativeSlots,
    /Rerun the consume call only after the complete reply is in `replyPath`/u
  );

  for (const [command, text] of [
    ["review run", reviewRun],
    ["ask run", askRun],
    ["check run", section(toolkit, "check run")],
  ] as const) {
    assert.equal(
      text.split(backgroundStart(command)).length - 1,
      1,
      `${command}: background start stated once`
    );
  }

  assert.match(reviewRun, /before the backgrounded rerun/iu);
});

test("native slots launch by prompt path", () => {
  const providers = read(`${root}references/providers.md`);
  const openCode = providers.indexOf("## OpenCode private launches");

  for (const heading of ["Native slots", "Shared provider controls", "Quota"]) {
    const position = providers.indexOf(`## ${heading}`);
    assert.ok(
      position !== -1 && openCode !== -1 && position < openCode,
      heading
    );
  }

  const toolkit = read(`${root}references/toolkit.md`);
  assert.doesNotMatch(
    toolkit,
    /#### (?:Test cleanup|Cap-ending SHOULD corrections)|\]\(#test-cleanup\)/u
  );

  for (const term of [
    "test-cleanup-evidence-required",
    "test-cleanup-paths-unchanged",
    "test-cleanup-recorded",
    "test-cleanup-empty",
    "test-cleanup-removed",
    "--review-fix",
    "reviewFix",
    "bind the revised spec, then append its `edit` record",
  ]) {
    assert.ok(toolkit.includes(term), term);
  }

  const grounding = read(`${root}references/grounding.md`);
  assert.match(
    grounding,
    /only when the explorer did not report a passing `lint run`[^.]*inline[^.]*or after the orchestrator edits the map/u
  );

  for (const phrase of [
    "Relaunch a failed, timed-out or lint-failing explorer once",
    "For a size error, ask it to compress wording while retaining every entry",
    "self-ground",
  ]) {
    assert.ok(grounding.includes(phrase), phrase);
  }

  assert.match(providers, /read and execute[^.]*`promptPath`/iu);
  assert.match(providers, /cannot read files[^.]*inline/iu);
  assert.match(
    read(`${root}references/verbs/ask.md`),
    /answering a native voice yourself, read its prompt/iu
  );

  for (const file of [
    "SKILL.md",
    "references/toolkit.md",
    "references/verbs/ask.md",
  ]) {
    assert.doesNotMatch(
      read(root + file),
      /read (?:each|the result's native slots and each) `?promptPath/iu
    );
  }
});

test("orchestrator reads quality bar sections by stage", () => {
  const skill = read(`${root}SKILL.md`);
  assert.ok(
    !links(skill).some((link) => link.endsWith("quality-bar.md")),
    "SKILL.md does not link to the whole quality bar"
  );
  const plan = read(`${root}references/verbs/plan.md`);
  assert.ok(links(plan).includes("../grounding.md#design-increments"));
  assert.doesNotMatch(plan, /quality-bar\.md#code/u);
  const review = read(`${root}references/verbs/review.md`);

  for (const anchor of ["spec", "plan", "design"]) {
    assert.ok(links(review).includes(`../templates/quality-bar.md#${anchor}`));
  }

  for (const phrase of [
    "Standalone review needs no bound plan",
    "Code targets are `integration`, a bound-plan task ID, `worktree`, `<a>..<b>` or `<rev>`",
    "Session state is excluded",
  ]) {
    assert.ok(review.includes(phrase), phrase);
  }

  const implementLinks = links(read(`${root}references/verbs/implement.md`));

  for (const anchor of [
    "rulings-and-fix-scope",
    "review-provenance-and-applicability",
  ]) {
    assert.ok(implementLinks.includes(`../review-rules.md#${anchor}`));
  }

  for (const guide of ["../spec-stage.md", "plan.md", "design.md"]) {
    assert.ok(implementLinks.includes(guide), guide);
  }
});

const qualityAnchors = (text: string) =>
  [
    ...new Set(
      [...text.matchAll(/quality-bar\.md#(?<g1>[a-z]+)/gu)].map((match) =>
        defined(match[1])
      )
    ),
  ].toSorted(byDefaultOrder);

const expectedQuality = (kind: keyof typeof qualitySections) =>
  [...qualitySections[kind]].toSorted(byDefaultOrder);

const authoringSentence = (file: string) => {
  const line =
    referenceDoc(file)
      .split("\n")
      .find((candidate) => candidate.startsWith("Apply the [shared]")) ?? "";

  assert.notEqual(line, "", `${file} has its quality-criteria line`);

  return line.split(" when authoring.")[0] ?? "";
};

test("quality lists: each guide links the qualitySections of its kind", () => {
  assert.deepEqual(
    qualityAnchors(authoringSentence("verbs/plan")),
    expectedQuality("plan")
  );
  assert.deepEqual(
    qualityAnchors(authoringSentence("verbs/design")),
    expectedQuality("design")
  );

  const implement = referenceDoc("verbs/implement");

  assert.deepEqual(
    qualityAnchors(
      implement.split("\n7. Apply [shared]")[1]?.split("\n8. Review")[0] ?? ""
    ),
    expectedQuality("cleanup")
  );
  assert.deepEqual(
    qualityAnchors(
      implement.split("\n8. Review")[1]?.split("\n9. When")[0] ?? ""
    ),
    expectedQuality("code")
  );

  const reviewLine =
    referenceDoc("verbs/review")
      .split("\n")
      .find((line) => line.startsWith("At adjudication apply [shared]")) ?? "";

  const clauses =
    reviewLine
      .split(" and: ")[1]
      ?.split(". Adjudicate")[0]
      ?.split(/; for /u)
      .map((clause) => clause.replace(/^for /u, "")) ?? [];

  assert.equal(clauses.length, 3, "review names plan, design and code clauses");

  for (const [index, kind] of (["plan", "design", "code"] as const).entries()) {
    const clause = clauses[index] ?? "";

    assert.ok(clause.startsWith(kind), `${kind} clause`);
    assert.deepEqual(
      ["shared", ...qualityAnchors(clause)].toSorted(byDefaultOrder),
      expectedQuality(kind),
      `review ${kind}`
    );
  }

  assert.deepEqual(qualityAnchors(referenceDoc("spec-authoring")), [
    "shared",
    "spec",
  ]);
});

test("failed plan slot rule has one home", () => {
  const coverage = read(`${root}references/review-coverage.md`);
  assert.match(
    section(coverage, "Failed-slot coverage"),
    /failed plan or design slot at the cap gets no extra round[^.]*\[Decision Frame\]\(decision-frame\.md\)[^.]*user decides/u
  );
  const rules = read(`${root}references/review-rules.md`);
  assert.ok(links(rules).includes("review-coverage.md#failed-slot-coverage"));
  assert.doesNotMatch(
    rules,
    /failed plan or design slot at the cap gets no extra round/u
  );
  const implement = read(`${root}references/verbs/implement.md`);

  const step = (n: number) =>
    implement.split("\n").find((line) => line.startsWith(`${n}. `)) ?? "";

  assert.ok(
    links(step(1)).includes("../review-coverage.md#failed-slot-coverage")
  );
  assert.doesNotMatch(implement, /extra round|reduced coverage goes/u);
  assert.match(
    step(3),
    /`worktree create` refuses a task until its prerequisites have integrated; verify an integrated prerequisite before creating its dependents/u
  );
  const toolkit = read(`${root}references/toolkit.md`);
  assert.ok(
    section(toolkit, "worktree create").includes("prerequisite-pending")
  );
  const removal = /drops only a non-host provider whose sandbox cannot run/u;
  assert.match(read(`${root}references/readme/configuration.md`), removal);
  assert.match(read(`${root}references/readme/troubleshooting.md`), removal);
});

test("reference duplicates keep one home and link to it", () => {
  // Spec authoring sequence lives in spec-authoring.md; spec-stage.md keeps its anchor and links.
  const stage = referenceDoc("spec-stage");
  assert.ok(
    links(stage).some(
      (link) =>
        link === "spec-authoring.md" || link.startsWith("spec-authoring.md#")
    )
  );
  assert.ok(stage.includes("## Resolve and author"));
  assert.doesNotMatch(stage, /1\. \*\*Ground\.\*\*/u);
  const authoring = read(`${root}references/spec-authoring.md`);
  assert.match(authoring, /1\. \*\*Ground\.\*\*/u);
  assert.match(authoring, /2\. \*\*Critique and refine\.\*\*/u);
  assert.match(authoring, /3\. \*\*Author\.\*\*/u);
  assert.match(authoring, /4\. \*\*Confirm\.\*\*/u);
  assert.ok(links(authoring).includes("spec-stage.md#revision-protocol"));
  // Lint-code field notes live in plan-field-notes.md; plan.md links them.
  const planTemplate = read(`${root}references/templates/plan.md`);
  assert.ok(links(planTemplate).includes("plan-field-notes.md"));
  const fieldNotes = read(`${root}references/templates/plan-field-notes.md`);

  for (const code of [
    "glance-restates-task-map",
    "section-order",
    "task-behaviour",
    "plan-id-in-test-name",
    "criterion-red-test-path",
    "criterion-tests-path",
    "undeclared-test-path",
    "criterion-red-command",
    "red-downgraded",
    "overlap",
    "duplicate-change-path",
    "criterion-task-changes",
    "criterion-check-tests",
  ]) {
    assert.ok(fieldNotes.includes(code), code);
  }

  assert.ok(
    fieldNotes.includes(
      "A title-filtered Check does not cover its file; also run each filtered file unfiltered in another Check or under Automated Tests."
    ),
    "title-filtered Check rule"
  );
  assert.doesNotMatch(
    planTemplate.split("## Field notes")[1] ?? "",
    /glance-restates-task-map/u
  );
  // The map budget is rendered from DEFAULT_MAP_BUDGET; no reference hardcodes it.
  assert.doesNotMatch(referenceDoc("templates/context-map"), /16,384|32,768/u);
  assert.doesNotMatch(referenceDoc("grounding"), /16,384/u);
  assert.ok(
    links(referenceDoc("grounding")).includes(
      "templates/explorer-brief.md#map-budget-and-output"
    )
  );
  // The native reply channel is generated; providers.md links it.
  assert.ok(
    links(referenceDoc("providers")).some((link) =>
      link.includes("scripts/toolkit/fanout.ts")
    )
  );
  // The utility entry resolves through SKILL routing.
  assert.ok(links(referenceDoc("grounding")).includes("../SKILL.md#routing"));
  // The repository-change closing rule lives in review-coverage.md; toolkit links it.
  assert.ok(
    links(referenceDoc("toolkit")).includes(
      "review-coverage.md#failed-slot-coverage"
    )
  );
  assert.ok(
    links(referenceDoc("toolkit")).includes(
      "review-coverage.md#repository-changes-from-native-voices"
    )
  );
  assert.doesNotMatch(
    referenceDoc("toolkit"),
    /keeps the legacy round-level meaning/u
  );
  // Implement step 6 launches through the brief test-cleanup action.
  const implement = referenceDoc("verbs/implement");
  assert.match(implement, /brief test-cleanup/u);
  assert.ok(
    links(implement).some((link) =>
      link.includes("toolkit.md#brief-test-cleanup")
    )
  );
  // The SKILL write boundary links the quality bar.
  assert.ok(
    links(read(`${root}SKILL.md`)).includes(
      "references/templates/quality-bar.md#shared"
    )
  );
});

test("scope-round carry-forward and settled-decision deduplication contracts hold across grounding quality bar and review prompt", () => {
  const grounding = read(`${root}references/grounding.md`);
  const explorer = read(`${root}references/templates/explorer-brief.md`);

  for (const [name, text] of [["explorer-brief.md", explorer]] as const) {
    assert.ok(text.includes("realpath"), `${name}: symlinked path resolution`);
    assert.ok(text.includes("(uncommitted)"), `${name}: uncommitted marker`);
    assert.ok(text.includes("git ls-tree"), `${name}: tracked path check`);
    assert.ok(
      text.includes("git diff --name-only"),
      `${name}: unchanged path check`
    );
    assert.match(text, /Commit: <sha>/u, `${name}: capture commit`);
  }

  // The carry-forward conditions live in the explorer brief; grounding links them.
  assert.ok(
    links(grounding).includes(
      "templates/explorer-brief.md#map-budget-and-output"
    )
  );
  assert.ok(grounding.includes("carries forward an entry"));
  assert.ok(grounding.includes("explorer brief's scope-round rule"));
  assert.match(grounding, /re-read and re-verify/u);
  assert.ok(
    grounding.includes(
      "refined `REQ`s, `DEC`s, planning-altitude test seams, callers and parallel implementations"
    )
  );
  assert.equal(
    grounding.split("git status").length - 1,
    1,
    "git status appears only as a prohibition"
  );
  assert.ok(grounding.includes("Do not run a `git status` check."));
  assert.equal(
    explorer.split("git status").length - 1,
    0,
    "explorer brief asks for no git status check"
  );

  assert.match(explorer, /recorded `Commit: <sha>` is present/u);
  assert.match(explorer, /otherwise it re-reads the file/iu);

  // Settled decisions, non-goals and earlier rulings are closed without new unweighed evidence.
  const quality = read(`${root}references/templates/quality-bar.md`);
  const prompt = read(`${root}references/templates/review-prompt.md`);

  for (const [name, text] of [
    ["quality-bar.md", quality],
    ["review-prompt.md", prompt],
  ] as const) {
    assert.match(
      text,
      /accepted or rejected rulings/iu,
      `${name}: settled rulings`
    );
  }

  assert.ok(links(quality).includes("review-prompt.md#prompt-template"));
  assert.ok(links(quality).includes("review-prompt.md#re-review-template"));
  const promptFlat = prompt.replaceAll(/\s+/gu, " ");
  assert.match(
    promptFlat,
    /earlier accepted or rejected rulings in `### Settled in earlier rounds` as closed unless you cite new code or requirement evidence that the ruling missed/u
  );
  assert.match(
    promptFlat,
    /do not re-raise style preferences or checks enforced by configured linters, formatters or type checkers/u
  );

  const append = section(read(`${root}references/toolkit.md`), "ledger append");
  assert.match(
    append,
    /single record object or a non-empty JSON array of record objects/iu
  );
  assert.match(
    append,
    /validates each record sequentially|validated sequentially/iu
  );
  assert.match(append, /one `withLedger` lock|single `withLedger` lock/iu);
  assert.match(append, /findings refresh/iu);
});

const listOverlayFiles = (dir: string): string[] => {
  const full = path.join(OVERLAY_ROOT, dir);

  if (!fs.existsSync(full)) {
    return [];
  }

  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".scratch"
      ) {
        return [];
      }

      return listOverlayFiles(rel);
    }

    return [rel];
  });
};

test("grounding guidance defines two explorer kinds and limit-based conditions", () => {
  const grounding = read(`${root}references/grounding.md`);

  for (const signal of [
    "Not covered",
    "Surprises",
    "(text-only)",
    "unresolved-dispatch",
    "map size warning",
  ]) {
    assert.ok(grounding.includes(signal), signal);
  }

  // Two explorer kinds: map and research
  assert.match(grounding, /two explorer kinds/iu);
  assert.match(grounding, /map explorer/iu);
  assert.match(grounding, /research explorer/iu);
  // Limit-based continue-or-launch-fresh condition
  assert.match(grounding, /exceeded the limit|passes the limit/iu);
  // Gap handling: follow-up to lead or research explorer for new topic
  assert.match(
    grounding,
    /gap.*(?:could change a REQ, DEC, scope or blast radius)/iu
  );
  assert.match(grounding, /follow-up.*lead|research explorer/iu);
  // Map correction has one owner: orchestrator
  assert.match(grounding, /orchestrator.*correct.*map/iu);

  // No file under skills/dispatch, docs, or tests names gap explorer, scout as a kind, or three-per-round cap
  const checkFiles = [
    ...listOverlayFiles("skills/dispatch"),
    ...listOverlayFiles("docs"),
    ...listOverlayFiles("tests"),
  ];

  const violations: string[] = [];

  for (const file of checkFiles) {
    if (file.replaceAll("\\", "/").endsWith("skill-contract.test.ts")) {
      continue;
    }

    const content = fs.readFileSync(path.join(OVERLAY_ROOT, file), "utf-8");

    if (
      /\bgap explorer\b/iu.test(content) ||
      /\bscout explorer\b/iu.test(content) ||
      /\bone slot is a scout\b/iu.test(content) ||
      /\bat most three in one round\b/iu.test(content)
    ) {
      violations.push(file.replaceAll("\\", "/"));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `files referencing gap/scout explorer or 3-per-round cap: ${violations.join(", ")}`
  );
});

test("subagent role table, shared rules and delegation contract", () => {
  const skill = read(`${root}SKILL.md`);

  for (const col of [
    "Launched by",
    "May launch",
    "Model source",
    "Writes",
    "May be continued",
  ]) {
    assert.match(skill, new RegExp(col, "iu"), `missing column: ${col}`);
  }

  for (const role of [
    "Child orchestrator",
    "Writer",
    "Explorer",
    "Utility subagent",
    "Reviewer or voice",
  ]) {
    assert.match(skill, new RegExp(role, "iu"), `missing role row: ${role}`);
  }

  assert.match(skill, /Explorer[^\n]*map[^\n]*research/iu);
  assert.match(skill, /Child orchestrator[^\n]*(?:inheritance|parent)/iu);
  assert.match(skill, /writes only an assigned map/iu);
  assert.match(skill, /test cleanup/iu);
  assert.match(skill, /ask voice/iu);
  assert.match(skill, /fresh context without parent history/iu);
  assert.match(skill, /exact.*launchAs/iu);
  assert.match(skill, /retain handles/iu);
  assert.match(skill, /never poll/iu);
  assert.match(skill, /claims/iu);
  assert.match(skill, /5 files or 20 KB/iu);
  assert.match(skill, /distilled, cited reply/iu);
  assert.match(skill, /one (?:explorer|launch) per independent topic/iu);
  assert.match(skill, /any step of any verb.*research explorer/iu);
  assert.match(skill, /parallel/iu);
  assert.match(skill, /brief explorer/iu);
  assert.match(skill, /retained explorer a follow-up anytime/iu);
  assert.match(skill, /inline/iu);
  assert.match(skill, /8,192|8192/iu);
  assert.match(skill, /rewrit(?:es?|ing) no map/iu);
  assert.match(
    skill,
    /utility subagent under a writer is not a second writer/iu
  );
  assert.doesNotMatch(skill, /when no `?utility`? entry resolves/iu);
  assert.match(
    skill,
    /when the host has no launch tool|host with no launch tool/iu
  );
});

test("implement guide bounds active task writers by doctor run writeConcurrency", () => {
  const implement = read(`${root}references/verbs/implement.md`);
  assert.match(
    implement,
    /Keep active task writers within `doctor run` `writeConcurrency`\./u
  );
  assert.doesNotMatch(implement, /Honor configured native capacity\./u);
});

test("configuration recommends the strongest model and doctor run documents writeConcurrency", () => {
  const config = read(`${root}references/readme/configuration.md`);
  assert.match(config, /strongest available model for the orchestrator/iu);
  assert.match(config, /cheap explorers and writers depend on a strong lead/iu);
  assert.match(
    section(read(`${root}references/toolkit.md`), "doctor run"),
    /writeConcurrency/u
  );
});

test("implement runs verification before test cleanup and verify states the approval loop and proof guidance", () => {
  const implementGuide = read(`${root}references/verbs/implement.md`);
  assert.ok(
    implementGuide.indexOf("verification stage") <
      implementGuide.indexOf("Apply [shared]")
  );
  assert.ok(!implementGuide.includes("verification step"));
  assert.ok(
    !implementGuide.includes(
      "full contract and remaining criterion verification"
    )
  );

  for (const term of [
    "check run --task",
    "check run --criteria",
    "Any verifier-added test launches cleanup",
    "all review rounds settle",
    "accepted review fixes changed proved behaviour",
    "V0",
    "before launching",
    "covering those fixes together",
    "Never re-check between rounds",
    "add tests in a re-check",
    "another code review round",
  ]) {
    assert.ok(implementGuide.includes(term), term);
  }

  assert.ok(links(implementGuide).includes("verify.md"));
  assert.match(
    implementGuide,
    /check run`[^\n]*before the verifier launches/iu
  );
  const verifyGuide = read(`${root}references/verbs/verify.md`);

  for (const step of ["1. ", "2. ", "3. ", "4. ", "5. ", "6. "]) {
    assert.ok(
      verifyGuide.includes(`\n${step}`),
      `missing numbered step ${step}`
    );
  }

  for (const term of [
    "status show",
    "check run",
    "checks passed",
    "finishes unblocked checks",
    "NEEDS_APPROVAL",
    "approval quote",
    "declined check",
    "not proved",
    "verification:<cycle>:V<n>",
    "On resume rule",
    "re-check only those issues",
    "Escalate recurrence",
    "three fix rounds per issue",
    "report-only",
    "dirty: true",
    "returns results inline",
    "new cycle launches fresh",
    "no delivery step",
    "test edits permitted",
    "no test edits",
  ]) {
    assert.ok(verifyGuide.includes(term), term);
  }

  assert.match(verifyGuide, /failed check or baseline[^\n]*proved/iu);
  const skill = read(`${root}SKILL.md`);
  assert.match(skill, /runtime verification/u);
  const toolkit = read(`${root}references/toolkit.md`);
  assert.match(section(toolkit, "brief verifier"), /checks passed/u);
  const verifyManual = read(`${root}references/readme/verify.md`);
  assert.match(verifyManual, /verification\/report\.md/u);
  assert.match(verifyManual, /Verification/u);
});

const firstSpan = (text: string) => /`(?<g1>[^`]+)`/u.exec(text)?.[1] ?? "-";

test("call table lists every tool action, record kind and session command with its section argument form", () => {
  const toolkit = stripGeneratedMarkers(
    read(`${root}references/toolkit.md`)
  ).replaceAll("\r\n", "\n");

  const actualCallTable = `### call table\n${section(toolkit, "call table").trimEnd()}\n`;
  assert.equal(
    actualCallTable,
    renderCallTable(),
    "toolkit.md ### call table must match renderCallTable() verbatim"
  );

  const lines = section(toolkit, "call table")
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .slice(2);

  const parsed = lines.map((line) => {
    const [type, heading, ...rest] = line.slice(2, -2).split(" | ");

    return {
      type: defined(type),
      heading: defined(heading),
      form: rest
        .join(" | ")
        .split(String.raw`\|`)
        .join("|"),
    };
  });

  const expected = [
    ...Object.keys(ACTION_CONTRACTS).map((h) => ["action", h]),
    // SAFETY: recordSchemas() builds phased writer/integrate entries with phases and flat entries without; the inferred type widens phased to boolean, so assert the declared union for narrowing.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inferred type widens phased to boolean; values match the declared union.
    ...(recordSchemas() as RecordSchema[]).flatMap((schema) =>
      schema.phased
        ? schema.phases.map((phase) => [
            "record",
            `${schema.kind} (${phase.phase})`,
          ])
        : [["record", schema.kind]]
    ),
    ...Object.keys(SESSION_CONTRACTS).map((action) => [
      "session",
      `session ${action}`,
    ]),
  ];

  assert.deepEqual(
    parsed.map((r) => [r.type, r.heading]).toSorted(byDefaultOrder),
    expected.toSorted(byDefaultOrder)
  );

  for (const row of parsed) {
    const targetHeading =
      row.type === "record"
        ? row.heading.replace(/ \([^)]+\)$/u, "")
        : row.heading;

    const body = section(toolkit, targetHeading);
    assert.ok(body.length > 0, `missing toolkit.md section for ${row.heading}`);

    if (row.type === "action") {
      const form = firstSpan(
        body.split("\n").find((line) => line.startsWith("Arguments: ")) ?? ""
      );

      assert.equal(row.form.replaceAll(/^`|`$/gu, ""), form, row.heading);
    } else if (row.type === "session") {
      assert.equal(
        row.form.replaceAll(/^`|`$/gu, ""),
        firstSpan(body),
        row.heading
      );
    }
  }

  // Documented envelope hint, stdin (-), inline flags, Windows PowerShell 5.1 UTF-8, and 4,096-byte inline guidance.
  assert.match(toolkit, /\bhint\b[^\n]*ok:\s*true|ok:\s*true[^\n]*\bhint\b/iu);
  assert.match(toolkit, /\$OutputEncoding.*utf8|utf8.*\$OutputEncoding/iu);
  assert.match(toolkit, /Windows PowerShell 5\.1/u);
  assert.match(toolkit, /4,096/u);

  for (const [heading, pattern] of [
    ["ask run", /<question-file\|->.*--text <text>/u],
    ["brief explorer", /<values\.json\|->.*--json <json>/u],
    [
      "brief test-cleanup",
      /<values\.json\|->.*--json <json>.*--base <ref> --integration-path <path>/u,
    ],
    ["brief verifier", /<values\.json\|->.*--json <json>/u],
    ["lint run", /--edit <fields\.json\|->.*--json <json>/u],
    [
      "worktree commit",
      /--review-fix <json-file\|->.*--review-fix-json <json>.*--test-cleanup <json-file\|->.*--test-cleanup-json <json>/u,
    ],
    ["worktree deliver", /--commit <message-file\|->.*--message <text>/u],
    ["ledger append", /<record\.json\|->/u],
  ] as const) {
    assert.match(
      section(toolkit, heading),
      pattern,
      `${heading} documents stdin/inline flags`
    );
  }

  const askGuide = read(`${root}references/verbs/ask.md`);
  assert.match(askGuide, /--text/u);
  assert.match(askGuide, /stdin \(`-`\)|`?ask run`?/u);
});

test("SKILL.md read rule loads the call table once and fetches help on demand or refusal", () => {
  const skill = read(`${root}SKILL.md`);
  assert.ok(skill.includes("dispatch.ts help call table` once per run"));
  assert.match(skill, /help <heading>[^\n]*when uncertain/iu);
  assert.ok(
    skill.includes("after each `ok:false` result that has a `help` field")
  );
  assert.ok(
    !skill.includes("before the first use in a run of each tool action")
  );
  assert.ok(!skill.includes("For each call read its action section"));
  assert.ok(
    !skill.includes(
      "for ledger calls also read the matching record-kind section"
    )
  );
});

test("review rules require governing evidence for a reversal", () => {
  const rules = read(`${root}references/review-rules.md`);
  assert.ok(
    rules.includes(
      "Before accepting a finding that reverses an earlier accepted ruling or an approved plan criterion, cite the governing spec or plan in the ruling and resolve the conflict there."
    ),
    "review rules must require governing evidence and conflict resolution before a reversal"
  );
});

const referenceFile = (file: string) => read(`${root}references/${file}`);

test("merged rules keep one home", () => {
  const homes: [string, string, string, string][] = [
    [
      "review-rules.md",
      "plan and design only",
      "decision-frame.md",
      "Offer this only for plan and design reviews",
    ],
    [
      "decision-frame.md",
      "Obtain a user quote for any actual waiver",
      "decision-frame.md",
      "Waivers, manual completion and selection of xhigh/max also require verbatim user quotes",
    ],
    [
      "verbs/implement.md",
      "Waivers and manual-completion records must quote",
      "decision-frame.md",
      "Waivers, manual completion and selection of xhigh/max also require verbatim user quotes",
    ],
    [
      "verbs/verify.md",
      "commit fixes and verifier-added tests",
      "verbs/implement.md",
      "Commit verifier-added tests and fixes with `worktree commit`",
    ],
    [
      "verbs/verify.md",
      "A post-review re-check adds no tests",
      "verbs/implement.md",
      "Never re-check between rounds or add tests in a re-check",
    ],
    [
      "worktree-cleanup.md",
      "Report every retained owned path",
      "worktree-cleanup.md",
      "Resolve owned retained paths before a successful handoff",
    ],
    [
      "verbs/review.md",
      "worktree captures tracked and untracked",
      "toolkit.md",
      "Worktree captures HEAD plus tracked/untracked changes",
    ],
    [
      "verbs/review.md",
      "Verify claims against intent and current source",
      "review-rules.md",
      "Verify every claim against current source and governing outcomes",
    ],
    [
      "verbs/review.md",
      "Preserve prior findings, rulings",
      "review-rules.md",
      "Retain reviewed revision, scope, findings, rulings",
    ],
    [
      "verbs/plan.md",
      "Settle the approval tuple",
      "decision-frame.md",
      "one approval tuple of spec hash, plan hash and optional design hash",
    ],
    [
      "grounding.md",
      "resolve any symlinked cited path",
      "templates/explorer-brief.md",
      "resolve any symlinked path with `realpath`",
    ],
  ];

  for (const [oldFile, repeat, homeFile, home] of homes) {
    assert.ok(
      !referenceFile(oldFile).includes(repeat),
      `${oldFile} repeats: ${repeat}`
    );
    assert.ok(
      referenceFile(homeFile).includes(home),
      `${homeFile} lacks: ${home}`
    );
  }
});

test("flow defect repairs state and verifier disposable and refused-write rules", () => {
  const brief = read(`${root}references/templates/verifier-brief.md`);
  assert.match(
    brief,
    /disposable repositories you create and remove are excepted/u
  );
  assert.match(
    brief,
    /When the host refuses the report write, return the full report text/u
  );
  assert.match(brief, /A refused write needs no user ruling/u);
  const verify = read(`${root}references/verbs/verify.md`);
  assert.match(
    verify,
    /When the host refuses the report write, the verifier returns the full report text and the orchestrator persists it/u
  );
  assert.match(verify, /a refused write needs no user ruling/u);
});

test("design increments route isolated sessions", () => {
  const skill = read(`${root}SKILL.md`);
  const design = read(`${root}references/verbs/design.md`);
  assert.match(
    skill,
    /\| Design increment \| Child orchestrator where verified; else chain \|/u
  );

  for (const term of [
    "session init",
    "increment ID",
    "dependency order",
    "committed",
    "Reconcile",
  ]) {
    assert.ok(design.includes(term), term);
  }

  assert.match(
    design,
    /After continuation the child, or the parent when chaining, grounds one coherent plan/u
  );
  assert.match(design, /earlier outcomes only through their walkthroughs/iu);
});

test("child launch documents inheritance, mismatch fallback, chaining and continuation gating", () => {
  const providers = read(`${root}references/providers.md`);
  assert.match(providers, /definition with `model: inherit`/u);
  assert.match(
    providers,
    /on the same model Claude Code inherits session effort\./u
  );
  assert.match(
    providers,
    /Missing telemetry alone does not block documented inheritance\./u
  );
  assert.match(
    providers,
    /If the host cannot apply the settings or reports a mismatch, report the existing launch blocker with evidence\./u
  );
  assert.match(
    read(`${root}references/verbs/design.md`),
    /on capability-missing chain the increment in its session\./u
  );
  assert.match(
    read(`${root}references/templates/increment-orchestrator-brief.md`),
    /Wait for the parent to continue you before any increment work\./u
  );
});

test("design parent settles approval and caller commit", () => {
  const design = read(`${root}references/verbs/design.md`);

  for (const term of [
    "approval tuple",
    "opt-in",
    "empty commit",
    "record-only",
    "deviation",
  ]) {
    assert.ok(design.includes(term), term);
  }

  assert.match(
    design,
    /Before accepting or declining a deviation, obtain a user decision for .* disagreement or uncertainty about intent or trade-offs/u
  );
  assert.match(
    design,
    /Wait for that decision before ruling on or implementing the affected change\./u
  );
  assert.match(
    design,
    /Decline only when the increment can be met without the deviation/u
  );
  assert.match(
    design,
    /otherwise obtain user approval at medium and above; at low follow/u
  );
});

test("accepted review fixes route by artifact and change", () => {
  const rules = read(`${root}references/review-rules.md`);
  assert.match(rules, /plan and design fixes go to the orchestrator/iu);
  assert.match(
    rules,
    /mechanical correction confirmed by a deterministic check goes to utility first/iu
  );

  for (const trigger of [
    "multiple files",
    "an executable production statement",
    "a production configuration or schema directive that changes runtime behaviour",
    "a test assertion",
  ]) {
    assert.match(
      rules,
      new RegExp(
        `route a remaining fix to the responsible task writer if it changes[^.]*${trigger}`,
        "iu"
      )
    );
  }

  for (const pattern of [
    /orchestrator handles remaining small fixes/iu,
    /content-preserving rename.*one file/iu,
    /importer edit.*another file/iu,
    /standalone review.*direct/iu,
  ]) {
    assert.match(rules, pattern);
  }
});

test("writer review fix handoff preserves the integration boundary", () => {
  const guide = read(`${root}references/verbs/implement.md`);
  const fixes = read(`${root}references/review-fixes.md`);
  const skill = read(`${root}SKILL.md`);
  const brief = read(`${root}references/templates/writer-brief.md`);
  assert.ok(links(guide).includes("../review-fixes.md"));

  for (const pattern of [
    /clean integration worktree.*HEAD/iu,
    /absolute integration worktree.*paths/iu,
    /serial/iu,
    /retained.*writer/iu,
    /model candidates.*effort.*platform options/iu,
    /dropped.*writer or utility/iu,
    /HEAD.*delta/iu,
    /staged.*unstaged.*untracked/iu,
    /nonempty/iu,
    /partial edits.*replacement/iu,
    /worktree commit --review-fix/iu,
  ]) {
    assert.match(fixes, pattern);
  }

  assert.match(
    fixes,
    /full correction set in the accepted ruling’s `paths` field/u
  );
  assert.match(
    fixes,
    /latest accepted ruling that declares `paths` or fall back to the single-file locus when none does/u
  );
  assert.doesNotMatch(fixes, /`?fix`? field/iu);
  assert.match(
    fixes,
    /cross-ownership fix.*all approved paths.*task owning the defective behaviour.*resolve unclear ownership.*plan and integration evidence before writes/iu
  );
  assert.ok(links(fixes).includes("templates/quality-bar.md#shared"));
  assert.match(fixes, /reserve toolkit actions for the orchestrator/iu);
  assert.match(
    fixes,
    /assignee replies inline with status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`, changed paths and check results; it does not create, submit or integrate a task worktree/iu
  );
  assert.match(
    skill,
    /Follow-ups return inline without files, except assigned child increment continuation or review fix; review fixes also reply inline/iu
  );

  const routing = defined(
    defined(skill.split("## Routing\n")[1]).split("\n## ")[0]
  );

  assert.match(
    routing,
    /implementation integration mechanical fixes that a deterministic check confirms \| Utility subagent/iu
  );
  assert.match(
    routing,
    /remaining implementation integration fixes per \[writer triggers\]\(references\/review-rules\.md\) \| Writer at run level/iu
  );
  assert.match(
    routing,
    /remaining small integration fixes and standalone review fixes \| Orchestrator/iu
  );
  assert.match(
    read(`${root}references/toolkit.md`),
    /accepted fixes, including inspected assigned writer or utility deltas/iu
  );
  assert.match(
    brief,
    /For the ordinary task, reply only with status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`; `\{\{reportPath\}\}`; a one-line summary; and `concerns: <n>`/iu
  );
  assert.match(
    brief,
    /integration worktree.*listed paths; reply inline with status `DONE`, `BLOCKED` or `NEEDS_CONTEXT`, changed paths and check results\. Preserve the original `\{\{reportPath\}\}` and RED evidence/iu
  );
});

test("removed explorer config key explore-subagents is absent from code, tests and docs except allowed list", () => {
  const allowed = new Set(
    [
      "docs/decisions/0001-strict-dispatch-config-format.md",
      "docs/decisions/0015-native-subagent-routing.md",
      "skills/dispatch/scripts/lib/config.ts",
      "tests/unit/lib/config.test.ts",
      "tests/integration/skill-contract.test.ts",
      "skills/dispatch/config.local.jsonc",
    ].map((p) => path.normalize(p))
  );

  const filesToCheck = [
    ...listOverlayFiles("skills/dispatch"),
    ...listOverlayFiles("docs"),
    ...listOverlayFiles("tests"),
    "README.md",
  ];

  const violations: string[] = [];

  for (const rel of filesToCheck) {
    if (allowed.has(path.normalize(rel))) {
      continue;
    }

    const full = path.join(OVERLAY_ROOT, rel);

    try {
      const content = fs.readFileSync(full, "utf-8");

      if (content.includes("explore-subagents")) {
        violations.push(path.normalize(rel).replaceAll("\\", "/"));
      }
    } catch {
      // Unreadable entries cannot name the retired key.
    }
  }

  assert.deepEqual(
    violations,
    [],
    `files unexpectedly referencing explore-subagents: ${violations.join(", ")}`
  );
});

test("shipped SKILL.md and reference markdown name no retired verify spellings", () => {
  const files: string[] = [
    path.join(OVERLAY_ROOT, "skills", "dispatch", "SKILL.md"),
  ];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        files.push(full);
      }
    }
  };

  walk(path.join(OVERLAY_ROOT, "skills", "dispatch", "references"));
  const retired = /\bverify run\b|\bVerify:|Evidence:\s*verify\b/u;
  const hits: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");

    if (retired.test(content)) {
      hits.push(path.relative(OVERLAY_ROOT, file).replaceAll("\\", "/"));
    }
  }

  assert.deepEqual(
    hits,
    [],
    `retired verify spellings in shipped markdown: ${hits.join(", ")}`
  );
});

test("verifier brief states the ten proof standards and baseline rule with no URL", () => {
  const brief = read(`${root}references/templates/verifier-brief.md`);
  assert.doesNotMatch(brief, /https?:\/\//u);

  for (const pattern of [
    /real user path/iu,
    /action and the resulting state/iu,
    /side effects/iu,
    /mock only where a production boundary/iu,
    /dry-run or test mode/iu,
    /usable.*not process-up/iu,
    /read-only health check/iu,
    /stop only what you started.*never by process name/iu,
    /keep evidence after cleanup/iu,
    /never weaken a check/iu,
    /checks passed/u,
    /baseline row/iu,
  ]) {
    assert.match(brief, pattern);
  }
});

test("each preserved rule has one canonical home; review fix procedure and lightweight fix review keep one home", () => {
  const ref = (file: string) => read(`${root}references/${file}`);
  const skill = read(`${root}SKILL.md`);

  // Map correction: canonical home in grounding.md#check-and-recover; SKILL.md routing names only threshold-exceeding corrections.
  const grounding = ref("grounding.md");
  assert.match(
    grounding,
    /verifies and rules in every case[\s\S]*small corrections[\s\S]*utility subagent[\s\S]*context guard/iu
  );
  assert.match(
    skill,
    /\|[^|\n]*map corrections? (?:over|exceeding) the context-guard threshold[^|\n]*\| Utility subagent \|/iu
  );
  assert.doesNotMatch(skill, /\|[^|\n]*,\s*map correction,\s*/iu);

  // Explorer write scope: canonical home in grounding.md#publish; other sites drop "read-only" on explorers.
  assert.match(
    grounding,
    /writes only its assigned map file[^.]*nested partial maps/iu
  );
  assert.doesNotMatch(
    ref("glossary.md"),
    /explorer subagent \|[^|\n]*read-only/iu
  );
  assert.doesNotMatch(skill, /Explorer subagent \(read-only\)/iu);

  // Retained explorer follow-up: canonical home in SKILL.md#context-guard; grounding.md links it.
  assert.match(
    skill,
    /Ask a retained explorer a follow-up anytime, outside the limit/iu
  );
  assert.ok(links(grounding).includes("../SKILL.md#context-guard"));
  assert.doesNotMatch(
    grounding,
    /Ask a retained explorer a follow-up anytime, outside the limit/iu
  );

  // Cap, continuation, confirmation-only: saved round-1 cap in review-rules.md; coverage and toolkit link it.
  const rules = ref("review-rules.md");
  assert.match(rules, /at or above the saved round-1 cap/u);
  assert.doesNotMatch(rules, /configured cap/u);
  assert.ok(
    links(ref("review-coverage.md")).includes(
      "review-rules.md#review-provenance-and-applicability"
    )
  );
  assert.doesNotMatch(
    ref("review-coverage.md"),
    /when no accepted MUST or pending MUST rejection admits a round/u
  );
  const toolkit = ref("toolkit.md");
  assert.ok(
    links(toolkit).includes(
      "review-rules.md#review-provenance-and-applicability"
    )
  );
  assert.doesNotMatch(
    toolkit,
    /no accepted `MUST` and no accepted `SHOULD` below `cap1`/u
  );
  assert.doesNotMatch(
    toolkit,
    /report qualifying corrections as verified but not re-reviewed/u
  );

  // MUST-rejection delivery gate: canonical home in review-rules.md#rulings-and-fix-scope; toolkit and implement link it.
  assert.ok(
    rules.includes(
      "Delivery and report completion require confirmed applicable MUST rejections."
    )
  );
  assert.ok(links(toolkit).includes("review-rules.md#rulings-and-fix-scope"));
  assert.doesNotMatch(
    toolkit,
    /The same closure query gates report completion/u
  );
  const implement = ref("verbs/implement.md");
  assert.ok(
    links(implement).includes("../review-rules.md#rulings-and-fix-scope")
  );
  assert.doesNotMatch(
    implement,
    /pending or escalated confirmations block delivery and report completion/u
  );

  // Fix-interaction self-check and moved review-fix procedure.
  const reviewFixes = ref("review-fixes.md");
  const review = ref("verbs/review.md");
  assert.ok(
    links(reviewFixes).includes("review-rules.md#rulings-and-fix-scope")
  );
  assert.ok(links(reviewFixes).includes("templates/quality-bar.md#shared"));
  assert.ok(links(implement).includes("../review-fixes.md"));
  assert.doesNotMatch(implement, /worktree commit --review-fix/u);

  const fixRules = defined(rules.split("The orchestrator runs steps 1–3")[1]);

  const once = (needle: string) => {
    assert.equal(fixRules.split(needle).length - 1, 1, needle);
  };

  for (let n = 1; n <= 8; n += 1) {
    assert.match(fixRules, new RegExp(`^${n}${String.raw`\. `}`, "mu"));
  }

  for (const text of [
    "mode `inline`",
    "advisory",
    "`lint run --edit --fix-review-lite`",
    "`review run --note`",
  ]) {
    once(text);
  }

  assert.match(
    fixRules,
    /Repeat the review once at most per batch, only when the batch fixed an accepted MUST finding/u
  );
  assert.match(
    defined(toolkit.split("### edit")[1]),
    /For each edited artifact per fix batch, run `lint run --edit`/u
  );
  // The fix-review-lite task text lives in its template; each input slot and rule appears once there.
  const fixReviewLiteBrief = ref("templates/fix-review-lite-brief.md");
  assert.match(
    fixReviewLiteBrief,
    /Unresolved citations\. You may read their listed matches:[\s\n]+\{\{unresolved\}\}/u
  );
  assert.match(
    fixReviewLiteBrief,
    /Read only[^\n]*the listed citations and matches[^\n]*never read a withheld path/u
  );

  for (const text of [
    "Relative paths resolve against this root.",
    "{{questions}}",
    "{{diffPath}}",
    "{{artifact}}",
    "{{spec}}",
    "{{citations}}",
    "Report only false citations",
  ]) {
    assert.equal(fixReviewLiteBrief.split(text).length - 1, 1, text);
  }

  // REQ-4 bounds reads to the diff, artifact, spec and consumer searches; codegraph returns source outside that bound.
  assert.doesNotMatch(fixReviewLiteBrief, /codegraph explore/u);
  assert.match(skill, /Pass `--host <platform>`[^\n]*`brief fix-review-lite`/u);
  assert.match(
    fixRules,
    /code and integration fixes[\s\S]*whoever applied accepted fixes re-reads the changed sections or paths together with the other consumers of each touched contract/u
  );
  assert.match(
    fixRules,
    /launches no subagent and changes no roster, cap or round rule/u
  );
  assert.match(fixRules, /mark the review inline in the verb report/u);
  assert.match(
    rules,
    /For the final completed review round[^\n]*plan and design batches[^\n]*step 8/u
  );
  assert.match(fixRules, /verb report \(the plan or design handoff\)/u);
  assert.match(
    fixRules,
    /Verify each claim at source and fix or rule it before the next round or report/u
  );
  assert.match(
    reviewFixes,
    /steps 4–6 with the orchestrator’s stated step 3 root cause per group/u
  );
  assert.match(
    rules,
    /After claims settle, record one `note` per batch, including any repeat[^\n]*stable, unique one-based batch ordinal within that review round/u
  );
  assert.match(reviewFixes, /self-check for code fixes/u);
  assert.match(skill, /plan and design lightweight fix reviews/u);
  assert.match(review, /fix procedure/u);

  // Cleanup order: canonical home in worktree-cleanup.md; implement links it.
  assert.ok(links(implement).includes("../worktree-cleanup.md"));

  // Discard-work gate: canonical home in decision-frame.md#user-gate-boundaries; toolkit links it.
  assert.ok(links(toolkit).includes("decision-frame.md#user-gate-boundaries"));
  assert.doesNotMatch(
    toolkit,
    /Obtain user authority before discarded accepted work|obtain user authority when discarding work|authorize discarded work/u
  );

  // Standalone review adds no gate: canonical home in verbs/review.md; SKILL.md and spec-stage link it.
  assert.ok(links(skill).includes("references/verbs/review.md"));
  assert.doesNotMatch(skill, /Standalone review adds no approval gate/u);
  assert.ok(links(ref("spec-stage.md")).includes("verbs/review.md"));
  assert.doesNotMatch(
    ref("spec-stage.md"),
    /Standalone review settlement does not add an approval gate/u
  );

  // Read the whole spec: canonical home in spec-stage.md#readers-and-document-layers; verb guides link it.
  for (const verb of ["plan", "design", "review", "implement"]) {
    const text = ref(`verbs/${verb}.md`);
    assert.ok(
      links(text).includes("../spec-stage.md#readers-and-document-layers"),
      verb
    );
    assert.doesNotMatch(text, /read the whole|whole read/iu, verb);
  }

  // Never poll: canonical home in SKILL.md#launch-and-continue; toolkit links it.
  assert.ok(links(toolkit).includes("../SKILL.md#launch-and-continue"));
  assert.doesNotMatch(
    toolkit,
    /never poll, sleep-loop, or reread output while it runs/u
  );

  // Native-slot procedure: canonical home in providers.md#native-slots; toolkit and verbs/ask link it.
  assert.ok(links(toolkit).includes("providers.md#native-slots"));

  const nativeReplies =
    toolkit.split("## Native-slot replies")[1]?.split("\n## ")[0] ?? "";

  assert.doesNotMatch(
    nativeReplies,
    /Stop a timed-out handle before reporting it/u
  );
  assert.ok(
    links(ref("verbs/ask.md")).includes("../providers.md#native-slots")
  );
  assert.doesNotMatch(
    ref("verbs/ask.md"),
    /the first call returns descriptors before any CLI launch/u
  );

  // Writer plan read, affected checks and reply schema: canonical home in writer-brief.md.
  const planTemplate = ref("templates/plan.md");
  assert.match(planTemplate, /reading the whole plan only when/iu);
  assert.doesNotMatch(
    planTemplate,
    /from its start through `## Task Map`, then only its own task/u
  );
  assert.doesNotMatch(
    planTemplate,
    /full checks of modified logical test files or known impacted consumers before aggregate/u
  );
  assert.ok(links(implement).includes("../templates/writer-brief.md"));
  assert.doesNotMatch(
    implement,
    /Their reply gives status, `reportPath`, a one-line summary and `concerns: <n>`/u
  );

  // Three fix rounds: canonical home in verbs/verify.md; implement links it.
  assert.ok(links(implement).includes("verify.md"));
  assert.doesNotMatch(implement, /count three fix rounds per issue/u);

  // Settled-section regeneration: canonical home in review-rules.md; templates/plan and templates/design link it.
  assert.ok(links(planTemplate).includes("../review-rules.md"));
  assert.doesNotMatch(
    planTemplate,
    /renders current findings and round links from the ledger after each review round and ruling/u
  );
  const designTemplate = ref("templates/design.md");
  assert.ok(links(designTemplate).includes("../review-rules.md"));
  assert.doesNotMatch(
    designTemplate,
    /regenerates the findings section from the ledger after each review round and ruling/u
  );

  // Read-command allowlist: Claude and Copilot apply read-commands.
  const config = ref("readme/configuration.md");
  assert.match(config, /Claude and Copilot[^\n]*allowlist/iu);
  assert.doesNotMatch(config, /Only Claude has a command allowlist/u);

  // Diagnostics explorer use: readme/concepts.md matches diagnostics.md.
  const concepts = ref("readme/concepts.md");
  assert.match(concepts, /research explorer/iu);
  assert.doesNotMatch(concepts, /launches no subagent for it/u);

  // No Git writes: providers.md links quality-bar.md#shared.
  assert.ok(
    links(ref("providers.md")).includes("templates/quality-bar.md#shared")
  );
  assert.doesNotMatch(
    ref("providers.md"),
    /task writers edit only assigned paths and run no Git write commands/u
  );
});

test("implement runs the pre-cleanup check by changed-path class", () => {
  const implement = read(`${root}references/verbs/implement.md`);
  assert.match(implement, /when no path changed[^.]*run no check/iu);
  assert.match(
    implement,
    /matches no criterion's declared `Changes:` or `Tests:`[^.]*all-criteria `check run`/iu
  );
  assert.match(
    implement,
    /check run --criteria[^.]*automated criteria whose declared paths match/iu
  );
  assert.match(
    implement,
    /review-only criteria keep their user-evidence path/iu
  );
  assert.match(
    implement,
    /start all-criteria and contract \[checks\]\([^)]+\) \(`check run`\) as a background call[^.]*start code review on the same integration HEAD together/iu
  );

  const toolkit = read(`${root}references/toolkit.md`);
  assert.match(
    toolkit,
    /`?trees`? maps each `?removed`? ID to the accepted evidence tree/iu
  );
  assert.match(
    toolkit,
    /diff between that evidence tree and the pre-cleanup tree/iu
  );
  assert.match(toolkit, /verified at <tree>; tests removed in cleanup/u);

  const readmeImplement = read(`${root}references/readme/implement.md`);
  assert.match(
    readmeImplement,
    /cleanup starts without a full check run unless the verifier commit changed an undeclared path/iu
  );
});

test("readmes state the spec confirm gate at every level", () => {
  const files = [
    "README.md",
    `${root}README.md`,
    `${root}references/readme/concepts.md`,
    `${root}references/readme/plan.md`,
    `${root}references/readme/design.md`,
    `${root}references/readme/implement.md`,
  ];

  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /Approve spec at medium\+/iu, file);
    assert.doesNotMatch(
      text,
      /at (?:level )?`?medium`? and above[^.\n]*(?:approve|confirm) the spec/iu,
      file
    );
    assert.doesNotMatch(
      text,
      /at `?low`?[^.\n]*(?:shows you the spec|links the spec|shows the spec) at (?:the end|handoff)/iu,
      file
    );
    assert.match(
      text,
      /confirm(?:s|ed|ing)?[^\n]*every level|at every level[^\n]*confirm(?:s|ed|ing)?/iu,
      file
    );
  }

  for (const flow of ["plan", "design", "implement"]) {
    const text = read(`${root}references/readme/${flow}.md`);
    assert.match(text, /SpecGate\{"Confirm spec before/u, flow);
  }
});

test("only a subagent assigned a map may lint it", () => {
  const toolkit = read(`${root}references/toolkit.md`);
  const callTable = section(toolkit, "call table");
  assert.match(
    callTable,
    /subagent assigned a map[^\n]*`lint run` on that (?:assigned )?map only/iu
  );

  const skill = read(`${root}SKILL.md`);

  const utilityRow =
    skill.split("\n").find((line) => line.startsWith("| Utility subagent")) ??
    "";

  assert.match(utilityRow, /except `lint run` on an assigned map/iu);

  const concepts = read(`${root}references/readme/concepts.md`);
  assert.match(
    concepts,
    /Explorer subagents[\s\S]*write only an assigned map file[\s\S]*`lint run` on its assigned map only/iu
  );
  assert.match(
    concepts,
    /Utility subagents[\s\S]*except `lint run` on an assigned map/iu
  );
});

test("skill prose and scripts stay host-neutral without subagentModels", () => {
  const skill = read(`${root}SKILL.md`);
  const providers = read(`${root}references/providers.md`);
  const toolkit = read(`${root}references/toolkit.md`);

  for (const [name, text] of [
    ["SKILL.md", skill],
    ["providers.md", providers],
    ["toolkit.md", toolkit],
  ] as const) {
    assert.doesNotMatch(
      text,
      /subagentModels/u,
      `${name} omits subagentModels`
    );
  }

  const launchSection =
    skill.split("## Launch and continue\n")[1]?.split("\n## ")[0] ?? "";

  assert.ok(launchSection.length > 0, "SKILL.md has Launch and continue");
  assert.doesNotMatch(
    launchSection,
    // eslint-disable-next-line eslint/prefer-named-capture-group -- positional groups are used by the assertion below.
    /\b(opencode|agy|claude|codex|copilot)\b/iu,
    "SKILL.md launch rule names no platform"
  );

  assert.doesNotMatch(
    providers,
    /host-sandboxed|dangerouslyDisableSandbox|excludedCommands/u,
    "providers.md omits host-sandboxed recovery"
  );
  assert.doesNotMatch(
    providers,
    /closest `Model`|flash_lite/u,
    "providers.md omits agy Model list"
  );

  const scriptsDir = path.join(OVERLAY_ROOT, root, "scripts");

  const tsFiles = fs
    .readdirSync(scriptsDir, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

  for (const file of tsFiles) {
    const content = fs.readFileSync(path.join(scriptsDir, file), "utf-8");

    if (file === "toolkit/fanout/state.ts") {
      const stripped = content.replace(
        /(?:function normalizeNative\b|const normalizeNative\s*=)[\s\S]*?\n\};?/u,
        ""
      );

      assert.doesNotMatch(
        stripped,
        /subagentModels/u,
        "fanout/state.ts names subagentModels only inside normalizeNative"
      );
      assert.match(
        content,
        /(?:function normalizeNative\b|const normalizeNative\s*=)[\s\S]*?subagentModels/u,
        "fanout/state.ts keeps subagentModels in normalizeNative"
      );
    } else {
      assert.doesNotMatch(
        content,
        /subagentModels/u,
        `${file} omits subagentModels`
      );
    }
  }
});

test("checks passed condition has one home in brief verifier", () => {
  const toolkit = section(referenceFile("toolkit.md"), "brief verifier");
  const verify = referenceFile("verbs/verify.md");
  const implement = referenceFile("verbs/implement.md");
  assert.match(toolkit, /executed \+ reused > 0/u);
  assert.match(toolkit, /no bound integration is targeted/u);

  for (const guide of [verify, implement]) {
    assert.ok(links(guide).includes("../toolkit.md#brief-verifier"));
    assert.doesNotMatch(
      guide,
      /executed > 0|no bound integration is targeted|zero.command runs|zero commands ran|executed-command condition/u
    );
  }
});

test("implement step 7 and 8 synchronize stale-test cleanup and shared testing bar", () => {
  const implement = read(`${root}references/verbs/implement.md`);

  const step7 =
    implement.split("7. Apply [shared]")[1]?.split("8. Review")[0] ?? "";

  const step8 = implement.split("8. Review")[1]?.split("9. When")[0] ?? "";
  assert.ok(
    step7.length > 0 && step8.length > 0,
    "implement steps 7 and 8 exist"
  );

  // Fail-safe cleanup trigger: launches on Tests:, test/fixture/helper, source-code, or contract/spec diffs; skips only non-code/non-contract doc-only diffs.
  assert.match(step7, /git diff --name-only --no-renames <base>\.\.HEAD/u);
  assert.match(
    step7,
    /Tests:|test\/fixture\/helper|test, fixture, helper|source|contract|spec/iu
  );
  assert.match(step7, /doc-only|non-code\/non-contract/iu);
  assert.match(step7, /ledger append - --cleanup skip/u);
  assert.match(step7, /ledger append - --cleanup zero/u);

  // Pre-review handling of cleanup-flagged concerns (test-only helpers and uncovered/Check-pinned tier downgrades).
  assert.match(step7, /test-only/iu);
  assert.match(step7, /downgrade/iu);
  assert.match(step7, /worktree commit/u);
  assert.match(step7, /living-plan|revision protocol|line 38|step below/iu);

  // Code review enforces the identical testing bar and rejects restoration of bar-compliant pruning/downgrades.
  assert.match(step8, /identical|same/iu);
  assert.match(step8, /over-tiered|stale/iu);
  assert.match(step8, /downgrade/iu);
  assert.match(step8, /restor/iu);
});

// SECTION: One home per orchestrator rule

const templateDoc = (name: string) => referenceDoc(`templates/${name}`);

const guideLine = (text: string, lead: string) => {
  const line = text.split("\n").find((candidate) => candidate.includes(lead));
  assert.notEqual(line, undefined, `line containing ${lead}`);

  return line ?? "";
};

const headingBody = (text: string, heading: string) =>
  text.split(`## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

test("one home: --reuse precondition lives in check run", () => {
  for (const guide of ["verbs/implement", "verbs/verify"]) {
    const text = referenceDoc(guide);

    assert.doesNotMatch(text, /gitignored files and external state/u, guide);
    assert.doesNotMatch(text, /commands\[\]/u, guide);
    assert.doesNotMatch(text, /--fresh/u, guide);
    assert.match(
      text,
      /`--reuse`[^\n]*\[precondition\]\(\.\.\/toolkit\.md#check-run\)/u,
      guide
    );
  }

  const checkRun = section(referenceDoc("toolkit"), "check run");

  for (const term of [
    "`--reuse`",
    "gitignored files and external state (services, DBs, env, clock)",
    "each reused command's source execution",
    "`commands[]` in `.state/evidence/<hex>.json`",
    ".state/evidence/commands/index/<cacheHex>.json",
    ".state/evidence/commands/<execId>.json",
    "`createdAt`, `command`, `tree`",
    "even when no criterion evidence record was written yet",
    "cannot be established for every selected command's source execution",
  ]) {
    assert.ok(checkRun.includes(term), term);
  }

  assert.equal(
    checkRun.match(/bypasses within-run per-command deduplication/gu)?.length,
    1,
    "the --fresh bypass has one statement"
  );
});

test("one home: implement order lives in the implement procedure", () => {
  const skill = read(`${root}SKILL.md`);
  const line = guideLine(skill, "- `implement`:");

  assert.ok(links(line).includes("references/verbs/implement.md#procedure"));
  assert.ok(links(line).includes("references/worktree-cleanup.md"));
  assert.doesNotMatch(
    line,
    /integration checks|runtime verification|repair within scope|exact HEAD|Report behavior/u
  );
  assert.ok(line.indexOf("report complete") < line.indexOf("worktree cleanup"));
  assert.ok(
    !links(skill).includes(
      "references/review-rules.md#review-provenance-and-applicability"
    )
  );

  const procedure =
    referenceDoc("verbs/implement").split("## Interruption recovery")[0] ?? "";

  const order = [
    "[Land](../toolkit.md#worktree-land)",
    "Run [verification stage](verify.md)",
    "Run the test cleanup",
    "8. Review code",
    "9. When all review rounds settle",
    "11. Deliver the exact verified source",
    "Complete the [report](../toolkit.md#report-complete) after delivery",
    "clean owned worktrees under [worktree cleanup]",
  ].map((term) => procedure.indexOf(term));

  assert.ok(
    order.every((index) => index >= 0),
    String(order)
  );
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b)
  );
  assert.match(
    procedure,
    /Report behaviour, evidence and concerns through the walkthrough and artifact links\./u
  );
});

test("one home: native writer write boundary lives in the role table and quality bar", () => {
  const skill = read(`${root}SKILL.md`);

  assert.doesNotMatch(skill, /Native writers edit only assigned paths/u);
  assert.match(
    skill,
    /Native writers keep their role-table write scope and \[Git boundary\]\(references\/templates\/quality-bar\.md#shared\)\./u
  );
  assert.match(guideLine(skill, "| Writer |"), /Assigned task paths/u);
  assert.ok(
    templateDoc("quality-bar").includes(
      "Run no Git write commands (add, stash, commit, checkout, reset, restore)."
    )
  );
});

test("one home: broken-citation fail-closed lives in lint run and review run", () => {
  for (const guide of ["verbs/plan", "verbs/design"]) {
    const text = referenceDoc(guide);

    assert.doesNotMatch(text, /broken-citation/u, guide);
    assert.ok(links(text).includes("../toolkit.md#lint-run"), guide);
    assert.ok(links(text).includes("review.md"), guide);
  }

  assert.ok(
    links(referenceDoc("verbs/review")).includes("../toolkit.md#review-run")
  );

  const toolkit = referenceDoc("toolkit");

  assert.match(
    section(toolkit, "lint run"),
    /Plan and design artifacts also fail closed with `broken-citation` on invalid backticked repo-relative[^\n]*governed sections/u
  );
  assert.match(
    section(toolkit, "review run"),
    /Plan and design rounds also run blocking `broken-citation` validation[^\n]*governed sections/u
  );
});

test("one home: context-map sourcing lives in grounding check and recover", () => {
  const plan = referenceDoc("verbs/plan");
  const design = referenceDoc("verbs/design");

  for (const [name, text] of [
    ["plan", plan],
    ["design", design],
  ] as const) {
    assert.doesNotMatch(
      text,
      /spec-phase map|scope delta|current phase map|current design-phase map/u,
      name
    );
    assert.ok(links(text).includes("../grounding.md#check-and-recover"), name);
  }

  assert.match(
    plan,
    /When the phase context map exists, take items from the context maps; for an increment plan, also take increment-local items from its increment map\. Apply \[map checks\]\(\.\.\/grounding\.md#check-and-recover\) to these sources\./u
  );
  assert.match(
    design,
    /When a context map exists, take items from the context maps\. Apply \[map checks\]\(\.\.\/grounding\.md#check-and-recover\) to these sources\./u
  );

  const recover = headingBody(referenceDoc("grounding"), "Check and recover");

  for (const term of [
    "spec-phase map",
    "scope delta",
    "current phase map",
    "either is absent",
  ]) {
    assert.ok(recover.includes(term), term);
  }
});

test("one home: two writers never share a worktree lives in launch and continue", () => {
  const implement = referenceDoc("verbs/implement");

  assert.doesNotMatch(implement, /do not run two writers/u);
  assert.doesNotMatch(implement, /not a second writer/u);
  assert.match(
    implement,
    /A relaunch acknowledges the old writer as stopped; [^\n]*\]\(\.\.\/\.\.\/SKILL\.md#launch-and-continue\)/u
  );

  const launch = headingBody(read(`${root}SKILL.md`), "Launch and continue");

  assert.ok(
    launch.includes(
      "Two writers never share a worktree. A utility subagent under a writer is not a second writer."
    )
  );
});

test("one home: test cleanup runs only its edited test files in the cleanup brief", () => {
  const implement = referenceDoc("verbs/implement");

  assert.doesNotMatch(implement, /runs only its edited test files/u);
  assert.ok(links(implement).includes("../templates/test-cleanup-brief.md"));
  assert.match(
    templateDoc("test-cleanup-brief"),
    /Run only edited test files after edits/u
  );
});

test("one home: verifier approval classification lives in the verifier brief", () => {
  const verify = referenceDoc("verbs/verify");

  assert.doesNotMatch(verify, /Read-only calls|Persistent or shared state/u);
  assert.ok(
    links(verify).includes("../templates/verifier-brief.md#proof-standards")
  );
  assert.match(
    verify,
    /returning `NEEDS_APPROVAL` with a batched request[^\n]*declined check is `not proved` and is a limit, not an issue/u
  );

  const proof = headingBody(templateDoc("verifier-brief"), "Proof standards");

  for (const term of [
    "Read-only calls, local servers and disposable resources you create and remove need no approval",
    "persistent or shared state",
    "external messages",
    "paid calls",
    "non-local actions",
  ]) {
    assert.ok(proof.includes(term), term);
  }
});

test("one home: landing a finished task is one call in the implement procedure", () => {
  const implement = referenceDoc("verbs/implement");
  const procedure = implement.split("## Interruption recovery")[0] ?? "";
  const step = guideLine(procedure, "5. Inspect the actual delta");

  assert.ok(links(step).includes("../toolkit.md#worktree-land"));
  assert.match(step, /`worktree continue`/u);
  assert.match(step, /`check run --task <task>`/u);

  for (const primitive of ["worktree-submit", "worktree-integrate"]) {
    assert.ok(
      !links(implement).includes(`../toolkit.md#${primitive}`),
      primitive
    );
  }

  assert.match(
    guideLine(implement, "| Submit, integrate, and verify criteria"),
    /\[worktree land\]\(\.\.\/toolkit\.md#worktree-land\)/u
  );
});

test("one home: plan and design fix batches name the two combined forms in the edit-first order", () => {
  const rules = referenceDoc("review-rules");

  const item =
    rules.split(/^8\. /mu)[1]?.split("\n\nFor code and integration fixes")[0] ??
    "";

  assert.ok(item.length > 0, "item 8 exists");
  assert.doesNotMatch(item, /brief fix-review-lite/u);
  assert.doesNotMatch(item, /--host/u);

  const order = [
    "`lint run --edit --fix-review-lite`",
    "launch it on its",
    "`review run --note`",
    "`ledger append`",
  ].map((term) => item.indexOf(term));

  assert.ok(
    order.every((index) => index >= 0),
    String(order)
  );
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b)
  );
  assert.match(
    item,
    /`ledger append`[^\n]*before the report after a final batch/u
  );
  assert.match(item, /`--fix-review-lite` on the further `lint run --edit`/u);
});
