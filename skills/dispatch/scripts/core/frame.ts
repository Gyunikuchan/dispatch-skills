// Frame projection: one JSON line per invocation on stdout (spec §4.6).

import { validateHostEvent } from './validate.ts';
import type { Await, Frame, HostEvent, Machine } from './types.ts';

export function replyTemplate(runRel: string): string {
  // NOTE: `@<file>` sidesteps JSON quoting differences across bash, zsh, and PowerShell.
  return `node <skills-dir>/dispatch/scripts/dispatch.ts send --run ${runRel} --event @<event-file>`;
}

export function projectFrame<S>(machine: Machine<S>, state: S, runRel: string, error?: string): Frame {
  const { at, data } = machine.project(state);
  const frame: Frame = { v: 1, run: runRel, at, await: machine.awaitOf(state) ?? 'done', data, reply: replyTemplate(runRel) };
  const events = awaitEnvelopes(frame.await, data).filter((event) => validateHostEvent(frame.await, event, machine.validate ? (item) => machine.validate!(state, item) : undefined).ok);
  if (events.length) frame.events = events;
  if (frame.await === 'done' && typeof data['summary'] === 'string' && Buffer.byteLength(data['summary']) > 4096) frame.data = { ...data, summary: new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(data['summary']).subarray(0, 4000), { stream: true }) + ' [full captures referenced separately]' };
  if (error !== undefined) frame.error = error;
  return frame;
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
    case 'native': return [{ type: 'NATIVE_RESULTS', slots: rows(data['slots']).map((slot) => ({ slot: String(slot['substitutesFor'] ?? slot['sourceKey']), sourceKey: slot['sourceKey'], outputPath: slot['outputPath'], mapping: { configuredModel: slot['model'], launcherModel: '<actual launched model>', provider: '<host provider>' } })) }];
    case 'rule': return [{ type: 'RULINGS', rulings: Object.fromEntries(rows(data['findings']).map((finding) => [String(finding['id']), { ruling: finding['category'] === 'intent' ? 'needs-user' : 'accept', fix: { affectedPaths: [String(finding['locus']).replace(/:L\d+.*$/, '')], dependsOn: [], verification: [] } }])) }];
    case 'fix': return [{ type: 'FIXES_APPLIED', clusters: rows(data['clusters']).map((cluster) => ({ clusterId: cluster['clusterId'], status: 'applied', affectedPaths: cluster['affectedPaths'] })) }];
    case 'write': return [{ type: 'WRITE_ENVELOPE', envelopePath: String(data['envelopePath']) }, { type: 'WRITE_FAILED', model: String(data['model']), kind: '<observed failure class>', reason: '<observed failure>' }];
    case 'evidence': return [{ type: 'EVIDENCE', criteria: Object.fromEntries(rows(data['criteria']).map((criterion) => [String(criterion['id']), { outcome: 'pass', evidence: '<observed criterion evidence>' }])) }];
    case 'decide': {
      const kind = data['kind'] as Extract<HostEvent, { type: 'DECISION' }>['kind'];
      const items = Array.isArray(data['items']) ? data['items'] : [];
      const answer = kind === 'opt-in' ? [] : kind === 'drift' ? Object.fromEntries(items.map((item) => [String(item), 'stop']))
        : kind === 'needs-user' ? typeof items[0] === 'string' ? { decision: 'stop', by: 'user', quote: '<actual user quote>' } : Object.fromEntries(rows(items).map((item) => [String(item['id']), '<actual user ruling>']))
        : kind === 'concerns' ? { decision: 'stop', by: 'user', quote: '<actual user quote>' } : 'stop';
      return kind === 'approval' ? [{ type: 'DECISION', kind, answer: { by: 'user', quote: '<actual user quote>', ...(typeof data['hash'] === 'string' ? { hash: data['hash'] } : {}) } }, { type: 'DECISION', kind, answer: 'stop' }] : [{ type: 'DECISION', kind, answer }];
    }
    case 'done': return [];
  }
}
