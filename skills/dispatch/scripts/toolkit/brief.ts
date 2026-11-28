import fs from "node:fs";
import path from "node:path";

import { isRecord, loadConfig, validateConfig } from "../lib/config.ts";
import { launchLine, summaryLaunch } from "../lib/platform.ts";
import {
  normalizeProvider,
  resolveLevel,
  resolveSubagent,
  resolveUtility,
} from "../policy/roster.ts";
import type { ResolvedSubagent, ResolvedUtility } from "../policy/roster.ts";
import type { HandlerContext } from "./cli.ts";
import {
  DEFAULT_MAP_BUDGET,
  DEFAULT_RESEARCH_REPLY_LIMIT,
} from "./domain/context.ts";
import { structuralLines } from "./domain/markdown-structure.ts";
import { parsePlan, selectTaskBrief } from "./domain/plan.ts";
import { qualityCriteria } from "./domain/prompt.ts";
import type { QualityConsumer } from "./domain/prompt.ts";
import { readJsonPayload } from "./input.ts";
import {
  currentSnapshot,
  foldLedger,
  gate,
  latest,
  withLedger,
} from "./ledger.ts";
import {
  isLevel,
  isUtilityTable,
  isWriterTable,
  present,
  textValue,
} from "./narrow.ts";
import { capSummary, clipBytes, ToolError } from "./output.ts";
import { checks } from "./plan-view.ts";
import type { Level } from "./types.ts";
import { launches } from "./writers.ts";

interface LaunchValues {
  model: string[] | null;
  effort: string | null;
  launchAs: string | null;
}

const launchValues = (
  resolved: ResolvedSubagent | ResolvedUtility | undefined,
  normalized: string
) =>
  resolved
    ? {
        model: resolved.models,
        effort: resolved.effort,
        launchAs: launchLine(normalized, resolved.models, resolved.effort),
      }
    : { model: null, effort: null, launchAs: null };

export const briefSummary = (
  prefix: string,
  host: string | undefined,
  values: LaunchValues,
  file: string,
  bytes: number,
  suffix?: { tail: string; shortPath: string }
) => {
  let launch =
    host !== undefined && host !== "" && values.model !== null
      ? `${summaryLaunch(host, values.model, values.effort)}; `
      : "";

  const absolute = `${prefix}: ${launch}${file} (${bytes} bytes)`;

  if (!suffix) {
    return capSummary(absolute);
  }

  const { tail, shortPath } = suffix;

  if (Buffer.byteLength(absolute + tail) <= 1024) {
    return absolute + tail;
  }

  const ending = `session-relative ${shortPath} (${bytes} bytes)${tail}`;
  const headBudget = 1024 - Buffer.byteLength(ending);
  const prefixBudget = headBudget - Buffer.byteLength(launch);

  const heading =
    prefixBudget < 5 ? "" : `${clipBytes(prefix, prefixBudget - 2)}: `;

  if (prefixBudget < 0) {
    launch =
      headBudget < 5
        ? ""
        : `${clipBytes(launch.slice(0, -2), headBudget - 2)}; `;
  }

  return heading + launch + ending;
};

/** Writer launch values from `write-subagents` at the ledger level; null when the host or config does not resolve. */
const writerLaunchValues = (
  skillRoot: string,
  host: string | undefined,
  level: Level
) => {
  try {
    if (host === undefined || host === "") {
      return { model: null, effort: null, launchAs: null };
    }

    const normalized = normalizeProvider(host);
    const { config } = loadConfig(skillRoot);

    if (validateConfig(config).length) {
      return { model: null, effort: null, launchAs: null };
    }

    const section = config["write-subagents"];
    const writerTable = isWriterTable(section) ? section : undefined;

    const key =
      writerTable === undefined
        ? undefined
        : Object.keys(writerTable).find(
            (candidate) => normalizeProvider(candidate) === normalized
          );

    const entry =
      key !== undefined && writerTable !== undefined
        ? resolveLevel(writerTable[key], level)
        : undefined;

    return launchValues(entry ? resolveSubagent(entry) : undefined, normalized);
  } catch {
    return { model: null, effort: null, launchAs: null };
  }
};

