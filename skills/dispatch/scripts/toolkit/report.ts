import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { parseJson } from "../lib/integrity.ts";
import { readArtifact } from "./artifacts.ts";
import type { HandlerContext } from "./cli.ts";
import { loadRejections, applicableReviewIds } from "./confirmations.ts";
import type { RejectionState } from "./confirmations.ts";
import { coverageState } from "./coverage.ts";
import { diagnosticsEnabled } from "./diagnostics-capture.ts";
import { optionalDiagnostics, retroWarning } from "./diagnostics.ts";
import { structuralLines } from "./domain/markdown-structure.ts";
import { parseGlance } from "./domain/plan.ts";
import type { ParsedPlan } from "./domain/types.ts";
import {
  cleanupBinding,
  criterionStatusCounts,
  criterionStatuses,
  latestCleanup,
  verifiedStage,
} from "./evidence.ts";
import type { CriterionStatus } from "./evidence.ts";
import { git, gitOk, headTree, splitPaths, testedTree } from "./git.ts";
import { integrationRecord } from "./integration-state.ts";
import { currentHashes, foldLedger, latest, withLedger } from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { present, stringList, stringMap, textValue } from "./narrow.ts";
import { ToolError, writePrivateOutput } from "./output.ts";
import { checks, loadPlan, ownedPaths } from "./plan-view.ts";
import { validateReviewFix } from "./records.ts";
import type { LedgerRecord, ReviewFix } from "./records.ts";
import { reviewRows } from "./review-findings.ts";
import { reviewIdentity } from "./review-identity.ts";
import {
  INTEGRATION_REVIEW,
  reviewDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewRoundNumber,
} from "./review-state.ts";
import { renderWalkthrough } from "./walkthrough.ts";
import type { WalkthroughView } from "./walkthrough.ts";
import { deliveredSourceRef } from "./writers.ts";

interface Current {
  headTree: string;
  testedTree: string;
}

export interface ReviewFixReport {
  commit: string;
  reason: string;
  metadata: ReviewFix;
  status: "re-reviewed" | "verified but not re-reviewed" | "not verified";
  paths: string[];
  verification?: {
    tree: string;
    criteria: string[];
    contract: string[];
  };
}

interface Snapshot {
  risk: string;
  fold: Fold;
  bind: LedgerRecord;
  plan: ParsedPlan;
  planPath: string;
  planHash: string;
  planStem: string;
  specPath: string;
  specHash: string;
  designHash: string | undefined;
  integration: LedgerRecord | undefined;
  integrationPath: string | null;
  head: string | null;
  current: Current | null;
  statuses: CriterionStatus[];
  delivered: LedgerRecord | undefined;
  deliveredAtHead: boolean;
  integrated: number;
  rejectionConfirmations: RejectionState[];
  confirmationError: string | undefined;
  coverage: WalkthroughView["coverage"];
  reviewedCodeBaseline: string | undefined;
  reviewFixes: ReviewFixReport[];
  testCleanup: WalkthroughView["testCleanup"];
}

type ReportFacts = Snapshot & { view: WalkthroughView };

const isDirectory = (directory: string) => {
  try {
    return fs.statSync(directory).isDirectory();
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return false;
    }

    throw error;
  }
};

const destinationOf = (record: LedgerRecord) => {
  const dest: unknown = record.data["dest"];

  return isRecord(dest) ? dest : undefined;
};

const recordForDestination = (fold: Fold, integration: LedgerRecord) => {
  const dest = destinationOf(integration);

  return fold.records.findLast(
    (record) =>
      record.kind === "integrate" &&
      record.data["phase"] === "delivered" &&
      destinationOf(record)?.["path"] === dest?.["path"] &&
      destinationOf(record)?.["branch"] === dest?.["branch"]
  );
};

