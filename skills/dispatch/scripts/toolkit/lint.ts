import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { artifactHash, artifactKind, readArtifact } from "./artifacts.ts";
import { lintCitations } from "./domain/citations.ts";
import type { CitationDefect } from "./domain/citations.ts";
import { lintContextMap } from "./domain/context.ts";
import { parseDesign, parseIncrementGraph } from "./domain/design.ts";
import { structuralLines } from "./domain/markdown-structure.ts";
import {
  lint as lintDefect,
  outsideIncrementWarnings,
  parentPin,
  parsePlan,
} from "./domain/plan.ts";
import { parseSpec } from "./domain/spec.ts";
import { present } from "./narrow.ts";
import { ToolError } from "./output.ts";

interface LintArtifactOptions {
  repositoryRoot?: string;
}

export const safeRepoPath = (value: string) => {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }

  const normalized = path.posix.normalize(value);

  return (
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.posix.isAbsolute(normalized)
  );
};

export const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

/** Reads only repository files whose resolved path remains inside the session's repository root. */
export const repositoryReader = (repositoryRoot: string) => {
  const root = path.resolve(repositoryRoot);
  let realRoot: string;

  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return () => null;
  }

  return (relativePath: string) => {
    if (!safeRepoPath(relativePath)) {
      return null;
    }

    const candidate = path.resolve(root, relativePath);

    if (!within(root, candidate)) {
      return null;
    }

    try {
      const real = fs.realpathSync(candidate);

      if (!within(realRoot, real) || !fs.statSync(real).isFile()) {
        return null;
      }

      return fs.readFileSync(real, "utf-8");
    } catch {
      return null;
    }
  };
};

const pinnedIncrementWarnings = (
  source: string,
  changes: Parameters<typeof outsideIncrementWarnings>[0],
  repositoryRoot: string
) => {
  const pin = parentPin(source);

  if (pin === null || !("increment" in pin)) {
    return [];
  }

  const design = repositoryReader(repositoryRoot)(pin.path);

  const increment =
    design === null
      ? undefined
      : parseIncrementGraph(structuralLines(design)).increments.find(
          (row) => row.id === pin.increment
        );

  if (!increment) {
    return [
      lintDefect(
        "outside-increment",
        null,
        `Pinned design increment ${pin.increment} in ${pin.path} cannot be read; plan paths are unchecked.`
      ),
    ];
  }

  return outsideIncrementWarnings(changes, increment.paths, pin.increment);
};

export const lintArtifact = (
  file: string,
  options: LintArtifactOptions = {}
) => {
  const isContext = file.endsWith(".context.md");
  const kind = artifactKind(file);

  if (!isContext && !kind) {
    throw new ToolError(
      1,
      "invalid-input",
      "artifact must end in .spec.md, .plan.md, .design.md or .context.md"
    );
  }

  const source = readArtifact(path.dirname(file), path.basename(file));

  if (source === null) {
    throw new ToolError(
      1,
      "invalid-input",
      `artifact is missing or unreadable: ${file}`
    );
  }

  if (isContext) {
    if (options.repositoryRoot === undefined || options.repositoryRoot === "") {
      throw new ToolError(
        1,
        "invalid-input",
        "context lint requires the session repository root"
      );
    }

    const result = lintContextMap(source, {
      readRepoFile: repositoryReader(options.repositoryRoot),
    });

    const hash = `sha256:${crypto.createHash("sha256").update(source).digest("hex")}`;

    return {
      kind: "context" as const,
      hash,
      errors: result.defects,
      warnings: result.warnings,
    };
  }

  let result:
    | ReturnType<typeof parsePlan>
    | ReturnType<typeof parseDesign>
    | ReturnType<typeof parseSpec>;

  if (kind === "plan") {
    result = parsePlan(source);
  } else if (kind === "design") {
    result = parseDesign(source);
  } else {
    result = parseSpec(source);
  }

  const hash = artifactHash(present(kind, "the artifact kind"), source);

  const citationErrors: CitationDefect[] =
    (kind === "plan" || kind === "design") &&
    options.repositoryRoot !== undefined &&
    options.repositoryRoot !== ""
      ? lintCitations(source, kind, repositoryReader(options.repositoryRoot))
      : [];

  const errors = [
    ...("defects" in result ? result.defects : []),
    ...citationErrors,
  ];

  const warnings = [...result.warnings];

  if (
    result.ok &&
    "plan" in result &&
    options.repositoryRoot !== undefined &&
    options.repositoryRoot !== ""
  ) {
    warnings.push(
      ...pinnedIncrementWarnings(
        source,
        result.plan.changes,
        options.repositoryRoot
      )
    );
  }

  return { kind, hash, errors, warnings };
};
