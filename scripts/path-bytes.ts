import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONFIG_CANDIDATES,
  isRecord,
} from "../skills/dispatch/scripts/lib/config.ts";
import { nodeErrorCode } from "../skills/dispatch/scripts/lib/fs-ext.ts";
import type { Manifest } from "../skills/dispatch/scripts/lib/session.ts";
import type {
  CliDeps,
  HandlerContext,
} from "../skills/dispatch/scripts/toolkit/cli.ts";
import { stripGeneratedMarkers } from "../skills/dispatch/scripts/toolkit/contracts.ts";
import type { GitDeps } from "../skills/dispatch/scripts/toolkit/git.ts";

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
      "references/templates/verifier-brief.md#proof-standards":
        conditional("approval"),
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
      "SKILL.md#launch-and-continue": conditional("relaunch"),
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
  "references/verbs/implement.md#procedure": {
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

const SKILL_ROOT = path.join(import.meta.dirname, "../skills/dispatch");
const REPO_ROOT = path.join(import.meta.dirname, "..");

const readSkillFile: Read = (rel) =>
  fs.readFileSync(path.join(SKILL_ROOT, rel), "utf-8");

interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const PROCESS_OUTPUT: Output = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export const USAGE =
  "Usage: path-bytes [--at <commit> | --check-baseline | --report]\n";

/** Measures the checkout or a Git revision and checks the selected baseline. */
export const main = (
  args: string[] = process.argv.slice(2),
  git: (command: string[]) => string = (command) =>
    execFileSync("git", command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  baseline: Record<PathName, Figures> = BASELINE,
  output?: Output
) => {
  const io = output ?? PROCESS_OUTPUT;

  if (!isValidMainArgs(args)) {
    io.stderr(USAGE);

    return 2;
  }

  const archive = args[0] === "--check-baseline";
  const commit = archive ? BASELINE_COMMIT : args[1];
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
      ? readSkillFile
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

// SECTION: Actor-pack report

export interface PackRow {
  label: string;
  text: string;
  rendered: number;
  portable: number;
}

export interface ReportOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Directory that holds the throwaway fixture session; defaults to the OS temp directory. */
  fixtureParent?: string;
  /** Git port for the renderers; defaults to the fixed answers of PACK_FIXTURE, so rendering spawns nothing. */
  run?: GitDeps["run"];
}

export interface SequenceCall {
  action: string;
  flag?: string;
  kind?: string;
}

export interface CallSequence {
  family: "task path" | "review round";
  path: string;
  calls: SequenceCall[];
  sources: string[];
}

/** Fixed inputs of every pack row; a change here moves the baseline, so rerun the report before and after. */
export const PACK_FIXTURE = {
  host: "claude",
  level: "medium",
  task: "T1",
  at: "2026-01-01T00:00:00.000Z",
  specFile: "fixture.spec.md",
  planFile: "fixture.plan.md",
  designFile: "fixture.design.md",
  spec: [
    "# Fixture mission",
    "",
    "## Requirements",
    "",
    "### REQ-1 — Fixture behaviour",
    "",
    "The fixture works.",
    "",
  ].join("\n"),
  // NOTE: the RED exception keeps the writer brief free of the RED-capture block, which encodes absolute paths that normalization cannot reach.
  plan: [
    "# Fixture work",
    "",
    "Shared fixture context.",
    "",
    "## Task Map",
    "",
    "| ID | Title | Outcome | Prerequisites | Criteria |",
    "| --- | --- | --- | --- | --- |",
    "| T1 | First | First works | none | SC1 |",
    "",
    "## Proposed Changes",
    "",
    "### T1 — First",
    "",
    "- Constraints: Preserve the first invariant.",
    "",
    "#### [NEW] src/first.ts",
    "",
    "- Purpose: First implementation detail.",
    "",
    "## Success Criteria",
    "",
    "- [SC1] First works",
    "  - Changes: src/first.ts",
    "  - Check: `node first-check`",
    "  - Evidence: red",
    "  - RED exception: behavior-preserving",
    "",
    "## Verification Plan",
    "",
    "### Automated Tests",
    "",
    "- `node first-check`",
    "- `node contract-check`",
    "",
  ].join("\n"),
  round: {
    findingId: "R1-F001",
    severity: "SHOULD",
    locus: "§ Plan: Proposed Changes",
    defect: "The first change names no owner for the shared state.",
    requiredChange: "Name the single owner of the shared state.",
    rationale: "The owner closes the gap.",
    input: "# Fixture work\n",
  },
  diff: [
    "--- a/fixture.plan.md",
    "+++ b/fixture.plan.md",
    "@@ -1 +1,2 @@",
    " # Fixture work",
    "+The first module owns the shared state.",
    "",
  ].join("\n"),
  explorer: {
    objective: "Map the fixture area before planning.",
    questions: ["Which module owns the fixture state?", "Who consumes it?"],
    mapFile: "explorer-map.md",
  },
  commit: "a".repeat(40),
  verifier: { focus: "The first module serves the fixture state." },
  review: {
    scope: "Full review",
    turnTarget: 40,
    taskSummary: "Review the fixture change.",
  },
  ask: {
    question: "Which module owns the fixture state?",
    context: "The fixture has one module.",
  },
} as const;

// SECTION: Static call sequences (source: the verb guides and review rules cited per entry)

const step = (action: string, flag?: string): SequenceCall =>
  flag === undefined ? { action } : { action, flag };

const append = (kind: string): SequenceCall => ({
  action: "ledger append",
  kind,
});

const TASK_HEAD = [
  step("worktree create"),
  step("brief render"),
  step("worktree submit"),
  step("worktree integrate"),
];

const TASK_CHECK = step("check run", "--task");

export const CALL_SEQUENCES: readonly CallSequence[] = [
  {
    family: "task path",
    path: "normal",
    calls: [...TASK_HEAD, TASK_CHECK],
    sources: ["skills/dispatch/references/verbs/implement.md:17-19"],
  },
  {
    family: "task path",
    path: "integrate conflict",
    calls: [...TASK_HEAD, step("worktree continue"), TASK_CHECK],
    sources: ["skills/dispatch/references/verbs/implement.md:50"],
  },
  {
    // The repair itself is writer or orchestrator work, so only the check rerun adds a toolkit call.
    family: "task path",
    path: "check failure",
    calls: [...TASK_HEAD, TASK_CHECK, TASK_CHECK],
    sources: ["skills/dispatch/references/verbs/implement.md:19"],
  },
  {
    family: "review round",
    path: "no fixes",
    calls: [step("review run"), append("ruling")],
    sources: [
      "skills/dispatch/references/verbs/review.md:3",
      "skills/dispatch/references/review-rules.md:29",
    ],
  },
  {
    family: "review round",
    path: "plan/design fix batch",
    calls: [
      step("review run"),
      append("ruling"),
      step("brief fix-review-lite"),
      append("note"),
      step("lint run", "--edit"),
    ],
    sources: ["skills/dispatch/references/review-rules.md:52-55"],
  },
  {
    family: "review round",
    path: "code fix batch",
    calls: [
      step("review run"),
      append("ruling"),
      step("worktree commit", "--review-fix"),
      step("check run"),
    ],
    sources: ["skills/dispatch/references/review-fixes.md:23"],
  },
];

const callLabel = ({ action, flag, kind }: SequenceCall) => {
  if (kind !== undefined) {
    return `${action} (${kind})`;
  }

  return flag === undefined ? action : `${action} ${flag}`;
};

const sequenceLines = () =>
  CALL_SEQUENCES.map(
    ({ family, path: variant, calls }) =>
      `${family}, ${variant}: ${calls.length} calls — ${calls.map(callLabel).join(", ")}`
  );

// SECTION: Fixture identity and portable bytes

/** Names the config file that the renderers read, with the first 12 hex digits of the SHA-256 of its raw bytes. */
export const fixtureIdentity = (skillRoot: string) => {
  let config = "config none";

  for (const name of CONFIG_CANDIDATES) {
    try {
      const digest = crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(skillRoot, name)))
        .digest("hex")
        .slice(0, 12);

      config = `config ${name} sha256:${digest}`;
      break;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  return `Fixture: host ${PACK_FIXTURE.host} · level ${PACK_FIXTURE.level} · ${config} · platform ${process.platform}`;
};

interface PathRoot {
  root: string;
  placeholder: string;
}

// Ends a path run inside prose: whitespace, quotes, the backtick and list punctuation.
const PATH_END = String.raw`\s"'<>|*?()\[\]{},;` + String.fromCodePoint(96);

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** CRLF becomes LF; each root becomes its placeholder and the separators of the path run after it become `/`. Other backslashes stay. */
export const portableText = (text: string, roots: readonly PathRoot[]) => {
  let normalized = text.replaceAll("\r\n", "\n");

  // Longest roots first: the skill root sits inside the repository root.
  for (const { root, placeholder } of roots.toSorted(
    (a, b) => b.root.length - a.root.length
  )) {
    const prefix = root
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]+/u)
      .map(escapeRegExp)
      .join(String.raw`[\\/]+`);

    // A prefix must end at a path boundary, so a sibling such as `<root>-other` stays.
    const pattern = new RegExp(
      String.raw`${prefix}(?:(?<rest>[\\/][^${PATH_END}]*)|(?![\w.-]))`,
      process.platform === "win32" ? "giu" : "gu"
    );

    normalized = normalized.replaceAll(
      pattern,
      (_match: string, rest: string | undefined) =>
        placeholder + (rest ?? "").replaceAll("\\", "/")
    );
  }

  return normalized;
};

