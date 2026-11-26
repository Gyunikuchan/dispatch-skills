import fs from "node:fs";
import path from "node:path";

import { stripBom } from "../lib/fs-ext.ts";
import { parseJson } from "../lib/integrity.ts";
import type { HandlerContext } from "./cli.ts";
import { ToolError } from "./output.ts";

export const readRequiredReason = (ctx: HandlerContext) => {
  const value = ctx.values["reason"];

  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError(1, "invalid-input", "A non-blank --reason is required");
  }

  return value;
};

export interface DirectFieldSpec {
  readonly flag: string;
  readonly key: string;
}

export interface TextPayloadSpec {
  readonly positional?: string;
  readonly fileFlag?: string;
  readonly inlineFlag?: string;
  readonly label: string;
}

export type JsonPayloadSpec = TextPayloadSpec & {
  readonly direct?: readonly DirectFieldSpec[];
  readonly optional?: boolean;
};

type RawSource =
  | { readonly kind: "none" }
  | { readonly kind: "direct"; readonly value: Record<string, string> }
  | { readonly kind: "raw"; readonly text: string; readonly origin: string };

const readFileOrStdin = (
  ctx: HandlerContext,
  source: unknown,
  label: string
) => {
  if (typeof source !== "string" || !source.trim()) {
    throw new ToolError(
      1,
      "invalid-input",
      `${label} requires a readable file path or -`
    );
  }

  if (source === "-") {
    if (!ctx.deps.readStdin) {
      throw new ToolError(
        1,
        "invalid-input",
        `Cannot read ${label} from stdin`
      );
    }

    try {
      return { text: stripBom(ctx.deps.readStdin()), origin: "stdin" };
    } catch {
      throw new ToolError(
        1,
        "invalid-input",
        `Cannot read ${label} from stdin`
      );
    }
  }

  try {
    return {
      text: stripBom(fs.readFileSync(path.resolve(source), "utf-8")),
      origin: source,
    };
  } catch {
    throw new ToolError(
      1,
      "invalid-input",
      `Cannot read ${label} file ${source}`
    );
  }
};

// oxlint-disable-next-line eslint/complexity -- source resolution branches per positional/flag mode count and entry shape.
const resolveSource = (
  ctx: HandlerContext,
  spec: JsonPayloadSpec
): RawSource => {
  if (spec.positional !== undefined && ctx.args.length > 1) {
    throw new ToolError(
      1,
      "invalid-input",
      `${spec.label} accepts at most one ${spec.positional} input`
    );
  }

  const posArg = spec.positional === undefined ? undefined : ctx.args[0];

  const fileVal =
    spec.fileFlag === undefined ? undefined : ctx.values[spec.fileFlag];

  const inlineVal =
    spec.inlineFlag === undefined ? undefined : ctx.values[spec.inlineFlag];

  const directEntries = spec.direct ?? [];

  const presentDirect = directEntries.filter(
    (entry) => ctx.values[entry.flag] !== undefined
  );

  const hasDirect = presentDirect.length > 0;

  const modes =
    (posArg === undefined ? 0 : 1) +
    (fileVal === undefined ? 0 : 1) +
    (inlineVal === undefined ? 0 : 1) +
    (hasDirect ? 1 : 0);

  if (modes > 1) {
    throw new ToolError(
      1,
      "invalid-input",
      `${spec.label} accepts only one input form`
    );
  }

  if (modes === 0) {
    if (spec.optional === true) {
      return { kind: "none" };
    }

    throw new ToolError(1, "invalid-input", `${spec.label} requires input`);
  }

  if (hasDirect) {
    if (presentDirect.length !== directEntries.length) {
      const missing = directEntries
        .filter((entry) => ctx.values[entry.flag] === undefined)
        .map((entry) => `--${entry.flag}`)
        .join(", ");

      throw new ToolError(
        1,
        "invalid-input",
        `${spec.label} requires all direct flags together; missing ${missing}`
      );
    }

    const out: Record<string, string> = {};

    for (const entry of directEntries) {
      const value = ctx.values[entry.flag];

      if (typeof value !== "string" || !value.trim()) {
        throw new ToolError(
          1,
          "invalid-input",
          `--${entry.flag} requires a non-blank string`
        );
      }

      out[entry.key] = value;
    }

    return { kind: "direct", value: out };
  }

  if (inlineVal !== undefined) {
    if (typeof inlineVal !== "string") {
      throw new ToolError(
        1,
        "invalid-input",
        `--${spec.inlineFlag} requires a string value`
      );
    }

    return {
      kind: "raw",
      text: stripBom(inlineVal),
      origin: `--${spec.inlineFlag}`,
    };
  }

  const loaded = readFileOrStdin(ctx, posArg ?? fileVal, spec.label);

  return { kind: "raw", text: loaded.text, origin: loaded.origin };
};

/** Reads a non-blank text payload from a positional/flag file path, stdin `-`, or an inline text flag. */
export const readTextPayload = (ctx: HandlerContext, spec: TextPayloadSpec) => {
  const resolved = resolveSource(ctx, spec);

  if (resolved.kind !== "raw") {
    throw new ToolError(
      1,
      "invalid-input",
      `${spec.label} requires text input`
    );
  }

  if (!resolved.text.trim()) {
    throw new ToolError(1, "invalid-input", `${spec.label} must not be blank`);
  }

  return resolved.text;
};

/** Reads and parses a JSON payload from a file path, stdin `-`, inline `--json` flag, or co-required direct flags. */
export const readJsonPayload = (ctx: HandlerContext, spec: JsonPayloadSpec) => {
  const resolved = resolveSource(ctx, spec);

  if (resolved.kind === "none") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the absent and parsed branches.
    return undefined;
  }

  if (resolved.kind === "direct") {
    return resolved.value;
  }

  try {
    return parseJson(resolved.text);
  } catch {
    throw new ToolError(
      1,
      "invalid-input",
      `${spec.label} from ${resolved.origin} is not valid JSON`
    );
  }
};
