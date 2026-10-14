// Frame projection: one JSON line per invocation on stdout (spec §4.6).

import { runPaths } from '../lib/session.ts';
import { validateHostEvent } from './validate.ts';
import type { Await, DryRunVerdict, Frame, HostEvent, Machine } from './types.ts';
import type { Effect } from './types.ts';
import { descriptorHash } from './effect-recovery.ts';

export function recoveryFrame<S>(machine: Machine<S>, state: S, runRel: string, effect: Effect, attempt: number, evidence: string, runDir = runRel): Frame {
  const frame = projectFrame(machine, state, runRel);
  return { ...frame, at: `${frame.at} › effect recovery`, await: 'decide', events: [], data: { ...frame.data, kind: 'effect-recovery', effect, attempt, evidence,
    limits: 'No terminal result can be asserted. Retry can duplicate an external effect; stop retains artifacts and records failure.',
    recoveryReply: { type: 'EFFECT_RECOVERY', effectId: effect.id, attempt, descriptorHash: descriptorHash(effect, runDir), action: 'retry|stop', rationale: '<completion evidence and disposition rationale>' } } };
}

/** With a boundary seq, names `events/<seq>-<await>.json`; a rejected event and diagnostics notes keep the seq, so a rewrite reuses the path. */
export function replyTemplate(runRel: string, boundary?: { seq: number; awaiting: string }): string {
  const file = boundary ? runPaths(runRel).event(boundary.seq, boundary.awaiting).replace(/\\/g, '/') : '<event-file>';
  // NOTE: `@<file>` sidesteps JSON quoting differences across bash, zsh, and PowerShell.
  return `node <skills-dir>/dispatch/scripts/dispatch.ts send --run ${runRel} --event @${file}`;
}

export function projectFrame<S>(machine: Machine<S>, state: S, runRel: string, error?: string, seq?: number): Frame {
  const { at, data } = machine.project(state);
  const awaiting = machine.awaitOf(state) ?? 'done';
  const frame: Frame = { v: 1, run: runRel, at, await: awaiting, data, reply: replyTemplate(runRel, seq !== undefined && awaiting !== 'done' ? { seq, awaiting } : undefined) };
  const events = [...awaitEnvelopes(frame.await, data), ...reviewUseExamples(data)].filter((event) => validateHostEvent(frame.await, event, machine.validate ? (item) => machine.validate!(state, item) : undefined).ok);
  if (events.length) frame.events = events;
  // NOTE: intent examples default to `needs-user`; alternative rulings require actual authority evidence.
  if (frame.await === 'rule' && rows(data['findings']).some((finding) => finding['category'] === 'intent')) frame.data = { ...frame.data, intentRuling: 'needs-user; { ruling: accept|reject, quote: <user words> }; { ruling: accept|reject, by: orchestrator, reason: <settled decision> }' };
  if (frame.await === 'rule') frame.data = { ...frame.data, fixScope: 'Example locus paths are suggestions. Declare every production, test, fixture, helper edit and verification-generated output before sending RULINGS.' };
  // NOTE: observations are advisory; the hint shows the optional metadata a normal reply may carry.
  if (frame.await !== 'done' && rows(data['observations']).length) frame.data = { ...frame.data, changeDispositions: 'Optional on this reply: [{ observationId, afterHash, rationale, retain?: [criterion ids], refresh?: [criterion ids] }]. Observations never block progress.' };
  if (frame.await === 'done' && typeof data['summary'] === 'string' && Buffer.byteLength(data['summary']) > 4096) frame.data = { ...data, summary: new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(data['summary']).subarray(0, 4000), { stream: true }) + ' [full captures referenced separately]' };
  if (error !== undefined) frame.error = error;
  return frame;
}

/** Read-only guidance uses the same validated examples and boundary path as live rejection. */
export function dryRunGuidance<S>(machine: Machine<S>, state: S, runRel: string, seq?: number): Pick<DryRunVerdict, 'events' | 'reply'> {
  const frame = projectFrame(machine, state, runRel, undefined, seq);
  return { events: frame.events ?? [], reply: frame.reply };
}

const placeholder = (value: unknown): boolean => typeof value === 'string' ? /^<.*>$/.test(value)
  : Array.isArray(value) ? value.some(placeholder) : !!value && typeof value === 'object' && Object.values(value).some(placeholder);

/** The sole suggested event when it needs no host edit; several alternatives or any `<...>` placeholder leave the reply to the host. */
export function replyEvent(events: readonly HostEvent[] | undefined): HostEvent | undefined {
  return events?.length === 1 && !placeholder(events[0]) ? events[0] : undefined;
}

