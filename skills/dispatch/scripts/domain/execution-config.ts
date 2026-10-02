import type { ExecutionConfigUpdated, RunStartedEvent, ModelLevels } from '../core/types.ts';

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const stable = (v: unknown): string => JSON.stringify(v, (_k, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

/** Model values may change; level keys and all routing/sandbox policy remain bound. */
function topology(config: Readonly<Row>): unknown {
  const read = Object.fromEntries(Object.entries(row(config['read-delegates'])).map(([provider, value]) => {
    const delegate = row(value);
    return [provider, { ...delegate, targets: (delegate['targets'] as unknown[]).map((levels) => Object.keys(row(levels)).sort()) }];
  }));
  const write = Object.fromEntries(Object.entries(row(config['write-subagents'])).map(([provider, levels]) => [provider, Object.keys(row(levels)).sort()]));
  return { read, write, phases: config['phases'] ?? {} };
}
export const executionTopology = (config: Readonly<Row>): string => stable(topology(config));

export function executionDelta(current: Readonly<Row>, next: Readonly<Row>): ExecutionConfigUpdated['delta'] {
  if (executionTopology(current) !== executionTopology(next)) throw new Error('execution-config-topology: provider, target, level, policy and sandbox changes require a new run');
  const delta: ExecutionConfigUpdated['delta'] = { read: [], write: [] };
  for (const [provider, value] of Object.entries(row(next['read-delegates']))) {
    const before = row(row(current['read-delegates'])[provider])['targets'] as unknown[];
    (row(value)['targets'] as unknown[]).forEach((levels, index) => {
      if (stable(before[index]) !== stable(levels)) delta.read.push({ slot: `${provider}[${index}]`, provider, levels: structuredClone(levels) as ModelLevels });
    });
  }
  for (const [provider, levels] of Object.entries(row(next['write-subagents']))) {
    if (stable(row(current['write-subagents'])[provider]) !== stable(levels)) delta.write.push({ provider, levels: structuredClone(levels) as ModelLevels });
  }
  return delta;
}

export function applyExecutionConfig(config: Readonly<Row>, delta: ExecutionConfigUpdated['delta']): Row {
  const next = structuredClone(config);
  for (const change of delta.read) {
    const delegate = row(row(next['read-delegates'])[change.provider]);
    const index = Number(/\[(\d+)\]$/.exec(change.slot)?.[1]);
    const targets = delegate['targets'];
    if (!Array.isArray(targets) || !Number.isSafeInteger(index) || targets[index] === undefined) throw new Error('execution-config-identity: unknown read slot');
    targets[index] = structuredClone(change.levels);
  }
  for (const change of delta.write) {
    const writers = row(next['write-subagents']);
    if (!Object.hasOwn(writers, change.provider)) throw new Error('execution-config-identity: unknown writer provider');
    writers[change.provider] = structuredClone(change.levels);
  }
  executionDelta(config, next);
  return next;
}

export function refreshedRun(run: RunStartedEvent, event: ExecutionConfigUpdated): RunStartedEvent {
  return { ...run, config: applyExecutionConfig(run.config, event.delta) };
}
