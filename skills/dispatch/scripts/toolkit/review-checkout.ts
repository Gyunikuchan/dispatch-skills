import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import type { CliDeps } from "./cli.ts";
import { atomic } from "./fanout/state.ts";
import type { RepositoryChange, RepositoryCheckState } from "./findings.ts";
import { git, splitPaths } from "./git.ts";
import { foldLedger } from "./ledger.ts";
import { textValue } from "./narrow.ts";
import { reviewGenerationDirectory } from "./review-state.ts";
import { launches } from "./writers.ts";

type CheckoutEntryMap = Record<string, string>;

interface CheckoutState {
  cwd: string;
  head: string;
  entries: CheckoutEntryMap;
}

interface CheckoutBaseline {
  checkouts: CheckoutState[];
}

interface UnavailableBaseline {
  state: "unavailable";
  reason: string;
}

export type CheckoutBaselineFile = CheckoutBaseline | UnavailableBaseline;

interface CheckoutReport {
  repositoryChanges?: RepositoryChange[];
  repositoryCheck?: RepositoryCheckState;
  asOfSeq?: number;
}

interface Fingerprint {
  exec: string;
  fingerprint: string;
}

interface StoredEntry {
  raw: string;
  fingerprint: string;
}

interface ComparedDirs {
  dirs: string[];
  absentWorktree: boolean;
}

const isUnavailableBaseline = (
  baseline: CheckoutBaselineFile
): baseline is UnavailableBaseline =>
  "state" in baseline && baseline.state === "unavailable";

const isCheckoutState = (value: unknown): value is CheckoutState =>
  isRecord(value) &&
  typeof value["cwd"] === "string" &&
  typeof value["head"] === "string" &&
  isRecord(value["entries"]) &&
  Object.values(value["entries"]).every((entry) => typeof entry === "string");

const isCheckoutBaseline = (value: unknown): value is CheckoutBaseline =>
  isRecord(value) &&
  Array.isArray(value["checkouts"]) &&
  value["checkouts"].every(isCheckoutState);

const UNAVAILABLE = (reason: string): RepositoryCheckState => ({
  state: "unavailable",
  reason,
});

const hashFileContents = (full: string) => {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(full, "r");

  try {
    const chunk = Buffer.alloc(64 * 1024);

    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);

      if (read <= 0) {
        break;
      }

      hash.update(chunk.subarray(0, read));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      void 0;
    }
  }

  return hash.digest("hex");
};

const fingerprintFor = (cwd: string, rel: string): Fingerprint => {
  const full = path.join(cwd, ...rel.split("/"));
  let stat: fs.Stats;

  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { exec: "missing", fingerprint: "deleted" };
    }

    throw error;
  }

  if (stat.isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(full);

      return { exec: "link", fingerprint: `symlink:${target}` };
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return { exec: "link", fingerprint: "deleted" };
      }

      throw error;
    }
  }

  if (stat.isDirectory()) {
    return { exec: "dir", fingerprint: "directory" };
  }

  // oxlint-disable-next-line no-bitwise -- POSIX mode exec-bit mask.
  const exec = (stat.mode & 0o111) === 0 ? "-" : "x";

  if (!stat.isFile()) {
    return { exec, fingerprint: "unsupported" };
  }

  let fingerprint: string;

  try {
    fingerprint = hashFileContents(full);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      fingerprint = "deleted";
    } else {
      throw error;
    }
  }

  return { exec, fingerprint };
};

const sessionPrefix = (cwd: string, sessionDir: string) => {
  const rel = path.relative(cwd, sessionDir);

  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the outside-session and prefix branches.
    return undefined;
  }

  return rel.split(path.sep).join("/");
};

const excludedBySession = (relPath: string, prefix: string | undefined) => {
  if (prefix === undefined || prefix === "") {
    return false;
  }

  return relPath === prefix || relPath.startsWith(`${prefix}/`);
};

const parseStatus = (raw: string) => {
  const out = new Map<string, string>();

  for (const entry of raw.split("\0")) {
    if (!entry) {
      continue;
    }

    if (entry.startsWith("? ")) {
      out.set(entry.slice(2), entry);
      continue;
    }

    if (entry.startsWith("! ")) {
      continue;
    }

    if (entry.startsWith("1 ")) {
      const parts = entry.split(" ");

      if (parts.length >= 9) {
        out.set(parts.slice(8).join(" "), entry);
      }

      continue;
    }

    if (entry.startsWith("2 ")) {
      const parts = entry.split(" ");

      if (parts.length >= 10) {
        out.set(parts.slice(9).join(" "), entry);
      }

      continue;
    }

    if (entry.startsWith("u ")) {
      const parts = entry.split(" ");

      if (parts.length >= 11) {
        out.set(parts.slice(10).join(" "), entry);
      }

      continue;
    }
  }

  return out;
};

