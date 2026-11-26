import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { parseJson } from "../lib/integrity.ts";
import type { JsonObject } from "../lib/integrity.ts";
import { findSensitiveMatch } from "../providers/runner.ts";
import { artifactHash, artifactKind } from "./artifacts.ts";
import {
  assertFilled,
  briefSummary,
  fillSlots,
  nextBriefPath,
  resolveHostUtility,
  utilityLaunchValues,
} from "./brief.ts";
import type { HandlerContext } from "./cli.ts";
import { reviewId } from "./confirmations.ts";
import { DEFAULT_RESEARCH_REPLY_LIMIT } from "./domain/context.ts";
import { governedDesignText } from "./domain/design.ts";
import {
  addedCitations,
  consumerSearchText,
  safePathspec,
} from "./domain/fix-review-lite.ts";
import type { Citation } from "./domain/fix-review-lite.ts";
import { governedPlanText } from "./domain/plan.ts";
import { qualityCriteria } from "./domain/prompt.ts";
import { effectiveSeverity, RANK } from "./domain/severity.ts";
import type { Severity } from "./domain/types.ts";
import { git, gitPaths } from "./git.ts";
import { foldLedger } from "./ledger.ts";
import { safeRepoPath, within } from "./lint.ts";
import { present } from "./narrow.ts";
import { clipBytes, ToolError } from "./output.ts";
import { line } from "./review-findings.ts";
import {
  reviewDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewRoundNumber,
} from "./review-state.ts";

interface Round {
  number: number;
  dir: string;
  metadata: JsonObject;
  findings: JsonObject[];
}

const isSeverity = (value: string): value is Severity => value in RANK;

const toPosix = (file: string) => file.split(path.sep).join("/");

const safeText = (value: string) =>
  value.replaceAll("{{", "{ {").replaceAll("}}", "} }").replaceAll("](", "] (");

const canonical = (file: string) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
};

const realpathOrNull = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
};

