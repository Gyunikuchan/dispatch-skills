import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import type {
  JsonObject,
  JsonValue,
} from "../../skills/dispatch/scripts/lib/integrity.ts";
import { normalizeProvider } from "../../skills/dispatch/scripts/policy/roster.ts";
import { artifactHash } from "../../skills/dispatch/scripts/toolkit/artifacts.ts";
import { main } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import type { CliDeps } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import { appendRecord } from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import { jsonValue, readJson } from "../unit/toolkit/helpers/json.ts";
import { isString } from "./guards.ts";
import { memoryNodeFs } from "./memory-node-fs.ts";

export const CLEAN = JSON.stringify({ status: "CLEAN", findings: [] });

const RATING = {
  MUST: { impact: "blocks", trigger: "realistic" },
  SHOULD: { impact: "degrades", trigger: "realistic" },
  CONSIDER: { impact: "minor", trigger: "contrived" },
} as const;

const isRated = (severity: string): severity is keyof typeof RATING =>
  Object.hasOwn(RATING, severity);

const ratingFor = (severity: string) =>
  isRated(severity) ? RATING[severity] : undefined;

export const report = (
  locus = "§ Work",
  defect = "Concurrent writes overwrite captured results",
  severity = "SHOULD"
) =>
  JSON.stringify({
    status: "FINDINGS",
    findings: [
      {
        ...ratingFor(severity),
        tag: "reliability",
        locus,
        defect,
        requiredChange: "Keep writes isolated until finalization",
      },
    ],
  });

export const CONTEXT_MAP =
  "# Context map: work\n\n> **Commit:** abc123\n>\n> **Tool:** text\n\n## Map\n- Work — `work.plan.md:1`\n";

const templates = [
  "review-prompt.md",
  "review-prompt-plan.md",
  "review-prompt-design.md",
  "review-prompt-code.md",
  "quality-bar.md",
  "review-severity.md",
].map(
  (file) =>
    [
      file,
      fs.readFileSync(
        path.resolve("skills/dispatch/references/templates", file),
        "utf-8"
      ),
    ] as const
);

interface CliOutput {
  ok: boolean;
  summary: string;
  path: string | null;
  reason?: string;
}

const isCliOutput = (value: unknown): value is CliOutput =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  typeof value.ok === "boolean" &&
  "summary" in value &&
  typeof value.summary === "string" &&
  "path" in value &&
  (value.path === null || typeof value.path === "string") &&
  (!("reason" in value) || typeof value.reason === "string");

const isManifestHost = <T>(value: T): value is T & { host: unknown } =>
  typeof value === "object" && value !== null && "host" in value;