const completedReviewHeads = (session: string) => {
  const root = reviewDirectory(session, INTEGRATION_REVIEW);
  const heads = new Set<string>();

  if (!isDirectory(root)) {
    return [];
  }

  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory() || reviewRoundNumber(name.name) === undefined) {
      continue;
    }

    const directory = path.join(root, name.name);

    if (!fs.existsSync(reviewFindingsFile(directory))) {
      continue;
    }

    const saved = readReviewJson(reviewRoundFile(directory));
    const round = isRecord(saved) ? saved : undefined;
    const target = round?.["target"];
    const head = isRecord(target) ? target["head"] : undefined;
    const generation = round?.["generation"];

    if (
      typeof head !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head) ||
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      /\(confirmation-only\)/iu.test(String(round?.["scope"] ?? "")) ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      continue;
    }

    const slots = path.join(
      reviewGenerationDirectory(directory, generation),
      "slots"
    );

    if (
      isDirectory(slots) &&
      fs.readdirSync(slots, { withFileTypes: true }).some((file) => {
        if (!file.isFile() || !file.name.endsWith(".json")) {
          return false;
        }

        const slot = readReviewJson(path.join(slots, file.name));

        return isRecord(slot) && slot["state"] === "done";
      })
    ) {
      heads.add(head);
    }
  }

  return [...heads];
};

