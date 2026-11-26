import fs from "node:fs";
import path from "node:path";

import {
  CONFIG_CANDIDATES,
  HINT,
  loadConfig,
  validateConfig,
} from "../lib/config.ts";
import { checkIntegrity } from "../lib/integrity.ts";
import { launchLine } from "../lib/platform.ts";
import type { ProviderKey } from "../lib/platform.ts";
import { pricingProblems } from "../lib/pricing.ts";
import {
  normalizeProvider,
  resolveLevel,
  resolveRoster,
  resolveSubagent,
  resolveUtility,
} from "../policy/roster.ts";
import type {
  ReadDelegate,
  ResolvedSubagent,
  ResolvedUtility,
} from "../policy/roster.ts";
import { SPECS, isProviderId } from "../providers/index.ts";
import { probeProviders } from "../providers/probe.ts";
import type { ProbeDeps } from "../providers/probe.ts";
import { foldLedger, latest } from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import {
  isLevel,
  isReadDelegateTable,
  isUtilityTable,
  isWriterTable,
  present,
} from "./narrow.ts";
import { ToolError } from "./output.ts";

const withLaunch = <T extends ResolvedSubagent>(
  platform: string,
  entry: T
) => ({
  ...entry,
  launchAs: launchLine(platform, entry.models, entry.effort),
});

// oxlint-disable-next-line eslint/complexity -- doctor branches per level validity, platform capability table, and integrity drift.
const readDoctor = (
  session: string,
  skillRoot: string,
  requested: unknown,
  host: ProviderKey | null,
  liveness?: Readonly<Record<string, boolean>>,
  sandboxSupported?: Readonly<Record<string, boolean>>,
  fold?: Fold
) => {
  if (requested !== undefined && !isLevel(requested)) {
    throw new ToolError(
      1,
      "invalid-input",
      "level must be low, medium, high, xhigh or max"
    );
  }

  const recorded: unknown =
    requested ?? latest(fold ?? foldLedger(session), "level")?.data["level"];

  const level = isLevel(recorded) ? recorded : "medium";
  const integrity = checkIntegrity(skillRoot);

  let configPath =
    CONFIG_CANDIDATES.map((name) => path.join(skillRoot, name)).find((file) =>
      fs.existsSync(file)
    ) ?? null;

  let problems: string[];
  let warnings: string[] = [];
  const writers: Record<string, ResolvedSubagent & { launchAs: string }> = {};
  const utility: Record<string, ResolvedUtility & { launchAs: string }> = {};

  let sandboxRemoved: string[] = [];
  let writeConcurrency = 1;

  let readDelegates: Readonly<Record<string, ReadDelegate>> = {};

  try {
    const loaded = loadConfig(skillRoot);
    configPath = loaded.path;
    problems = validateConfig(loaded.config);
    warnings = pricingProblems(loaded.config["pricing"]);

    if (!problems.length) {
      const concurrency = loaded.config["write-concurrency"];
      writeConcurrency = typeof concurrency === "number" ? concurrency : 1;
      const writerSection = loaded.config["write-subagents"];

      for (const [platform, levels] of Object.entries(
        isWriterTable(writerSection) ? writerSection : {}
      )) {
        const canonical = normalizeProvider(platform);
        writers[canonical] = withLaunch(
          canonical,
          resolveSubagent(
            present(
              // oxlint-disable-next-line typescript/no-unsafe-argument -- writer levels originate from untyped config JSON; resolveLevel tolerates absent levels and present() reports the fault.
              resolveLevel(levels, level),
              `write-subagents.${platform} level entry`
            )
          )
        );
      }

      const utilitySection = loaded.config["utility-subagents"];

      for (const [platform, entry] of Object.entries(
        resolveUtility(isUtilityTable(utilitySection) ? utilitySection : {})
      )) {
        utility[platform] = withLaunch(platform, entry);
      }

      if (host && !utility[normalizeProvider(host)]) {
        problems.push(
          `Missing required entry "utility-subagents.${host}" (${HINT}).`
        );
      }

      if (host && !writers[normalizeProvider(host)]) {
        problems.push(
          `Missing required entry "write-subagents.${host}" (${HINT}).`
        );
      }

      const readSection: unknown = loaded.config["read-delegates"];
      readDelegates = present(
        isReadDelegateTable(readSection) ? readSection : undefined,
        "read-delegates table"
      );
      sandboxRemoved =
        resolveRoster({
          level,
          readDelegates,
          orchestrator: host ? { platform: host } : null,
          ...(liveness && { liveness }),
          ...(sandboxSupported && { sandboxSupported }),
        }).underfill?.sandboxUnsupported ?? [];
    }
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }

  let reason: string | undefined;

  if (integrity.status === "drift") {
    reason = "integrity-drift";
  } else if (problems.length > 0) {
    reason = "config-invalid";
  } else {
    reason = undefined;
  }

  const report = {
    ok: reason === undefined,
    ...(reason !== undefined && reason !== "" && { reason }),
    host: { platform: host, source: host ? "declared" : "none" },
    integrity,
    config: { path: configPath, problems, warnings },
    level,
    writers,
    utility,
    sandboxRemoved,
    writeConcurrency,
  };

  return { report, readDelegates };
};

export const doctorReport = (
  session: string,
  skillRoot: string,
  requested?: unknown,
  host: ProviderKey | null = null,
  liveness?: Readonly<Record<string, boolean>>,
  sandboxSupported?: Readonly<Record<string, boolean>>,
  fold?: Fold
) =>
  readDoctor(
    session,
    skillRoot,
    requested,
    host,
    liveness,
    sandboxSupported,
    fold
  ).report;

export const doctorReportWithProbe = async (
  session: string,
  skillRoot: string,
  requested?: unknown,
  host: ProviderKey | null = null,
  liveness?: Readonly<Record<string, boolean>>,
  sandboxSupported?: Readonly<Record<string, boolean>>,
  fold?: Fold,
  probeDeps?: ProbeDeps
) => {
  const { report, readDelegates } = readDoctor(
    session,
    skillRoot,
    requested,
    host,
    liveness,
    sandboxSupported,
    fold
  );

  if (report.config.problems.length) {
    return report;
  }

  const targets = Object.entries(readDelegates).flatMap(([key, delegate]) => {
    const provider = normalizeProvider(key);

    return isProviderId(provider)
      ? [
          {
            provider,
            sandboxRequired:
              delegate.sandbox !== false &&
              SPECS[provider].sandbox !== undefined,
          },
        ]
      : [];
  });

  const probe = await probeProviders(targets, probeDeps);

  return {
    ...report,
    ...probe,
    ...(probe.probeSummary.failed && { ok: false, reason: "probe-failed" }),
  };
};