export function faultFrame(runRel: string, error: string): Frame {
  return { v: 1, run: runRel, at: 'fault', await: 'done', data: { outcome: 'fault' }, reply: replyTemplate(runRel), error: oneLine(error) };
}

export function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}


type Row = Readonly<Record<string, unknown>>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === 'object') : [];

const amendExample = (task: string): HostEvent => ({
  type: 'AMEND', delta: [{ kind: 'modify', target: '<task, criterion, command, or path>', current: '<current text>', proposed: '<proposed text>' }],
  notify: [{ task, notice: '<what changed for this writer>' }], rationale: '<why the plan changes>',
});

// NOTE: a whole-file revision names the bound plan hash and every task's reconciliation, so the driver never infers intent.
const replaceExample = (task: string): HostEvent => ({
  type: 'REPLACE_PLAN', path: '<new plan file in the session folder>', expectedHash: '<bound plan hash>', rationale: '<why the plan changes>',
  notify: [{ task, notice: '<what changed for this writer>' }],
  reconciliation: { retained: ['<unchanged task>'], changed: [task], added: [], retired: [], intentChanged: false, dependencyChanged: false },
});

/** Optional applicability selection for the first unassessed review observation; the host supplies the rationale. */
function reviewUseExamples(data: Row): HostEvent[] {
  const open = rows(data['reviewObservations']).find((row) => !row['use']);
  if (!open) return [];
  const binding = { observationId: String(open['id']), afterHash: String(open['afterHash']) };
  return [
    { type: 'REVIEW_USE', ...binding, action: 'reuse', rationale: '<why the recorded findings apply to the current target>' },
    { type: 'REVIEW_USE', ...binding, action: 'targeted', rationale: '<why these paths need review>', paths: ['<changed path to review>'] },
  ];
}

