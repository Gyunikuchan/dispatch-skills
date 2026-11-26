import fs from "node:fs";
import path from "node:path";

import { parseJson, sortedJson } from "./integrity.ts";
import type { JsonObject } from "./integrity.ts";

const closesNext = (text: string, from: number) => {
  let index = from;

  while (index < text.length) {
    const char = text[index];

    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      return char === "}" || char === "]";
    }
  }

  return false;
};

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkReadCommands = (value: unknown, problems: string[]) => {
  if (value === undefined) {
    return;
  }

  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => typeof entry === "string" && READ_COMMAND.test(entry)
    )
  ) {
    problems.push(
      `read-commands must be an array of command prefixes made of plain words separated by single spaces (${HINT}).`
    );
  }
};

export type { JsonObject, JsonValue } from "./integrity.ts";

const SAMPLE_NAME = "config.sample.jsonc";

export const CONFIG_CANDIDATES = [
  "config.local.jsonc",
  "config.jsonc",
] as const;

export const HINT = `diff against ${SAMPLE_NAME}`;

const LEVELS = ["low", "medium", "high", "xhigh", "max"];

const TABLES = [
  "read-delegates",
  "write-subagents",
  "utility-subagents",
  "phases",
  "diagnostics",
  "write-concurrency",
  "read-commands",
  "pricing",
];

const PHASES = ["plan-review", "code-review"];
const KNOBS = ["targets", "rounds"];
const KNOWN = ["claude", "agy", "copilot", "opencode", "codex"];
const SANDBOXED = new Set(["claude", "copilot", "opencode", "codex"]);

interface PlatformAliases {
  readonly [alias: string]: string | undefined;
}

const ALIASES: PlatformAliases = {
  antigravity: "agy",
  claudecode: "claude",
  "claude-code": "claude",
  "github-copilot": "copilot",
  "openai-codex": "codex",
};

type DispatchConfig = JsonObject;

/** Strips `//` and block comments and trailing commas outside strings. */
export const stripJsonc = (text: string) => {
  let out = "";
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1];

    if (quote) {
      out += char;

      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === quote) {
        quote = "";
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }

      out += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);

      if (end === -1) {
        throw new SyntaxError("Unterminated block comment in JSONC");
      }

      index = end + 1;
      continue;
    }

    if (char === "," && closesNext(text, index + 1)) {
      continue;
    }

    out += char;
  }

  return out;
};

export const parseJsonc = (text: string) => parseJson(stripJsonc(text));

export const hasErrorCode = (error: unknown, code: string) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

export type ReadFile = (file: string) => string | null;

export const readReal: ReadFile = (file) => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
};

interface LoadedConfig {
  config: DispatchConfig;
  path: string;
}

/** Loads the first existing candidate under `skillRoot` wholly; absent optional tables become empty maps. */
export const loadConfig = (skillRoot: string, read: ReadFile = readReal) => {
  const candidates = CONFIG_CANDIDATES.map((name) =>
    path.join(skillRoot, name)
  );

  for (const file of candidates) {
    const text = read(file);

    if (text === null) {
      continue;
    }

    const parsed: unknown = parseJsonc(text);

    const config: DispatchConfig = isRecord(parsed)
      ? {
          ...parsed,
          "write-subagents": parsed["write-subagents"] ?? {},
          "utility-subagents": parsed["utility-subagents"] ?? {},
          phases: parsed["phases"] ?? {},
        }
      : {};

    if (!isRecord(parsed)) {
      throw new Error(`${file}: config must be a JSON object (${HINT}).`);
    }

    return { config, path: file } satisfies LoadedConfig;
  }

  throw new Error(
    `Config file not found: tried ${candidates.join(", ")}. Copy ${SAMPLE_NAME} to config.local.jsonc or config.jsonc.`
  );
};

