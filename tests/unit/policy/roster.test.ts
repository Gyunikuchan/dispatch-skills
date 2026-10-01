import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diversitySort, parsePins, resolveLevel, resolveRoster, type RosterInput } from '../../../skills/dispatch/scripts/policy/roster.ts';

const base: RosterInput = {
  level: 'high',
  readDelegates: {
    claude: { targets: [{ low: { model: 'claude-opus' } }, { low: { model: 'claude-sonnet' } }] },
    codex: { targets: [{ low: { model: 'gpt-5' } }, { low: { model: 'gpt-5-mini' } }] },
    agy: { targets: [{ low: { model: 'gemini-pro' } }] },
  },
  policy: { rounds: { low: 2 }, targets: { low: 3 } },
  orchestrator: { platform: 'claude', model: 'claude-opus-20260101' },
};
const slots = (roster: ReturnType<typeof resolveRoster>) => roster.targets.map((slot) => `${slot.slot}:${String(slot.model)}`);

test('grammar-sparse-level-maps: nearest lower level, else the lowest higher one', () => {
  assert.equal(resolveLevel({ low: 1, xhigh: 4 }, 'high'), 1);
  assert.equal(resolveLevel({ medium: 2, max: 5 }, 'low'), 2);
  assert.equal(resolveLevel({ high: 3 }, 'high'), 3);
  assert.equal(resolveLevel(undefined, 'high'), undefined);
});

test('grammar-pins: (a,b), (3), and (all) parse; count and all stand alone', () => {
  assert.deepEqual(parsePins('(Antigravity, codex)'), { kind: 'providers', keys: ['agy', 'codex'] });
  assert.deepEqual(parsePins('(3)'), { kind: 'count', count: 3 });
  assert.deepEqual(parsePins('(all)'), { kind: 'all' });
  assert.throws(() => parsePins('(2, codex)'), /stand alone/);
  assert.throws(() => parsePins('(0)'), /positive/);
  const pinned = resolveRoster({ ...base, pins: parsePins('(codex)') });
  assert.deepEqual(slots(pinned), ['codex[0]:gpt-5', 'codex[1]:gpt-5-mini']);
  assert.equal(resolveRoster({ ...base, pins: { kind: 'all' } }).targets.length, 5);
});

test('grammar-diversity-sort: every platform first once, orchestrator platform last, its own model last', () => {
  assert.deepEqual(diversitySort(['a1', 'a2', 'b1', 'c1', 'b2'], (item) => item[0]), ['a1', 'b1', 'c1', 'a2', 'b2']);
  const roster = resolveRoster({ ...base, policy: { rounds: { low: 1 }, targets: { low: 'all' } } });
  assert.deepEqual(slots(roster), ['codex[0]:gpt-5', 'agy[0]:gemini-pro', 'codex[1]:gpt-5-mini', 'claude[0]:claude-sonnet', 'claude[1]:claude-opus']);
});

test('grammar-target-identity: positional provider[index] slots; reserves follow targets', () => {
  const roster = resolveRoster(base);
  assert.equal(roster.rounds, 2);
  assert.deepEqual(roster.targets.map((slot) => slot.slot), ['codex[0]', 'agy[0]', 'codex[1]']);
  assert.deepEqual(roster.reserves.map((slot) => [slot.slot, slot.reserve]), [['claude[0]', true], ['claude[1]', true]]);
  const { policy: _policy, ...standalone } = base;
  const single = resolveRoster(standalone);
  assert.deepEqual([single.rounds, single.targets.length], [1, 1]);
});

test('grammar-only-filter: phase only keeps listed platforms', () => {
  const roster = resolveRoster({ ...base, policy: { rounds: { low: 1 }, targets: { low: 'all' }, only: ['Claude-Code'] } });
  assert.deepEqual(roster.targets.map((slot) => slot.provider), ['claude', 'claude']);
});

test('grammar-override-collapse: -m/-e collapse each platform to one target carrying the override', () => {
  const roster = resolveRoster({ ...base, policy: { rounds: { low: 1 }, targets: { low: 'all' } }, overrides: { effort: 'high' } });
  assert.deepEqual(roster.targets.map((slot) => [slot.slot, slot.effort]), [['codex[0]', 'high'], ['agy[0]', 'high'], ['claude[0]', 'high']]);
});

test('grammar-native-subagents-only: such platforms serve only as the orchestrator native subagents', () => {
  const readDelegates = { ...base.readDelegates, copilot: { targets: [{ low: { model: 'gpt-4.1' } }], nativeSubagentsOnly: true } };
  const policy = { rounds: { low: 1 }, targets: { low: 'all' as const } };
  const elsewhere = resolveRoster({ ...base, readDelegates, policy });
  assert.ok(!elsewhere.targets.some((slot) => slot.provider === 'copilot'));
  const native = resolveRoster({ ...base, readDelegates, policy, orchestrator: { platform: 'copilot', model: null } });
  assert.deepEqual(native.targets.filter((slot) => slot.provider === 'copilot').map((slot) => [slot.slot, slot.native]), [['copilot[0]', true]]);
});

test('grammar-pins: any unknown pinned provider throws, naming it', () => {
  assert.throws(() => resolveRoster({ ...base, pins: { kind: 'providers', keys: ['codex', 'typo'] } }), /typo/);
});
