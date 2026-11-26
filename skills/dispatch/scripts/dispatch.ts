import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseCommand, SESSION_ACTIONS, UsageError } from "./lib/cli.ts";
import { reprobeQuota } from "./lib/quota-store.ts";
import {
  AmbiguousSessionIdentityError,
  findRepoRoot,
  initSession,
  platformSessionId,
  reactivateSession,
  recordHost,
} from "./lib/session.ts";
import { H } from "./policy/quota.ts";
import { normalizeProvider } from "./policy/roster.ts";
import { SPECS, isProviderId } from "./providers/index.ts";
import { main as toolkitMain, nodeDeps } from "./toolkit/cli.ts";
import type { CliDeps } from "./toolkit/cli.ts";
import { renderCallTable, stripGeneratedMarkers } from "./toolkit/contracts.ts";
import { diagnosticInstructions } from "./toolkit/diagnostics-capture.ts";
import { capSummary } from "./toolkit/output.ts";

const GROUNDING_INSTRUCTIONS =
  "When a verb needs a new spec, run `doctor run --host <platform>` and ground under references/grounding.md before authoring the spec; after confirming it, ground again before design or plan authoring. Launch explorers on doctor's `utility` entry for this platform; self-ground only when the host has no launch tool or no map survives recovery.";

const printHelp = (heading: string, deps: EntryDeps) => {
  const fail = (summary: string, reason: string, exit: number) => {
    deps.stdout(
      `${JSON.stringify({
        ok: false,
        summary: capSummary(summary),
        path: null,
        reason,
      })}\n`
    );

    return exit;
  };

  const key = heading.toLowerCase();

  if (key === "call table") {
    deps.stdout(renderCallTable());

    return 0;
  }

  let lines: string[];

  try {
    lines = stripGeneratedMarkers(
      fs.readFileSync(
        path.join(deps.skillRoot, "references", "toolkit.md"),
        "utf-8"
      )
    ).split(/\r?\n/u);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      "fault",
      2
    );
  }

  const start = key
    ? lines.findIndex(
        (line) =>
          line.toLowerCase() === `## ${key}` ||
          line.toLowerCase() === `### ${key}`
      )
    : -1;

  if (start === -1) {
    return fail(
      `Unknown or empty heading; valid headings: ${lines
        .filter((line) => /^#{2,3} /u.test(line))
        .map((line) => line.replace(/^#{2,3} /u, ""))
        .join(", ")}`,
      "usage",
      1
    );
  }

  const stop =
    lines[start]?.startsWith("## ") === true ? /^#{1,2} /u : /^#{1,3} /u;

  const end = lines.findIndex(
    (line, index) => index > start && stop.test(line)
  );

  deps.stdout(
    `${lines
      .slice(start, end === -1 ? lines.length : end)
      .join("\n")
      .trimEnd()}\n`
  );

  return 0;
};

type EntryDeps = CliDeps & { cwd?: () => string };

type SessionReply =
  | {
      v: 1;
      action: "quota-reprobe";
      key: ReturnType<typeof reprobeQuota>["key"];
      appliesTo: "future-waves";
    }
  | {
      ok: boolean;
      summary: string;
      path: string | null;
      reused?: boolean;
      instructions?: string;
      reason?: string;
      help?: string;
      candidates?: string[];
      candidateCount?: number;
      omitted?: number;
    };