/** Fill runtime paths/ids from the current frame; quotes and observations require actual host evidence. */
export function awaitEnvelopes(current: Await, data: Row): HostEvent[] {
  switch (current) {
    case 'author': return typeof data['path'] === 'string' && data['path'].trim() ? [{ type: 'AUTHORED', path: data['path'] }] : [];
    case 'native': return [{ type: 'NATIVE_RESULTS', slots: rows(data['slots']).map((slot) => ({ slot: String(slot['substitutesFor'] ?? slot['sourceKey']), sourceKey: slot['sourceKey'], outputPath: slot['outputPath'], mapping: { configuredModel: slot['model'], launcherModel: slot['model'] ?? '<actual launched model>', ...(slot['reasoningEffort'] ? { launcherEffort: slot['reasoningEffort'] } : {}), provider: '<host provider>' } })) }];
    case 'rule': {
      // NOTE: artifact loci are section headings, so artifact reviews name the reviewed file instead.
      const fixTarget = typeof data['fixTarget'] === 'string' && data['fixTarget'] ? data['fixTarget'] : null;
      return [{ type: 'RULINGS', rulings: Object.fromEntries(rows(data['findings']).map((finding) => [String(finding['id']), { ruling: finding['category'] === 'intent' ? 'needs-user' : 'accept', fix: { affectedPaths: [fixTarget ?? String(finding['locus']).replace(/:L\d+.*$/, '')], dependsOn: [], verification: [] } }])) }];
    }
    case 'fix': return [{ type: 'FIXES_APPLIED', clusters: rows(data['clusters']).map((cluster) => ({ clusterId: cluster['clusterId'], status: 'applied', affectedPaths: cluster['affectedPaths'] })) }];
    case 'write': {
      const candidates = rows(data['tasks']).filter((task) => typeof task['task'] === 'string' && Number.isSafeInteger(task['attempt']) && Number(task['attempt']) > 0 && typeof task['signature'] === 'string' && typeof task['handle'] === 'string' && task['handle']);
      const effort = typeof data['effort'] === 'string' && data['effort'] ? { effort: data['effort'] } : {};
      const events: HostEvent[] = candidates.flatMap((task) => {
        const identity = { task: String(task['task']), attempt: Number(task['attempt']), signature: String(task['signature']), handle: String(task['handle']) };
        const model = String(task['model'] ?? data['model'] ?? '<actual launched model>');
        return [
          { type: 'WRITE_RECEIPT', status: 'submitted', ...identity, envelopePath: String(task['envelopePath'] ?? data['envelopePath']), briefHash: typeof task['briefHash'] === 'string' && task['briefHash'] ? task['briefHash'] : '<brief hash the writer echoes>', model, ...effort },
          { type: 'WRITE_RECEIPT', status: 'failed', ...identity, detail: '<observed failure>', model, ...effort },
          { type: 'WRITE_RECEIPT', status: 'cancelled', ...identity },
          { type: 'REQUEST', task: identity.task, attempt: identity.attempt, need: '<what the writer needs>', paths: ['<requested path>'], rationale: '<writer rationale>' },
        ];
      });
      if (typeof data['envelopePath'] === 'string' && data['envelopePath']) events.push({ type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: data['envelopePath'] });
      if (typeof data['model'] === 'string' && data['model']) events.push({ type: 'WRITE_RECEIPT', status: 'failed', detail: '<observed failure>', model: data['model'] });
      const launches = rows(data['tasks']).filter((task) => task['action'] === 'launch' && typeof task['task'] === 'string' && typeof task['signature'] === 'string' && Number.isSafeInteger(task['attempt']) && Number(task['attempt']) > 0);
      for (const task of launches) events.push({ type: 'WRITE_RECEIPT', status: 'launched', task: String(task['task']), attempt: Number(task['attempt']), signature: String(task['signature']), handle: typeof task['handle'] === 'string' && task['handle'] ? String(task['handle']) : '<host-assigned handle>', model: String(task['model'] ?? '<actual launched model>'), ...effort });
      // Only live writers can be told about an amendment, so the example needs one to notify.
      if (candidates.length) events.push(amendExample(String(candidates[0]!['task'])), replaceExample(String(candidates[0]!['task'])));
      return events;
    }
    case 'evidence': return [{ type: 'EVIDENCE', criteria: Object.fromEntries(rows(data['criteria']).map((criterion) => [String(criterion['id']), { outcome: 'pass', evidence: '<observed criterion evidence>' }])) }];
    case 'decide': {
      const kind = data['kind'] as Extract<HostEvent, { type: 'DECISION' }>['kind'];
      const items = Array.isArray(data['items']) ? data['items'] : [];
      const notice = rows([data['notice']])[0];
      const answer = kind === 'opt-in' ? [] : kind === 'drift' ? { by: 'orchestrator', noticeId: notice?.['id'] ?? '<current notice id>', afterHash: notice?.['afterHash'] ?? '<current after hash>', action: '<preserve|refresh|reconcile|escalate>', rationale: '<observed intent and dependency evidence>', evidenceIds: notice?.['affectedEvidence'] ?? [] }
        : kind === 'needs-user' ? typeof items[0] === 'string' ? { decision: 'stop', by: 'user', quote: '<actual user quote>' } : Object.fromEntries(rows(items).map((item) => [String(item['id']), { ruling: 'accept', quote: '<actual user quote>' }]))
        : kind === 'concerns' ? { decision: 'stop', by: 'user', quote: '<actual user quote>' }
        : kind === 'level-classification' ? { evaluatedLevel: 'medium', rationale: '<concrete scope and risk evidence>', gateScope: data['gateScope'] }
        : kind === 'level-recommendation' ? { choice: 'adopt', quote: '<actual user quote>' }
        : kind === 'integration-conflict' ? { by: 'orchestrator', action: 'resolve', rationale: '<resolution against the intent and criteria of both tasks>' }
        : kind === 'request' ? { by: 'orchestrator', action: 'approve', rationale: '<ruling against task intent and invariants>' }
        : kind === 'request-user' ? { by: 'user', requestId: data['requestId'] ?? rows([data['request']])[0]?.['requestId'], choice: 'accept', quote: '<actual user quote>' }
        : kind === 'failure' ? { by: 'orchestrator', action: 'retry', rationale: '<observed root cause and the change that addresses it>' }
        : kind === 'run-stop' ? { by: 'user', quote: '<actual user quote>' } : 'stop';
      const examples: HostEvent[] = [];
      if (typeof kind === 'string') examples.push({ type: 'DECISION', kind, answer } as HostEvent);
      // An approved request usually lands as a plan amendment; the target writer is the requester.
      if (kind === 'request') examples.push(amendExample(String(rows([data['request']])[0]?.['task'] ?? '<requesting task>')));
      if (data['stopAllowed'] === true && kind !== 'run-stop') examples.push({ type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: '<actual user quote>' } });
      return kind === 'approval' ? [{ type: 'DECISION', kind, answer: { by: 'user', quote: '<actual user quote>', ...(typeof data['hash'] === 'string' ? { hash: data['hash'] } : {}) } }, { type: 'DECISION', kind, answer: 'stop' }] : examples;
    }
    case 'retro': return [{ type: 'RETRO', observations: [] }];
    case 'done': return [];
  }
}
