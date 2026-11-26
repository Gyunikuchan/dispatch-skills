import { createHash } from "node:crypto";

import { sanitizeText } from "./sanitize.ts";

export const BLOCKED_MARKER = "BLOCKED:";

export const isBlockedReply = (text: string) => text.startsWith(BLOCKED_MARKER);

export const parseBlockedReply = (text: string) => {
  const trimmed = text.trim();
  const isBlocked = isBlockedReply(trimmed);

  return {
    isBlocked,
    raw: isBlocked ? trimmed.slice(BLOCKED_MARKER.length).trim() : trimmed,
  };
};

export const failureReasonDisplay = (raw: string) =>
  sanitizeText(raw).slice(0, 200) || "(reason removed by sanitizer)";

/** Keep only the display-safe reason and an identity shared across reply surfaces. */
export const failureReasonEvidence = (raw: string) => ({
  reason: failureReasonDisplay(raw),
  reasonHash: createHash("sha256").update(raw).digest("hex"),
});
