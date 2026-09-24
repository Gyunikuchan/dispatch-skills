/**
 * Classifies a delegate report the way the driver does: `parsed` (0), `prose` (3, re-ask), or
 * `invalid` (1, content-free or schema-empty).
 */
import { parseRebuttal, parseReport } from '../../skills/dispatch/scripts/review/parse-report.mjs';
import { InvalidReviewReportError } from '../../skills/dispatch/scripts/review/report.mjs';

export function classifyReviewReport(kind, input, { rebuttalKeys = null } = {}) {
  try {
    const parsed = rebuttalKeys ? parseRebuttal(kind, input, rebuttalKeys) : parseReport(kind, input);
    return { status: 0, parsed, stderr: '' };
  } catch (err) {
    if (!(err instanceof InvalidReviewReportError)) throw err;
    const stderr = JSON.stringify({ error: err.prose ? 'prose-report' : 'invalid-report', diagnostics: err.diagnostics }, null, 2);
    return { status: err.prose ? 3 : 1, parsed: null, stderr };
  }
}