const parseFlagged = (raw: string) => {
  const out = new Set<string>();

  for (const entry of raw.split("\0")) {
    if (!entry) {
      continue;
    }

    const [tag] = entry;

    if (tag === undefined || entry[1] !== " ") {
      continue;
    }

    if (tag === tag.toLowerCase() || tag === "S" || tag === "s") {
      out.add(entry.slice(2));
    }
  }

  return out;
};

const isGitlinkDirty = (statusRaw: string, fingerprint: string) => {
  if (fingerprint !== "directory") {
    return false;
  }

  if (!statusRaw.startsWith("1 ")) {
    return false;
  }

  const parts = statusRaw.split(" ");
  const subm = parts[2] ?? "";

  return subm.includes("M") || subm.includes("U");
};

export const captureCheckouts = async (
  deps: CliDeps,
  dirs: readonly string[],
  sessionDir: string
): Promise<CheckoutBaseline> => {
  const checkouts: CheckoutState[] = [];

  for (const cwd of dirs) {
    if (!fs.existsSync(cwd)) {
      throw new Error(`Absent checkout ${cwd}`);
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    const headResult = await git(deps, cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ]);

    if (headResult.exit) {
      throw new Error(`Cannot resolve HEAD in ${cwd}`);
    }

    const head = headResult.stdout.trim();

    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    const statusResult = await git(deps, cwd, [
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "-z",
      "-uall",
      "--no-renames",
      "--ignore-submodules=none",
    ]);

    if (statusResult.exit) {
      throw new Error(`Cannot capture status in ${cwd}`);
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    const flaggedResult = await git(deps, cwd, ["ls-files", "-v", "-z"]);

    if (flaggedResult.exit) {
      throw new Error(`Cannot list index flags in ${cwd}`);
    }

    const statusMap = parseStatus(statusResult.stdout);
    const flagged = parseFlagged(flaggedResult.stdout);
    const prefix = sessionPrefix(path.resolve(cwd), path.resolve(sessionDir));
    const names = new Set([...statusMap.keys(), ...flagged]);
    const entries: CheckoutEntryMap = {};
    Object.setPrototypeOf(entries, null);

    for (const name of [...names].toSorted()) {
      if (excludedBySession(name, prefix)) {
        continue;
      }

      const statusRaw = statusMap.get(name) ?? "";
      const { exec, fingerprint } = fingerprintFor(path.resolve(cwd), name);
      entries[name] = `${statusRaw} ${exec} ${fingerprint}`;
    }

    checkouts.push({ cwd: path.resolve(cwd), head, entries });
  }

  return { checkouts };
};

const diffEntries = (baseline: CheckoutEntryMap, current: CheckoutEntryMap) => {
  const changed: string[] = [];

  for (const name of new Set([
    ...Object.keys(baseline),
    ...Object.keys(current),
  ])) {
    const left = Object.hasOwn(baseline, name) ? baseline[name] : undefined;
    const right = Object.hasOwn(current, name) ? current[name] : undefined;

    if (left !== right) {
      changed.push(name);
    }
  }

  return changed.toSorted();
};

const splitStored = (stored: string | undefined): StoredEntry => {
  if (stored === undefined) {
    return { raw: "", fingerprint: "" };
  }

  const last = stored.lastIndexOf(" ");
  const fingerprint = last === -1 ? "" : stored.slice(last + 1);
  const rest = last === -1 ? "" : stored.slice(0, last);
  const second = rest.lastIndexOf(" ");
  const raw = second === -1 ? "" : rest.slice(0, second);

  return { raw, fingerprint };
};

export const compareCheckouts = async (
  deps: CliDeps,
  baseline: CheckoutBaselineFile,
  dirs: readonly string[],
  sessionDir: string
): Promise<CheckoutReport> => {
  if (isUnavailableBaseline(baseline)) {
    return {
      repositoryCheck: UNAVAILABLE(
        baseline.reason ?? "checkout capture failed"
      ),
    };
  }

  let current: CheckoutBaseline;

  try {
    current = await captureCheckouts(deps, dirs, sessionDir);
  } catch (error) {
    return {
      repositoryCheck: UNAVAILABLE(
        error instanceof Error ? error.message : String(error)
      ),
    };
  }

  const byCwd = new Map(
    baseline.checkouts.map((checkout) => [path.resolve(checkout.cwd), checkout])
  );

  const repositoryChanges: RepositoryChange[] = [];

  for (const next of current.checkouts) {
    const key = path.resolve(next.cwd);
    const prev = byCwd.get(key);

    if (!prev) {
      continue;
    }

    const paths = new Set<string>();

    if (prev.head !== next.head) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
      const diff = await git(deps, key, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        prev.head,
        next.head,
        "--",
      ]);

      if (diff.exit) {
        return { repositoryCheck: UNAVAILABLE(`Cannot compare ${key}`) };
      }

      for (const name of splitPaths(diff.stdout)) {
        paths.add(name);
      }
    }

    for (const name of Object.keys(prev.entries)) {
      if (!Object.hasOwn(next.entries, name)) {
        continue;
      }

      const prevParts = splitStored(prev.entries[name]);
      const nextParts = splitStored(next.entries[name]);

      if (
        isGitlinkDirty(prevParts.raw, prevParts.fingerprint) &&
        isGitlinkDirty(nextParts.raw, nextParts.fingerprint)
      ) {
        return {
          repositoryCheck: UNAVAILABLE(`Dirty submodule re-edited in ${key}`),
        };
      }
    }

    for (const name of diffEntries(prev.entries, next.entries)) {
      paths.add(name);
    }

    const sorted = [...paths].toSorted();

    if (sorted.length) {
      repositoryChanges.push({ cwd: key, paths: sorted });
    }
  }

  if (!repositoryChanges.length) {
    return {};
  }

  repositoryChanges.sort((left, right) => {
    if (left.cwd < right.cwd) {
      return -1;
    }

    return left.cwd > right.cwd ? 1 : 0;
  });

  return { repositoryChanges };
};

