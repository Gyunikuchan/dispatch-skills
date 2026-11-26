import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stripGeneratedMarkers } from "../skills/dispatch/scripts/toolkit/contracts.ts";

// SECTION: Types

export type LinkClass = "unconditional" | "conditional" | "owner";

/** `when` states the condition of a conditional link; the test requires it near every prose occurrence. */
export interface LinkEntry {
  class: LinkClass;
  when?: string;
}

/** A tool call on the normal path; `kind` names the record kind of a `ledger append`. Count 0 lists a conditional anchor. */
export interface Call {
  action: string;
  kind?: string;
  count: number;
}

/** Targets are `references/...` paths relative to skills/dispatch, with an optional `#anchor`. */
export interface PathManifest {
  guide: string;
  links: Record<string, LinkEntry>;
  calls: Call[];
}

export interface Figures {
  distinct: number;
  workload: number;
  editableDistinct: number;
  editableWorkload: number;
}

export type Model = "before" | "preload" | "after";

export type Read = (rel: string) => string;

export type PathName =
  | "ask"
  | "design"
  | "plan"
  | "implement"
  | "review"
  | "verify";

// SECTION: Manifest (fixed normal-path model; counts are representative, not observed averages)

const unconditional: LinkEntry = { class: "unconditional" };
const owner: LinkEntry = { class: "owner" };

const conditional = (when: string) =>
  ({
    class: "conditional",
    when,
  }) satisfies LinkEntry;

const call = (action: string, count: number) =>
  ({ action, count }) satisfies Call;

const record = (kind: string, count: number) =>
  ({
    action: "ledger append",
    kind,
    count,
  }) satisfies Call;

const TOOLKIT = "references/toolkit.md";
const BAR = "references/templates/quality-bar.md";

