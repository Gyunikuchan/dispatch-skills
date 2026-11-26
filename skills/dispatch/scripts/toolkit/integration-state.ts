import type { Fold } from "./ledger.ts";
import { textValue } from "./narrow.ts";

export const integrationRecord = (fold: Fold) =>
  fold.records.findLast(
    (r) => r.kind === "integrate" && r.data["phase"] === "opened"
  );

export const integrationEnded = (fold: Fold, task: string, after: number) =>
  fold.records.some(
    (row) =>
      row.kind === "integrate" &&
      row.seq > after &&
      row.data["task"] === task &&
      (row.data["phase"] === "done" || row.data["phase"] === "abandoned")
  );

export const pendingIntegration = (fold: Fold) =>
  fold.records.findLast(
    (row) =>
      row.kind === "integrate" &&
      row.data["phase"] === "started" &&
      !integrationEnded(fold, textValue(row.data["task"]), row.seq)
  );

export const currentRuntimeVerification = (fold: Fold, openingSeq: number) => {
  const proof = fold.records.findLast(
    (row) =>
      row.seq > openingSeq &&
      row.kind === "integrate" &&
      row.data["phase"] === "verification"
  );

  const open: unknown = proof?.data["open"];

  if (!proof || !Array.isArray(open) || open.length) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps consistent-return satisfied across the early-exit and valued branches.
    return undefined;
  }

  const invalidated = fold.records.some(
    (row) =>
      row.seq > proof.seq &&
      row.kind === "ruling" &&
      textValue(row.data["subject"]).startsWith("verification:") &&
      row.data["ruling"] === "accepted"
  );

  return invalidated ? undefined : proof;
};