const comparedDirs = (
  session: string,
  repositoryRoot: string,
  cwd: string,
  taskWorktree?: string
) => {
  const dirs = [path.resolve(cwd), path.resolve(repositoryRoot)];

  if (taskWorktree !== undefined && taskWorktree !== "") {
    dirs.push(path.resolve(session, taskWorktree));
  }

  return [...new Set(dirs)];
};

const baselineFileFor = (dir: string, generation: number) =>
  path.join(
    reviewGenerationDirectory(dir, generation),
    "checkout-baseline.json"
  );

const checkoutReportFileFor = (dir: string, generation: number) =>
  path.join(reviewGenerationDirectory(dir, generation), "checkout-report.json");

const checkoutReportAttemptFor = (dir: string, generation: number) => {
  const canonical = checkoutReportFileFor(dir, generation);

  if (!fs.existsSync(canonical)) {
    return canonical;
  }

  let attempt = 2;

  while (
    fs.existsSync(
      path.join(
        reviewGenerationDirectory(dir, generation),
        `checkout-report-${attempt}.json`
      )
    )
  ) {
    attempt += 1;
  }

  return path.join(
    reviewGenerationDirectory(dir, generation),
    `checkout-report-${attempt}.json`
  );
};

export const writeCheckoutReport = (
  dir: string,
  generation: number,
  checkout: CheckoutReport
) => {
  fs.mkdirSync(reviewGenerationDirectory(dir, generation), { recursive: true });
  atomic(checkoutReportAttemptFor(dir, generation), checkout);
};

export const generationLaunchedNative = (dir: string, generation: number) => {
  try {
    const fanout: unknown = JSON.parse(
      fs.readFileSync(
        path.join(reviewGenerationDirectory(dir, generation), "fanout.json"),
        "utf-8"
      )
    );

    return (
      fanout === null ||
      (isRecord(fanout) &&
        (fanout["nativeFirst"] === true || fanout["nativeLaunched"] === true))
    );
  } catch (error) {
    return nodeErrorCode(error) !== "ENOENT";
  }
};

const taskWorktreeOf = (session: string, task: string) => {
  try {
    const fold = foldLedger(session);
    const launch = launches(fold, task).findLast((entry) => entry.finished);

    return launch?.finished ? textValue(launch.record.data["path"]) : undefined;
  } catch {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the resolved and unreadable branches.
    return undefined;
  }
};