const readReviewJson = (file: string) => {
  try {
    return parseJson(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    if (error instanceof SyntaxError || nodeErrorCode(error) === "ENOENT") {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the missing-file and parsed branches.
      return undefined;
    }

    throw error;
  }
};

const countValue = (value: unknown) => {
  if (typeof value !== "number") {
    throw new TypeError(`Expected a number value, received ${typeof value}`);
  }

  return value;
};

const testCleanupView = ({ data }: LedgerRecord) => ({
  from: textValue(data["from"]),
  trees: stringMap(data["trees"]),
  removed: stringList(data["removed"]),
  deleted: countValue(data["deleted"]),
  merged: countValue(data["merged"]),
});

// oxlint-disable-next-line eslint/complexity -- capture branches per bind state, integration presence, and fix-record kind.
const capture = async (ctx: HandlerContext, fold: Fold) => {
  const bind = latest(fold, "bind");
  const plan = loadPlan(ctx.session, ctx.manifest);

  if (!bind) {
    throw new ToolError(4, "lint-errors", "No bound plan");
  }

  // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
  const planPath = String(bind.data["plan"]);
  // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
  const specPath = String(bind.data["spec"]);
  const hashes = currentHashes(ctx.manifest.repositoryRoot, bind);
  const specHash = hashes.spec ?? "unavailable";
  const planHash = hashes.plan ?? "unavailable";
  const integration = integrationRecord(fold);
  let integrationPath: string | null = null;
  let head: string | null = null;
  let current: Current | null = null;

  if (integration) {
    const candidate = path.resolve(
      ctx.session,
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      String(integration.data["path"])
    );

    if (isDirectory(candidate)) {
      integrationPath = candidate;
      head = await gitOk(ctx.deps, candidate, ["rev-parse", "HEAD"]);
      const headTreeValue = await headTree(ctx.deps, candidate);

      const testedTreeValue = await testedTree(
        ctx.deps,
        ctx.session,
        candidate
      );

      current = { headTree: headTreeValue, testedTree: testedTreeValue };
    }
  }

  const checkRows = checks(plan);

  const cleanup = cleanupBinding(fold);
  const cleanupRecord = latestCleanup(fold);

  const fixRecords = fold.records.filter(
    (record) =>
      record.kind === "integrate" &&
      record.data["phase"] === "fix" &&
      typeof record.data["reviewFix"] === "object" &&
      record.data["reviewFix"] !== null
  );

  let reviewedCodeBaseline: string | undefined;

  if (
    fixRecords.length &&
    typeof integrationPath === "string" &&
    integrationPath !== "" &&
    integration &&
    typeof head === "string" &&
    head !== "" &&
    typeof integration.data["base"] === "string"
  ) {
    try {
      const identity = await reviewIdentity(
        ctx,
        fold,
        integrationPath,
        head,
        integration.data["base"]
      );

      reviewedCodeBaseline = identity.baseline;
    } catch (error) {
      if (!(error instanceof ToolError && error.reason === "review-required")) {
        throw error;
      }
    }
  }

  const reviewHeads = fixRecords.length
    ? completedReviewHeads(ctx.session)
    : [];

  const hasCurrentVerification = Boolean(
    fixRecords.length &&
    current &&
    checkRows.length &&
    verifiedStage(fold, checkRows, current, cleanup)
  );

  const reviewFixes: ReviewFixReport[] = [];
  const repository = ctx.manifest.repositoryRoot;

  for (const record of fixRecords) {
    // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
    const commit = String(record.data["commit"]);
    const metadata = validateReviewFix(record.data["reviewFix"]);

    const isAncestor = async (target: string) => {
      const ancestry = await git(ctx.deps, repository, [
        "merge-base",
        "--is-ancestor",
        commit,
        target,
      ]);

      return ancestry.exit === 0;
    };

    let reviewed = false;

    for (const target of reviewHeads) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
      if (await isAncestor(target)) {
        reviewed = true;
        break;
      }
    }

    const verification =
      !reviewed &&
      typeof head === "string" &&
      head !== "" &&
      hasCurrentVerification &&
      // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
      (await isAncestor(head))
        ? {
            tree: present(current, "the current integration trees").headTree,
            criteria: checkRows
              .filter((check) => check.criterion !== "contract")
              .map((check) => check.criterion),
            contract: checkRows
              .filter((check) => check.criterion === "contract")
              .map((check) => check.criterion),
          }
        : undefined;

    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    const names = await git(ctx.deps, repository, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "--no-renames",
      "-r",
      "-z",
      commit,
    ]);

    let status: ReviewFixReport["status"];

    if (reviewed) {
      status = "re-reviewed";
    } else if (verification === undefined) {
      status = "not verified";
    } else {
      status = "verified but not re-reviewed";
    }

    reviewFixes.push({
      commit,
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      reason: String(record.data["reason"]),
      metadata,
      status,
      paths: names.exit === 0 ? splitPaths(names.stdout) : [],
      ...(verification && { verification }),
    });
  }

  const statusRows = criterionStatuses(fold, checkRows, current, cleanup);

  const delivered = integration
    ? recordForDestination(fold, integration)
    : undefined;

  const deliveredAtHead =
    delivered !== undefined &&
    typeof head === "string" &&
    head !== "" &&
    delivered.data["source"] === head;

  const planTaskIds = new Set(plan.tasks.map((task) => task.id));

  const integrated = new Set(
    fold.records.flatMap((record) =>
      record.kind === "integrate" &&
      record.data["phase"] === "done" &&
      typeof record.data["task"] === "string" &&
      planTaskIds.has(record.data["task"])
        ? [record.data["task"]]
        : []
    )
  );

  const riskToken = plan.box["Risk"]?.trim().split(/\s+/u, 1)[0];
  const risk = riskToken === "med" || riskToken === "high" ? riskToken : "low";

  const planStem =
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing, typescript/strict-boolean-expressions -- empty stems and titles fall through to the walkthrough default.
    path.basename(planPath).replace(/\.plan\.md$/iu, "") ||
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing, typescript/strict-boolean-expressions -- empty stems and titles fall through to the walkthrough default.
    plan.title ||
    "walkthrough";

  let rejectionConfirmations: RejectionState[] = [];
  let confirmationError: string | undefined;

  try {
    rejectionConfirmations = loadRejections(
      ctx.session,
      fold,
      applicableReviewIds(ctx.manifest, fold)
    );
  } catch (error) {
    if (
      !(
        error instanceof ToolError &&
        error.reason === "review-confirmation-required"
      )
    ) {
      throw error;
    }

    confirmationError = error.message;
  }

  let coverage: WalkthroughView["coverage"];

  try {
    coverage = coverageState(
      ctx.session,
      fold,
      INTEGRATION_REVIEW,
      applicableReviewIds(ctx.manifest, fold).get(INTEGRATION_REVIEW)
    );
  } catch (error) {
    if (!(error instanceof ToolError && error.reason === "coverage-required")) {
      throw error;
    }

    coverage = "unreadable";
  }

  return {
    fold,
    bind,
    plan,
    planPath,
    planHash,
    planStem,
    specPath,
    specHash,
    designHash: hashes.design ?? undefined,
    risk,
    integration,
    integrationPath,
    head,
    current,
    statuses: statusRows,
    delivered,
    deliveredAtHead,
    integrated: integrated.size,
    rejectionConfirmations,
    confirmationError,
    coverage,
    reviewedCodeBaseline,
    reviewFixes,
    testCleanup: cleanupRecord ? testCleanupView(cleanupRecord) : undefined,
  };
};

