import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Fold } from "./ledger.ts";
import type { RecoverySelection } from "./review-state.ts";

export interface HandlerResult {
  ok: boolean;
  summary: string;
  value: unknown;
  exit: number;
  reason?: string;
  step?: string;
  postFold?: Fold;
  recoverySelection?: RecoverySelection;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  path: string | null;
  reason?: string;
  step?: string;
  help?: string;
  hint?: string;
  exit: number;
}

export class ToolError extends Error {
  readonly exit: number;
  readonly reason: string;
  readonly step: string | undefined;
  constructor(exit: number, reason: string, message: string, step?: string) {
    super(message);
    this.name = "ToolError";
    this.exit = exit;
    this.reason = reason;
    this.step = step;
  }
}

export const result = (value: unknown, postFold?: Fold) => ({
  ok: true,
  value,
  exit: 0,
  summary: JSON.stringify(value),
  ...(postFold && { postFold }),
});

export function refuse(reason: string, message = reason): never {
  throw new ToolError(4, reason, message);
}

export const capSummary = (text: string) => {
  if (Buffer.byteLength(text, "utf-8") <= 1024) {
    return text;
  }

  let clipped = "";
  let bytes = 3;

  for (const point of text) {
    const size = Buffer.byteLength(point, "utf-8");

    if (bytes + size > 1024) {
      break;
    }

    clipped += point;
    bytes += size;
  }

  return `${clipped}…`;
};

// Counts stay in `head` so a truncated list never hides totals; the omission notice is budgeted before any item.
const SUMMARY_ITEM_LIMIT = 5;
const SUMMARY_ITEM_BYTES = 200;

export const clipBytes = (text: string, max: number) => {
  if (Buffer.byteLength(text, "utf-8") <= max) {
    return text;
  }

  let clipped = "";
  let bytes = Buffer.byteLength("…", "utf-8");

  for (const point of text) {
    const size = Buffer.byteLength(point, "utf-8");

    if (bytes + size > max) {
      break;
    }

    clipped += point;
    bytes += size;
  }

  return `${clipped}…`;
};

// A combined action names the failing step first; the CLI adds this prefix to the handler summary.
export const stepPrefix = (step: string) => `${step}: `;

/** `reserve` leaves room for text the caller adds before the 1,024 B cap applies. */
export const summaryWithItems = (
  head: string,
  items: readonly string[],
  reserve = 0
) => {
  if (!items.length) {
    return head;
  }

  const clipped = items.map((item) => clipBytes(item, SUMMARY_ITEM_BYTES));

  for (
    let shown = Math.min(SUMMARY_ITEM_LIMIT, clipped.length);
    shown > 0;
    shown -= 1
  ) {
    const omitted = clipped.length - shown;

    const text = `${head}; first ${shown}: ${clipped
      .slice(0, shown)
      .join("; ")}${omitted > 0 ? `; +${omitted} more in result` : ""}`;

    if (Buffer.byteLength(text, "utf-8") + reserve <= 1024) {
      return text;
    }
  }

  return head;
};

export const writePrivateOutput = (
  target: string,
  text: string,
  flag: "w" | "wx" = "w"
) => {
  const temp = `${target}.${crypto.randomUUID()}.tmp`;

  try {
    fs.writeFileSync(temp, text, { flag, mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
};

export const writeResult = (
  session: string,
  tool: string,
  action: string,
  value: unknown
) => {
  const directory = path.join(path.resolve(session), ".state", "results");
  fs.mkdirSync(directory, { recursive: true });

  const target = path.join(
    directory,
    `${tool}-${action}-${crypto.randomUUID()}.json`
  );

  writePrivateOutput(target, `${JSON.stringify(value, null, 2)}\n`, "wx");

  return target;
};