/** Explorer, test-cleanup and writer utility entry; null when the host or config does not resolve. */
export const resolveHostUtility = (
  skillRoot: string,
  host: string | undefined
) => {
  try {
    if (host === undefined || host === "") {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the unresolved and entry branches.
      return undefined;
    }

    const { config } = loadConfig(skillRoot);

    if (validateConfig(config).length) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the unresolved and entry branches.
      return undefined;
    }

    const section = config["utility-subagents"];
    const utility = resolveUtility(isUtilityTable(section) ? section : {});

    return utility[normalizeProvider(host)];
  } catch {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the resolved and failed branches.
    return undefined;
  }
};

/** Explorer and test-cleanup launch values from the `utility` entry; null when the host or config does not resolve. */
export const utilityLaunchValues = (
  skillRoot: string,
  host: string | undefined
) => {
  const normalized =
    host !== undefined && host !== "" ? normalizeProvider(host) : "";

  return launchValues(resolveHostUtility(skillRoot, host), normalized);
};

const taskParts = (
  source: string,
  selected: NonNullable<ReturnType<typeof selectTaskBrief>>
) => {
  const lines = source.split(/\r?\n/u);
  const structural = structuralLines(source);

  const taskEnd = structural.findIndex(
    (entry, i) => i >= selected.task.line && /^#{2,3} /u.test(entry.text)
  );

  const section = lines
    .slice(selected.task.line - 1, taskEnd === -1 ? undefined : taskEnd)
    .join("\n")
    .trim();

  const criteria = selected.criteria
    .map((criterion) => {
      const end = structural.findIndex(
        (entry, i) =>
          i >= criterion.line &&
          (entry.text.startsWith("## ") || /^- \[SC\d+\]/u.test(entry.text))
      );

      return lines
        .slice(criterion.line - 1, end === -1 ? undefined : end)
        .join("\n")
        .trim();
    })
    .join("\n\n");

  return { section, criteria };
};

export const taskMarkdown = (
  source: string,
  brief: NonNullable<ReturnType<typeof selectTaskBrief>>
) => {
  const { section, criteria } = taskParts(source, brief);

  return [section, criteria].filter(Boolean).join("\n\n");
};

type SelectedTaskBrief = NonNullable<ReturnType<typeof selectTaskBrief>>;

// Base64url keeps the payload opaque to shell parsing.
const CAPTURE_BOOTSTRAP = [
  "const fs=require('node:fs');",
  "const path=require('node:path');",
  "const {spawnSync}=require('node:child_process');",
  "const data=JSON.parse(Buffer.from(process.argv[2],'base64url').toString('utf8'));",
  "fs.mkdirSync(data.logDir,{recursive:true});",
  "const stdoutPath=path.join(data.logDir,data.criterion+'.stdout');",
  "const stderrPath=path.join(data.logDir,data.criterion+'.stderr');",
  "let stdoutFd,stderrFd,result;",
  "try { stdoutFd=fs.openSync(stdoutPath,'w');stderrFd=fs.openSync(stderrPath,'w');try { result=spawnSync(data.command,{cwd:data.cwd,shell:true,stdio:['ignore',stdoutFd,stderrFd]}); } catch(error) { result={status:null,signal:null,error}; } }",
  "finally { try { if(stdoutFd!==undefined)fs.closeSync(stdoutFd); } finally { if(stderrFd!==undefined)fs.closeSync(stderrFd); } }",
  "const replay=(file,target)=>{const fd=fs.openSync(file,'r');try {const chunk=Buffer.alloc(65536);let size;while((size=fs.readSync(fd,chunk,0,chunk.length,null))>0){let offset=0;while(offset<size)offset+=fs.writeSync(target,chunk,offset,size-offset);}} finally {fs.closeSync(fd);}};",
  String.raw`fs.writeFileSync(path.join(data.logDir,data.criterion+'.exit'),JSON.stringify({status:result.status??null,signal:result.signal??null,error:result.error?String(result.error.message??result.error):null})+'\n');`,
  "replay(stdoutPath,1);replay(stderrPath,2);",
  "if(result.error)process.stderr.write(String(result.error.message??result.error));",
  "process.exitCode=result.status??1;",
].join("");

