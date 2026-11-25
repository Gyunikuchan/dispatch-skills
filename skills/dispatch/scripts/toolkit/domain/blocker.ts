import { createHash } from 'node:crypto';
import { sanitizeText } from './sanitize.ts';

export const BLOCKED_MARKER = 'BLOCKED:';

export const isBlockedReply = (text: string): boolean => text.startsWith(BLOCKED_MARKER);

type BlockedReply = { isBlocked: boolean; raw: string };
type FailureEvidence = { reason: string; reasonHash: string };

export function parseBlockedReply(text: string): BlockedReply {
  const trimmed = text.trim();
  const isBlocked = isBlockedReply(trimmed);
  return { isBlocked, raw: isBlocked ? trimmed.slice(BLOCKED_MARKER.length).trim() : trimmed };
}

export function failureReasonDisplay(raw: string): string {
  return sanitizeText(raw).slice(0, 200) || '(reason removed by sanitizer)';
}

/** Keep only the display-safe reason and an identity shared across reply surfaces. */
export function failureReasonEvidence(raw: string): FailureEvidence {
  return { reason: failureReasonDisplay(raw), reasonHash: createHash('sha256').update(raw).digest('hex') };
}
