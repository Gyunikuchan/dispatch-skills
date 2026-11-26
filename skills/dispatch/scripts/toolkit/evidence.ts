import type { PlanCriterion } from "./domain/types.ts";
import type { Fold } from "./ledger.ts";
import { stringList, stringMap, textValue } from "./narrow.ts";
import type { Check } from "./plan-view.ts";

/** Criteria whose tests a cleanup commit removed keep their evidence at their recorded tree. */
interface CleanupBinding {
  from: string;
  fromTree: string;
  removed: string[];
  trees: Record<string, string>;
}

type CleanupEvidenceResult =
  | { ok: true; trees: Record<string, string> }
  | { ok: false; stale: string[] };

interface CurrentTree {
  headTree: string;
  testedTree: string;
}

export interface CriterionStatus {
  criterion: string;
  state: "verified" | "manual" | "waived" | "missing";
  seq?: number;
  quote?: string;
  evidence?: string;
  reason?: string;
}

export const strictEvidence = (fold: Fold, check: Check) => {
  if (check.evidenceClass === "review") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the review-class and row branches.
    return undefined;
  }

  const row = fold.records.findLast(
    (r) =>
      r.kind === "evidence" &&
      r.data["criterion"] === check.criterion &&
      r.data["commandDigest"] === check.commandDigest
  );

  return row &&
    row.data["exit"] === 0 &&
    row.data["clean"] === true &&
    row.data["before"] === row.data["after"] &&
    typeof row.data["tree"] === "string" &&
    row.data["tree"]
    ? row
    : undefined;
};

const normalizePath = (value: string) =>
  value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");

export const matchesDeclared = (
  diffPath: string,
  declared: readonly string[]
) => {
  const target = normalizePath(diffPath);

  return declared.some((entry) => {
    const base = normalizePath(entry);

    return !!base && (target === base || target.startsWith(`${base}/`));
  });
};

/** Cleanup evidence rule: latest clean passing evidence per criterion, with no declared-own or undeclared path changes since that tree. */
export const cleanupEvidence = (
  fold: Fold,
  checks: readonly Check[],
  criteria: readonly Pick<PlanCriterion, "id" | "changes" | "tests">[],
  removed: readonly string[],
  fromTree: string,
  diffs: ReadonlyMap<string, readonly string[]>
): CleanupEvidenceResult => {
  const checkById = new Map(checks.map((check) => [check.criterion, check]));

  const criterionById = new Map(
    criteria.map((criterion) => [criterion.id, criterion])
  );

  const allDeclared = criteria.flatMap((criterion) => [
    ...criterion.changes,
    ...criterion.tests,
  ]);

  const trees: Record<string, string> = {};
  const stale: string[] = [];

  for (const id of removed) {
    const criterion = criterionById.get(id);
    const check = checkById.get(id);
    const record = criterion && check ? strictEvidence(fold, check) : undefined;

    if (!criterion || !record) {
      stale.push(id);
      continue;
    }

    // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
    const tree = String(record.data["tree"]);

    if (tree === fromTree) {
      trees[id] = tree;
      continue;
    }

    const changed = diffs.get(tree);

    if (!changed) {
      stale.push(id);
      continue;
    }

    const own = [...criterion.changes, ...criterion.tests];

    if (
      changed.some(
        (file) =>
          matchesDeclared(file, own) || !matchesDeclared(file, allDeclared)
      )
    ) {
      stale.push(id);
      continue;
    }

    trees[id] = tree;
  }

  return stale.length ? { ok: false, stale } : { ok: true, trees };
};

const eligibleEvidence = (fold: Fold, check: Check, current: CurrentTree) => {
  if (check.evidenceClass === "review") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the review-class and row branches.
    return undefined;
  }

  if (current.testedTree !== current.headTree) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the untested and row branches.
    return undefined;
  }

  const row = strictEvidence(fold, check);

  return row && row.data["tree"] === current.headTree ? row : undefined;
};

export const eligibility = (
  fold: Fold,
  checks: readonly Check[],
  current: CurrentTree
) =>
  checks.map((check) => ({
    criterion: check.criterion,
    state: eligibleEvidence(fold, check, current)
      ? ("verified" as const)
      : ("missing" as const),
  }));

export const latestCleanup = (fold: Fold) =>
  fold.records.findLast(
    (r) => r.kind === "integrate" && r.data["phase"] === "test-cleanup"
  );

export const cleanupBinding = (fold: Fold) => {
  const record = latestCleanup(fold);

  return record
    ? {
        from: textValue(record.data["from"]),
        fromTree: textValue(record.data["fromTree"]),
        removed: stringList(record.data["removed"]),
        trees: stringMap(record.data["trees"] ?? {}),
      }
    : null;
};

const boundEvidence = (
  fold: Fold,
  check: Check,
  current: CurrentTree | null,
  cleanup: CleanupBinding | null | undefined
) => {
  const row = current ? eligibleEvidence(fold, check, current) : undefined;

  if (row || cleanup?.removed.includes(check.criterion) !== true) {
    return row;
  }

  const tree = Object.hasOwn(cleanup.trees, check.criterion)
    ? cleanup.trees[check.criterion]
    : undefined;

  if (tree === undefined || tree === "") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the missing-tree and evidence branches.
    return undefined;
  }

  return eligibleEvidence(fold, check, { headTree: tree, testedTree: tree });
};

export const verifiedStage = (
  fold: Fold,
  checks: readonly Check[],
  current: CurrentTree,
  cleanup?: CleanupBinding | null
) =>
  checks
    .filter((check) => check.evidenceClass !== "review")
    .every((check) => !!boundEvidence(fold, check, current, cleanup));

export const criterionStatuses = (
  fold: Fold,
  checks: readonly Check[],
  current: CurrentTree | null,
  cleanup?: CleanupBinding | null
): CriterionStatus[] =>
  checks.map((check) => {
    const evidence = boundEvidence(fold, check, current, cleanup);

    if (evidence) {
      return {
        criterion: check.criterion,
        state: "verified",
        ...(cleanup?.removed.includes(check.criterion) === true && {
          reason: `verified at ${
            cleanup.trees[check.criterion]
          }; tests removed in cleanup`,
        }),
        ...(typeof evidence.data["path"] === "string" && {
          evidence: evidence.data["path"],
        }),
      };
    }

    const manual = fold.records.findLast(
      (record) =>
        record.kind === "manual-complete" &&
        record.data["criterion"] === check.criterion
    );

    if (manual) {
      return {
        criterion: check.criterion,
        state: "manual",
        seq: manual.seq,
        ...(typeof manual.quote === "string" && { quote: manual.quote }),
        ...(typeof manual.data["evidence"] === "string" && {
          evidence: manual.data["evidence"],
        }),
      };
    }

    const waiver = fold.records.findLast(
      (record) =>
        record.kind === "waiver" && record.data["criterion"] === check.criterion
    );

    if (waiver) {
      return {
        criterion: check.criterion,
        state: "waived",
        seq: waiver.seq,
        ...(typeof waiver.quote === "string" && { quote: waiver.quote }),
        ...(typeof waiver.data["reason"] === "string" && {
          reason: waiver.data["reason"],
        }),
      };
    }

    return { criterion: check.criterion, state: "missing" };
  });

export const criterionStatusCounts = (
  statuses: readonly CriterionStatus[]
) => ({
  verified: statuses.filter((status) => status.state === "verified").length,
  manual: statuses.filter((status) => status.state === "manual").length,
  waived: statuses.filter((status) => status.state === "waived").length,
  missing: statuses.filter((status) => status.state === "missing").length,
});