const CAPTURE_SHELL_META = new Set([
  ...String.raw`!#$&()*;<>?[]\^{|}~%`.split(""),
  String.fromCodePoint(96),
]);

// ASCII controls only (U+0000-U+001F, U+007F): `\p{Cc}` minus the C1 block.
const ASCII_CONTROL = /(?![\u0080-\u009F])\p{Cc}/u;

const safeCapturePath = (value: string) => {
  if (
    !value ||
    value.trim() !== value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("~") ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    ASCII_CONTROL.test(value) ||
    value.includes('"') ||
    value.includes("'") ||
    value.includes(String.fromCodePoint(96))
  ) {
    return false;
  }

  for (const character of value) {
    if (CAPTURE_SHELL_META.has(character)) {
      return false;
    }
  }

  return true;
};

const quoteCapturePath = (value: string) =>
  process.platform === "win32" ? `"${value}"` : `'${value}'`;

// oxlint-disable-next-line eslint/complexity -- red-capture branches per criterion eligibility, unsafe test path, and placeholder expansion.
const renderRedCapture = (
  selected: SelectedTaskBrief,
  task: string,
  worktree: string,
  redLogDir: string
) => {
  const lines: string[] = [];
  const capturePath = path.join(redLogDir, "capture.cjs");
  let written = false;

  for (const criterion of selected.criteria) {
    // Keep this eligibility rule aligned with redGaps; verify-only and excepted criteria need no capture.
    if (
      !selected.task.criteria.includes(criterion.id) ||
      criterion.evidence !== "red" ||
      criterion.red === null ||
      criterion.red === "" ||
      (criterion.redException !== null && criterion.redException !== "")
    ) {
      continue;
    }

    const testFiles = [...new Set(criterion.tests)];
    const unsafe = testFiles.find((file) => !safeCapturePath(file));

    if (unsafe !== undefined) {
      lines.push(
        `- RED capture omitted for task ${task}, criterion ${
          criterion.id
        }: unsafe test path ${JSON.stringify(unsafe)}.`
      );
      continue;
    }

    if (criterion.red.includes("{files}") && !testFiles.length) {
      lines.push(
        `- RED capture omitted for task ${task}, criterion ${
          criterion.id
        }: {files} has no test paths.`
      );
      continue;
    }

    const command = criterion.red.replaceAll(
      "{files}",
      testFiles.map(quoteCapturePath).join(" ")
    );

    if (!written) {
      fs.mkdirSync(redLogDir, { recursive: true });
      fs.writeFileSync(capturePath, CAPTURE_BOOTSTRAP);
      written = true;
    }

    const bootstrap = Buffer.from(CAPTURE_BOOTSTRAP, "utf-8").toString(
      "base64url"
    );

    const data = Buffer.from(
      JSON.stringify({
        command,
        cwd: worktree,
        logDir: redLogDir,
        criterion: criterion.id,
      }),
      "utf-8"
    ).toString("base64url");

    const shellPath =
      process.platform === "win32" && /^[A-Za-z]:/u.test(capturePath)
        ? capturePath.slice(2)
        : capturePath;

    let shellMeta = false;

    for (const character of shellPath) {
      if (
        !(process.platform === "win32" && character === "\\") &&
        CAPTURE_SHELL_META.has(character)
      ) {
        shellMeta = true;
        break;
      }
    }

    const safe =
      path.isAbsolute(capturePath) &&
      !ASCII_CONTROL.test(shellPath) &&
      !/["':]/u.test(shellPath) &&
      !shellMeta;

    const wrapper = safe
      ? `node ${quoteCapturePath(capturePath)} ${data}`
      : `node -e "eval(Buffer.from(process.argv[1],'base64url').toString())" ${
          bootstrap
        } ${data}`;

    const tick = String.fromCodePoint(96);
    lines.push(`- ${criterion.id}: ${tick}${wrapper}${tick}`);
  }

  return lines.join("\n");
};

/** The host's utility entry as brief text; an undetected host or unusable config never refuses the render. */
const explorerText = (skillRoot: string, platform: string | undefined) => {
  const entry = resolveHostUtility(skillRoot, platform);

  if (!entry) {
    return "Utility subagent entry for this host is not configured; the orchestrator reports a blocker.";
  }

  const launch = launchLine(platform ?? "", entry.models, entry.effort);
  const limit = entry.contextLimit.toLocaleString("en-US");
  const replyLimit = DEFAULT_RESEARCH_REPLY_LIMIT.toLocaleString("en-US");

  return `Explorer subagent for this host — ${launch}. For heavy reading outside your task paths, you may launch a research explorer on this entry (token limit ${limit} tokens, reply size limit ${replyLimit} UTF-8 bytes). Require it to stay read-only: no edits, no Git write commands and no toolkit. Read the files you edit yourself and treat its reply as claims. If the host has no launch tool, read directly. For tedious, simple edits inside your task paths, you may launch a utility subagent on the same entry. Assign each utility subagent explicit disjoint paths inside your task paths, with no path shared between two running utility subagents. Require it to run no Git write commands, no toolkit, and launch nothing; no token limit applies to it. Inspect its delta and run the task verification yourself. If the host has no launch tool, perform the edits yourself.`;
};

/** Shared `{{slot}}` substitution; an unknown slot name refuses instead of emitting raw braces. */
export const fillSlots = (
  label: string,
  text: string,
  slots: Record<string, string>
) =>
  text.replaceAll(/\{\{(?<cap1>\w+)\}\}/gu, (_, name: string) => {
    if (!Object.hasOwn(slots, name)) {
      throw new Error(`Unknown ${label} brief slot ${name}`);
    }

    return String(slots[name]);
  });

export const assertFilled = (label: string, text: string) => {
  if (/\{\{\w+\}\}/u.test(text)) {
    throw new ToolError(2, "fault", `Unfilled ${label} brief placeholder`);
  }

  if (/\[[^\]]+\]\((?![a-zA-Z][a-zA-Z0-9+.-]*:)(?![#<])[^)]+\)/u.test(text)) {
    throw new ToolError(
      2,
      "fault",
      `Rendered ${label} brief contains a relative link`
    );
  }
};

export const nextBriefPath = (directory: string, base: string) => {
  let index = 1;

  while (fs.existsSync(path.join(directory, `${base}-${index}.md`))) {
    index += 1;
  }

  return path.join(directory, `${base}-${index}.md`);
};

const briefQuality = (skillRoot: string, consumer: QualityConsumer) => {
  const bar = fs.readFileSync(
    path.join(skillRoot, "references", "templates", "quality-bar.md"),
    "utf-8"
  );

  const specStage = fs.readFileSync(
    path.join(skillRoot, "references", "spec-stage.md"),
    "utf-8"
  );

  return qualityCriteria(bar, consumer, 0, specStage);
};

const prepareBriefDirectory = (session: string) => {
  const directory = path.join(session, ".state", "briefs");
  fs.mkdirSync(directory, { recursive: true });

  return directory;
};

const publishUtilityBrief = (
  ctx: HandlerContext,
  directory: string,
  kind: string,
  text: string,
  details: Record<string, string | number | null>,
  launchNote = ""
) => {
  const file = nextBriefPath(directory, kind);
  fs.writeFileSync(file, text);
  const host = ctx.deps.orchestrator?.platform;
  const launch = utilityLaunchValues(ctx.deps.skillRoot, host);
  // NOTE: an unresolved launch stays null, so the note only decorates a resolved one.
  const note = launch.launchAs === null ? "" : launchNote;
  const bytes = Buffer.byteLength(text);

  const value = {
    briefPath: file,
    bytes,
    ...details,
    ...launch,
    launchAs: launch.launchAs === null ? null : `${launch.launchAs}${note}`,
  };

  return {
    ok: true,
    exit: 0,
    value,
    summary: capSummary(
      `${briefSummary(`${kind} brief`, host, launch, file, bytes)}${note}`
    ),
  };
};

/** Validates a parsed brief values object; an unknown, missing or blank value refuses before anything is written. */
const validateValues = <
  const Req extends string,
  const Opt extends string = never,
>(
  parsed: unknown,
  required: readonly Req[],
  optional: readonly Opt[] = []
) => {
  if (!isRecord(parsed)) {
    throw new ToolError(
      1,
      "invalid-input",
      "Values payload must hold a JSON object"
    );
  }

  const allowed = new Set<string>([...required, ...optional]);

  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      throw new ToolError(1, "invalid-input", `Unknown value ${key}`);
    }
  }

  const out: Record<string, string> = {};

  for (const key of [...required, ...optional]) {
    const value = parsed[key];

    if (value === undefined) {
      // SAFETY: Req extends string so readonly Req[] widens element-wise; the assertion only widens the element type for includes.
      if ((required as readonly string[]).includes(key)) {
        throw new ToolError(1, "invalid-input", `Missing value ${key}`);
      }

      continue;
    }

    if (key === "questions" && Array.isArray(value)) {
      if (
        value.length === 0 ||
        !value.every((q) => typeof q === "string" && q.trim() !== "")
      ) {
        throw new ToolError(1, "invalid-input", `Malformed value ${key}`);
      }

      // oxlint-disable-next-line typescript/no-base-to-string -- array elements are runtime-validated strings; join renders their text.
      out[key] = value.join("\n");
    } else if (typeof value === "string" && value.trim()) {
      out[key] = value;
    } else {
      throw new ToolError(1, "invalid-input", `Malformed value ${key}`);
    }
  }

  // The loop above refused every missing or malformed value; this only carries that proof into the type.
  const isComplete = (
    values: typeof out
  ): values is typeof out &
    Record<Req, string> &
    Partial<Record<Opt, string>> => required.every((key) => key in values);

  if (!isComplete(out)) {
    throw new ToolError(1, "invalid-input", "Missing value");
  }

  return out;
};

export const renderBrief = async (ctx: HandlerContext) => {
  const [task] = ctx.args;

  if (ctx.args.length !== 1 || task === undefined) {
    throw new ToolError(1, "invalid-input", "One task ID is required");
  }

  const gated = await withLedger(
    ctx.session,
    "brief render",
    ctx.deps,
    async (tx) => {
      const bind = latest(tx.fold, "bind");
      const snapshot = currentSnapshot(ctx.manifest.repositoryRoot, bind);
      const decision = gate(tx.fold, snapshot.hashes);

      if (!decision.allowed) {
        throw new ToolError(4, decision.reason, decision.reason);
      }

      const source = snapshot.bytes.plan;

      if (
        !bind ||
        source === null ||
        source === undefined ||
        (snapshot.bytes.spec ?? null) === null
      ) {
        throw new ToolError(
          4,
          "lint-errors",
          "Bound spec and plan must be readable"
        );
      }

      const parsed = parsePlan(source);

      if (!parsed.ok) {
        throw new ToolError(4, "lint-errors", JSON.stringify(parsed.defects));
      }

      const selected = selectTaskBrief(parsed.plan, task);

      if (!selected) {
        throw new ToolError(1, "invalid-input", `Unknown task ${task}`);
      }

      const launch = launches(tx.fold, task).at(-1);

      if (!launch || launch.finished || launch.abandoned || launch.superseded) {
        throw new ToolError(4, "no-open-launch", `No open launch for ${task}`);
      }

      await ctx.deps.hook?.("brief:after-gate");
      const recorded: unknown = latest(tx.fold, "level")?.data["level"];
      const level = isLevel(recorded) ? recorded : "medium";

      return {
        bind,
        snapshot,
        launch,
        source,
        parsed,
        selected,
        level,
        postFold: tx.fold,
      };
    }
  );

  const { bind, snapshot, launch, source, parsed, selected, level, postFold } =
    gated;

  const { section, criteria } = taskParts(source, selected);

  const worktree = path.resolve(
    ctx.session,
    textValue(launch.record.data["path"])
  );

  const reportPath = path.join(
    ctx.session,
    ".state",
    "briefs",
    `${task}-${launch.launch}.report.md`
  );

  const redLogDir = path.join(
    ctx.session,
    ".state",
    "briefs",
    `${task}-${launch.launch}.red`
  );

  const templates = path.join(ctx.deps.skillRoot, "references", "templates");
  const quality = briefQuality(ctx.deps.skillRoot, "writer");

  const slots = {
    task,
    worktree,
    specPath: path.resolve(
      ctx.manifest.repositoryRoot,
      textValue(bind.data["spec"])
    ),
    specHash: textValue(snapshot.hashes.spec),
    planPath: path.resolve(
      ctx.manifest.repositoryRoot,
      textValue(bind.data["plan"])
    ),
    planHash: textValue(snapshot.hashes.plan),
    design:
      typeof bind.data["design"] === "string" && bind.data["design"] !== ""
        ? `Governing design: \`${path.resolve(
            ctx.manifest.repositoryRoot,
            textValue(bind.data["design"])
          )}\` (governed hash ${snapshot.hashes.design}).`
        : "",
    shared: parsed.plan.sharedContext,
    section,
    criteria,
    quality,
    explorer: explorerText(ctx.deps.skillRoot, ctx.deps.orchestrator?.platform),
    reportPath,
    redLogDir,
    redCapture: renderRedCapture(selected, task, worktree, redLogDir),
    contracts: present(
      checks(parsed.plan).find((check) => check.criterion === "contract"),
      "contract checks"
    )
      .commands.map((command) => `- \`${command}\``)
      .join("\n"),
  };

  const text = fillSlots(
    "writer",
    fs.readFileSync(path.join(templates, "writer-brief.md"), "utf-8"),
    slots
  );

  const directory = prepareBriefDirectory(ctx.session);
  const file = path.join(directory, `${task}-${launch.launch}.md`);
  fs.writeFileSync(file, text);

  const writerValues = writerLaunchValues(
    ctx.deps.skillRoot,
    ctx.deps.orchestrator?.platform,
    level
  );

  const value = {
    path: file,
    task,
    launch: launch.launch,
    bytes: Buffer.byteLength(text),
    ...writerValues,
  };

  return {
    ok: true,
    exit: 0,
    value,
    summary: briefSummary(
      `${task} launch ${launch.launch}`,
      ctx.deps.orchestrator?.platform,
      writerValues,
      file,
      value.bytes
    ),
    postFold,
  };
};

const selectExplorerKind = (text: string, kind: "map" | "research") => {
  const other = kind === "map" ? "research" : "map";

  return text
    .replaceAll(
      new RegExp(
        `<!--\\s*kind:\\s*${other}\\s*-->[\\s\\S]*?<!--\\s*/kind:\\s*${other}\\s*-->\\r?\\n?`,
        "gu"
      ),
      ""
    )
    .replaceAll(
      new RegExp(`<!--\\s*/?kind:\\s*${kind}\\s*-->\\r?\\n?`, "gu"),
      ""
    );
};

const EXPLORER_REQUIRED_VALUES = ["objective", "questions"] as const;
const EXPLORER_OPTIONAL_VALUES = ["outputPath"] as const;
const TEST_CLEANUP_VALUES = ["base", "integrationPath"] as const;

// NOTE: Antigravity map explorers write the map file, so they need the write-capable `self` type.
const AGY_MAP_SELF_NOTE =
  "; TypeName: self (write-capable; the map explorer writes its file)";

// oxlint-disable-next-line eslint/require-await -- handler signature requires async; this brief builds synchronously.
export const renderExplorerBrief = async (ctx: HandlerContext) => {
  const values = validateValues(
    readJsonPayload(ctx, {
      positional: "values",
      inlineFlag: "json",
      label: "explorer values",
    }),
    EXPLORER_REQUIRED_VALUES,
    EXPLORER_OPTIONAL_VALUES
  );

  const kind =
    values.outputPath !== undefined && values.outputPath !== ""
      ? "map"
      : "research";

  const templates = path.join(ctx.deps.skillRoot, "references", "templates");

  const entry = resolveHostUtility(
    ctx.deps.skillRoot,
    ctx.deps.orchestrator?.platform
  );

  const contextLimit = entry ? entry.contextLimit : null;

  const limit = entry
    ? `${entry.contextLimit.toLocaleString("en-US")} tokens`
    : "utility entry not configured; the orchestrator reports a blocker";

  // 75% margin: an explorer cannot count the tokens its tool output and reasoning add.
  const splitAt = entry
    ? `${Math.floor(entry.contextLimit * 0.75).toLocaleString("en-US")} tokens`
    : limit;

  const writesMap =
    kind === "map" &&
    normalizeProvider(ctx.deps.orchestrator?.platform ?? "") === "agy";

  const mapNote = writesMap ? AGY_MAP_SELF_NOTE : "";

  const nestedLaunch = entry
    ? `${launchLine(
        ctx.deps.orchestrator?.platform ?? "",
        entry.models,
        entry.effort
      )}${mapNote}`
    : "utility entry not configured; the orchestrator reports a blocker";

  const templateText = fs.readFileSync(
    path.join(templates, "explorer-brief.md"),
    "utf-8"
  );

  const kindTemplate = selectExplorerKind(templateText, kind);

  const slots = {
    objective: values.objective,
    questions: values.questions,
    limit,
    splitAt,
    nestedLaunch,
    quality: briefQuality(ctx.deps.skillRoot, "explorer"),
    ...(values.outputPath !== undefined && values.outputPath !== ""
      ? {
          outputPath: values.outputPath,
          cliPath: path.join(ctx.deps.skillRoot, "scripts", "dispatch.ts"),
          session: ctx.session,
          mapBudget: DEFAULT_MAP_BUDGET.toLocaleString("en-US"),
          contextMapTemplate: fs.readFileSync(
            path.join(templates, "context-map.md"),
            "utf-8"
          ),
        }
      : {
          replyLimit: DEFAULT_RESEARCH_REPLY_LIMIT.toLocaleString("en-US"),
        }),
  };

  const text = fillSlots("explorer", kindTemplate, slots);
  assertFilled("explorer", text);
  const directory = prepareBriefDirectory(ctx.session);

  return publishUtilityBrief(
    ctx,
    directory,
    "explorer",
    text,
    { kind, contextLimit },
    mapNote
  );
};

// oxlint-disable-next-line eslint/require-await -- handler signature requires async; this brief builds synchronously.
export const renderTestCleanupBrief = async (ctx: HandlerContext) => {
  const values = validateValues(
    readJsonPayload(ctx, {
      positional: "values",
      inlineFlag: "json",
      direct: [
        { flag: "base", key: "base" },
        { flag: "integration-path", key: "integrationPath" },
      ],
      label: "test-cleanup values",
    }),
    TEST_CLEANUP_VALUES
  );

  const fold = foldLedger(ctx.session);
  const bind = latest(fold, "bind");

  if (
    !bind ||
    typeof bind.data["plan"] !== "string" ||
    !bind.data["plan"].trim()
  ) {
    throw new ToolError(4, "lint-errors", "No bound plan");
  }

  const templates = path.join(ctx.deps.skillRoot, "references", "templates");

  const slots = {
    base: values.base,
    integrationPath: values.integrationPath,
    planPath: path.resolve(ctx.manifest.repositoryRoot, bind.data["plan"]),
    quality: briefQuality(ctx.deps.skillRoot, "cleanup"),
  };

  const text = fillSlots(
    "test-cleanup",
    fs.readFileSync(path.join(templates, "test-cleanup-brief.md"), "utf-8"),
    slots
  );

  assertFilled("test-cleanup", text);
  const directory = prepareBriefDirectory(ctx.session);

  return {
    ...publishUtilityBrief(ctx, directory, "test-cleanup", text, {}),
    postFold: fold,
  };
};

const VERIFIER_VALUES = ["checkoutPath", "base", "specPath", "focus"] as const;

// oxlint-disable-next-line eslint/require-await -- handler signature requires async; this brief builds synchronously.
export const renderVerifierBrief = async (ctx: HandlerContext) => {
  const values = validateValues(
    readJsonPayload(ctx, {
      positional: "values",
      inlineFlag: "json",
      label: "verifier values",
    }),
    VERIFIER_VALUES
  );

  const templates = path.join(ctx.deps.skillRoot, "references", "templates");
  const evidenceDir = path.join(ctx.session, "verification");

  const text = fillSlots(
    "verifier",
    fs.readFileSync(path.join(templates, "verifier-brief.md"), "utf-8"),
    {
      ...values,
      evidenceDir,
      quality: briefQuality(ctx.deps.skillRoot, "verifier"),
    }
  );

  assertFilled("verifier", text);
  const directory = prepareBriefDirectory(ctx.session);
  fs.mkdirSync(evidenceDir, { recursive: true });

  return publishUtilityBrief(ctx, directory, "verifier", text, { evidenceDir });
};
