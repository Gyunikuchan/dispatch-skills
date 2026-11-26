import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalMarkdown } from "../lib/canonical-markdown.ts";
import { governedDesignText } from "./domain/design.ts";
import { governedPlanText } from "./domain/plan.ts";
import { governedSpecText } from "./domain/spec.ts";

export type ArtifactKind = "spec" | "plan" | "design";

export const artifactKind = (file: string) => {
  for (const kind of ["spec", "plan", "design"] as const) {
    if (file.endsWith(`.${kind}.md`)) {
      return kind;
    }
  }

  return null;
};

export const artifactHash = (kind: ArtifactKind, source: string) => {
  const governed = {
    spec: governedSpecText,
    plan: governedPlanText,
    design: governedDesignText,
  }[kind](source);

  return `sha256:${crypto
    .createHash("sha256")
    .update(canonicalMarkdown(governed))
    .digest("hex")}`;
};

export const readArtifact = (root: string, relative: string) => {
  try {
    const file = path.resolve(root, relative);

    if (!fs.statSync(file).isFile()) {
      return null;
    }

    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
};