const readJson = (file: string) => {
  const text = readText(file);

  try {
    const parsed = text === null ? null : parseJson(text);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const span = (citation: Citation) => {
  if (citation.start === null) {
    return citation.path;
  }

  if (citation.start === citation.end) {
    return `${citation.path}:${citation.start}`;
  }

  return `${citation.path}:${citation.start}-${citation.end}`;
};

const list = (items: readonly string[]) =>
  items.length ? items.join("\n") : "- None.";

const completedRounds = (reviewDir: string) => {
  if (!fs.existsSync(reviewDir)) {
    return [];
  }

  const rounds: Round[] = [];

  for (const name of fs.readdirSync(reviewDir)) {
    const number = reviewRoundNumber(name);

    if (number === undefined) {
      continue;
    }

    const dir = path.join(reviewDir, name);
    const metadata = readJson(reviewRoundFile(dir));
    const findings = readJson(reviewFindingsFile(dir))?.["findings"];

    if (!metadata || !Array.isArray(findings)) {
      continue;
    }

    rounds.push({ number, dir, metadata, findings: findings.filter(isRecord) });
  }

  return rounds.toSorted((a, b) => b.number - a.number);
};

// oxlint-disable-next-line eslint/complexity -- lite-brief branches per arg shape, kind gate, round presence, and ruling state.
export const renderFixReviewLiteBrief = async (ctx: HandlerContext) => {
  const [target] = ctx.args;

  if (ctx.args.length !== 1 || target === undefined) {
    throw new ToolError(
      1,
      "invalid-input",
      "One plan or design artifact path is required"
    );
  }

  const root = canonical(ctx.manifest.repositoryRoot);
  const artifact = path.resolve(ctx.manifest.repositoryRoot, target);
  const kind = artifactKind(artifact);

  if (kind !== "plan" && kind !== "design") {
    throw new ToolError(
      1,
      "invalid-input",
      "fix-review-lite reviews a plan or design artifact only"
    );
  }

  const review = reviewId(kind, artifact);
  const reviewDir = reviewDirectory(ctx.session, review);
  const artifactReal = canonical(artifact);

  const round = completedRounds(reviewDir).find(
    (candidate) =>
      typeof candidate.metadata["artifactPath"] === "string" &&
      canonical(candidate.metadata["artifactPath"]) === artifactReal
  );

  if (!round) {
    throw new ToolError(
      4,
      "nothing-to-review",
      `No completed review round reviewed ${artifact}`
    );
  }

  const fold = foldLedger(ctx.session);
  const questions: string[] = [];

  for (const finding of round.findings) {
    const { id } = finding;

    if (typeof id !== "string") {
      continue;
    }

    const history = fold.records.filter(
      (record) =>
        record.kind === "ruling" &&
        record.data["subject"] === `review:${review}:${id}`
    );

    const ruling = history.at(-1);

    if (!ruling || ruling.data["ruling"] !== "accepted") {
      continue;
    }

    const stored =
      typeof finding["severity"] === "string" ? finding["severity"] : "unknown";

    const severity = isSeverity(stored)
      ? effectiveSeverity({ severity: stored }, history)
      : stored;

    const rationale =
      typeof ruling.data["rationale"] === "string"
        ? ruling.data["rationale"]
        : "";

    questions.push(
      clipBytes(
        safeText(
          `- ${line(id)} ${line(severity)} ${line(finding["locus"])}: ${line(finding["defect"])}` +
            ` — required: ${line(finding["requiredChange"])} — ruling: ${line(rationale)}`
        ),
        400
      )
    );
  }

  if (!questions.length) {
    throw new ToolError(
      4,
      "nothing-to-review",
      "No accepted finding in the reviewed round"
    );
  }

  const specMeta = round.metadata["spec"];
  const specPath = isRecord(specMeta) ? specMeta["path"] : undefined;
  const specHash = isRecord(specMeta) ? specMeta["hash"] : undefined;

  if (typeof specPath !== "string" || typeof specHash !== "string") {
    throw new ToolError(
      1,
      "invalid-input",
      "Round records no spec path and hash"
    );
  }

  const specText = readText(specPath);

  if (specText === null) {
    throw new ToolError(1, "invalid-input", `Cannot read spec ${specPath}`);
  }

  const source = readText(artifact);

  if (source === null) {
    throw new ToolError(1, "invalid-input", `Cannot read artifact ${artifact}`);
  }

  const snapshot = path.join(round.dir, "spec.snapshot.md");
  let specLine: string;

  if (artifactHash("spec", specText) === specHash) {
    specLine = `Governing spec: \`${specPath}\`.`;
  } else {
    const reviewed = readText(snapshot);
    specLine =
      reviewed !== null && artifactHash("spec", reviewed) === specHash
        ? `Governing spec: \`${specPath}\`, changed since the round. Reviewed spec text: \`${snapshot}\`.`
        : `Governing spec: \`${specPath}\`, changed since the round. The reviewed spec text is unavailable.`;
  }

  const listing = await gitPaths(ctx.deps, root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);

  const listed = new Set(listing);
  const sessionRel = toPosix(path.relative(root, ctx.session));

  const sessionsRootRel = toPosix(
    path.relative(root, path.dirname(ctx.session))
  );

  const sessionsInside =
    sessionsRootRel !== "" &&
    !sessionsRootRel.startsWith("..") &&
    !path.isAbsolute(sessionsRootRel);

  const inSessions = (rel: string) =>
    sessionsInside &&
    (rel === sessionsRootRel || rel.startsWith(`${sessionsRootRel}/`));

  const ownSession = (rel: string) =>
    rel.startsWith(`${sessionRel}/`) &&
    rel !== `${sessionRel}/.state` &&
    !rel.startsWith(`${sessionRel}/.state/`);

  const directory = path.join(ctx.session, ".state", "briefs");
  fs.mkdirSync(directory, { recursive: true });
  const briefFile = nextBriefPath(directory, "fix-review-lite");
  const base = briefFile.slice(0, -".md".length);
  const governedFile = `${base}.governed.md`;
  const diffFile = `${base}.diff`;
  const inputFile = path.join(reviewDir, `round-${round.number}.input.md`);
  const written: string[] = [];

  try {
    fs.writeFileSync(
      governedFile,
      kind === "plan" ? governedPlanText(source) : governedDesignText(source)
    );
    written.push(governedFile);

    const diff = await git(ctx.deps, root, [
      "diff",
      "--no-index",
      "--no-color",
      "--no-ext-diff",
      "--",
      inputFile,
      governedFile,
    ]);

    if (diff.exit === 0) {
      throw new ToolError(
        4,
        "nothing-to-review",
        "No change since the reviewed round input"
      );
    }

    if (diff.exit !== 1 || !diff.stdout) {
      throw new ToolError(
        2,
        "fault",
        diff.stderr || `git diff exited ${diff.exit}`
      );
    }

    fs.writeFileSync(diffFile, diff.stdout);
    written.push(diffFile);

    const kept = new Set<string>();
    const unresolved: string[] = [];
    const withheld: string[] = [];
    const seen = new Set<string>();
    const unrenderable = new Set<string>();

    const citationReason = (rel: string) => {
      if (/[\r\n`]|\{\{|\}\}|\]\(/u.test(rel)) {
        return "unrenderable name";
      }

      const abs = path.resolve(root, rel);

      if (!safeRepoPath(rel) || !within(root, abs)) {
        return "outside repository";
      }

      if (inSessions(rel) && !ownSession(rel)) {
        return "session";
      }

      const real = realpathOrNull(abs);

      if (real === null) {
        return "no match";
      }

      if (!within(root, real)) {
        return "outside repository";
      }

      if (fs.statSync(real, { throwIfNoEntry: false })?.isFile() !== true) {
        return "not a file";
      }

      if (findSensitiveMatch(abs, realpathOrNull)) {
        return "sensitive";
      }

      return listed.has(rel) ? null : "not listed";
    };

    for (const citation of addedCitations(diff.stdout)) {
      const normalized: Citation = {
        ...citation,
        path: path.posix.normalize(citation.path),
      };

      const key = span(normalized);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      let reason = citationReason(normalized.path);

      if (reason === "no match") {
        const matches = [...listed].filter(
          (rel) =>
            rel === normalized.path || rel.endsWith(`/${normalized.path}`)
        );

        if (matches.length === 1) {
          const match = present(matches[0], "citation match");
          const real = realpathOrNull(path.resolve(root, match));

          if (
            real !== null &&
            fs.statSync(real, { throwIfNoEntry: false })?.isFile() === true
          ) {
            normalized.path = match;
            reason = citationReason(match);
          }
        } else if (matches.length > 1) {
          const readable = matches.filter(
            (rel) => citationReason(rel) === null
          );

          const shown = readable.slice(0, 5);

          if (readable.length > 5) {
            shown.push(`+${readable.length - 5} more`);
          }

          unresolved.push(
            `- \`${normalized.path}\`: several matches${shown.length ? `: ${shown.join(", ")}` : ""}`
          );
          continue;
        }
      }

      if (reason === null) {
        kept.add(`- \`${span(normalized)}\``);
      } else if (reason === "no match" || reason === "not a file") {
        unresolved.push(`- \`${normalized.path}\`: ${reason}`);
      } else {
        const display = normalized.path
          .replaceAll("\r", String.raw`\r`)
          .replaceAll("\n", String.raw`\n`)
          .replaceAll("`", "%60");

        withheld.push(safeText(`- \`${display}\`: ${reason}`));

        if (reason === "unrenderable name") {
          unrenderable.add(normalized.path);
        }
      }
    }

    const excludes: string[] = sessionsInside ? [sessionsRootRel] : [];

    for (const rel of listing) {
      const sensitive = findSensitiveMatch(
        path.resolve(root, rel),
        realpathOrNull
      );

      if (inSessions(rel) || !(sensitive || unrenderable.has(rel))) {
        continue;
      }

      excludes.push(rel);

      if (sensitive && !safePathspec(rel)) {
        withheld.push(safeText(`- \`${rel}\`: sensitive`));
      }
    }

    const consumerSearch = consumerSearchText(excludes);

    const notePrefix = `fix-review-lite:${review}:${round.number}:`;

    const ordinal =
      Math.max(
        0,
        ...fold.records
          .filter(
            (record) =>
              record.kind === "note" && record.key.startsWith(notePrefix)
          )
          .flatMap((record) =>
            /^[1-9]\d*$/u.test(record.key.slice(notePrefix.length))
              ? [Number(record.key.slice(notePrefix.length))]
              : []
          )
      ) + 1;

    const noteKey = notePrefix + ordinal;

    const noteSkeleton = {
      kind: "note",
      by: "orchestrator",
      key: noteKey,
      data: {
        text: `kind ${kind}; raised <n>; confirmed <n>; rejected <id: evidence | none>; mode <explorer|inline>`,
      },
    };

    const bar = fs.readFileSync(
      path.join(
        ctx.deps.skillRoot,
        "references",
        "templates",
        "quality-bar.md"
      ),
      "utf-8"
    );

    const specStage = fs.readFileSync(
      path.join(ctx.deps.skillRoot, "references", "spec-stage.md"),
      "utf-8"
    );

    const evidence = qualityCriteria(bar, "explorer", 0, specStage)
      .split("\n")
      .find((text) => text.startsWith("- Evidence:"));

    if (evidence === undefined) {
      throw new ToolError(2, "fault", "Quality bar has no Evidence line");
    }

    const template = fs.readFileSync(
      path.join(
        ctx.deps.skillRoot,
        "references",
        "templates",
        "fix-review-lite-brief.md"
      ),
      "utf-8"
    );

    const slots = {
      questions: questions.join("\n"),
      repositoryRoot: safeText(root),
      diffPath: safeText(diffFile),
      artifact: safeText(artifact),
      spec: safeText(specLine),
      citations: list([...kept]),
      unresolved: unresolved.length ? list(unresolved) : "- none",
      withheld: list(withheld),
      consumerSearch,
      replyLimit: DEFAULT_RESEARCH_REPLY_LIMIT.toLocaleString("en-US"),
      evidence,
    };

    const text = fillSlots("fix-review-lite", template, slots);
    assertFilled("fix-review-lite", text);
    fs.writeFileSync(briefFile, text);

    const host = ctx.deps.orchestrator?.platform;
    const entry = resolveHostUtility(ctx.deps.skillRoot, host);
    const launch = utilityLaunchValues(ctx.deps.skillRoot, host);

    const value = {
      briefPath: briefFile,
      bytes: Buffer.byteLength(text),
      review,
      round: round.number,
      noteKey,
      noteSkeleton,
      diffPath: diffFile,
      citations: kept.size,
      unresolved: unresolved.length,
      withheld: withheld.length,
      contextLimit: entry ? entry.contextLimit : null,
      ...launch,
    };

    const summary = `fix-review-lite brief ${review} round ${round.number}: ${questions.length} accepted, ${kept.size} citations, ${unresolved.length} unresolved, ${withheld.length} withheld`;

    return {
      ok: true,
      exit: 0,
      value,
      summary: briefSummary(summary, host, launch, briefFile, value.bytes, {
        tail: `; skeleton ${JSON.stringify(noteSkeleton)}`,
        shortPath: `.state/briefs/${path.basename(briefFile)}`,
      }),
      postFold: fold,
    };
  } catch (error) {
    for (const file of written) {
      fs.rmSync(file, { force: true });
    }

    throw error;
  }
};
