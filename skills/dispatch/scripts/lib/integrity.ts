import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalMarkdown } from "./canonical-markdown.ts";

export const MANIFEST_NAME = "skill-hashes.json";
const SCRIPT_EXTENSION = /\.ts$/u;
const REFERENCE_EXTENSION = /\.(?:md|json)$/u;

const sha256 = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex");

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

/** A parsed JSON object; absent keys read as undefined. */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** `JSON.parse` without a reviver produces exactly a JsonValue. */
export const parseJson: (text: string) => JsonValue = JSON.parse;

const isObjectValue = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object";

export const sortedJson: (value: unknown) => string = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(",")}]`;
  }

  if (isObjectValue(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const jsonForm = (text: string) => {
  try {
    return sortedJson(JSON.parse(text));
  } catch {
    return text.replaceAll("\r\n", "\n");
  }
};

export const hashSkillFile = (file: string) => {
  const text = fs.readFileSync(file, "utf-8");

  if (file.endsWith(".md")) {
    return sha256(canonicalMarkdown(text));
  }

  if (file.endsWith(".json")) {
    return sha256(jsonForm(text));
  }

  return sha256(text.replaceAll("\r\n", "\n"));
};

const forward = (value: string) => value.split(path.sep).join("/");

const collect = (
  skillDir: string,
  sub: string,
  pattern: RegExp,
  into: Record<string, string>
) => {
  const root = path.join(skillDir, sub);

  if (!fs.existsSync(root)) {
    return;
  }

  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const relative = `${sub}/${forward(String(entry))}`;
    const absolute = path.join(skillDir, relative);

    if (pattern.test(relative) && fs.statSync(absolute).isFile()) {
      into[relative] = hashSkillFile(absolute);
    }
  }
};

/** Hashes SKILL.md, scripts (.ts plus the package manifest), and references (.md/.json), sorted by path. */
export const generateSkillHashes = (skillDir: string) => {
  const entries: Record<string, string> = {};
  const skillMd = path.join(skillDir, "SKILL.md");

  if (fs.existsSync(skillMd)) {
    entries["SKILL.md"] = hashSkillFile(skillMd);
  }

  collect(skillDir, "scripts", SCRIPT_EXTENSION, entries);
  const packageManifest = path.join(skillDir, "scripts", "package.json");

  if (fs.existsSync(packageManifest)) {
    entries["scripts/package.json"] = hashSkillFile(packageManifest);
  }

  collect(skillDir, "references", REFERENCE_EXTENSION, entries);

  return Object.fromEntries(
    Object.keys(entries)
      .toSorted()
      .map((key) => [key, entries[key] ?? ""])
  );
};

type IntegrityResult =
  | { status: "ok" }
  | { status: "missing-manifest"; warning: string }
  | { status: "drift"; violations: string[] };

/** Compares the manifest with a fresh hash of the skill; run before any dispatch. */
export const checkIntegrity = (skillDir: string) => {
  const manifestPath = path.join(skillDir, MANIFEST_NAME);

  if (!fs.existsSync(manifestPath)) {
    return {
      status: "missing-manifest",
      warning: `Skill integrity manifest '${MANIFEST_NAME}' not found in ${skillDir}; integrity verification is disabled.`,
    };
  }

  let manifest: unknown;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return { status: "drift", violations: [MANIFEST_NAME] };
  }

  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return { status: "drift", violations: [MANIFEST_NAME] };
  }

  const recorded = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !key.startsWith("$"))
  );

  const actual = generateSkillHashes(skillDir);

  const violations = [
    ...new Set([...Object.keys(recorded), ...Object.keys(actual)]),
  ]
    .filter((key) => recorded[key] !== actual[key])
    .toSorted();

  return violations.length ? { status: "drift", violations } : { status: "ok" };
};

/** The dispatch version recorded in the manifest (`$version`), or undefined when absent or unreadable. */
export const readVersion = (skillDir: string) => {
  let version: unknown;

  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(skillDir, MANIFEST_NAME), "utf-8")
    );

    version = isObjectValue(manifest) ? manifest["$version"] : undefined;
  } catch {
    version = undefined;
  }

  return typeof version === "string" ? version : undefined;
};

/** One-line INTEGRITY_VIOLATION diagnostic, or null when clean. */
export const integrityDiagnostic = (result: IntegrityResult) =>
  result.status === "drift"
    ? `INTEGRITY_VIOLATION: skill integrity check failed for ${result.violations.join(", ")}; run npm run hashes if these edits are intended.`
    : null;