const parseNameStatus = (bytes: string) => {
  const parts = bytes.split("\0").filter(Boolean);
  const changes: { status: string; path: string }[] = [];

  for (let index = 0; index < parts.length;) {
    const token = present(parts[index], "a name-status token");

    index += 1;
    const tab = token.indexOf("\t");

    if (tab !== -1) {
      changes.push({ status: token.slice(0, tab), path: token.slice(tab + 1) });
    } else if (index < parts.length) {
      changes.push({
        status: token,
        path: present(parts[index], "a name-status path"),
      });

      index += 1;
    }
  }

  return changes;
};

const userDataSummary = (data: LedgerRecord["data"]) => {
  try {
    return JSON.stringify(data);
  } catch {
    return "[unavailable]";
  }
};

type FocusBullets = { text: string; evidence: string }[];

const isFocusBullets = (value: unknown): value is FocusBullets =>
  Array.isArray(value) &&
  value.every(
    (bullet) =>
      isRecord(bullet) &&
      typeof bullet["text"] === "string" &&
      typeof bullet["evidence"] === "string"
  );

const focusBulletsOf = (record: LedgerRecord | undefined) => {
  const bullets: unknown = record?.data["bullets"] ?? [];

  if (!isFocusBullets(bullets)) {
    throw new TypeError("Expected review focus bullets");
  }

  return bullets;
};

const runtimeProofView = (
  fold: Fold,
  proof: LedgerRecord,
  settled: LedgerRecord | undefined
) => {
  const report: unknown = proof.data["report"];
  const artifacts: unknown = proof.data["artifacts"];
  const dirty: unknown = proof.data["dirty"];

  return {
    outcome: textValue(proof.data["outcome"]),
    head: textValue(proof.data["head"]),
    reason: textValue(proof.data["reason"]),
    ...(report !== undefined && { report: textValue(report) }),
    ...(artifacts !== undefined && { artifacts: stringList(artifacts) }),
    ...(typeof dirty === "boolean" && { dirty }),
    fixes: settled
      ? fold.records
          .filter(
            (r) =>
              r.seq > settled.seq &&
              r.kind === "integrate" &&
              r.data["phase"] === "fix"
          )
          .map((r) => ({
            commit: textValue(r.data["commit"]),
            reason: textValue(r.data["reason"]),
            beforeLatest: r.seq < proof.seq,
          }))
      : [],
  };
};