export const MANIFEST: Record<PathName, PathManifest> = {
  ask: {
    guide: "references/verbs/ask.md",
    links: {
      "SKILL.md#routing": unconditional,
      "references/grounding.md#publish": conditional("only when"),
      "references/toolkit.md#ask-run": unconditional,
      "references/grounding.md": conditional("when"),
      "references/decision-frame.md": conditional("When source checks"),
      "references/providers.md#native-slots": unconditional,
      "references/providers.md": unconditional,
    },
    calls: [call("ask run", 1)],
  },
  design: {
    guide: "references/verbs/design.md",
    links: {
      "references/spec-authoring.md#resolve-and-author":
        conditional("No current spec"),
      "references/grounding.md#scope-round": unconditional,
      [`${BAR}#shared`]: unconditional,
      [`${BAR}#spec`]: unconditional,
      [`${BAR}#design`]: unconditional,
      "references/spec-stage.md#readers-and-document-layers": unconditional,
      "references/templates/design.md": unconditional,
      "references/grounding.md#check-and-recover": unconditional,
      [`${TOOLKIT}#lint-run`]: unconditional,
      [`${TOOLKIT}#bind`]: unconditional,
      "references/spec-stage.md#run-level": unconditional,
      "references/review-rules.md": unconditional,
      "references/verbs/review.md": unconditional,
      "references/spec-stage.md#revision-protocol": unconditional,
      [`${TOOLKIT}#edit`]: unconditional,
      "references/verbs/implement.md": unconditional,
      [`${TOOLKIT}#session-commands`]: conditional("For each ready increment"),
      "references/templates/increment-orchestrator-brief.md":
        conditional("On a verified host"),
      "references/providers.md#child-orchestrators":
        conditional("On a verified host"),
      "references/grounding.md#design-increments": unconditional,
      "references/decision-frame.md#user-gate-boundaries":
        conditional("user gate"),
      "references/spec-stage.md#approval": conditional("otherwise"),
      [`${TOOLKIT}#worktree-deliver`]: conditional("With the opt-in"),
    },
    calls: [
      call("doctor run", 1),
      call("lint run", 1),
      call("review run", 2),
      call("brief fix-review-lite", 1),
      record("bind", 1),
      record("edit", 1),
      call("worktree deliver", 0),
    ],
  },
  // Normal review assumes a code target; plan/design edit records are conditional.
  review: {
    guide: "references/verbs/review.md",
    links: {
      "references/spec-stage.md#readers-and-document-layers": unconditional,
      [`${TOOLKIT}#review-run`]: unconditional,
      [`${BAR}#shared`]: unconditional,
      [`${BAR}#spec`]: unconditional,
      [`${BAR}#plan`]: unconditional,
      [`${BAR}#testing`]: unconditional,
      [`${BAR}#design`]: unconditional,
      [`${BAR}#code`]: unconditional,
      "references/review-rules.md": unconditional,
      [`${TOOLKIT}#ruling`]: unconditional,
      "references/review-rules.md#rulings-and-fix-scope": unconditional,
      [`${TOOLKIT}#edit`]: conditional("plan and design fixes"),
      "references/review-coverage.md#failed-slot-coverage": conditional("slot"),
      "references/spec-stage.md": unconditional,
      "references/review-coverage.md#repository-changes-from-native-voices":
        conditional("repository change"),
    },
    calls: [call("review run", 2), record("ruling", 8), record("edit", 0)],
  },
  // Step reads make the Decision Frame unconditional, including escalation without risky approval.
  verify: {
    guide: "references/verbs/verify.md",
    links: {
      [`${TOOLKIT}#brief-verifier`]: unconditional,
      [`${TOOLKIT}#check-run`]: unconditional,
      "SKILL.md#routing": conditional("If `check run` fails"),
      "references/decision-frame.md": unconditional,
      "references/spec-stage.md": unconditional,
      [`${TOOLKIT}#ledger-append`]: unconditional,
    },
    calls: [
      call("brief verifier", 1),
      call("check run", 1),
      record("integrate", 1),
    ],
  },
  plan: {
    guide: "references/verbs/plan.md",
    links: {
      "references/spec-authoring.md#resolve-and-author":
        conditional("No current spec"),
      "references/grounding.md#scope-round": unconditional,
      "references/grounding.md#design-increments":
        conditional("increment plan"),
      [`${BAR}#shared`]: unconditional,
      [`${BAR}#spec`]: unconditional,
      [`${BAR}#plan`]: unconditional,
      [`${BAR}#testing`]: unconditional,
      "references/spec-stage.md#readers-and-document-layers": unconditional,
      "references/spec-stage.md#run-level": unconditional,
      "references/spec-stage.md#revision-protocol": unconditional,
      "references/templates/plan.md": unconditional,
      "references/templates/plan-field-notes.md": conditional(
        "lint reports a code"
      ),
      "references/grounding.md#check-and-recover": unconditional,
      [`${TOOLKIT}#lint-run`]: unconditional,
      [`${TOOLKIT}#bind`]: unconditional,
      [`${TOOLKIT}#edit`]: unconditional,
      "references/review-rules.md": unconditional,
      "references/decision-frame.md#review-escalation": conditional("recur"),
      "references/verbs/review.md": unconditional,
      "references/verbs/implement.md": conditional("Notify affected writers"),
    },
    calls: [
      call("doctor run", 1),
      call("brief explorer", 1),
      call("lint run", 3),
      call("review run", 2),
      call("brief fix-review-lite", 1),
      record("bind", 1),
      record("level", 1),
      record("approval", 1),
      record("ruling", 8),
      record("edit", 2),
    ],
  },
  implement: {
    guide: "references/verbs/implement.md",
    links: {
      "references/spec-stage.md": conditional("objective"),
      "references/spec-stage.md#readers-and-document-layers": unconditional,
      "references/verbs/plan.md": conditional("objective"),
      "references/verbs/design.md": conditional("authoring a design"),
      "references/verbs/design.md#implement-an-approved-design":
        conditional("supplied design"),
      [TOOLKIT]: owner,
      "references/grounding.md#scope-round": unconditional,
      "references/grounding.md#design-increments":
        conditional("design increment"),
      "references/spec-stage.md#run-level": conditional("authors the plan"),
      "references/review-coverage.md#failed-slot-coverage": conditional("slot"),
      "references/review-coverage.md#repository-changes-from-native-voices":
        conditional("repository change"),
      [`${TOOLKIT}#worktree-create`]: unconditional,
      [`${TOOLKIT}#brief-render`]: unconditional,
      [`${TOOLKIT}#worktree-submit`]: unconditional,
      [`${TOOLKIT}#worktree-integrate`]: unconditional,
      [`${TOOLKIT}#check-run`]: unconditional,
      [`${TOOLKIT}#brief-verifier`]: unconditional,
      "references/verbs/verify.md": unconditional,
      [`${BAR}#shared`]: unconditional,
      [`${BAR}#testing`]: unconditional,
      [`${BAR}#code`]: unconditional,
      [`${BAR}#spec`]: unconditional,
      "SKILL.md#routing": unconditional,
      "references/templates/test-cleanup-brief.md": unconditional,
      [`${TOOLKIT}#brief-test-cleanup`]: unconditional,
      [`${TOOLKIT}#worktree-commit`]: unconditional,
      "references/review-rules.md#review-provenance-and-applicability":
        unconditional,
      "references/review-rules.md#rulings-and-fix-scope": unconditional,
      "references/review-fixes.md": conditional("accepted fixes run"),
      "references/decision-frame.md#review-escalation":
        conditional("coverage-decision"),
      [`${TOOLKIT}#edit`]: conditional("accepted SHOULD"),
      [`${TOOLKIT}#manual-complete`]: unconditional,
      [`${TOOLKIT}#report-complete`]: unconditional,
      "references/worktree-cleanup.md": unconditional,
      [`${TOOLKIT}#worktree-deliver`]: unconditional,
      "references/spec-stage.md#revision-protocol": unconditional,
      "references/decision-frame.md#user-gate-boundaries":
        conditional("Discarding work"),
      [`${TOOLKIT}#worktree-continue`]: conditional("conflicts"),
      [`${TOOLKIT}#worktree-abort`]: conditional("conflicts"),
      [`${TOOLKIT}#worktree-abandon`]: conditional("stopped writer"),
      [`${TOOLKIT}#worktree-close`]: conditional("retained integration"),
      "references/templates/writer-brief.md": unconditional,
    },
    calls: [
      call("doctor run", 1),
      call("lint run", 1),
      call("check run", 4),
      call("worktree create", 2),
      call("brief render", 2),
      call("worktree submit", 2),
      call("worktree integrate", 2),
      call("brief verifier", 1),
      call("brief test-cleanup", 1),
      call("worktree commit", 2),
      call("review run", 2),
      call("worktree deliver", 1),
      call("report complete", 1),
      call("worktree cleanup", 1),
      call("worktree continue", 0),
      call("worktree abort", 0),
      call("worktree abandon", 0),
      call("worktree close", 0),
      record("bind", 1),
      record("approval", 1),
      record("ruling", 8),
      record("focus", 1),
      record("manual-complete", 1),
      record("integrate", 1),
      record("edit", 0),
    ],
  },
};