export const comparedDirsFor = (
  session: string,
  repositoryRoot: string,
  cwd: string,
  taskTarget: boolean,
  requested: string
): ComparedDirs => {
  const worktree = taskTarget ? taskWorktreeOf(session, requested) : undefined;
  const dirs = comparedDirs(session, repositoryRoot, cwd, worktree);

  const absentWorktree =
    worktree !== undefined &&
    worktree !== "" &&
    !fs.existsSync(path.resolve(session, worktree));

  return { dirs, absentWorktree };
};

export const writeBaselineIfMissing = async (
  dir: string,
  generation: number,
  dirs: readonly string[],
  sessionDir: string,
  deps: CliDeps
) => {
  const file = baselineFileFor(dir, generation);

  if (fs.existsSync(file)) {
    return;
  }

  fs.mkdirSync(reviewGenerationDirectory(dir, generation), { recursive: true });

  try {
    const baseline = await captureCheckouts(deps, dirs, sessionDir);
    atomic(file, baseline);
  } catch (error) {
    atomic(file, {
      state: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};

export const compareForRound = async (
  dir: string,
  generation: number,
  dirs: readonly string[],
  sessionDir: string,
  absentWorktree: boolean,
  deps: CliDeps
): Promise<CheckoutReport> => {
  const file = baselineFileFor(dir, generation);
  let raw: string;

  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      return {
        repositoryCheck: {
          state: "unavailable",
          reason: `checkout baseline unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }

    if (!generationLaunchedNative(dir, generation)) {
      return {};
    }

    return {
      repositoryCheck: {
        state: "unavailable",
        reason: "checkout baseline missing after native launch",
      },
    };
  }

  let baseline: unknown;

  try {
    baseline = JSON.parse(raw);
  } catch (error) {
    return {
      repositoryCheck: {
        state: "unavailable",
        reason: `checkout baseline malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }

  if (!isRecord(baseline)) {
    return {
      repositoryCheck: {
        state: "unavailable",
        reason:
          "checkout baseline malformed: expected a checkout baseline object",
      },
    };
  }

  if (baseline["state"] === "unavailable") {
    const { reason } = baseline;

    return {
      repositoryCheck: UNAVAILABLE(
        typeof reason === "string" ? reason : "checkout capture failed"
      ),
    };
  }

  if (!isCheckoutBaseline(baseline)) {
    return {
      repositoryCheck: {
        state: "unavailable",
        reason: "checkout baseline malformed: expected a checkouts array",
      },
    };
  }

  if (absentWorktree) {
    return {
      repositoryCheck: { state: "unavailable", reason: "Absent task worktree" },
    };
  }

  try {
    return await compareCheckouts(deps, baseline, dirs, sessionDir);
  } catch (error) {
    return {
      repositoryCheck: {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

export const carryCheckoutBaseline = (
  dir: string,
  previousGeneration: number
) => {
  const previousBaseline = baselineFileFor(dir, previousGeneration);
  const nextBaseline = baselineFileFor(dir, previousGeneration + 1);

  try {
    fs.mkdirSync(reviewGenerationDirectory(dir, previousGeneration + 1), {
      recursive: true,
    });

    const nextValid = (() => {
      try {
        JSON.parse(fs.readFileSync(nextBaseline, "utf-8"));

        return true;
      } catch {
        return false;
      }
    })();

    if (!nextValid) {
      let previousRaw: string | undefined;

      try {
        previousRaw = fs.readFileSync(previousBaseline, "utf-8");
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") {
          if (generationLaunchedNative(dir, previousGeneration)) {
            atomic(nextBaseline, {
              state: "unavailable",
              reason: `checkout baseline missing after native launch in generation ${
                previousGeneration
              }`,
            });
          }
        } else {
          atomic(nextBaseline, {
            state: "unavailable",
            reason: `baseline carry-over failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }

      if (previousRaw !== undefined) {
        try {
          const carried: unknown = JSON.parse(previousRaw);
          atomic(nextBaseline, carried);
        } catch (error) {
          atomic(nextBaseline, {
            state: "unavailable",
            reason: `baseline carry-over failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
    }
  } catch (error) {
    try {
      fs.mkdirSync(reviewGenerationDirectory(dir, previousGeneration + 1), {
        recursive: true,
      });

      if (!fs.existsSync(nextBaseline)) {
        atomic(nextBaseline, {
          state: "unavailable",
          reason: `baseline carry-over failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    } catch {
      void 0;
    }
  }
};