// oxlint-disable-next-line eslint/complexity -- materialization branches per command exit, name-status action, and ledger kind.
const materialize = async (ctx: HandlerContext, snapshot: Snapshot) => {
  const changes: WalkthroughView["changes"][number][] = [];
  const unplannedPaths: string[] = [];

  if (
    typeof snapshot.integrationPath === "string" &&
    snapshot.integrationPath !== "" &&
    snapshot.integration
  ) {
    const result = await git(ctx.deps, snapshot.integrationPath, [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      String(snapshot.integration.data["base"]),
      snapshot.head ?? "HEAD",
    ]);

    if (result.exit !== 0) {
      throw new ToolError(
        2,
        "fault",
        result.stderr || result.stdout || "Git diff failed"
      );
    }

    for (const change of parseNameStatus(result.stdout)) {
      const relative = change.path.replaceAll("\\", "/");

      const owners = snapshot.plan.tasks
        .filter((task) => ownedPaths(snapshot.plan, task.id).includes(relative))
        .map((task) => ({ id: task.id, title: task.title }));

      if (!owners.length) {
        unplannedPaths.push(relative);
      }

      let action: "NEW" | "DELETE" | "MODIFY";

      if (change.status === "A") {
        action = "NEW";
      } else if (change.status === "D") {
        action = "DELETE";
      } else {
        action = "MODIFY";
      }

      changes.push({
        action,
        path: relative,
        owners,
      });
    }
  }

  const root = ctx.manifest.repositoryRoot;
  let bindingAtEdit: LedgerRecord | undefined;

  const edits = snapshot.fold.records
    .filter((record) => {
      if (record.kind === "bind") {
        bindingAtEdit = record;
      }

      if (record.kind !== "edit") {
        return false;
      }

      const artifact = textValue(record.data["artifact"]);
      const bound: unknown = bindingAtEdit?.data[artifact];
      const reported: unknown = snapshot.bind.data[artifact];

      return (
        typeof bound === "string" &&
        bound !== "" &&
        typeof reported === "string" &&
        reported !== "" &&
        path.relative(
          path.resolve(root, textValue(reported)),
          path.resolve(root, textValue(bound))
        ) === ""
      );
    })
    .map((record) => ({
      seq: record.seq,
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      artifact: String(record.data["artifact"]),
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      class: String(record.data["class"]),
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      rationale: String(record.data["rationale"]),
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      diffRef: String(record.data["diffRef"]),
      affects: Array.isArray(record.data["affects"])
        ? record.data["affects"].map(String)
        : [],
    }));

  const escalations = new Map<string, LedgerRecord>();

  for (const record of snapshot.fold.records) {
    if (record.kind === "escalation") {
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      escalations.set(String(record.data["id"]), record);
    }
  }

  const openEscalations = [...escalations.values()].flatMap(({ data }) =>
    data["state"] === "open"
      ? // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
        [{ id: String(data["id"]), summary: String(data["summary"]) }]
      : []
  );

  const deferredEscalations = [...escalations.values()].flatMap((record) => {
    // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
    const summary = String(record.data["summary"]);
    // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
    const id = String(record.data["id"]);

    return record.data["state"] === "resolved" &&
      id.startsWith("ceiling:") &&
      summary.startsWith("defer:")
      ? [{ id, summary }]
      : [];
  });

  const rulings = new Map<string, LedgerRecord>();

  for (const record of snapshot.fold.records) {
    if (record.kind === "ruling") {
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      rulings.set(String(record.data["subject"]), record);
    }
  }

  const deferredRulings = [...rulings.values()].flatMap((record) => {
    const match = /^review:(?<cap1>[^:]+):(?<cap2>.+)$/u.exec(
      // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
      String(record.data["subject"])
    );

    return record.data["ruling"] === "deferred" && match
      ? [
          {
            review: present(match[1], "the review ID"),
            finding: present(match[2], "the finding ID"),
          },
        ]
      : [];
  });

  const userRecords = snapshot.fold.records
    .filter((record) => record.by === "user")
    .map((record) => ({
      seq: record.seq,
      kind: record.kind,
      summary: userDataSummary(record.data),
      quote: record.quote ?? "",
    }));

  let review: ReturnType<typeof reviewRows>;

  try {
    review = reviewRows(
      ctx.session,
      snapshot.fold,
      snapshot.rejectionConfirmations
    );
  } catch (error) {
    if (
      snapshot.confirmationError === undefined ||
      snapshot.confirmationError === "" ||
      !(error instanceof ToolError && error.reason === "review-corrupt")
    ) {
      throw error;
    }

    snapshot.confirmationError += `; ${error.message}`;
    review = { rows: [], rounds: [] };
  }

  const destination =
    snapshot.integration && destinationOf(snapshot.integration);

  // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
  const destBranch = String(destination?.["branch"] ?? "");
  const { glance } = snapshot.plan;
  const focusRecord = latest(snapshot.fold, "focus");
  const focusBullets = focusBulletsOf(focusRecord);
  const visualInput: unknown = focusRecord?.data["visual"];
  const focusVisual = typeof visualInput === "string" ? visualInput : undefined;
  let visuals = glance?.visuals ?? "";
  const designPath: unknown = snapshot.bind.data["design"];

  if (!visuals && typeof designPath === "string") {
    const source = readArtifact(ctx.manifest.repositoryRoot, designPath);

    if (source !== null) {
      visuals = parseGlance(structuralLines(source))?.visuals ?? "";
    }
  }

  const integrationSeq = snapshot.integration?.seq ?? 0;

  const proofRecords = snapshot.fold.records.filter(
    (r) =>
      r.seq > integrationSeq &&
      r.kind === "integrate" &&
      r.data["phase"] === "verification"
  );

  const proof = proofRecords.at(-1);

  const settled = proofRecords.find((r) => {
    const open: unknown = r.data["open"];

    return Array.isArray(open) && open.length === 0;
  });

  const runtimeProof = proof
    ? runtimeProofView(snapshot.fold, proof, settled)
    : undefined;

  const source: unknown = snapshot.delivered?.data["source"] ?? null;

  const view: WalkthroughView = {
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing, typescript/strict-boolean-expressions -- an empty plan title falls back to the plan stem.
    title: snapshot.plan.title || snapshot.planStem,
    specPath: snapshot.specPath,
    specHash: snapshot.specHash,
    planPath: snapshot.planPath,
    planHash: snapshot.planHash,
    risk: snapshot.risk,
    delivered: snapshot.integration
      ? {
          integrated: snapshot.integrated,
          total: snapshot.plan.tasks.length,
          source: source === null ? null : textValue(source),
          branch: destBranch,
          ref: deliveredSourceRef(ctx.manifest.safeSessionId),
        }
      : null,
    glance: glance ? { what: glance.what, visuals: glance.visuals } : null,
    repositoryRoot: ctx.manifest.repositoryRoot,
    ...(typeof designPath === "string" && {
      designPath,
      designHash: snapshot.designHash ?? "unavailable",
    }),
    ...(runtimeProof && { runtimeProof }),
    visuals,
    focus: focusRecord
      ? {
          bullets: focusBullets,
          ...(focusVisual !== undefined &&
            focusVisual !== "" && { visual: focusVisual }),
        }
      : null,
    tasks: snapshot.plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      outcome: task.summary,
    })),
    statuses: snapshot.statuses,
    changes,
    edits,
    unplannedPaths,
    openEscalations,
    deferredRulings,
    deferredEscalations,
    userRecords,
    reviewRows: review.rows,
    reviewRounds: review.rounds,
    reviewFixes: snapshot.reviewFixes,
    ...(snapshot.coverage !== undefined && { coverage: snapshot.coverage }),
    ...(snapshot.reviewedCodeBaseline !== undefined &&
      snapshot.reviewedCodeBaseline !== "" && {
        reviewedCodeBaseline: snapshot.reviewedCodeBaseline,
      }),
    ...(snapshot.testCleanup && { testCleanup: snapshot.testCleanup }),
  };

  return { ...snapshot, view };
};

