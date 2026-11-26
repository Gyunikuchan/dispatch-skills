import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASELINE,
  MANIFEST,
  SKILL_LINKS,
  checkGrowth,
  formatReport,
  main,
  measure,
  normalizeSkillLink,
  slug,
  validatePathLinks,
} from "../../scripts/path-bytes.ts";
import type {
  Figures,
  PathManifest,
  PathName,
} from "../../scripts/path-bytes.ts";
import { KINDS } from "../../skills/dispatch/scripts/toolkit/records.ts";
import { defined } from "../helpers/guards.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const skillDir = path.join(root, "skills/dispatch");

const readFile = (rel: string) =>
  fs.readFileSync(path.join(skillDir, rel), "utf-8");

const toolkit = readFile("references/toolkit.md");

interface Occurrence {
  target: string;
  stepText: string | null;
  sentence: string;
  clause: string;
  line: string;
}

const guideOccurrences = (
  name: string,
  text = readFile(`references/verbs/${name}.md`)
) => {
  const stepStart = text.indexOf("## Step reads");
  const found: Occurrence[] = [];
  let offset = 0;

  for (const line of text
    .replaceAll(/(?<g1>[^\n])\n(?=[^\n|#])/gu, "$1 ")
    .split("\n")) {
    const inSteps = stepStart !== -1 && offset > stepStart;

    const isRow =
      inSteps &&
      line.startsWith("| ") &&
      !line.startsWith("| Step") &&
      !line.startsWith("| ---");

    const stepText = isRow ? defined(line.split("|")[1]).trim() : null;
    const pieces: { start: number; end: number }[] = [];
    let from = 0;

    for (const match of line.matchAll(/\.\s+/gu)) {
      pieces.push({ start: from, end: match.index + 1 });
      from = match.index + match[0].length;
    }

    pieces.push({ start: from, end: line.length });

    for (const match of line.matchAll(/\]\((?<g1>[^)\s]+)\)/gu)) {
      const target = normalizeSkillLink(
        `references/verbs/${name}.md`,
        defined(match[1])
      );

      if (target === null) {
        continue;
      }

      const piece = defined(
        pieces.find(
          (candidate) =>
            match.index >= candidate.start && match.index < candidate.end
        )
      );

      found.push({
        target,
        stepText,
        sentence: line.slice(piece.start, piece.end),
        clause: line.slice(
          Math.max(piece.start, line.lastIndexOf(";", match.index) + 1),
          (() => {
            const end = line.indexOf(";", match.index);

            return end === -1 ? piece.end : Math.min(end, piece.end);
          })()
        ),
        line,
      });
    }

    offset += line.length + 1;
  }

  return found;
};

interface Heading {
  title: string;
  group: string;
  level: 2 | 3;
}

const toolkitHeadings = () => {
  const map = new Map<string, Heading>();
  let group = "";

  for (const line of toolkit.split("\n")) {
    const match = /^(?<g1>#{2,3})\s+(?<g2>.*?)\s*$/u.exec(line);

    if (!match) {
      continue;
    }

    if (match[1] === "##") {
      group = defined(match[2]);
      map.set(slug(group), { title: group, group, level: 2 });
    } else {
      map.set(slug(defined(match[2])), {
        title: defined(match[2]),
        group,
        level: 3,
      });
    }
  }

  return map;
};

const GUIDES = [
  "ask",
  "design",
  "plan",
  "implement",
  "review",
  "verify",
] as const;

test("path link validation reports missing, stale and bad-anchor destinations for both declaration sources", () => {
  assert.deepEqual(validatePathLinks(readFile), []);
  const { guide } = MANIFEST.ask;
  const skill = "SKILL.md";
  const badAnchorSource = "references/providers.md";
  const originalAnchor = "## Native slots";
  assert.ok(readFile(badAnchorSource).includes(originalAnchor));
  const guideText = readFile(guide);
  const skillText = readFile(skill);
  const missing = "references/absent.md";
  const staleGuide = "references/decision-frame.md";
  const staleSkill = "references/decision-frame.md";

  const edited = new Map([
    [guide, guideText.replaceAll("](../decision-frame.md)", "](../absent.md)")],
    [
      skill,
      skillText.replaceAll(`](${staleSkill})`, "](<references/./absent.md>)"),
    ],
    [
      badAnchorSource,
      readFile(badAnchorSource).replace(originalAnchor, "## Renamed slots"),
    ],
  ]);

  const errors = validatePathLinks(
    (file) => edited.get(file) ?? readFile(file)
  );

  for (const [source, stale] of [
    [guide, staleGuide],
    [skill, staleSkill],
  ] as const) {
    assert.ok(
      errors.includes(`${source}: undeclared link ${missing}`),
      errors.join("\n")
    );
    assert.ok(
      errors.includes(`${source}: stale declaration ${stale}`),
      errors.join("\n")
    );
    assert.ok(
      errors.includes(`${source}: missing link file ${missing}`),
      errors.join("\n")
    );
    assert.ok(
      errors.includes(
        `${source}: invalid link anchor references/providers.md#native-slots`
      ),
      errors.join("\n")
    );
  }
});

test("path link classes follow the step text and the stated conditions", () => {
  const [wrapped] = guideOccurrences(
    "ask",
    "Earlier condition. When the branch applies,\nread [guidance](../grounding.md)."
  );

  assert.equal(
    defined(wrapped).sentence,
    "When the branch applies, read [guidance](../grounding.md)."
  );

  const [first, second] = guideOccurrences(
    "ask",
    "Read [routing](../../SKILL.md#routing); read [guidance](../grounding.md) only when needed."
  );

  const suffix = /\bonly (?<g1>on|when|if|for)\b/iu;
  assert.doesNotMatch(defined(first).clause, suffix);
  assert.match(defined(second).clause, suffix);

  for (const name of GUIDES) {
    const { links } = MANIFEST[name];
    const occurrences = guideOccurrences(name);

    for (const [target, entry] of Object.entries(links)) {
      const own = occurrences.filter((item) => item.target === target);

      if (target === "references/toolkit.md") {
        assert.equal(
          entry.class,
          "owner",
          `${name}: an anchorless toolkit link names the contract owner`
        );
        continue;
      }

      assert.notEqual(
        entry.class,
        "owner",
        `${name}: ${target} is not an owner link`
      );
      const rows = own.filter((item) => item.stepText !== null);

      if (rows.length) {
        const derived = rows.some(
          (item) => !/\b(?<g1>when|only)\b/iu.test(defined(item.stepText))
        )
          ? "unconditional"
          : "conditional";

        assert.equal(
          entry.class,
          derived,
          `${name}: ${target} class follows its Step reads text`
        );
      }

      if (entry.class === "conditional") {
        assert.ok(
          entry.when !== undefined && entry.when !== null && entry.when !== "",
          `${name}: ${target} states its condition`
        );

        for (const item of own.filter(
          (candidate) =>
            candidate.stepText === null &&
            !rows.some(
              (row) => !/\b(?<g1>when|only)\b/iu.test(defined(row.stepText))
            )
        )) {
          assert.ok(
            item.sentence.toLowerCase().includes(entry.when.toLowerCase()),
            `${name}: ${target} paragraph carries its condition "${entry.when}": ${item.sentence}`
          );
        }
      } else if (!rows.length) {
        for (const item of own) {
          assert.ok(
            !/^\W*(?<g1>when|if|for)\b/iu.test(item.sentence) &&
              !/\bonly (?<g1>on|when|if|for)\b/iu.test(item.clause),
            `${name}: ${target} is unconditional but its sentence states a condition: ${item.sentence}`
          );
        }
      }
    }
  }
});

test("path call sequences cover every toolkit anchor of their guides", () => {
  for (const name of GUIDES) {
    const { links, calls } = MANIFEST[name];
    const headings = toolkitHeadings();

    for (const [target, entry] of Object.entries(links)) {
      const anchor = /^references\/toolkit\.md#(?<g1>.+)$/u.exec(target)?.[1];

      if (anchor === undefined || anchor === null || anchor === "") {
        continue;
      }

      const heading = headings.get(anchor);
      assert.ok(heading, `${name}: ${target} resolves to a toolkit heading`);

      if (heading.level === 2) {
        assert.equal(
          heading.title,
          "Session commands",
          `${name}: ${target} names the session command group`
        );
        assert.equal(
          entry.class,
          "conditional",
          `${name}: ${target} is read for the increment branch`
        );
        continue;
      }

      const call =
        heading.group === "Ledger records"
          ? calls.find(
              (item) =>
                item.action === "ledger append" && item.kind === heading.title
            )
          : calls.find(
              (item) =>
                item.action === heading.title &&
                (heading.title === "ledger append" || item.kind === undefined)
            );

      assert.ok(call, `${name}: ${target} is in the call sequence`);

      if (entry.class === "conditional") {
        assert.equal(
          call.count,
          0,
          `${name}: ${target} is conditional, so it counts 0`
        );
      } else {
        assert.ok(
          call.count > 0,
          `${name}: ${target} is unconditional, so it counts at least 1`
        );
      }
    }
  }
});

test("path ledger calls name a record kind and other calls name a tool action", () => {
  for (const name of GUIDES) {
    const headings = toolkitHeadings();

    for (const call of MANIFEST[name].calls) {
      if (call.action === "ledger append") {
        assert.ok(
          // SAFETY: test fixture pins the concrete shape asserted below.
          // eslint-disable-next-line typescript/strict-boolean-expressions -- fixture value is validated by the assertion.
          call.kind && (KINDS as readonly string[]).includes(call.kind),
          `${name}: ledger append names a record kind: ${call.kind}`
        );
        assert.equal(headings.get(slug(call.kind))?.group, "Ledger records");
      } else {
        assert.equal(
          call.kind,
          undefined,
          `${name}: ${call.action} takes no record kind`
        );
        assert.equal(
          headings.get(slug(call.action))?.group,
          "Tool actions",
          `${name}: ${call.action} is a tool action`
        );
      }
    }
  }
});

const file = (...sections: [string, number][]) =>
  `${sections.map(([title, size]) => `### ${title}\n${"x".repeat(size)}`).join("\n")}\n`;

const sectionSize = (title: string, size: number) =>
  `### ${title}`.length + 1 + size;

test("measure counts each section per call before and once per run after", () => {
  const files = new Map(
    Object.entries({
      "SKILL.md": "S".repeat(100),
      "references/verbs/p.md": "G".repeat(200),
      "references/a.md": "A".repeat(300),
      "references/templates/quality-bar.md": file(["plan", 50]),
      "references/toolkit.md": file(
        ["call table", 10],
        ["do it", 20],
        ["ledger append", 30],
        ["k", 40],
        ["unused", 99]
      ),
    })
  );

  const manifest: Record<"p", PathManifest> = {
    p: {
      guide: "references/verbs/p.md",
      links: {
        "references/a.md": { class: "unconditional" },
        "references/skipped.md": { class: "conditional", when: "x" },
        "references/templates/quality-bar.md#plan": { class: "unconditional" },
        "references/toolkit.md#do-it": { class: "unconditional" },
        "references/toolkit.md": { class: "owner" },
      },
      calls: [
        { action: "do it", count: 3 },
        { action: "ledger append", kind: "k", count: 2 },
        { action: "unused", count: 0 },
      ],
    },
  };

  const reads = 100 + 200 + 300 + sectionSize("plan", 50);

  const doIt = sectionSize("do it", 20);
  const append = sectionSize("ledger append", 30);
  const kind = sectionSize("k", 40);
  const table = sectionSize("call table", 10);

  const read = (rel: string) =>
    files.get(rel) ?? assert.fail(`unexpected read ${rel}`);

  files.set(
    "references/toolkit.md",
    read("references/toolkit.md").replace(
      `### do it\n${"x".repeat(20)}`,
      `### do it\n<!-- GENERATED: action:do-it -->${"x".repeat(20)}<!-- END GENERATED: action:do-it -->`
    )
  );
  const before = measure(read, "before", manifest).p;
  assert.equal(before.distinct, reads + doIt + append + kind);
  assert.equal(before.workload, reads + 3 * doIt + 2 * append + 2 * kind);
  assert.equal(
    before.editableDistinct,
    before.distinct - sectionSize("plan", 50)
  );
  assert.equal(
    before.editableWorkload,
    before.workload - sectionSize("plan", 50)
  );

  const preload = measure(read, "preload", manifest).p;
  assert.equal(preload.distinct, reads + table + doIt + append + kind);
  assert.equal(preload.workload, preload.distinct);
  assert.equal(
    preload.editableWorkload,
    preload.workload - sectionSize("plan", 50)
  );

  const after = measure(read, "after", manifest).p;
  assert.equal(after.distinct, reads + table);
  assert.equal(after.workload, after.distinct);
  assert.equal(
    after.editableWorkload,
    after.workload - sectionSize("plan", 50)
  );
});

test("measure counts a section once when its whole file is already read", () => {
  const read = (rel: string) =>
    ({
      "SKILL.md": "S",
      "references/verbs/p.md": "G",
      "references/a.md": file(["one", 5], ["two", 7]),
      "references/toolkit.md": file(["call table", 1]),
    })[rel] ?? "";

  const manifest = {
    p: {
      guide: "references/verbs/p.md",
      calls: [],
      links: {
        "references/a.md": { class: "unconditional" },
        "references/a.md#one": { class: "unconditional" },
        "SKILL.md#routing": { class: "unconditional" },
      },
    },
  } satisfies Record<"p", PathManifest>;

  const figures = measure(read, "before", manifest).p;
  assert.equal(
    figures.distinct,
    1 + 1 + Buffer.byteLength(file(["one", 5], ["two", 7]))
  );
});

test("growth above the baseline fails and a smaller figure passes", () => {
  const same = {
    ...BASELINE,
    plan: { ...BASELINE.plan },
    implement: { ...BASELINE.implement },
  };

  assert.deepEqual(checkGrowth(same), []);

  const smaller = {
    ...BASELINE,
    plan: { ...BASELINE.plan, workload: BASELINE.plan.workload - 1 },
    implement: { ...BASELINE.implement },
  };

  assert.deepEqual(checkGrowth(smaller), []);

  const grown: Record<PathName, Figures> = {
    ...BASELINE,
    plan: { ...BASELINE.plan },
    implement: {
      ...BASELINE.implement,
      workload: BASELINE.implement.workload + 1,
    },
  };

  const errors = checkGrowth(grown);
  assert.equal(errors.length, 1);
  assert.match(defined(errors[0]), /implement.*workload/u);
});

test("the report prints distinct, workload and editable bytes with reductions for both paths", () => {
  const result = measure(readFile, "after");
  const report = formatReport(result);

  for (const name of GUIDES) {
    const figures = result[name];

    for (const [label, key] of [
      ["distinct", "distinct"],
      ["workload", "workload"],
      ["editable distinct", "editableDistinct"],
      ["editable workload", "editableWorkload"],
    ] as const) {
      assert.match(
        report,
        new RegExp(
          `${name} ${label}: ${figures[key]} bytes \\(baseline \\d+, -?\\d+(\\.\\d)?%\\)`,
          "u"
        )
      );
    }
  }

  const baseline: Record<PathName, Figures> = {
    ...BASELINE,
    plan: {
      distinct: 100,
      workload: 200,
      editableDistinct: 50,
      editableWorkload: 100,
    },
    implement: {
      distinct: 100,
      workload: 200,
      editableDistinct: 50,
      editableWorkload: 100,
    },
  };

  const synthetic: Record<PathName, Figures> = {
    ...BASELINE,
    plan: {
      distinct: 90,
      workload: 150,
      editableDistinct: 40,
      editableWorkload: 90,
    },
    implement: {
      distinct: 110,
      workload: 151,
      editableDistinct: 50,
      editableWorkload: 100,
    },
  };

  assert.equal(
    formatReport(
      { plan: synthetic.plan, implement: synthetic.implement },
      baseline
    ),
    [
      "plan distinct: 90 bytes (baseline 100, 10.0%)",
      "plan workload: 150 bytes (baseline 200, 25.0%)",
      "plan editable distinct: 40 bytes (baseline 50, 20.0%)",
      "plan editable workload: 90 bytes (baseline 100, 10.0%)",
      "plan workload 25% target: met (reported only)",
      "implement distinct: 110 bytes (baseline 100, -10.0%)",
      "implement workload: 151 bytes (baseline 200, 24.5%)",
      "implement editable distinct: 50 bytes (baseline 50, 0.0%)",
      "implement editable workload: 100 bytes (baseline 100, 0.0%)",
      "implement workload 25% target: not met (reported only)",
      "",
    ].join("\n")
  );
});

test("SKILL_LINKS flags count only normal-path reads", () => {
  const entries = Object.entries<Record<PathName, boolean>>(SKILL_LINKS);

  const original = entries.map(([target, cells]) => ({
    target,
    cells,
    flags: { ...cells },
  }));

  const fakeManifest = Object.fromEntries(
    GUIDES.map((name) => [
      name,
      {
        guide: `fake/${name}`,
        links: {},
        calls: [],
      },
    ])
  );

  try {
    for (const [, cells] of entries) {
      for (const name of GUIDES) {
        cells[name] = false;
      }
    }

    for (const { target, cells, flags } of original) {
      // eslint-disable-next-line eslint/no-shadow -- fixture-local name intentionally mirrors the outer contract.
      const [file, anchor] = target.split("#");

      const heading =
        anchor !== undefined && anchor !== null && anchor !== ""
          ? `## ${anchor}\n`
          : "";

      const body =
        heading +
        "x".repeat(10) +
        (file === "references/toolkit.md" ? "\n## call table\ntable" : "");

      const read = (rel: string) =>
        // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
        rel === file
          ? body
          : rel === "references/toolkit.md"
            ? "## call table\ntable"
            : "";

      const size = Buffer.byteLength(
        anchor !== undefined && anchor !== null && anchor !== ""
          ? (heading + "x".repeat(10)).trimEnd()
          : body
      );

      const empty = measure(read, "after", fakeManifest);
      Object.assign(cells, flags);
      const actual = measure(read, "after", fakeManifest);

      for (const name of GUIDES) {
        const before = empty[name];
        const after = actual[name];
        assert.ok(before && after);
        assert.equal(
          after.workload - before.workload,
          flags[name] ? size : 0,
          `${name}: ${target}`
        );
      }

      for (const name of GUIDES) {
        cells[name] = false;
      }
    }
  } finally {
    for (const { cells, flags } of original) {
      Object.assign(cells, flags);
    }
  }
});

test("a read that SKILL.md mandates counts once on each path that makes it", () => {
  const pad = "x".repeat(10);

  const grow = (rel: string, marker: string) => (name: string) => {
    const text = readFile(name);

    return name === rel ? text.replace(marker, marker + pad) : text;
  };

  const base = measure(readFile, "after");

  const native = measure(
    grow("references/toolkit.md", "## Native-slot replies\n"),
    "after"
  );

  assert.equal(native.plan.workload - base.plan.workload, 10);
  assert.equal(native.implement.workload - base.implement.workload, 10);
  const onDiskMarker = "<!-- GENERATED: direct-read -->\n";

  const direct = measure(
    (rel) =>
      rel === "references/toolkit.md"
        ? readFile(rel).replace(
            "## Native-slot replies\n",
            `## Native-slot replies\n${onDiskMarker}`
          )
        : readFile(rel),
    "after"
  );

  assert.equal(
    direct.plan.workload - base.plan.workload,
    Buffer.byteLength(onDiskMarker)
  );

  const cleanup = measure(
    grow("references/worktree-cleanup.md", "# "),
    "after"
  );

  assert.equal(cleanup.plan.workload - base.plan.workload, 0);
  assert.equal(cleanup.implement.workload - base.implement.workload, 10);

  const gate = measure(
    grow("references/decision-frame.md", "## User Gate Boundaries\n"),
    "after"
  );

  assert.equal(gate.plan.workload - base.plan.workload, 10);
  assert.equal(gate.implement.workload - base.implement.workload, 10);
  const outside = measure(grow("references/decision-frame.md", "# "), "after");
  assert.equal(outside.plan.workload - base.plan.workload, 10);
  assert.equal(outside.implement.workload - base.implement.workload, 0);
});

const unknownCommit = () => {
  throw new Error("unknown commit");
};

const showCommit = (args: string[]) => {
  if (args[0] === "rev-parse") {
    return "resolved-object\n";
  }

  assert.ok(defined(args[1]).startsWith("resolved-object:skills/dispatch/"));

  return readFile(defined(defined(args[1]).split(":skills/dispatch/")[1]));
};

const showIncompleteCommit = (args: string[]) => {
  if (args[0] === "rev-parse") {
    return "ok";
  }

  const rel = defined(defined(args[1]).split(":skills/dispatch/")[1]);

  if (rel === "references/verbs/ask.md") {
    throw new Error("absent file");
  }

  const text = readFile(rel);

  return rel === "references/grounding.md"
    ? text.replace("## Check and recover", "## Removed section")
    : text;
};

test("path bytes main refuses unknown arguments and commits", () => {
  let errors = "";
  let output = "";

  const capture = {
    stdout(text: string) {
      output += text;
    },
    stderr(text: string) {
      errors += text;
    },
  };

  for (const args of [["--bad"], ["--at"]]) {
    errors = "";
    assert.equal(main(args, undefined, undefined, capture), 2);
    assert.match(errors, /Usage:/u);
  }

  errors = "";
  assert.equal(main(["--at", "missing"], unknownCommit, undefined, capture), 2);
  assert.match(errors, /unknown commit/u);
  assert.equal(output, "");
});

test("path bytes measures a commit through git show", () => {
  let output = "";

  const capture = {
    stdout(text: string) {
      output += text;
    },
    stderr: (text: string) => {
      throw new Error(text);
    },
  };

  assert.equal(main(["--at", "fake"], showCommit, undefined, capture), 0);
  assert.match(output, /ask distinct:/u);
  output = "";
  assert.equal(
    main(["--at", "fake"], showIncompleteCommit, undefined, capture),
    0
  );
  assert.match(output, /ask: missing absent file/u);
  assert.match(output, /plan: missing .*no section/u);
  assert.doesNotMatch(output, /ask distinct:|plan distinct:/u);
  assert.match(output, /review distinct:/u);
});

test("path bytes check baseline fails on any figure mismatch", () => {
  const git = (args: string[]) =>
    args[0] === "rev-parse"
      ? "ok"
      : readFile(defined(defined(args[1]).split(":skills/dispatch/")[1]));

  const current = measure(readFile, "preload");
  assert.equal(main(["--check-baseline"], git, current), 0);

  for (const [key, delta] of [
    ["workload", -1],
    ["workload", 1],
    ["distinct", 1],
  ] as const) {
    const changed = structuredClone(current);
    changed.plan[key] += delta;
    assert.equal(main(["--check-baseline"], git, changed), 1);
  }
});

test("path bytes resolves one archived repair brief only when the live section is absent", () => {
  const liveHeading = "### brief fix-review-lite";
  const archivedHeading = "### brief fix-archive-now";
  // Equal heading lengths isolate selection from measurement.
  const current = measure(readFile, "preload");

  const checkout = (heading: string) => (rel: string) =>
    rel === "references/toolkit.md"
      ? toolkit.replace(liveHeading, heading)
      : readFile(rel);

  let output = "";

  const capture = {
    stdout(text: string) {
      output += text;
    },
    stderr() {},
  };

  const check = (heading: string) => {
    output = "";

    return main(
      ["--check-baseline"],
      (args) =>
        args[0] === "rev-parse"
          ? "ok"
          : checkout(heading)(
              defined(defined(args[1]).split(":skills/dispatch/")[1])
            ),
      current,
      capture
    );
  };

  assert.equal(check(archivedHeading), 0);
  assert.throws(
    () => measure(checkout(archivedHeading), "preload"),
    /no section "brief fix-review-lite"/u
  );
  assert.equal(check("### archived other action"), 1);
  assert.match(output, /0 archived repair brief sections/u);
  assert.equal(check(`${archivedHeading}\n\n### brief fix-second`), 1);
  assert.match(output, /2 archived repair brief sections/u);
  assert.equal(
    check(`${archivedHeading}\n\n### brief fix-second\n\n${liveHeading}`),
    0
  );
});