/** Host read-command prefixes for provider allowlists; no config file means none. */
export const loadReadCommands = (
  skillRoot: string,
  read: ReadFile = readReal
) => {
  if (
    CONFIG_CANDIDATES.every((name) => read(path.join(skillRoot, name)) === null)
  ) {
    return [];
  }

  const value = loadConfig(skillRoot, read).config["read-commands"];
  const problems: string[] = [];
  checkReadCommands(value, problems);

  if (problems.length) {
    throw new Error(problems.join(" "));
  }

  return isStringArray(value) ? value : [];
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const canonical = (key: string) =>
  ALIASES[key.toLowerCase()] ?? key.toLowerCase();

const nonNegativeInt = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const positiveInt = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const goodName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  !value.trim().endsWith(":");

const READ_COMMAND = /^[A-Za-z0-9._/:=@+-]+(?: [A-Za-z0-9._/:=@+-]+)*$/u;

const checkLevelConfig = (
  where: string,
  value: unknown,
  problems: string[],
  utility = false
) => {
  const desc = utility
    ? "model, context-limit and optional effort"
    : "model and optional effort";

  if (!isRecord(value)) {
    problems.push(`${where} must be an object with ${desc} (${HINT}).`);

    return;
  }

  const valid = utility ? "model, effort, context-limit" : "model, effort";

  const validKeys = utility
    ? ["model", "effort", "context-limit"]
    : ["model", "effort"];

  for (const key of Object.keys(value)) {
    if (!validKeys.includes(key)) {
      problems.push(
        `${where} has unrecognized key "${key}". Valid keys: ${valid} (${HINT}).`
      );
    }
  }

  const { model } = value;

  if (model === undefined) {
    problems.push(`${where}.model is required (${HINT}).`);
  } else if (
    !(
      goodName(model) ||
      (Array.isArray(model) && model.length > 0 && model.every(goodName))
    )
  ) {
    problems.push(
      `${where}.model must be a nonblank string or non-empty array of nonblank strings (${HINT}).`
    );
  } else if (Array.isArray(model)) {
    const dup = model.find((item, index) => model.indexOf(item) !== index);

    if (dup !== undefined) {
      problems.push(`${where}.model has duplicate alias "${dup}" (${HINT}).`);
    }
  }

  if ("effort" in value && !goodName(value["effort"])) {
    problems.push(
      `${where}.effort must be a string and not blank; omit it for the provider default (${HINT}).`
    );
  }

  if (
    utility &&
    (value["context-limit"] === undefined ||
      !positiveInt(value["context-limit"]))
  ) {
    problems.push(
      `${where}.context-limit must be a positive integer (${HINT}).`
    );
  }
};

const checkLevelMap = (where: string, value: unknown, problems: string[]) => {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object keyed by level (${HINT}).`);

    return;
  }

  if (!Object.keys(value).length) {
    problems.push(`${where} must define at least one level (${HINT}).`);
  }

  for (const [key, entry] of Object.entries(value)) {
    if (LEVELS.includes(key)) {
      checkLevelConfig(`${where}.${key}`, entry, problems);
    } else {
      problems.push(
        `${where} has unrecognized key "${key}". Valid keys: ${LEVELS.join(", ")} (${HINT}).`
      );
    }
  }
};

const checkReadProviderKeys = (
  where: string,
  value: JsonObject,
  provider: string,
  sandboxed: boolean,
  valid: string,
  problems: string[]
) => {
  for (const [key, field] of Object.entries(value)) {
    if (key === "targets" || key === "nativeSubagents") {
      continue;
    }

    if (key === "nativeSubagentsOnly" || (key === "sandbox" && sandboxed)) {
      if (typeof field !== "boolean") {
        problems.push(`${where}.${key} must be a boolean (${HINT}).`);
      }
    } else if (key === "sandbox") {
      problems.push(
        `${where}.sandbox is not supported for ${provider}; remove it (${HINT}).`
      );
    } else {
      problems.push(
        `${where} has unrecognized key "${key}". Valid keys: ${valid} (${HINT}).`
      );
    }
  }
};

const checkReadProvider = (
  where: string,
  value: unknown,
  provider: string,
  problems: string[]
) => {
  const sandboxed = SANDBOXED.has(provider);

  const valid = sandboxed
    ? "sandbox, nativeSubagentsOnly, targets"
    : "nativeSubagentsOnly, targets";

  if (!isRecord(value)) {
    problems.push(`${where} must be an object with keys ${valid} (${HINT}).`);

    return;
  }

  if ("nativeSubagents" in value) {
    problems.push(
      `${where}.nativeSubagents was removed; delete the key (${HINT}).`
    );
  }

  checkReadProviderKeys(where, value, provider, sandboxed, valid, problems);

  const { targets } = value;

  if (!Array.isArray(targets) || !targets.length) {
    problems.push(
      `${where}.targets must be a non-empty array of level maps (${HINT}).`
    );

    return;
  }

  const seen = new Map<string, number>();

  for (const [index, target] of targets.entries()) {
    checkLevelMap(`${where}.targets[${index}]`, target, problems);

    if (!isRecord(target)) {
      continue;
    }

    const key = sortedJson(target);
    const first = seen.get(key);

    if (first === undefined) {
      seen.set(key, index);
    } else {
      problems.push(
        `${where}.targets[${index}] duplicates targets[${first}] (${HINT}).`
      );
    }

    if (value["nativeSubagentsOnly"] !== true) {
      continue;
    }

    for (const [level, entry] of Object.entries(target)) {
      if (
        LEVELS.includes(level) &&
        isRecord(entry) &&
        entry["effort"] === undefined
      ) {
        problems.push(
          `${where}.targets[${index}].${level}.effort is required when nativeSubagentsOnly is true (${HINT}).`
        );
      }
    }
  }
};

const checkPlatformTable = (
  table: string,
  value: unknown,
  problems: string[],
  one: (where: string, entry: unknown, provider: string) => void
) => {
  if (!isRecord(value)) {
    problems.push(
      `"${table}" must be an object mapping platform key to settings (${HINT}).`
    );

    return [];
  }

  const seen = new Map<string, string>();

  for (const [key, entry] of Object.entries(value)) {
    if (key === "all") {
      problems.push(
        `${table} cannot use reserved pin keyword "all" as a platform key (${HINT}).`
      );
      continue;
    }

    const provider = canonical(key);

    if (!KNOWN.includes(provider)) {
      problems.push(
        `${table}: unknown platform "${key}" (expected ${KNOWN.join(", ")}).`
      );
      continue;
    }

    const prior = seen.get(provider);

    if (prior !== undefined) {
      problems.push(
        `${table}: duplicate platform "${provider}" (keys "${prior}" and "${key}" normalize to the same provider).`
      );
      continue;
    }

    seen.set(provider, key);
    one(`${table}.${key}`, entry, provider);
  }

  return [...seen.keys()];
};

const checkPhaseKnobs = (
  where: string,
  policy: JsonObject,
  problems: string[]
) => {
  for (const key of Object.keys(policy)) {
    if (![...KNOBS, "only"].includes(key)) {
      problems.push(
        `${where} has unrecognized key "${key}". Valid keys: ${[...KNOBS, "only"].join(", ")} (${HINT}).`
      );
    }
  }

  for (const knob of KNOBS) {
    const map = policy[knob];

    if (map === undefined) {
      problems.push(`${where} is missing required knob "${knob}" (${HINT}).`);
      continue;
    }

    if (!isRecord(map) || !Object.keys(map).length) {
      problems.push(
        `${where}.${knob} must be a non-empty object keyed by level (${HINT}).`
      );
      continue;
    }

    for (const [level, entry] of Object.entries(map)) {
      if (!LEVELS.includes(level)) {
        problems.push(
          `${where}.${knob} has unrecognized level "${level}". Valid levels: ${LEVELS.join(", ")} (${HINT}).`
        );
      } else if (
        knob === "rounds"
          ? !nonNegativeInt(entry)
          : entry !== "all" && !nonNegativeInt(entry)
      ) {
        problems.push(
          `${where}.${knob}.${level} must be a non-negative integer${knob === "targets" ? ' or "all"' : ""} (${HINT}).`
        );
      }
    }
  }
};

const checkPhaseOnly = (
  where: string,
  only: unknown,
  readKeys: readonly string[],
  problems: string[]
) => {
  if (!isStringArray(only) || !only.length) {
    problems.push(
      `${where}.only must be a non-empty array of read-delegates platform keys (${HINT}).`
    );

    return;
  }

  const missing = only.filter((key) => !readKeys.includes(canonical(key)));

  if (missing.length > 0) {
    problems.push(
      `${where}.only names platform(s) not in read-delegates: ${missing.join(", ")} (configured: ${readKeys.join(", ") || "none"}).`
    );
  }
};

const checkPhases = (
  value: unknown,
  readKeys: readonly string[],
  problems: string[]
) => {
  if (!isRecord(value)) {
    problems.push(
      `"phases" must be an object keyed by review phase (${HINT}).`
    );

    return;
  }

  for (const [phase, policy] of Object.entries(value)) {
    const where = `phases.${phase}`;

    if (!PHASES.includes(phase)) {
      problems.push(
        `phases has unrecognized phase "${phase}". Valid phases: ${PHASES.join(", ")} (${HINT}).`
      );
      continue;
    }

    if (!isRecord(policy)) {
      problems.push(`${where} must be an object (${HINT}).`);
      continue;
    }

    checkPhaseKnobs(where, policy, problems);

    const { only } = policy;

    if (only === undefined) {
      continue;
    }

    checkPhaseOnly(where, only, readKeys, problems);
  }
};

/** Every schema problem in one pass; empty when valid. */
export const validateConfig = (config: unknown) => {
  if (!isRecord(config)) {
    return [
      `Config must be a JSON object with tables: ${TABLES.join(", ")} (${HINT}).`,
    ];
  }

  const problems: string[] = [];

  if (
    config["diagnostics"] !== undefined &&
    typeof config["diagnostics"] !== "boolean"
  ) {
    problems.push(`diagnostics must be a boolean (${HINT}).`);
  }

  if (
    config["write-concurrency"] !== undefined &&
    !positiveInt(config["write-concurrency"])
  ) {
    problems.push(`write-concurrency must be a positive integer (${HINT}).`);
  }

  checkReadCommands(config["read-commands"], problems);

  if ("explore-subagents" in config) {
    problems.push(
      `explore-subagents was renamed to utility-subagents (${HINT}).`
    );
  }

  for (const key of Object.keys(config)) {
    if (key !== "explore-subagents" && !TABLES.includes(key)) {
      problems.push(
        `Unrecognized top-level key "${key}". Valid tables: ${TABLES.join(", ")} (${HINT}).`
      );
    }
  }

  let readKeys: string[] = [];
  const read = config["read-delegates"];

  if (read === undefined) {
    problems.push(`Missing required table "read-delegates" (${HINT}).`);
  } else {
    readKeys = checkPlatformTable(
      "read-delegates",
      read,
      problems,
      (where, entry, provider) => {
        checkReadProvider(where, entry, provider, problems);
      }
    );

    if (isRecord(read) && !Object.keys(read).length) {
      problems.push(
        `read-delegates must define at least one platform (${HINT}).`
      );
    }
  }

  const write = config["write-subagents"];

  if (write !== undefined) {
    checkPlatformTable("write-subagents", write, problems, (where, entry) => {
      checkLevelMap(where, entry, problems);
    });
  }

  const utility = config["utility-subagents"];

  if (utility !== undefined) {
    checkPlatformTable(
      "utility-subagents",
      utility,
      problems,
      (where, entry) => {
        checkLevelConfig(where, entry, problems, true);
      }
    );
  }

  if (config["phases"] !== undefined) {
    checkPhases(config["phases"], readKeys, problems);
  }

  return problems;
};