// SECTION: Fixture session and renderers

const unusedRuntime = (): never => {
  throw new Error("path-bytes report has no CLI runtime");
};

const fixtureGit: GitDeps["run"] = async (argv) => {
  await Promise.resolve();

  if (argv[1] === "ls-files") {
    return { exit: 0, stdout: "", stderr: "" };
  }

  if (argv[1] === "diff") {
    return { exit: 1, stdout: PACK_FIXTURE.diff, stderr: "" };
  }

  throw new Error(`Unexpected Git call: ${argv.join(" ")}`);
};

// NOTE: the toolkit loads on demand, so the no-argument workload gate keeps its startup cost.
const loadToolkit = async () => {
  const [brief, lite, prompts, domainPrompt, artifacts, confirmations, state] =
    await Promise.all([
      import("../skills/dispatch/scripts/toolkit/brief.ts"),
      import("../skills/dispatch/scripts/toolkit/fix-review-lite.ts"),
      import("../skills/dispatch/scripts/toolkit/prompts.ts"),
      import("../skills/dispatch/scripts/toolkit/domain/prompt.ts"),
      import("../skills/dispatch/scripts/toolkit/artifacts.ts"),
      import("../skills/dispatch/scripts/toolkit/confirmations.ts"),
      import("../skills/dispatch/scripts/toolkit/review-state.ts"),
    ]);

  return {
    brief,
    lite,
    prompts,
    domainPrompt,
    artifacts,
    confirmations,
    state,
  };
};