const tryReadJson = (file: string) => {
  try {
    return parseJson(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
};

const tryNormalize = (host: string) => {
  try {
    return normalizeProvider(host);
  } catch {
    return null;
  }
};

export const fixture = async (bound = true, confirmed = true) => {
  // A shallow virtual root avoids physical ancestor probes in quota-path validation.
  const root = path.join(
    path.parse(os.tmpdir()).root,
    `review-${crypto.randomUUID()}`
  );

  const cleanup = memoryNodeFs(root);

  const session = path.join(
    root,
    ".scratch/dispatch-skills/20261023T0000Z-test"
  );

  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(
    path.join(session, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      folderName: path.basename(session),
      sessionId: "test",
      safeSessionId: "test",
      repositoryRoot: fs.realpathSync(root),
    })
  );

  const lines: string[] = [];

  const launches: {
    provider: Parameters<CliDeps["delegate"]>[0];
    request: Parameters<CliDeps["delegate"]>[1];
    mode: Parameters<CliDeps["delegate"]>[2];
  }[] = [];

  const deps: CliDeps = {
    run: async () =>
      await Promise.reject(new Error("Unit tests must not spawn processes")),
    delegate: async () =>
      await Promise.reject(new Error("Unscripted delegate")),
    modes: () => ["cli"],
    orchestrator: null,
    liveness: {
      claude: true,
      agy: true,
      codex: true,
      copilot: true,
      opencode: true,
    },
    stdout: (line) => {
      lines.push(line);
    },
    env: {},
    clock: () => 0,
    sleep: async () => {
      await Promise.resolve();
    },
    pid: 42,
    host: "test-host",
    isAlive: () => false,
    skillRoot: path.resolve("skills/dispatch"),
  };

  const f = {
    root,
    session,
    lines,
    launches,
    deps,
    cleanup,
    artifact: (name: string, source: string) => {
      const file = path.join(root, name);
      fs.writeFileSync(file, source);

      return file;
    },
    output: () => {
      assert.equal(lines.length, 1);
      const value: unknown = JSON.parse(lines[0] ?? "");
      assert.ok(isCliOutput(value), "unexpected CLI output shape");

      return value;
    },
  };

  const skill = path.join(f.root, "skill");
  fs.mkdirSync(path.join(skill, "references/templates"), { recursive: true });

  for (const [file, source] of templates) {
    fs.writeFileSync(path.join(skill, "references/templates", file), source);
  }

  fs.copyFileSync(
    path.resolve("skills/dispatch/references/spec-stage.md"),
    path.join(skill, "references/spec-stage.md")
  );
  f.deps.skillRoot = skill;

  const config = (native = false) => {
    fs.writeFileSync(
      path.join(skill, "config.jsonc"),
      JSON.stringify({
        "read-delegates": native
          ? {
              codex: {
                nativeSubagentsOnly: true,
                targets: [{ low: { model: "native" } }],
              },
            }
          : {
              claude: { targets: [{ low: { model: "fake" } }] },
              agy: { targets: [{ low: { model: "fake" } }] },
            },
        phases: {
          "plan-review": {
            targets: { low: 0, medium: 2 },
            rounds: { low: 0, medium: 2 },
          },
          "code-review": { targets: { low: 2 }, rounds: { low: 2 } },
        },
      })
    );
  };

  config();

  const spec = f.artifact(
    "mission.spec.md",
    "# Mission\n## Intent & Problem\nKeep captured work recoverable.\n## Requirements\n### REQ-1 — Works\n"
  );

  const plan = f.artifact(
    "work.plan.md",
    "# Work\n## Work\nOriginal body.\n## Review Findings & Resolutions\nDriver log.\n"
  );

  f.artifact("work.plan.context.md", CONTEXT_MAP);
  let key = 0;

  const add = async (kind: string, data: JsonObject) => {
    const current = key;
    key += 1;

    return await appendRecord(
      f.session,
      { kind, by: "orchestrator", key: `input-${current}`, data },
      f.deps
    );
  };

  if (bound) {
    await add("bind", { spec: "mission.spec.md", plan: "work.plan.md" });
  }

  const confirm = async (specPath = spec) => {
    const current = key;
    key += 1;

    return await appendRecord(
      f.session,
      {
        kind: "confirm",
        by: "user",
        quote: "Approved",
        key: `confirm:${current}`,
        data: {
          spec: artifactHash("spec", fs.readFileSync(specPath, "utf-8")),
        },
      },
      f.deps
    );
  };

  if (confirmed) {
    await confirm();
  }

  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({ provider, request, mode });

    return await Promise.resolve({
      outcome: { status: "ok", text: report(), resume: null, sessionId: null },
      invocations: [],
    });
  };

  const call = async (kind = "plan", target = plan, level = "medium") => {
    f.lines.length = 0;

    const host = (() => {
      // SAFETY: fixture orchestrator is null or a stub carrying platform; the cast narrows a known test stub.
      const platform = (f.deps.orchestrator as { platform: string } | null)
        ?.platform;

      if (isString(platform) && platform !== "") {
        return normalizeProvider(platform);
      }

      const manifest: JsonValue | null = tryReadJson(
        path.join(f.session, "manifest.json")
      );

      if (
        isManifestHost(manifest) &&
        isString(manifest.host) &&
        manifest.host !== ""
      ) {
        const fromManifest = tryNormalize(manifest.host);

        if (fromManifest !== null) {
          return fromManifest;
        }
      }

      /* NOTE: an unreadable manifest falls back to the config-derived host. */
      const fileConfig: JsonValue | null = tryReadJson(
        path.join(f.deps.skillRoot, "config.jsonc")
      );

      try {
        assert.ok(fileConfig instanceof Object);

        const delegates =
          "read-delegates" in fileConfig
            ? fileConfig["read-delegates"]
            : undefined;

        const present = new Set(
          Object.keys(delegates ?? {}).map((delegateName) =>
            normalizeProvider(delegateName)
          )
        );

        return (
          ["opencode", "claude", "agy", "copilot", "codex"].find(
            (candidate) => !present.has(candidate)
          ) ?? "opencode"
        );
      } catch {
        return "opencode";
      }
    })();

    const exit = await main(
      [
        "review",
        "run",
        target,
        "--kind",
        kind,
        "--level",
        level,
        "--session",
        f.session,
        "--host",
        host,
      ],
      f.deps
    );

    const output = f.output();

    return {
      exit,
      output,
      value:
        output.path !== null && output.path !== ""
          ? readJson(output.path, jsonValue)
          : null,
    };
  };

  const directory = path.join(f.session, ".state/reviews/plan-work.plan");

  const read = (round: number, file: string) =>
    readJson(path.join(directory, `round-${round}`, file), jsonValue);

  return { ...f, spec, plan, add, call, confirm, directory, read, config };
};
