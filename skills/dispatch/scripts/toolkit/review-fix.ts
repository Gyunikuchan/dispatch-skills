import crypto from 'node:crypto';
import { stableValue } from './domain/stable-value.ts';
import { validateReviewFix } from './records.ts';
import type { ReviewFix } from './records.ts';
import { ToolError } from './output.ts';
import { present } from './narrow.ts';

type ReviewFixIdentity = { digest: string; data: string };
export function reviewFixIdentity(value: ReviewFix): ReviewFixIdentity {
  const canonical = stableValue(value);
  return {
    digest: 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex'),
    data: Buffer.from(canonical).toString('base64url'),
  };
}
const FIX_DATA = 'Dispatch-Review-Fix-Data: ';
// NOTE: commitlint config-conventional caps body and footer lines at 100 characters, so the data trailer repeats in ordered chunks.
export const dataTrailers = (prefix: string, data: string): Array<string> =>
  (data.match(new RegExp(`.{1,${100 - prefix.length}}`, 'g')) ?? []).map((chunk) => prefix + chunk);
export const reviewFixTrailers = (value: ReviewFix, { digest, data } = reviewFixIdentity(value)): string =>
  ['Dispatch-Review-Fix: ' + digest, ...dataTrailers(FIX_DATA, data)].join('\n');
export function reviewFixFromCommit(message: string): ReviewFix | undefined {
  const digests = message.split(/\r?\n/).filter((line) => line.startsWith('Dispatch-Review-Fix: '));
  const values = message.split(/\r?\n/).filter((line) => line.startsWith(FIX_DATA));
  if (!digests.length && !values.length) {
    return undefined;
  }
  if (digests.length !== 1 || !values.length) {
    throw new ToolError(1, 'invalid-review-fix', 'Expected one correction digest and its metadata trailers');
  }
  const digest = present(digests[0], 'the correction digest').slice('Dispatch-Review-Fix: '.length);
  const encoded = values.map((line) => line.slice(FIX_DATA.length)).join('');
  try {
    const parsed = validateReviewFix(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (digest !== reviewFixIdentity(parsed).digest) {
      throw new Error('Correction digest mismatch');
    }
    return parsed;
  } catch {
    throw new ToolError(1, 'invalid-review-fix', 'Correction metadata is malformed or differs from its digest');
  }
}