const resultValue = (facts: ReportFacts, relativePath: string) => ({
  path: relativePath,
  statuses: facts.statuses,
  changes: facts.view.changes,
  deviations: {
    edits: facts.view.edits,
    unplannedPaths: facts.view.unplannedPaths,
  },
  openEscalations: facts.view.openEscalations,
  deferredRulings: facts.view.deferredRulings,
  deferredEscalations: facts.view.deferredEscalations,
  userRecords: facts.view.userRecords,
  delivered: facts.view.delivered,
  rejectionConfirmations: facts.rejectionConfirmations,
  confirmationError: facts.confirmationError,
  reviewedCodeBaseline: facts.reviewedCodeBaseline,
  reviewFixes: facts.reviewFixes,
});

const publishReport = (
  ctx: HandlerContext,
  facts: ReportFacts,
  outcome: "rendered" | "complete",
  diagnostics: boolean
) => {
  const walkthroughPath = path.join(
    ctx.session,
    `${facts.planStem}.walkthrough.md`
  );

  writePrivateOutput(
    walkthroughPath,
    renderWalkthrough(facts.view, ctx.session)
  );

  const diagnosticsPath = diagnostics
    ? optionalDiagnostics(ctx.session, facts.fold, outcome, {
        manifest: ctx.manifest,
        deps: ctx.deps,
      })
    : undefined;

  const complete = outcome === "complete";

  const warning =
    complete && diagnostics ? retroWarning(ctx.session) : undefined;

  const counts = criterionStatusCounts(facts.statuses);

  const relative = path
    .relative(ctx.session, walkthroughPath)
    .split(path.sep)
    .join("/");

  const deviations = facts.view.edits.length + facts.view.unplannedPaths.length;
  const summary = `walkthrough ${relative}; SC verified ${counts.verified}, manual ${counts.manual}, waived ${counts.waived}, missing ${counts.missing}; deviations ${deviations}; user records ${facts.view.userRecords.length}`;

  const confirmation =
    complete ||
    facts.confirmationError === undefined ||
    facts.confirmationError === ""
      ? ""
      : `; confirmation unavailable: ${facts.confirmationError}`;

  return {
    ok: true,
    exit: 0,
    summary:
      (complete ? "complete: " : "") +
      summary +
      confirmation +
      (warning === undefined || warning === "" ? "" : `; ${warning}`),
    value: {
      ...resultValue(facts, relative),
      ...(diagnosticsPath !== undefined &&
        diagnosticsPath !== "" && { diagnostics: diagnosticsPath }),
      ...(warning !== undefined && warning !== "" && { warning }),
    },
    postFold: facts.fold,
  };
};