/** Every relative link in SKILL.md; true marks a read that the path makes on every normal run. */
export const SKILL_LINKS = {
  "references/decision-frame.md": {
    ask: false,
    design: true,
    plan: true,
    implement: false,
    review: false,
    verify: false,
  },
  "references/decision-frame.md#user-gate-boundaries": {
    ask: false,
    design: false,
    plan: false,
    implement: true,
    review: false,
    verify: false,
  },
  "references/providers.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/providers.md#child-orchestrators": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/providers.md#native-slots": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/review-rules.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/review-rules.md#review-provenance-and-applicability": {
    ask: false,
    design: false,
    plan: false,
    implement: true,
    review: false,
    verify: false,
  },
  "references/self-build.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/spec-stage.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/spec-stage.md#approval": {
    ask: false,
    design: true,
    plan: true,
    implement: true,
    review: false,
    verify: false,
  },
  "references/spec-stage.md#run-level": {
    ask: true,
    design: true,
    plan: true,
    implement: true,
    review: true,
    verify: true,
  },
  "references/templates/quality-bar.md#shared": {
    ask: false,
    design: false,
    plan: false,
    implement: true,
    review: false,
    verify: false,
  },
  [TOOLKIT]: {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  [`${TOOLKIT}#doctor-run`]: {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  [`${TOOLKIT}#native-slot-replies`]: {
    ask: true,
    design: true,
    plan: true,
    implement: true,
    review: true,
    verify: true,
  },
  [`${TOOLKIT}#session-commands`]: {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  [`${TOOLKIT}#status-show`]: {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/verbs/ask.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/verbs/design.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/verbs/implement.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/verbs/plan.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/verbs/review.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/verbs/verify.md": {
    ask: false,
    design: false,
    plan: false,
    implement: false,
    review: false,
    verify: false,
  },
  "references/worktree-cleanup.md": {
    ask: false,
    design: false,
    plan: false,
    implement: true,
    review: false,
    verify: false,
  },
} satisfies Record<string, Record<PathName, boolean>>;

/** Figures at BASELINE_COMMIT; reproduce with --check-baseline. */
export const BASELINE_COMMIT = "88685174";

export const BASELINE: Record<PathName, Figures> = {
  ask: {
    distinct: 30_354,
    workload: 30_354,
    editableDistinct: 29_591,
    editableWorkload: 29_591,
  },
  design: {
    distinct: 89_006,
    workload: 89_006,
    editableDistinct: 76_238,
    editableWorkload: 76_238,
  },
  review: {
    distinct: 59_293,
    workload: 59_293,
    editableDistinct: 41_415,
    editableWorkload: 41_415,
  },
  verify: {
    distinct: 33_124,
    workload: 33_124,
    editableDistinct: 29_556,
    editableWorkload: 29_556,
  },
  plan: {
    distinct: 85_118,
    workload: 85_118,
    editableDistinct: 68_781,
    editableWorkload: 68_781,
  },
  implement: {
    distinct: 100_102,
    workload: 100_102,
    editableDistinct: 85_248,
    editableWorkload: 85_248,
  },
};

// SECTION: Sections and bytes

export const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

/** The heading line through the line before the next heading of the same or a higher level; null when absent. */
export const sectionOf = (
  text: string,
  anchor: string,
  headingLevel?: number
) => {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let fence = false;
  let start = -1;
  let level = 0;

  for (const [index, line] of lines.entries()) {
    if (/^ {0,3}(?<fence>```|~~~)/u.test(line)) {
      fence = !fence;
      continue;
    }

    if (fence) {
      continue;
    }

    const [, hashes, heading] =
      /^(?<hashes>#{1,6})\s+(?<heading>.*?)\s*$/u.exec(line) ?? [];

    if (hashes === undefined || heading === undefined) {
      continue;
    }

    if (start < 0) {
      if (
        slug(heading) === anchor &&
        (headingLevel === undefined || hashes.length === headingLevel)
      ) {
        start = index;
        level = hashes.length;
      }
    } else if (hashes.length <= level) {
      return lines.slice(start, index).join("\n").trimEnd();
    }
  }

  return start < 0 ? null : lines.slice(start).join("\n").trimEnd();
};

/** Resolves a Markdown destination in the skill root, retaining its authored fragment. */
export const normalizeSkillLink = (source: string, target: string) => {
  const clean =
    target.startsWith("<") && target.endsWith(">")
      ? target.slice(1, -1)
      : target;

  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(clean)) {
    return null;
  }

  const fragment = clean.indexOf("#");
  const file = fragment === -1 ? clean : clean.slice(0, fragment);

  const resolved =
    file && !path.posix.isAbsolute(file)
      ? path.posix.join(path.posix.dirname(source), file)
      : file || source;

  return resolved + (fragment === -1 ? "" : clean.slice(fragment));
};

/** Compares authored relative destinations with the editorial declarations and verifies their targets. */
export const validatePathLinks = (read: Read) => {
  const errors: string[] = [];
  const contents = new Map<string, string | null>();

  const readOnce = (file: string) => {
    if (!contents.has(file)) {
      try {
        contents.set(file, read(file));
      } catch (error) {
        const code =
          error !== null &&
          error !== undefined &&
          typeof error === "object" &&
          "code" in error
            ? error.code
            : undefined;

        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") {
          throw error;
        }

        contents.set(file, null);
      }
    }

    return contents.get(file) ?? null;
  };

  const sources: [string, string[]][] = [
    ...Object.values(MANIFEST).map(
      ({ guide, links }) =>
        [guide, Object.keys(links)] satisfies [string, string[]]
    ),
    ["SKILL.md", Object.keys(SKILL_LINKS)],
  ];

  for (const [source, declarations] of sources) {
    const text = readOnce(source);

    if (text === null) {
      errors.push(`${source}: missing link source`);
      continue;
    }

    const declared = new Set(declarations);
    const found = new Set<string>();

    for (const [, target] of text.matchAll(
      /\]\([ \t]*(?<target><[^>\r\n]+>|[^)\s]+)(?:[ \t]+[^)\r\n]*)?\)/gu
    )) {
      const normalized =
        target === undefined ? null : normalizeSkillLink(source, target);

      if (normalized !== null) {
        found.add(normalized);
      }
    }

    for (const target of found) {
      if (!declared.has(target)) {
        errors.push(`${source}: undeclared link ${target}`);
      }
    }

    for (const target of declared) {
      if (!found.has(target)) {
        errors.push(`${source}: stale declaration ${target}`);
      }
    }

    for (const target of new Set([...found, ...declared])) {
      const [file = "", anchor] = target.split(/#(?<anchor>.*)/su);

      if (
        file === ".." ||
        file.startsWith("../") ||
        file.includes("\\") ||
        path.posix.isAbsolute(file)
      ) {
        errors.push(`${source}: link outside the skill ${target}`);
        continue;
      }

      const body = readOnce(file);

      if (body === null) {
        errors.push(`${source}: missing link file ${target}`);
      } else if (anchor !== undefined && sectionOf(body, anchor) === null) {
        errors.push(`${source}: invalid link anchor ${target}`);
      }
    }
  }

  return errors;
};

// NOTE: CRLF is normalized so Windows checkouts and Git blobs give the same figures.
const bytes = (text: string) =>
  Buffer.byteLength(text.replaceAll("\r\n", "\n"), "utf-8");

const isFrozen = (file: string) =>
  /(?<root>^|\/)(?<doc>quality-bar|spec-stage)\.md$/u.test(file);

interface ReadItem {
  file: string;
  anchor?: string;
}

const isPathName = (name: string): name is PathName =>
  Object.hasOwn(MANIFEST, name);

const pathReads = (spec: PathManifest, name: string) => {
  const items: ReadItem[] = [{ file: "SKILL.md" }, { file: spec.guide }];

  for (const [target, entry] of Object.entries(spec.links)) {
    if (entry.class !== "unconditional") {
      continue;
    }

    const [file = "", anchor] = target.split("#");

    // A toolkit anchor reaches the orchestrator through the call sequence, never as a separate read.
    if (file !== TOOLKIT) {
      items.push(anchor === undefined ? { file } : { file, anchor });
    }
  }

  // A section that SKILL.md mandates has no call heading, so it is a direct read even in toolkit.md.
  for (const [target, paths] of Object.entries(SKILL_LINKS)) {
    if (!isPathName(name) || !paths[name]) {
      continue;
    }

    const [file = "", anchor] = target.split("#");
    items.push(anchor === undefined ? { file } : { file, anchor });
  }

  const whole = new Set(
    items.flatMap(({ file, anchor }) => (anchor === undefined ? [file] : []))
  );

  const seen = new Set<string>();

  return items.filter((item) => {
    const key = `${item.file}#${item.anchor ?? ""}`;

    if (seen.has(key) || (item.anchor !== undefined && whole.has(item.file))) {
      return false;
    }

    seen.add(key);

    return true;
  });
};

// SECTION: Measure

export function measure(read: Read, model: Model): Record<PathName, Figures>;
export function measure<K extends string>(
  read: Read,
  model: Model,
  manifest: Record<K, PathManifest>,
  archive?: boolean
): Record<K, Figures>;
export function measure(
  read: Read,
  model: Model,
  manifest: Record<string, PathManifest> = MANIFEST,
  archive = false
) {
  const toolkit = read(TOOLKIT);
  const help = stripGeneratedMarkers(toolkit);

  const section = (heading: string) => {
    let text = sectionOf(help, slug(heading));

    if (text === null && archive && heading === "brief fix-review-lite") {
      // The pinned baseline predates the rename.
      const candidates: string[] = [];
      let fence = false;

      for (const line of help.split(/\r?\n/u)) {
        if (/^ {0,3}(?<fence>```|~~~)/u.test(line)) {
          fence = !fence;
          continue;
        }

        if (fence) {
          continue;
        }

        const headingText = /^###\s+(?<heading>.*?)\s*$/u.exec(line)?.[1];

        if (headingText === undefined) {
          continue;
        }

        const anchor = slug(headingText);

        if (anchor.startsWith("brief-fix-")) {
          candidates.push(anchor);
        }
      }

      const [candidate] = candidates;

      if (candidates.length !== 1 || candidate === undefined) {
        throw new Error(
          `toolkit.md has ${candidates.length} archived repair brief sections; expected one`
        );
      }

      text = sectionOf(help, candidate, 3);
    }

    if (text === null) {
      throw new Error(`toolkit.md has no section "${heading}"`);
    }

    return bytes(text);
  };

  const result: Record<string, Figures> = {};

  for (const [name, spec] of Object.entries(manifest)) {
    const figures: Figures = {
      distinct: 0,
      workload: 0,
      editableDistinct: 0,
      editableWorkload: 0,
    };

    const add = (size: number, count: number, frozen: boolean) => {
      figures.workload += size * count;

      if (!frozen) {
        figures.editableWorkload += size * count;
      }
    };

    const addDistinct = (size: number, frozen: boolean) => {
      figures.distinct += size;

      if (!frozen) {
        figures.editableDistinct += size;
      }
    };

    for (const item of pathReads(spec, name)) {
      const text = read(item.file);

      const body =
        item.anchor === undefined ? text : sectionOf(text, item.anchor);

      if (body === null) {
        throw new Error(`${item.file} has no section "${item.anchor}"`);
      }

      add(bytes(body), 1, isFrozen(item.file));
      addDistinct(bytes(body), isFrozen(item.file));
    }

    const headings = new Set<string>();

    for (const entry of spec.calls) {
      if (entry.count <= 0) {
        continue;
      }

      headings.add(entry.action);

      if (entry.kind !== undefined) {
        headings.add(entry.kind);
      }

      if (model === "before") {
        add(section(entry.action), entry.count, false);

        if (entry.kind !== undefined) {
          add(section(entry.kind), entry.count, false);
        }
      }
    }

    const preload = model === "preload";
    const after = model === "after";
    const callTable = ["call table"];

    let sections: Iterable<string>;

    if (preload) {
      sections = [...callTable, ...headings];
    } else if (after) {
      sections = callTable;
    } else {
      sections = headings;
    }

    for (const heading of sections) {
      addDistinct(section(heading), false);

      if (model !== "before") {
        add(section(heading), 1, false);
      }
    }

    result[name] = figures;
  }

  return result;
}

// SECTION: Comparison and report

const LABELS: [keyof Figures, string][] = [
  ["distinct", "distinct"],
  ["workload", "workload"],
  ["editableDistinct", "editable distinct"],
  ["editableWorkload", "editable workload"],
];

// NOTE: only workload figures gate growth; distinct bytes rise by the call table, which replaces repeated reads, so they are reported only.
const GATED = new Set<keyof Figures>(["workload", "editableWorkload"]);

export const checkGrowth = (
  result: Partial<Record<PathName, Figures>>,
  baseline: Record<PathName, Figures> = BASELINE
) => {
  const errors: string[] = [];

  for (const [name, figures] of Object.entries(result)) {
    if (!isPathName(name)) {
      continue;
    }

    for (const [key, label] of LABELS) {
      if (GATED.has(key) && figures[key] > baseline[name][key]) {
        errors.push(
          `${name} ${label} grew to ${figures[key]} bytes above baseline ${baseline[name][key]}`
        );
      }
    }
  }

  return errors;
};

export const formatReport = (
  result: Partial<Record<PathName, Figures>>,
  baseline: Record<PathName, Figures> = BASELINE
) => {
  const lines: string[] = [];

  for (const [name, figures] of Object.entries(result)) {
    if (!isPathName(name)) {
      continue;
    }

    for (const [key, label] of LABELS) {
      const base = baseline[name][key];
      const reduction = base ? ((base - figures[key]) / base) * 100 : 0;
      lines.push(
        `${name} ${label}: ${figures[key]} bytes (baseline ${base}, ${reduction.toFixed(1)}%)`
      );
    }

    const base = baseline[name].workload;
    const met = base > 0 && (base - figures.workload) / base >= 0.25;
    lines.push(
      `${name} workload 25% target: ${met ? "met" : "not met"} (reported only)`
    );
  }

  return `${lines.join("\n")}\n`;
};

/** Measures the checkout or a Git revision and checks the selected baseline. */
export const main = (
  args: string[] = process.argv.slice(2),
  git: (command: string[]) => string = (command) =>
    execFileSync("git", command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  baseline: Record<PathName, Figures> = BASELINE,
  output?: { stdout: (text: string) => void; stderr: (text: string) => void }
) => {
  const io = output ?? {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };

  if (!isValidMainArgs(args)) {
    io.stderr("Usage: path-bytes [--at <commit> | --check-baseline]\n");

    return 2;
  }

  const archive = args[0] === "--check-baseline";
  const commit = archive ? BASELINE_COMMIT : args[1];
  const skillDir = path.join(import.meta.dirname, "../skills/dispatch");
  let objectId = "";

  if (commit !== undefined) {
    try {
      objectId = git(["rev-parse", "--verify", `${commit}^{commit}`]).trim();
    } catch (error) {
      io.stderr(`${formatGitError(error)}\n`);

      return 2;
    }
  }

  const read: Read =
    commit === undefined
      ? (rel) => fs.readFileSync(path.join(skillDir, rel), "utf-8")
      : (rel) => git(["show", `${objectId}:skills/dispatch/${rel}`]);

  const result: Partial<Record<PathName, Figures>> = {};
  const missing = measureManifest(read, archive, commit, io, result);

  io.stdout(formatReport(result, baseline));

  if (archive) {
    return checkArchiveBaseline(result, baseline, missing, io);
  }

  if (commit !== undefined) {
    return 0;
  }

  const errors = checkGrowth(result, baseline);

  for (const error of errors) {
    io.stderr(`${error}\n`);
  }

  return errors.length ? 1 : 0;
};

const isStringValue = (value: unknown): value is string =>
  typeof value === "string";

const formatGitError = (error: unknown) => {
  const raw =
    error !== null &&
    error !== undefined &&
    typeof error === "object" &&
    "stderr" in error
      ? error.stderr
      : undefined;

  const message = error instanceof Error ? error.message : String(error);
  const stderrText = isStringValue(raw) ? raw : undefined;

  return stderrText === undefined || stderrText === "" ? message : stderrText;
};

const isValidMainArgs = (args: string[]) =>
  args.length === 0 ||
  (args.length === 1 && args[0] === "--check-baseline") ||
  (args.length === 2 && args[0] === "--at" && args[1] !== undefined);

const measureManifest = (
  read: Read,
  archive: boolean,
  commit: string | undefined,
  output: { stdout: (text: string) => void; stderr: (text: string) => void },
  result: Partial<Record<PathName, Figures>>
) => {
  let missing = false;

  for (const name of Object.keys(MANIFEST).filter(isPathName)) {
    try {
      const figures = measure(
        read,
        archive ? "preload" : "after",
        { [name]: MANIFEST[name] },
        archive
      )[name];

      if (figures === undefined) {
        throw new Error(`No figures recorded for ${name}`);
      }

      result[name] = figures;
    } catch (error) {
      if (commit === undefined) {
        throw error;
      }

      missing = true;
      output.stdout(
        `${name}: missing ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  return missing;
};

const checkArchiveBaseline = (
  result: Partial<Record<PathName, Figures>>,
  baseline: Record<PathName, Figures>,
  missing: boolean,
  output: { stdout: (text: string) => void; stderr: (text: string) => void }
) => {
  const unequal =
    missing ||
    Object.entries(result).some(
      ([name, figures]) =>
        isPathName(name) &&
        LABELS.some(([key]) => figures[key] !== baseline[name][key])
    );

  if (unequal) {
    output.stderr("Baseline differs from commit measure\n");
  }

  return unequal ? 1 : 0;
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main();
}
