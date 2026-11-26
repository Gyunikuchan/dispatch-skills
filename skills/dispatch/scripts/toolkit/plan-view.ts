import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Manifest } from "../lib/session.ts";
import { parsePlan, selectTaskBrief } from "./domain/plan.ts";
import { stableValue } from "./domain/stable-value.ts";
import type { ParsedPlan } from "./domain/types.ts";
import { foldLedger, latest } from "./ledger.ts";
import { textValue } from "./narrow.ts";
import { ToolError } from "./output.ts";

type CheckEvidenceClass =
  | ParsedPlan["criteria"][number]["evidence"]
  | "contract";

export interface Check {
  criterion: string;
  commands: string[];
  commandDigest: string;
  evidenceClass: CheckEvidenceClass;
}

export const commandDigest = (check: {
  criterion: string;
  commands: readonly string[];
}) =>
  `sha256:${crypto
    .createHash("sha256")
    .update(
      stableValue({ criterion: check.criterion, commands: check.commands })
    )
    .digest("hex")}`;

export const loadPlan = (session: string, manifest: Manifest) => {
  const bind = latest(foldLedger(session), "bind");

  // oxlint-disable-next-line typescript/strict-boolean-expressions -- bound plan path is a string when present; falsy covers absent and empty identically.
  if (!bind?.data["plan"]) {
    throw new ToolError(4, "lint-errors", "No bound plan");
  }

  const planPath = path.resolve(
    manifest.repositoryRoot,
    textValue(bind.data["plan"])
  );

  const parsed = parsePlan(fs.readFileSync(planPath, "utf-8"));

  if (!parsed.ok) {
    throw new ToolError(4, "lint-errors", JSON.stringify(parsed.defects));
  }

  return parsed.plan;
};

const selection = (plan: ParsedPlan, id: string) => {
  const brief = selectTaskBrief(plan, id);

  if (!brief) {
    const valid = plan.tasks.map((t) => t.id).join(", ");
    throw new ToolError(
      1,
      "invalid-input",
      `Unknown task ${id}${valid ? `; valid: ${valid}` : ""}`
    );
  }

  return brief;
};

export const taskCriteria = (plan: ParsedPlan, id: string) => [
  ...selection(plan, id).task.criteria,
];

export const ownedPaths = (plan: ParsedPlan, id: string) =>
  selection(plan, id).changes.map((c) => c.path);

type PlanValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | PlanValue[]
  | { [key: string]: PlanValue };

const stripPositions = (value: unknown): PlanValue => {
  if (Array.isArray(value)) {
    return value.map(stripPositions);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "line" && !/Lines?$/u.test(key))
        .map(([key, item]) => [key, stripPositions(item)])
    );
  }

  return value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
};

export const taskSection = (plan: ParsedPlan, id: string) => {
  const { task, changes, criteria } = selection(plan, id);

  return `sha256:${crypto
    .createHash("sha256")
    .update(stableValue(stripPositions({ task, changes, criteria })))
    .digest("hex")}`;
};

export const checks = (plan: ParsedPlan) => {
  const listed = new Set(
    plan.criteria.flatMap((c) => c.verify.map((v) => v.command))
  );

  const rows: Omit<Check, "commandDigest">[] = plan.criteria.map((c) => ({
    criterion: c.id,
    commands: c.verify.map((v) => v.command),
    evidenceClass: c.evidence,
  }));

  rows.push({
    criterion: "contract",
    commands: plan.verification.automated.filter((c) => !listed.has(c)),
    evidenceClass: "contract",
  });

  return rows.map((row) => ({ ...row, commandDigest: commandDigest(row) }));
};