export const reportRender = async (ctx: HandlerContext) => {
  if (ctx.args.length) {
    throw new ToolError(
      1,
      "invalid-input",
      "report render takes no positional arguments"
    );
  }

  const diagnostics = diagnosticsEnabled(ctx.deps.skillRoot);

  const facts = await materialize(
    ctx,
    await capture(ctx, foldLedger(ctx.session))
  );

  return publishReport(ctx, facts, "rendered", diagnostics);
};

const refusal = (snapshot: Snapshot) => {
  if (
    snapshot.confirmationError !== undefined &&
    snapshot.confirmationError !== ""
  ) {
    return new ToolError(
      4,
      "review-confirmation-required",
      snapshot.confirmationError
    );
  }

  if (
    snapshot.rejectionConfirmations.some((state) => state.state !== "confirmed")
  ) {
    return new ToolError(
      4,
      "review-confirmation-required",
      "Rejected MUST findings need explicit reviewer confirmation"
    );
  }

  if (
    snapshot.integration === undefined ||
    snapshot.integrationPath === null ||
    snapshot.integrationPath === ""
  ) {
    return new ToolError(
      4,
      "no-integration",
      "No integration worktree is available"
    );
  }

  const missing = snapshot.statuses
    .filter((status) => status.state === "missing")
    .map((status) => status.criterion);

  const dirty =
    snapshot.current !== null &&
    snapshot.current.testedTree !== snapshot.current.headTree;

  if (missing.length) {
    return new ToolError(
      4,
      "criteria-unmet",
      `Missing criteria: ${missing.join(", ")}${dirty ? "; dirty checkout (integration tree differs from HEAD tree)" : ""}`
    );
  }

  if (!snapshot.deliveredAtHead) {
    return new ToolError(
      4,
      "undelivered",
      `No delivery record matches integration HEAD ${snapshot.head ?? "unknown"}`
    );
  }

  const { risk } = snapshot;
  const focus = latest(snapshot.fold, "focus");
  const bullets: unknown = focus?.data["bullets"];

  if (
    (risk === "med" || risk === "high") &&
    (!Array.isArray(bullets) || bullets.length < 3)
  ) {
    return new ToolError(
      4,
      "focus-required",
      "At least three review focus bullets are required for med- or high-risk plans"
    );
  }

  return null;
};

export const reportComplete = async (ctx: HandlerContext) => {
  if (ctx.args.length) {
    throw new ToolError(
      1,
      "invalid-input",
      "report complete takes no positional arguments"
    );
  }

  const captured = await withLedger(
    ctx.session,
    "report complete",
    ctx.deps,
    async (tx) => {
      const snapshot = await capture(ctx, tx.fold);

      return { snapshot, refusal: refusal(snapshot) };
    }
  );

  if (captured.refusal) {
    const { snapshot } = captured;

    const walkthroughPath = path.join(
      ctx.session,
      `${snapshot.planStem}.walkthrough.md`
    );

    return {
      ok: false,
      exit: captured.refusal.exit,
      reason: captured.refusal.reason,
      summary: captured.refusal.message,
      value: {
        path: path
          .relative(ctx.session, walkthroughPath)
          .split(path.sep)
          .join("/"),
        statuses: snapshot.statuses,
        reviewedCodeBaseline: snapshot.reviewedCodeBaseline,
        reviewFixes: snapshot.reviewFixes,
        reason: captured.refusal.reason,
        message: captured.refusal.message,
      },
    };
  }

  const facts = await materialize(ctx, captured.snapshot);

  return publishReport(
    ctx,
    facts,
    "complete",
    diagnosticsEnabled(ctx.deps.skillRoot)
  );
};