type Toolkit = Awaited<ReturnType<typeof loadToolkit>>;

interface Pack {
  label: string;
  render: () => Promise<string> | string;
}

const writeJson = (file: string, value: unknown) => {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

const json = (value: unknown) => ({ json: JSON.stringify(value) });

// Each brief renderer writes its file under the session; the pack is that file as the actor reads it.
const briefFile = async (
  result: Promise<{ value: unknown }>,
  key: "path" | "briefPath"
) => {
  const { value } = await result;
  const file = isRecord(value) ? value[key] : undefined;

  if (typeof file !== "string") {
    throw new TypeError(`The renderer returned no ${key}`);
  }

  return fs.readFileSync(file, "utf-8");
};

/** Seeds the fixture session and repository, then lists each pack with the production renderer that builds it. */
const seedPacks = (
  fixtureRoot: string,
  kit: Toolkit,
  run: GitDeps["run"]
): Pack[] => {
  const fixture = PACK_FIXTURE;
  const repo = path.join(fixtureRoot, "repo");
  const session = path.join(fixtureRoot, "session");
  const integration = path.join(fixtureRoot, "integration");
  const specPath = path.join(repo, fixture.specFile);
  const planPath = path.join(repo, fixture.planFile);
  const designPath = path.join(repo, fixture.designFile);
  const specHash = kit.artifacts.artifactHash("spec", fixture.spec);

  fs.mkdirSync(repo);
  fs.mkdirSync(session);
  fs.writeFileSync(specPath, fixture.spec);
  fs.writeFileSync(planPath, fixture.plan);

  // The fix-review-lite pack needs one completed plan round whose only finding is accepted.
  const review = kit.confirmations.reviewId("plan", planPath);
  const reviewDir = kit.state.reviewDirectory(session, review);
  const roundDir = kit.state.reviewRoundDirectory(reviewDir, 1);
  fs.mkdirSync(roundDir, { recursive: true });

  writeJson(kit.state.reviewRoundFile(roundDir), {
    artifactPath: planPath,
    spec: { path: specPath, hash: specHash },
  });

  writeJson(kit.state.reviewFindingsFile(roundDir), {
    findings: [
      {
        id: fixture.round.findingId,
        severity: fixture.round.severity,
        locus: fixture.round.locus,
        defect: fixture.round.defect,
        requiredChange: fixture.round.requiredChange,
      },
    ],
  });

  fs.writeFileSync(
    path.join(reviewDir, "round-1.input.md"),
    fixture.round.input
  );

  // The writer gate needs a confirmed spec, an approved plan, a level and an open launch.
  const planHash = kit.artifacts.artifactHash("plan", fixture.plan);

  const records = [
    { kind: "bind", data: { spec: fixture.specFile, plan: fixture.planFile } },
    {
      kind: "confirm",
      by: "user",
      quote: "Approved",
      data: { spec: specHash },
    },
    { kind: "level", data: { level: fixture.level } },
    {
      kind: "approval",
      by: "user",
      quote: "Approved",
      data: { spec: specHash, plan: planHash },
    },
    {
      kind: "writer",
      data: {
        phase: "launched",
        task: fixture.task,
        path: `.state/worktrees/${fixture.task}-1`,
        base: {
          commit: fixture.commit,
          taskSection: `sha256:${"b".repeat(64)}`,
          seq: 1,
        },
      },
    },
    {
      kind: "ruling",
      data: {
        subject: `review:${review}:${fixture.round.findingId}`,
        ruling: "accepted",
        rationale: fixture.round.rationale,
      },
    },
  ];

  fs.writeFileSync(
    path.join(session, "ledger.jsonl"),
    `${records
      .map((entry, index) =>
        JSON.stringify({
          seq: index + 1,
          at: fixture.at,
          key: `record-${index + 1}`,
          by: "orchestrator",
          ...entry,
        })
      )
      .join("\n")}\n`
  );

  const manifest: Manifest = {
    schemaVersion: 1,
    folderName: "20260101T0000Z-path-bytes",
    sessionId: "path-bytes",
    safeSessionId: "path-bytes",
    repositoryRoot: repo,
    sessionTitle: "path-bytes fixture",
    createdAt: fixture.at,
    lastUsedAt: fixture.at,
    location: "workspace",
  };

  const deps: CliDeps = {
    delegate: unusedRuntime,
    modes: unusedRuntime,
    orchestrator: { platform: fixture.host, model: null },
    liveness: {},
    run,
    stdout: unusedRuntime,
    env: {},
    clock: () => Date.now(),
    sleep: unusedRuntime,
    pid: process.pid,
    host: "path-bytes",
    isAlive: () => true,
    skillRoot: SKILL_ROOT,
  };

  const context = (
    args: string[],
    values: HandlerContext["values"] = {}
  ): HandlerContext => ({ session, manifest, args, values, deps });

  const reviewContext = {
    skillRoot: SKILL_ROOT,
    spec: { path: specPath, hash: specHash },
    scope: fixture.review.scope,
    turnTarget: fixture.review.turnTarget,
    round: 1,
  };

  const { questions, objective } = fixture.explorer;

  return [
    {
      label: "writer brief (no RED capture)",
      render: async () =>
        await briefFile(kit.brief.renderBrief(context([fixture.task])), "path"),
    },
    {
      label: "explorer brief (map)",
      render: async () =>
        await briefFile(
          kit.brief.renderExplorerBrief(
            context(
              [],
              json({
                objective,
                questions,
                outputPath: path.join(fixtureRoot, fixture.explorer.mapFile),
              })
            )
          ),
          "briefPath"
        ),
    },
    {
      label: "explorer brief (research)",
      render: async () =>
        await briefFile(
          kit.brief.renderExplorerBrief(
            context([], json({ objective, questions }))
          ),
          "briefPath"
        ),
    },
    {
      label: "test-cleanup brief",
      render: async () =>
        await briefFile(
          kit.brief.renderTestCleanupBrief(
            context(
              [],
              json({ base: fixture.commit, integrationPath: integration })
            )
          ),
          "briefPath"
        ),
    },
    {
      label: "verifier brief",
      render: async () =>
        await briefFile(
          kit.brief.renderVerifierBrief(
            context(
              [],
              json({
                checkoutPath: integration,
                base: fixture.commit,
                specPath,
                focus: fixture.verifier.focus,
              })
            )
          ),
          "briefPath"
        ),
    },
    {
      label: "fix-review-lite brief",
      render: async () =>
        await briefFile(
          kit.lite.renderFixReviewLiteBrief(context([planPath])),
          "briefPath"
        ),
    },
    {
      label: "review prompt (code)",
      render: () =>
        kit.prompts.reviewPrompt("code", {
          ...reviewContext,
          artifact: "integration",
          planPath,
          taskSummary: fixture.review.taskSummary,
        }),
    },
    {
      label: "review prompt (plan)",
      render: () =>
        kit.prompts.reviewPrompt("plan", {
          ...reviewContext,
          artifact: planPath,
        }),
    },
    {
      label: "review prompt (design)",
      render: () =>
        kit.prompts.reviewPrompt("design", {
          ...reviewContext,
          artifact: designPath,
        }),
    },
    {
      label: "ask prompt",
      render: () =>
        kit.domainPrompt.askPrompt(fixture.ask.question, fixture.ask.context),
    },
  ];
};

const failureReason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Renders every actor pack in a throwaway fixture session and removes it, even when a render fails. */
export const renderPackRows = async (options: ReportOptions = {}) => {
  const created = fs.mkdtempSync(
    path.join(options.fixtureParent ?? os.tmpdir(), "path-bytes-fixture-")
  );

  try {
    // NOTE: the real path matches the paths the renderers resolve (Windows short names, macOS /var).
    const fixtureRoot = fs.realpathSync.native(created);
    const kit = await loadToolkit();
    const packs = seedPacks(fixtureRoot, kit, options.run ?? fixtureGit);

    const roots = [...new Set([fixtureRoot, created])].map((root) => ({
      root,
      placeholder: "<fixture>",
    }));

    for (const [dir, placeholder] of [
      [SKILL_ROOT, "<skill-root>"],
      [REPO_ROOT, "<repo-root>"],
    ] as const) {
      for (const root of new Set([dir, fs.realpathSync.native(dir)])) {
        roots.push({ root, placeholder });
      }
    }

    const rows: PackRow[] = [];

    for (const { label, render } of packs) {
      let text: string;

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- packs render in order: they share one session ledger and briefs folder.
        text = await render();
      } catch (error) {
        throw new Error(`${label}: ${failureReason(error)}`, { cause: error });
      }

      rows.push({
        label,
        text,
        rendered: Buffer.byteLength(text),
        portable: Buffer.byteLength(portableText(text, roots)),
      });
    }

    return rows;
  } finally {
    fs.rmSync(created, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
};

const outputOf = ({ stdout, stderr }: ReportOptions): Output => ({
  stdout: stdout ?? PROCESS_OUTPUT.stdout,
  stderr: stderr ?? PROCESS_OUTPUT.stderr,
});

/** Prints the fixture identity, per-verb reading, actor-pack bytes and static call sequences; resolves to the exit code. */
export const report = async (options: ReportOptions = {}) => {
  const io = outputOf(options);
  let rows: PackRow[];

  try {
    rows = await renderPackRows(options);
  } catch (error) {
    io.stderr(`${failureReason(error)}\n`);

    return 1;
  }

  const figures: Partial<Record<PathName, Figures>> = {};
  measureManifest(readSkillFile, false, undefined, io, figures);

  io.stdout(
    [
      fixtureIdentity(SKILL_ROOT),
      "",
      "Per-verb mandatory reading (after model, bytes)",
      formatReport(figures),
      "Actor packs (static fixture; rendered = raw UTF-8 bytes the actor receives; portable = paths and line endings normalized)",
      ...rows.map(
        ({ label, rendered, portable }) =>
          `${label}: ${rendered} rendered, ${portable} portable`
      ),
      "",
      "Static toolkit-call sequences (static; observed counts come from diagnostics render)",
      ...sequenceLines(),
      "",
    ].join("\n")
  );

  return 0;
};

/** Runs `--report`, or one of the synchronous forms through `main`. */
export const cli = async (
  args: string[] = process.argv.slice(2),
  options: ReportOptions = {}
) =>
  args.length === 1 && args[0] === "--report"
    ? await report(options)
    : main(args, undefined, undefined, outputOf(options));

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await cli();
}
