// Frame projection: one JSON line per invocation on stdout (spec §4.6).

import { runPaths } from '../lib/session.ts';
import { validateHostEvent } from './validate.ts';
import type { Await, Frame, HostEvent, Machine } from './types.ts';

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
  const events = (awaitEnvelopes(frame.await, data) ?? []).filter((event) => validateHostEvent(frame.await, event, machine.validate ? (item) => machine.validate!(state, item) : undefined).ok);
  if (events.length) frame.events = events;
  // NOTE: the RULINGS example defaults intent findings to `needs-user`; the hint names the user-backed alternative shape.
  if (frame.await === 'rule' && rows(data['findings']).some((finding) => finding['category'] === 'intent')) frame.data = { ...frame.data, intentRuling: '{ ruling: accept|reject, quote: <user words> }' };
  if (frame.await === 'done' && typeof data['summary'] === 'string' && Buffer.byteLength(data['summary']) > 4096) frame.data = { ...data, summary: new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(data['summary']).subarray(0, 4000), { stream: true }) + ' [full captures referenced separately]' };
  if (error !== undefined) frame.error = error;
  return frame;
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
      const events: HostEvent[] = candidates.flatMap((task) => {
        const identity = { task: String(task['task']), attempt: Number(task['attempt']), signature: String(task['signature']), handle: String(task['handle']) };
        return [
          { type: 'WRITE_ENVELOPE', envelopePath: String(task['envelopePath'] ?? data['envelopePath']), ...identity },
          { type: 'WRITE_FAILED', model: String(task['model'] ?? data['model']), kind: '<observed failure class>', reason: '<observed failure>', ...identity },
          { type: 'WRITE_CANCELLED', reason: '<confirmed cancellation>', ...identity },
        ];
      });
      if (typeof data['envelopePath'] === 'string' && data['envelopePath']) events.push({ type: 'WRITE_ENVELOPE', envelopePath: data['envelopePath'] });
      if (typeof data['model'] === 'string' && data['model']) events.push({ type: 'WRITE_FAILED', model: data['model'], kind: '<observed failure class>', reason: '<observed failure>' });
      const launches = rows(data['tasks']).filter((task) => task['action'] === 'launch' && typeof task['task'] === 'string' && typeof task['signature'] === 'string' && Number.isSafeInteger(task['attempt']) && Number(task['attempt']) > 0);
      if (launches.length && data['stage'] !== 'scope-draining') events.push({ type: 'WRITE_LAUNCHED', tasks: launches.map((task) => ({ task: String(task['task']), attempt: Number(task['attempt']), signature: String(task['signature']), handle: typeof task['handle'] === 'string' && task['handle'] ? String(task['handle']) : '<host-assigned handle>', model: String(task['model'] ?? '<actual launched model>'), ...(typeof data['effort'] === 'string' && data['effort'] ? { effort: data['effort'] } : {}) })) });
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
        : kind === 'scope-deviation' ? { by: 'orchestrator', request: data['pendingProposal'], ruling: 'approve', rationale: '<adjudication against task intent and invariants>' }
        : kind === 'scope-deviation-user' ? { by: 'user', requestId: rows([data['pendingProposal']])[0]?.['requestId'], choice: 'accept', quote: '<actual user quote>' }
        : kind === 'run-stop' ? { by: 'user', quote: '<actual user quote>' } : 'stop';
      const examples: HostEvent[] = [];
      if (typeof kind === 'string') examples.push({ type: 'DECISION', kind, answer } as HostEvent);
      if (data['stopAllowed'] === true && kind !== 'run-stop') examples.push({ type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: '<actual user quote>' } });
      return kind === 'approval' ? [{ type: 'DECISION', kind, answer: { by: 'user', quote: '<actual user quote>', ...(typeof data['hash'] === 'string' ? { hash: data['hash'] } : {}) } }, { type: 'DECISION', kind, answer: 'stop' }] : examples;
    }
    case 'retro': return [{ type: 'RETRO', observations: [] }];
    case 'done': return [];
  }
}