export const main = async (
  argv: readonly string[] = process.argv.slice(2),
  deps: EntryDeps = nodeDeps()
) => {
  if (argv[0] === "help") {
    const words = argv
      .slice(1)
      .filter(
        (arg, index, rest) =>
          !arg.startsWith("--") && rest[index - 1]?.startsWith("--") !== true
      );

    return printHelp(words.join(" ").trim(), deps);
  }

  if (argv[0] !== "session") {
    return await toolkitMain([...argv], deps);
  }

  const print = (value: SessionReply) => {
    deps.stdout(`${JSON.stringify(value)}\n`);
  };

  try {
    const command = parseCommand(argv);

    if (
      // SAFETY: SESSION_ACTIONS is a fixed tuple of literals; widening to readonly string[] for includes.
      !(SESSION_ACTIONS as readonly string[]).includes(command.action ?? "")
    ) {
      throw new UsageError(
        `session requires ${SESSION_ACTIONS.slice(0, -1).join(
          ", "
        )}, or ${SESSION_ACTIONS.at(-1)}`
      );
    }

    const flag = (name: string) => command.flags[name];

    const required = (name: string) => {
      const value = flag(name);

      if (value === undefined) {
        throw new UsageError(`--${name} is required`);
      }

      return value;
    };

    const repo = findRepoRoot(deps.cwd ? deps.cwd() : process.cwd());

    if (repo === null) {
      throw new UsageError("session requires a Git repository");
    }

    if (command.action === "quota-reprobe") {
      const runQuotaReprobe = () => {
        const provider = required("provider");
        const mode = required("mode");

        if (!isProviderId(provider)) {
          throw new UsageError("Unknown --provider");
        }

        if (!SPECS[provider].modes.some((entry) => entry.id === mode)) {
          throw new UsageError("Unknown --mode for provider");
        }

        const key = { provider, model: flag("model") ?? null, mode };
        let result;

        try {
          result = reprobeQuota(
            {
              sessionDir: path.resolve(required("session-dir")),
              repositoryRoot: repo,
              bucketWidth: H,
            },
            key
          );
        } catch (error) {
          if (
            error instanceof Error &&
            ([
              "Linked quota path",
              "Invalid quota key or bucket width",
              "Quota session ownership mismatch",
            ].includes(error.message) ||
              /^Session manifest (?:is missing or invalid|has an unsupported or unsafe identity): /u.test(
                error.message
              ))
          ) {
            throw new UsageError(error.message);
          }

          throw error;
        }

        print({
          v: 1,
          action: "quota-reprobe",
          key: result.key,
          appliesTo: "future-waves",
        });

        return 0;
      };

      return runQuotaReprobe();
    }

    const runSessionCommand = () => {
      const host = normalizeProvider(required("host"));

      if (!isProviderId(host)) {
        throw new UsageError(
          `Unknown --host; use ${Object.keys(SPECS).join(", ")}`
        );
      }

      const session =
        command.action === "init"
          ? initSession({
              repositoryRoot: repo,
              sessionId:
                flag("session-id") ??
                platformSessionId((name) => deps.env[name]) ??
                crypto.randomUUID(),
              sessionTitle: required("objective"),
              now: new Date(deps.clock()),
            })
          : {
              path: reactivateSession(
                path.resolve(required("session-dir")),
                repo
              ),
              reused: true,
            };

      recordHost(session.path, host);
      const diagnostics = diagnosticInstructions(deps.skillRoot).instructions;

      print({
        ok: true,
        summary: capSummary(`Session ${command.action} complete`),
        path: session.path,
        reused: session.reused,
        instructions:
          diagnostics === undefined || diagnostics === ""
            ? GROUNDING_INSTRUCTIONS
            : `${GROUNDING_INSTRUCTIONS} ${diagnostics}`,
      });

      return 0;
    };

    return runSessionCommand();
  } catch (error) {
    if (error instanceof AmbiguousSessionIdentityError) {
      const candidates: string[] = [];

      for (const candidate of error.candidates.slice(0, 5)) {
        if (
          Buffer.byteLength(JSON.stringify([...candidates, candidate])) > 1024
        ) {
          break;
        }

        candidates.push(candidate);
      }

      const candidateCount = error.candidates.length;
      print({
        ok: false,
        summary: capSummary(error.message),
        path: null,
        reason: "fault",
        help: "session reactivate",
        candidates,
        candidateCount,
        omitted: candidateCount - candidates.length,
      });

      return 2;
    }

    const usage = error instanceof UsageError;
    print({
      ok: false,
      summary: capSummary(
        error instanceof Error ? error.message : String(error)
      ),
      path: null,
      reason: usage ? "usage" : "fault",
      // SAFETY: SESSION_ACTIONS is a fixed tuple of literals; widening to readonly string[] for includes.
      help: (SESSION_ACTIONS as readonly string[]).includes(argv[1] ?? "")
        ? `session ${argv[1]}`
        : "call table",
    });

    return usage ? 1 : 2;
  }
};

export const isEntry = (
  argvPath: string | undefined,
  realpath: (file: string) => string = fs.realpathSync,
  moduleUrl = import.meta.url
) =>
  argvPath !== undefined &&
  argvPath !== "" &&
  pathToFileURL(realpath(path.resolve(argvPath))).href === moduleUrl;

if (isEntry(process.argv[1])) {
  process.exitCode = await main();
}
