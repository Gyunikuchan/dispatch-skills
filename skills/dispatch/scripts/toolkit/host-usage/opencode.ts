import { opencodeDbPath } from '../../lib/opencode-db.ts';
import { note, stageAt } from './read.ts';
import type { HostUsageAdapter, HostUsageFs, HostUsageQuery, HostUsageResult, HostUsageRow } from './types.ts';

export const opencode: HostUsageAdapter = {
  sessionEnv: ['OPENCODE_SESSION_ID'],
  read(query, fs) {
    return collect(query, fs);
  },
};

function collect(query: HostUsageQuery, fs: HostUsageFs): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} };
  const notes = result.notes!;
  if (!fs.opencodeMessages) return { rows: [], unavailable: 'read-error:EUNKNOWN' };

  const dbPath = opencodeDbPath(query.home, query.env);
  const read = fs.opencodeMessages(dbPath, query.sessionId, { fromMs: query.startMs, toMs: query.endMs });

  for (const message of read.messages) {
    const row: HostUsageRow = {
      stage: stageAt(query.stages, message.createdMs),
      role: message.depth === 0 ? 'host' : 'subagent',
      // Empty parts fail the report gates and render as `—` without another label.
      model: message.model ?? '',
      effort: message.effort,
      input: message.input,
      output: message.output,
    };
    if (message.cacheRead !== undefined) row.cacheRead = message.cacheRead;
    if (message.cacheWrite !== undefined) row.cacheWrite = message.cacheWrite;
    if (message.reasoning !== undefined) row.reasoning = message.reasoning;
    result.rows.push(row);
  }

  // The reader sums skipped messages across the root and its descendants without a role split.
  if (read.skipped > 0) note(notes, 'host', 'unparsed lines', read.skipped);
  if (read.truncated === 'rows') note(notes, 'host', 'read budget reached');
  if (read.truncated === 'sessions') note(notes, 'subagent', 'too many candidates');
  if (read.messages.length === 0) result.unavailable = 'no usage records';
  return result;
}
